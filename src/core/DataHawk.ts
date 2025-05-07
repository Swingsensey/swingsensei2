import puppeteer from 'puppeteer';
import axios from 'axios';
import Redis from 'ioredis';
import { CircuitBreaker } from 'opossum';
import { logInfoAggregated, logErrorAggregated } from './SystemGuard';
import { retry, measureLatency } from '../utils/utils';
import apiSources from '../../data/api_sources.json';
import { Token, NewsSignal } from '../utils/types';

const redisClient = new Redis(process.env.REDIS_URL!);

interface ApiSource {
  name: string;
  url: string;
  priority: number;
  fetch: (params: any) => Promise<any>;
}

class DataHawk {
  private browser: puppeteer.Browser | null = null;
  private proxyAgent: string | null = null;
  private deviceId: string = this.generateDeviceId();
  private apiBreakers: Map<string, CircuitBreaker> = new Map();

  constructor() {
    this.initializeApiBreakers();
  }

  private generateDeviceId(): string {
    return Math.random().toString(36).substring(2, 15);
  }

  private async rotateProxy(): Promise<void> {
    try {
      const proxyResponse = await axios.get('https://api.brightdata.com/proxy', {
        headers: { Authorization: `Bearer ${process.env.BRIGHTDATA_API_KEY}` },
      });
      this.proxyAgent = proxyResponse.data.proxy;
      this.deviceId = this.generateDeviceId();
      logInfoAggregated('DATA_HAWK', `Rotated proxy: ${this.proxyAgent}, deviceId: ${this.deviceId}`);
    } catch (error) {
      logErrorAggregated('DATA_HAWK', `Proxy rotation failed: ${error.message}`);
    }
  }

  private initializeApiBreakers() {
    for (const source of apiSources as ApiSource[]) {
      const breaker = new CircuitBreaker(
        async (params: any) => source.fetch(params),
        { timeout: 10000, errorThresholdPercentage: 50, resetTimeout: 30000 }
      );
      this.apiBreakers.set(source.name, breaker);
    }
  }

  async initializeBrowser(): Promise<void> {
    await this.rotateProxy();
    this.browser = await puppeteer.launch({
      headless: true,
      args: this.proxyAgent ? [`--proxy-server=${this.proxyAgent}`] : [],
    });
    logInfoAggregated('DATA_HAWK', 'Browser initialized');
  }

