import { Redis } from 'ioredis';
import { MongoClient } from 'mongodb';
import { CircuitBreaker } from 'opossum';
import { TelegramBot } from 'node-telegram-bot-api';
import { scheduleJob } from 'node-schedule';
import { logInfoAggregated, logErrorAggregated, sendTelegramAlert as systemGuardTelegramAlert } from '../utils/systemGuard';
import { logger } from '../utils/logger';
import DataHawk from './DataHawk';
import FilterGuard from './FilterGuard';
import TradeSensei from './TradeSensei';
import WebhookAgent from './WebhookAgent';
import { SentimentAnalyzer } from './AIConsilium';
import * as tf from '@tensorflow/tfjs-node';
import { Token, FilterParams, SwarmCommand, SwarmPayload, DQNState, CoordinationResult, ErrorMessage, ErrorResolution, DQNWeights } from '../types';
import { swarmCommandsProcessed, filterPerformance, riskyTokensFiltered, walletRebalance, coordinationRequestsTotal, tradesExecutedTotal } from '../utils/metrics';
import fetch from 'node-fetch';

const redisClient = new Redis(process.env.REDIS_URL || 'redis://default:uYnc1PFgjnDPW7BqlItETZ8gQaVzmL5W@redis-12123.c124.us-central1-1.gce.redns.redis-cloud.com:12123');
const mongoUri = process.env.MONGO_URI || 'mongodb+srv://swingsniperbot:QHH5LgRPPujpQDa2@cluster0.ncp3nmf.mongodb.net/swingsensei?retryWrites=true&w=majority';
const mongoClient = new MongoClient(mongoUri);
const telegramBot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN || '', { polling: false });
const breakerOptions = { timeout: 10000, errorThresholdPercentage: 50, resetTimeout: 30000 };
const PROMETHEUS_URL = process.env.PROMETHEUS_URL || 'http://localhost:9090/api/v1/query';

interface AgentStatus {
  name: string;
  running: boolean;
  lastPing: number;
}

interface DQNConfig {
  stateSize: number;
  actionSize: number;
  hiddenLayers: number[];
  learningRate: number;
  gamma: number;
}

class SwarmMaster {
  private readonly dataHawk: DataHawk;
  private readonly filterGuard: FilterGuard;
  private readonly tradeSensei: TradeSensei;
  private readonly webhookAgent: WebhookAgent;
  private readonly dqnModel: tf.Sequential;
  private dqnConfig: DQNConfig;
  private readonly agentStatuses: Map<string, AgentStatus>;
  private readonly db: Promise<MongoClient>;
  private readonly redis: Redis;
  private readonly bot: TelegramBot;
  private readonly mongo: MongoClient;

  constructor() {
    this.redis = redisClient;
    this.bot = telegramBot;
    this.mongo = mongoClient;
    this.dataHawk = new DataHawk();
    this.filterGuard = new FilterGuard();
    this.tradeSensei = new TradeSensei();
    this.webhookAgent = new WebhookAgent();
    this.dqnConfig = {
      stateSize: 9,
      actionSize: 3,
      hiddenLayers: [64, 32],
      learningRate: 0.001,
      gamma: 0.95,
    };
    this.dqnModel = this.createDQNModel();
    this.agentStatuses = new Map<string, AgentStatus>();
    this.db = mongoClient.connect();
    this.initializeAgents();
    this.setupCommandListener();
    this.setupAdditionalSubscriptions();
    this.scheduleDailyReport();
    setInterval(() => this.adjustDQNParams(), 3600000);
  }

  private createDQNModel(): tf.Sequential {
    const model = tf.sequential();
    model.add(tf.layers.dense({ units: this.dqnConfig.hiddenLayers[0], inputShape: [this.dqnConfig.stateSize], activation: 'relu' }));
    this.dqnConfig.hiddenLayers.slice(1).forEach(units => {
      model.add(tf.layers.dense({ units, activation: 'relu' }));
    });
    model.add(tf.layers.dense({ units: this.dqnConfig.actionSize, activation: 'linear' }));
    model.compile({ optimizer: tf.train.adam(this.dqnConfig.learningRate), loss: 'meanSquaredError' });
    return model;
  }

