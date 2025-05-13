import Redis from 'ioredis';
import { Jupiter } from '@jup-ag/api';
import FilterGuard from './FilterGuard';
import { logInfo, logError, sendTelegramAlert } from './SystemGuard';
import { queryDeepSeek, queryOpenAI } from './LearnMaster';
import { retry, circuitBreaker } from '../utils/utils';
import { Token, Trade, Wallet, Signal } from '../types';
import { connectDB } from '../db/mongo';
import axios from 'axios';
import { register } from 'prom-client';
import { tradeSuccess, tradeFailure, telegramApiErrors, telegramSignalsProcessed, telegramCheckLatency } from '../utils/metrics';

const redisClient = new Redis(process.env.REDIS_URL!, {
  maxRetriesPerRequest: 3,
  connectTimeout: 10000,
});
const jupiter = new Jupiter({ basePath: 'https://quote-api.jup.ag/v6' });

interface TrailingStopConfig {
  maxPrice: number;
  stopLossPercent: number;
  nextFibonacciLevel: number;
}

class Orchestrator {
  private readonly filterGuard: FilterGuard;
  private readonly wallets: Wallet[];
  private readonly tradeExecutionBreaker = circuitBreaker(this.executeTrade.bind(this), {
    timeout: 5000,
    errorThreshold: 50,
    resetTimeout: 30000,
  });
  private readonly closeTradeBreaker = circuitBreaker(this.closeTrade.bind(this), {
    timeout: 5000,
    errorThreshold: 50,
    resetTimeout: 30000,
  });
  private readonly notifyTelegramBreaker = circuitBreaker(this.notifyTelegram.bind(this), {
    timeout: 3000,
    errorThreshold: 50,
    resetTimeout: 30000,
  });
  private readonly reinvestBreaker = circuitBreaker(this.reinvest.bind(this), {
    timeout: 5000,
    errorThreshold: 50,
    resetTimeout: 30000,
  });
  private trailingStops: Map<string, TrailingStopConfig> = new Map();

  constructor() {
    this.filterGuard = new FilterGuard();
    this.wallets = [{ walletId: 'wallet1', balance: 1000, type: 'trading' }];
    this.initialize();
  }

  private async initialize(): Promise<void> {
    await this.checkDependencies();
    await this.loadApiSources();
    this.subscribeToSignals();
  }

