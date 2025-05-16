import { MongoClient } from 'mongodb';
import { Redis } from 'ioredis';
import { backOff } from 'exponential-backoff';
import * as tf from '@tensorflow/tfjs-node';
import { logInfoAggregated, logErrorAggregated } from '../utils/systemGuard';
import { FilterParams } from '../types';

const redisClient = new Redis(process.env.REDIS_URL || 'redis://default:uYnc1PFgjnDPW7BqlItETZ8gQaVzmL5W@redis-12123.c124.us-central1-1.gce.redns.redis-cloud.com:12123');
const mongoUri = process.env.MONGO_URI || 'mongodb+srv://swingsensei:QHH5LgRPPujpQDa2@cluster0.ncp3nmf.mongodb.net/swingsensei?retryWrites=true&w=majority';
const mongoClient = new MongoClient(mongoUri);

interface TokenHistory {
  ticker: string;
  volume: number;
  liquidity: number;
  holders: number;
  timestamp: Date;
  price: number;
  marketCap: number;
}

interface FeatureVector {
  volume: number;
  liquidity: number;
  holders: number;
  socialPosts: number;
  sentiment: number;
  priceChange: number;
}

class FilterGuardML {
  private readonly db: Promise<MongoClient>;
  private model: tf.Sequential;

  constructor() {
    this.db = mongoClient.connect();
    this.model = tf.sequential();
    this.model.add(tf.layers.dense({ units: 16, activation: 'relu', inputShape: [6] }));
    this.model.add(tf.layers.dense({ units: 8, activation: 'relu' }));
    this.model.add(tf.layers.dense({ units: 1, activation: 'sigmoid' }));
    this.model.compile({
      optimizer: tf.train.adam(0.001),
      loss: 'binaryCrossentropy',
      metrics: ['accuracy'],
    });
  }

  private async getMongoDB() {
    return backOff(async () => (await this.db).db(), { numOfAttempts: 3, startingDelay: 1000 });
  }

  private normalizeFeature(value: number, min: number, max: number): number {
    return (value - min) / (max - min) || 0;
  }

  private async getFeatureVector(history: TokenHistory, socialData: any): Promise<FeatureVector> {
    const socialPosts = socialData?.posts || 0;
    const sentiment = socialData?.sentiment || 0;
    const priceChange = history.price > 0 ? (history.price - history.price) / history.price : 0;

    return {
      volume: this.normalizeFeature(history.volume, 10000, 100000),
      liquidity: this.normalizeFeature(history.liquidity, 10000, 200000),
      holders: this.normalizeFeature(history.holders, 500, 5000),
      socialPosts: this.normalizeFeature(socialPosts, 0, 100),
      sentiment: this.normalizeFeature(sentiment, 0, 1),
      priceChange: this.normalizeFeature(priceChange, -0.5, 0.5),
    };
  }

  private async trainModel(filterName: string, days: number = 7): Promise<void> {
    try {
      const db = await this.getMongoDB();
      const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

      const tokenHistories = await db.collection<TokenHistory>('tokens_history').find({
        timestamp: { $gte: since },
      }).toArray();

      const trainingData: { features: FeatureVector; label: number }[] = [];
      for (const history of tokenHistories) {
        const latest = tokenHistories
          .filter(h => h.ticker === history.ticker)
          .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime())[0];
        const earliest = tokenHistories
          .filter(h => h.ticker === history.ticker)
          .sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime())[0];
        if (latest && earliest && earliest.price > 0) {
          const priceChange = (latest.price - earliest.price) / earliest.price;
          const label = priceChange > 0.2 ? 1 : 0;
          const socialData = await redisClient.get(`tweets:${history.ticker}`);
          const features = await this.getFeatureVector(history, socialData ? JSON.parse(socialData) : null);
          trainingData.push({ features, label });
        }
      }

      if (trainingData.length === 0) {
        logErrorAggregated('FILTERGUARD_ML', `No training data for ${filterName}`);
        return;
      }

      const xs = tf.tensor2d(trainingData.map(d => [
        d.features.volume,
        d.features.liquidity,
        d.features.holders,
        d.features.socialPosts,
        d.features.sentiment,
        d.features.priceChange,
      ]));
      const ys = tf.tensor2d(trainingData.map(d => [d.label]), [trainingData.length, 1]);

      await this.model.fit(xs, ys, {
        epochs: 50,
        batchSize: 32,
        shuffle: true,
        validationSplit: 0.2,
      });

      xs.dispose();
      ys.dispose();

      logInfoAggregated('FILTERGUARD_ML', `Trained MLP model for ${filterName}`);
    } catch (error) {
      logErrorAggregated('FILTERGUARD_ML', `Error training model for ${filterName}: ${error.message}`);
    }
  }

  private async predictSuccess(ticker: string): Promise<number> {
    try {
      const db = await this.getMongoDB();
      const history = await db.collection<TokenHistory>('tokens_history').findOne({
        ticker,
        timestamp: { $gte: new Date(Date.now() - 15 * 60 * 1000) },
      });
      if (!history) return 0;

      const socialData = await redisClient.get(`tweets:${ticker}`);
      const features = await this.getFeatureVector(history, socialData ? JSON.parse(socialData) : null);
      const input = tf.tensor2d([[
        features.volume,
        features.liquidity,
        features.holders,
        features.socialPosts,
        features.sentiment,
        features.priceChange,
      ]]);

      const prediction = this.model.predict(input) as tf.Tensor;
      const probability = (await prediction.data())[0];
      input.dispose();
      prediction.dispose();

      return probability;
    } catch (error) {
      logErrorAggregated('FILTERGUARD_ML', `Error predicting success for ${ticker}: ${error.message}`);
      return 0;
    }
  }

  async updateFilterParams(filterName: string, days: number = 7) {
    await this.trainModel(filterName, days);

    const mlParams: Partial<FilterParams> = {
      minVolume: 30000 * (1 + (await this.predictSuccess('TEST'))),
      minLiquidity: 50000 * (1 + (await this.predictSuccess('TEST'))),
      minHolders: 1000 * (1 + (await this.predictSuccess('TEST'))),
      minSocialPosts: 20 * (1 + (await this.predictSuccess('TEST'))),
      minSentiment: 0.7 * (1 + (await this.predictSuccess('TEST'))),
      minPriceChange: -10 * (1 + (await this.predictSuccess('TEST'))),
    };

    try {
      await redisClient.setEx(`filter:ml_params:${filterName}`, 24 * 3600, JSON.stringify(mlParams));
      logInfoAggregated('FILTERGUARD_ML', `Updated ML params for ${filterName}: ${JSON.stringify(mlParams)}`);
    } catch (error) {
      logErrorAggregated('FILTERGUARD_ML', `Error updating ML params for ${filterName}: ${error.message}`);
    }
  }

  async runMLCycle(filters: string[] = ['Trending 5min', 'NextBC 5min', 'Solana Swing Sniper', 'NewlyReached10M']) {
    for (const filter of filters) {
      await this.updateFilterParams(filter);
    }
  }
}

export default FilterGuardML;
