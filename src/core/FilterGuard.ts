import { Redis } from 'ioredis';
import axios from 'axios';
import pLimit from 'p-limit';
import { backOff } from 'exponential-backoff';
import { CircuitBreaker } from 'opossum';
import { MongoClient } from 'mongodb';
import { logInfoAggregated, logErrorAggregated, sendTelegramAlert, recordMetric } from '../utils/systemGuard';
import { Token, FilterParams } from '../types';

const redisClient = new Redis(process.env.REDIS_URL || 'redis://default:uYnc1PFgjnDPW7BqlItETZ8gQaVzmL5W@redis-12123.c124.us-central1-1.gce.redns.redis-cloud.com:12123');
const mongoUri = process.env.MONGO_URI || 'mongodb+srv://swingsniperbot:QHH5LgRPPujpQDa2@cluster0.ncp3nmf.mongodb.net/swingsensei?retryWrites=true&w=majority';
const mongoClient = new MongoClient(mongoUri);
const breakerOptions = { timeout: 10000, errorThresholdPercentage: 50, resetTimeout: 30000 };
const limit = pLimit(10);

interface BirdeyeData {
  volume: number;
  liquidity: number;
  marketCap: number;
  priceChange: number;
}

interface CieloData {
  kits: number;
  maxTransferAmount: number;
  sellVolume: number;
}

interface SolscanData {
  holders: number;
  burnedLP: number;
  transactions: number;
  createdAt: number;
}

interface DexscreenerData {
  volume: number;
  liquidity: number;
}

interface MoralisData {
  topHolders: number;
  holderConcentration: number;
}

interface SocialData {
  posts: number;
  hasInfluencers: boolean;
  sentiment: number;
}

class ApiError extends Error {
  constructor(message: string, public readonly status: number) {
    super(message);
    this.name = 'ApiError';
  }
}

class FilterGuard {
  private readonly birdeyeBreaker: CircuitBreaker;
  private readonly cieloBreaker: CircuitBreaker;
  private readonly solscanBreaker: CircuitBreaker;
  private readonly dexscreenerBreaker: CircuitBreaker;
  private readonly moralisBreaker: CircuitBreaker;
  private readonly db: Promise<MongoClient>;

  constructor() {
    this.birdeyeBreaker = new CircuitBreaker(this.fetchBirdeyeData.bind(this), breakerOptions);
    this.cieloBreaker = new CircuitBreaker(this.fetchCieloData.bind(this), breakerOptions);
    this.solscanBreaker = new CircuitBreaker(this.fetchSolscanData.bind(this), breakerOptions);
    this.dexscreenerBreaker = new CircuitBreaker(this.fetchDexscreenerData.bind(this), breakerOptions);
    this.moralisBreaker = new CircuitBreaker(this.fetchMoralisData.bind(this), breakerOptions);
    this.db = mongoClient.connect();
    this.birdeyeBreaker.on('open', () => logErrorAggregated('FILTERGUARD', 'Birdeye API circuit opened'));
    this.cieloBreaker.on('open', () => logErrorAggregated('FILTERGUARD', 'Cielo API circuit opened'));
    this.solscanBreaker.on('open', () => logErrorAggregated('FILTERGUARD', 'Solscan API circuit opened'));
    this.dexscreenerBreaker.on('open', () => logErrorAggregated('FILTERGUARD', 'Dexscreener API circuit opened'));
    this.moralisBreaker.on('open', () => logErrorAggregated('FILTERGUARD', 'Moralis API circuit opened'));
  }

  private async getMongoDB() {
    return backOff(async () => {
      const client = await this.db;
      return client.db();
    }, { numOfAttempts: 3, startingDelay: 1000 });
  }

