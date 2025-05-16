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

export interface FilterParams {
  name: string;
  minVolume: number;
  minLiquidity: number;
  minHolders?: number;
  minSocialPosts?: number;
  minSentiment?: number;
  minPriceChange?: number;
  maxPriceChange?: number;
  minMarketCap?: number;
  maxMarketCap?: number;
  minWhales?: number;
  whaleMinTransfer?: number;
  burnedLP?: number;
  minTransactions?: number;
  requireInfluencers?: boolean;
  minAge?: number;
  maxAge?: number;
  minVolumeGrowth?: number;
  minLiquidityGrowth?: number;
  minHoldersGrowth?: number;
  maxHolderConcentration?: number;
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
}

export interface NewsItem {
  ticker: string;
  text: string;
  source: string;
  timestamp: string;
}

export interface LunarCrushData {
  ticker: string;
  socialVolume: number;
  socialScore: number;
  galaxyScore: number;
  socialPosts: number;
  sentiment: number;
  timestamp: string;
}

export interface XAlphaData {
  ticker: string;
  socialPosts: number;
  sentiment: number;
  influenceScore: number;
  timestamp: string;
}

export interface BirdeyeData {
  volume: number;
  liquidity: number;
  marketCap: number;
  priceChange: number;
  price: number;
}

export interface SolscanData {
  holders: number;
  burnedLP: number;
  transactions: number;
  createdAt: number;
}

export interface RaydiumPair {
  pairAddress: string;
  baseToken: string;
  quoteToken: string;
  liquidity: number;
}

export interface Trade {
  ticker: string;
  action: 'buy' | 'sell';
  positionSize: number;
  price: number;
  walletId: string;
  roi: number;
  entryType: 'fibonacci' | 'sentiment' | 'volume';
  exitReason: 'trailingStop' | 'fibonacciLevel';
}

export interface Wallet {
  id: string;
  balance: number;
  tokens: Record<string, number>;
}

export interface TradeSenseiDependencies {
  redis: any;
  jupiter: any;
  aiConsilium: any;
}

export interface SwarmCommand {
  agent: string;
  task: string;
  priority: number;
}

export interface SwarmPayload {
  command: SwarmCommand;
  data: any;
}

export interface DQNState {
  price: number;
  volume: number;
  liquidity: number;
  sentiment: number;
}

export interface CoordinationResult {
  success: boolean;
  agent: string;
  task: string;
}

export interface ErrorMessage {
  id: string;
  message: string;
  timestamp: string;
}

export interface ErrorResolution {
  id: string;
  resolution: string;
  timestamp: string;
}

export interface DQNWeights {
  weights: number[];
  biases: number[];
}
