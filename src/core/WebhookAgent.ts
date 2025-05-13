import express from 'express';
import { createHmac } from 'crypto';
import Bull from 'bull';
import TelegramBot from 'node-telegram-bot-api';
import Redis from 'ioredis';
import { MongoClient } from 'mongodb';
import Joi from 'joi';
import { CircuitBreaker } from 'opossum';
import { TokenBucket } from 'limiter';
import promClient from 'prom-client';
import { Connection, PublicKey } from '@solana/web3.js';
import { gzipSync, gunzipSync } from 'zlib';
import axios from 'axios';
import { FilterGuard } from './FilterGuard';
import { TradeGenix } from './TradeGenix';
import { Orchestrator } from './Orchestrator';
import { aiClients } from './index';
import { logger } from '../utils/logger';
import { tradeRoi, telegramApiErrors, telegramCheckLatency } from '../utils/metrics';

// --- Metrics ---
const webhookProcessingMs = new promClient.Histogram({
  name: 'webhook_processing_ms',
  help: 'Webhook processing duration in ms',
  labelNames: ['ticker', 'strategy'],
});
const webhookQueueSize = new promClient.Gauge({
  name: 'webhook_queue_size',
  help: 'Number of tasks in webhook queue',
});

// --- Types ---
interface WebhookPayload {
  ticker: string;
  action: 'buy' | 'sell';
  price: number;
  strategy: string;
  signature: string;
}

interface Token {
  ticker: string;
  price: number;
  volume: number;
  marketCap: number;
  priceChange: number;
}

interface NewsDetails {
  marketCap?: number;
  liquidity?: number;
  snipers?: number;
  category?: string;
  channel?: string;
  socialVolume?: number;
  socialScore?: number;
  galaxyScore?: number;
  announcementImpact?: number;
}

interface Dependencies {
  filterGuard: typeof FilterGuard;
  tradeGenix: typeof TradeGenix;
  orchestrator: typeof Orchestrator;
  aiClients: typeof aiClients;
}

// --- Config ---
const redisClient = new Redis(process.env.REDIS_URL!);
const mongoClient = new MongoClient(process.env.MONGO_URI!);
const telegramBot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN!, { polling: false });
const webhookQueue = new Bull('webhook-queue', process.env.REDIS_URL!);
const redisSignalQueue = new Bull('redis-signal-queue', process.env.REDIS_URL!);
const telegramQueue = new Bull('telegram-queue', process.env.REDIS_URL!);
const router = express.Router();
const webhookSchema = Joi.object({
  ticker: Joi.string().required(),
  action: Joi.string().valid('buy', 'sell').required(),
  price: Joi.number().positive().required(),
  strategy: Joi.string().required(),
  signature: Joi.string().required(),
});
/**
 * Maps TradingView strategies to FilterGuard filters for signal validation.
 * - RSI: Uses `trending_5min` for short-term trend signals (volume > 35k, price change < -15%).
 * - MACD: Uses `nextbc_5min` for breakout signals (volume > 25k, price change > 20%).
 * - Bollinger: Uses `swing_sniper` for swing trading (volume > 40k, price change > 10%).
 */
const strategyToFilter: Record<string, string> = {
  RSI: 'trending_5min',
  MACD: 'nextbc_5min',
  Bollinger: 'swing_sniper',
};
const huggingFaceBreaker = new CircuitBreaker(aiClients.huggingface.query, {
  timeout: 10000,
  errorThresholdPercentage: 50,
  resetTimeout: 30000,
});
const telegramLimiter = new TokenBucket({ capacity: 20, fillRate: 20 / 60 });
let tradeBuffer: any[] = [];
const solanaConnection = new Connection('https://api.mainnet-beta.solana.com');
const rpcPool = [
  'https://api.mainnet-beta.solana.com',
  'https://rpc.ankr.com/solana',
  'https://solana-rpc.projectserum.com',
];
let currentRpcIndex = 0;

