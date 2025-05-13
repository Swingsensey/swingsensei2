import { Counter, Histogram } from 'prom-client';
import Redis from 'ioredis';
import { FreeAIAgent } from './FreeAIAgent';
import { logInfo, logError } from './systemGuard';

interface SentimentResult {
  sentiment: string;
  confidence: number;
}

interface AIConsiliumConfig {
  redisClient: Redis;
}

class SentimentAnalyzer {
  private readonly redis: Redis;
  private readonly freeAgent: FreeAIAgent;
  private readonly costs: Record<string, number>;
  private readonly sentimentRequestsTotal: Counter<string>;
  private readonly freeApiRequestsTotal: Counter<string>;
  private readonly sentimentRequestDuration: Histogram<string>;
  private readonly aiApiCostTotal: Counter<string>;

  constructor({ redisClient }: AIConsiliumConfig) {
    this.redis = redisClient;
    this.freeAgent = new FreeAIAgent({ redisClient });
    this.costs = {
      deepseek: parseFloat(process.env.DEEPSEEK_COST_PER_REQUEST || '0.0001'),
      gemini: parseFloat(process.env.GEMINI_COST_PER_REQUEST || '0.00005'),
      yandexgpt: parseFloat(process.env.YANDEXGPT_COST_PER_REQUEST || '0.0002'),
      openai: parseFloat(process.env.OPENAI_COST_PER_REQUEST || '0.0001'),
      huggingface: parseFloat(process.env.HUGGINGFACE_COST_PER_REQUEST || '0.00008'),
      free: 0,
    };

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

    this.sentimentRequestDuration = new Histogram({
      name: 'sentiment_request_duration_seconds',
      help: 'Duration of sentiment analysis requests',
      labelNames: ['provider'],
    });

    this.aiApiCostTotal = new Counter({
      name: 'ai_api_cost_total',
      help: 'Total cost of AI API requests in USD',
      labelNames: ['provider'],
    });
  }

  private async getPromptTemplate(task: string): Promise<string> {
    const templateKey = `prompt:template:${task}`;
    const template = await this.redis.get(templateKey) ?? await this.redis.get('prompt:template:default') ?? '{prompt}';
    if (!template.includes('{prompt}')) {
      logError('AICONSILIUM', `Invalid template for ${task}, using default`);
      return '{prompt}';
    }
    return template;
  }

  private async applySuperPrompt(task: string, text: string): Promise<string> {
    const template = await this.getPromptTemplate(task);
    return template.replace('{prompt}', text);
  }

  async analyzeFreeAI(text: string, task: string): Promise<SentimentResult> {
    if (!['trade_sensei', 'data_hawk', 'swarm_master'].includes(task)) {
      throw new Error(`Invalid task: ${task}`);
    }

    const start = Date.now();
    try {
      const enhancedPrompt = await this.applySuperPrompt(task, text);
      const methodMap: Record<string, keyof FreeAIAgent> = {
        trade_sensei: 'arbitrate',
        data_hawk: 'analyze',
        swarm_master: 'train',
      };
      const response = await this.freeAgent[methodMap[task]](enhancedPrompt);

      this.freeApiRequestsTotal.inc({ provider: response.provider, task });
      this.aiApiCostTotal.inc({ provider: 'free' }, 0);
      this.sentimentRequestDuration.observe({ provider: response.provider }, (Date.now() - start) / 1000);

      return { sentiment: response.text, confidence: response.confidence };
    } catch (error) {
      logError('AICONSILIUM', `Free AI error for ${task}: ${(error as Error).message}`);
      throw new Error(`Failed to process ${task}: ${(error as Error).message}`);
    }
  }
}