  private async getMongoDB() {
    return await this.db;
  }

  private initializeAgents() {
    this.agentStatuses.set('DataHawk', { name: 'DataHawk', running: true, lastPing: Date.now() });
    this.agentStatuses.set('FilterGuard', { name: 'FilterGuard', running: true, lastPing: Date.now() });
    this.agentStatuses.set('TradeSensei', { name: 'TradeSensei', running: true, lastPing: Date.now() });
    this.agentStatuses.set('WebhookAgent', { name: 'WebhookAgent', running: true, lastPing: Date.now() });

    this.redis.subscribe('agent:ping', (err) => {
      if (err) logErrorAggregated('SWARMMASTER', `Redis subscribe error: ${err.message}`);
    });

    this.redis.on('message', (channel, message) => {
      if (channel === 'agent:ping') {
        const { agent, timestamp } = JSON.parse(message);
        if (this.agentStatuses.has(agent)) {
          this.agentStatuses.set(agent, { ...this.agentStatuses.get(agent)!, lastPing: timestamp });
        }
      }
    });
  }

  private setupCommandListener() {
    this.redis.subscribe('commands:swarm', (err) => {
      if (err) logger.error({ component: 'SWARMMASTER', message: `Redis subscribe error: ${err.message}` });
    });

    this.redis.on('message', async (channel, message) => {
      if (channel !== 'commands:swarm') return;
      try {
        const { command, payload } = JSON.parse(message);
        swarmCommandsProcessed.inc({ source: 'redis', command });
        await this.processCommand(command, payload);
      } catch (err) {
        logger.error({ component: 'SWARMMASTER', message: `Command parse/handle error: ${err.message}` });
      }
    });
  }

  private setupAdditionalSubscriptions() {
    const channels = ['tradingview:webhooks', 'errors:detected', 'models:updated', 'signals:new', 'trades:executed'];
    channels.forEach(channel => {
      this.redis.subscribe(channel, (err) => {
        if (err) logErrorAggregated('SWARMMASTER', `Redis subscribe error for ${channel}: ${err.message}`);
      });
    });

    this.redis.on('message', async (channel, message) => {
      try {
        switch (channel) {
          case 'tradingview:webhooks':
            const webhook = JSON.parse(message);
            await this.processCommand('scan_signal', { ticker: webhook.ticker });
            break;
          case 'errors:detected':
            await this.handleError(message);
            break;
          case 'models:updated':
            const update = JSON.parse(message);
            logger.info({ component: 'SWARMMASTER', message: `Model updated: ${update.model}` });
            break;
          case 'signals:new':
            const signal = JSON.parse(message);
            await this.redis.publish('swarm:metrics', JSON.stringify({ metric: 'signal_processed', ticker: signal.ticker }));
            break;
          case 'trades:executed':
            const trade = JSON.parse(message);
            tradesExecutedTotal.inc({ ticker: trade.ticker });
            await this.redis.publish('swarm:metrics', JSON.stringify({ metric: 'trade_executed', ticker: trade.ticker }));
            break;
        }
      } catch (err) {
        logger.error({ component: 'SWARMMASTER', message: `Error processing ${channel}: ${err.message}` });
      }
    });
  }

  private async processCommand(command: SwarmCommand, payload: SwarmPayload) {
    switch (command) {
      case 'analyze_fibonacci':
        await this.analyzeFibonacci(payload);
        break;
      case 'scan_signal':
        await this.scanSignal(payload);
        break;
      case 'auto_trade':
        await this.autoTrade(payload);
        break;
      default:
        logger.error({ component: 'SWARMMASTER', message: `Unknown command: ${command}` });
    }
  }

