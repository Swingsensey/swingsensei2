import Redis from 'ioredis';
import { tf, Tensor } from '@tensorflow/tfjs-node';
import FilterGuard from './FilterGuard';
import { logInfoAggregated, logErrorAggregated, partialExits } from './SystemGuard';
import { queryGemini, queryDeepSeek, queryOpenAI } from './LearnMaster';
import { retry } from '../utils/utils';
import { Token, Trade } from '../utils/types';

const redisClient = new Redis(process.env.REDIS_URL!);

interface DQNConfig {
  learningRate: number;
  discountFactor: number;
  epsilon: number;
}

class TradeSensei {
  private filterGuard: FilterGuard;
  private dqnModel: tf.Sequential;
  private config: DQNConfig = { learningRate: 0.001, discountFactor: 0.95, epsilon: 0.1 };

  constructor() {
    this.filterGuard = new FilterGuard();
    this.dqnModel = this.initializeDQN();
    this.subscribeToChannels();
  }

  private initializeDQN(): tf.Sequential {
    const model = tf.sequential();
    model.add(tf.layers.dense({ units: 128, activation: 'relu', inputShape: [10] }));
    model.add(tf.layers.dense({ units: 64, activation: 'relu' }));
    model.add(tf.layers.dense({ units: 3, activation: 'linear' })); // buy, hold, sell
    model.compile({ optimizer: tf.train.adam(this.config.learningRate), loss: 'meanSquaredError' });
    return model;
  }

  async trainDQN(trades: Trade[]): Promise<void> {
    const states = trades.map(t => [
      t.price,
      t.volume,
      t.marketCap,
      t.liquidity,
      t.holders,
      t.socialPosts,
      t.whaleActivity,
      t.burnedLP,
      t.transactions,
      t.priceChange,
    ]);
    const actions = trades.map(t => (t.action === 'buy' ? 0 : t.action === 'hold' ? 1 : 2));
    const rewards = trades.map(t => t.roi * t.positionSize / t.balance);
    const inputs = tf.tensor2d(states);
    const targets = tf.tensor2d(actions.map((a, i) => {
      const target = Array(3).fill(0);
      target[a] = rewards[i];
      return target;
    }));
    await this.dqnModel.fit(inputs, targets, { epochs: 10, batchSize: 32 });
    await redisClient.publish('models:updated', JSON.stringify({ model: 'DQN', timestamp: Date.now() }));
    logInfoAggregated('TRADE_SENSEI', 'DQN trained');
    inputs.dispose();
    targets.dispose();
  }

  async generateSignal(token: Token): Promise<Trade | null> {
    try {
      const state = tf.tensor2d([[
        token.price,
        token.volume,
        token.marketCap,
        token.liquidity,
        token.holders,
        token.socialPosts,
        token.whaleActivity,
        token.burnedLP,
        token.transactions,
        token.priceChange,
      ]]);
      const prediction = this.dqnModel.predict(state) as Tensor;
      const actionIndex = (await prediction.argMax(-1).data())[0];
      const confidence = (await prediction.max(-1).data())[0];
      state.dispose();
      prediction.dispose();
      if (confidence < 0.8) return null;
      const action = actionIndex === 0 ? 'buy' : actionIndex === 1 ? 'hold' : 'sell';
      const trade: Trade = {
        ticker: token.ticker,
        action,
        price: token.price,
        positionSize: token.liquidity * (0.1 + Math.random() * 0.7), // 0.1–0.8%
        balance: 1000, // Paper trading
        roi: 0,
        timestamp: Date.now(),
        walletId: 'wallet1',
      };
      await redisClient.publish('signals:new', JSON.stringify(trade));
      logInfoAggregated('TRADE_SENSEI', `Generated signal: ${trade.ticker} ${trade.action}`);
      return trade;
    } catch (error) {
      logErrorAggregated('TRADE_SENSEI', `Signal generation failed: ${error.message}`);
      return null;
    }
  }

  async processWebhook(webhook: any): Promise<Trade | null> {
    const token: Token = {
      ticker: webhook.ticker,
      price: webhook.price,
      volume: webhook.volume,
      marketCap: webhook.marketCap,
      liquidity: webhook.liquidity,
      holders: webhook.holders,
      socialPosts: webhook.socialPosts,
      whaleActivity: webhook.whaleActivity,
      burnedLP: webhook.burnedLP,
      transactions: webhook.transactions,
      priceChange: webhook.priceChange,
      fibLevel: webhook.fibLevel,
    };
    const filtered = await this.filterGuard.validate([token]);
    if (filtered.length === 0) return null;
    const trade = await this.generateSignal(filtered[0]);
    if (trade) {
      await redisClient.publish('tradingview:webhooks', JSON.stringify(trade));
      logInfoAggregated('TRADE_SENSEI', `Processed webhook for ${trade.ticker}`);
    }
    return trade;
  }

