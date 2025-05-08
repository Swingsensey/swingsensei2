import { Redis } from 'ioredis';
import { MongoClient } from 'mongodb';
import { promisify } from 'util';
import tf from '@tensorflow/tfjs-node';
import { Jupiter } from '@jup-ag/api';
import { FilterGuard } from './FilterGuard';
import { WebhookAgent } from './WebhookAgent';
import axios from 'axios';
import { load } from 'ts-dotenv';
import { logger } from '../utils/logger';
import { metrics } from '../utils/metrics';

// Load environment variables
const env = load({
  REDIS_URL: String,
  MONGO_URI: String,
  GEMINI_API_KEY: String,
  DEEPSEEK_API_KEY: String,
  OPENAI_API_KEY: String,
});

// Initialize Redis, MongoDB, and Jupiter API
const redis = new Redis(env.REDIS_URL);
const mongo = new MongoClient(env.MONGO_URI);
const jupiter = new Jupiter();

// Initialize FilterGuard
const filterGuard = new FilterGuard();

// State
let dqnModel: tf.Sequential | null = null;
let balance = 1000; // Paper trading initial balance

// Load DQN model from Redis (updated by SystemMaster)
async function loadDQNModel() {
  try {
    const modelData = await redis.get('dqn:model');
    if (modelData) {
      dqnModel = await tf.loadLayersModel(`data:${modelData}`);
      logger.info('DQN model loaded from Redis');
    } else {
      logger.warn('No DQN model found in Redis, waiting for SystemMaster update');
    }
  } catch (error) {
    logger.error('Error loading DQN model:', error);
    metrics.inc('errors_dqn_load');
  }
}

// Generate trading signals using DQN and filters
async function generateSignal(token: any) {
  if (!dqnModel) {
    logger.warn('DQN model not loaded, skipping signal generation');
    return null;
  }

  const state = [
    token.price,
    token.volume,
    token.marketCap,
    token.liquidity,
    token.holders,
    token.transactions,
  ];

  const action = tf.tidy(() => {
    const stateTensor = tf.tensor2d([state]);
    const prediction = dqnModel!.predict(stateTensor) as tf.Tensor;
    return prediction.argMax(1).dataSync()[0];
  });

  const filters = [
    filterGuard.applyTrending5min(token),
    filterGuard.applyNextBC5min(token),
    filterGuard.applySolanaSwingSniper(token),
  ];

  const filterPassed = filters.some((f) => f);
  if (action === 1 && filterPassed) {
    const signal = {
      agent: 'TradeSensei',
      signal: 'buy',
      confidence: 0.8,
      timestamp: Date.now(),
      token,
    };

    await redis.publish('signals:new', JSON.stringify(signal));
    await mongo.db('swingsensei').collection('signals').insertOne(signal);
    metrics.inc('signals_generated');
    return signal;
  }

  return null;
}

// Execute partial exit strategy
async function executePartialExit(trade: any) {
  const { ticker, price, entryPrice } = trade;
  const roi = (price - entryPrice) / entryPrice;

  let exitPercentage = 0;
  if (roi >= 1) exitPercentage = 0.3; // 30% at +100%
  else if (roi >= 0.5) exitPercentage = 0.3; // 30% at +50%
  else if (roi <= -0.15) exitPercentage = 1; // Full exit at -15%

  if (exitPercentage > 0) {
    const exitTrade = {
      ticker,
      percentage: exitPercentage,
      price,
      timestamp: Date.now(),
    };

    await redis.publish('trade:partial_exit', JSON.stringify(exitTrade));
    await mongo.db('swingsensei').collection('partial_exits').insertOne(exitTrade);
    metrics.inc('partial_exits');
  }
}

// Arbitrate signals using Gemini, DeepSeek, OpenAI
async function arbitrateSignal(signal: any) {
  const { token } = signal;
  const arbitrationPromises = [
    axios.post('https://api.gemini.com/v1/arbitrate', { token }, { headers: { 'Authorization': env.GEMINI_API_KEY } }),
    axios.post('https://api.deepseek.com/v1/arbitrate', { token }, { headers: { 'Authorization': env.DEEPSEEK_API_KEY } }),
    axios.post('https://api.openai.com/v1/arbitrate', { token }, { headers: { 'Authorization': env.OPENAI_API_KEY } }),
  ];

  try {
    const [gemini, deepseek, openai] = await Promise.allSettled(arbitrationPromises);
    const votes = [
      gemini.status === 'fulfilled' ? gemini.value.data.vote : null,
      deepseek.status === 'fulfilled' ? deepseek.value.data.vote : null,
      openai.status === 'fulfilled' ? openai.value.data.vote : null,
    ].filter((v) => v !== null);

    const decision = votes.reduce((acc, vote) => (vote === 'approve' ? acc + 1 : acc), 0) > votes.length / 2 ? 'approve' : 'reject';

    await redis.publish('arbitration:decisions', JSON.stringify({ signal, decision }));
    metrics.inc('arbitration_decisions');
    return decision;
  } catch (error) {
    logger.error('Error arbitrating signal:', error);
    metrics.inc('errors_arbitration');
    return 'reject';
  }
}

// Subscribe to tokens and news
async function init() {
  await mongo.connect();
  await loadDQNModel();

  redis.subscribe('tokens:new', async (err, count) => {
    if (err) {
      logger.error('Redis subscribe error:', err);
      metrics.inc('errors_redis');
      return;
    }

    redis.on('message', async (channel, message) => {
      if (channel === 'tokens:new') {
        const token = JSON.parse(message);
        const signal = await generateSignal(token);
        if (signal) {
          const decision = await arbitrateSignal(signal);
          if (decision === 'approve') {
            await WebhookAgent.notifyTelegram(`New signal: ${JSON.stringify(signal)}`);
          }
        }
      }
    });
  });

  redis.subscribe('news:signals', async (err, count) => {
    if (err) {
      logger.error('Redis subscribe error:', err);
      metrics.inc('errors_redis');
      return;
    }

    redis.on('message', async (channel, message) => {
      if (channel === 'news:signals') {
        const news = JSON.parse(message);
        const token = { ...news.token, sentimentScore: news.sentimentScore };
        const signal = await generateSignal(token);
        if (signal) {
          const decision = await arbitrateSignal(signal);
          if (decision === 'approve') {
            await WebhookAgent.notifyTelegram(`News-based signal: ${JSON.stringify(signal)}`);
          }
        }
      }
    });
  });

  redis.subscribe('models:updated', async (err, count) => {
    if (err) {
      logger.error('Redis subscribe error:', err);
      metrics.inc('errors_redis');
      return;
    }

    redis.on('message', async (channel, message) => {
      if (channel === 'models:updated') {
        await loadDQNModel();
      }
    });
  });
}

// Start TradeSensei
init().catch((error) => {
  logger.error('TradeSensei init error:', error);
  metrics.inc('errors_init');
});