  async coordinateAgents(asset: string): Promise<CoordinationResult> {
    if (!asset) {
      throw new Error('Asset must be provided');
    }
    try {
      coordinationRequestsTotal.inc({ asset });
      const consilium = new SentimentAnalyzer({ redisClient: this.redis });
      const prompt = await this.redis.get('prompt:template:swarm_master') || '{}';
      const result = await consilium.analyzeFreeAI(asset, 'swarm_master', JSON.parse(prompt));

      const tokenData = await this.redis.get(`tokens:${asset}`);
      const token: Token = tokenData ? JSON.parse(tokenData) : { ticker: asset, price: 0, volume: 0, marketCap: 0, liquidity: 0, priceChange: 0 };

      const tradeSenseiSignal = await this.tradeSensei.generateSignal(token);
      const signals = [
        { ...JSON.parse(result.sentiment), weight: 0.6 },
        { ...tradeSenseiSignal, weight: 0.4 },
      ];

      const aggregated = signals.reduce((acc, sig) => {
        const confidence = sig.confidence * sig.weight;
        if (!acc[sig.action]) acc[sig.action] = 0;
        acc[sig.action] += confidence;
        return acc;
      }, {} as Record<string, number>);

      const action = Object.entries(aggregated).reduce((a, b) => a[1] > b[1] ? a : b)[0] as 'buy' | 'sell' | 'hold';
      const confidence = aggregated[action] / signals.reduce((sum, sig) => sum + sig.weight, 0);

      const coordinationResult: CoordinationResult = {
        asset,
        action,
        confidence,
        source: 'SwarmMaster',
      };

      await this.redis.publish('swarm:metrics', JSON.stringify({ metric: 'coordination_completed', asset, action, confidence }));
      logInfoAggregated('SWARMMASTER', `Coordinated agents for ${asset}: ${JSON.stringify(coordinationResult)}`);
      return coordinationResult;
    } catch (error) {
      logErrorAggregated('SWARMMASTER', `Coordination error for ${asset}: ${error.message}`);
      await this.redis.publish('swarm:alerts', JSON.stringify({ type: 'error', message: `Coordination failed for ${asset}: ${error.message}` }));
      throw new Error(`Failed to coordinate agents: ${error.message}`);
    }
  }

  private async handleError(message: string) {
    try {
      const { errorId, type, provider, task, stack } = JSON.parse(message) as ErrorMessage;
      let solution = '';
      let resolved = false;

      if (type === '429' && provider === 'io.net') {
        solution = 'Переключение на gpt4free';
        resolved = true;
        await this.redis.publish('ai:requests', JSON.stringify({ task, provider: 'gpt4free' }));
      } else if (type === '5xx') {
        solution = 'Повтор задачи через 5 секунд';
        resolved = true;
        setTimeout(() => {
          this.redis.publish('ai:requests', JSON.stringify({ task, provider }));
        }, 5000);
      } else if (type === 'cloud_limit_warning' || type === 'cloud_limit_exceeded') {
        solution = 'Снизьте нагрузку скрапинга или перейдите на Render Starter ($7/мес)';
        resolved = false;
        await this.sendTelegramAlert({ errorId, type, provider, stack, solution });
      } else {
        solution = `Требуется ручное вмешательство: ${stack}`;
        resolved = false;
        await this.sendTelegramAlert({ errorId, type, provider, stack, solution });
      }

      const resolution: ErrorResolution = { errorId, solution, resolved };
      await this.redis.set(`swarm:error_resolution:${errorId}`, JSON.stringify(resolution), 'EX', 86400);
      await this.redis.publish('errors:resolved', JSON.stringify(resolution));
    } catch (err) {
      logErrorAggregated('SWARMMASTER', `Error handling error message: ${err.message}`);
    }
  }

  private async sendTelegramAlert(error: { errorId: string; type: string; provider: string; stack: string; solution: string }) {
    const message = `
⚠️ Неразрешимая ошибка:
ID: ${error.errorId}
Тип: ${error.type}
Провайдер: ${error.provider}
Стек: ${error.stack}
Решение: ${error.solution}
    `;
    try {
      await this.bot.sendMessage(process.env.TELEGRAM_CHAT_ID || '-1002616465399', message);
    } catch (err) {
      logErrorAggregated('SWARMMASTER', `Failed to send Telegram alert: ${err.message}`);
      await systemGuardTelegramAlert(`Failed to send Telegram alert: ${message}`, process.env.TELEGRAM_CHAT_ID || '-1002616465399');
    }
  }