  private async fetchBirdeyeData(ticker: string): Promise<BirdeyeData> {
    const cacheKey = `birdeye:${ticker}`;
    const cached = await redisClient.get(cacheKey);
    if (cached) return JSON.parse(cached);

    try {
      const data = await backOff(async () => {
        const response = await axios.get(`https://public-api.birdeye.so/v1/tokens/${ticker}`, {
          headers: { 'X-API-KEY': process.env.BIRDEYE_API_KEY || '66c9040b2fda4f6194880191a989e788' },
          timeout: 5000,
        });
        return {
          volume: response.data.volume_5min || 0,
          liquidity: response.data.liquidity || 0,
          marketCap: response.data.marketCap || 0,
          priceChange: response.data.priceChange_5min || 0,
        };
      }, { numOfAttempts: 3, startingDelay: 1000 });
      await redisClient.setEx(cacheKey, 3600, JSON.stringify(data));
      logInfoAggregated('FILTERGUARD', `Fetched Birdeye data for ${ticker}`);
      return data;
    } catch (error) {
      logErrorAggregated('FILTERGUARD', `Birdeye API error for ${ticker}: ${error.message}`);
      throw new ApiError(`Failed to fetch Birdeye data: ${error.message}`, axios.isAxiosError(error) && error.response?.status || 500);
    }
  }

  private async fetchCieloData(ticker: string): Promise<CieloData> {
    const cacheKey = `cielo:${ticker}`;
    const cached = await redisClient.get(cacheKey);
    if (cached) return JSON.parse(cached);

    try {
      const data = await backOff(async () => {
        const response = await axios.get(`https://api.cielo.io/v1/whales/${ticker}`, {
          headers: { Authorization: `Bearer ${process.env.CIELO_API_KEY || '38aeb68f-b846-4d6a-92a5-6d133a5f0821'}` },
          timeout: 5000,
        });
        return {
          kits: response.data.kits || 0,
          maxTransferAmount: response.data.maxTransferAmount || 0,
          sellVolume: response.data.sellVolume || 0,
        };
      }, { numOfAttempts: 3, startingDelay: 1000 });
      await redisClient.setEx(cacheKey, 3600, JSON.stringify(data));
      logInfoAggregated('FILTERGUARD', `Fetched Cielo data for ${ticker}`);
      return data;
    } catch (error) {
      logErrorAggregated('FILTERGUARD', `Cielo API error for ${ticker}: ${error.message}`);
      throw new ApiError(`Failed to fetch Cielo data: ${error.message}`, axios.isAxiosError(error) && error.response?.status || 500);
    }
  }

  private async fetchSolscanData(ticker: string): Promise<SolscanData> {
    const cacheKey = `solscan:${ticker}`;
    const cached = await redisClient.get(cacheKey);
    if (cached) return JSON.parse(cached);

    try {
      const data = await backOff(async () => {
        const response = await axios.get(`https://public-api.solscan.io/v2/tokens/${ticker}`, {
          headers: { Authorization: `Bearer ${process.env.SOLSCAN_API_KEY || 'yJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJjcmVhdGVkQXQiOjE3NDQwMzIwMTc0MDAsImVtYWlsIjoiZ29yb3Zvai5pdmFuQGdtYWlsLmNvbSIsImFjdGlvbiI6InRva2VuLWFwaSIsImFwaVZlcnNpb24iOiJ2MiIsImlhdCI6MTc0NDAzMjAxN30.jzSbaIygiJe6cC0sGk3Ek4jTj77qJlHFaB8wGeV4abw'}` },
          timeout: 5000,
        });
        return {
          holders: response.data.holders || 0,
          burnedLP: response.data.burnedLP || 0,
          transactions: response.data.transactions_5min || 0,
          createdAt: response.data.createdAt || 0,
        };
      }, { numOfAttempts: 3, startingDelay: 1000 });
      await redisClient.setEx(cacheKey, 3600, JSON.stringify(data));
      logInfoAggregated('FILTERGUARD', `Fetched Solscan data for ${ticker}`);
      return data;
    } catch (error) {
      logErrorAggregated('FILTERGUARD', `Solscan API error for ${ticker}: ${error.message}`);
      throw new ApiError(`Failed to fetch Solscan data: ${error.message}`, axios.isAxiosError(error) && error.response?.status || 500);
    }
  }

