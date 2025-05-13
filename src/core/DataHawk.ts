import { MongoClient, BulkWriteOperation } from 'mongodb';
import Redis from 'ioredis';
import axios, { AxiosRequestConfig } from 'axios';
import TelegramBot from 'node-telegram-bot-api';
import { CircuitBreaker } from 'opossum';
import pLimit from 'p-limit';
import { logInfoAggregated, logErrorAggregated, sendTelegramAlert } from '../utils/systemGuard';
import AIConsilium from '../utils/aiConsilium';
import { Token, Signal, NewsSignal, NewsItem, LunarCrushData } from '../utils/types';
import {
  tokensFetched, signalsGenerated, apiLatency, errorRate, newsProcessed,
  telegramAlertsSent, lunarcrushRequests, tickerExtraction, apiSwitch,
  lunarcrushRequestTime, telegramSignalsProcessed, telegramApiErrors,
  telegramCheckLatency, fibonacciExits, Counter
} from '../utils/metrics';

interface APISource {
  name: string;
  url: string;
  priority: number;
  fallback?: string;
}

interface Dependencies {
  redisClient: Redis;
  mongoClient: MongoClient;
  telegramBot: TelegramBot;
  aiConsilium: AIConsilium;
}

const tweetsProcessed = new Counter({
  name: 'tweets_processed_total',
  help: 'Total tweets processed',
  labelNames: ['ticker'],
});

class TelegramMessageProcessor {
  private readonly telegramBot: TelegramBot;
  private readonly mongoClient: MongoClient;
  private readonly redisClient: Redis;
  private readonly aiConsilium: AIConsilium;
  private readonly limit = pLimit(2, { timeout: 10000 });

  constructor({ telegramBot, mongoClient, redisClient, aiConsilium }: Dependencies) {
    this.telegramBot = telegramBot;
    this.mongoClient = mongoClient;
    this.redisClient = redisClient;
    this.aiConsilium = aiConsilium;
    this.validateEnv();
    this.setupListeners();
  }

  private validateEnv() {
    if (!process.env.LUNARCRUSH_API_KEY) logErrorAggregated('TELEGRAM_PROCESSOR', 'Missing LUNARCRUSH_API_KEY');
    if (!process.env.MONITOR_CHANNEL_ID) logErrorAggregated('TELEGRAM_PROCESSOR', 'Missing MONITOR_CHANNEL_ID');
  }

  private setupListeners() {
    this.telegramBot.on('message', async (msg) => {
      if (msg.chat.id === parseInt(process.env.MONITOR_CHANNEL_ID || '0')) {
        await this.processTokenCheckResponse(msg);
      }
    });
  }

  private async extractNewsItem(message: string): Promise<NewsItem | null> {
    try {
      const data = JSON.parse(message);
      if (!data.text || !data.ticker) throw new Error('Invalid NewsItem format');
      return { text: data.text, source: data.source, timestamp: data.timestamp, category: data.category, channel: data.channel, chat_id: data.chat_id };
    } catch (error) {
      logErrorAggregated('TELEGRAM_PROCESSOR', `Parse error: ${error.message}`);
      telegramApiErrors.labels('parse').inc();
      return null;
    }
  }

  private async analyzeNewsItem(newsItem: NewsItem): Promise<NewsSignal[]> {
    const tickers = await this.extractTickers(newsItem.text);
    const signals: NewsSignal[] = [];
    for (const ticker of tickers) {
      const lunarData = await this.fetchLunarCrushData(ticker);
      const sentiment = await this.limit(() => this.aiConsilium.analyzeSentiment(newsItem.text, lunarData.socialVolume, newsItem.category, newsItem.channel));
      signals.push({
        ticker,
        sentimentScore: sentiment.score,
        announcementImpact: sentiment.impact,
        timestamp: new Date().toISOString(),
        source: newsItem.source,
        category: newsItem.category,
        channel: newsItem.channel,
        chat_id: newsItem.chat_id,
      });
      newsProcessed.inc({ source: newsItem.source, ticker });
    }
    return signals;
  }

