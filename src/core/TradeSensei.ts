import { Redis } from 'ioredis';
import { MongoClient } from 'mongodb';
import tf from '@tensorflow/tfjs-node';
import { Connection, Keypair } from '@solana/web3.js';
import { Jupiter } from '@jup-ag/api';
import { FilterGuard } from './FilterGuard';
import { WebhookAgent } from './WebhookAgent';
import axios from 'axios';
import { load } from 'ts-dotenv';
import { logger } from '../utils/logger';
import { metrics } from '../utils/metrics';
import { Token, Signal, TradeSenseiDependencies } from '../types';

// Класс TradeSensei
class TradeSensei {
  private dqnModel: tf.Sequential | null = null;
  private balance = 1000; // Начальный баланс для paper trading
  private readonly filterGuard = new FilterGuard();
  private readonly solscanBreaker = new CircuitBreaker(
    (ticker: string) =>
      axios.get(`https://api.solscan.io/amm/pool/${ticker}`, { headers: { Authorization: this.deps.solscanApiKey } }),
    { timeout: 5000, errorThresholdPercentage: 50, resetTimeout: 30000 }
  );
  private readonly cieloBreaker = new CircuitBreaker(
    (ticker: string) =>
      axios.get(`https://api.cielo.io/whale-transactions?ticker=${ticker}`, {
        headers: { Authorization: this.deps.cieloApiKey },
      }),
    { timeout: 5000, errorThresholdPercentage: 50, resetTimeout: 30000 }
  );
  private readonly dexscreenerBreaker = new CircuitBreaker(
    (ticker: string) =>
      axios.get(`https://api.dexscreener.com/token-pairs/v1/solana/${ticker}`),
    { timeout: 5000, errorThresholdPercentage: 50, resetTimeout: 30000 }
  );

  constructor(private readonly deps: TradeSenseiDependencies) {}

  // Валидация токена
  private validateToken(token: any): { token: Token; signal: Partial<Signal> } | null {
    const requiredFields = ['ticker', 'price', 'high', 'low', 'volume', 'marketCap', 'holders', 'transactions'];
    if (!token || requiredFields.some((field) => !token[field] || token[field] < 0)) {
      logger.warn('Некорректные данные токена');
      return null;
    }
    const validatedToken: Token = {
      ticker: token.ticker,
      price: token.price,
      volume: token.volume,
      marketCap: token.marketCap,
      liquidity: token.liquidity || 0,
      priceChange: token.priceChange || 0,
    };
    const signal: Partial<Signal> = {
      ticker: token.ticker,
      marketCap: token.marketCap,
      liquidity: token.liquidity || 0,
      holders: token.holders,
      transactions: token.transactions,
      sentimentScore: token.sentimentScore || 0.5,
      fearGreedIndex: token.fearGreedIndex || 50,
      snipers: token.snipers || 0,
      devHoldings: token.devHoldings || 0,
      socialVolume: token.socialVolume || 0,
      socialScore: token.socialScore || 0,
      galaxyScore: token.galaxyScore || 0,
      announcementImpact: token.announcementImpact || 0,
      category: token.category || 'trend',
      channel: token.channel || 'unknown',
    };
    if (token.source === 'news') {
      if (signal.marketCap! > 500_000 || signal.snipers! > 0.5 || signal.devHoldings! > 0.05) return null;
      if (!['call', 'trend'].includes(signal.category!)) return null;
    }
    return { token: validatedToken, signal };
  }

  // Получение ликвидности через Dexscreener API
  private async fetchDexscreenerLiquidity(ticker: string): Promise<number | null> {
    const cacheKey = `tokens:liquidity:${ticker}`;
    try {
      const response = await this.dexscreenerBreaker.fire(ticker);
      const liquidity = response.data[0]?.liquidity?.usd || 0;
      if (liquidity > 0) {
        await this.deps.redis.setex(cacheKey, 60, liquidity.toString());
        logger.info(`Ликвидность Dexscreener для ${ticker}: ${liquidity}`);
      }
      return liquidity;
    } catch (error) {
      logger.error(`Ошибка Dexscreener API для ${ticker}:`, error);
      metrics.inc('errors_dexscreener_api');
      return null;
    }
  }

