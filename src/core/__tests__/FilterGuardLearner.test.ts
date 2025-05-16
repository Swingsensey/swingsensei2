import { jest } from '@jest/globals';
import { Redis } from 'ioredis';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { MongoClient } from 'mongodb';
import FilterGuardLearner from '../FilterGuardLearner';
import { logInfoAggregated, logErrorAggregated } from '../../utils/systemGuard';

jest.mock('ioredis');
jest.mock('../../utils/systemGuard', () => ({
  logInfoAggregated: jest.fn(),
  logErrorAggregated: jest.fn(),
}));

const mockRedis = Redis as jest.MockedClass<typeof Redis>;
const mockLogInfo = logInfoAggregated as jest.Mock;
const mockLogError = logErrorAggregated as jest.Mock;

describe('FilterGuardLearner', () => {
  let learner: FilterGuardLearner;
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

    learner = new FilterGuardLearner();
  });

  afterAll(async () => {
    await mongoClient.close();
    await mongod.stop();
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('analyzeFilterPerformance', () => {
    it('should calculate optimal parameters for successful tokens', async () => {
      const db = await mongoClient.db();
      const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

      await db.collection('filter_results').insertMany([
        {
          filterName: 'Trending 5min',
          timestamp: new Date(),
          totalTokens: 100,
          passedTokens: 10,
          activeMarkets: ['US'],
        },
      ]);

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

      const params = await learner['analyzeFilterPerformance']('Trending 5min', 7);
      expect(params).toEqual({
        minVolume: 50000,
        minLiquidity: 100000,
        minSocialPosts: 50,
        minSentiment: 0.9,
      });
      expect(mockLogInfo).toHaveBeenCalledWith('FILTERGUARD_LEARNER', expect.stringContaining('Learned params for Trending 5min'));
    });
  });

  describe('updateFilterParams', () => {
    it('should update Redis with learned parameters', async () => {
      redisInstance.get.mockResolvedValue(JSON.stringify({
        posts: 50,
        sentiment: 0.9,
        tweets: ['@WatcherGuru mentioned TEST1'],
      }));

      const db = await mongoClient.db();
      await db.collection('tokens_history').insertOne({
        ticker: 'TEST1',
        volume: 50000,
        liquidity: 100000,
        holders: 2000,
        timestamp: new Date(),
        price: 1.5,
        marketCap: 15000000,
      });

      await learner.updateFilterParams('Trending 5min', 7);
      expect(redisInstance.setEx).toHaveBeenCalledWith(
        'filter:learned_params:Trending 5min',
        24 * 3600,
        expect.stringContaining('"minVolume":50000')
      );
    });
  });
});