  private async extractTickers(text: string): Promise<string[]> {
    const tickerRegex = /\$[A-Z]{2,5}|\b[A-Z]{2,5}\b/g;
    const potentialTickers = text.match(tickerRegex) || [];
    const validTickers = (await Promise.all(potentialTickers.map(ticker => this.validateTicker(ticker)))).filter((t): t is string => t !== null);
    tickerExtraction.inc({ source: 'telegram' }, validTickers.length);
    return validTickers;
  }

  private async validateTicker(ticker: string): Promise<string | null> {
    const start = Date.now();
    const cacheKey = `lunarcrush:meta:${ticker}`;
    const cached = await this.redisClient.get(cacheKey);
    if (cached) return JSON.parse(cached) ? ticker : null;

    try {
      const response = await axios.get('https://api.lunarcrush.com/v2', {
        params: { data: 'meta', type: 'assets', symbol: ticker },
        headers: { Authorization: `Bearer ${process.env.LUNARCRUSH_API_KEY || ''}` },
      });
      const isValid = !!response.data.data?.length;
      await this.redisClient.setEx(cacheKey, 86400, JSON.stringify(isValid));
      lunarcrushRequests.inc({ ticker });
      lunarcrushRequestTime.labels(ticker).observe((Date.now() - start) / 1000);
      return isValid ? ticker : null;
    } catch (error) {
      telegramApiErrors.labels('lunarcrush').inc();
      logErrorAggregated('TELEGRAM_PROCESSOR', `LunarCrush meta error for ${ticker}: ${error.message}`);
      return null;
    }
  }

  private async fetchLunarCrushData(ticker: string): Promise<LunarCrushData> {
    const start = Date.now();
    const cacheKey = `lunarcrush:${ticker}`;
    const cached = await this.redisClient.get(cacheKey);
    if (cached) return JSON.parse(cached);

    try {
      const response = await axios.get('https://api.lunarcrush.com/v2', {
        params: { data: 'assets', symbol: ticker, data_points: 7, interval: 'day', time_series_indicators: 'social_volume,social_score,galaxy_score' },
        headers: { Authorization: `Bearer ${process.env.LUNARCRUSH_API_KEY || ''}` },
      });
      const data = response.data.data[0] || {};
      const result: LunarCrushData = { socialVolume: data.social_volume || 0, socialScore: data.social_score || 0, galaxyScore: data.galaxy_score || 0 };
      await this.redisClient.setEx(cacheKey, 3600, JSON.stringify(result));
      lunarcrushRequests.inc({ ticker });
      lunarcrushRequestTime.labels(ticker).observe((Date.now() - start) / 1000);
      return result;
    } catch (error) {
      telegramApiErrors.labels('lunarcrush').inc();
      logErrorAggregated('TELEGRAM_PROCESSOR', `LunarCrush API error for ${ticker}: ${error.message}`);
      return { socialVolume: 0, socialScore: 0, galaxyScore: 0 };
    }
  }

  async processTokenCheckResponse(msg: TelegramBot.Message) {
    const start = Date.now();
    if (!msg.text) return;

    try {
      const lines = msg.text.split('\n');
      const tickerMatch = lines[0].match(/Token:\s*([A-Z]{2,5})/);
      if (!tickerMatch) return;
      const ticker = tickerMatch[1];
      const metrics = this.parseTokenMetrics(lines);
      const signal = await this.mongoClient.db('datahawk').collection('news_signals').findOne({ ticker, timestamp: { $gte: new Date(Date.now() - 3600000).toISOString() } });
      if (signal) {
        const updatedSignal = { ...signal, ...metrics };
        await this.mongoClient.db('datahawk').collection('news_signals').updateOne({ ticker, timestamp: signal.timestamp }, { $set: updatedSignal });
        if (updatedSignal.announcementImpact > 0.7) {
          await this.redisClient.publish('news:signals', JSON.stringify(updatedSignal));
          sendTelegramAlert('TELEGRAM_PROCESSOR', `Updated signal for ${ticker}: ${JSON.stringify(updatedSignal)}`);
          telegramSignalsProcessed.inc({ ticker });
        }
      }
      telegramCheckLatency.labels(ticker).observe((Date.now() - start) / 1000);
    } catch (error) {
      logErrorAggregated('TELEGRAM_PROCESSOR', `Token check response error: ${error.message}`);
      telegramApiErrors.labels('response').inc();
    }
  }