  // Получение ликвидности через Solscan или Dexscreener
  private async fetchPoolLiquidity(ticker: string): Promise<number | null> {
    const cacheKey = `tokens:liquidity:${ticker}`;
    const cached = await this.deps.redis.get(cacheKey);
    if (cached) {
      logger.info(`Ликвидность для ${ticker} из кэша`);
      return parseFloat(cached);
    }

    // Попытка через Solscan
    try {
      const response = await this.solscanBreaker.fire(ticker);
      const liquidity = response.data.pool?.liquidity || 0;
      if (liquidity > 0) {
        await this.deps.redis.setex(cacheKey, 60, liquidity.toString());
        logger.info(`Ликвидность Solscan для ${ticker}: ${liquidity}`);
        return liquidity;
      }
    } catch (error) {
      logger.error(`Ошибка Solscan API для ${ticker}:`, error);
      metrics.inc('errors_solscan_api');
    }

    // Fallback на Dexscreener
    const dexscreenerLiquidity = await this.fetchDexscreenerLiquidity(ticker);
    if (dexscreenerLiquidity !== null) {
      return dexscreenerLiquidity;
    }

    // Fallback на последний кэш
    const fallback = await this.deps.redis.get(cacheKey);
    return fallback ? parseFloat(fallback) : null;
  }

  // Получение китовых транзакций через Cielo API
  private async fetchWhaleActivity(ticker: string): Promise<boolean> {
    const cacheKey = `tokens:whales:${ticker}`;
    const cached = await this.deps.redis.get(cacheKey);
    if (cached) {
      logger.info(`Китовые транзакции для ${ticker} из кэша`);
      return cached === 'true';
    }

    try {
      const response = await this.cieloBreaker.fire(ticker);
      const whaleActivity = response.data.transactions?.some((tx: any) => tx.amount >= 15000 && Date.now() - tx.timestamp < 5 * 60 * 1000);
      await this.deps.redis.setex(cacheKey, 60, whaleActivity.toString());
      logger.info(`Китовые транзакции для ${ticker}: ${whaleActivity}`);
      return whaleActivity;
    } catch (error) {
      logger.error(`Ошибка Cielo API для ${ticker}:`, error);
      metrics.inc('errors_cielo_api');
      return false;
    }
  }

  // Проверка ликвидности по фильтрам
  private validateLiquidity(liquidity: number, filter: string): boolean {
    const thresholds = {
      Trending5min: 40000,
      NextBC5min: 35000,
      SolanaSwingSniper: 100000,
    };
    return liquidity >= thresholds[filter];
  }

  // Расчет уровней Фибоначчи
  private async calculateFibonacciLevels(high: number, low: number, ticker: string) {
    const cacheKey = `tokens:fibonacci:${ticker}`;
    const cached = await this.deps.redis.get(cacheKey);
    if (cached) {
      return JSON.parse(cached);
    }

    const diff = high - low;
    const fibLevels = {
      level_236: low + diff * 0.236,
      level_382: low + diff * 0.382,
      level_500: low + diff * 0.5,
      level_618: low + diff * 0.618,
      lastMin: low,
      lastMax: high,
    };

    await this.deps.redis.setex(cacheKey, 300, JSON.stringify(fibLevels));
    return fibLevels;
  }

  // Проверка входа по Фибоначчи
  private async calculateFibonacciEntry(token: Token, signal: Partial<Signal>, fibLevels: any): Promise<{ isValid: boolean; fibonacciLevel: number } | null> {
    const price = token.price;
    const tolerance = 0.02; // ±2%
    const targetLevels = [fibLevels.level_382, fibLevels.level_618];

    // Проверка близости цены к уровням 38.2% или 61.8%
    const closestLevel = targetLevels.find(
      (level) => price >= level * (1 - tolerance) && price <= level * (1 + tolerance)
    );
    if (!closestLevel) return null;

    // Проверка роста объема (за последние 15 мин)
    const historicalData = await this.deps.mongo
      .db('swingsensei')
      .collection('tokens_history')
      .findOne({ ticker: token.ticker, timestamp: { $gte: new Date(Date.now() - 15 * 60 * 1000) } });
    if (!historicalData || token.volume <= historicalData.volume * 1.5) {
      logger.warn(`Недостаточный рост объема для ${token.ticker}`);
      return null;
    }

    // Проверка активности китов
    const whaleActivity = await this.fetchWhaleActivity(token.ticker);
    if (!whaleActivity) {
      logger.warn(`Китовые транзакции не подтверждены для ${token.ticker}`);
      return null;
    }

    // Проверка sentimentScore
    if (signal.sentimentScore! <= 0.7) {
      logger.warn(`Недостаточный sentimentScore для ${token.ticker}`);
      return null;
    }

    return { isValid: true, fibonacciLevel: closestLevel };
  }