  private scheduleDailyReport() {
    scheduleJob('0 23 * * *', async () => {
      try {
        const report = await this.generateDailyReport();
        await this.bot.sendMessage(process.env.TELEGRAM_CHAT_ID || '-1002616465399', report);
        await this.redis.set(`reports:daily:${new Date().toISOString().split('T')[0]}`, report, 'EX', 604800);
        await this.redis.publish('reports:daily', JSON.stringify({ date: new Date().toISOString().split('T')[0], report }));
      } catch (err) {
        logErrorAggregated('SWARMMASTER', `Failed to generate daily report: ${err.message}`);
      }
    });
  }

  private async generateDailyReport(): Promise<string> {
    try {
      const db = await this.getMongoDB();
      const trades = await db.collection('trades').find({ timestamp: { $gte: new Date(new Date().setHours(0, 0, 0)) } }).toArray();
      const errors = await this.redis.keys('swarm:error_resolution:*');
      const errorDetails = await Promise.all(errors.map(async (key) => JSON.parse(await this.redis.get(key) || '{}')));
      const dqnWeights = await db.collection('dqn_weights').findOne({}, { sort: { timestamp: -1 } });

      const income = trades.reduce((sum, trade) => sum + (trade.roi || 0), 0);
      const tradeCount = trades.length;
      const bestTrade = trades.sort((a, b) => (b.roi || 0) - (a.roi || 0))[0] || { roi: 0, ticker: 'N/A' };
      const problems = errorDetails.map((err) => {
        return `- ${err.type || 'unknown'}: ${err.provider || 'unknown'} (${err.resolved ? 'решено' : 'ожидает'}: ${err.solution || 'нет решения'})`;
      }).join('\n');
      const experience = dqnWeights ? `DQN увеличил вес новостей до ${(dqnWeights.newsWeight * 100).toFixed(1)}%` : 'Нет обновлений DQN';
      const suggestions = this.generateSuggestions(errorDetails, income, tradeCount);

      return `
📊 Ежедневный отчёт SwingSensei (${new Date().toISOString().split('T')[0]}):
💰 Доход: $${income.toFixed(2)} (ROI ${((income / 1000) * 100).toFixed(1)}%)
📈 Сделок: ${tradeCount}
⚠️ Проблемы:
${problems || '- Нет проблем'}
🧠 Опыт: ${experience}
🏆 Лучшая сделка: $${bestTrade.roi.toFixed(2)} (ROI ${(bestTrade.roi / 1000 * 100).toFixed(1)}%, токен ${bestTrade.ticker})
💡 Предложения: ${suggestions}
    `;
    } catch (err) {
      throw new Error(`Failed to generate daily report: ${err.message}`);
    }
  }

  private generateSuggestions(errors: any[], income: number, tradeCount: number): string {
    if (errors.some((err) => err.type === 'cloud_limit_exceeded')) {
      return 'Перейдите на Render Starter ($7/мес) для увеличения лимитов';
    }
    if (tradeCount > 0 && income / tradeCount < 5) {
      return 'Увеличьте вес трендов в DQN до 35%';
    }
    return 'Снизите GPT4FREE_POOL_SIZE до 1 для оптимизации';
  }