  async applyPartialExit(trade: Trade, currentPrice: number): Promise<Trade | null> {
    const profitPercent = ((currentPrice - trade.price) / trade.price) * 100;
    let partialSize = 0;
    if (profitPercent >= 50 && trade.positionSize > 0) partialSize = trade.positionSize * 0.3;
    else if (profitPercent >= 100 && trade.positionSize > 0) partialSize = trade.positionSize * 0.3;
    if (partialSize > 0) {
      const partialTrade: Trade = {
        ...trade,
        positionSize: partialSize,
        action: 'sell',
        price: currentPrice,
        roi: profitPercent,
        timestamp: Date.now(),
      };
      await redisClient.publish('trade:partial_exit', JSON.stringify(partialTrade));
      partialExits.inc({ ticker: trade.ticker, percentage: partialSize / trade.positionSize });
      trade.positionSize -= partialSize;
      logInfoAggregated('TRADE_SENSEI', `Partial exit: ${trade.ticker}, ${partialSize}`);
      return trade.positionSize > 0 ? trade : null;
    }
    return trade;
  }

  async applyTrailingStop(trade: Trade, currentPrice: number): Promise<Trade | null> {
    const atr = 2; // Placeholder ATR*1.5–2.5
    const stopPrice = trade.price * (1 - 0.15); // Trailing loss 15–25%
    if (currentPrice < stopPrice) {
      const exitTrade: Trade = {
        ...trade,
        action: 'sell',
        price: currentPrice,
        roi: ((currentPrice - trade.price) / trade.price) * 100,
        timestamp: Date.now(),
      };
      await redisClient.publish('trade:partial_exit', JSON.stringify(exitTrade));
      logInfoAggregated('TRADE_SENSEI', `Trailing stop: ${trade.ticker}, sold at ${currentPrice}`);
      return null;
    }
    return trade;
  }

  async arbitrateSignals(signals: Trade[]): Promise<Trade | null> {
    if (signals.length <= 1) return signals[0] || null;
    try {
      const prompt = `Arbitrate trading signals for ${signals[0].ticker}: ${JSON.stringify(signals)}`;
      const [gemini, deepseek, openai] = await Promise.all([
        retry(() => queryGemini(prompt), { retries: 3 }),
        retry(() => queryDeepSeek(prompt), { retries: 3 }),
        retry(() => queryOpenAI(prompt), { retries: 3 }),
      ]);
      const votes = [gemini, deepseek, openai].map(res => JSON.parse(res).action);
      const majority = votes.sort((a, b) =>
        votes.filter(v => v === a).length - votes.filter(v => v === b).length
      ).pop();
      const decision = signals.find(s => s.action === majority) || signals[0];
      await redisClient.publish('arbitration:decisions', JSON.stringify(decision));
      logInfoAggregated('TRADE_SENSEI', `Arbitrated signal: ${decision.ticker} ${decision.action}`);
      return decision;
    } catch (error) {
      logErrorAggregated('TRADE_SENSEI', `Arbitration failed: ${error.message}`);
      return signals[0];
    }
  }

  private async subscribeToChannels(): Promise<void> {
    redisClient.subscribe('tokens:new', 'news:signals', 'tradingview:webhooks', (err, count) => {
      if (err) logErrorAggregated('TRADE_SENSEI', `Subscription failed: ${err.message}`);
      else logInfoAggregated('TRADE_SENSEI', `Subscribed to ${count} channels`);
    });
    redisClient.on('message', async (channel, message) => {
      if (channel === 'tokens:new') {
        const tokens = JSON.parse(message);
        const filtered = await this.filterGuard.applyTrending5min(tokens);
        for (const token of filtered) await this.generateSignal(token);
      } else if (channel === 'news:signals') {
        const signals = JSON.parse(message);
        for (const signal of signals) {
          if (signal.sentimentScore > 0.7) {
            const token = { ticker: signal.ticker, price: 0, volume: 0, marketCap: 0, liquidity: 0, holders: 0, socialPosts: 0, whaleActivity: 0, burnedLP: 0, transactions: 0, priceChange: 0, fibLevel: 0 }; // Placeholder
            await this.generateSignal(token);
          }
        }
      } else if (channel === 'tradingview:webhooks') {
        const webhook = JSON.parse(message);
        await this.processWebhook(webhook);
      }
    });
  }
}

export default TradeSensei;
