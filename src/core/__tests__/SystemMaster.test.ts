import { SystemMaster, SystemMasterConfig, ErrorData } from '../SystemMaster';c
import Redis from 'ioredis';
import { Counter } from 'prom-client';
import { TariffChecker } from '../TariffChecker';
import { logInfo, logError, sendTelegramNotification } from '../systemGuard';
import RedisMock from 'ioredis-mock';
import { mocked } from 'jest-mock';

// Моки
jest.mock('../systemGuard');
jest.mock('../TariffChecker');
jest.mock('prom-client', () => ({
  Counter: jest.fn().mockImplementation(() => ({
    get: jest.fn().mockReturnValue({ values: [] }),
  })),
}));
const mockLogInfo = mocked(logInfo);
const mockLogError = mocked(logError);
const mockSendTelegramNotification = mocked(sendTelegramNotification);
const mockTariffChecker = mocked(TariffChecker);

// Подготовка
let redisClient: Redis;
let systemMaster: SystemMaster;
const config: SystemMasterConfig = { redisClient: new RedisMock() };

beforeEach(() => {
  jest.clearAllMocks();
  redisClient = new RedisMock();
  systemMaster = new SystemMaster(config);
  mockTariffChecker.prototype.analyzeTaskRedistribution = jest.fn().mockResolvedValue([]);
});

afterEach(() => {
  jest.useRealTimers();
});

