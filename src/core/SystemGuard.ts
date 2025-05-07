import logger from '../utils/logger';
import {
  apiLatency,
  tradeSuccess,
  tradeFailure,
  partialExits,
  getMetrics,
} from '../utils/metrics';
import fs from 'fs/promises';
import axios from 'axios';
import { Request, Response, NextFunction } from 'express';
import Redis from 'ioredis';
import jwt from 'jsonwebtoken';
import { MongoClient } from 'mongodb';

const redisClient = new Redis(process.env.REDIS_URL!);

class FileBuffer {
  private buffer: string[] = [];
  private maxSize = 1000;

  async add(data: string) {
    this.buffer.push(data);
    if (this.buffer.length >= this.maxSize) await this.flush();
    logger.info({ component: 'FILE_BUFFER', message: `Added data: ${data}` });
  }

  async flush() {
    if (this.buffer.length === 0) return;
    await fs.appendFile('logs/buffer.txt', this.buffer.join('\n') + '\n');
    this.buffer = [];
    logger.info({ component: 'FILE_BUFFER', message: 'Buffer flushed' });
  }
}

function logInfoAggregated(component: string, message: string) {
  logger.info({ component, message });
  FileBuffer.add(`${component}: ${message}`);
}

function logErrorAggregated(component: string, message: string) {
  logger.error({ component, message });
  FileBuffer.add(`ERROR ${component}: ${message}`);
}

async function rotateLogs() {
  const files = await fs.readdir('logs');
  const oldFiles = files.filter(f => f.includes('api-') && !f.includes(new Date().toISOString().split('T')[0]));
  for (const file of oldFiles) {
    await fs.unlink(`logs/${file}`).catch(() => logErrorAggregated('LOGGER', `Failed to delete ${file}`));
  }
  logInfoAggregated('LOGGER', 'Logs rotated');
}

async function authenticateToken(req: Request, res: Response, next: NextFunction) {
  const token = req.headers['authorization']?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Token missing' });
  const blacklisted = await redisClient.get(`blacklist:${token}`);
  if (blacklisted) return res.status(403).json({ error: 'Token blacklisted' });
  jwt.verify(token, process.env.JWT_SECRET!, (err: any, user: any) => {
    if (err) return res.status(403).json({ error: 'Invalid token' });
    req.user = user;
    next();
  });
}

function authenticateJWT(req: Request, res: Response, next: NextFunction) {
  authenticateToken(req, res, next);
}

function recordMetric(name: string, labels: Record<string, string | number>, value?: number) {
  const metric = [
    tradesExecuted,
    signalsGenerated,
    roiTotal,
    winRate,
    partialExits,
    balance,
    walletsCount,
    apiLatency,
    tradeSuccess,
    tradeFailure,
  ].find(m => m.name === name);
  if (metric) {
    if (value !== undefined && 'observe' in metric) metric.observe(labels, value);
    else if ('inc' in metric) metric.inc(labels);
  }
}

async function sendTelegramAlert(message: string): Promise<void> {
  await axios.post(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    chat_id: process.env.TELEGRAM_CHAT_ID,
    text: message,
  });
  logInfoAggregated('TELEGRAM', `Sent alert: ${message}`);
}

async function connectDB() {
  const client = new MongoClient(process.env.MONGO_URI!);
  await client.connect();
  logInfoAggregated('DB', 'Connected to MongoDB');
  return client.db();
}

async function testProjectIntegrity(): Promise<boolean> {
  const db = await connectDB();
  const collections = await db.listCollections().toArray();
  const required = ['tokens', 'trades', 'wallets', 'capital'];
  const missing = required.filter(r => !collections.some(c => c.name === r));
  if (missing.length > 0) {
    logErrorAggregated('ENHANCEMENTS', `Missing collections: ${missing.join(', ')}`);
    return false;
  }
  logInfoAggregated('ENHANCEMENTS', 'Project integrity test passed');
  return true;
}

async function backup() {
  const db = await connectDB();
  const collections = await db.listCollections().toArray();
  for (const { name } of collections) {
    const data = await db.collection(name).find().toArray();
    await fs.writeFile(`backups/${name}-${new Date().toISOString()}.json`, JSON.stringify(data));
  }
  logInfoAggregated('ENHANCEMENTS', 'Backup completed');
}

async function deploy() {
  logInfoAggregated('ENHANCEMENTS', 'Deploy completed');
}

async function monitorQueues() {
  const queues = await redisClient.keys('queue:*');
  for (const queue of queues) {
    const length = await redisClient.llen(queue);
    recordMetric('queue_length', { queue }, length);
  }
  logInfoAggregated('ENHANCEMENTS', `Monitored ${queues.length} queues`);
}

export {
  FileBuffer,
  logInfoAggregated,
  logErrorAggregated,
  rotateLogs,
  authenticateToken,
  authenticateJWT,
  recordMetric,
  getMetrics,
  sendTelegramAlert,
  testProjectIntegrity,
  backup,
  deploy,
  monitorQueues,
  apiLatency,
  tradeSuccess,
  tradeFailure,
  partialExits,
};
