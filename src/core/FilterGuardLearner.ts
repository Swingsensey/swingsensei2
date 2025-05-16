import { MongoClient } from 'mongodb';
import { Redis } from 'ioredis';
import { backOff } from 'exponential-backoff';
import { logInfoAggregated, logErrorAggregated } from '../utils/systemGuard';
import { FilterParams } from '../types';

const redisClient = new Redis(process.env.REDIS_URL || 'redis://default:uYnc1PFgjnDPW7BqlItETZ8gQaVzmL5W@redis-12123.c124.us-central1-1.gce.redns.redis-cloud.com:12123');
const mongoUri = process.env.MONGO_URI || 'mongodb+srv://swingsensei:QHH5LgRPPujpQDa2@cluster0.ncp3nmf.mongodb.net/swingsensei?retryWrites=true&w=majority';
const mongoClient = new MongoClient(mongoUri);

interface FilterResult {
  filterName: string;
  timestamp: Date;
  totalTokens: number;
  passedTokens: number;
  activeMarkets: string[];
}

interface TokenHistory {
  ticker: string;
  volume: number;
  liquidity: number;
  holders: number;
  timestamp: Date;
  price: number;
  marketCap: number;
}

class FilterGuardLearner {
  private readonly db: Promise<MongoClient>;

  constructor() {
    this.db = mongoClient.connect();
  }

  private async getMongoDB() {
    return backOff(async () => (await this.db).db(), { numOfAttempts: 3, startingDelay: 1000 });
  }

  private calculatePercentile(values: number[], percentile: number): number {
    if (values.length === 0) return 0;
    const sorted = values.sort((a, b) => a - b);
    const index = Math.ceil((percentile / 100) * sorted.length) - 1;
    return sorted[index] || 0;
  }

  private async analyzeFilterPerformance(filterName: string, days: number = 7): Promise<Partial<FilterParams>> {
    try {
      const db = await this.getMongoDB();
      const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

      const results = await db.collection<FilterResult>('filter_results').find({
        filterName,
        timestamp: { $gte: since },
      }).toArray();

      const successfulTickers = new Set<string>();
      const tokenHistories = await db.collection<TokenHistory>('tokens_history').find({
        timestamp: { $gte: since },
      }).toArray();

      const tickerPriceChanges: Record<string, number> = {};
      for (const history of tokenHistories) {
        if (!tickerPriceChanges[history.ticker]) {
          const latest = tokenHistories
            .filter(h => h.ticker === history.ticker)
            .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime())[0];
          const earliest = tokenHistories
            .filter(h => h.ticker === history.ticker)
            .sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime())[0];
          if (latest && earliest && earliest.price > 0) {
            tickerPriceChanges[history.ticker] = (latest.price - earliest.price) / earliest.price;
            if (tickerPriceChanges[history.ticker] > 0.2) {
              successfulTickers.add(history.ticker);
            }
          }
        }
      }

      const volumes: number[] = [];
      const liquidities: number[] = [];
      const socialPosts: number[] = [];
      const sentiments: number[] = [];

      for (const ticker of successfulTickers) {
        const histories = tokenHistories.filter(h => h.ticker === ticker);
        histories.forEach(h => {
          volumes.push(h.volume);
          liquidities.push(h.liquidity);
        });
        const socialData = await redisClient.get(`tweets:${ticker}`);
        if (socialData) {
          const parsed = JSON.parse(socialData);
          socialPosts.push(parsed.posts || 0);
          sentiments.push(parsed.sentiment || 0);
        }
      }

      const learnedParams: Partial<FilterParams> = {
        minVolume: this.calculatePercentile(volumes, 90) || 30000,
        minLiquidity: this.calculatePercentile(liquidities, 90) || 50000,
        minSocialPosts: this.calculatePercentile(socialPosts, 90) || 20,
        minSentiment: this.calculatePercentile(sentiments, 90) || 0.7,
      };

      logInfoAggregated('FILTERGUARD_LEARNER', `Learned params for ${filterName}: ${JSON.stringify(learnedParams)}`);
      return learnedParams;
    } catch (error) {
      logErrorAggregated('FILTERGUARD_LEARNER', `Error analyzing filter performance for ${filterName}: ${error.message}`);
      return {};
    }
  }

  async updateFilterParams(filterName: string, days: number = 7) {
    try {
      const learnedParams = await this.analyzeFilterPerformance(filterName, days);
      if (Object.keys(learnedParams).length > 0) {
        await redisClient.setEx(`filter:learned_params:${filterName}`, 24 * 3600, JSON.stringify(learnedParams));
        logInfoAggregated('FILTERGUARD_LEARNER', `Updated learned params for ${filterName}`);
      }
    } catch (error) {
      logErrorAggregated('FILTERGUARD_LEARNER', `Error updating filter params for ${filterName}: ${error.message}`);
    }
  }

  async runLearningCycle(filters: string[] = ['Trending 5min', 'NextBC 5min', 'Solana Swing Sniper', 'NewlyReached10M']) {
    for (const filter of filters) {
      await this.updateFilterParams(filter);
    }
  }
}

export default FilterGuardLearner;
