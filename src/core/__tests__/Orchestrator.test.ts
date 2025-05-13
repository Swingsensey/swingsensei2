import { mocked } from 'jest-mock';
import Redis from 'ioredis';
import { Jupiter } from '@jup-ag/api';
import Orchestrator from '../Orchestrator';
import FilterGuard from '../FilterGuard';
import { logInfo, logError, sendTelegramAlert } from '../SystemGuard';
import { queryDeepSeek, queryOpenAI } from '../LearnMaster';
import { connectDB } from '../db/mongo';
import { Token, Trade, Signal } from '../types';
import { register } from 'prom-client';
import { telegramSignalsProcessed } from '../utils/metrics';

jest.mock('ioredis');
jest.mock('@jup-ag/api');
jest.mock('../FilterGuard');
jest.mock('../SystemGuard');
jest.mock('../LearnMaster');
jest.mock('../db/mongo');
jest.mock('axios');

describe('Orchestrator', () => {
  let orchestrator: Orchestrator;
  let mockRedis: jest.Mocked<Redis>;
  let mockJupiter: jest.Mocked<Jupiter>;

  beforeEach(() => {
    mockRedis = new Redis() as jest.Mocked<Redis>;
    mockJupiter = new Jupiter({ basePath: 'https://quote-api.jup.ag/v6' }) as jest.Mocked<Jupiter>;
    (FilterGuard as jest.Mock).mockImplementation(() => ({
      validate: jest.fn().mockResolvedValue([]),
    }));
    (connectDB as jest.Mock).mockResolvedValue({
      command: jest.fn().mockResolvedValue({}),
      collection: jest.fn().mockReturnValue({
        insertOne: jest.fn().mockResolvedValue({}),
        updateOne: jest.fn().mockResolvedValue({}),
        deleteMany: jest.fn().mockResolvedValue({}),
        insertMany: jest.fn().mockResolvedValue({}),
      }),
    });
    orchestrator = new Orchestrator();
    register.clear();
    jest.clearAllMocks();
  });

  it('creates trade from fibonacci signal', async () => {
    const signal: Signal = {
      ticker: 'SOL',
      action: 'buy',
      confidence: 0.9,
      source: 'TradeSensei',
      timestamp: new Date().toISOString(),
      entryType: 'fibonacci',
      fibonacciLevel: 100,
    };
    const token: Token = {
      ticker: 'SOL',
      price: 150,
      volume: 1000,
      marketCap: 1000000,
      liquidity: 500000,
      priceChange: 5,
      fibonacciLevels: { level_236: 90, level_382: 100, level_500: 120, level_618: 130, lastMin: 80, lastMax: 160 },
    };
    const trade = await orchestrator['createTradeFromSignal'](signal, token);
    expect(trade).toMatchObject({
      ticker: 'SOL',
      action: 'buy',
      positionSize: expect.any(Number),
      price: 150,
      walletId: 'wallet1',
      entryType: 'fibonacci',
      fibonacciLevel: 100,
    });
    expect(trade.positionSize).toBeLessThanOrEqual(4000);
  });

  it('validates trade with DeepSeek and OpenAI', async () => {
    const trade: Trade = {
      ticker: 'SOL',
      action: 'buy',
      positionSize: 100,
      price: 150,
      walletId: 'wallet1',
      timestamp: new Date().toISOString(),
      roi: 0,
      entryType: 'fibonacci',
      fibonacciLevel: 100,
    };
    mocked(queryDeepSeek).mockResolvedValue(JSON.stringify({ valid: true }));
    mocked(queryOpenAI).mockResolvedValue(JSON.stringify({ valid: true }));
    const result = await orchestrator['validateTrade'](trade);
    expect(result).toEqual(trade);
    expect(queryDeepSeek).toHaveBeenCalledWith(`Validate trade for SwingSensei: ${JSON.stringify(trade)}`);
    expect(queryOpenAI).toHaveBeenCalledWith(`Validate trade for SwingSensei: ${JSON.stringify(trade)}`);
  });

  it('sets trailing stop for fibonacci trade', async () => {
    const trade: Trade = {
      ticker: 'SOL',
      action: 'buy',
      positionSize: 100,
      price: 150,
      walletId: 'wallet1',
      timestamp: new Date().toISOString(),
      roi: 0,
      entryType: 'fibonacci',
      fibonacciLevel: 100,
    };
    mockRedis.get.mockResolvedValue(JSON.stringify({
      price: 150,
      fibonacciLevels: { level_382: 100, level_500: 120, level_618: 130, lastMin: 80, lastMax: 160 },
    }));
    await orchestrator['setTrailingStop'](trade);
    expect(orchestrator['trailingStops'].has('SOL')).toBe(true);
    expect(orchestrator['trailingStops'].get('SOL')).toMatchObject({
      maxPrice: 150,
      stopLossPercent: 0.15,
      nextFibonacciLevel: 120,
    });
  });

  it('closes trade on fibonacci level trigger', async () => {
    const trade: Trade = {
      ticker: 'SOL',
      action: 'buy',
      positionSize: 100,
      price: 150,
      walletId: 'wallet1',
      timestamp: new Date().toISOString(),
      roi: 0,
      entryType: 'fibonacci',
      fibonacciLevel: 100,
    };
    mockRedis.get.mockResolvedValue(JSON.stringify({ price: 90, fibonacciLevels: { level_382: 100, level_500: 120 } }));
    mockJupiter.quote.mockResolvedValue({ inAmount: 100 * 1e9, outAmount: 95 * 1e9 });
    mockJupiter.swap.mockResolvedValue({});
    orchestrator['trailingStops'].set('SOL', { maxPrice: 150, stopLossPercent: 0.15, nextFibonacciLevel: 120 });
    await orchestrator['monitorTrailingStop'](trade);
    expect(mockJupiter.swap).toHaveBeenCalled();
    expect(mockRedis.publish).toHaveBeenCalledWith('trades:executed', expect.stringContaining('"exitReason":"fibonacciLevel"'));
  });

  it('handles insufficient balance error', async () => {
    const trade: Trade = {
      ticker: 'SOL',
      action: 'buy',
      positionSize: 2000,
      price: 150,
      walletId: 'wallet1',
      timestamp: new Date().toISOString(),
      roi: 0,
      entryType: 'fibonacci',
      fibonacciLevel: 100,
    };
    await orchestrator['executeTrade'](trade);
    expect(logError).toHaveBeenCalledWith('ORCHESTRATOR', 'Insufficient balance or wallet not found: SOL');
  });

  it('monitors fibonacci strategy efficiency', async () => {
    register.getSingleMetric('datahawk_signals_generated_total')?.set({ source: 'fibonacci' }, 10);
    register.getSingleMetric('trades_fibonacci_exits_total')?.set({ ticker: 'SOL' }, 5);
    const result = await orchestrator.monitorFibonacciStrategy();
    expect(result.efficiency).toBe(0.5);
    expect(logInfo).toHaveBeenCalledWith('ORCHESTRATOR', 'Fibonacci strategy efficiency: 50.00%');
    expect(sendTelegramAlert).toHaveBeenCalledWith('Fibonacci strategy efficiency: 50.00%', expect.any(String));
  });

  it('coordinates fibonacci signals with high priority', async () => {
    const signal: Signal = {
      ticker: 'SOL',
      action: 'buy',
      confidence: 0.9,
      source: 'TradeSensei',
      timestamp: new Date().toISOString(),
      entryType: 'fibonacci',
      fibonacciLevel: 100,
    };
    await orchestrator.coordinateAgents(signal);
    expect(mockRedis.lpush).toHaveBeenCalledWith('signals:tradesensei:high_priority', JSON.stringify(signal));
    expect(logInfo).toHaveBeenCalledWith('ORCHESTRATOR', 'Prioritized fibonacci signal for SOL');
    expect(telegramSignalsProcessed.inc).toHaveBeenCalledWith({ ticker: 'SOL' });
  });

  it('coordinates non-fibonacci signals with low priority', async () => {
    const signal: Signal = {
      ticker: 'SOL',
      action: 'buy',
      confidence: 0.9,
      source: 'TradeSensei',
      timestamp: new Date().toISOString(),
      entryType: 'sentiment',
      socialScore: 0.9,
    };
    await orchestrator.coordinateAgents(signal);
    expect(mockRedis.lpush).toHaveBeenCalledWith('signals:tradesensei:low_priority', JSON.stringify(signal));
    expect(logInfo).toHaveBeenCalledWith('ORCHESTRATOR', 'Sent sentiment signal for SOL');
    expect(telegramSignalsProcessed.inc).toHaveBeenCalledWith({ ticker: 'SOL' });
  });

  it('checks Redis and MongoDB dependencies on initialize', async () => {
    mockRedis.ping.mockResolvedValue('PONG');
    await expect(orchestrator['checkDependencies']()).resolves.toBeUndefined();
    expect(mockRedis.ping).toHaveBeenCalled();
    expect(connectDB).toHaveBeenCalled();
    expect(logInfo).toHaveBeenCalledWith('ORCHESTRATOR', 'Redis connection successful');
    expect(logInfo).toHaveBeenCalledWith('ORCHESTRATOR', 'MongoDB connection successful');
  });

  it('handles circuit breaker failure in closeTrade', async () => {
    const trade: Trade = {
      ticker: 'SOL',
      action: 'buy',
      positionSize: 100,
      price: 150,
      walletId: 'wallet1',
      timestamp: new Date().toISOString(),
      roi: 0,
      entryType: 'fibonacci',
      fibonacciLevel: 100,
    };
    mockJupiter.quote.mockRejectedValue(new Error('API failure'));
    await expect(orchestrator['closeTradeBreaker'].fire(trade, 'fibonacciLevel')).rejects.toThrow('API failure');
    expect(logError).toHaveBeenCalledWith('ORCHESTRATOR', 'Close trade error: API failure');
  });

  it('handles circuit breaker failure in notifyTelegram', async () => {
    mocked(sendTelegramAlert).mockRejectedValue(new Error('Telegram API failure'));
    await expect(orchestrator['notifyTelegramBreaker'].fire('Test message')).rejects.toThrow('Telegram API failure');
    expect(logError).toHaveBeenCalledWith('ORCHESTRATOR', 'Telegram notification error: Telegram API failure');
  });
});