// --- Telegram Queue Processor ---
telegramQueue.process(async (job) => {
  const { message, token, chatId } = job.data;
  const errorKey = `telegram:error:${chatId}`;
  const errorCountKey = `telegram:error:count:${chatId}`;
  const start = Date.now();
  try {
    await axios.post(`https://api.telegram.org/bot${token}/sendMessage`, {
      chat_id: chatId,
      text: message,
      parse_mode: 'Markdown',
    });
    telegramCheckLatency.observe({ ticker: '' }, (Date.now() - start) / 1000);
    await redisClient.del(errorKey);
    await redisClient.del(errorCountKey);
    logger.info({ component: 'WEBHOOK_AGENT', message: `Sent Telegram notification to ${chatId}` });
  } catch (error) {
    telegramApiErrors.inc({ ticker: '' });
    const errorCount = parseInt(await redisClient.get(errorCountKey) || '0') + 1;
    const ttl = Math.min(60 * Math.pow(2, errorCount - 1), 300); // Exponential backoff: 60s, 120s, 240s, max 300s
    await redisClient.setEx(errorKey, ttl, 'true');
    await redisClient.setEx(errorCountKey, ttl, errorCount.toString());
    logger.error({ component: 'WEBHOOK_AGENT', message: `Ошибка Telegram уведомления: ${error.message}, backoff TTL: ${ttl}s` });
    throw error;
  }
});

// --- MongoDB Batch Insert ---
setInterval(async () => {
  if (tradeBuffer.length > 0) {
    try {
      await mongoClient.db().collection('trades').insertMany(tradeBuffer);
      logger.info({ component: 'WEBHOOK_AGENT', message: `Inserted ${tradeBuffer.length} trades to MongoDB` });
      tradeBuffer = [];
    } catch (error) {
      logger.error({ component: 'WEBHOOK_AGENT', message: `MongoDB batch insert error: ${error.message}` });
    }
  }
}, 10000);

// --- Queue Size Monitoring ---
setInterval(async () => {
  try {
    const size = await webhookQueue.getWaitingCount();
    webhookQueueSize.set(size);
    if (size > 100) {
      await telegramLimiter.removeTokens(1);
      await WebhookSignalProcessor.notifyTelegram(
        `⚠️ Webhook queue size: ${size}`,
        process.env.TELEGRAM_BOT_TOKEN!,
        process.env.TELEGRAM_CHAT_ID!
      );
      logger.warn({ component: 'WEBHOOK_AGENT', message: `Queue size exceeded: ${size}` });
    }
  } catch (error) {
    logger.error({ component: 'WEBHOOK_AGENT', message: `Queue size check error: ${error.message}` });
  }
}, 60000);

// --- Dynamic Telegram Rate Limiting ---
setInterval(async () => {
  try {
    const signalsPerMin = parseInt(await redisClient.get('market:activity') || '0');
    telegramLimiter.fillRate = signalsPerMin > 50 ? 10 / 60 : signalsPerMin < 10 ? 30 / 60 : 20 / 60;
    logger.info({ component: 'WEBHOOK_AGENT', message: `Updated Telegram fillRate to ${telegramLimiter.fillRate * 60}/min` });
  } catch (error) {
    logger.error({ component: 'WEBHOOK_AGENT', message: `Telegram rate limit update error: ${error.message}` });
  }
}, 30000);

