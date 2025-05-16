import { Redis } from 'ioredis';
import axios from 'axios';
import pLimit from 'p-limit';
import { backOff } from 'exponential-backoff';
import { CircuitBreaker } from 'opossum';
import { MongoClient } from 'mongodb';
import { logInfoAggregated, logErrorAggregated, sendTelegramAlert, recordMetric } from '../utils/systemGuard';
import { Token, FilterParams, LunarCrushData, XAlphaData } from '../types';
import { filterPassed, filterFailed, filterDurationSeconds } from '../utils/metrics';

const REDIS_URL = process.env.REDIS_URL || 'redis://default:uYnc1PFgjnDPW7BqlItETZ8gQaVzmL5W@redis-12123.c124.us-central1-1.gce.redns.redis-cloud.com:12123';
const MONGO_URI = process.env.MONGO_URI || 'mongodb+srv://swingsensei:QHH5LgRPPujpQDa2@cluster0.ncp3nmf.mongodb.net/swingsensei?retryWrites=true&w=majority';
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '-1002616465399';
const CACHE_TTL_SECONDS = 300;
const CONCURRENT_REQUEST_LIMIT = 10; // Уменьшено для оптимизации
const CIRCUIT_BREAKER_OPTIONS = { timeout: 10000, errorThresholdPercentage: 50, resetTimeout: 30000 };

interface BirdeyeData { volume: number; liquidity: number; marketCap: number; priceChange: number; price: number; }
interface CieloData { kits: number; maxTransferAmount: number; sellVolume: number; }
interface SolscanData { holders: number; burnedLP: number; transactions: number; createdAt: number; }
interface DexscreenerData { volume: number; liquidity: number; }
interface MoralisData { topHolders: number; holderConcentration: number; }
interface SocialData { posts: number; hasInfluencers: boolean; sentiment: number; }
interface HistoricalData { volume: number; liquidity: number; holders: number; }

class ApiError extends Error {
  constructor(message: string, public readonly status: number) {
    super(message);
    this.name = 'ApiError';
  }
}

class FilterGuard {
  private readonly redisClient: Redis;
  private readonly mongoClient: MongoClient;
  private readonly requestLimiter: (fn: () => Promise<any>) => Promise<any>;
  private readonly circuitBreakers: Record<string, CircuitBreaker>;
  private readonly mongoDbPromise: Promise<MongoClient>;

  constructor() {
    this.redisClient = new Redis(REDIS_URL);
    this.mongoClient = new MongoClient(MONGO_URI);
    this.requestLimiter = pLimit(CONCURRENT_REQUEST_LIMIT);
    this.mongoDbPromise = this.mongoClient.connect();
    this.circuitBreakers = {
      birdeye: new CircuitBreaker(this.fetchBirdeyeData.bind(this), CIRCUIT_BREAKER_OPTIONS),
      cielo: new CircuitBreaker(this.fetchCieloData.bind(this), CIRCUIT_BREAKER_OPTIONS),
      solscan: new CircuitBreaker(this.fetchSolscanData.bind(this), CIRCUIT_BREAKER_OPTIONS),
      dexscreener: new CircuitBreaker(this.fetchDexscreenerData.bind(this), CIRCUIT_BREAKER_OPTIONS),
      moralis: new CircuitBreaker(this.fetchMoralisData.bind(this), CIRCUIT_BREAKER_OPTIONS),
    };
    this.setupCircuitBreakerListeners();
  }

  private setupCircuitBreakerListeners(): void {
    Object.entries(this.circuitBreakers).forEach(([name, breaker]) =>
      breaker.on('open', () => logErrorAggregated('FILTERGUARD', `${name} API circuit opened`))
    );
  }

  private async getMongoDatabase() {
    return backOff(async () => (await this.mongoDbPromise).db(), { numOfAttempts: 5, startingDelay: 1000 });
  }

  private getActiveMarkets(): string[] {
    const now = new Date();
    const utcHour = now.getUTCHours();
    const utcMinute = now.getUTCMinutes();
    const activeMarkets: string[] = [];
    if (utcHour >= 0 && utcHour < 8) activeMarkets.push('Asia');
    if (utcHour >= 7 && utcHour < 15) activeMarkets.push('Europe');
    if ((utcHour > 14 || (utcHour === 14 && utcMinute >= 30)) && utcHour < 21) activeMarkets.push('US');
    return activeMarkets;
  }

