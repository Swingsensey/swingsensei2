import Redis from 'ioredis';
import { Jupiter } from '@jup-ag/api';
import FilterGuard from './FilterGuard';
import { logInfo, logError } from './SystemGuard';
import { queryDeepSeek, queryOpenAI } from './LearnMaster';
import { retry, circuitBreaker } from '../utils/utils';
import { Token, Trade, Wallet } from '../utils/types';
import { connectDB } from '../db/mongo';
import axios from 'axios';
import { Counter } from 'prometheus-client';

const tradeSuccess = new Counter({ name: 'trade_success', help: 'Successful trades', labelNames: ['filter', 'ticker'] });
const tradeFailure = new Counter({ name: 'trade_failure', help: 'Failed trades', labelNames: ['filter', 'error'] });

const redisClient = new Redis(process.env.REDIS_URL!, {
  maxRetriesPerRequest: 3,
  connectTimeout: 10000,
});
const jupiter = new Jupiter({ basePath: 'https://quote-api.jup.ag/v6' });

interface TradeValidationResult {
  isValid: boolean;
  error?: string;
}

class Orchestrator {
  private readonly filterGuard: FilterGuard;
  private readonly wallets: Wallet[];
  private readonly tradeExecutionBreaker = circuitBreaker(this.executeTrade.bind(this), {
    timeout: 5000,
    errorThreshold: 50,
    resetTimeout: 30000,
  });

  constructor() {
    this.filterGuard = new FilterGuard();
    this.wallets = [{ walletId: 'wallet1', balance: 1000, type: 'trading' }];
    this.initialize();
  }

  private async initialize(): Promise<void> {
    await this.loadApiSources();
    this.subscribeToSignals();
  }

  private async loadApiSources(): Promise<void> {
    try {
      const cachedSources = await redisClient.get('api:sources');
      if (cachedSources) {
        logInfo('ORCHESTRATOR', 'API sources loaded from Redis');
        return;
      }
      const fs = await import('fs/promises');
      const sources = JSON.parse(await fs.readFile('api_sources.json', 'utf-8'));
      await redisClient.set('api:sources', JSON.stringify(sources), 'EX', 3600);
      logInfo('ORCHESTRATOR', 'API sources loaded from file');
    } catch (error) {
      logError('ORCHESTRATOR', `Failed to load API sources: ${(error as Error).message}`);
    }
  }

  async fetchTokens(): Promise<Token[]> {
    try {
      const tokens = JSON.parse((await redisClient.get('tokens:gmgn')) || '[]');
      const validatedTokens = await this.filterGuard.validate(tokens);
      logInfo('ORCHESTRATOR', `Validated ${validatedTokens.length} tokens`);
      return validatedTokens;
    } catch (error) {
      logError('ORCHESTRATOR', `Token fetch/validation failed: ${(error as Error).message}`);
      return [];
    }
  }

  async processSignals(tokens: Token[]): Promise<Trade[]> {
    const trades: Trade[] = [];
    for (const token of tokens) {
      const trade = await this.resolveTokenSignals(token);
      if (trade) trades.push(trade);
    }
    await this.executeTrades(trades);
    logInfo('ORCHESTRATOR', `Processed ${trades.length} trades`);
    return trades;
  }

  private async resolveTokenSignals(token: Token): Promise<Trade | null> {
    const signals = await redisClient.lrange(`signals:${token.ticker}`, 0, -1);
    if (signals.length > 1) {
      return this.handleSignalConflict(token.ticker, signals);
    }
    if (signals.length === 1) {
      const trade = JSON.parse(signals[0]);
      return this.validateTrade(trade);
    }
    return null;
  }

  private async handleSignalConflict(ticker: string, signals: string[]): Promise<Trade | null> {
    await redisClient.publish('signals:conflicts', JSON.stringify({ ticker, signals }));
    const decision = await redisClient.blpop('arbitration:decisions', 10);
    return decision ? JSON.parse(decision[1]) : null;
  }

  private async validateTrade(trade: Trade): Promise<Trade | null> {
    try {
      const prompt = `Validate trade for SwingSensei: ${JSON.stringify(trade)}`;
      const [deepSeekResult, openAIResult] = await Promise.all([
        retry(() => queryDeepSeek(prompt), { retries: 3, delay: 1000 }),
        retry(() => queryOpenAI(prompt), { retries: 3, delay: 1000 }),
      ]);
      const deepSeekValid = JSON.parse(deepSeekResult).valid;
      const openAIValid = JSON.parse(openAIResult).valid;
      if (!deepSeekValid || !openAIValid) {
        logError('ORCHESTRATOR', `Trade validation failed: ${trade.ticker}`);
        return null;
      }
      return trade;
    } catch (error) {
      logError('ORCHESTRATOR', `Trade validation error: ${(error as Error).message}`);
      return null;
    }
  }

  private async executeTrades(trades: Trade[]): Promise<void> {
    for (const trade of trades) {
      await this.tradeExecutionBreaker.fire(trade);
      await redisClient.publish('trades:executed', JSON.stringify(trade));
    }
  }