// --- Solana Price Cache ---
async function cacheTokenPrice(ticker: string): Promise<number> {
  const cacheKey = `solana:price:${ticker}`;
  const cachedPrice = await redisClient.get(cacheKey);
  if (cachedPrice) {
    logger.info({ component: 'WEBHOOK_AGENT', message: `Solana price cache hit for ${ticker}` });
    return parseFloat(cachedPrice);
  }
  for (let i = 0; i < rpcPool.length; i++) {
    try {
      const connection = new Connection(rpcPool[currentRpcIndex]);
      const price = 100; // Mock price (replace with real Solana RPC call, e.g., Raydium AMM)
      await redisClient.setEx(cacheKey, 60, price.toString());
      await redisClient.set(`rpc:priority:${rpcPool[currentRpcIndex]}`, Date.now());
      logger.info({ component: 'WEBHOOK_AGENT', message: `Fetched price ${price} from ${rpcPool[currentRpcIndex]}` });
      return price;
    } catch (error) {
      logger.warn({ component: 'WEBHOOK_AGENT', message: `RPC ${rpcPool[currentRpcIndex]} failed: ${error.message}` });
      currentRpcIndex = (currentRpcIndex + 1) % rpcPool.length;
    }
  }
  throw new Error('All RPC nodes failed');
}

// --- Adaptive Position Size ---
async function calculatePositionSize(ticker: string, baseSize: number): Promise<number> {
  const cacheKey = `volatility:${ticker}`;
  const volatility = parseFloat(await redisClient.get(cacheKey) || '0.1');
  // Placeholder: Implement actual liquidity fetching logic
  const liquidity = 1000000; // Mock liquidity (replace with Solana RPC call)
  const positionSize = baseSize * (1 / (volatility + 0.1)) * (liquidity / 1000000);
  logger.info({ component: 'WEBHOOK_AGENT', message: `Calculated positionSize for ${ticker}: ${positionSize}` });
  return positionSize;
}

