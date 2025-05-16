import { jest } from '@jest/globals';
import { Redis } from 'ioredis';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { MongoClient } from 'mongodb';
import * as tf from '@tensorflow/tfjs-node';
import FilterGuardML from '../FilterGuardML';
import { logInfoAggregated, logErrorAggregated } from '../../utils/systemGuard';

jest.mock('ioredis');
jest.mock('../../utils/systemGuard', () => ({
  logInfoAggregated: jest.fn(),
  logErrorAggregated: jest.fn(),
}));

const mockRedis = Redis as jest.MockedClass<typeof Redis>;
const mockLogInfo = logInfoAggregated as jest.Mock;
const mockLogError = logErrorAggregated as jest.Mock;

describe('FilterGuardML', () => {
  let ml: FilterGuardML;
  let mongod: MongoMemoryServer;
  let mongoClient: MongoClient;
  let redisInstance: any;

  beforeAll(async () => {
    mongod = await MongoMemoryServer.create();
    const uri = mongod.getUri();
    mongoClient = new MongoClient(uri);
    await mongoClient.connect();

    redisInstance = {
      get: jest.fn(),
      setEx: jest.fn(),
    };
    mockRedis.mockImplementation(() => redisInstance as any);

    ml = new FilterGuardML();
  });

  afterAll(async () => {
    await mongoClient.close();
    await mongod.stop();
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('trainModel', () => {
    it('should train MLP model', async () => {
      const db = await mongoClient.db();
      const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

      await db.collection('tokens_history').insertMany([
        {
          ticker: 'TEST1',
          volume: 50000,
          liquidity: 100000,
          holders: 2000,
          timestamp: new Date(),
          price: 1.5,
          marketCap: 15000000,
        },
        {
          ticker: 'TEST1',
          volume: 40000,
          liquidity: 80000,
          holders: 1800,
          timestamp: since,
          price: 1.0,
          marketCap: 10000000,
        },
        {
          ticker: 'TEST2',
          volume: 30000,
          liquidity: 60000,
          holders: 1500,
          timestamp: new Date(),
          price: 0.8,
          marketCap: 8000000,
        },
      ]);

      redisInstance.get.mockResolvedValue(JSON.stringify({
        posts: 50,
        sentiment: 0.9,
        tweets: ['@WatcherGuru mentioned TEST1'],
      }));

      await ml['trainModel']('Trending 5min', 7);
      expect(mockLogInfo).toHaveBeenCalledWith('FILTERGUARD_ML', expect.stringContaining('Trained MLP model for Trending 5min'));
    });
  });

  describe('predictSuccess', () => {
    it('should predict success probability for a token', async () => {
      const db = await mongoClient.db();
      await db.collection('tokens_history').insertOne({
        ticker: 'TEST',
        volume: 50000,
        liquidity: 100000,
        holders: 2000,
        timestamp: new Date(),
        price: 1.5,
        marketCap: 15000000,
      });

      redisInstance.get.mockResolvedValue(JSON.stringify({
        posts: 50,
        sentiment: 0.9,
        tweets: ['@WatcherGuru mentioned TEST'],
      }));

      const probability = await ml['predictSuccess']('TEST');
      expect(probability).toBeGreaterThan(0);
      expect(probability).toBeLessThanOrEqual(1);
    });
  });

  describe('updateFilterParams', () => {
    it('should update Redis with ML-adjusted parameters', async () => {
      const db = await mongoClient.db();
      await db.collection('tokens_history').insertOne({
        ticker: 'TEST',
        volume: 50000,
        liquidity: 100000,
        holders: 2000,
        timestamp: new Date(),
        price: 1.5,
        marketCap: 15000000,
      });

      redisInstance.get.mockResolvedValue(JSON.stringify({
        posts: 50,
        sentiment: 0.9,
        tweets: ['@WatcherGuru mentioned TEST'],
      }));

      await ml.updateFilterParams('Trending 5min', 7);
      expect(redisInstance.setEx).toHaveBeenCalledWith(
        'filter:ml_params:Trending 5min',
        24 * 3600,
        expect.stringContaining('"minVolume":')
      );
    });
  });
});