  private async fetchDexscreenerData(ticker: string): Promise<DexscreenerData> {
    const cacheKey = `dexscreener:${ticker}`;
    const cached = await redisClient.get(cacheKey);
    if (cached) return JSON.parse(cached);

    try {
      const data = await backOff(async () => {
        const response = await axios.get(`https://api.dexscreener.com/v1/tokens/${ticker}`, {
          timeout: 5000,
        });
        return {
          volume: response.data.volume_5min || 0,
          liquidity: response.data.liquidity || 0,
        };
      }, { numOfAttempts: 3, startingDelay: 1000 });
      await redisClient.setEx(cacheKey, 3600, JSON.stringify(data));
      logInfoAggregated('FILTERGUARD', `Fetched Dexscreener data for ${ticker}`);
      return data;
    } catch (error) {
      logErrorAggregated('FILTERGUARD', `Dexscreener API error for ${ticker}: ${error.message}`);
      throw new ApiError(`Failed to fetch Dexscreener data: ${error.message}`, axios.isAxiosError(error) && error.response?.status || 500);
    }
  }

  private async fetchMoralisData(ticker: string): Promise<MoralisData> {
    const cacheKey = `moralis:${ticker}`;
    const cached = await redisClient.get(cacheKey);
    if (cached) return JSON.parse(cached);

    try {
      const data = await backOff(async () => {
        const response = await axios.get(`https://deep-index.moralis.io/api/v2/tokens/${ticker}/holders`, {
          headers: { 'X-API-Key': process.env.MORALIS_API_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJub25jZSI6ImRlYTQyNzgwLTZiODEtNGRhMS05NTg5LTVlZTY5ZDM3NzBjNSIsIm9yZ0lkIjoiNDQyMzU0IiwidXNlcklkIjoiNDU1MTE2IiwidHlwZSI6IlBST0pFQ1QiLCJ0eXBlSWQiOiJmODE0Y2FhNy0zNDVhLTQ3OTAtOGE0MC0xYzYxNjYxZjUzNTkiLCJpYXQiOjE3NDUxNjA5MjMsImV4cCI6NDkwMDkyMDkyM30.Spa1J9dajgV0PrS5FIQItLhRlTjB9SnQ4yyfpsSN4RQ' },
          timeout: 5000,
        });
        return {
          topHolders: response.data.topHolders || 0,
          holderConcentration: response.data.holderConcentration || 0,
        };
      }, { numOfAttempts: 3, startingDelay: 1000 });
      await redisClient.setEx(cacheKey, 3600, JSON.stringify(data));
      logInfoAggregated('FILTERGUARD', `Fetched Moralis data for ${ticker}`);
      return data;
    } catch (error) {
      logErrorAggregated('FILTERGUARD', `Moralis API error for ${ticker}: ${error.message}`);
      throw new ApiError(`Failed to fetch Moralis data: ${error.message}`, axios.isAxiosError(error) && error.response?.status || 500);
    }
  }

  private async fetchTweetcordData(ticker: string): Promise<SocialData> {
    const cacheKey = `tweets:${ticker}`;
    const cached = await redisClient.get(cacheKey);
    if (cached) return JSON.parse(cached);

    try {
      const tweets = await redisClient.get(`tweets:${ticker}`);
      if (!tweets) return { posts: 0, hasInfluencers: false, sentiment: 0 };
      const data = JSON.parse(tweets);
      const result = {
        posts: data.posts || 0,
        hasInfluencers: data.tweets.some((tweet: string) =>
          tweet.toLowerCase().includes('watcherguru') || tweet.toLowerCase().includes('elonmusk')
        ),
        sentiment: data.sentiment || 0,
      };
      await redisClient.setEx(cacheKey, 3600, JSON.stringify(result));
      logInfoAggregated('FILTERGUARD', `Fetched ${result.posts} tweets for ${ticker}`);
      return result;
    } catch (error) {
      logErrorAggregated('FILTERGUARD', `Tweetcord error for ${ticker}: ${error.message}`);
      throw new ApiError(`Failed to fetch Tweetcord data: ${error.message}`, 500);
    }
  }

  private async fetchHistoricalData(ticker: string): Promise<{ volume: number; liquidity: number; holders: number } | null> {
    try {
      const db = await this.getMongoDB();
      const fifteenMinAgo = new Date(Date.now() - 15 * 60 * 1000);
      const data = await db.collection('tokens_history').findOne({
        ticker,
        timestamp: { $gte: fifteenMinAgo },
      });
      return data ? { volume: data.volume, liquidity: data.liquidity, holders: data.holders } : null;
    } catch (error) {
      logErrorAggregated('FILTERGUARD', `Historical data error for ${ticker}: ${error.message}`);
      throw new ApiError(`Failed to fetch historical data: ${error.message}`, 500);
    }
  }

  private async checkSwingSniperPatterns(ticker: string, db: any): Promise<boolean> {
    try {
      const history = await db.collection('price_history').find({
        ticker,
        timestamp: { $gte: new Date(Date.now() - 20 * 60 * 1000) },
      }).toArray();
      if (history.length < 4) return false;

      const prices = history.map(h => h.price);
      const volumes = history.map(h => h.volume);
      const dump = prices[0] * 0.8 > prices[Math.floor(prices.length / 2)]; // Дамп: цена упала на 20%
      const flat = Math.max(...prices.slice(-4)) - Math.min(...prices.slice(-4)) <= prices[prices.length - 1] * 0.1; // Флэт: колебания <10%
      const breakout = prices[prices.length - 1] > prices[prices.length - 2] * 1.1; // Пробой: рост >10%
      const volumeDump = volumes[0] > 30000; // Высокий объем на дампе
      const volumeFlat = volumes[Math.floor(volumes.length / 2)] < 15000; // Низкий объем на флэте
      const volumeBreakout = volumes[volumes.length - 1] > 50000; // Высокий объем на пробое

      return dump && flat && breakout && volumeDump && volumeFlat && volumeBreakout;
    } catch (error) {
      logErrorAggregated('FILTERGUARD', `Swing Sniper pattern error for ${ticker}: ${error.message}`);
      return false;
    }
  }

  private validateTokenInput(token: Token): void {
    if (!token.ticker || typeof token.volume !== 'number' || token.volume < 0 || typeof token.liquidity !== 'number' || token.liquidity < 0) {
      throw new ApiError('Invalid token data', 400);
    }
  }

  private async validateToken(token: Token, params: FilterParams): Promise<boolean> {
    try {
      this.validateTokenInput(token);

      const [birdeyeData, tweetcordData, whaleActivity, solscanData, dexscreenerData, moralisData, historicalData] = await Promise.all([
        this.birdeyeBreaker.fire(token.ticker),
        this.fetchTweetcordData(token.ticker),
        this.cieloBreaker.fire(token.ticker),
        this.solscanBreaker.fire(token.ticker),
        this.dexscreenerBreaker.fire(token.ticker),
        this.moralisBreaker.fire(token.ticker),
        this.fetchHistoricalData(token.ticker),
      ]);

      // Проверка возраста токена
      const ageInHours = solscanData.createdAt ? (Date.now() - solscanData.createdAt) / 1000 / 3600 : 0;
      if (params.minAge && ageInHours < params.minAge) return false;
      if (params.maxAge && ageInHours > params.maxAge) return false;

      // Проверка роста метрик
      if (historicalData) {
        const volumeGrowth = (token.volume - historicalData.volume) / historicalData.volume;
        const liquidityGrowth = token.liquidity - historicalData.liquidity;
        const holdersGrowth = solscanData.holders - historicalData.holders;
        if (params.minVolumeGrowth && volumeGrowth < params.minVolumeGrowth) return false;
        if (params.minLiquidityGrowth && liquidityGrowth < params.minLiquidityGrowth) return false;
        if (params.minHoldersGrowth && holdersGrowth < params.minHoldersGrowth) return false;
      } else {
        return false; // Нет исторических данных
      }

      // Проверка whale-слива
      const sellRatio = whaleActivity.sellVolume / whaleActivity.maxTransferAmount;
      if (sellRatio > 0.15) return false; // Ужесточено на основе твоего опыта

      // Проверка инфлюенсеров и sentiment
      const validInfluencers = params.requireInfluencers ? tweetcordData.hasInfluencers : true;
      const validSentiment = tweetcordData.sentiment >= (params.minSentiment || 0.7);

      // Кросс-проверка с Birdeye и Dexscreener
      const validVolume = birdeyeData.volume >= params.minVolume * 0.9 && dexscreenerData.volume >= params.minVolume * 0.9;
      const validLiquidity = birdeyeData.liquidity >= params.minLiquidity * 0.9 && dexscreenerData.liquidity >= params.minLiquidity * 0.9;
      const validMarketCap = birdeyeData.marketCap >= params.minMarketCap && birdeyeData.marketCap <= (params.maxMarketCap || Infinity);
      const validPriceChange = birdeyeData.priceChange >= params.minPriceChange && birdeyeData.priceChange <= (params.maxPriceChange || Infinity);

      // Проверка концентрации держателей (Moralis)
      const validHolderConcentration = moralisData.holderConcentration <= (params.maxHolderConcentration || 0.5); // Не более 50% у топ-держателей

      return (
        validVolume &&
        validPriceChange &&
        validMarketCap &&
        validLiquidity &&
        tweetcordData.posts >= (params.minSocialPosts || 0) &&
        whaleActivity.kits >= (params.minWhales || 0) &&
        whaleActivity.maxTransferAmount >= (params.whaleMinTransfer || 0) &&
        solscanData.holders >= (params.minHolders || 0) &&
        solscanData.burnedLP >= (params.burnedLP || 0) &&
        solscanData.transactions >= (params.minTransactions || 0) &&
        validInfluencers &&
        validSentiment &&
        validHolderConcentration
      );
    } catch (error) {
      logErrorAggregated('FILTERGUARD', `Error validating ${token.ticker}: ${error.message}`);
      return false;
    }
  }

  async applyFilters(tokens: Token[], params: FilterParams): Promise<Token[]> {
    const filtered: Token[] = [];
    const promises = tokens.map(token => limit(async () => {
      if (await this.validateToken(token, params)) {
        return token;
      }
      return null;
    }));

    const results = await Promise.all(promises);
    results.forEach((token) => {
      if (token) {
        filtered.push(token);
        recordMetric('filter_passed', { filter: params.name, ticker: token.ticker });
      } else {
        recordMetric('filter_failed', { filter: params.name, ticker: token.ticker });
      }
    });

    if (filtered.length > 0) {
      await redisClient.publish('tokens:filtered', JSON.stringify(filtered));
      await sendTelegramAlert(`Filtered ${filtered.length} tokens for ${params.name}`, process.env.TELEGRAM_CHAT_ID || '-1002616465399');
    }
    logInfoAggregated('FILTERGUARD', `Applied ${params.name} filter: ${filtered.length} tokens passed`);
    return filtered;
  }

  async applySolanaSwingSniperFilter(tokens: Token[]): Promise<Token[]> {
    const filtered: Token[] = [];
    const db = await this.getMongoDB();

    const promises = tokens.map(token => limit(async () => {
      try {
        this.validateTokenInput(token);

        const [birdeyeData, tweetcordData, whaleActivity, solscanData, dexscreenerData, moralisData] = await Promise.all([
          this.birdeyeBreaker.fire(token.ticker),
          this.fetchTweetcordData(token.ticker),
          this.cieloBreaker.fire(token.ticker),
          this.solscanBreaker.fire(token.ticker),
          this.dexscreenerBreaker.fire(token.ticker),
          this.moralisBreaker.fire(token.ticker),
        ]);

        // Проверка возраста токена
        const ageInHours = solscanData.createdAt ? (Date.now() - solscanData.createdAt) / 1000 / 3600 : 0;
        if (ageInHours < 0.5 || ageInHours > 1440) return null;

        // Проверка дампа, флэта, пробоя
        if (!(await this.checkSwingSniperPatterns(token.ticker, db))) return null;

        // Проверка whale-слива
        const sellRatio = whaleActivity.sellVolume / whaleActivity.maxTransferAmount;
        if (sellRatio > 0.15) return null;

        // Проверка остальных метрик
        const params: FilterParams = {
          name: 'Solana Swing Sniper',
          minVolume: 35000, // Ужесточено на основе твоего опыта
          minPriceChange: -20,
          maxPriceChange: 10,
          minMarketCap: 300000,
          maxMarketCap: 2500000,
          minLiquidity: 150000,
          minSocialPosts: 30,
          minWhales: 5,
          whaleMinTransfer: 25000,
          minHolders: 2000, // Ужесточено для защиты от скама
          burnedLP: 97,
          minTransactions: 500,
          requireInfluencers: true,
          minAge: 0.5,
          maxAge: 1440,
          minVolumeGrowth: 2.5,
          minLiquidityGrowth: 20000,
          minHoldersGrowth: 300,
          minSentiment: 0.8,
          maxHolderConcentration: 0.4, // Не более 40% у топ-держателей
        };

        if (await this.validateToken(token, params)) {
          return token;
        }
        return null;
      } catch (error) {
        logErrorAggregated('FILTERGUARD', `Error filtering ${token.ticker}: ${error.message}`);
        return null;
      }
    }));

    const results = await Promise.all(promises);
    results.forEach((token) => {
      if (token) {
        filtered.push(token);
        recordMetric('filter_passed', { filter: 'Solana Swing Sniper', ticker: token.ticker });
      } else {
        recordMetric('filter_failed', { filter: 'Solana Swing Sniper', ticker: token.ticker });
      }
    });

    if (filtered.length > 0) {
      await redisClient.publish('tokens:filtered', JSON.stringify(filtered));
      await sendTelegramAlert(`Filtered ${filtered.length} tokens for Solana Swing Sniper`, process.env.TELEGRAM_CHAT_ID || '-1002616465399');
    }
    logInfoAggregated('FILTERGUARD', `Applied Solana Swing Sniper filter: ${filtered.length} tokens passed`);
    return filtered;
  }

  async applyTrending5MinFilter(tokens: Token[]): Promise<Token[]> {
    const params: FilterParams = {
      name: 'Trending 5min',
      minVolume: 45000,
      minPriceChange: -10,
      maxPriceChange: 60,
      minMarketCap: 200000,
      maxMarketCap: 3000000,
      minLiquidity: 60000,
      minSocialPosts: 35,
      minWhales: 4,
      whaleMinTransfer: 20000,
      minHolders: 1500,
      burnedLP: 97,
      minTransactions: 250,
      requireInfluencers: true,
      minAge: 0.667,
      maxAge: 3,
      minVolumeGrowth: 2,
      minLiquidityGrowth: 20000,
      minHoldersGrowth: 200,
      minSentiment: 0.8,
      maxHolderConcentration: 0.4,
    };
    return this.applyFilters(tokens, params);
  }

  async applyNextBC5MinFilter(tokens: Token[]): Promise<Token[]> {
    const params: FilterParams = {
      name: 'NextBC 5min',
      minVolume: 35000,
      minPriceChange: 30,
      maxPriceChange: 250,
      minMarketCap: 150000,
      maxMarketCap: 600000,
      minLiquidity: 50000,
      minSocialPosts: 35,
      minWhales: 4,
      whaleMinTransfer: 15000,
      minHolders: 1000,
      burnedLP: 97,
      minTransactions: 250,
      requireInfluencers: true,
      minAge: 72,
      maxAge: 1440,
      minVolumeGrowth: 3,
      minLiquidityGrowth: 15000,
      minHoldersGrowth: 150,
      minSentiment: 0.8,
      maxHolderConcentration: 0.4,
    };
    return this.applyFilters(tokens, params);
  }
}

export default FilterGuard;
