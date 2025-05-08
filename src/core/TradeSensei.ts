import Redis from 'ioredis';
import { WebSocketServer } from 'ws';
import { Trade, PriceData } from '../utils/types';
import { tf } from '@tensorflow/tfjs-node';

interface Cache {
  get(key: string): Promise<string | null>;
  setex(key: string, seconds: number, value: string): Promise<void>;
  publish(channel: string, message: string): Promise<void>;
  subscribe(channels: string[], callback: (err: Error | null, count: number) => void): void;
  on(event: string, handler: (channel: string, message: string) => void): void;
}

interface Logger {
  info(message: string): void;
  error(message: string): void;
}

// Инициализация зависимостей
const redisClient: Cache = new Redis(process.env.REDIS_URL!, { maxRetriesPerRequest: 3 });
const wss = new WebSocketServer({ port: 8080 });
const logger: Logger = {
  info: (msg) => console.log(`[INFO] ${msg}`),
  error: (msg) => console.error(`[ERROR] ${msg}`)
};

// Идея 1: Адаптация множителя через машинное обучение
async function trainMultiplierModel(ticker: string, trades: Trade[]): Promise<number> {
  try {
    const model = tf.sequential();
    model.add(tf.layers.dense({ units: 32, activation: 'relu', inputShape: [5] }));
    model.add(tf.layers.dense({ units: 1, activation: 'linear' }));
    model.compile({ optimizer: tf.train.adam(0.01), loss: 'meanSquaredError' });

    const inputs = trades.map(t => [
      t.price,
      t.volume,
      t.priceChange,
      t.liquidity,
      t.whaleActivity
    ]);
    const outputs = trades.map(t => {
      const profit = t.roi * t.positionSize;
      return profit > 0 ? 2.5 : 1.5; // Успешные сделки -> высокий множитель
    });

    await model.fit(tf.tensor2d(inputs), tf.tensor1d(outputs), { epochs: 50, batchSize: 16 });
    const recentTrade = trades[trades.length - 1];
    const prediction = model.predict(tf.tensor2d([[
      recentTrade.price,
      recentTrade.volume,
      recentTrade.priceChange,
      recentTrade.liquidity,
      recentTrade.whaleActivity
    ]])) as tf.Tensor;
    const multiplier = (await prediction.data())[0];
    prediction.dispose();
    return Math.min(Math.max(multiplier, 1.5), 2.5);
  } catch (error) {
    logger.error(`Ошибка обучения модели множителя: ${error.message}`);
    return 2;
  }
}

// Идея 2: WebSocket для реал-тайм сигналов
function setupWebSocketSignals(): void {
  redisClient.subscribe(['signals:new'], (err, count) => {
    if (err) logger.error(`Ошибка подписки WebSocket: ${err.message}`);
    else logger.info(`WebSocket подписан на ${count} каналов`);
  });

  redisClient.on('message', (channel, message) => {
    if (channel === 'signals:new') {
      wss.clients.forEach(client => {
        client.send(message);
      });
      logger.info('Сигнал отправлен через WebSocket');
    }
  });

  wss.on('connection', ws => {
    logger.info('Новое WebSocket-соединение');
    ws.on('error', error => logger.error(`Ошибка WebSocket: ${error.message}`));
  });
}

// Идея 3: Интеграция с DexScreener API
async function fetchPricesFromDexScreener(ticker: string): Promise<PriceData[]> {
  try {
    const response = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${ticker}`);
    const data = await response.json();
    return data.pairs[0].priceHistory.slice(-14).map((p: any) => ({
      high: p.high,
      low: p.low,
      close: p.close
    }));
  } catch (error) {
    logger.error(`Ошибка DexScreener API: ${error.message}`);
    return [];
  }
}

// Инициализация WebSocket
setupWebSocketSignals();