  private async executeTrade(trade: Trade): Promise<void> {
    const wallet = this.wallets.find((w) => w.walletId === trade.walletId);
    if (!wallet || wallet.balance < trade.positionSize) {
      logError('ORCHESTRATOR', `Insufficient balance or wallet not found: ${trade.ticker}`);
      tradeFailure.inc({ filter: 'SwingSniper', error: 'Insufficient balance' });
      return;
    }
    try {
      const quote = await this.getTradeQuote(trade);
      const swap = await this.performSwap(quote, trade);
      await this.updateWalletAndLogTrade(trade, wallet, quote);
      await this.reinvest(trade);
    } catch (error) {
      tradeFailure.inc({ filter: 'SwingSniper', error: (error as Error).message });
      logError('ORCHESTRATOR', `Trade execution failed: ${(error as Error).message}`);
    }
  }

  private async getTradeQuote(trade: Trade): Promise<any> {
    return jupiter.quote({
      inputMint: 'SOL',
      outputMint: trade.ticker,
      amount: trade.positionSize * 1e9,
      slippageBps: 50,
    });
  }

  private async performSwap(quote: any, trade: Trade): Promise<any> {
    return jupiter.swap({
      quoteResponse: quote,
      userPublicKey: process.env.WALLET_PUBLIC_KEY!,
      wrapAndUnwrapSol: true,
    });
  }

  private async updateWalletAndLogTrade(trade: Trade, wallet: Wallet, quote: any): Promise<void> {
    wallet.balance -= trade.positionSize;
    trade.roi = ((trade.price - quote.inAmount / 1e9) / (quote.inAmount / 1e9)) * 100;
    const db = await connectDB();
    await db.collection('trades').insertOne({ ...trade, timestamp: new Date() });
    tradeSuccess.inc({ filter: 'SwingSniper', ticker: trade.ticker });
    logInfo('ORCHESTRATOR', `Executed trade: ${trade.ticker} ${trade.action}`);
  }

  async manageWallets(): Promise<void> {
    try {
      const totalBalance = this.calculateTotalBalance();
      if (totalBalance >= 5000 && this.wallets.length < 2) {
        await this.createNewWallet(totalBalance);
      }
    } catch (error) {
      logError('ORCHESTRATOR', `Wallet management failed: ${(error as Error).message}`);
    }
  }

  private calculateTotalBalance(): number {
    return this.wallets.reduce((sum, wallet) => sum + wallet.balance, 0);
  }

  private async createNewWallet(totalBalance: number): Promise<void> {
    const newWalletBalance = totalBalance / 2;
    this.wallets.push({ walletId: 'wallet2', balance: newWalletBalance, type: 'trading' });
    this.wallets[0].balance = newWalletBalance;
    await redisClient.publish('wallets:updated', JSON.stringify(this.wallets));
    await this.notifyTelegram(`Новый кошелек создан: wallet2, баланс: ${newWalletBalance}`);
    logInfo('ORCHESTRATOR', 'Created new wallet');
  }

  private async notifyTelegram(message: string): Promise<void> {
    await axios.post(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      chat_id: process.env.TELEGRAM_CHAT_ID,
      text: message,
    });
  }

  private async reinvest(trade: Trade): Promise<void> {
    try {
      const totalBalance = this.calculateTotalBalance();
      const reinvestPercent = this.determineReinvestPercent(totalBalance);
      const reinvestAmount = trade.roi * trade.positionSize * reinvestPercent;
      const bankAmount = trade.roi * trade.positionSize * (1 - reinvestPercent);
      await this.updateWalletsForReinvestment(reinvestAmount, bankAmount);
      await this.persistWallets();
      logInfo('ORCHESTRATOR', `Reinvested ${reinvestAmount}, banked ${bankAmount}`);
    } catch (error) {
      logError('ORCHESTRATOR', `Reinvestment failed: ${(error as Error).message}`);
    }
  }

  private determineReinvestPercent(totalBalance: number): number {
    if (totalBalance >= 2000 && totalBalance < 5000) return 0.75;
    if (totalBalance >= 5000) return 0.6;
    return 1;
  }

  private async updateWalletsForReinvestment(reinvestAmount: number, bankAmount: number): Promise<void> {
    const tradingWallet = this.wallets.find((w) => w.type === 'trading');
    let bankWallet = this.wallets.find((w) => w.type === 'bank');
    if (!bankWallet && bankAmount > 0) {
      bankWallet = { walletId: 'bank1', balance: 0, type: 'bank' };
      this.wallets.push(bankWallet);
    }
    if (tradingWallet) tradingWallet.balance += reinvestAmount;
    if (bankWallet && bankAmount > 0) bankWallet.balance += bankAmount;
  }

  private async persistWallets(): Promise<void> {
    const db = await connectDB();
    await db.collection('wallets').deleteMany({});
    await db.collection('wallets').insertMany(this.wallets);
    await redisClient.publish('wallets:updated', JSON.stringify(this.wallets));
  }

  private subscribeToSignals(): void {
    redisClient.subscribe('signals:new', (err, count) => {
      if (err) {
        logError('ORCHESTRATOR', `Subscription failed: ${err.message}`);
        return;
      }
      logInfo('ORCHESTRATOR', `Subscribed to ${count} channels`);
    });
    redisClient.on('message', async (channel, message) => {
      if (channel !== 'signals:new') return;
      const trade = JSON.parse(message);
      const validatedTrade = await this.validateTrade(trade);
      if (validatedTrade) await this.tradeExecutionBreaker.fire(validatedTrade);
    });
  }
}

export default Orchestrator;
