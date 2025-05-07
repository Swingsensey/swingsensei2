import Joi from 'joi';

async function retry<T>(fn: () => Promise<T>, options: { retries: number; baseDelay?: number; maxDelay?: number }): Promise<T> {
  const { retries, baseDelay = 1000, maxDelay = 10000 } = options;
  for (let i = 0; i < retries; i++) {
    try {
      return await fn();
    } catch (error) {
      if (i === retries - 1) throw error;
      const delay = Math.min(baseDelay * Math.pow(2, i) + Math.random() * 100, maxDelay);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
  throw new Error('Retry failed');
}

function measureTime(fn: () => Promise<any>) {
  const start = Date.now();
  return fn().then(result => ({ result, time: Date.now() - start }));
}

import { apiLatency } from '../core/SystemGuard';

function measureLatency<T>(fn: () => Promise<T>, endpoint: string, source: string): Promise<T> {
  const timer = apiLatency.startTimer({ endpoint, source });
  return fn().finally(() => timer());
}

const envSchema = Joi.object({
  PORT: Joi.number().default(3000),
  JWT_SECRET: Joi.string().min(32).required(),
  CORS_ORIGIN: Joi.string().uri().required(),
  REDIS_URL: Joi.string().uri().required(),
  MONGO_URI: Joi.string().uri().required(),
  TELEGRAM_BOT_TOKEN: Joi.string().required(),
  TELEGRAM_CHAT_ID: Joi.string().required(),
  BIRDEYE_API_KEY: Joi.string().required(),
  SOLSCAN_API_KEY: Joi.string().required(),
  DRPC_API_KEY: Joi.string().required(),
  SYNDICA_API_KEY: Joi.string().required(),
  HELIUS_API_KEY: Joi.string().required(),
  HELIUS_WEBHOOK_ID: Joi.string().required(),
  MORALIS_API_KEY: Joi.string().required(),
  QUICKNODE_API_KEY: Joi.string().required(),
  ALCHEMY_API_KEY: Joi.string().required(),
  XAI_API_KEY: Joi.string().required(),
  CIELO_API_KEY: Joi.string().required(),
  HUGGINGFACE_API_KEY: Joi.string().required(),
  DEEPSEEK_API_KEY: Joi.string().required(),
  GEMINI_API_KEY: Joi.string().required(),
  OPENAI_API_KEY: Joi.string().required(),
  YANDEXGPT_API_KEY: Joi.string().required(),
  YANDEXGPT_CATALOG_ID: Joi.string().required(),
  SOLANA_RPC_URL: Joi.string().uri().required(),
  SOLANA_RPC_API_KEY: Joi.string().required(),
  SOLANA_DATA_API_KEY: Joi.string().required(),
  PRIVATE_KEY: Joi.string().required(),
  WEBHOOK_SECRET: Joi.string().required(),
}).unknown(true);

const { error: envError } = envSchema.validate(process.env);
if (envError) throw new Error(`Environment validation failed: ${envError.message}`);

export { retry, measureTime, measureLatency, envSchema };
