import DataHawk from '../core/DataHawk';
import { MongoClient } from 'mongodb';
import Redis from 'ioredis';
import axios from 'axios';
import puppeteer from 'puppeteer';
import { Token, Signal, NewsSignal } from '../utils/types';
import * as cheerio from 'cheerio';
import AIConsilium from '../utils/aiConsilium';
import TelegramBot from 'node-telegram-bot-api';
import { lunarcrushRequests, lunarcrushRequestTime, apiSwitch, signalsGenerated, fibonacciExits } from '../utils/metrics';

jest.mock('mongodb');
jest.mock('ioredis');
jest.mock('axios');
jest.mock('puppeteer');
jest.mock('puppeteer-extra', () => ({
  default: { launch: jest.fn().mockResolvedValue({ 
    newPage: jest.fn().mockResolvedValue({ 
      authenticate: jest.fn(), 
      setUserAgent: jest.fn(), 
      setExtraHTTPHeaders: jest.fn(), 
      goto: jest.fn().mockResolvedValue(null), 
      content: jest.fn().mockResolvedValue(`
        <div class="swap-token"><span class="token-symbol">SOL</span><span class="token-price">150</span><span class="volume">1000</span><span class="market-cap">1000000</span><span class="liquidity">50000</span></div>
        <div class="swap-token"><span class="token-symbol">RAY</span><span class="token-price">50</span><span class="volume">500</span><span class="market-cap">500000</span><span class="liquidity">25000</span></div>
      `), 
      close: jest.fn() 
    }) 
  }) },
  use: jest.fn(),
}));
jest.mock('cheerio');
jest.mock('../utils/aiConsilium');
jest.mock('node-telegram-bot-api');
jest.mock('../utils/systemGuard', () => ({ logInfoAggregated: jest.fn(), logErrorAggregated: jest.fn(), sendTelegramAlert: jest.fn() }));
jest.mock('ts-retry-promise', () => ({ retry: jest.fn().mockImplementation(fn => fn()) }));
jest.mock('opossum');