  private parseTokenMetrics(lines: string[]): Partial<NewsSignal> {
    const metrics: Partial<NewsSignal> = {};
    for (const line of lines) {
      if (line.includes('Market Cap')) metrics.marketCap = parseFloat(line.match(/[\d.]+/)?.[0] || '0');
      if (line.includes('Liquidity')) metrics.liquidity = parseFloat(line.match(/[\d.]+/)?.[0] || '0');
      if (line.includes('Snipers')) metrics.snipers = parseFloat(line.match(/[\d.]+/)?.[0] || '0') / 100;
      if (line.includes('Dev Holdings')) metrics.devHoldings = parseFloat(line.match(/[\d.]+/)?.[0] || '0');
      if (line.includes('Age')) metrics.age = parseInt(line.match(/\d+/)?.[0] || '0');
      if (line.includes('Volume 1h')) metrics.volume1h = parseFloat(line.match(/[\d.]+/)?.[0] || '0');
      if (line.includes('Price Change 1h')) metrics.priceChange1h = parseFloat(line.match(/[\d.]+/)?.[0] || '0');
      if (line.includes('Holders')) metrics.holders = parseInt(line.match(/\d+/)?.[0] || '0');
      if (line.includes('Top Holders')) metrics.topHolders = parseInt(line.match(/\d+/)?.[0] || '0');
    }
    return metrics;
  }

  async fetchTelegramNews(): Promise<NewsItem[]> {
    const cacheKey = 'telegram:news';
    const cached = await this.redisClient.get(cacheKey);
    if (cached) return JSON.parse(cached);

    try {
      const updates = await this.telegramBot.getUpdates({ allowed_updates: ['message'] });
      const news = updates
        .filter(update => update.message?.text && update.message.chat.username)
        .map(update => ({
          text: update.message!.text,
          source: 'telegram',
          timestamp: new Date(update.message!.date * 1000).toISOString(),
          category: 'news',
          channel: update.message!.chat.username,
          chat_id: update.message!.chat.id,
        }));
      await this.redisClient.setEx(cacheKey, 3600, JSON.stringify(news));
      return news;
    } catch (error) {
      logErrorAggregated('TELEGRAM_PROCESSOR', `Telegram updates error: ${error.message}`);
      telegramApiErrors.labels('updates').inc();
      return [];
    }
  }
}

class TokenFetcher {
  private readonly apiSources: APISource[];
  private readonly whaleActivityCircuitBreaker: CircuitBreaker;

  constructor() {
    this.apiSources = this.loadApiSources();
    this.whaleActivityCircuitBreaker = new CircuitBreaker(this.checkWhaleActivity.bind(this), {
      timeout: 5000,
      errorThresholdPercentage: 50,
      resetTimeout: 30000,
    });
    this.whaleActivityCircuitBreaker.on('open', () => logErrorAggregated('TOKEN_FETCHER', 'Whale activity circuit breaker opened'));
  }

  private loadApiSources(): APISource[] {
    try {
      const sources = JSON.parse(require('fs').readFileSync('api_sources.json', 'utf8'));
      return sources.sort((a: APISource, b: APISource) => a.priority - b.priority);
    } catch (error) {
      logErrorAggregated('TOKEN_FETCHER', `Failed to load API sources: ${error.message}`);
      return [
        { name: 'birdeye', url: 'https://api.birdeye.so/v1/tokens', priority: 1 },
        { name: 'solscan', url: 'https://api.solscan.io/tokens', priority: 2 },
        { name: 'lunarcrush', url: 'https://api.lunarcrush.com/v2', priority: 3 },
      ];
    }
  }

  private calculateFibonacciLevels(price: number, lastMin: number, lastMax: number): { level_236: number; level_382: number; level_500: number; level_618: number } {
    const range = lastMax - lastMin;
    return {
      level_236: lastMin + range * 0.236,
      level_382: lastMin + range * 0.382,
      level_500: lastMin + range * 0.5,
      level_618: lastMin + range * 0.618,
    };
  }