  private async analyzeFibonacci(payload: SwarmPayload) {
    const { ticker } = payload;
    try {
      const tokenData = await this.redis.get(`tokens:${ticker}`);
      if (!tokenData) {
        logger.error({ component: 'SWARMMASTER', message: `Token ${ticker} not found in Redis` });
        return;
      }
      const token: Token = JSON.parse(tokenData);
      if (!token.fibonacciLevels) {
        logger.error({ component: 'SWARMMASTER', message: `Fibonacci levels missing for ${ticker}` });
        return;
      }

      const signalData = await this.redis.get(`news:signals:${ticker}`).then(data => data ? JSON.parse(data) : {});
      if (signalData.snipers > 50 || signalData.devHoldings > 5) {
        riskyTokensFiltered.inc({ ticker, reason: signalData.snipers > 50 ? 'high_snipers' : 'high_devHoldings' });
        logger.info({ component: 'SWARMMASTER', message: `Token ${ticker} filtered out: high risk (snipers: ${signalData.snipers}, devHoldings: ${signalData.devHoldings})` });
        return;
      }

      const whaleData = await this.redis.get(`cielo:${ticker}`).then(data => data ? JSON.parse(data) : { kits: 0 });
      if (token.volume < 10000 || whaleData.kits < 2) {
        logger.info({ component: 'SWARMMASTER', message: `Token ${ticker} filtered out: low volume (${token.volume}) or whale activity (${whaleData.kits})` });
        return;
      }

      const currentPrice = token.price;
      const { level_382, level_618 } = token.fibonacciLevels;
      const isFibEntry = currentPrice <= level_618 && currentPrice >= level_382;

      if (isFibEntry) {
        const signal = {
          ticker,
          action: 'buy' as const,
          confidence: 0.85,
          source: 'fibonacci',
          timestamp: new Date().toISOString(),
          entryType: 'fibonacci' as const,
          fibonacciLevel: currentPrice <= level_618 ? 0.618 : 0.382,
          marketCap: token.marketCap,
          liquidity: token.liquidity,
          category: signalData.category || 'trend',
        };
        await this.redis.publish('signals:new', JSON.stringify(signal));
        logger.info({ component: 'SWARMMASTER', message: `Fibonacci signal generated for ${ticker}` });
      }
    } catch (err) {
      logger.error({ component: 'SWARMMASTER', message: `Fibonacci analysis error for ${ticker}: ${err.message}` });
    }
  }

  private async scanSignal(payload: SwarmPayload) {
    const { ticker } = payload;
    try {
      const tokenData = await this.redis.get(`tokens:${ticker}`);
      if (!tokenData) return;

      const token: Token = JSON.parse(tokenData);

      const signalData = await this.redis.get(`news:signals:${ticker}`).then(data => data ? JSON.parse(data) : {});
      if (signalData.snipers > 50 || signalData.devHoldings > 5) {
        riskyTokensFiltered.inc({ ticker, reason: signalData.snipers > 50 ? 'high_snipers' : 'high_devHoldings' });
        logger.info({ component: 'SWARMMASTER', message: `Token ${ticker} filtered out: high risk (snipers: ${signalData.snipers}, devHoldings: ${signalData.devHoldings})` });
        return;
      }

      const filterAction = await this.selectFilter(token);
      let filtered: Token[] = [];
      switch (filterAction) {
        case 0:
          filtered = await this.filterGuard.applyTrending5MinFilter([token]);
          break;
        case 1:
          filtered = await this.filterGuard.applyNextBC5MinFilter([token]);
          break;
        case 2:
          filtered = await this.filterGuard.applySolanaSwingSniperFilter([token]);
          break;
      }
      if (filtered.length > 0) {
        const signal = {
          ticker,
          action: 'buy' as const,
          confidence: 0.8,
          source: 'swarm',
          timestamp: new Date().toISOString(),
          entryType: 'volume' as const,
          marketCap: token.marketCap,
          liquidity: token.liquidity,
          category: signalData.category || 'trend',
        };
        await this.redis.publish('signals:new', JSON.stringify(signal));
      }
    } catch (err) {
      logger.error({ component: 'SWARMMASTER', message: `Scan signal error for ${ticker}: ${err.message}` });
    }
  }

  private async autoTrade(payload: SwarmPayload) {
    const { ticker, entryPrice } = payload;
    const tokenData = await this.redis.get(`tokens:${ticker}`);
    if (!tokenData) return;

    const token: Token = JSON.parse(tokenData);
    await this.tradeSensei.executeTrade(token, {
      size: 0.01,
      stopLoss: entryPrice ? entryPrice * 0.85 : 0.1,
      takeProfit: entryPrice ? entryPrice * 1.3 : 0.3,
    });
    tradesExecutedTotal.inc({ ticker });
  }

  private async monitorAgents() {
    const now = Date.now();
    for (const [name, status] of this.agentStatuses) {
      if (now - status.lastPing > 60000) {
        logErrorAggregated('SWARMMASTER', `Agent ${name} not responding`);
        status.running = false;
        await systemGuardTelegramAlert(`Agent ${name} down! Restarting...`, process.env.TELEGRAM_CHAT_ID || '-1002616465399');
        this.restartAgent(name);
      }
    }
  }

