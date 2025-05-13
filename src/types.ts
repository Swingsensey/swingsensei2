export interface Token {
  ticker: string;
  price: number;
  volume: number;
  marketCap: number;
  liquidity: number;
  priceChange: number;
  fibonacciLevels?: {
    level_236: number;
    level_382: number;
    level_500: number;
    level_618: number;
    lastMin: number;
    lastMax: number;
  };
}

export interface Signal {
  ticker: string;
  action: 'buy' | 'sell' | 'hold';
  confidence: number;
  source: string;
  timestamp: string;
  entryType: 'fibonacci' | 'sentiment' | 'volume';
  marketCap?: number;
  liquidity?: number;
  snipers?: number;
  devHoldings?: number;
  age?: number;
  volume1h?: number;
  priceChange1h?: number;
  holders?: number;
  topHolders?: number;
  category?: string;
  channel?: string;
  socialVolume?: number;
  socialScore?: number;
  galaxyScore?: number;
  announcementImpact?: number;
  fibonacciLevel?: number;
}

export interface NewsSignal {
  ticker: string;
  sentimentScore: number;
  announcementImpact: number;
  timestamp: string;
  source: string;
  marketCap?: number;
  liquidity?: number;
  snipers?: number;
  devHoldings?: number;
  age?: number;
  volume1h?: number;
  priceChange1h?: number;
  holders?: number;
  topHolders?: number;
}

export interface NewsItem {
  text: string;
  source: string;
  timestamp: string;
  category: string;
  channel?: string;
}

export interface LunarCrushData {
  socialVolume: number;
  socialScore: number;
  galaxyScore: number;
}

export interface BirdeyeData {
  symbol: string;
  price: number;
  volume_5min: number;
  liquidity: number;
  marketCap: number;
}

export interface SolscanData {
  tokenAddress: string;
  price: number;
  volume: number;
  marketCap: number;
}

export interface RaydiumPair {
  symbol: string;
  price: number;
  volume_24h: number;
  market_cap: number;
  liquidity: number;
  price_change_24h: number;
}

export interface Trade {
  ticker: string;
  action: 'buy' | 'sell';
  positionSize: number;
  price: number;
  walletId: string;
  timestamp: string;
  roi: number;
  entryType: 'fibonacci' | 'sentiment' | 'volume';
  fibonacciLevel?: number;
  exitReason?: 'trailingStop' | 'fibonacciLevel';
  filter?: number;
}

export interface Wallet {
  walletId: string;
  balance: number;
  type: 'trading' | 'bank';
}

export interface TradeSenseiDependencies {
  redis: Redis;
  mongo: MongoClient;
  jupiter: any;
  solscanApiKey: string;
  cieloApiKey: string;
  telegramBotToken: string;
  telegramChatId: string;
}

export type SwarmCommand = 'analyze_fibonacci' | 'scan_signal' | 'auto_trade' | 'rebalance';

export interface SwarmPayload {
  ticker?: string;
  entryPrice?: number;
  strategy?: string;
  walletId?: string;
  size?: number;
}

export interface DQNState {
  volume: number;
  liquidity: number;
  priceChange: number;
  socialSentiment: number;
  whaleActivity: number;
  volatility: number;
  socialVolume: number;
  galaxyScore: number;
  announcementImpact: number;
}

export interface CoordinationResult {
  asset: string;
  action: 'buy' | 'sell' | 'hold';
  confidence: number;
  source: 'SwarmMaster';
}

export interface ErrorMessage {
  errorId: string;
  type: string;
  provider: string;
  task: string;
  stack: string;
}

export interface ErrorResolution {
  errorId: string;
  solution: string;
  resolved: boolean;
}

export interface DQNWeights {
  newsWeight: number;
  timestamp: Date;
  weights: any[];
}