  async fetchTokens(): Promise<Token[]> {
    const start = Date.now();
    for (const source of this.apiSources) {
      try {
        const config: AxiosRequestConfig = { headers: { 'User-Agent': 'Mozilla/5.0' }, params: source.name === 'birdeye' ? { sort_by: 'volume_5min', sort_type: 'desc' } : {} };
        const response = await axios.get(source.url, config);
        let tokens: Token[] = [];
        if (source.name === 'birdeye') {
          tokens = response.data.data.map((item: any) => ({
            ticker: item.symbol,
            price: item.price,
            volume: item.volume_5min,
            marketCap: item.marketCap,
            liquidity: item.liquidity,
            priceChange: 0,
            fibonacciLevels: this.calculateFibonacciLevels(item.price, item.price * 0.9, item.price * 1.1),
          }));
        } else if (source.name === 'solscan') {
          tokens = response.data.data.map((item: any) => ({
            ticker: item.tokenAddress,
            price: item.price,
            volume: item.volume,
            marketCap: item.marketCap,
            liquidity: 0,
            priceChange: 0,
            fibonacciLevels: this.calculateFibonacciLevels(item.price, item.price * 0.9, item.price * 1.1),
          }));
        }
        tokensFetched.inc({ source: source.name }, tokens.length);
        apiLatency.labels(source.name).observe((Date.now() - start) / 1000);
        return tokens;
      } catch (error) {
        logErrorAggregated('TOKEN_FETCHER', `${source.name} API error: ${error.message}`);
        errorRate.labels(source.name).inc();
        apiSwitch.inc({ api: source.name });
        if (error.response?.status === 403 || error.response?.status === 429) {
          if (source.fallback) {
            logInfoAggregated('TOKEN_FETCHER', `Switching to fallback for ${source.name}: ${source.fallback}`);
            source.url = source.fallback;
            continue;
          }
        }
      }
    }
    return [];
  }

  private async checkWhaleActivity(ticker: string): Promise<{ whaleActivity: boolean }> {
    try {
      const response = await axios.get(`https://api.cielo.app/whale-activity/${ticker}`);
      return { whaleActivity: response.data.activity > 0.7 };
    } catch (error) {
      logErrorAggregated('TOKEN_FETCHER', `Whale activity error for ${ticker}: ${error.message}`);
      return { whaleActivity: false };
    }
  }
}

class SignalGenerator {
  private readonly redisClient: Redis;
  private readonly mongoClient: MongoClient;
  private readonly telegramProcessor: TelegramMessageProcessor;
  private readonly tokenFetcher: TokenFetcher;

  constructor({ redisClient, mongoClient, telegramBot, aiConsilium }: Dependencies, tokenFetcher: TokenFetcher) {
    this.redisClient = redisClient;
    this.mongoClient = mongoClient;
    this.telegramProcessor = new TelegramMessageProcessor({ redisClient, mongoClient, telegramBot, aiConsilium });
    this.tokenFetcher = tokenFetcher;
    this.validateConnections();
    this.setupRedisListeners();
  }

  private async validateConnections() {
    try {
      await this.redisClient.ping();
      logInfoAggregated('SIGNAL_GENERATOR', 'Redis connection validated');
    } catch (error) {
      logErrorAggregated('SIGNAL_GENERATOR', `Redis connection error: ${error.message}`);
      throw error;
    }
    try {
      await this.mongoClient.connect();
      logInfoAggregated('SIGNAL_GENERATOR', 'MongoDB connection validated');
    } catch (error) {
      logErrorAggregated('SIGNAL_GENERATOR', `MongoDB connection error: ${error.message}`);
      throw error;
    }
  }

  private setupRedisListeners() {
    this.redisClient.subscribe('news:raw', 'swarm:commands', 'tweets:raw', (err, count) => {
      if (err) {
        logErrorAggregated('SIGNAL_GENERATOR', `Redis subscribe error: ${err.message}`);
        return;
      }
      logInfoAggregated('SIGNAL_GENERATOR', `Subscribed to ${count} channels`);
    });

    this.redisClient.on('message', async (channel, message) => {
      if (channel === 'news:raw') await this.handleTelegramNews(message);
      else if (channel === 'swarm:commands') await this.handleSwarmCommands(message);
      else if (channel === 'tweets:raw') await this.handleTweets(message);
    });
  }

