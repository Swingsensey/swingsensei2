import { Redis } from 'ioredis';
import { MongoClient } from 'mongodb';
import { Jupiter } from '@jup-ag/api';
import { Connection, Keypair } from '@solana/web3.js';
import tf from '@tensorflow/tfjs-node';
import { TradeSensei } from '../core/TradeSensei';
import { logger } from '../utils/logger';
import { metrics } from '../utils/metrics';
import { Token, Signal } from '../types';

jest.mock('ioredis');
jest.mock('mongodb');
jest.mock('@tensorflow/tfjs-node');
jest.mock('@solana/web3.js');
jest.mock('@jup-ag/api');
jest.mock('axios');
jest.mock('../utils/logger');
jest.mock('../utils/metrics');

describe('TradeSensei', () => {
  let tradeSensei: TradeSensei;
  let mockRedis: jest.Mocked<Redis>;
  let mockMongo: jest.Mocked<MongoClient>;
  let mockJupiter: jest.Mocked<Jupiter>;

  beforeEach(() => {
    mockRedis = new Redis() as jest.Mocked<Redis>;
    mockMongo = new MongoClient('') as jest.Mocked<MongoClient>;
    mockJupiter = new Jupiter({ connection: new Connection(''), wallet: new Keypair() }) as jest.Mocked<Jupiter>;

    tradeSensei = new TradeSensei({
      redis: mockRedis,
      mongo: mockMongo,
      jupiter: mockJupiter,
      solscanApiKey: 'test-solscan-key',
      cieloApiKey: 'test-cielo-key',
      telegramBotToken: 'test-telegram-token',
      telegramChatId: 'test-chat-id',
    });

    // Мок для DQN-модели
    (tradeSensei as any).dqnModel = {
      predict: jest.fn().mockReturnValue({ argMax: () => ({ dataSync: () => [1] }) }),
      fit: jest.fn().mockResolvedValue(undefined),
      save: jest.fn().mockResolvedValue('mocked-model-data'),
    };
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('should generate signal for valid Fibonacci entry', async () => {
    const token: Token = {
      ticker: 'TEST',
      price: 0.382,
      volume: 30000,
      marketCap: 400000,
      liquidity: 100000,
      priceChange: 0,
    };
    const signalData: Partial<Signal> = {
      holders: 120,
      transactions: 500,
      sentimentScore: 0.8,
      fearGreedIndex: 60,
      snipers: 0.2,
      devHoldings: 0.02,
      socialVolume: 500,
      socialScore: 0.85,
      galaxyScore: 0.7,
      announcementImpact: 0.6,
      category: 'trend',
      channel: 'test_channel',
    };

    // Моки для Redis
    mockRedis.get.mockImplementation((key) => {
      if (key === 'tokens:liquidity:TEST') return Promise.resolve('100000');
      if (key === 'tokens:whales:TEST') return Promise.resolve('true');
      return Promise.resolve(null);
    });
    mockRedis.setex.mockResolvedValue('OK');
    mockRedis.publish.mockResolvedValue(1);

    // Моки для MongoDB
    mockMongo.db.mockReturnValue({
      collection: jest.fn().mockReturnValue({
        findOne: jest.fn().mockResolvedValue({ volume: 15000 }),
        insertOne: jest.fn().mockResolvedValue({ insertedId: 'mocked-id' }),
      }),
    } as any);

    // Мок для FilterGuard
    (tradeSensei as any).filterGuard.applySolanaSwingSniper = jest.fn().mockReturnValue(true);

    const signal = await tradeSensei.generateSignal(
      { ...token, high: 1, low: 0, ...signalData },
      'tokens'
    );

    expect(signal).not.toBeNull();
    expect(signal?.entryType).toBe('fibonacci');
    expect(signal?.fibonacciLevel).toBe(0.382);
    expect(signal?.ticker).toBe('TEST');
    expect(metrics.signalsGenerated.inc).toHaveBeenCalledWith({ source: 'tokens' });
  });

  it('should reject token with marketCap > 500K for news source', async () => {
    const token: Token = {
      ticker: 'TEST',
      price: 0.382,
      volume: 30000,
      marketCap: 600000,
      liquidity: 100000,
      priceChange: 0,
    };
    const signalData: Partial<Signal> = {
      holders: 120,
      transactions: 500,
      sentimentScore: 0.8,
      fearGreedIndex: 60,
      snipers: 0.2,
      devHoldings: 0.02,
      socialVolume: 500,
      socialScore: 0.85,
      galaxyScore: 0.7,
      announcementImpact: 0.6,
      category: 'trend',
      channel: 'test_channel',
    };

    const signal = await tradeSensei.generateSignal(
      { ...token, high: 1, low: 0, ...signalData, source: 'news' },
      'news'
    );
    expect(signal).toBeNull();
  });

  it('should validate Fibonacci entry correctly', async () => {
    const token: Token = {
      ticker: 'TEST',
      price: 0.382,
      volume: 30000,
      marketCap: 400000,
      liquidity: 100000,
      priceChange: 0,
    };
    const signal: Partial<Signal> = {
      sentimentScore: 0.8,
    };
    const fibLevels = {
      level_236: 0.236,
      level_382: 0.382,
      level_500: 0.5,
      level_618: 0.618,
      lastMin: 0,
      lastMax: 1,
    };

    // Моки для MongoDB
    mockMongo.db.mockReturnValue({
      collection: jest.fn().mockReturnValue({
        findOne: jest.fn().mockResolvedValue({ volume: 15000 }),
      }),
    } as any);

    // Моки для Redis
    mockRedis.get.mockImplementation((key) => {
      if (key === 'tokens:whales:TEST') return Promise.resolve('true');
      return Promise.resolve(null);
    });

    const result = await (tradeSensei as any).calculateFibonacciEntry(token, signal, fibLevels);
    expect(result).toEqual({ isValid: true, fibonacciLevel: 0.382 });
  });

  it('should build correct DQN state', async () => {
    const token: Token = {
      ticker: 'TEST',
      price: 0.382,
      volume: 30000,
      marketCap: 400000,
      liquidity: 100000,
      priceChange: 0,
    };
    const signal: Partial<Signal> = {
      holders: 120,
      transactions: 500,
      sentimentScore: 0.8,
      fearGreedIndex: 60,
    };
    const fibLevels = {
      level_236: 0.236,
      level_382: 0.382,
      level_500: 0.5,
      level_618: 0.618,
      lastMin: 0,
      lastMax: 1,
    };

    // Моки для MongoDB
    mockMongo.db.mockReturnValue({
      collection: jest.fn().mockReturnValue({
        find: jest.fn().mockReturnValue({
          toArray: jest.fn().mockResolvedValue([{ entryType: 'fibonacci', fibonacciLevel: 0.382 }]),
        }),
      }),
    } as any);

    const state = await (tradeSensei as any).buildSignalState(token, signal, fibLevels);
    expect(state).toEqual([
      0.382,
      30000,
      400000,
      100000,
      120,
      500,
      0.8,
      0.6,
      0.382,
      0.618,
      1,
    ]);
  });

  it('should handle arbitration correctly', async () => {
    const signal = { token: { ticker: 'TEST' } };

    // Моки для Redis
    mockRedis.llen.mockResolvedValue(0);
    mockRedis.lpush.mockResolvedValue(1);
    mockRedis.expire.mockResolvedValue(1);
    mockRedis.publish.mockResolvedValue(1);

    // Моки для axios
    const mockAxios = require('axios');
    mockAxios.post.mockImplementation((url: string) =>
      Promise.resolve({ data: { vote: url.includes('gemini') ? 'approve' : 'reject' } })
    );

    const decision = await (tradeSensei as any).arbitrateSignal(signal);
    expect(decision).toBe('reject');
    expect(metrics.arbitrationDecisions.inc).toHaveBeenCalled();
  });
});
