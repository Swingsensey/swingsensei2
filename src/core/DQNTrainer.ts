import * as tf from '@tensorflow/tfjs-node';
import Redis from 'ioredis';
import axios from 'axios';
import { NewsSignal, Token } from '../utils/types';
import { logInfoAggregated, logErrorAggregated } from './SystemGuard';
import { retry } from '../utils/utils';

// Интерфейс для DQN-агента
interface DQNAgent {
  train(signals: NewsSignal[], tokens: Token[]): Promise<void>;
  predict(ticker: string, signal: NewsSignal): Promise<number>;
  saveModel(): Promise<void>;
  loadModel(): Promise<void>;
}

class DQNTrainer implements DQNAgent {
  private readonly redisClient: Redis;
  private readonly axiosInstance: typeof axios;
  private model: tf.Sequential;
  private readonly stateSize = 6; // [sentimentScore, announcementImpact, confidence, fearGreedIndex, isWhale, strategy]
  private readonly actionSize = 3; // [buy, sell, hold]
  private readonly gamma = 0.95; // Discount factor
  private readonly epsilon = 1.0; // Exploration rate
  private readonly epsilonMin = 0.01;
  private readonly epsilonDecay = 0.995;
  private readonly learningRate = 0.001;
  private readonly batchSize = 32;
  private readonly memory: Array<{
    state: number[];
    action: number;
    reward: number;
    nextState: number[];
    done: boolean;
  }> = [];
  private readonly memorySize = 1000;

  constructor(redisClient: Redis = new Redis(process.env.REDIS_URL!), axiosInstance: typeof axios = axios) {
    this.redisClient = redisClient;
    this.axiosInstance = axiosInstance;
    this.model = this.createModel();
    this.loadModel().catch(() => logInfoAggregated('DQN_TRAINER', 'No saved model found, starting fresh'));
  }

  private createModel(): tf.Sequential {
    const model = tf.sequential();
    model.add(
      tf.layers.dense({
        units: 64,
        activation: 'relu',
        inputShape: [this.stateSize],
      })
    );
    model.add(tf.layers.dense({ units: 32, activation: 'relu' }));
    model.add(tf.layers.dense({ units: this.actionSize, activation: 'linear' }));
    model.compile({
      optimizer: tf.train.adam(this.learningRate),
      loss: 'meanSquaredError',
    });
    return model;
  }

  private async getTokenPrice(ticker: string): Promise<number> {
    try {
      const response = await retry(
        () =>
          this.axiosInstance.get('https://api.raydium.io/v2/tokens', {
            headers: { Authorization: `Bearer ${process.env.RAYDIUM_API_KEY}` },
          }),
        { retries: 3 }
      );
      const token = response.data.find((t: any) => t.symbol === ticker);
      return token ? Number(token.price) : 0;
    } catch (error) {
      logErrorAggregated('DQN_TRAINER', `Failed to fetch price for ${ticker}: ${error.message}`);
      return 0;
    }
  }

  private getState(signal: NewsSignal): number[] {
    const strategyValue = signal.strategy
      ? { pump: 1, dump: -1, fomo: 0.5 }[signal.strategy] || 0
      : 0;
    return [
      signal.sentimentScore,
      signal.announcementImpact,
      signal.confidence,
      signal.fearGreedIndex / 100,
      signal.isWhale ? 1 : 0,
      strategyValue,
    ];
  }

  private calculateReward(currentPrice: number, nextPrice: number, action: number): number {
    const priceChange = nextPrice - currentPrice;
    if (action === 0) return priceChange > 0 ? priceChange : -priceChange; // Buy
    if (action === 1) return priceChange < 0 ? -priceChange : priceChange; // Sell
    return -Math.abs(priceChange) * 0.1; // Hold (small penalty)
  }