  private async restartAgent(agentName: string) {
    try {
      switch (agentName) {
        case 'DataHawk':
          this.dataHawk = new DataHawk();
          break;
        case 'FilterGuard':
          this.filterGuard = new FilterGuard();
          break;
        case 'TradeSensei':
          this.tradeSensei = new TradeSensei();
          break;
        case 'WebhookAgent':
          this.webhookAgent = new WebhookAgent();
          break;
      }
      this.agentStatuses.set(agentName, { name: agentName, running: true, lastPing: Date.now() });
      logInfoAggregated('SWARMMASTER', `Agent ${agentName} restarted`);
    } catch (error) {
      logErrorAggregated('SWARMMASTER', `Failed to restart ${agentName}: ${error.message}`);
    }
  }

  private async calculateVolatility(ticker: string): Promise<number> {
    try {
      const db = await this.getMongoDB();
      const prices = await db.collection('token_prices')
        .find({ ticker, timestamp: { $gte: new Date(Date.now() - 15 * 60 * 1000) } })
        .sort({ timestamp: -1 })
        .limit(100)
        .toArray();
      
      if (prices.length < 2) return 0;
      
      const priceValues = prices.map(p => p.price);
      const mean = priceValues.reduce((sum, p) => sum + p, 0) / priceValues.length;
      const variance = priceValues.reduce((sum, p) => sum + Math.pow(p - mean, 2), 0) / priceValues.length;
      const stdDev = Math.sqrt(variance);
      
      return (stdDev / mean) * 100;
    } catch (error) {
      logErrorAggregated('SWARMMASTER', `Volatility calculation error for ${ticker}: ${error.message}`);
      return 0;
    }
  }

  private async getDQNState(token: Token): Promise<DQNState> {
    const tweetcordData = await this.redis.get(`tweets:${token.ticker}`).then(data => data ? JSON.parse(data) : { sentiment: 0 });
    const whaleData = await this.redis.get(`cielo:${token.ticker}`).then(data => data ? JSON.parse(data) : { kits: 0 });
    const signalData = await this.redis.get(`news:signals:${token.ticker}`).then(data => data ? JSON.parse(data) : {});
    const volatility = await this.calculateVolatility(token.ticker);
    return {
      volume: token.volume / 100000,
      liquidity: token.liquidity / 100000,
      priceChange: token.priceChange / 100,
      socialSentiment: tweetcordData.sentiment || 0,
      whaleActivity: whaleData.kits || 0,
      volatility: volatility / 100,
      socialVolume: signalData.socialVolume / 10000 || 0,
      galaxyScore: signalData.galaxyScore / 100 || 0,
      announcementImpact: signalData.announcementImpact || 0,
    };
  }

  private async analyzeFilterPerformance(token: Token): Promise<number[]> {
    try {
      const db = await this.getMongoDB();
      const trades = await db.collection('trades')
        .find({
          marketCap: { $gte: token.marketCap * 0.9, $lte: token.marketCap * 1.1 },
          liquidity: { $gte: token.liquidity * 0.8, $lte: token.liquidity * 1.2 },
          timestamp: { $gte: new Date(Date.now() - 24 * 60 * 60 * 1000) },
        })
        .toArray();

      const filterRois = [0, 0, 0];
      const filterCounts = [0, 0, 0];
      trades.forEach(trade => {
        const filterIndex = trade.filter || 0;
        filterRois[filterIndex] += trade.roi || 0;
        filterCounts[filterIndex]++;
      });

      return filterRois.map((roi, i) => filterCounts[i] > 0 ? roi / filterCounts[i] : 0);
    } catch (err) {
      logger.error({ component: 'SWARMMASTER', message: `Filter performance analysis error: ${err.message}` });
      return [0, 0, 0];
    }
  }

  private async selectFilter(token: Token): Promise<number> {
    const state = await this.getDQNState(token);
    const stateTensor = tf.tensor2d([Object.values(state)], [1, this.dqnConfig.stateSize]);
    const qValues = this.dqnModel.predict(stateTensor) as tf.Tensor;
    const qValuesArray = qValues.dataSync();

    const filterRois = await this.analyzeFilterPerformance(token);
    const weightedQValues = qValuesArray.map((q, i) => q * (1 + filterRois[i] * 0.2));
    const action = weightedQValues.indexOf(Math.max(...weightedQValues));

    filterPerformance.inc({ filter: action, ticker: token.ticker });
    stateTensor.dispose();
    qValues.dispose();
    return action;
  }