  private async getCachedActiveMarkets(): Promise<string[]> {
    const cached = await this.redisClient.get('active_markets');
    if (cached) return JSON.parse(cached);
    const markets = this.getActiveMarkets();
    await this.redisClient.setEx('active_markets', 300, JSON.stringify(markets));
    return markets;
  }

  private adjustFilterParams(baseParams: FilterParams, activeMarkets: string[]): FilterParams {
    const adjustedParams = { ...baseParams };
    if (activeMarkets.includes('US')) {
      adjustedParams.minVolume = Math.round(baseParams.minVolume * 1.2);
      adjustedParams.minLiquidity = Math.round(baseParams.minLiquidity * 1.2);
    } else if (activeMarkets.includes('Asia')) {
      adjustedParams.minVolume = Math.round(baseParams.minVolume * 0.8);
      adjustedParams.minLiquidity = Math.round(baseParams.minLiquidity * 0.8);
    }
    return adjustedParams;
  }

  private async loadFilterParameters(filterName: string, defaultParams: FilterParams): Promise<FilterParams> {
    try {
      const mlParams = await this.redisClient.get(`filter:ml_params:${filterName}`);
      if (mlParams) return { ...defaultParams, ...JSON.parse(mlParams) };
      const learnedParams = await this.redisClient.get(`filter:learned_params:${filterName}`);
      if (learnedParams) return { ...defaultParams, ...JSON.parse(learnedParams) };
      const cachedParams = await this.redisClient.get(`filter:params:${filterName}`);
      return cachedParams ? { ...defaultParams, ...JSON.parse(cachedParams) } : defaultParams;
    } catch (error) {
      logErrorAggregated('FILTERGUARD', `Failed to load filter params for ${filterName}: ${(error as Error).message}`);
      return defaultParams;
    }
  }

  private async fetchBirdeyeData(ticker: string): Promise<BirdeyeData> {
    return this.fetchCachedData(`birdeye:${ticker}`, async () => {
      const response = await axios.get(`https://public-api.birdeye.so/v1/tokens/${ticker}`, {
        headers: { 'X-API-KEY': process.env.BIRDEYE_API_KEY || '66c9040b2fda4f6194880191a989e788' },
        timeout: 5000,
      });
      return {
        volume: response.data.volume_5min || 0,
        liquidity: response.data.liquidity || 0,
        marketCap: response.data.marketCap || 0,
        priceChange: response.data.priceChange_5min || 0,
        price: response.data.price || 0,
      };
    }, 'Birdeye', ticker);
  }

  private async fetchCieloData(ticker: string): Promise<CieloData> {
    return this.fetchCachedData(`cielo:${ticker}`, async () => {
      const response = await axios.get(`https://api.cielo.io/v1/whales/${ticker}`, {
        headers: { Authorization: `Bearer ${process.env.CIELO_API_KEY || '38aeb68f-b846-4d6a-92a5-6d133a5f0821'}` },
        timeout: 5000,
      });
      return {
        kits: response.data.kits || 0,
        maxTransferAmount: response.data.maxTransferAmount || 0,
        sellVolume: response.data.sellVolume || 0,
      };
    }, 'Cielo', ticker);
  }

  private async fetchSolscanData(ticker: string): Promise<SolscanData> {
    return this.fetchCachedData(`solscan:${ticker}`, async () => {
      const response = await axios.get(`https://public-api.solscan.io/v2/tokens/${ticker}`, {
        headers: { Authorization: `Bearer ${process.env.SOLSCAN_API_KEY || 'yJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...'}` },
        timeout: 5000,
      });
      return {
        holders: response.data.holders || 0,
        burnedLP: response.data.burnedLP || 0,
        transactions: response.data.transactions_5min || 0,
        createdAt: response.data.createdAt || 0,
      };
    }, 'Solscan', ticker);
  }

  private async fetchDexscreenerData(ticker: string): Promise<DexscreenerData> {
    return this.fetchCachedData(`dexscreener:${ticker}`, async () => {
      const response = await axios.get(`https://api.dexscreener.com/v1/tokens/${ticker}`, { timeout: 5000 });
      return {
        volume: response.data.volume_5min || 0,
        liquidity: response.data.liquidity || 0,
      };
    }, 'Dexscreener', ticker);
  }