  async train(signals: NewsSignal[], tokens: Token[]): Promise<void> {
    if (signals.length < 2) {
      logInfoAggregated('DQN_TRAINER', 'Not enough signals to train');
      return;
    }

    try {
      for (let i = 0; i < signals.length - 1; i++) {
        const signal = signals[i];
        const nextSignal = signals[i + 1];
        const token = tokens.find((t) => t.ticker === signal.ticker);
        if (!token) continue;

        const currentPrice = await this.getTokenPrice(signal.ticker);
        const nextPrice = await this.getTokenPrice(nextSignal.ticker);
        if (currentPrice === 0 || nextPrice === 0) continue;

        const state = this.getState(signal);
        const nextState = this.getState(nextSignal);
        const action = Math.random() < this.epsilon ? Math.floor(Math.random() * this.actionSize) : await this.getBestAction(state);
        const reward = this.calculateReward(currentPrice, nextPrice, action);
        const done = i === signals.length - 2;

        this.memory.push({ state, action, reward, nextState, done });
        if (this.memory.length > this.memorySize) this.memory.shift();

        if (this.memory.length >= this.batchSize) {
          const batch = this.memory.slice(-this.batchSize);
          const states = tf.tensor2d(batch.map((m) => m.state));
          const nextStates = tf.tensor2d(batch.map((m) => m.nextState));
          const rewards = batch.map((m) => m.reward);
          const actions = batch.map((m) => m.action);
          const dones = batch.map((m) => m.done);

          const qValues = this.model.predict(states) as tf.Tensor;
          const nextQValues = this.model.predict(nextStates) as tf.Tensor;
          const qValuesArray = await qValues.array();
          const nextQValuesArray = await nextQValues.array();

          const targets = qValuesArray.map((q, idx) => {
            const maxNextQ = Math.max(...nextQValuesArray[idx]);
            return dones[idx] ? rewards[idx] : rewards[idx] + this.gamma * maxNextQ;
          });

          const updatedQValues = qValuesArray.map((q, idx) => {
            q[actions[idx]] = targets[idx];
            return q;
          });

          await this.model.fit(states, tf.tensor2d(updatedQValues), {
            epochs: 1,
            batchSize: this.batchSize,
            verbose: 0,
          });

          states.dispose();
          nextStates.dispose();
          qValues.dispose();
          nextQValues.dispose();
        }
      }

      this.epsilon = Math.max(this.epsilonMin, this.epsilon * this.epsilonDecay);
      logInfoAggregated('DQN_TRAINER', `Trained model, epsilon: ${this.epsilon}`);
    } catch (error) {
      logErrorAggregated('DQN_TRAINER', `Training failed: ${error.message}`);
    }
  }

  private async getBestAction(state: number[]): Promise<number> {
    const stateTensor = tf.tensor2d([state]);
    const qValues = this.model.predict(stateTensor) as tf.Tensor;
    const qValuesArray = await qValues.array();
    stateTensor.dispose();
    qValues.dispose();
    return qValuesArray[0].indexOf(Math.max(...qValuesArray[0]));
  }

  async predict(ticker: string, signal: NewsSignal): Promise<number> {
    try {
      const state = this.getState(signal);
      const action = await this.getBestAction(state);
      logInfoAggregated('DQN_TRAINER', `Predicted action for ${ticker}: ${['buy', 'sell', 'hold'][action]}`);
      return action;
    } catch (error) {
      logErrorAggregated('DQN_TRAINER', `Prediction failed for ${ticker}: ${error.message}`);
      return 2; // Default to hold
    }
  }

  async saveModel(): Promise<void> {
    try {
      const modelJson = await this.model.toJSON();
      await this.redisClient.set('dqn_model', JSON.stringify(modelJson));
      logInfoAggregated('DQN_TRAINER', 'Model saved to Redis');
    } catch (error) {
      logErrorAggregated('DQN_TRAINER', `Failed to save model: ${error.message}`);
    }
  }

  async loadModel(): Promise<void> {
    try {
      const modelJson = await this.redisClient.get('dqn_model');
      if (modelJson) {
        const parsed = JSON.parse(modelJson);
        this.model = await tf.models.modelFromJSON(parsed);
        this.model.compile({
          optimizer: tf.train.adam(this.learningRate),
          loss: 'meanSquaredError',
        });
        logInfoAggregated('DQN_TRAINER', 'Model loaded from Redis');
      }
    } catch (error) {
      logErrorAggregated('DQN_TRAINER', `Failed to load model: ${error.message}`);
    }
  }
}

export default DQNTrainer;