describe('DataHawk', () => {
  let dataHawk: DataHawk;
  let redisClient: jest.Mocked<Redis>;
  let mongoClient: jest.Mocked<MongoClient>;
  let aiConsilium: jest.Mocked<AIConsilium>;
  let circuitBreaker: jest.Mock;

  beforeAll(() => {
    process.env.MONITOR_CHANNEL_ID = '-1002616465399';
    jest.mock('mongodb', () => ({
      MongoClient: jest.fn().mockImplementation(() => ({
        connect: jest.fn().mockResolvedValue({}),
        db: jest.fn().mockReturnValue({
          collection: jest.fn().mockReturnValue({
            updateOne: jest.fn(),
            findOne: jest.fn().mockResolvedValue({ ticker: 'SOL', timestamp: '2025-05-11T00:00:00Z' }),
            insertOne: jest.fn(),
            find: jest.fn().mockReturnValue({ 
              sort: jest.fn().mockReturnThis(), 
              limit: jest.fn().mockReturnThis(), 
              toArray: jest.fn().mockResolvedValue([]) 
            }),
          }),
        }),
      })),
    }));
    jest.mock('cheerio', () => ({
      load: jest.fn().mockReturnValue({
        find: jest.fn().mockReturnThis(),
        text: jest.fn().mockImplementation(sel => ({
          '.token-symbol': 'SOL,RAY',
          '.token-price': '150,50',
          '.volume': '1000,500',
          '.market-cap': '1000000,500000',
          '.liquidity': '50000,25000',
        }[sel] || '')),
        each: jest.fn().mockImplementation((_, cb) => { cb(0, {}); cb(1, {}); }),
      }),
    }));
    jest.mock('../utils/aiConsilium', () => jest.fn().mockImplementation(() => ({
      analyzeSentiment: jest.fn().mockResolvedValue({ score: 0.5, confidence: 0.8, impact: 0.7, socialVolume: 1000 }),
    })));
    jest.mock('opossum', () => ({
      CircuitBreaker: jest.fn().mockImplementation(fn => ({
        fire: jest.fn().mockImplementation((...args) => fn(...args)),
      })),
    }));
  });

  beforeEach(() => {
    redisClient = new Redis() as any;
    redisClient.get = jest.fn();
    redisClient.setEx = jest.fn();
    redisClient.publish = jest.fn();
    redisClient.subscribe = jest.fn().mockImplementation((_, cb) => cb(null, 4));
    mongoClient = new MongoClient('') as any;
    aiConsilium = new AIConsilium() as any;
    circuitBreaker = { fire: jest.fn() };
    dataHawk = new DataHawk({ redisClient, mongoClient, telegramBot: new TelegramBot(''), aiConsilium });
  });

  describe('scrapeRaydiumFallback', () => {
    it('should scrape multiple Raydium tokens', async () => {
      axios.get.mockRejectedValue(new Error('API error'));
      const tokens = await dataHawk['tokenFetcher']['scrapeRaydiumFallback']();
      expect(tokens).toEqual([
        { ticker: 'SOL', price: 150, volume: 1000, marketCap: 1000000, liquidity: 50000, priceChange: 0 },
        { ticker: 'RAY', price: 50, volume: 500, marketCap: 500000, liquidity: 25000, priceChange: 0 },
      ]);
      expect(cheerio.load).toHaveBeenCalled();
    });

    it('should use Raydium API if available', async () => {
      axios.get.mockResolvedValue({ data: [
        { symbol: 'SOL/USDC', price: 150, volume_24h: 1000, market_cap: 1000000, liquidity: 50000, price_change_24h: 2 },
        { symbol: 'RAY/USDC', price: 50, volume_24h: 500, market_cap: 500000, liquidity: 25000, price_change_24h: 1 },
      ] });
      const tokens = await dataHawk['tokenFetcher']['scrapeRaydiumFallback']();
      expect(tokens).toEqual([
        { ticker: 'SOL', price: 150, volume: 1000, marketCap: 1000000, liquidity: 50000, priceChange: 2 },
        { ticker: 'RAY', price: 50, volume: 500, marketCap: 500000, liquidity: 25000, priceChange: 1 },
      ]);
      expect(axios.get).toHaveBeenCalledWith('https://api.raydium.io/v2/pairs', expect.any(Object));
    });
  });

  describe('fetchTelegramNews', () => {
    it('should fetch Telegram news and cache them', async () => {
      (TelegramBot.prototype.getUpdates as jest.Mock).mockResolvedValue([{ message: { chat: { username: 'CryptoNews' }, text: 'Bitcoin is mooning!', date: 1697059200 } }]);
      const news = await dataHawk['telegramProcessor']['fetchTelegramNews']();
      expect(news).toEqual([{ text: 'Bitcoin is mooning!', source: 'telegram', timestamp: new Date(1697059200 * 1000).toISOString(), category: 'news', channel: 'CryptoNews' }]);
      expect(redisClient.setEx).toHaveBeenCalledWith('telegram:news', 3600, JSON.stringify(news));
    });

    it('should return cached Telegram news', async () => {
      redisClient.get.mockResolvedValue(JSON.stringify([{ text: 'Cached news', source: 'telegram', timestamp: '2025-05-11T00:00:00Z', category: 'news', channel: 'CryptoNews' }]));
      const news = await dataHawk['telegramProcessor']['fetchTelegramNews']();
      expect(news).toEqual([{ text: 'Cached news', source: 'telegram', timestamp: '2025-05-11T00:00:00Z', category: 'news', channel: 'CryptoNews' }]);
      expect(TelegramBot.prototype.getUpdates).not.toHaveBeenCalled();
    });
  });

  describe('generateSignals', () => {
    it('should generate Fibonacci signals with DQNTrainer', async () => {
      axios.get.mockImplementation(url => ({ data: url.includes('alternative.me') ? { data: [{ value: 75 }] } : [] }));
      jest.spyOn(dataHawk['tokenFetcher'], 'fetchTokens').mockResolvedValue([
        { ticker: 'SOL', price: 150, volume: 200000, marketCap: 1000000, liquidity: 50000, priceChange: 2, fibonacciLevels: { level_236: 140, level_382: 142, level_500: 145, level_618: 148, lastMin: 130, lastMax: 160 } },
      ]);
      jest.spyOn(dataHawk['telegramProcessor'], 'fetchTelegramNews').mockResolvedValue([]);
      jest.spyOn(dataHawk['tokenFetcher']['whaleActivityCircuitBreaker'], 'fire').mockResolvedValue({ whaleActivity: true });
      const signals = await dataHawk.generateSignals();
      expect(signals).toContainEqual(expect.objectContaining({ ticker: 'SOL', action: 'buy', confidence: expect.any(Number), source: 'DQN', entryType: 'fibonacci' }));
      expect(redisClient.publish).toHaveBeenCalledWith('signals:new', expect.stringContaining('"ticker":"SOL"'));
      expect(signalsGenerated.inc).toHaveBeenCalledWith({ source: 'DQN', value: 1 });
    });

    it('should handle negative sentiment in signal generation', async () => {
      jest.spyOn(dataHawk['aiConsilium'], 'analyzeSentiment').mockResolvedValue({ score: -0.5, confidence: 0.9, impact: 0.2, socialVolume: 500 });
      jest.spyOn(dataHawk['tokenFetcher'], 'fetchTokens').mockResolvedValue([
        { ticker: 'SOL', price: 150, volume: 200000, marketCap: 1000000, liquidity: 50000, priceChange: 2, fibonacciLevels: { level_236: 140, level_382: 142, level_500: 145, level_618: 148, lastMin: 130, lastMax: 160 } },
      ]);
      jest.spyOn(dataHawk['telegramProcessor'], 'fetchTelegramNews').mockResolvedValue([]);
      const signals = await dataHawk.generateSignals();
      expect(signals).toContainEqual(expect.objectContaining({ ticker: 'SOL', action: 'sell', confidence: expect.any(Number), source: 'DQN', entryType: 'fibonacci' }));
      expect(signalsGenerated.inc).toHaveBeenCalledWith({ source: 'DQN', value: 1 });
    });
  });

  describe('processTokenCheckResponse', () => {
    it('should process token check response and update news_signals', async () => {
      const msg = {
        chat: { id: parseInt(process.env.MONITOR_CHANNEL_ID || '0') },
        text: 'Token: SOL\nMarket Cap: 1000000\nLiquidity: 50000\nSnipers: 10%',
      } as TelegramBot.Message;
      await dataHawk['telegramProcessor'].processTokenCheckResponse(msg);
      expect(mongoClient.db().collection().updateOne).toHaveBeenCalledWith(
        { ticker: 'SOL', timestamp: expect.any(String) },
        expect.objectContaining({
          $set: expect.objectContaining({ marketCap: 1000000, liquidity: 50000, snipers: 0.1 }),
        })
      );
    });
  });

  describe('fetchAPIData', () => {
    it('should rotate APIs and track switches', async () => {
      axios.get.mockRejectedValueOnce({ response: { status: 429 } }).mockResolvedValueOnce({ 
        data: [{ symbol: 'SOL', price: 150, volume_5min: 1000, marketCap: 1000000, liquidity: 50000 }] 
      });
      const tokens = await dataHawk['tokenFetcher']['fetchTokens']();
      expect(tokens).toEqual([{ ticker: 'SOL', price: 150, volume: 1000, marketCap: 1000000, liquidity: 50000, priceChange: 0 }]);
      expect(apiSwitch.inc).toHaveBeenCalledWith({ api: expect.any(String), value: 1 });
    });

    it('should fall back to scrapeRaydiumFallback on failure', async () => {
      axios.get.mockRejectedValue(new Error('API error'));
      const tokens = await dataHawk['tokenFetcher']['fetchTokens']();
      expect(tokens).toEqual([
        { ticker: 'SOL', price: 150, volume: 1000, marketCap: 1000000, liquidity: 50000, priceChange: 0 },
        { ticker: 'RAY', price: 50, volume: 500, marketCap: 500000, liquidity: 25000, priceChange: 0 },
      ]);
    });

    it('should handle CircuitBreaker open state', async () => {
      jest.mock('opossum', () => ({
        CircuitBreaker: jest.fn().mockImplementation(() => ({
          fire: jest.fn().mockRejectedValue(new Error('Circuit open')),
        })),
      }));
      await expect(dataHawk['tokenFetcher']['fetchTokens']()).resolves.toEqual([]);
      expect(dataHawk['systemGuard'].logErrorAggregated).toHaveBeenCalledWith('Circuit breaker open for token fetch');
    });
  });

  describe('fetchLunarCrushData', () => {
    it('should fetch LunarCrush data and cache it', async () => {
      axios.get.mockResolvedValue({ data: { data: [{ social_volume: 1000, social_score: 50, galaxy_score: 75 }] } });
      const result = await dataHawk['telegramProcessor']['fetchLunarCrushData']('SOL');
      expect(result).toEqual({ socialVolume: 1000, socialScore: 50, galaxyScore: 75 });
      expect(redisClient.setEx).toHaveBeenCalledWith('lunarcrush:SOL', 3600, JSON.stringify({ socialVolume: 1000, socialScore: 50, galaxyScore: 75 }));
      expect(lunarcrushRequests.inc).toHaveBeenCalledWith({ ticker: 'SOL', value: 1 });
      expect(lunarcrushRequestTime.labels).toHaveBeenCalledWith('SOL');
    });

    it('should return cached LunarCrush data', async () => {
      redisClient.get.mockResolvedValue(JSON.stringify({ socialVolume: 500, socialScore: 40, galaxyScore: 60 }));
      const result = await dataHawk['telegramProcessor']['fetchLunarCrushData']('SOL');
      expect(result).toEqual({ socialVolume: 500, socialScore: 40, galaxyScore: 60 });
      expect(axios.get).not.toHaveBeenCalled();
    });
  });

  describe('handleTweets', () => {
    it('should process tweets and generate news signals', async () => {
      redisClient.publish.mockImplementation((channel, message, cb) => {
        if (channel === 'tweets:raw') cb(null, 1);
      });
      await dataHawk['tweetProcessor']?.handleTweets({ 
        ticker: 'SOL', 
        text: 'SOL is pumping!', 
        user: 'elonmusk', 
        timestamp: '2025-05-11T00:00:00Z', 
        source: 'twitter', 
        category: 'influencer', 
        channel: 'elonmusk' 
      });
      expect(dataHawk['aiConsilium'].analyzeSentiment).toHaveBeenCalledWith('SOL is pumping!');
      expect(redisClient.publish).toHaveBeenCalledWith('news:signals', expect.stringContaining('"ticker":"SOL"'));
    });
  });
});
