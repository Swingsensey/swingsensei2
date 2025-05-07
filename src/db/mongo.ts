import { MongoClient, Db } from 'mongodb';
import { logInfoAggregated, logErrorAggregated } from '../core/SystemGuard';

let client: MongoClient | null = null;
let db: Db | null = null;

async function connectDB(): Promise<Db> {
  if (db) return db;
  try {
    client = new MongoClient(process.env.MONGO_URI!);
    await client.connect();
    db = client.db('swingsensei');
    logInfoAggregated('MONGO', 'Connected to MongoDB');
    return db;
  } catch (error) {
    logErrorAggregated('MONGO', `MongoDB connection failed: ${error.message}`);
    throw error;
  }
}

async function closeDB(): Promise<void> {
  if (client) {
    await client.close();
    client = null;
    db = null;
    logInfoAggregated('MONGO', 'Disconnected from MongoDB');
  }
}

async function saveTrade(trade: any): Promise<void> {
  const db = await connectDB();
  await db.collection('trades').insertOne(trade);
  logInfoAggregated('MONGO', `Saved trade: ${trade.ticker}`);
}

async function saveSignal(signal: any): Promise<void> {
  const db = await connectDB();
  await db.collection('signals').insertOne(signal);
  logInfoAggregated('MONGO', `Saved signal: ${signal.agent}`);
}

async function saveWallet(wallet: any): Promise<void> {
  const db = await connectDB();
  await db.collection('wallets').insertOne(wallet);
  logInfoAggregated('MONGO', `Saved wallet: ${wallet.walletId}`);
}

async function savePartialExit(exit: any): Promise<void> {
  const db = await connectDB();
  await db.collection('partial_exits').insertOne(exit);
  logInfoAggregated('MONGO', `Saved partial exit: ${exit.ticker}`);
}

export { connectDB, closeDB, saveTrade, saveSignal, saveWallet, savePartialExit };