describe('SystemMaster', () => {
  describe('constructor', () => {
    it('инициализирует метрики и запускает интервал', () => {
      expect(Counter).toHaveBeenCalledTimes(3);
      expect(Counter).toHaveBeenCalledWith({
        name: 'sentiment_requests_total',
        help: 'Total number of sentiment analysis requests',
        labelNames: ['provider'],
      });
      expect(Counter).toHaveBeenCalledWith({
        name: 'free_api_requests_total',
        help: 'Total number of free AI API requests',
        labelNames: ['provider', 'task'],
      });
      expect(Counter).toHaveBeenCalledWith({
        name: 'ai_api_cost_total',
        help: 'Total cost of AI API requests in USD',
        labelNames: ['provider'],
      });
    });
  });

  describe('reportError', () => {
    const errorData: ErrorData = {
      type: 'cloud_limit_exceeded',
      provider: 'render_free',
      task: 'system',
      stack: 'Requests limit exceeded',
    };

    it('публикует ошибку в Redis и errors:detected', async () => {
      await systemMaster.reportError(errorData);
      const errorId = expect.stringMatching(/^error:render_free:system:\d+$/);
      expect(redisClient.set).toHaveBeenCalledWith(
        errorId,
        JSON.stringify(errorData),
        'EX',
        86400
      );
      expect(redisClient.publish).toHaveBeenCalledWith(
        'errors:detected',
        JSON.stringify({ errorId, ...errorData })
      );
      expect(mockLogInfo).toHaveBeenCalledWith('SYSTEMMASTER', expect.stringContaining('Published error:'));
    });

    it('обрабатывает ошибку Redis', async () => {
      jest.spyOn(redisClient, 'set').mockRejectedValueOnce(new Error('Redis error'));
      await systemMaster.reportError(errorData);
      expect(mockLogError).toHaveBeenCalledWith('SYSTEMMASTER', 'Failed to report error: Redis error');
    });
  });

  describe('monitorApiLimits', () => {
    it('вызывает generateUsageReport и отправляет Telegram-уведомление', async () => {
      const mockReport = '📊 AI API Usage Report:\n...';
      jest.spyOn(systemMaster, 'generateUsageReport' as any).mockResolvedValue(mockReport);
      await (systemMaster as any).monitorApiLimits();
      expect(mockSendTelegramNotification).toHaveBeenCalledWith(mockReport);
      expect(mockLogInfo).toHaveBeenCalledWith('SYSTEMMASTER', mockReport);
    });

    it('обрабатывает ошибку через reportError', async () => {
      const error = new Error('Monitor error');
      jest.spyOn(systemMaster, 'generateUsageReport' as any).mockRejectedValue(error);
      const reportErrorSpy = jest.spyOn(systemMaster, 'reportError');
      await (systemMaster as any).monitorApiLimits();
      expect(reportErrorSpy).toHaveBeenCalledWith({
        type: 'monitor_error',
        provider: 'system',
        task: 'monitor_api_limits',
        stack: 'Monitor error',
      });
    });
  });

  describe('generateUsageReport', () => {
    beforeEach(() => {
      process.env.DEEPSEEK_FREE_QUOTA = '1000';
      process.env.GEMINI_FREE_QUOTA = '100';
      process.env.YANDEXGPT_FREE_QUOTA = '500';
      process.env.OPENAI_FREE_QUOTA = '1000';
      process.env.HUGGINGFACE_FREE_QUOTA = '1000';
    });

    it('генерирует отчёт для платных API', async () => {
      (systemMaster as any).sentimentRequestsTotal.get = jest.fn().mockReturnValue({
        values: [{ labels: { provider: 'deepseek' }, value: 800 }],
      });
      (systemMaster as any).aiApiCostTotal.get = jest.fn().mockReturnValue({
        values: [{ labels: { provider: 'deepseek' }, value: 0.16 }],
      });
      const report = await (systemMaster as any).generateUsageReport();
      expect(report).toContain('📊 AI API Usage Report:');
      expect(report).toContain('- deepseek: 800/1000 requests (80.0%), cost: $0.1600');
      expect(mockTariffChecker.prototype.analyzeTaskRedistribution).toHaveBeenCalled();
    });

    it('публикует предупреждение при превышении лимита (>80%)', async () => {
      (systemMaster as any).sentimentRequestsTotal.get = jest.fn().mockReturnValue({
        values: [{ labels: { provider: 'deepseek' }, value: 900 }],
      });
      (systemMaster as any).aiApiCostTotal.get = jest.fn().mockReturnValue({
        values: [{ labels: { provider: 'deepseek' }, value: 0.18 }],
      });
      const reportErrorSpy = jest.spyOn(systemMaster, 'reportError');
      const report = await (systemMaster as any).generateUsageReport();
      expect(report).toContain('⚠️ High usage! Consider upgrading plan.');
      expect(reportErrorSpy).toHaveBeenCalledWith({
        type: 'cloud_limit_warning',
        provider: 'deepseek',
        task: 'api_usage',
        stack: expect.stringContaining('Usage at 90.0% for deepseek'),
      });
    });

    it('генерирует отчёт для бесплатных API', async () => {
      (systemMaster as any).freeApiRequestsTotal.get = jest.fn().mockReturnValue({
        values: [
          { labels: { provider: 'gpt4free', task: 'trade_sensei' }, value: 50 },
        ],
      });
      jest.spyOn(redisClient, 'get').mockResolvedValue('2');
      const report = await (systemMaster as any).generateUsageReport();
      expect(report).toContain('📊 Free AI API Usage:');
      expect(report).toContain('- gpt4free: 50 requests, 2 errors, savings: $0.0100');
    });

    it('публикует ошибку при блокировке API', async () => {
      (systemMaster as any).freeApiRequestsTotal.get = jest.fn().mockReturnValue({
        values: [
          { labels: { provider: 'gpt4free', task: 'trade_sensei' }, value: 50 },
        ],
      });
      jest.spyOn(redisClient, 'get').mockImplementation(async (key: string) => {
        if (key === 'gpt4free:block:gpt4free') return '5';
        return '0';
      });
      const reportErrorSpy = jest.spyOn(systemMaster, 'reportError');
      const report = await (systemMaster as any).generateUsageReport();
      expect(report).toContain('⚠️ 5 blocks detected');
      expect(reportErrorSpy).toHaveBeenCalledWith({
        type: 'api_block',
        provider: 'gpt4free',
        task: 'free_api',
        stack: '5 blocks detected for gpt4free',
      });
    });

    it('включает рекомендации TariffChecker', async () => {
      mockTariffChecker.prototype.analyzeTaskRedistribution.mockResolvedValue([
        { task: 'trade_sensei', toProvider: 'openai', savings: 0.01, performanceChange: 0.05 },
      ]);
      const report = await (systemMaster as any).generateUsageReport();
      expect(report).toContain('🔄 Task Redistribution Recommendations:');
      expect(report).toContain('- Move "trade_sensei" to openai: saves $0.0100, performance +0.05');
    });
  });
});
