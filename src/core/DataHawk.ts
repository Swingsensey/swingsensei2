import axios from 'axios';
import Redis from 'ioredis';
import { NewsSignal, Token } from './utils/types';
import { retry } from 'ts-retry-promise';
import puppeteer from 'puppeteer';
import * as cheerio from 'cheerio';
import { CircuitBreaker } from 'opossum';
import puppeteerExtra from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';

puppeteerExtra.use(StealthPlugin());

interface APISource {
  url: string;
  priority: number;
  fallback: boolean;
}

interface BrightDataProxy {
  host: string;
  port: number;
  username: string;
  password: string;
}

class DataHawk {
  private redisClient: Redis;
  private apiSources: APISource[] = [];
  private circuitBreaker: CircuitBreaker;

  constructor(redisClient: Redis) {
    this.redisClient = redisClient;
    this.loadAPISources();
    this.circuitBreaker = new CircuitBreaker({
      errorThresholdPercentage: 50,
      rollingCountTimeout: 10000,
    });
  }

  private loadAPISources(): void {
    this.apiSources = [
      { url: 'https://api.raydium.io/v1/tokens', priority: 1, fallback: true },
      { url: 'https://public-api.birdeye.so/v1/tokens', priority: 2, fallback: true },
      { url: 'https://public-api.solscan.io/account/transactions', priority: 3, fallback: true },
    ].sort((a, b) => a.priority - b.priority);
  }

  private async getBrightDataProxy(): Promise<BrightDataProxy> {
    // Симуляция получения прокси через BrightData API
    return {
      host: 'brd.superproxy.io',
      port: 22225,
      username: process.env.BRIGHTDATA_USERNAME || 'brd-customer-username',
      password: process.env.BRIGHTDATA_PASSWORD || 'password',
    };
  }

  private async scrapeGMGN(): Promise<Token[]> {
    const proxy = await this.getBrightDataProxy();
    const browser = await puppeteerExtra.launch({
      headless: 'new',
      args: [
        `--proxy-server=${proxy.host}:${proxy.port}`,
        '--no-sandbox',
        '--disable-setuid-sandbox',
      ],
    });
    const page = await browser.newPage();
    await page.authenticate({ username: proxy.username, password: proxy.password });
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36');
    await page.goto('https://gmgn.ai/', { waitUntil: 'networkidle2' });

    const content = await page.content();
    const $ = cheerio.load(content);
    const tokens: Token[] = [];

    $('.token-item').each((i, el) => {
      const ticker = $(el).find('.token-ticker').text();
      const price = parseFloat($(el).find('.token-price').text());
      if (ticker && !isNaN(price)) tokens.push({ ticker, price });
    });

    await browser.close();
    return tokens;
  }

  private async scrapeRaydiumFallback(): Promise<Token[]> {
    const browser = await puppeteerExtra.launch({ headless: 'new' });
    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36');
    await page.goto('https://raydium.io/swap/', { waitUntil: 'networkidle2' });

    const content = await page.content();
    const $ = cheerio.load(content);
    const tokens: Token[] = [];

    $('.token-list-item').each((i, el) => {
      const ticker = $(el).find('.token-symbol').text();
      const price = parseFloat($(el).find('.token-price').text());
      if (ticker && !isNaN(price)) tokens.push({ ticker, price });
    });

    await browser.close();
    return tokens;
  }

  private async fetchAPIData(): Promise<Token[]> {
    for (const source of this.apiSources) {
      try {
        const response = await this.circuitBreaker.fire(
          () => retry(() => axios.get(source.url, { params: { apiKey: process.env.SOLSCAN_API_KEY } }), { retries: 3, delay: 1000 })
        );
        if (source.url.includes('solscan')) {
          return response.data.map((item: any) => ({
            ticker: item.tokenAddress ? item.tokenAddress.slice(0, 8) : 'unknown',
            price: parseFloat(item.amount || 0) / 1e9, // Нормализация SOL
          }));
        }
        return response.data.map((item: any) => ({
          ticker: item.symbol || item.name || 'unknown',
          price: parseFloat(item.price || 0),
        }));
      } catch (error) {
        console.error(`API ${source.url} failed: ${error.message}`);
        if (!source.fallback) continue;
      }
    }
    // Резервный скрапинг Raydium
    return await this.scrapeRaydiumFallback();
  }

  async fetchTwitterPosts(): Promise<{ posts: NewsSignal[] }> {
    const cacheKey = 'twitter:posts';
    const cached = await this.redisClient.get(cacheKey);
    if (cached) return JSON.parse(cached);

    const posts: NewsSignal[] = [];
    try {
      const response = await retry(
        () =>
          axios.get('https://api.twitter.com/2/tweets/search/recent', {
            headers: { Authorization: `Bearer ${process.env.TWITTER_BEARER_TOKEN}` },
            params: {
              query: '#Solana OR #memecoin whale -is:retweet',
              max_results: 500,
              'tweet.fields': 'created_at',
            },
          }),
        { retries: 3, delay: 1000 }
      );
      posts.push(
        ...response.data.data.map((tweet: any) => ({
          text: tweet.text,
          timestamp: new Date(tweet.created_at).getTime(),
          source: 'twitter',
        }))
      );
    } catch (error) {
      console.error(`Twitter fetch failed: ${error.message}`);
    }

    await this.redisClient.setEx(cacheKey, 900, JSON.stringify({ posts })); // 15 минут
    return { posts };
  }

  async fetchTweetcordSignals(): Promise<NewsSignal[]> {
    const cacheKey = 'tweetcord:signals';
    const cached = await this.redisClient.get(cacheKey);
    if (cached) return JSON.parse(cached);

    const useDiscord = false;
    let signals: NewsSignal[] = [];

    if (useDiscord) {
      const channelId = '123456789';
      signals = [{ text: '123456789', timestamp: Date.now(), source: 'discord' }];
    }

    const twitterSignals = await this.fetchTwitterPosts().then((result) => result.posts);
    signals = signals.concat(twitterSignals);

    await this.redisClient.setEx(cacheKey, 600, JSON.stringify(signals)); // 10 минут
    return signals;
  }

  async generateSignals(): Promise<NewsSignal[]> {
    const [gmgnTokens, apiTokens, tweetcordSignals] = await Promise.all([
      this.scrapeGMGN(),
      this.fetchAPIData(),
      this.fetchTweetcordSignals(),
    ]);

    // Устранение дубликатов токенов
    const tokenMap = new Map<string, Token>();
    [...gmgnTokens, ...apiTokens].forEach(token => {
      if (!tokenMap.has(token.ticker)) tokenMap.set(token.ticker, token);
    });
    const allTokens = Array.from(tokenMap.values()).map(token => ({
      ...token,
      source: 'gmgn' in token ? 'gmgn' : 'api',
    }));

    await this.redisClient.setEx('tokens:new', 300, JSON.stringify(allTokens));
    await this.redisClient.publish('tokens:new', JSON.stringify(allTokens));

    const signals: NewsSignal[] = tweetcordSignals.map(signal => {
      const tickerMatch = signal.text.match(/\b[A-Z]{3,}\b/); // Поиск токена без $
      const ticker = signal.text.split(' ').find(w => w.startsWith('$'))?.slice(1) || tickerMatch?.[0] || '';
      return { ...signal, ticker };
    });

    await this.redisClient.setEx('news:signals', 3600, JSON.stringify(signals));
    await this.redisClient.publish('news:signals', JSON.stringify(signals));
    return signals;
  }

  async start(): Promise<void> {
    setInterval(() => this.generateSignals(), 300000);
  }
}

export default DataHawk;
