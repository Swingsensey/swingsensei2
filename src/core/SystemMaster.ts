import { Counter } from 'prom-client';
import Redis from 'ioredis';
import { logInfo, logError, sendTelegramNotification } from './systemGuard';
import { TariffChecker } from './TariffChecker';

interface SystemMasterConfig {
  redisClient: Redis;
}

interface ErrorData {
  type: string;
  provider: string;
  task: string;
  stack: string;
}

class SystemMaster {
  private readonly redis: Redis;
  private readonly tariffChecker: TariffChecker;
  private readonly sentimentRequestsTotal: Counter<string>;
  private readonly freeApiRequestsTotal: Counter<string>;
  private readonly aiApiCostTotal: Counter<string>;
  private readonly taskCosts: Record<string, number> = {
    trade_sensei: 0.0002,
    data_hawk: 0.0001,
    swarm_master: 0.0003,
  };

  constructor({ redisClient }: SystemMasterConfig) {
    this.redis = redisClient;
    this.tariffChecker = new TariffChecker(redisClient);
    this.initializeMetrics();
    setInterval(() => this.monitorApiLimits(), 60 * 60 * 1000);
  }

  private initializeMetrics(): void {
    this.sentimentRequestsTotal = new Counter({
      name: 'sentiment_requests_total',
      help: 'Total number of sentiment analysis requests',
      labelNames: ['provider'],
    });

    this.freeApiRequestsTotal = new Counter({
      name: 'free_api_requests_total',
      help: 'Total number of free AI API requests',
      labelNames: ['provider', 'task'],
    });

    this.aiApiCostTotal = new Counter({
      name: 'ai_api_cost_total',
      help: 'Total cost of AI API requests in USD',
      labelNames: ['provider'],
    });
  }

  async reportError(error: ErrorData): Promise<void> {
    try {
      const errorId = `error:${error.provider}:${error.task}:${Date.now()}`;
      await this.redis.set(errorId, JSON.stringify(error), 'EX', 86400);
      await this.redis.publish('errors:detected', JSON.stringify({ errorId, ...error }));
      logInfo('SYSTEMMASTER', `Published error: ${errorId}`);
    } catch (err) {
      logError('SYSTEMMASTER', `Failed to report error: ${(err as Error).message}`);
    }
  }

  private async monitorApiLimits(): Promise<void> {
    try {
      const report = await this.generateUsageReport();
      await sendTelegramNotification(report);
      logInfo('SYSTEMMASTER', report);
    } catch (error) {
      await this.reportError({
        type: 'monitor_error',
        provider: 'system',
        task: 'monitor_api_limits',
        stack: (error as Error).message,
      });
    }
  }

  private async generateUsageReport(): Promise<string> {
    const providers = ['deepseek', 'gemini', 'yandexgpt', 'openai', 'huggingface', 'free'];
    const freeProviders = ['gpt4free', 'ionet'];
    const quotas: Record<string, number> = {
      deepseek: parseInt(process.env.DEEPSEEK_FREE_QUOTA || '1000'),
      gemini: parseInt(process.env.GEMINI_FREE_QUOTA || '100'),
      yandexgpt: parseInt(process.env.YANDEXGPT_FREE_QUOTA || '500'),
      openai: parseInt(process.env.OPENAI_FREE_QUOTA || '1000'),
      huggingface: parseInt(process.env.HUGGINGFACE_FREE_QUOTA || '1000'),
    };

    let report = '📊 AI API Usage Report:\n';
    const paidRequests: Record<string, number> = {};
    const paidCosts: Record<string, number> = {};
    const freeRequests: Record<string, Record<string, number>> = {};
    const freeErrors: Record<string, Record<string, number>> = {};
    const freeBlocks: Record<string, number> = {};

    // Paid APIs
    for (const provider of providers) {
      const requests = (await this.sentimentRequestsTotal.get())?.values.find(v => v.labels.provider === provider)?.value || 0;
      const cost = (await this.aiApiCostTotal.get())?.values.find(v => v.labels.provider === provider)?.value || 0;
      if (provider !== 'free') {
        paidRequests[provider] = requests;
        paidCosts[provider] = cost;
        const quota = quotas[provider] || 1000;
        const usagePercent = (requests / quota) * 100;
        report += `- ${provider}: ${requests}/${quota} requests (${usagePercent.toFixed(1)}%), cost: $${cost.toFixed(4)}\n`;
        if (usagePercent > 80) {
          report += `  ⚠️ High usage! Consider upgrading plan.\n`;
          await this.reportError({
            type: 'cloud_limit_warning',
            provider,
            task: 'api_usage',
            stack: `Usage at ${usagePercent.toFixed(1)}% for ${provider}`,
          });
        }
      }
    }

    // Free APIs
    report += '\n📊 Free AI API Usage:\n';
    for (const provider of freeProviders) {
      const tasks = ['trade_sensei', 'data_hawk', 'swarm_master'];
      freeRequests[provider] = {};
      freeErrors[provider] = {};
      let totalRequests = 0;
      let totalSavings = 0;

      for (const task of tasks) {
        const reqs = (await this.freeApiRequestsTotal.get())?.values.find(v => v.labels.provider === provider && v.labels.task === task)?.value || 0;
        const errors = parseInt(await this.redis.get(`error:${provider}:${task}`) || '0');
        freeRequests[provider][task] = reqs;
        freeErrors[provider][task] = errors;
        totalRequests += reqs;
        totalSavings += reqs * this.taskCosts[task];
      }

      freeBlocks[provider] = provider === 'gpt4free' ? parseInt(await this.redis.get(`gpt4free:block:${provider}`) || '0') : 0;
      report += `- ${provider}: ${totalRequests} requests, ${Object.values(freeErrors[provider]).reduce((a, b) => a + b, 0)} errors, savings: $${totalSavings.toFixed(4)}\n`;
      if (freeBlocks[provider] > 0) {
        report += `  ⚠️ ${freeBlocks[provider]} blocks detected\n`;
        await this.reportError({
          type: 'api_block',
          provider,
          task: 'free_api',
          stack: `${freeBlocks[provider]} blocks detected for ${provider}`,
        });
      }
    }

    // Recommendations
    const recommendations = await this.tariffChecker.analyzeTaskRedistribution();
    if (recommendations.length > 0) {
      report += '\n🔄 Task Redistribution Recommendations:\n';
      for (const rec of recommendations) {
        report += `- Move "${rec.task}" to ${rec.toProvider}: saves $${rec.savings.toFixed(4)}, performance ${rec.performanceChange > 0 ? '+' : ''}${rec.performanceChange.toFixed(2)}\n`;
      }
    }

    return report;
  }
}

export { SystemMaster, SystemMasterConfig, ErrorData };