  // Проверка истории импульсов для DQN
  private async checkImpulseHistory(ticker: string): Promise<number> {
    const trades = await this.deps.mongo
      .db('swingsensei')
      .collection('trades')
      .find({ ticker, timestamp: { $gte: new Date(Date.now() - 15 * 60 * 1000) } })
      .toArray();
    return trades.some((trade) => trade.entryType === 'fibonacci' && [0.382, 0.618].includes(trade.fibonacciLevel)) ? 1 : 0;
  }

  // Формирование состояния для DQN
  private async buildSignalState(token: Token, signal: Partial<Signal>, fibLevels: any): Promise<number[]> {
    const impulseHistory = await this.checkImpulseHistory(token.ticker);
    return [
      token.price,
      token.volume,
      token.marketCap,
      signal.liquidity!,
      signal.holders!,
      signal.transactions!,
      signal.sentimentScore!,
      signal.fearGreedIndex! / 100,
      fibLevels.level_382,
      fibLevels.level_618,
      impulseHistory,
    ];
  }

  // Применение DQN-модели
  private applyDQNModel(state: number[]): number {
    return tf.tidy(() => {
      const stateTensor = tf.tensor2d([state]);
      const prediction = this.dqnModel!.predict(stateTensor) as tf.Tensor;
      return prediction.argMax(1).dataSync()[0];
    });
  }

  // Генерация сигнала
  async generateSignal(token: any, source: 'tokens' | 'news' | 'webhook' = 'tokens') {
    if (!this.dqnModel) {
      logger.warn('DQN-модель не загружена');
      return null;
    }

    const validated = this.validateToken(token);
    if (!validated) return null;
    const { token: validatedToken, signal: validatedSignal } = validated;

    const liquidity = await this.fetchPoolLiquidity(validatedToken.ticker);
    if (!liquidity) return null;
    validatedToken.liquidity = liquidity;
    validatedSignal.liquidity = liquidity;

    const filters = [
      { name: 'Trending5min', passed: this.filterGuard.applyTrending5min(validatedToken) },
      { name: 'NextBC5min', passed: this.filterGuard.applyNextBC5min(validatedToken) },
      { name: 'SolanaSwingSniper', passed: this.filterGuard.applySolanaSwingSniper(validatedToken) },
    ];

    const filterPassed = filters.find((f) => f.passed && this.validateLiquidity(liquidity, f.name));
    if (!filterPassed) {
      logger.warn(`Фильтры не пройдены для ${validatedToken.ticker}`);
      return null;
    }

    const fibLevels = await this.calculateFibonacciLevels(token.high || token.price, token.low || token.price, validatedToken.ticker);
    const fibEntry = await this.calculateFibonacciEntry(validatedToken, validatedSignal, fibLevels);
    if (!fibEntry) {
      logger.warn(`Фибоначчи вход не подтвержден для ${validatedToken.ticker}`);
      return null;
    }

    const calculatedTradeVolume = Math.min(liquidity * 0.008, liquidity * 0.001, this.balance * 0.1);
    if (calculatedTradeVolume <= 0) {
      logger.warn(`Недостаточный объем для ${validatedToken.ticker}`);
      return null;
    }

    const state = await this.buildSignalState(validatedToken, validatedSignal, fibLevels);
    const action = this.applyDQNModel(state);

    if (action === 1) {
      const signal: Signal = {
        agent: 'TradeSensei',
        action: 'buy',
        entryType: 'fibonacci',
        fibonacciLevel: fibEntry.fibonacciLevel,
        timestamp: Date.now().toString(),
        source,
        confidence: 0.8, // Можно уточнить логику
        ticker: validatedToken.ticker,
        volume: calculatedTradeVolume,
        marketCap: validatedToken.marketCap,
        liquidity: validatedSignal.liquidity,
        snipers: validatedSignal.snipers!,
        devHoldings: validatedSignal.devHoldings!,
        socialVolume: validatedSignal.socialVolume!,
        socialScore: validatedSignal.socialScore!,
        galaxyScore: validatedSignal.galaxyScore!,
        announcementImpact: validatedSignal.announcementImpact!,
        category: validatedSignal.category!,
        channel: validatedSignal.channel!,
        sentimentScore: validatedSignal.sentimentScore,
        fearGreedIndex: validatedSignal.fearGreedIndex,
      };

      await this.deps.redis.publish('signals:new', JSON.stringify(signal));
      await this.deps.mongo.db('swingsensei').collection('signals').insertOne(signal);
      metrics.signalsGenerated.inc({ source });
      return signal;
    }

    return null;
  }

