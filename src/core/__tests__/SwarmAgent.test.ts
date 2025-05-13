import { expect } from 'chai';
import sinon from 'sinon';
import { Redis } from 'ioredis';
import { MongoClient } from 'mongodb';
import { TelegramBot } from 'node-telegram-bot-api';
import { scheduleJob } from 'node-schedule';
import SwarmMaster from './SwarmMaster';
import { Token, DQNState, CoordinationResult, ErrorMessage, ErrorResolution } from '../types';
import { tradesExecutedTotal } from '../utils/metrics';

describe('SwarmMaster', () => {
  let redisStub: sinon.SinonStubbedInstance<Redis>;
  let mongoStub: sinon.SinonStubbedInstance<MongoClient>;
  let botStub: sinon.SinonStubbedInstance<TelegramBot>;
  let swarmMaster: SwarmMaster;
  let scheduleJobStub: sinon.SinonStub;

  beforeEach(() => {
    redisStub = sinon.createStubInstance(Redis);
    mongoStub = sinon.createStubInstance(MongoClient);
    botStub = sinon.createStubInstance(TelegramBot);
    scheduleJobStub = sinon.stub(scheduleJob, 'scheduleJob').callsFake((rule, callback) => {
      return { cancel: sinon.stub() };
    });
    process.env.TELEGRAM_CHAT_ID = '-1002616465399';
    swarmMaster = new SwarmMaster();
  });

  afterEach(() => {
    sinon.restore();
  });

  it('should initialize agents correctly', () => {
    expect(swarmMaster['agentStatuses'].size).to.equal(4);
    expect(swarmMaster['agentStatuses'].get('DataHawk')?.running).to.be.true;
  });

  it('should filter risky tokens in analyze_fibonacci', async () => {
    const token: Token = {
      ticker: 'TEST',
      price: 100,
      volume: 15000,
      marketCap: 100000,
      liquidity: 50000,
      priceChange: 5,
      fibonacciLevels: { level_236: 80, level_382: 85, level_500: 90, level_618: 95, lastMin: 70, lastMax: 110 },
    };
    redisStub.get.withArgs('tokens:TEST').resolves(JSON.stringify(token));
    redisStub.get.withArgs('cielo:TEST').resolves(JSON.stringify({ kits: 3 }));
    redisStub.get.withArgs('news:signals:TEST').resolves(JSON.stringify({ snipers: 60, devHoldings: 2 }));

    await swarmMaster['analyzeFibonacci']({ ticker: 'TEST' });
    expect(redisStub.publish.calledWith('signals:new')).to.be.false;
  });

  it('should generate fibonacci signal with valid conditions', async () => {
    const token: Token = {
      ticker: 'TEST',
      price: 90,
      volume: 15000,
      marketCap: 100000,
      liquidity: 50000,
      priceChange: 5,
      fibonacciLevels: { level_236: 80, level_382: 85, level_500: 90, level_618: 95, lastMin: 70, lastMax: 110 },
    };
    redisStub.get.withArgs('tokens:TEST').resolves(JSON.stringify(token));
    redisStub.get.withArgs('cielo:TEST').resolves(JSON.stringify({ kits: 3 }));
    redisStub.get.withArgs('news:signals:TEST').resolves(JSON.stringify({ snipers: 10, devHoldings: 1 }));

    await swarmMaster['analyzeFibonacci']({ ticker: 'TEST' });
    expect(redisStub.publish.calledWith('signals:new')).to.be.true;
  });

  it('should select filter with historical performance', async () => {
    const token: Token = {
      ticker: 'TEST',
      price: 100,
      volume: 15000,
      marketCap: 100000,
      liquidity: 50000,
      priceChange: 5,
    };
    redisStub.get.withArgs('tokens:TEST').resolves(JSON.stringify(token));
    redisStub.get.withArgs('tweets:TEST').resolves(JSON.stringify({ sentiment: 0.8 }));
    redisStub.get.withArgs('cielo:TEST').resolves(JSON.stringify({ kits: 3 }));
    redisStub.get.withArgs('news:signals:TEST').resolves(JSON.stringify({ socialVolume: 5000, galaxyScore: 85, announcementImpact: 0.9 }));
    mongoStub.collection('trades').find.resolves({
      toArray: sinon.stub().resolves([{ filter: 0, roi: 0.2 }, { filter: 1, roi: 0.1 }]),
    });

    const filter = await swarmMaster['selectFilter'](token);
    expect(filter).to.be.oneOf([0, 1, 2]);
  });

  it('should adjust DQN parameters based on metrics', async () => {
    const fetchStub = sinon.stub(global, 'fetch');
    fetchStub.onCall(0).resolves({ json: () => ({ data: { result: [{ value: [0, '5'] }] } }) });
    fetchStub.onCall(1).resolves({ json: () => ({ data: { result: [{ value: [0, '25'] }] } }) });

    await swarmMaster['adjustDQNParams']();
    expect(swarmMaster['dqnConfig'].learningRate).to.equal(0.0009);
    expect(swarmMaster['dqnConfig'].gamma).to.equal(0.99);
  });

  it('should manage reinvestment correctly', async () => {
    mongoStub.collection('wallets').find.resolves({
      toArray: sinon.stub().resolves([
        { walletId: 'W1', balance: 3000, type: 'trading' },
        { walletId: 'W2', balance: 1000, type: 'trading' },
      ]),
    });

    await swarmMaster['manageReinvestment']();
    expect(redisStub.publish.calledWith('swarm:commands', sinon.match.string)).to.be.true;
  });

  it('should coordinate agents for SOL', async () => {
    redisStub.get.withArgs('prompt:template:swarm_master').resolves('{}');
    redisStub.get.withArgs('tokens:SOL').resolves(JSON.stringify({ ticker: 'SOL', price: 100, volume: 15000, marketCap: 100000, liquidity: 50000, priceChange: 5 }));
    const coordinationResult: CoordinationResult = {
      asset: 'SOL',
      action: 'buy',
      confidence: 0.85,
      source: 'SwarmMaster',
    };
    const tradeSenseiSignal = { ticker: 'SOL', action: 'buy', confidence: 0.8, source: 'TradeSensei' };
    sinon.stub(swarmMaster['tradeSensei'], 'generateSignal').resolves(tradeSenseiSignal);
    sinon.stub(SentimentAnalyzer.prototype, 'analyzeFreeAI').resolves({ sentiment: JSON.stringify(coordinationResult) });

    const result = await swarmMaster.coordinateAgents('SOL');
    expect(result).to.deep.equal({
      asset: 'SOL',
      action: 'buy',
      confidence: expect.any(Number),
      source: 'SwarmMaster',
    });
    expect(redisStub.publish.calledWith('swarm:metrics')).to.be.true;
  });

  it('should throw error if asset is not provided in coordinateAgents', async () => {
    await expect(swarmMaster.coordinateAgents('')).to.be.rejectedWith('Asset must be provided');
  });

  it('should handle 429 error by switching to gpt4free', async () => {
    const errorMessage: ErrorMessage = {
      errorId: '123',
      type: '429',
      provider: 'io.net',
      task: 'analyze_token',
      stack: 'Error stack',
    };
    await swarmMaster['handleError'](JSON.stringify(errorMessage));
    expect(redisStub.publish.calledWith('ai:requests', JSON.stringify({ task: 'analyze_token', provider: 'gpt4free' }))).to.be.true;
    expect(redisStub.set.calledWith(`swarm:error_resolution:${errorMessage.errorId}`, sinon.match.string, 'EX', 86400)).to.be.true;
    expect(redisStub.publish.calledWith('errors:resolved', sinon.match.string)).to.be.true;
  });

  it('should send Telegram alert for cloud_limit_exceeded', async () => {
    const errorMessage: ErrorMessage = {
      errorId: '124',
      type: 'cloud_limit_exceeded',
      provider: 'render',
      task: 'scrape_data',
      stack: 'Error stack',
    };
    await swarmMaster['handleError'](JSON.stringify(errorMessage));
    expect(botStub.sendMessage.calledWith('-1002616465399', sinon.match.string)).to.be.true;
    expect(redisStub.set.calledWith(`swarm:error_resolution:${errorMessage.errorId}`, sinon.match.string, 'EX', 86400)).to.be.true;
    expect(redisStub.publish.calledWith('errors:resolved', sinon.match.string)).to.be.true;
  });

  it('should schedule daily report', () => {
    expect(scheduleJobStub.calledWith('0 23 * * *', sinon.match.func)).to.be.true;
  });

  it('should generate daily report', async () => {
    const trades = [
      { ticker: 'SOL', roi: 10, timestamp: new Date() },
      { ticker: 'ETH', roi: 5, timestamp: new Date() },
    ];
    const errorResolution = {
      errorId: '123',
      type: '429',
      provider: 'io.net',
      solution: 'Переключение на gpt4free',
      resolved: true,
    };
    const dqnWeights = { newsWeight: 0.3, timestamp: new Date() };
    mongoStub.collection('trades').find.resolves({ toArray: sinon.stub().resolves(trades) });
    redisStub.keys.withArgs('swarm:error_resolution:*').resolves(['swarm:error_resolution:123']);
    redisStub.get.withArgs('swarm:error_resolution:123').resolves(JSON.stringify(errorResolution));
    mongoStub.collection('dqn_weights').findOne.resolves(dqnWeights);

    const report = await swarmMaster['generateDailyReport']();
    expect(report).to.include('Доход: $15.00');
    expect(report).to.include('Сделок: 2');
    expect(report).to.include('DQN увеличил вес новостей до 30.0%');
    expect(report).to.include('Лучшая сделка: $10.00');
  });

  it('should generate suggestions for low income', async () => {
    const trades = [{ ticker: 'SOL', roi: 2, timestamp: new Date() }];
    mongoStub.collection('trades').find.resolves({ toArray: sinon.stub().resolves(trades) });
    redisStub.keys.withArgs('swarm:error_resolution:*').resolves([]);
    mongoStub.collection('dqn_weights').findOne.resolves(null);

    const report = await swarmMaster['generateDailyReport']();
    expect(report).to.include('Увеличьте вес трендов в DQN до 35%');
  });
});