  private async adjustDQNParams() {
    try {
      const roiResponse = await fetch(`${PROMETHEUS_URL}?query=roi_total[24h]`);
      const roiData = await roiResponse.json();
      const roiTotal = parseFloat(roiData.data.result[0]?.value[1] || 0);

      const failureResponse = await fetch(`${PROMETHEUS_URL}?query=tradeFailure[24h]`);
      const failureData = await failureResponse.json();
      const tradeFailure = parseFloat(failureData.data.result[0]?.value[1] || 0);

      let updated = false;
      if (roiTotal < 10) {
        this.dqnConfig.learningRate = Math.max(0.0001, this.dqnConfig.learningRate * 0.9);
        updated = true;
      }
      if (tradeFailure > 20) {
        this.dqnConfig.gamma = Math.min(0.99, this.dqnConfig.gamma + 0.05);
        updated = true;
      }

      if (updated) {
        this.dqnModel.compile({ optimizer: tf.train.adam(this.dqnConfig.learningRate), loss: 'meanSquaredError' });
        logger.info({ component: 'SWARMMASTER', message: `DQN params updated: learningRate=${this.dqnConfig.learningRate}, gamma=${this.dqnConfig.gamma}` });
        await systemGuardTelegramAlert(`DQN params updated: learningRate=${this.dqnConfig.learningRate}, gamma=${this.dqnConfig.gamma}`, process.env.TELEGRAM_CHAT_ID || '-1002616465399');
      }
    } catch (err) {
      logger.error({ component: 'SWARMMASTER', message: `DQN params adjustment error: ${err.message}` });
    }
  }

  private async manageReinvestment() {
    try {
      const db = await this.getMongoDB();
      const wallets = await db.collection('wallets').find({ type: 'trading' }).toArray();
      const totalBalance = wallets.reduce((sum, w) => sum + w.balance, 0);
      const maxWallet = wallets.reduce((max, w) => w.balance > max.balance ? w : max, wallets[0]);

      if (maxWallet.balance / totalBalance > 0.5) {
        const targetWallet = wallets.find(w => w.walletId !== maxWallet.walletId && w.balance < maxWallet.balance);
        if (targetWallet) {
          const rebalanceCommand = {
            command: 'rebalance',
            payload: { walletId: targetWallet.walletId, size: 0.01 },
          };
          await this.redis.publish('swarm:commands', JSON.stringify(rebalanceCommand));
          walletRebalance.inc({ walletId: targetWallet.walletId });
          logger.info({ component: 'SWARMMASTER', message: `Rebalanced to wallet ${targetWallet.walletId}` });
          await systemGuardTelegramAlert(`Rebalanced to wallet ${targetWallet.walletId}`, process.env.TELEGRAM_CHAT_ID || '-1002616465399');
        }
      }
    } catch (err) {
      logger.error({ component: 'SWARMMASTER', message: `Reinvestment management error: ${err.message}` });
    }
  }

  private async trainDQN(token: Token, filterAction: number, reward: number, nextState: DQNState) {
    const state = await this.getDQNState(token);
    const stateTensor = tf.tensor2d([Object.values(state)], [1, this.dqnConfig.stateSize]);
    const nextStateTensor = tf.tensor2d([Object.values(nextState)], [1, this.dqnConfig.stateSize]);
    const targetQ = reward + this.dqnConfig.gamma * tf.max(this.dqnModel.predict(nextStateTensor) as tf.Tensor, 1).dataSync()[0];
    const qValues = this.dqnModel.predict(stateTensor) as tf.Tensor;
    const qValuesArray = qValues.dataSync();
    qValuesArray[filterAction] = targetQ;
    const targetTensor = tf.tensor2d([qValuesArray], [1, this.dqnConfig.actionSize]);
    await this.dqnModel.fit(stateTensor, targetTensor, { epochs: 1, verbose: 0 });

    // Сохраняем веса DQN в MongoDB
    const weights = this.dqnModel.getWeights().map(w => w.dataSync());
    await (await this.getMongoDB()).collection('dqn_weights').insertOne({
      newsWeight: state.announcementImpact > 0.8 ? 0.3 : 0.2,
      timestamp: new Date(),
      weights,
    });

    stateTensor.dispose();
    nextStateTensor.dispose();
    qValues.dispose();
    targetTensor.dispose();
  }

