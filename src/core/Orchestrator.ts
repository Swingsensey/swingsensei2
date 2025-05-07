import Redis from 'ioredis';
import { Jupiter } from '@jup-ag/api';
import FilterGuard from './FilterGuard';
import { logInfoAggregated, logErrorAggregated, tradeSuccess, tradeFailure } from './SystemGuard';
import { queryDeepSeek, queryOpenAI } from './LearnMaster';
import { retry } from '../utils/utils';
import { Token, Trade, Wallet } from '../utils/types';
import { connectDB } from '../db/mongo';

const redisClient = new Redis(process.env.REDIS_URL!);
const jupiter = new Jupiter({ basePath: 'https://quote-api.jup.ag' });

class Orchestrator {
  private filterGuard: FilterGuard;
  private wallets: Wallet[] = [{ walletId: 'wallet1', balance: 1000, type: 'trading' }];

  constructor() {
    this.filterGuard = new FilterGuard();
    this.subscribeToSignals();
  }

  async loadApiSources(): Promise<void> {
    // Placeholder: Load api_sources.json dynamically if needed
    logInfoAggregated('ORCHESTRATOR', 'API sources loaded');
  }

  async fetchAndValidateTokens(): Promise<Token[]> {
    const tokens = JSON.parse((await redisClient.get('tokens:gmgn')) || '[]');
    const validated = await this.filterGuard.validate(tokens);
    logInfoAggregated('ORCHESTRATOR', `Validated ${validated.length} tokens`);
    return validated;
  }

  async processSignals(tokens: Token[], totalCapital: number): Promise<Trade[]> {
    const trades: Trade[] = [];
    for (const token of tokens) {
      const signals = await redisClient.lrange(`signals:${token.ticker}`, 0, -1);
      if (signals.length > 1) {
        await redisClient.publish('signals:conflicts', JSON.stringify({ ticker: token.ticker, signals }));
        const decision = await redisClient.blpop('arbitration:decisions', 10);
        if (decision) trades.push(JSON.parse(decision[1]));
      } else if (signals.length === 1) {
        const trade = JSON.parse(signals[0]);
        const validatedTrade = await this.validateTrade(trade);
        if (validatedTrade) trades.push(validatedTrade);
      }
    }
    for (const trade of trades) {
      await this.executeTrade(trade);
      await redisClient.publish('trades:executed', JSON.stringify(trade));
    }
    logInfoAggregated('ORCHESTRATOR', `Processed ${trades.length} trades`);
    return trades;
  }

  async validateTrade(trade: Trade): Promise<Trade | null> {
    try {
      const prompt = `Validate trade: ${JSON.stringify(trade)}`;
      const [deepseek, openai] = await Promise.all([
        retry(() => queryDeepSeek(prompt), { retries: 3 }),
        retry(() => queryOpenAI(prompt), { retries: 3 }),
      ]);
      const valid = JSON.parse(deepseek).valid && JSON.parse(openai).valid;
      if (!valid) {
        logErrorAggregated('ORCHESTRATOR', `Trade validation failed: ${trade.ticker}`);
        return null;
      }
      return trade;
    } catch (error) {
      logErrorAggregated('ORCHESTRATOR', `Trade validation error: ${error.message}`);
      return null;
    }
  }

  async executeTrade(trade: Trade): Promise<void> {
    try {
      const wallet = this.wallets.find(w => w.walletId === trade.walletId);
      if (!wallet || wallet.balance < trade.positionSize) {
        throw new Error('Insufficient balance');
      }
      const quote = await jupiter.quote({
        inputMint: 'SOL',
        outputMint: trade.ticker,
        amount: trade.positionSize,
      });
      const swap = await jupiter.swap({
        quoteResponse: quote,
        userPublicKey: process.env.PRIVATE_KEY!,
      });
      wallet.balance -= trade.positionSize;
      trade.roi = ((trade.price - quote.inAmount) / quote.inAmount) * 100;
      const db = await connectDB();
      await db.collection('trades').insertOne(trade);
      tradeSuccess.inc({ filter: 'SwingSniper', ticker: trade.ticker });
      logInfoAggregated('ORCHESTRATOR', `Executed trade: ${trade.ticker} ${trade.action}`);
      await this.reinvest(trade);
    } catch (error) {
      tradeFailure.inc({ filter: 'SwingSniper', error: error.message });
      logErrorAggregated('ORCHESTRATOR', `Trade execution failed: ${error.message}`);
    }
  }

  async manageWallets(): Promise<void> {
    const totalBalance = this.wallets.reduce((sum, w) => sum + w.balance, 0);
    if (totalBalance >= 5000 && this.wallets.length < 2) {
      this.wallets.push({ walletId: 'wallet2', balance: totalBalance / 2, type: 'trading' });
      this.wallets[0].balance /= 2;
      await redisClient.publish('wallets:updated', JSON.stringify(this.wallets));
      await axios.post(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
        chat_id: process.env.TELEGRAM_CHAT_ID,
        text: `New wallet created: wallet2, balance: ${totalBalance / 2}`,
      });
      logInfoAggregated('ORCHESTRATOR', 'Created new wallet');
    }
  }

  async reinvest(trade: Trade): Promise<void> {
    const totalBalance = this.wallets.reduce((sum, w) => sum + w.balance, 0);
    let reinvestPercent = 1;
    if (totalBalance >= 2000 && totalBalance < 5000) reinvestPercent = 0.75;
    else if (totalBalance >= 5000) reinvestPercent = 0.6;
    const reinvestAmount = trade.roi * trade.positionSize * reinvestPercent;
    const bankAmount = trade.roi * trade.positionSize * (1 - reinvestPercent);
    const tradingWallet = this.wallets.find(w => w.type === 'trading');
    const bankWallet = this.wallets.find(w => w.type === 'bank') || { walletId: 'bank1', balance: 0, type: 'bank' };
    if (tradingWallet) tradingWallet.balance += reinvestAmount;
    if (bankAmount > 0) {
      bankWallet.balance += bankAmount;
      if (!this.wallets.includes(bankWallet)) this.wallets.push(bankWallet);
    }
    const db = await connectDB();
    await db.collection('wallets').insertMany(this.wallets);
    await redisClient.publish('wallets:updated', JSON.stringify(this.wallets));
    logInfoAggregated('ORCHESTRATOR', `Reinvested ${reinvestAmount}, banked ${bankAmount}`);
  }

  private async subscribeToSignals(): Promise<void> {
    redisClient.subscribe('signals:new', (err, count) => {
      if (err) logErrorAggregated('ORCHESTRATOR', `Subscription failed: ${err.message}`);
      else logInfoAggregated('ORCHESTRATOR', `Subscribed to ${count} channels`);
    });
    redisClient.on('message', async (channel, message) => {
      if (channel === 'signals:new') {
        const trade = JSON.parse(message);
        const validatedTrade = await this.validateTrade(trade);
        if (validatedTrade) await this.executeTrade(validatedTrade);
      }
    });
  }
}

export default Orchestrator;