// --- Helpers ---
async function retry<T>(fn: () => Promise<T>, retries = 3, baseDelay = 1000, maxDelay = 10000): Promise<T> {
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

async function validateWebhookSignature(payload: WebhookPayload): Promise<boolean> {
  const { ticker, action, price, strategy, signature } = payload;
  const secret = process.env.WEBHOOK_SECRET!;
  const computedSignature = createHmac('sha256', secret)
    .update(JSON.stringify({ ticker, action, price, strategy }))
    .digest('hex');
  return signature === computedSignature;
}

async function validateWebhookSignal(
  token: Token,
  strategy: string,
  dependencies: Dependencies
): Promise<boolean> {
  const filter = strategyToFilter[strategy] || 'trending_5min';
  const cacheKey = `filter:${token.ticker}:${filter}`;
  const cachedResult = await redisClient.get(cacheKey);
  if (cachedResult) {
    logger.info({ component: 'WEBHOOK_AGENT', message: `FilterGuard cache hit for ${cacheKey}` });
    return cachedResult === 'true';
  }
  const filterParams = {
    trending_5min: { minVolume: 35000, minPriceChange: -15, minMarketCap: 100000, minSocialPosts: 25, minWhales: 2 },
    nextbc_5min: { minVolume: 25000, minPriceChange: 20, minMarketCap: 50000, minSocialPosts: 25, minWhales: 2 },
    swing_sniper: { minVolume: 40000, minPriceChange: 10, minMarketCap: 200000, minSocialPosts: 20, minWhales: 3 },
  }[filter];
  const validTokens = await dependencies.filterGuard.applyFilters([token], filterParams);
  await redisClient.setEx(cacheKey, 30, validTokens.length > 0 ? 'true' : 'false');
  return validTokens.length > 0;
}

async function generateAndValidateTrade(
  token: Token,
  strategy: string,
  dependencies: Dependencies
): Promise<{ trade: any; huggingFaceRecommendation: string } | null> {
  const filter = strategyToFilter[strategy] || 'trending_5min';
  const cacheKey = `hf:signal:${token.ticker}:${strategy}`;
  const cachedRecommendation = await redisClient.get(cacheKey);
  if (cachedRecommendation) {
    logger.info({ component: 'WEBHOOK_AGENT', message: `HuggingFace cache hit for ${cacheKey}` });
    const recommendation = JSON.parse(cachedRecommendation);
    const action = recommendation.toLowerCase().includes('buy')
      ? 'buy'
      : recommendation.toLowerCase().includes('sell')
      ? 'sell'
      : 'hold';
    const positionSize = await calculatePositionSize(token.ticker, 100);
    const trade = await dependencies.tradeGenix.generateTradeSignal({
      token,
      name: `webhook_${strategy}`,
      positionSize,
      wallet: { id: 'webhook-wallet' },
      filter,
    });
    return trade.action !== 'hold' && action === trade.action ? { trade pronouns: recommendation } : null;
  }
  const prompt = `Оцени сигнал TradingView для ${token.ticker}: ${token.price} (стратегия: ${strategy}). Рекомендация: buy, sell или hold?`;
  let huggingFaceRecommendation: string;
  try {
    huggingFaceRecommendation = await huggingFaceBreaker.fire(prompt);
  } catch {
    huggingFaceRecommendation = await dependencies.aiClients.deepseek.query(prompt);
    logger.warn({ component: 'WEBHOOK_AGENT', message: 'Switched to DeepSeek' });
  }
  await redisClient.setEx(cacheKey, 300, JSON.stringify(huggingFaceRecommendation));
  const action = huggingFaceRecommendation.toLowerCase().includes('buy')
    ? 'buy'
    : huggingFaceRecommendation.toLowerCase().includes('sell')
    ? 'sell'
    : 'hold';
  const positionSize = await calculatePositionSize(token.ticker, 100);
  const trade = await dependencies.tradeGenix.generateTradeSignal({
    token,
    name: `webhook_${strategy}`,
    positionSize,
    wallet: { id: 'webhook-wallet' },
    filter,
  });
  return trade.action !== 'hold' && action === trade.action ? { trade, huggingFaceRecommendation } : null;
}

async function fetchNewsDetails(ticker: string): Promise<NewsDetails> {
  const cacheKey = `news:details:${ticker}`;
  const cachedDetails = await redisClient.get(cacheKey);
  if (cachedDetails) {
    logger.info({ component: 'WEBHOOK_AGENT', message: `News details cache hit for ${ticker}` });
    return JSON.parse(cachedDetails);
  }
  // Placeholder: DataHawk.ts fills news:details:${ticker} with marketCap, liquidity, etc.
  const details: NewsDetails = {};
  await redisClient.setEx(cacheKey, 300, JSON.stringify(details));
  return details;
}

async function formatTelegramMessage(
  action: string,
  ticker: string,
  price: number,
  strategy: string,
  newsDetails: NewsDetails
): Promise<string> {
  let message = `📡 TradingView: ${action.toUpperCase()} ${ticker} @ $${price} (Стратегия: ${strategy})`;
  if (Object.keys(newsDetails).length > 0) {
    message += `\n*Контекст*:`;
    if (newsDetails.marketCap) message += `\n- Market Cap: $${(newsDetails.marketCap / 1e6).toFixed(2)}M`;
    if (newsDetails.liquidity) message += `\n- Liquidity: $${(newsDetails.liquidity / 1e6).toFixed(2)}M`;
    if (newsDetails.snipers) message += `\n- Snipers: ${newsDetails.snipers}`;
    if (newsDetails.category) message += `\n- Category: ${newsDetails.category}`;
    if (newsDetails.channel) message += `\n- Channel: ${newsDetails.channel}`;
    if (newsDetails.socialVolume) message += `\n- Social Volume: ${newsDetails.socialVolume}`;
    if (newsDetails.socialScore) message += `\n- Social Score: ${newsDetails.socialScore}`;
    if (newsDetails.galaxyScore) message += `\n- Galaxy Score: ${newsDetails.galaxyScore}`;
    if (newsDetails.announcementImpact) message += `\n- Announcement Impact: ${(newsDetails.announcementImpact * 100).toFixed(1)}%`;
  }
  return message;
}

async function executeAndNotifyTrade(
  trade: any,
  ticker: string,
  price: number,
  strategy: string,
  huggingFaceRecommendation: string,
  dependencies: Dependencies
): Promise<void> {
  const inputToken = trade.action === 'buy' ? 'SOL' : ticker;
  const outputToken = trade.action === 'buy' ? ticker : 'SOL';
  const cachedPrice = await cacheTokenPrice(ticker);
  try {
    await dependencies.orchestrator.executeSwap(inputToken, outputToken, trade.positionSize);
  } catch (error) {
    await telegramLimiter.removeTokens(1);
    const message = `⚠️ Ошибка сделки ${ticker}: ${error.message}`;
    await WebhookSignalProcessor.notifyTelegram(
      message,
      process.env.TELEGRAM_BOT_TOKEN!,
      process.env.TELEGRAM_CHAT_ID!
    );
    logger.error({ component: 'WEBHOOK_AGENT', message: `Swap failed: ${error.message}` });
    throw error;
  }
  tradeBuffer.push({
    ...trade,
    source: 'tradingview',
    llmAnalysis: huggingFaceRecommendation,
    timestamp: new Date().toISOString(),
    cachedPrice,
  });
  if (tradeBuffer.length >= 100) {
    await mongoClient.db().collection('trades').insertMany(tradeBuffer);
    logger.info({ component: 'WEBHOOK_AGENT', message: `Inserted ${tradeBuffer.length} trades to MongoDB` });
    tradeBuffer = [];
  }
  tradeRoi.observe({ filter: trade.filter, ticker: trade.ticker }, trade.roi);
  const newsDetails = await fetchNewsDetails(ticker);
  const message = await formatTelegramMessage(trade.action, ticker, price, strategy, newsDetails);
  await telegramLimiter.removeTokens(1);
  await WebhookSignalProcessor.notifyTelegram(
    message,
    process.env.TELEGRAM_BOT_TOKEN!,
    process.env.TELEGRAM_CHAT_ID!
  );
  const compressedTrade = gzipSync(Buffer.from(JSON.stringify(trade))).toString('base64');
  await redisClient.publish('trades:executed', compressedTrade);
  logger.info({ component: 'WEBHOOK_AGENT', message: `Executed ${trade.action} for ${ticker}, compressed size: ${compressedTrade.length}` });
}

// --- Signal Processor ---
interface SignalProcessor {
  processWebhook(payload: WebhookPayload): Promise<void>;
  processRedisSignal(signal: any): Promise<void>;
}

class WebhookSignalProcessor implements SignalProcessor {
  constructor(private dependencies: Dependencies) {}

  static async notifyTelegram(message: string, token: string, chatId: string): Promise<void> {
    const errorKey = `telegram:error:${chatId}`;
    const hasRecentError = await redisClient.get(errorKey);
    if (hasRecentError) {
      logger.warn({ component: 'WEBHOOK_AGENT', message: `Skipping Telegram notification for ${chatId} due to recent error` });
      return;
    }
    await telegramQueue.add({ message, token, chatId });
    logger.info({ component: 'WEBHOOK_AGENT', message: `Added Telegram notification to queue for ${chatId}` });
  }

  async processWebhook(payload: WebhookPayload): Promise<void> {
    const { error } = webhookSchema.validate(payload);
    if (error) throw new Error(`Invalid payload: ${error.message}`);
    if (!(await validateWebhookSignature(payload))) {
      logger.error({ component: 'WEBHOOK_AGENT', message: 'Invalid signature' });
      throw new Error('Invalid signature');
    }
    const { ticker, action, price, strategy } = payload;
    const token: Token = { ticker, price, volume: 0, marketCap: 0, priceChange: 0 };
    await webhookQueue.add({ ticker, action, price, strategy });
    const compressedPayload = gzipSync(Buffer.from(JSON.stringify(payload))).toString('base64');
    await redisClient.publish('tradingview:webhooks', compressedPayload);
    await redisClient.incr('market:activity');
    await redisClient.expire('market:activity', 60);
    logger.info({ component: 'WEBHOOK_AGENT', message: `Webhook queued for ${ticker}, compressed size: ${compressedPayload.length}` });
  }

  async processRedisSignal(signal: any): Promise<void> {
    const { ticker, action, price } = signal;
    const newsDetails = await fetchNewsDetails(ticker);
    const message = await formatTelegramMessage(action, ticker, price, 'Redis', newsDetails);
    await telegramLimiter.removeTokens(1);
    await WebhookSignalProcessor.notifyTelegram(
      message,
      process.env.TELEGRAM_BOT_TOKEN!,
      process.env.TELEGRAM_CHAT_ID!
    );
    const compressedSignal = gzipSync(Buffer.from(JSON.stringify({ ticker, action, price, source: 'signals:new' }))).toString('base64');
    await redisClient.publish('tradingview:webhooks', compressedSignal);
    logger.info({ component: 'WEBHOOK_AGENT', message: `Notified signal for ${ticker}, compressed size: ${compressedSignal.length}` });
  }
}

// --- Routes ---
const dependencies: Dependencies = { filterGuard: FilterGuard, tradeGenix: TradeGenix, orchestrator: Orchestrator, aiClients };
const signalProcessor = new WebhookSignalProcessor(dependencies);

router.post('/api/webhook', async (req, res) => {
  try {
    await signalProcessor.processWebhook(req.body);
    res.json({ status: 'queued' });
  } catch (error) {
    logger.error({ component: 'WEBHOOK_AGENT', message: `Webhook error: ${error.message}` });
    res.status(error.message === 'Invalid signature' ? 403 : 400).json({ error: error.message });
  }
});

// --- Queue Processor ---
webhookQueue.process(async (job) => {
  const { ticker, price, strategy } = job.data;
  const timer = webhookProcessingMs.startTimer({ ticker, strategy });
  const token: Token = { ticker, price, volume: 0, marketCap: 0, priceChange: 0 };
  try {
    const isTokenValid = await validateWebhookSignal(token, strategy, dependencies);
    if (!isTokenValid) {
      logger.warn({ component: 'WEBHOOK_AGENT', message: `Invalid token: ${ticker}` });
      return;
    }
    const tradeData = await generateAndValidateTrade(token, strategy, dependencies);
    if (!tradeData) {
      logger.info({ component: 'WEBHOOK_AGENT', message: `Trade for ${ticker} rejected` });
      return;
    }
    const { trade, huggingFaceRecommendation } = tradeData;
    await executeAndNotifyTrade(trade, ticker, price, strategy, huggingFaceRecommendation, dependencies);
  } finally {
    const duration = timer();
    if (duration > 5000) {
      await telegramLimiter.removeTokens(1);
      const message = `⚠️ High webhook processing time: ${duration.toFixed(2)}ms for ${ticker}`;
      await WebhookSignalProcessor.notifyTelegram(
        message,
        process.env.TELEGRAM_BOT_TOKEN!,
        process.env.TELEGRAM_CHAT_ID!
      );
      logger.warn({ component: 'WEBHOOK_AGENT', message: `High processing time: ${duration}ms for ${ticker}` });
    }
  }
});

// --- Redis Subscription ---
redisClient.subscribe('signals:new', (err) => {
  if (err) logger.error({ component: 'WEBHOOK_AGENT', message: `Redis subscription error: ${err.message}` });
});

redisClient.on('message', async (channel, message) => {
  if (channel === 'signals:new') {
    try {
      const decompressed = JSON.parse(gunzipSync(Buffer.from(message, 'base64')).toString());
      await redisSignalQueue.add(decompressed);
    } catch (error) {
      logger.error({ component: 'WEBHOOK_AGENT', message: `Redis signal queue error: ${error.message}` });
    }
  }
});

redisSignalQueue.process(async (job) => {
  try {
    await signalProcessor.processRedisSignal(job.data);
  } catch (error) {
    logger.error({ component: 'WEBHOOK_AGENT', message: `Redis signal processing error: ${error.message}` });
  }
});

export default router;