  // Арбитраж сигнала
  private async arbitrateSignal(signal: any) {
    const { token } = signal;
    if (!token) {
      logger.warn('Некорректный сигнал для арбитража');
      return 'reject';
    }

    const arbitrationPromises = [];
    const geminiQueueKey = 'gemini:queue';
    const queueLength = await this.deps.redis.llen(geminiQueueKey);
    if (queueLength < 60) {
      await this.deps.redis.lpush(geminiQueueKey, JSON.stringify({ token }));
      await this.deps.redis.expire(geminiQueueKey, 60);
      arbitrationPromises.push(
        axios.post('https://api.gemini.com/v1/arbitrate', { token }, { headers: { Authorization: env.GEMINI_API_KEY } })
      );
    }

    arbitrationPromises.push(
      axios.post('https://api.deepseek.com/v1/arbitrate', { token }, { headers: { Authorization: env.DEEPSEEK_API_KEY } }),
      axios.post('https://api.openai.com/v1/arbitrate', { token }, { headers: { Authorization: env.OPENAI_API_KEY } })
    );

    try {
      const results = await Promise.allSettled(arbitrationPromises);
      const votes = results
        .map((result, index) => {
          if (result.status === 'fulfilled') {
            return result.value.data.vote;
          }
          logger.warn(`Арбитраж не удался для ${index === 0 ? 'Gemini' : index === 1 ? 'DeepSeek' : 'OpenAI'}`);
          return null;
        })
        .filter((v) => v !== null);

      const decision = votes.reduce((acc, vote) => (vote === 'approve' ? acc + 1 : acc), 0) > votes.length / 2 ? 'approve' : 'reject';
      await this.deps.redis.publish('arbitration:decisions', JSON.stringify({ ticker: token.ticker, decision }));
      metrics.arbitrationDecisions.inc();
      return decision;
    } catch (error) {
      logger.error('Ошибка арбитража:', error);
      metrics.inc('errors_arbitration');
      return 'reject';
    }
  }

  // Загрузка DQN-модели
  private async loadDQNModel() {
    try {
      const modelData = await this.deps.redis.get('dqn:model');
      if (modelData) {
        this.dqnModel = await tf.loadLayersModel(`data:${modelData}`);
        logger.info('DQN-модель загружена');
      } else {
        logger.warn('DQN-модель не найдена в Redis');
      }
    } catch (error) {
      logger.error('Ошибка загрузки DQN:', error);
      metrics.errors_dqn_load.inc();
    }
  }

  // Обучение DQN
  private async trainDQN() {
    if (!this.dqnModel) return;
    try {
      const trades = await this.deps.mongo
        .db('swingsensei')
        .collection('trades')
        .find({ timestamp: { $gte: Date.now() - 24 * 60 * 60 * 1000 } })
        .limit(50)
        .toArray();

      const states = await Promise.all(
        trades.map(async (t) => {
          const fibLevels = await this.calculateFibonacciLevels(t.high || t.price, t.low || t.price, t.ticker);
          const impulseHistory = await this.checkImpulseHistory(t.ticker);
          return [
            t.price,
            t.volume,
            t.marketCap,
            t.liquidity,
            t.holders,
            t.transactions,
            t.sentimentScore || 0.5,
            t.fearGreedIndex || 50,
            fibLevels.level_382,
            fibLevels.level_618,
            impulseHistory,
          ];
        })
      );
      const rewards = trades.map((t) => (t.entryType === 'fibonacci' ? t.roi * t.volume * 1.2 : t.roi * t.volume) / this.balance);
      const actions = trades.map((t) => (t.action === 'buy' ? 1 : 0));

      const stateTensor = tf.tensor2d(states);
      const actionTensor = tf.tensor1d(actions, 'int32');
      const rewardTensor = tf.tensor1d(rewards);

      await this.dqnModel.fit(stateTensor, actionTensor, { epochs: 1, sampleWeight: rewardTensor });

      const modelData = await this.dqnModel.save('data://model');
      await this.deps.redis.set('dqn:model', modelData, 'EX', 3600);
      logger.info('DQN-модель обучена');
    } catch (error) {
      logger.error('Ошибка обучения DQN:', error);
      metrics.inc('errors_dqn_train');
    }
  }