  private async handleTelegramNews(message: string) {
    const newsItem = await this.telegramProcessor.extractNewsItem(message);
    if (!newsItem) return;
    const signals = await this.telegramProcessor.analyzeNewsItem(newsItem);
    const bulkOps: BulkWriteOperation<NewsSignal>[] = signals.map(signal => ({
      updateOne: { filter: { ticker: signal.ticker, timestamp: signal.timestamp }, update: { $set: signal }, upsert: true },
    }));
    if (bulkOps.length > 0) {
      await this.mongoClient.db('datahawk').collection('news_signals').bulkWrite(bulkOps);
      for (const signal of signals) {
        if (signal.announcementImpact > 0.7) {
          await this.redisClient.publish('news:signals', JSON.stringify(signal));
          telegramAlertsSent.inc({ ticker: signal.ticker });
        }
      }
    }
  }

  private async handleSwarmCommands(message: string) {
    try {
      const command = JSON.parse(message);
      if (command.type === 'analyze_token') {
        const tokens = await this.tokenFetcher.fetchTokens();
        const token = tokens.find(t => t.ticker === command.ticker);
        if (token) {
          const signals = await this.generateFibonacciSignals([token]);
          await this.redisClient.publish('signals:new', JSON.stringify(signals[0]));
        }
      }
    } catch (error) {
      logErrorAggregated('SIGNAL_GENERATOR', `Swarm command error: ${error.message}`);
      errorRate.labels('swarm').inc();
    }
  }

  private async handleTweets(message: string) {
    try {
      const tweet = JSON.parse(message);
      const newsItem: NewsItem = { text: tweet.text, source: tweet.source, timestamp: tweet.timestamp, category: tweet.category, channel: tweet.channel, chat_id: tweet.chat_id };
      const signals = await this.telegramProcessor.analyzeNewsItem(newsItem);
      const bulkOps: BulkWriteOperation<NewsSignal>[] = signals.map(signal => ({
        updateOne: { filter: { ticker: signal.ticker, timestamp: signal.timestamp }, update: { $set: signal }, upsert: true },
      }));
      if (bulkOps.length > 0) {
        await this.mongoClient.db('datahawk').collection('news_signals').bulkWrite(bulkOps);
        for (const signal of signals) {
          tweetsProcessed.inc({ ticker: signal.ticker });
          if (signal.announcementImpact > 0.7) {
            await this.redisClient.publish('news:signals', JSON.stringify(signal));
            telegramAlertsSent.inc({ ticker: signal.ticker });
          }
        }
      }
    } catch (error) {
      logErrorAggregated('SIGNAL_GENERATOR', `Tweet error: ${error.message}`);
      errorRate.labels('twitter').inc();
    }
  }

  private generateFibonacciSignal(token: Token): Signal | null {
    if (!token.fibonacciLevels) return null;
    const { price } = token;
    const { level_382, level_618 } = token.fibonacciLevels;
    const action = price <= level_618 ? 'buy' : price >= level_382 ? 'sell' : 'hold';
    const confidence = Math.min(1, Math.abs((price - level_382) / (level_618 - level_382)) * 1.5);
    return confidence > 0.7 ? { ticker: token.ticker, action, confidence, source: 'DQN', timestamp: new Date().toISOString(), entryType: 'fibonacci' } : null;
  }

  async generateFibonacciSignals(tokens: Token[]): Promise<Signal[]> {
    const signals = tokens.map(token => this.generateFibonacciSignal(token)).filter((signal): signal is Signal => signal !== null);
    for (const signal of signals) {
      await this.redisClient.publish('signals:new', JSON.stringify(signal));
      signalsGenerated.inc({ source: 'DQN' });
      if (signal.action === 'sell') fibonacciExits.inc({ ticker: signal.ticker });
    }
    return signals;
  }
}

class DataHawk {
  private readonly signalGenerator: SignalGenerator;
  private readonly tokenFetcher: TokenFetcher;

  constructor(deps: Dependencies) {
    this.tokenFetcher = new TokenFetcher();
    this.signalGenerator = new SignalGenerator(deps, this.tokenFetcher);
  }

  async generateSignals(tokens?: Token[]): Promise<Signal[]> {
    const fetchedTokens = tokens || await this.tokenFetcher.fetchTokens();
    return this.signalGenerator.generateFibonacciSignals(fetchedTokens);
  }
}

export default DataHawk;
