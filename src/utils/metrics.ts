import promClient from 'prom-client';

const register = new promClient.Registry();
promClient.collectDefaultMetrics({ register });

const tradesExecuted = new promClient.Counter({
  name: 'trades_executed_total',
  help: 'Total trades executed',
  labelNames: ['filter', 'ticker'],
});

const signalsGenerated = new promClient.Counter({
  name: 'signals_generated_total',
  help: 'Total signals generated',
  labelNames: ['agent'],
});

const roiTotal = new promClient.Gauge({
  name: 'roi_total',
  help: 'Total ROI across all trades',
  labelNames: ['walletId'],
});

const winRate = new promClient.Gauge({
  name: 'win_rate',
  help: 'Win rate of trades',
  labelNames: ['filter'],
});

const partialExits = new promClient.Counter({
  name: 'partial_exits_total',
  help: 'Total partial exits executed',
  labelNames: ['ticker', 'percentage'],
});

const balance = new promClient.Gauge({
  name: 'wallet_balance',
  help: 'Current wallet balance',
  labelNames: ['walletId', 'type'],
});

const walletsCount = new promClient.Gauge({
  name: 'wallets_count',
  help: 'Number of active wallets',
  labelNames: ['type'],
});

const apiLatency = new promClient.Histogram({
  name: 'api_request_duration_ms',
  help: 'API request duration in ms',
  labelNames: ['endpoint', 'source'],
});

const tradeSuccess = new promClient.Counter({
  name: 'trade_success_total',
  help: 'Successful trades',
  labelNames: ['filter', 'ticker'],
});

const tradeFailure = new promClient.Counter({
  name: 'trade_failure_total',
  help: 'Failed trades',
  labelNames: ['filter', 'error'],
});

async function getMetrics(): Promise<string> {
  return register.metrics();
}

export {
  tradesExecuted,
  signalsGenerated,
  roiTotal,
  winRate,
  partialExits,
  balance,
  walletsCount,
  apiLatency,
  tradeSuccess,
  tradeFailure,
  getMetrics,
};