  // Инициализация подписок
  async init() {
    await this.deps.mongo.connect();
    await this.loadDQNModel();
    setInterval(() => this.trainDQN(), 5 * 60 * 1000);

    const channels = ['tokens:new', 'news:signals', 'tradingview:webhooks', 'models:updated'];
    for (const channel of channels) {
      this.deps.redis.subscribe(channel, (err) => {
        if (err) {
          logger.error(`Ошибка подписки на ${channel}:`, err);
          metrics.inc('errors_redis');
        }
      });
    }

    this.deps.redis.on('message', async (channel, message) => {
      try {
        const data = JSON.parse(message);
        if (channel === 'tokens:new') {
          const signal = await this.generateSignal(data, 'tokens');
          if (signal && (await this.arbitrateSignal(signal)) === 'approve') {
            await WebhookAgent.notifyTelegram(
              `Новый сигнал по токену: ${JSON.stringify(signal)}`,
              this.deps.telegramBotToken,
              this.deps.telegramChatId
            );
          }
        } else if (channel === 'news:signals') {
          const token = { ...data.token, sentimentScore: data.sentimentScore, fearGreedIndex: data.fearGreedIndex };
          const signal = await this.generateSignal(token, 'news');
          if (signal && (await this.arbitrateSignal(signal)) === 'approve') {
            await WebhookAgent.notifyTelegram(
              `Сигнал на основе новостей: ${JSON.stringify(signal)}`,
              this.deps.telegramBotToken,
              this.deps.telegramChatId
            );
          }
        } else if (channel === 'tradingview:webhooks') {
          const token = { ...data.token, sentimentScore: 0.7 };
          const signal = await this.generateSignal(token, 'webhook');
          if (signal && (await this.arbitrateSignal(signal)) === 'approve') {
            await WebhookAgent.notifyTelegram(
              `Сигнал вебхука: ${JSON.stringify(signal)}`,
              this.deps.telegramBotToken,
              this.deps.telegramChatId
            );
          }
        } else if (channel === 'models:updated') {
          await this.loadDQNModel();
        }
      } catch (error) {
        logger.error(`Ошибка обработки сообщения ${channel}:`, error);
        metrics.errors_message_processing.inc();
      }
    });
  }
}

// Загрузка окружения
const env = load({
  REDIS_URL: String,
  MONGO_URI: String,
  GEMINI_API_KEY: String,
  DEEPSEEK_API_KEY: String,
  OPENAI_API_KEY: String,
  SOLANA_RPC_API_KEY: String,
  TELEGRAM_BOT_TOKEN: String,
  TELEGRAM_CHAT_ID: String,
  PRIVATE_KEY: String,
  SOLSCAN_API_KEY: String,
  CIELO_API_KEY: String,
});

// Инициализация зависимостей
const redis = new Redis(env.REDIS_URL);
const mongo = new MongoClient(env.MONGO_URI);
const connection = new Connection(`https://api.mainnet-beta.solana.com?api-key=${env.SOLANA_RPC_API_KEY}`);
const wallet = Keypair.fromSecretKey(Buffer.from(env.PRIVATE_KEY, 'base64'));
const jupiter = new Jupiter({ connection, wallet });

// Запуск
const tradeSensei = new TradeSensei({
  redis,
  mongo,
  jupiter,
  solscanApiKey: env.SOLSCAN_API_KEY,
  cieloApiKey: env.CIELO_API_KEY,
  telegramBotToken: env.TELEGRAM_BOT_TOKEN,
  telegramChatId: env.TELEGRAM_CHAT_ID,
});
tradeSensei.init().catch((error) => {
  logger.error('Ошибка инициализации:', error);
  metrics.inc('errors_init');
});