  async closeBrowser(): Promise<void> {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
      logInfoAggregated('DATA_HAWK', 'Browser closed');
    }
  }

  async scrapeGmgnTokens(): Promise<Token[]> {
    if (!this.browser) await this.initializeBrowser();
    try {
      const page = await this.browser!.newPage();
      await page.setUserAgent(`Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ${this.deviceId}`);
      await page.goto('https://gmgn.ai/sol', { waitUntil: 'networkidle2' });
      const tokens = await page.evaluate(() => {
        const rows = Array.from(document.querySelectorAll('.token-row'));
        return rows.map(row => ({
          ticker: row.querySelector('.ticker')?.textContent || '',
          price: parseFloat(row.querySelector('.price')?.textContent || '0'),
          volume: parseFloat(row.querySelector('.volume')?.textContent || '0'),
          marketCap: parseFloat(row.querySelector('.marketCap')?.textContent || '0'),
          liquidity: parseFloat(row.querySelector('.liquidity')?.textContent || '0'),
          holders: parseInt(row.querySelector('.holders')?.textContent || '0'),
          socialPosts: parseInt(row.querySelector('.social')?.textContent || '0'),
          whaleActivity: parseInt(row.querySelector('.whales')?.textContent || '0'),
          burnedLP: parseFloat(row.querySelector('.burnedLP')?.textContent || '0'),
          transactions: parseInt(row.querySelector('.txns')?.textContent || '0'),
          priceChange: parseFloat(row.querySelector('.priceChange')?.textContent || '0'),
          fibLevel: parseFloat(row.querySelector('.fib')?.textContent || '0'),
        }));
      });
      await page.close();
      await redisClient.set('tokens:gmgn', JSON.stringify(tokens), 'EX', 300); // TTL 5min
      await redisClient.publish('tokens:new', JSON.stringify(tokens));
      logInfoAggregated('DATA_HAWK', `Scraped ${tokens.length} tokens from GMGN.ai`);
      return tokens;
    } catch (error) {
      logErrorAggregated('DATA_HAWK', `GMGN scrape failed: ${error.message}`);
      await this.closeBrowser();
      await this.rotateProxy();
      return this.fetchTokensFromApis();
    }
  }

  async fetchTokensFromApis(): Promise<Token[]> {
    const sortedSources = (apiSources as ApiSource[]).sort((a, b) => a.priority - b.priority);
    for (const source of sortedSources) {
      try {
        const breaker = this.apiBreakers.get(source.name)!;
        const tokens = await measureLatency(
          () => retry(() => breaker.fire({}), { retries: 3 }),
          source.url,
          source.name
        );
        await redisClient.set('tokens:gmgn', JSON.stringify(tokens), 'EX', 300);
        await redisClient.publish('tokens:new', JSON.stringify(tokens));
        logInfoAggregated('DATA_HAWK', `Fetched ${tokens.length} tokens from ${source.name}`);
        return tokens;
      } catch (error) {
        logErrorAggregated('DATA_HAWK', `API ${source.name} failed: ${error.message}`);
      }
    }
    return [];
  }

  async fetchNews(): Promise<NewsSignal[]> {
    const newsApiKey = process.env.NEWSAPI_KEY;
    const rateLimitKey = 'newsapi:rate';
    const ttl = 24 * 60 * 60; // 24h
    const maxRequests = 100;

    const currentRequests = parseInt((await redisClient.get(rateLimitKey)) || '0');
    if (currentRequests >= maxRequests) {
      logErrorAggregated('DATA_HAWK', 'NewsAPI rate limit exceeded');
      return this.fallbackNewsAnalysis();
    }

    try {
      const news = await measureLatency(
        () =>
          retry(
            () =>
              axios.get('https://newsapi.org/v2/everything', {
                params: { q: 'solana memecoin', apiKey: newsApiKey },
              }),
            { retries: 3 }
          ),
        'https://newsapi.org/v2/everything',
        'NewsAPI'
      );
      const signals = news.data.articles.map((article: any) => ({
        title: article.title,
        description: article.description,
        sentimentScore: 0, // Placeholder for HuggingFace analysis
        timestamp: new Date(article.publishedAt).getTime(),
      }));
      await redisClient.incr(rateLimitKey);
      await redisClient.expire(rateLimitKey, ttl);
      await redisClient.publish('news:signals', JSON.stringify(signals));
      logInfoAggregated('DATA_HAWK', `Fetched ${signals.length} news signals`);
      return signals;
    } catch (error) {
      logErrorAggregated('DATA_HAWK', `NewsAPI fetch failed: ${error.message}`);
      return this.fallbackNewsAnalysis();
    }
  }

  async fallbackNewsAnalysis(): Promise<NewsSignal[]> {
    // DeepSeek/OpenAI as fallback
    try {
      const prompt = 'Analyze recent Solana memecoin news and generate signals';
      const response = await axios.post(
        'https://api.deepseek.com/v1/chat/completions',
        { messages: [{ role: 'user', content: prompt }], model: 'deepseek-rag' },
        { headers: { Authorization: `Bearer ${process.env.DEEPSEEK_API_KEY}` } }
      );
      const signals = JSON.parse(response.data.choices[0].message.content);
      await redisClient.publish('news:signals', JSON.stringify(signals));
      logInfoAggregated('DATA_HAWK', `Fetched ${signals.length} fallback news signals`);
      return signals;
    } catch (error) {
      logErrorAggregated('DATA_HAWK', `Fallback news analysis failed: ${error.message}`);
      return [];
    }
  }

  async monitorTweets(): Promise<void> {
    redisClient.subscribe('tweets:raw', (err, count) => {
      if (err) logErrorAggregated('DATA_HAWK', `Tweet subscription failed: ${err.message}`);
      else logInfoAggregated('DATA_HAWK', `Subscribed to tweets:raw, count: ${count}`);
    });
    redisClient.on('message', async (channel, message) => {
      if (channel === 'tweets:raw') {
        const tweets = JSON.parse(message);
        const signals = tweets.map((tweet: any) => ({
          title: tweet.text,
          sentimentScore: 0, // Placeholder for HuggingFace
          timestamp: new Date(tweet.created_at).getTime(),
        }));
        await redisClient.publish('news:signals', JSON.stringify(signals));
        logInfoAggregated('DATA_HAWK', `Processed ${signals.length} tweet signals`);
      }
    });
  }

  async monitorErrors(): Promise<void> {
    redisClient.subscribe('errors:detected', (err, count) => {
      if (err) logErrorAggregated('DATA_HAWK', `Error subscription failed: ${err.message}`);
      else logInfoAggregated('DATA_HAWK', `Subscribed to errors:detected, count: ${count}`);
    });
    redisClient.on('message', async (channel, message) => {
      if (channel === 'errors:detected') {
        const error = JSON.parse(message);
        if (error.source === 'GMGN' && [403, 429].includes(error.status)) {
          await this.rotateProxy();
          await this.scrapeGmgnTokens();
        }
      }
    });
  }
}

export default DataHawk;