  private async fetchMoralisData(ticker: string): Promise<MoralisData> {
    return this.fetchCachedData(`moralis:${ticker}`, async () => {
      const response = await axios.get(`https://deep-index.moralis.io/api/v2/tokens/${ticker}/holders`, {
        headers: { 'X-API-Key': process.env.MORALIS_API_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...' },
        timeout: 5000,
      });
      return {
        topHolders: response.data.topHolders || 0,
        holderConcentration: response.data.holderConcentration || 0,
      };
    }, 'Moralis', ticker);
  }

  private async fetchTweetcordData(ticker: string): Promise<SocialData> {
    return this.fetchCachedData(`tweets:${ticker}`, async () => {
      const tweets = await this.redisClient.get(`tweets:${ticker}`);
      if (!tweets) return { posts: 0, hasInfluencers: false, sentiment: 0 };
      const data = JSON.parse(tweets);
      return {
        posts: data.posts || 0,
        hasInfluencers: data.tweets.some((tweet: string) =>
          tweet.toLowerCase().includes('watcherguru') || tweet.toLowerCase().includes('elonmusk')
        ),
        sentiment: data.sentiment || 0,
      };
    }, 'Tweetcord', ticker);
  }

  private async fetchTelegramData(ticker: string): Promise<SocialData> {
    return this.fetchCachedData(`news:${ticker}`, async () => {
      const news = await this.redisClient.get(`news:${ticker}`);
      if (!news) return { posts: 0, hasInfluencers: false, sentiment: 0 };
      const data = JSON.parse(news);
      return {
        posts: data.posts || 0,
        hasInfluencers: data.category === 'call' || data.category === 'trend',
        sentiment: data.sentiment || 0,
      };
    }, 'TelegramNews', ticker);
  }

  private async fetchLunarData(ticker: string): Promise<LunarCrushData> {
    return this.fetchCachedData(`lunar:${ticker}`, async () => {
      const data = await this.redisClient.get(`lunar:${ticker}`);
      if (!data) return { socialVolume: 0, socialScore: 0, galaxyScore: 0, socialPosts: 0, sentiment: 0, timestamp: new Date().toISOString() };
      return JSON.parse(data);
    }, 'LunarCrush', ticker);
  }

  private async fetchXAlphaData(ticker: string): Promise<XAlphaData> {
    return this.fetchCachedData(`xalpha:${ticker}`, async () => {
      const data = await this.redisClient.get(`xalpha:${ticker}`);
      if (!data) return { socialPosts: 0, sentiment: 0, influenceScore: 0, timestamp: new Date().toISOString() };
      return JSON.parse(data);
    }, 'XAlpha', ticker);
  }

  private async fetchCachedData<T>(cacheKey: string, fetchFn: () => Promise<T>, apiName: string, ticker: string): Promise<T> {
    const cached = await this.redisClient.get(cacheKey);
    if (cached) return JSON.parse(cached);
    try {
      const data = await backOff(fetchFn, { numOfAttempts: 3, startingDelay: 1000 });
      await this.redisClient.setEx(cacheKey, CACHE_TTL_SECONDS, JSON.stringify(data));
      logInfoAggregated('FILTERGUARD', `Fetched ${apiName} data for ${ticker}`);
      return data;
    } catch (error) {
      const status = axios.isAxiosError(error) ? error.response?.status || 500 : 500;
      if (status >= 500) {
        logErrorAggregated('FILTERGUARD', `${apiName} server error for ${ticker}: ${(error as Error).message}`);
      } else {
        logErrorAggregated('FILTERGUARD', `${apiName} client error for ${ticker}: ${(error as Error).message}`);
      }
      throw new ApiError(`Failed to fetch ${apiName} data`, status);
    }
  }

  private async fetchMultipleCachedData<T>(cacheKeys: string[], fetchFn: () => Promise<T>, apiName: string, ticker: string): Promise<T[]> {
    const cached = await this.redisClient.mget(...cacheKeys);
    const results: T[] = [];
    for (let i = 0; i < cached.length; i++) {
      if (cached[i]) {
        results.push(JSON.parse(cached[i]));
      } else {
        const data = await backOff(fetchFn, { numOfAttempts: 3, startingDelay: 1000 });
        await this.redisClient.setEx(cacheKeys[i], CACHE_TTL_SECONDS, JSON.stringify(data));
        results.push(data);
      }
    }
    return results;
  }

  private async fetchHistoricalData(tickers: string[]): Promise<Map<string, HistoricalData>> {
    try {
      const db = await this.getMongoDatabase();
      const fifteenMinAgo = new Date(Date.now() - 15 * 60 * 1000);
      const data = await db.collection('tokens_history').find({
        ticker: { $in: tickers },
        timestamp: { $gte: fifteenMinAgo },
      }).toArray();
      return new Map(data.map(item => [item.ticker, {
        volume: item.volume,
        liquidity: item.liquidity,
        holders: item.holders,
      }]));
    } catch (error) {
      logErrorAggregated('FILTERGUARD', `Historical data error: ${(error as Error).message}`);
      throw new ApiError(`Failed to fetch historical data: ${(error as Error).message}`, 500);
    }
  }

  private async getPastMarketCap(ticker: string, date: Date): Promise<number> {
    try {
      const price = await this.fetchHistoricalPrice(ticker, date);
      const supply = await this.getTokenSupply(ticker);
      return price * supply;
    } catch (error) {
      logErrorAggregated('FILTERGUARD', `Past market cap error for ${ticker}: ${(error as Error).message}`);
      return 0;
    }
  }

  private async fetchHistoricalPrice(ticker: string, date: Date): Promise<number> {
    try {
      const response = await axios.get(`https://public-api.birdeye.so/v1/tokens/${ticker}/history`, {
        headers: { 'X-API-KEY': process.env.BIRDEYE_API_KEY || '66c9040b2fda4f6194880191a989e788' },
        params: { timestamp: Math.floor(date.getTime() / 1000) },
        timeout: 5000,
      });
      return response.data.price || 0;
    } catch (error) {
      logErrorAggregated('FILTERGUARD', `Birdeye historical price error for ${ticker}: ${(error as Error).message}`);
      return 0;
    }
  }

  private async getTokenSupply(ticker: string): Promise<number> {
    try {
      const response = await axios.get(`https://public-api.solscan.io/v2/tokens/${ticker}/supply`, {
        headers: { Authorization: `Bearer ${process.env.SOLSCAN_API_KEY || 'yJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...'}` },
        timeout: 5000,
      });
      return response.data.supply || 0;
    } catch (error) {
      logErrorAggregated('FILTERGUARD', `Solscan supply error for ${ticker}: ${(error as Error).message}`);
      return 0;
    }
  }

  private async checkSwingSniperPatterns(ticker: string, db: any): Promise<boolean> {
    try {
      const history = await db.collection('price_history').find({
        ticker,
        timestamp: { $gte: new Date(Date.now() - 20 * 60 * 1000) },
      }).toArray();
      if (history.length < 4) return false;
      const prices = history.map((h: any) => h.price);
      const volumes = history.map((h: any) => h.volume);
      const isDump = prices[0] * 0.8 > prices[Math.floor(prices.length / 2)];
      const isFlat = Math.max(...prices.slice(-4)) - Math.min(...prices.slice(-4)) <= prices[prices.length - 1] * 0.1;
      const isBreakout = prices[prices.length - 1] > prices[prices.length - 2] * 1.1;
      const isVolumeDump = volumes[0] > 30000;
      const isVolumeFlat = volumes[Math.floor(volumes.length / 2)] < 15000;
      const isVolumeBreakout = volumes[volumes.length - 1] > 50000;
      return isDump && isFlat && isBreakout && isVolumeDump && isVolumeFlat && isVolumeBreakout;
    } catch (error) {
      logErrorAggregated('FILTERGUARD', `Swing Sniper pattern error for ${ticker}: ${(error as Error).message}`);
      return false;
    }
  }

  private validateTokenInput(token: Token): void {
    const requiredFields: (keyof Token)[] = ['ticker', 'price', 'volume', 'marketCap', 'liquidity', 'priceChange'];
    for (const field of requiredFields) {
      if (token[field] === undefined || token[field] === null || (typeof token[field] === 'number' && token[field] < 0)) {
        throw new ApiError(`Invalid ${field} in token data`, 400);
      }
    }
    if (!token.ticker.match(/^[A-Z0-9]+$/)) {
      throw new ApiError('Invalid ticker format', 400);
    }
  }

  private async validateTokenMetrics(
    token: Token,
    params: FilterParams,
    historicalData: Map<string, HistoricalData>
  ): Promise<boolean> {
    const [
      birdeyeData,
      tweetcordData,
      telegramData,
      lunarData,
      xalphaData,
      whaleActivity,
      solscanData,
      dexscreenerData,
      moralisData
    ] = await Promise.all([
      this.circuitBreakers.birdeye.fire(token.ticker),
      this.fetchTweetcordData(token.ticker),
      this.fetchTelegramData(token.ticker),
      this.fetchLunarData(token.ticker),
      this.fetchXAlphaData(token.ticker),
      this.circuitBreakers.cielo.fire(token.ticker),
      this.circuitBreakers.solscan.fire(token.ticker),
      this.circuitBreakers.dexscreener.fire(token.ticker),
      this.circuitBreakers.moralis.fire(token.ticker),
    ]);

    const ageInHours = solscanData.createdAt ? (Date.now() - solscanData.createdAt) / 1000 / 3600 : 0;
    if (params.minAge && ageInHours < params.minAge || params.maxAge && ageInHours > params.maxAge) return false;

    const histData = historicalData.get(token.ticker);
    if (!histData) return false;

    const volumeGrowth = (token.volume - histData.volume) / histData.volume;
    const liquidityGrowth = token.liquidity - histData.liquidity;
    const holdersGrowth = solscanData.holders - histData.holders;
    if (
      (params.minVolumeGrowth && volumeGrowth < params.minVolumeGrowth) ||
      (params.minLiquidityGrowth && liquidityGrowth < params.minLiquidityGrowth) ||
      (params.minHoldersGrowth && holdersGrowth < params.minHoldersGrowth)
    ) return false;

    const sellRatio = whaleActivity.sellVolume / whaleActivity.maxTransferAmount;
    if (sellRatio > 0.15) return false;

    const validInfluencers = params.requireInfluencers
      ? (tweetcordData.hasInfluencers || telegramData.hasInfluencers || lunarData.socialPosts > 50 || xalphaData.influenceScore > 0.8)
      : true;
    const validSentiment = Math.max(tweetcordData.sentiment, telegramData.sentiment, lunarData.sentiment, xalphaData.sentiment) >= (params.minSentiment || 0.7);
    const validVolume = birdeyeData.volume >= params.minVolume * 0.9 && dexscreenerData.volume >= params.minVolume * 0.9;
    const validLiquidity = birdeyeData.liquidity >= params.minLiquidity * 0.9 && dexscreenerData.liquidity >= params.minLiquidity * 0.9;
    const validMarketCap = birdeyeData.marketCap >= params.minMarketCap && birdeyeData.marketCap <= (params.maxMarketCap || Infinity);
    const validPriceChange = birdeyeData.priceChange >= params.minPriceChange && birdeyeData.priceChange <= (params.maxPriceChange || Infinity);
    const validHolderConcentration = moralisData.holderConcentration <= (params.maxHolderConcentration || 0.5);

    return (
      validVolume &&
      validPriceChange &&
      validMarketCap &&
      validLiquidity &&
      (tweetcordData.posts + telegramData.posts + lunarData.socialPosts + xalphaData.socialPosts) >= (params.minSocialPosts || 0) &&
      whaleActivity.kits >= (params.minWhales || 0) &&
      whaleActivity.maxTransferAmount >= (params.whaleMinTransfer || 0) &&
      solscanData.holders >= (params.minHolders || 0) &&
      solscanData.burnedLP >= (params.burnedLP || 0) &&
      solscanData.transactions >= (params.minTransactions || 0) &&
      validInfluencers &&
      validSentiment &&
      validHolderConcentration
    );
  }

  private async validateToken(
    token: Token,
    params: FilterParams,
    historicalData: Map<string, HistoricalData>
  ): Promise<boolean> {
    this.validateTokenInput(token);
    const isStandardValid = await this.validateTokenMetrics(token, params, historicalData);
    if (isStandardValid) {
      recordMetric('filterPassed', { filter: params.name, ticker: token.ticker });
      return true;
    }

    const [tweetcordData, telegramData, lunarData, xalphaData] = await Promise.all([
      this.fetchTweetcordData(token.ticker),
      this.fetchTelegramData(token.ticker),
      this.fetchLunarData(token.ticker),
      this.fetchXAlphaData(token.ticker),
    ]);

    const hasStrongSocialSignal =
      tweetcordData.hasInfluencers ||
      telegramData.hasInfluencers ||
      Math.max(tweetcordData.sentiment, telegramData.sentiment, lunarData.sentiment, xalphaData.sentiment) > 0.9;
    if (hasStrongSocialSignal) {
      recordMetric('filterPassed', { filter: params.name, ticker: token.ticker });
      return true;
    }

    const isSwingSniperPattern = await this.checkSwingSniperPatterns(token.ticker, await this.getMongoDatabase());
    if (isSwingSniperPattern) {
      recordMetric('filterPassed', { filter: params.name, ticker: token.ticker });
      return true;
    }

    recordMetric('filterFailed', { filter: params.name, ticker: token.ticker });
    return false;
  }

  private async applyFiltersWithMetrics(tokens: Token[], params: FilterParams): Promise<Token[]> {
    const startTime = Date.now();
    const activeMarkets = await this.getCachedActiveMarkets();
    const adjustedParams = this.adjustFilterParams(params, activeMarkets);
    const historicalData = await this.fetchHistoricalData(tokens.map(t => t.ticker));

    const filteredTokens = await Promise.all(
      tokens.map(token =>
        this.requestLimiter(async () => (await this.validateToken(token, adjustedParams, historicalData) ? token : null))
      )
    );

    const validTokens = filteredTokens.filter((token): token is Token => token !== null);

    if (validTokens.length > 0) {
      await this.redisClient.publish('tokens:filtered', JSON.stringify(validTokens));
      await sendTelegramAlert(
        `Filtered ${validTokens.length} tokens for ${params.name} (Markets: ${activeMarkets.join(', ')})`,
        TELEGRAM_CHAT_ID
      );
    }
    logInfoAggregated('FILTERGUARD', `Applied ${params.name} filter: ${validTokens.length} tokens passed`);
    recordMetric('filterDurationSeconds', { filter: params.name }, (Date.now() - startTime) / 1000);

    await this.logFilterResults(params.name, tokens.length, validTokens.length, activeMarkets);

    return validTokens;
  }

  private async logFilterResults(
    filterName: string,
    totalTokens: number,
    passedTokens: number,
    activeMarkets: string[]
  ): Promise<void> {
    try {
      const db = await this.getMongoDatabase();
      await db.collection('filter_results').insertOne({
        filterName,
        timestamp: new Date(),
        totalTokens,
        passedTokens,
        activeMarkets,
      });
    } catch (error) {
      logErrorAggregated('FILTERGUARD', `Failed to log filter results: ${(error as Error).message}`);
    }
  }

  async applyFilters(tokens: Token[], params: FilterParams): Promise<Token[]> {
    const finalParams = await this.loadFilterParameters(params.name, params);
    return this.applyFiltersWithMetrics(tokens, finalParams);
  }

  async applyNewlyReached10MFilter(tokens: Token[]): Promise<Token[]> {
    const startTime = Date.now();
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const historicalData = await this.fetchHistoricalData(tokens.map(t => t.ticker));
    const filterParams: FilterParams = {
      name: 'NewlyReached10M',
      minVolume: 30000,
      minLiquidity: 50000,
      minHolders: 1000,
      minSocialPosts: 20,
      minSentiment: 0.7,
    };
    const learnedParams = await this.loadFilterParameters(filterParams.name, filterParams);

    const filteredTokens = await Promise.all(
      tokens.map(token =>
        this.requestLimiter(async () => {
          try {
            const currentMarketCap = await this.circuitBreakers.birdeye.fire(token.ticker).then(data => data.marketCap);
            const pastMarketCap = await this.getPastMarketCap(token.ticker, thirtyDaysAgo);
            if (pastMarketCap < 10_000_000 && currentMarketCap >= 10_000_000) {
              return (await this.validateToken(token, learnedParams, historicalData)) ? token : null;
            }
            return null;
          } catch (error) {
            logErrorAggregated('FILTERGUARD', `Error filtering ${token.ticker} for NewlyReached10M: ${(error as Error).message}`);
            return null;
          }
        })
      )
    );

    const validTokens = filteredTokens.filter((token): token is Token => token !== null);
    validTokens.forEach(token => recordMetric('filterPassed', { filter: 'NewlyReached10M', ticker: token.ticker }));
    filteredTokens.forEach((token, index) => {
      if (!token) recordMetric('filterFailed', { filter: 'NewlyReached10M', ticker: tokens[index].ticker });
    });

    if (validTokens.length > 0) {
      await this.redisClient.publish('tokens:filtered', JSON.stringify(validTokens));
      await sendTelegramAlert(`Filtered ${validTokens.length} tokens for NewlyReached10M`, TELEGRAM_CHAT_ID);
    }
    logInfoAggregated('FILTERGUARD', `Applied NewlyReached10M filter: ${validTokens.length} tokens passed`);
    recordMetric('filterDurationSeconds', { filter: 'NewlyReached10M' }, (Date.now() - startTime) / 1000);

    await this.logFilterResults('NewlyReached10M', tokens.length, validTokens.length, await this.getCachedActiveMarkets());

    return validTokens;
  }

  async applySolanaSwingSniperFilter(tokens: Token[]): Promise<Token[]> {
    const defaultParams: FilterParams = {
      name: 'Solana Swing Sniper',
      minVolume: 35000,
      minPriceChange: -20,
      maxPriceChange: 10,
      minMarketCap: 300000,
      maxMarketCap: 2500000,
      minLiquidity: 200000,
      minSocialPosts: 30,
      minWhales: 5,
      whaleMinTransfer: 25000,
      minHolders: 2000,
      burnedLP: 97,
      minTransactions: 500,
      requireInfluencers: true,
      minAge: 0.5,
      maxAge: 1440,
      minVolumeGrowth: 2.5,
      minLiquidityGrowth: 20000,
      minHoldersGrowth: 300,
      minSentiment: 0.8,
      maxHolderConcentration: 0.4,
    };
    const finalParams = await this.loadFilterParameters(defaultParams.name, defaultParams);
    return this.applyFiltersWithMetrics(tokens, finalParams);
  }

  async applyTrending5MinFilter(tokens: Token[]): Promise<Token[]> {
    const defaultParams: FilterParams = {
      name: 'Trending 5min',
      minVolume: 45000,
      minPriceChange: -10,
      maxPriceChange: 60,
      minMarketCap: 200000,
      maxMarketCap: 3000000,
      minLiquidity: 200000,
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
    return this.applyFilters(tokens, defaultParams);
  }

  async applyNextBC5MinFilter(tokens: Token[]): Promise<Token[]> {
    const defaultParams: FilterParams = {
      name: 'NextBC 5min',
      minVolume: 35000,
      minPriceChange: 30,
      maxPriceChange: 250,
      minMarketCap: 150000,
      maxMarketCap: 600000,
      minLiquidity: 200000,
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
    return this.applyFilters(tokens, defaultParams);
  }

  async run(): Promise<void> {
    try {
      await this.redisClient.subscribe('tokens:new', 'news:signals', 'tweets:raw', 'news:raw', 'lunar:raw', 'xalpha:raw');
      this.redisClient.on('message', async (channel: string, message: string) => {
        try {
          let tokens: Token[] = [];
          if (channel === 'lunar:raw' || channel === 'xalpha:raw') {
            const data = JSON.parse(message);
            tokens = [{
              ticker: data.ticker,
              price: 0,
              volume: 0,
              marketCap: 0,
              liquidity: 0,
              priceChange: 0,
            }];
            recordMetric(channel === 'lunar:raw' ? 'lunarRawProcessed' : 'xalphaRawProcessed', { ticker: data.ticker });
          } else {
            tokens = JSON.parse(message);
          }
          if (!Array.isArray(tokens) || tokens.length === 0) return;
          if (['tokens:new', 'news:signals', 'lunar:raw', 'xalpha:raw'].includes(channel)) {
            const filtered = await Promise.all([
              this.applyTrending5MinFilter(tokens),
              this.applyNextBC5MinFilter(tokens),
              this.applySolanaSwingSniperFilter(tokens),
              this.applyNewlyReached10MFilter(tokens),
            ]).then(results => results.flat());
            if (filtered.length > 0) {
              await this.redisClient.publish('tokens:filtered', JSON.stringify(filtered));
            }
          }
        } catch (error) {
          logErrorAggregated('FILTERGUARD', `Error processing ${channel}: ${(error as Error).message}`);
        }
      });
    } catch (error) {
      logErrorAggregated('FILTERGUARD', `Error starting FilterGuard: ${(error as Error).message}`);
    }
  }
}

export default FilterGuard;
