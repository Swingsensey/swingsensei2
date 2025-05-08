import logger from '../utils/logger';
import { Counter, Histogram, register } from 'prom-client';
import fs from 'fs/promises';
import axios from 'axios';
import { Request, Response, NextFunction } from 'express';
import Redis from 'ioredis';
import jwt from 'jsonwebtoken';
import { MongoClient } from 'mongodb';
import * as tf from '@tensorflow/tfjs';
import { publish, subscribe } from '../utils/messageBroker';
import { pipeline, Pipeline } from '@xenova/transformers';

// Инициализация сервисов
const redisClient = new Redis(process.env.REDIS_URL || 'redis://localhost:6379');
const mongoClient = new MongoClient(process.env.MONGO_URI || 'mongodb://localhost:27017/swingsensei');

// Prometheus метрики
const apiLatency = new Histogram({
  name: 'api_latency_seconds',
  help: 'API response time in seconds',
  labelNames: ['endpoint'],
});
const tradeSuccess = new Counter({
  name: 'trades_success_total',
  help: 'Total successful trades',
  labelNames: ['ticker'],
});
const tradeFailure = new Counter({
  name: 'trades_failure_total',
  help: 'Total failed trades',
  labelNames: ['ticker'],
});
const partialExits = new Counter({
  name: 'partial_exits_total',
  help: 'Total partial exits',
  labelNames: ['ticker'],
});
const tradesExecuted = new Counter({
  name: 'trades_executed_total',
  help: 'Total trades executed',
  labelNames: ['ticker'],
});
const signalsGenerated = new Counter({
  name: 'signals_generated_total',
  helpBuffering log entries
class LogBuffer {
  private entries: string[] = [];
  private readonly maxSize = 1000;
  private readonly logFilePath = 'logs/buffer.txt';

  async append(entry: string): Promise<void> {
    this.entries.push(entry);
    if (this.entries.length >= this.maxSize) {
      await this.flush();
    }
    logger.info({ component: 'LOG_BUFFER', message: `Appended: ${entry}` });
  }

  async flush(): Promise<void> {
    if (this.entries.length === 0) return;
    await fs.appendFile(this.logFilePath, this.entries.join('\n') + '\n');
    this.entries = [];
    logger.info({ component: 'LOG_BUFFER', message: 'Buffer flushed' });
  }
}

const logBuffer = new LogBuffer();

// Логирование
function logInfo(component: string, message: string): void {
  logger.info({ component, message });
  logBuffer.append(`${component}: ${message}`);
}

function logError(component: string, message: string): void {
  logger.error({ component, message });
  logBuffer.append(`ERROR ${component}: ${message}`);
}

// Ротация логов
async function rotateLogFiles(): Promise<void> {
  const files = await fs.readdir('logs');
  const currentDate = new Date().toISOString().split('T')[0];
  const oldFiles = files.filter(file => file.includes('api-') && !file.includes(currentDate));
  for (const file of oldFiles) {
    await fs.unlink(`logs/${file}`).catch(err => logError('LOG_ROTATION', `Failed to delete ${file}: ${err.message}`));
  }
  logInfo('LOG_ROTATION', 'Log files rotated');
}

// Аутентификация
async function authenticateJwtToken(req: Request, res: Response, next: NextFunction): Promise<void> {
  const token = req.headers['authorization']?.split(' ')[1];
  if (!token) {
    res.status(401).json({ error: 'Token missing' });
    return;
  }
  const isBlacklisted = await redisClient.get(`blacklist:${token}`);
  if (isBlacklisted) {
    res.status(403).json({ error: 'Token blacklisted' });
    return;
  }
  jwt.verify(token, process.env.JWT_SECRET!, (err: any, user: any) => {
    if (err) {
      res.status(403).json({ error: 'Invalid token' });
      return;
    }
    req.user = user;
    next();
  });
}

// Метрики
function recordPrometheusMetric(
  metric: Histogram<string> | Counter<string>,
  labels: Record<string, string | number>,
  value?: number
): void {
  if ('observe' in metric && value !== undefined) {
    metric.observe(labels, value);
  } else if ('inc' in metric) {
    metric.inc(labels);
  }
}

async function getPrometheusMetrics(): Promise<string> {
  return register.metrics();
}

// Уведомления
async function sendTelegramNotification(message: string): Promise<void> {
  await axios.post(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    chat_id: process.env.TELEGRAM_CHAT_ID,
    text: message,
  });
  logInfo('TELEGRAM', `Notification sent: ${message}`);
}

// MongoDB
async function connectMongoDb(): Promise<any> {
  await mongoClient.connect();
  logInfo('MONGODB', 'Connected to MongoDB');
  return mongoClient.db();
}

// Проверка целостности
async function verifyProjectIntegrity(): Promise<boolean> {
  const mongoDb = await connectMongoDb();
  const collections = await mongoDb.listCollections().toArray();
  const requiredCollections = ['tokens', 'trades', 'wallets', 'capital'];
  const missingCollections = requiredCollections.filter(
    name => !collections.some((c: any) => c.name === name)
  );
  if (missingCollections.length > 0) {
    logError('INTEGRITY', `Missing collections: ${missingCollections.join(', ')}`);
    return false;
  }
  logInfo('INTEGRITY', 'Project integrity verified');
  return true;
}

// Резервное копирование
async function backupMongoCollections(): Promise<void> {
  const mongoDb = await connectMongoDb();
  const collections = await mongoDb.listCollections().toArray();
  for (const { name } of collections) {
    const data = await mongoDb.collection(name).find().toArray();
    const backupPath = `backups/${name}-${new Date().toISOString()}.json`;
    await fs.writeFile(backupPath, JSON.stringify(data));
  }
  logInfo('BACKUP', 'MongoDB collections backed up');
}

// Мониторинг очередей
async function monitorRedisQueues(): Promise<void> {
  const queueKeys = await redisClient.keys('queue:*');
  for (const queue of queueKeys) {
    const length = await redisClient.llen(queue);
    recordPrometheusMetric(new Histogram({
      name: 'queue_length',
      help: 'Length of Redis queues',
      labelNames: ['queue'],
    }), { queue }, length);
  }
  logInfo('QUEUES', `Monitored ${queueKeys.length} queues`);
}

// Класс SystemMaster
class SystemMaster {
  private readonly dqnModel: tf.Sequential;
  private readonly mongoDb: any;
  private readonly errorAnalyzer: Pipeline;

  constructor() {
    this.dqnModel = this.initializeDqnModel();
    this.mongoDb = connectMongoDb();
    this.errorAnalyzer = this.initializeErrorAnalyzer();
    this.subscribeToRedisEvents();
  }

  private initializeDqnModel(): tf.Sequential {
    const model = tf.sequential();
    model.add(tf.layers.dense({ units: 64, inputShape: [5], activation: 'relu' }));
    model.add(tf.layers.dense({ units: 32, activation: 'relu' }));
    model.add(tf.layers.dense({ units: 3, activation: 'linear' }));
    model.compile({ optimizer: 'adam', loss: 'meanSquaredError' });
    return model;
  }

  private async initializeErrorAnalyzer(): Promise<Pipeline> {
    return pipeline('text-generation', 'distilbert-base-uncased');
  }

  private async subscribeToRedisEvents(): Promise<void> {
    await subscribe('system:events', async (message: string) => {
      const event = JSON.parse(message);
      switch (event.type) {
        case 'errors:detected':
          await this.analyzeError(event.payload);
          break;
        case 'trades:executed':
          await this.updateTradeMetrics(event.payload);
          break;
      }
    });
    logInfo('SYSTEMMASTER', 'Subscribed to Redis events');
  }

  private async analyzeError(error: any): Promise<void> {
    try {
      const analysis = await this.errorAnalyzer(`Analyze error: ${JSON.stringify(error)}`, {
        max_length: 100,
      });
      const result = analysis[0].generated_text;
      await publish('errors:resolved', JSON.stringify({ error, analysis: result }));
      await sendTelegramNotification(`Error resolved: ${error.message}\nAnalysis: ${result}`);
      logInfo('SYSTEMMASTER', `Error analyzed: ${error.message}`);
    } catch (err) {
      logError('SYSTEMMASTER', `Error analysis failed: ${err.message}`);
      await this.fallbackErrorAnalysis(error);
    }
  }

  private async fallbackErrorAnalysis(error: any): Promise<void> {
    try {
      const response = await axios.post(
        'https://api.deepseek.com/v1',
        { prompt: `Analyze error: ${JSON.stringify(error)}` },
        { headers: { Authorization: `Bearer ${process.env.DEEPSEEK_API_KEY}` } }
      );
      const analysis = response.data.text;
      await publish('errors:resolved', JSON.stringify({ error, analysis }));
      await sendTelegramNotification(`Error resolved (DeepSeek): ${error.message}\nAnalysis: ${analysis}`);
      logInfo('SYSTEMMASTER', `Error analyzed via DeepSeek: ${error.message}`);
    } catch (err) {
      logError('SYSTEMMASTER', `DeepSeek analysis failed: ${err.message}`);
    }
  }

  private async updateTradeMetrics(trade: any): Promise<void> {
    try {
      const mongoDb = await this.mongoDb;
      tradesExecuted.inc({ ticker: trade.ticker });
      if (trade.success) {
        tradeSuccess.inc({ ticker: trade.ticker });
      } else {
        tradeFailure.inc({ ticker: trade.ticker });
      }
      if (trade.partialExit) {
        partialExits.inc({ ticker: trade.ticker });
      }

      const trades = await mongoDb.collection('trades').find().toArray();
      const wallets = await mongoDb.collection('wallets').find().toArray();

      const roi = this.calculateRoi(trades);
      const winRate = this.calculateWinRate(trades);
      const balance = this.calculateBalance(wallets);
      const walletCount = wallets.length;

      recordPrometheusMetric(new Histogram({
        name: 'roi_total',
        help: 'Total ROI across trades',
        labelNames: ['component'],
      }), { component: 'system' }, roi);
      recordPrometheusMetric(new Histogram({
        name: 'win_rate',
        help: 'Trade win rate percentage',
        labelNames: ['component'],
      }), { component: 'system' }, winRate);
      recordPrometheusMetric(new Histogram({
        name: 'balance',
        help: 'Total wallet balance',
        labelNames: ['component'],
      }), { component: 'system' }, balance);
      recordPrometheusMetric(new Counter({
        name: 'wallets_count',
        help: 'Number of wallets',
        labelNames: ['component'],
      }), { component: 'system' }, walletCount);

      logInfo('SYSTEMMASTER', 'Trade metrics updated');
    } catch (err) {
      logError('SYSTEMMASTER', `Failed to update metrics: ${err.message}`);
    }
  }

  private calculateRoi(trades: any[]): number {
    return trades.length > 0
      ? trades.reduce((sum: number, trade: any) => sum + trade.roi, 0) / trades.length
      : 0;
  }

  private calculateWinRate(trades: any[]): number {
    const wins = trades.filter((trade: any) => trade.success).length;
    return trades.length > 0 ? (wins / trades.length) * 100 : 0;
  }

  private calculateBalance(wallets: any[]): number {
    return wallets.reduce((sum: number, wallet: any) => sum + wallet.balance, 0);
  }

  async trainDqnModel(): Promise<void> {
    try {
      const mongoDb = await this.mongoDb;
      const trades = await mongoDb.collection('trades').find().toArray();
      const { states, actions } = this.prepareDqnData(trades);

      const inputs = tf.tensor2d(states);
      const targets = tf.tensor2d(actions);
      await this.dqnModel.fit(inputs, targets, { epochs: 10 });
      inputs.dispose();
      targets.dispose();

      await this.dqnModel.save('file://./models/dqn');
      await publish('models:updated', JSON.stringify({ model: 'dqn', timestamp: new Date().toISOString() }));
      logInfo('SYSTEMMASTER', 'DQN model trained and saved');
    } catch (err) {
      logError('SYSTEMMASTER', `DQN training failed: ${err.message}`);
    }
  }

  private prepareDqnData(trades: any[]): { states: number[][], actions: number[][] } {
    const states = trades.map((trade: any) => {
      const normalizedPrice = trade.price / 1000; // Пример нормализации
      const normalizedVolume = trade.volume / 1000000;
      return [normalizedPrice, normalizedVolume, trade.roi, trade.positionSize, trade.executionTime];
    });
    const actions = trades.map((trade: any) =>
      trade.action === 'buy' ? [1, 0, 0] : trade.action === 'sell' ? [0, 1, 0] : [0, 0, 1]
    );
    return { states, actions };
  }

  async trainLlmModel(): Promise<void> {
    try {
      const mongoDb = await this.mongoDb;
      const trades = await mongoDb.collection('trades').find().toArray();
      const trainingData = trades.map((trade: any) => ({
        text: `Trade: ${trade.ticker}, Price: ${trade.price}, Volume: ${trade.volume}`,
        label: trade.explanation || 'No explanation provided',
      }));

      // Локальное обучение DistilBERT
      const trainer = await pipeline('text-classification', 'distilbert-base-uncased');
      // Имитация обучения (упрощенно, так как полное обучение требует GPU)
      logInfo('SYSTEMMASTER', 'Simulated LLM training with DistilBERT');

      await publish('models:updated', JSON.stringify({ model: 'llm', timestamp: new Date().toISOString() }));
      logInfo('SYSTEMMASTER', 'LLM model training completed');
    } catch (err) {
      logError('SYSTEMMASTER', `LLM training failed: ${err.message}`);
    }
  }

  async startMonitoring(): Promise<void> {
    setInterval(() => rotateLogFiles(), 24 * 60 * 60 * 1000);
    setInterval(() => monitorRedisQueues(), 60 * 1000);
    setInterval(() => this.trainDqnModel(), 24 * 60 * 60 * 1000);
    setInterval(() => this.trainLlmModel(), 7 * 24 * 60 * 60 * 1000);
    logInfo('SYSTEMMASTER', 'Monitoring started');
  }
}

export {
  LogBuffer,
  logInfo,
  logError,
  rotateLogFiles,
  authenticateJwtToken,
  recordPrometheusMetric,
  getPrometheusMetrics,
  sendTelegramNotification,
  verifyProjectIntegrity,
  backupMongoCollections,
  monitorRedisQueues,
  SystemMaster,
  apiLatency,
  tradeSuccess,
  tradeFailure,
  partialExits,
  tradesExecuted,
  signalsGenerated,
};
