import { mocked } from 'jest-mock';
import Redis from 'ioredis-mock';
import Bull from 'bull';
import axios from 'axios';
import { logger } from '../../utils/logger';
import { telegramApiErrors, telegramCheckLatency } from '../../utils/metrics';
import { WebhookSignalProcessor } from '../WebhookAgent';

// Mock dependencies
jest.mock('axios');
jest.mock('../../utils/logger');
jest.mock('../../utils/metrics');
jest.mock('bull');
jest.mock('@solana/web3.js');

const mockedAxios = mocked(axios, true);
const mockedLogger = mocked(logger, true);
const mockedTelegramApiErrors = mocked(telegramApiErrors, true);
const mockedTelegramCheckLatency = mocked(telegramCheckLatency, true);
const mockedBull = mocked(Bull, true);

describe('WebhookAgent', () => {
  let redisClient: Redis;
  let telegramQueue: Bull.Queue;

  beforeEach(() => {
    redisClient = new Redis();
    telegramQueue = new Bull('telegram-queue', 'redis://localhost:6379');
    mockedBull.mockReturnValue(telegramQueue as any);
    jest.clearAllMocks();
  });

  afterEach(async () => {
    await redisClient.flushall();
  });

  describe('notifyTelegram', () => {
    it('should add message to telegram queue', async () => {
      const message = 'Test notification';
      const token = 'test-token';
      const chatId = 'test-chat-id';
      const addSpy = jest.spyOn(telegramQueue, 'add').mockResolvedValue(undefined);

      await WebhookSignalProcessor.notifyTelegram(message, token, chatId);

      expect(addSpy).toHaveBeenCalledWith({ message, token, chatId });
      expect(mockedLogger.info).toHaveBeenCalledWith({
        component: 'WEBHOOK_AGENT',
        message: `Added Telegram notification to queue for ${chatId}`,
      });
    });

    it('should skip notification if recent error exists', async () => {
      const message = 'Test notification';
      const token = 'test-token';
      const chatId = 'test-chat-id';
      await redisClient.set(`telegram:error:${chatId}`, 'true', 'EX', 60);
      const addSpy = jest.spyOn(telegramQueue, 'add');

      await WebhookSignalProcessor.notifyTelegram(message, token, chatId);

      expect(addSpy).not.toHaveBeenCalled();
      expect(mockedLogger.warn).toHaveBeenCalledWith({
        component: 'WEBHOOK_AGENT',
        message: `Skipping Telegram notification for ${chatId} due to recent error`,
      });
    });

    it('should process telegram queue and send message', async () => {
      const job = {
        data: {
          message: 'Test notification',
          token: 'test-token',
          chatId: 'test-chat-id',
        },
      };
      mockedAxios.post.mockResolvedValue({ status: 200 });

      const processor = (telegramQueue as any).process.mock.calls[0][0];
      await processor(job);

      expect(mockedAxios.post).toHaveBeenCalledWith(
        `https://api.telegram.org/bot${job.data.token}/sendMessage`,
        {
          chat_id: job.data.chatId,
          text: job.data.message,
          parse_mode: 'Markdown',
        }
      );
      expect(mockedTelegramCheckLatency.observe).toHaveBeenCalled();
      expect(await redisClient.get(`telegram:error:${job.data.chatId}`)).toBeNull();
      expect(await redisClient.get(`telegram:error:count:${job.data.chatId}`)).toBeNull();
      expect(mockedLogger.info).toHaveBeenCalledWith({
        component: 'WEBHOOK_AGENT',
        message: `Sent Telegram notification to ${job.data.chatId}`,
      });
    });

    it('should cache error with exponential backoff on axios failure', async () => {
      const job = {
        data: {
          message: 'Test notification',
          token: 'test-token',
          chatId: 'test-chat-id',
        },
      };
      const error = new Error('Telegram API error');
      mockedAxios.post.mockRejectedValue(error);

      const processor = (telegramQueue as any).process.mock.calls[0][0];
      await expect(processor(job)).rejects.toThrow('Telegram API error');

      expect(await redisClient.get(`telegram:error:${job.data.chatId}`)).toBe('true');
      expect(await redisClient.get(`telegram:error:count:${job.data.chatId}`)).toBe('1');
      expect(await redisClient.ttl(`telegram:error:${job.data.chatId}`)).toBeLessThanOrEqual(60);
      expect(mockedTelegramApiErrors.inc).toHaveBeenCalledWith({ ticker: '' });
      expect(mockedLogger.error).toHaveBeenCalledWith({
        component: 'WEBHOOK_AGENT',
        message: `Ошибка Telegram уведомления: ${error.message}, backoff TTL: 60s`,
      });

      // Simulate second failure
      await expect(processor(job)).rejects.toThrow('Telegram API error');
      expect(await redisClient.get(`telegram:error:count:${job.data.chatId}`)).toBe('2');
      expect(await redisClient.ttl(`telegram:error:${job.data.chatId}`)).toBeLessThanOrEqual(120);
      expect(mockedLogger.error).toHaveBeenCalledWith({
        component: 'WEBHOOK_AGENT',
        message: `Ошибка Telegram уведомления: ${error.message}, backoff TTL: 120s`,
      });
    });
  });

  describe('formatTelegramMessage', () => {
    it('should format message without news details', async () => {
      const message = await (WebhookAgent as any).formatTelegramMessage('buy', 'SOL', 100, 'RSI', {});
      expect(message).toBe('📡 TradingView: BUY SOL @ $100 (Стратегия: RSI)');
    });

    it('should format message with news details', async () => {
      const newsDetails = {
        marketCap: 50000000,
        liquidity: 10000000,
        snipers: 5,
        category: 'DeFi',
        channel: 'Twitter',
        socialVolume: 1000,
        socialScore: 85,
        galaxyScore: 90,
        announcementImpact: 0.2,
      };
      const message = await (WebhookAgent as any).formatTelegramMessage('buy', 'SOL', 100, 'RSI', newsDetails);
      expect(message).toBe(
        '📡 TradingView: BUY SOL @ $100 (Стратегия: RSI)\n' +
        '*Контекст*:\n' +
        '- Market Cap: $50.00M\n' +
        '- Liquidity: $10.00M\n' +
        '- Snipers: 5\n' +
        '- Category: DeFi\n' +
        '- Channel: Twitter\n' +
        '- Social Volume: 1000\n' +
        '- Social Score: 85\n' +
        '- Galaxy Score: 90\n' +
        '- Announcement Impact: 20.0%'
      );
    });
  });

  describe('fetchNewsDetails', () => {
    it('should return cached news details', async () => {
      const ticker = 'SOL';
      const details = { marketCap: 50000000, liquidity: 10000000 };
      await redisClient.set(`news:details:${ticker}`, JSON.stringify(details));

      const result = await (WebhookAgent as any).fetchNewsDetails(ticker);

      expect(result).toEqual(details);
      expect(mockedLogger.info).toHaveBeenCalledWith({
        component: 'WEBHOOK_AGENT',
        message: `News details cache hit for ${ticker}`,
      });
    });

    it('should cache and return empty details if not found', async () => {
      const ticker = 'SOL';

      const result = await (WebhookAgent as any).fetchNewsDetails(ticker);

      expect(result).toEqual({});
      expect(await redisClient.get(`news:details:${ticker}`)).toBe(JSON.stringify({}));
      expect(await redisClient.ttl(`news:details:${ticker}`)).toBeLessThanOrEqual(300);
    });
  });

  describe('cacheTokenPrice', () => {
    it('should return cached price from Redis', async () => {
      const ticker = 'SOL';
      await redisClient.set(`solana:price:${ticker}`, '150');

      const price = await (WebhookAgent as any).cacheTokenPrice(ticker);

      expect(price).toBe(150);
      expect(mockedLogger.info).toHaveBeenCalledWith({
        component: 'WEBHOOK_AGENT',
        message: `Solana price cache hit for ${ticker}`,
      });
    });

    it('should rotate RPC nodes on failure and cache price', async () => {
      const ticker = 'SOL';
      const mockConnection = { getPrice: jest.fn() };
      const mockPrice = 100;
      jest.spyOn(require('@solana/web3.js'), 'Connection')
        .mockImplementationOnce(() => { throw new Error('RPC failed'); })
        .mockImplementationOnce(() => mockConnection);
      mockConnection.getPrice = jest.fn().mockResolvedValue(mockPrice);

      const price = await (WebhookAgent as any).cacheTokenPrice(ticker);

      expect(price).toBe(mockPrice);
      expect(await redisClient.get(`solana:price:${ticker}`)).toBe(mockPrice.toString());
      expect(await redisClient.get(`rpc:priority:${rpcPool[1]}`)).toBeDefined();
      expect(mockedLogger.warn).toHaveBeenCalledWith({
        component: 'WEBHOOK_AGENT',
        message: `RPC ${rpcPool[0]} failed: RPC failed`,
      });
      expect(mockedLogger.info).toHaveBeenCalledWith({
        component: 'WEBHOOK_AGENT',
        message: `Fetched price ${mockPrice} from ${rpcPool[1]}`,
      });
    });

    it('should throw error if all RPC nodes fail', async () => {
      const ticker = 'SOL';
      jest.spyOn(require('@solana/web3.js'), 'Connection')
        .mockImplementation(() => { throw new Error('RPC failed'); });

      await expect((WebhookAgent as any).cacheTokenPrice(ticker)).rejects.toThrow('All RPC nodes failed');
      expect(mockedLogger.warn).toHaveBeenCalledTimes(rpcPool.length);
    });
  });
});
