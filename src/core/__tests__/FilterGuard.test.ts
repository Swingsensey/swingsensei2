import { jest } from '@jest/globals';
import { Redis } from 'ioredis';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { MongoClient } from 'mongodb';
import axios from 'axios';
import FilterGuard from '../FilterGuard';
import { Token, FilterParams } from '../../types';
import { logInfoAggregated, logErrorAggregated, sendTelegramAlert, recordMetric } from '../../utils/systemGuard';

jest.mock('axios');
jest.mock('ioredis');
jest.mock('../../utils/systemGuard', () => ({
  logInfoAggregated: jest.fn(),
  logErrorAggregated: jest.fn(),
  sendTelegramAlert: jest.fn(),
  recordMetric: jest.fn(),
}));

const mockAxios = axios as jest.Mocked<typeof axios>;
const mockRedis = Redis as jest.MockedClass<typeof Redis>;
const mockLogInfo = logInfoAggregated as jest.Mock;
const mockLogError = logErrorAggregated as jest.Mock;
const mockSendTelegram = sendTelegramAlert as jest.Mock;
const mockRecordMetric = recordMetric as jest.Mock;

describe('FilterGuard', () => {
  let filterGuard: FilterGuard;
  let mongod: MongoMemoryServer;
  let mongoClient: MongoClient;
  let redisInstance: any;

  const mockToken: Token = {
    ticker: 'TEST',
    volume: 50000,
    liquidity: 100000,
    price: 1.0,
    marketCap: 15000000,
    priceChange: 5,
  };

  beforeAll(async () => {
    mongod = await MongoMemoryServer.create();
    const uri = mongod.getUri();
    mongoClient = new MongoClient(uri);
    await mongoClient.connect();

    redisInstance = {
      get: jest.fn(),
      setEx: jest.fn(),
      publish: jest.fn(),
      subscribe: jest.fn(),
      mget: jest.fn(),
    };
    mockRedis.mockImplementation(() => redisInstance as any);

    filterGuard = new FilterGuard();
  });

  afterAll(async () => {
    await mongoClient.close();
    await mongod.stop();
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('getActiveMarkets', () => {
    it('should detect US market at 19:54 UTC', () => {
      jest.spyOn(global, 'Date').mockImplementation(() => new Date('2025-05-13T19:54:00Z'));
      const markets = filterGuard['getActiveMarkets']();
      expect(markets).toEqual(['US']);
      jest.spyOn(global, 'Date').mockRestore();
    });
  });

  describe('validateTokenInput', () => {
    it('should throw ApiError for invalid token input', () => {
      const invalidToken: Token = { ticker: '', price: 0, volume: -1, marketCap: 0, liquidity: 0, priceChange: 0 };
      expect(() => filterGuard['validateTokenInput'](invalidToken)).toThrow('Invalid token data');
    });

    it('should not throw for valid token input', () => {
      expect(() => filterGuard['validateTokenInput'](mockToken)).not.toThrow();
    });
  });

  describe('fetchLunarData', () => {
    it('should fetch LunarCrush data from cache', async () => {
      redisInstance.get.mockResolvedValue(JSON.stringify({
        socialVolume: 1000,
        socialScore: 50,
        galaxyScore: 60,
        socialPosts: 100,
        sentiment: 0.9,
        timestamp: new Date().toISOString(),
      }));

      const result = await filterGuard['fetchLunarData']('TEST');
      expect(result).toEqual({
        socialVolume: 1000,
        socialScore: 50,
        galaxyScore: 60,
        socialPosts: 100,
        sentiment: 0.9,
        timestamp: expect.any(String),
      });
      expect(redisInstance.get).toHaveBeenCalledWith('lunar:TEST');
    });

    it('should return default values if cache is empty', async () => {
      redisInstance.get.mockResolvedValue(null);

      const result = await filterGuard['fetchLunarData']('TEST');
      expect(result).toEqual({
        socialVolume: 0,
        socialScore: 0,
        galaxyScore: 0,
        socialPosts: 0,
        sentiment: 0,
        timestamp: expect.any(String),
      });
    });
  });

  describe('fetchXAlphaData', () => {
    it('should fetch XAlpha data from cache', async () => {
      redisInstance.get.mockResolvedValue(JSON.stringify({
        socialPosts: 200,
        sentiment: 0.85,
        influenceScore: 0.9,
        timestamp: new Date().toISOString(),
      }));

      const result = await filterGuard['fetchXAlphaData']('TEST');
      expect(result).toEqual({
        socialPosts: 200,
        sentiment: 0.85,
        influenceScore: 0.9,
        timestamp: expect.any(String),
      });
      expect(redisInstance.get).toHaveBeenCalledWith('xalpha:TEST');
    });

    it('should return default values if cache is empty', async () => {
      redisInstance.get.mockResolvedValue(null);

      const result = await filterGuard['fetchXAlphaData']('TEST');
      expect(result).toEqual({
        socialPosts: 0,
        sentiment: 0,
        influenceScore: 0,
        timestamp: expect.any(String),
      });
    });
  });

  describe('validateTokenMetrics', () => {
    it('should pass token with valid metrics', async () => {
      redisInstance.get
        .mockResolvedValueOnce(JSON.stringify({
          volume: 50000,
          liquidity: 100000,
          marketCap: 15000000,
          priceChange: 5,
          price: 1.5,
        }))
        .mockResolvedValueOnce(JSON.stringify({
          posts: 50,
          hasInfluencers: true,
          sentiment: 0.9,
        }))
        .mockResolvedValueOnce(JSON.stringify({
          posts: 20,
          hasInfluencers: false,
          sentiment: 0.8,
        }))
        .mockResolvedValueOnce(JSON.stringify({
          socialVolume: 1000,
          socialScore: 50,
          galaxyScore: 60,
          socialPosts: 100,
          sentiment: 0.9,
          timestamp: new Date().toISOString(),
        }))
        .mockResolvedValueOnce(JSON.stringify({
          socialPosts: 200,
          sentiment: 0.85,
          influenceScore: 0.9,
          timestamp: new Date().toISOString(),
        }))
        .mockResolvedValueOnce(JSON.stringify({
          kits: 5,
          maxTransferAmount: 50000,
          sellVolume: 1000,
        }))
        .mockResolvedValueOnce(JSON.stringify({
          holders: 2000,
          burnedLP: 97,
          transactions: 500,
          createdAt: Date.now() - 2 * 3600 * 1000,
        }))
        .mockResolvedValueOnce(JSON.stringify({
          volume: 50000,
          liquidity: 100000,
        }))
        .mockResolvedValueOnce(JSON.stringify({
          topHolders: 10,
          holderConcentration: 0.3,
        }));

      const db = await mongoClient.db();
      await db.collection('tokens_history').insertOne({
        ticker: 'TEST',
        volume: 20000,
        liquidity: 60000,
        holders: 1500,
        timestamp: new Date(),
      });

      const params: FilterParams = {
        name: 'Trending 5min',
        minVolume: 45000,
        minLiquidity: 60000,
        minHolders: 1500,
        minSocialPosts: 35,
        minSentiment: 0.8,
        minWhales: 4,
        whaleMinTransfer: 20000,
        burnedLP: 97,
        minTransactions: 250,
        requireInfluencers: true,
        minAge: 0.667,
        maxAge: 3,
        minVolumeGrowth: 2,
        minLiquidityGrowth: 20000,
        minHoldersGrowth: 200,
        maxHolderConcentration: 0.4,
      };
      const historicalData = new Map([['TEST', { volume: 20000, liquidity: 60000, holders: 1500 }]]);

      const result = await filterGuard['validateTokenMetrics'](mockToken, params, historicalData);
      expect(result).toBe(true);
    });

    it('should fail token with insufficient volume', async () => {
      redisInstance.get
        .mockResolvedValueOnce(JSON.stringify({
          volume: 10000,
          liquidity: 100000,
          marketCap: 15000000,
          priceChange: 5,
          price: 1.5,
        }))
        .mockResolvedValueOnce(JSON.stringify({
          posts: 50,
          hasInfluencers: true,
          sentiment: 0.9,
        }))
        .mockResolvedValueOnce(JSON.stringify({
          posts: 20,
          hasInfluencers: false,
          sentiment: 0.8,
        }))
        .mockResolvedValueOnce(JSON.stringify({
          socialVolume: 1000,
          socialScore: 50,
          galaxyScore: 60,
          socialPosts: 100,
          sentiment: 0.9,
          timestamp: new Date().toISOString(),
        }))
        .mockResolvedValueOnce(JSON.stringify({
          socialPosts: 200,
          sentiment: 0.85,
          influenceScore: 0.9,
          timestamp: new Date().toISOString(),
        }))
        .mockResolvedValueOnce(JSON.stringify({
          kits: 5,
          maxTransferAmount: 50000,
          sellVolume: 1000,
        }))
        .mockResolvedValueOnce(JSON.stringify({
          holders: 2000,
          burnedLP: 97,
          transactions: 500,
          createdAt: Date.now() - 2 * 3600 * 1000,
        }))
        .mockResolvedValueOnce(JSON.stringify({
          volume: 10000,
          liquidity: 100000,
        }))
        .mockResolvedValueOnce(JSON.stringify({
          topHolders: 10,
          holderConcentration: 0.3,
        }));

      const db = await mongoClient.db();
      await db.collection('tokens_history').insertOne({
        ticker: 'TEST',
        volume: 20000,
        liquidity: 60000,
        holders: 1500,
        timestamp: new Date(),
      });

      const params: FilterParams = {
        name: 'Trending 5min',
        minVolume: 45000,
        minLiquidity: 60000,
        minHolders: 1500,
        minSocialPosts: 35,
        minSentiment: 0.8,
      };
      const historicalData = new Map([['TEST', { volume: 20000, liquidity: 60000, holders: 1500 }]]);

      const result = await filterGuard['validateTokenMetrics'](mockToken, params, historicalData);
      expect(result).toBe(false);
    });
  });

  describe('applyNewlyReached10MFilter', () => {
    it('should filter tokens with market cap >10M in last month', async () => {
      redisInstance.get
        .mockResolvedValueOnce(JSON.stringify({
          volume: 50000,
          liquidity: 100000,
          marketCap: 15000000,
          priceChange: 5,
          price: 1.5,
        }))
        .mockResolvedValueOnce(JSON.stringify({
          posts: 50,
          hasInfluencers: true,
          sentiment: 0.9,
        }))
        .mockResolvedValueOnce(JSON.stringify({
          posts: 20,
          hasInfluencers: false,
          sentiment: 0.8,
        }))
        .mockResolvedValueOnce(JSON.stringify({
          socialVolume: 1000,
          socialScore: 50,
          galaxyScore: 60,
          socialPosts: 100,
          sentiment: 0.9,
          timestamp: new Date().toISOString(),
        }))
        .mockResolvedValueOnce(JSON.stringify({
          socialPosts: 200,
          sentiment: 0.85,
          influenceScore: 0.9,
          timestamp: new Date().toISOString(),
        }))
        .mockResolvedValueOnce(JSON.stringify({
          kits: 5,
          maxTransferAmount: 50000,
          sellVolume: 1000,
        }))
        .mockResolvedValueOnce(JSON.stringify({
          holders: 2000,
          burnedLP: 97,
          transactions: 500,
          createdAt: Date.now() - 2 * 3600 * 1000,
        }))
        .mockResolvedValueOnce(JSON.stringify({
          volume: 50000,
          liquidity: 100000,
        }))
        .mockResolvedValueOnce(JSON.stringify({
          topHolders: 10,
          holderConcentration: 0.3,
        }));

      mockAxios.get
        .mockResolvedValueOnce({ data: { price: 0.5 } })
        .mockResolvedValueOnce({ data: { supply: 10000000 } });

      const db = await mongoClient.db();
      await db.collection('tokens_history').insertOne({
        ticker: 'TEST',
        volume: 20000,
        liquidity: 60000,
        holders: 1500,
        timestamp: new Date(),
      });

      const result = await filterGuard.applyNewlyReached10MFilter([mockToken]);
      expect(result).toEqual([mockToken]);
      expect(mockRecordMetric).toHaveBeenCalledWith('filterPassed', { filter: 'NewlyReached10M', ticker: 'TEST' });
      expect(db.collection('filter_results').findOne({ filterName: 'NewlyReached10M' })).resolves.toBeTruthy();
    });

    it('should handle API errors gracefully', async () => {
      redisInstance.get
        .mockResolvedValueOnce(JSON.stringify({
          volume: 50000,
          liquidity: 100000,
          marketCap: 15000000,
          priceChange: 5,
          price: 1.5,
        }));
      mockAxios.get.mockRejectedValueOnce(new Error('API error'));

      const db = await mongoClient.db();
      await db.collection('tokens_history').insertOne({
        ticker: 'TEST',
        volume: 20000,
        liquidity: 60000,
        holders: 1500,
        timestamp: new Date(),
      });

      const result = await filterGuard.applyNewlyReached10MFilter([mockToken]);
      expect(result).toEqual([]);
      expect(mockLogError).toHaveBeenCalledWith('FILTERGUARD', expect.stringContaining('Error filtering TEST for NewlyReached10M'));
    });
  });

  describe('run', () => {
    it('should process lunar:raw channel and apply filters', async () => {
      redisInstance.subscribe.mockResolvedValue(undefined);
      redisInstance.get
        .mockResolvedValueOnce(JSON.stringify({
          volume: 50000,
          liquidity: 100000,
          marketCap: 15000000,
          priceChange: 5,
          price: 1.5,
        }))
        .mockResolvedValueOnce(JSON.stringify({
          posts: 50,
          hasInfluencers: true,
          sentiment: 0.9,
        }))
        .mockResolvedValueOnce(JSON.stringify({
          posts: 20,
          hasInfluencers: false,
          sentiment: 0.8,
        }))
        .mockResolvedValueOnce(JSON.stringify({
          socialVolume: 1000,
          socialScore: 50,
          galaxyScore: 60,
          socialPosts: 100,
          sentiment: 0.9,
          timestamp: new Date().toISOString(),
        }))
        .mockResolvedValueOnce(JSON.stringify({
          socialPosts: 200,
          sentiment: 0.85,
          influenceScore: 0.9,
          timestamp: new Date().toISOString(),
        }))
        .mockResolvedValueOnce(JSON.stringify({
          kits: 5,
          maxTransferAmount: 50000,
          sellVolume: 1000,
        }))
        .mockResolvedValueOnce(JSON.stringify({
          holders: 2000,
          burnedLP: 97,
          transactions: 500,
          createdAt: Date.now() - 2 * 3600 * 1000,
        }))
        .mockResolvedValueOnce(JSON.stringify({
          volume: 50000,
          liquidity: 100000,
        }))
        .mockResolvedValueOnce(JSON.stringify({
          topHolders: 10,
          holderConcentration: 0.3,
        }));

      const db = await mongoClient.db();
      await db.collection('tokens_history').insertOne({
        ticker: 'TEST',
        volume: 20000,
        liquidity: 60000,
        holders: 1500,
        timestamp: new Date(),
      });

      await filterGuard.run();
      redisInstance.on.mock.calls[0][1]('lunar:raw', JSON.stringify({ ticker: 'TEST' }));

      expect(mockRecordMetric).toHaveBeenCalledWith('lunarRawProcessed', { ticker: 'TEST' });
      expect(redisInstance.publish).toHaveBeenCalledWith('tokens:filtered', expect.any(String));
    });
  });
});