  async runSwarm() {
    setInterval(() => this.monitorAgents(), 30000);
    setInterval(() => this.manageReinvestment(), 600000);

    this.redis.subscribe('tokens:new', (err) => {
      if (err) logErrorAggregated('SWARMMASTER', `Redis subscribe error: ${err.message}`);
    });

    this.redis.on('message', async (channel, message) => {
      if (channel === 'tokens:new') {
        const tokens: Token[] = JSON.parse(message);
        for (const token of tokens) {
          const filterAction = await this.selectFilter(token);
          let filtered: Token[] = [];
          switch (filterAction) {
            case 0:
              filtered = await this.filterGuard.applyTrending5MinFilter([token]);
              break;
            case 1:
              filtered = await this.filterGuard.applyNextBC5MinFilter([token]);
              break;
            case 2:
              filtered = await this.filterGuard.applySolanaSwingSniperFilter([token]);
              break;
          }
          if (filtered.length > 0) {
            await this.tradeSensei.executeTrade(filtered[0], { size: 0.01, stopLoss: 0.1, takeProfit: 0.3 });
            tradesExecutedTotal.inc({ ticker: filtered[0].ticker });
            const reward = await this.calculateReward(filtered[0]);
            const nextState = await this.getDQNState(filtered[0]);
            await this.trainDQN(filtered[0], filterAction, reward, nextState);
            recordMetric('trade_executed', { ticker: filtered[0].ticker, filter: filterAction });
          }
        }
      }
    });

    this.redis.subscribe('trade:result', async (err) => {
      if (err) logErrorAggregated('SWARMMASTER', `Redis subscribe error: ${err.message}`);
    });

    this.redis.on('message', async (channel, message) => {
      if (channel === 'trade:result') {
        const { ticker, profit } = JSON.parse(message);
        const reward = await this.calculateReward({ ticker } as Token);
        const token = await this.redis.get(`tokens:filtered`).then(data => data ? JSON.parse(data).find((t: Token) => t.ticker === ticker) : null);
        if (token) {
          const filterAction = await this.selectFilter(token);
          const nextState = await this.getDQNState(token);
          await this.trainDQN(token, filterAction, reward, nextState);
          await systemGuardTelegramAlert(`Trade result for ${ticker}: Profit ${profit}`, process.env.TELEGRAM_CHAT_ID || '-1002616465399');
        }
      }
    });

    await this.dataHawk.fetchGmgmTokens();
    logInfoAggregated('SWARMMASTER', 'SwarmMaster started');
  }

  private async calculateReward(token: Token): Promise<number> {
    try {
      const db = await this.getMongoDB();
      const trade = await db.collection('trades').findOne({ ticker: token.ticker }, { sort: { timestamp: -1 } });
      if (!trade) return 0;

      let reward = trade.profit > 0 ? trade.profit / trade.amount : -1;
      const liquidity = token.liquidity || 0;
      const liquidityMultiplier = liquidity >= 40000 ? 1.2 : liquidity >= 20000 ? 1.0 : 0.8;
      reward *= liquidityMultiplier;

      const volatility = await this.calculateVolatility(token.ticker);
      const volatilityMultiplier = volatility >= 10 && volatility <= 30 ? 1.3 : volatility > 30 ? 0.9 : 0.7;
      reward *= volatilityMultiplier;

      const signalData = await this.redis.get(`news:signals:${token.ticker}`).then(data => data ? JSON.parse(data) : {});
      if (signalData.announcementImpact > 0.8) reward += 0.5;

      return Math.max(-2, Math.min(2, reward));
    } catch (error) {
      logErrorAggregated('SWARMMASTER', `Reward calculation error for ${token.ticker}: ${error.message}`);
      return 0;
    }
  }
}

export default SwarmMaster;