  private async checkDependencies(): Promise<void> {
    try {
      await redisClient.ping();
      logInfo('ORCHESTRATOR', 'Redis connection successful');
    } catch (error) {
      logError('ORCHESTRATOR', `Redis connection failed: ${(error as Error).message}`);
      throw new Error('Redis unavailable');
    }
    try {
      const db = await connectDB();
      await db.command({ ping: 1 });
      logInfo('ORCHESTRATOR', 'MongoDB connection successful');
    } catch (error) {
      logError('ORCHESTRATOR', `MongoDB connection failed: ${(error as Error).message}`);
      throw new Error('MongoDB unavailable');
    }
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

  private isValidSentimentSignal(signal: Signal): boolean {
    return !(signal.entryType === 'sentiment' && (!signal.socialScore || signal.socialScore < 0.8));
  }

  async coordinateAgents(signal: Signal): Promise<void> {
    if (signal.entryType === 'fibonacci') {
      await redisClient.lpush(`signals:tradesensei:high_priority`, JSON.stringify(signal));
      logInfo('ORCHESTRATOR', `Prioritized fibonacci signal for ${signal.ticker}`);
    } else {
      await redisClient.lpush(`signals:tradesensei:low_priority`, JSON.stringify(signal));
      logInfo('ORCHESTRATOR', `Sent ${signal.entryType} signal for ${signal.ticker}`);
    }
    telegramSignalsProcessed.inc({ ticker: signal.ticker });
  }

  async monitorFibonacciStrategy(): Promise<{ efficiency: number }> {
    try {
      const signalsCount = register.getSingleMetric('datahawk_signals_generated_total')?.get()?.values.find(v => v.labels.source === 'fibonacci')?.value || 0;
      const exitsCount = register.getSingleMetric('trades_fibonacci_exits_total')?.get()?.values.reduce((sum, v) => sum + v.value, 0) || 0;
      const efficiency = signalsCount > 0 ? exitsCount / signalsCount : 0;
      logInfo('ORCHESTRATOR', `Fibonacci strategy efficiency: ${(efficiency * 100).toFixed(2)}%`);
      await this.notifyTelegramBreaker.fire(`Fibonacci strategy efficiency: ${(efficiency * 100).toFixed(2)}%`);
      return { efficiency };
    } catch (error) {
      logError('ORCHESTRATOR', `Fibonacci strategy monitoring error: ${(error as Error).message}`);
      return { efficiency: 0 };
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
      const signal: Signal = JSON.parse(signals[0]);
      if ((signal.entryType === 'fibonacci' || signal.entryType === 'sentiment') && signal.action === 'buy' && this.isValidSentimentSignal(signal)) {
        const trade = this.createTradeFromSignal(signal, token);
        return this.validateTrade(trade);
      }
    }
    return null;
  }

  private createTradeFromSignal(signal: Signal, token: Token): Trade {
    return {
      ticker: signal.ticker,
      action: signal.action,
      positionSize: this.calculatePositionSize(token),
      price: token.price,
      walletId: this.wallets[0].walletId,
      timestamp: new Date().toISOString(),
      entryType: signal.entryType,
      fibonacciLevel: signal.fibonacciLevel || token.fibonacciLevels?.level_382 || 0,
    };
  }

  private calculatePositionSize(token: Token): number {
    const liquidity = token.liquidity || 100000;
    return Math.min(0.008 * liquidity, this.wallets[0].balance * 0.1);
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
      await this.setTrailingStop(trade);
      await this.reinvestBreaker.fire(trade);
      await this.notifyTelegramBreaker.fire(`Trade executed: ${trade.ticker} ${trade.action} at ${trade.price}, size: ${trade.positionSize}`);
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

  private async setTrailingStop(trade: Trade): Promise<void> {
    const token = JSON.parse((await redisClient.get(`tokens:${trade.ticker}`)) || '{}');
    const fibonacciLevels = token.fibonacciLevels || {};
    const nextFibonacciLevel = this.getNextFibonacciLevel(trade.fibonacciLevel, fibonacciLevels);
    this.trailingStops.set(trade.ticker, {
      maxPrice: trade.price,
      stopLossPercent: 0.15,
      nextFibonacciLevel,
    });
    this.monitorTrailingStop(trade);
  }

  private getNextFibonacciLevel(currentLevel: number, levels: Token['fibonacciLevels']): number {
    if (!levels) return 0;
    const fibLevels = [levels.level_236, levels.level_382, levels.level_500, levels.level_618];
    const currentIndex = fibLevels.indexOf(currentLevel);
    return currentIndex < fibLevels.length - 1 ? fibLevels[currentIndex + 1] : levels.level_618;
  }

  private async monitorTrailingStop(trade: Trade): Promise<void> {
    const stopConfig = this.trailingStops.get(trade.ticker);
    if (!stopConfig) return;
    try {
      const token = JSON.parse((await redisClient.get(`tokens:${trade.ticker}`)) || '{}');
      const currentPrice = token.price || trade.price;
      if (currentPrice > stopConfig.maxPrice) {
        stopConfig.maxPrice = currentPrice;
        this.trailingStops.set(trade.ticker, stopConfig);
      }
      const stopPrice = stopConfig.maxPrice * (1 - stopConfig.stopLossPercent);
      const exitReason = currentPrice <= stopPrice ? 'trailingStop' : currentPrice <= stopConfig.nextFibonacciLevel ? 'fibonacciLevel' : null;
      if (exitReason) {
        await this.closeTradeBreaker.fire(trade, exitReason);
        this.trailingStops.delete(trade.ticker);
      }
    } catch (error) {
      logError('ORCHESTRATOR', `Trailing stop monitor error: ${(error as Error).message}`);
    }
  }

  private async closeTrade(trade: Trade, exitReason: 'trailingStop' | 'fibonacciLevel'): Promise<void> {
    try {
      const token = JSON.parse((await redisClient.get(`tokens:${trade.ticker}`)) || '{}');
      const quote = await jupiter.quote({
        inputMint: trade.ticker,
        outputMint: 'SOL',
        amount: trade.positionSize * 1e9,
        slippageBps: 50,
      });
      const swap = await jupiter.swap({
        quoteResponse: quote,
        userPublicKey: process.env.WALLET_PUBLIC_KEY!,
        wrapAndUnwrapSol: true,
      });
      const wallet = this.wallets.find((w) => w.walletId === trade.walletId)!;
      wallet.balance += quote.outAmount / 1e9;
      trade.exitReason = exitReason;
      trade.roi = ((quote.outAmount / 1e9 - trade.price) / trade.price) * 100;
      const db = await connectDB();
      await db.collection('trades').updateOne({ ticker: trade.ticker, timestamp: trade.timestamp }, { $set: trade });
      await redisClient.publish('trades:executed', JSON.stringify(trade));
      await this.notifyTelegramBreaker.fire(`Trade closed: ${trade.ticker}, exit: ${exitReason}, ROI: ${trade.roi.toFixed(2)}%`);
      logInfo('ORCHESTRATOR', `Closed trade: ${trade.ticker} with ${exitReason}`);
    } catch (error) {
      logError('ORCHESTRATOR', `Close trade error: ${(error as Error).message}`);
      throw error;
    }
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
    await this.notifyTelegramBreaker.fire(`New wallet created: wallet2, balance: ${newWalletBalance}`);
    logInfo('ORCHESTRATOR', 'Created new wallet');
  }

  private async notifyTelegram(message: string): Promise<void> {
    const startTime = Date.now();
    try {
      await sendTelegramAlert(message, process.env.TELEGRAM_CHAT_ID!);
      telegramCheckLatency.observe({ ticker: '' }, (Date.now() - startTime) / 1000);
    } catch (error) {
      telegramApiErrors.inc({ ticker: '' });
      logError('ORCHESTRATOR', `Telegram notification error: ${(error as Error).message}`);
      throw error;
    }
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
      throw error;
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
      const signal: Signal = JSON.parse(message);
      if ((signal.entryType === 'fibonacci' || signal.entryType === 'sentiment') && signal.action === 'buy' && this.isValidSentimentSignal(signal)) {
        const token = JSON.parse((await redisClient.get(`tokens:${signal.ticker}`)) || '{}');
        const trade = this.createTradeFromSignal(signal, token);
        const validatedTrade = await this.validateTrade(trade);
        if (validatedTrade) {
          await this.coordinateAgents(signal);
          await this.tradeExecutionBreaker.fire(validatedTrade);
        }
      }
    });
  }
}

export default Orchestrator;
