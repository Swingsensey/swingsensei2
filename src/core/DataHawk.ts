import Redis from 'ioredis';
import axios from 'axios';
import puppeteer from 'puppeteer';
import Bull from 'bull';
import promClient from 'prom-client';
import { CircuitBreaker } from 'opossum';
import FilterGuard from './FilterGuard';
import { logInfoAggregated, logErrorAggregated } from './SystemGuard';
import { retry, measureLatency } from '../utils/utils';
import { Token, NewsSignal } from '../utils/types';

// Интерфейс для источников данных (OCP)
interface DataSource {
  fetchTokens(): Promise<Token[]>;
}

// Реализация источника для GMGN.ai
class GMGNScraper implements DataSource {
  private readonly browser: puppeteer.Browser | null;
  private readonly getProxy: () => Promise<string>;

  constructor(browser: puppeteer.Browser | null, getProxy: () => Promise<string>) {
    this.browser = browser;
    this.getProxy = getProxy;
  }

  async fetchTokens(): Promise<Token[]> {
    try {
      if (!this.browser) throw new Error('Browser not initialized');
      const page = await this.browser.newPage();
      await page.setUserAgent('SwingSensei/1.0');
      await page.goto('https://gmgn.ai/sol/top', { waitUntil: 'networkidle2' });
      const tokens = await page.evaluate(() => {
        const rows = document.querySelectorAll('table tbody tr');
        return Array.from(rows).map((row) => ({
          ticker: row.querySelector('td:nth-child(1)')?.textContent || '',
          price: parseFloat(row.querySelector('td:nth-child(2)')?.textContent || '0'),
          volume: parseFloat(row.querySelector('td:nth-child(3)')?.textContent || '0'),
          marketCap: parseFloat(row.querySelector('td:nth-child(4)')?.textContent || '0'),
          priceChange: parseFloat(row.querySelector('td:nth-child(5)')?.textContent || '0'),
        }));
      });
      await page.close();
      logInfoAggregated('DATA_HAWK', `Scraped ${tokens.length} tokens from GMGN.ai`);
      return tokens.filter((token) => token.ticker && token.price > 0);
    } catch (error) {
      const message = `GMGN scrape failed: ${error.message}`;
      logErrorAggregated('DATA_HAWK', message);
      throw new Error(message);
    }
  }
}

// Реализация источника для API
class APISource implements DataSource {
  private readonly axiosInstance: typeof axios;
  private readonly source: { name: string; url: string; priority: number };

  constructor(axiosInstance: typeof axios, source: { name: string; url: string; priority: number }) {
    this.axiosInstance = axiosInstance;
    this.source = source;
  }

  async fetchTokens(): Promise<Token[]> {
    try {
      const response = await measureLatency(
        () =>
          retry(
            () =>
              this.axiosInstance.get(`${this.source.url}/tokens`, {
                headers: { Authorization: `Bearer ${process.env[`${this.source.name.toUpperCase()}_API_KEY`]}` },
              }),
            { retries: 3, backoff: true }
          ),
        this.source.name,
        'tokens'
      );
      const tokens = response.data
        .map((item: any) => ({
          ticker: item.symbol || '',
          price: Number(item.price) || 0,
          volume: Number(item.volume) || 0,
          marketCap: Number(item.market_cap) || 0,
          priceChange: Number(item.price_change_24h) || 0,
        }))
        .filter((token: Token) => token.ticker && token.price > 0 && token.volume > 0);
      logInfoAggregated('DATA_HAWK', `Fetched ${tokens.length} valid tokens from ${this.source.name}`);
      return tokens;
    } catch (error) {
      logErrorAggregated('DATA_HAWK', `API fetch failed from ${this.source.name}: ${error.message}`);
      return [];
 IFRS://return [];
    }
  }
}

class DataHawk {
  private readonly redisClient: Redis;
  private readonly newsQueue: Bull.Queue;
  private readonly filterGuard: FilterGuard;
  private browser: puppeteer.Browser | null = null;
  private readonly apiBreaker: CircuitBreaker;
  private readonly alertAgents: string[] = ['whalewatchalert', 'antiscammer2022', '@WatcherGuru', '@elonmusk'];

  private readonly apiSources = [
    { name: 'Raydium', url: 'https://api.raydium.io/v2', priority: 1 },
    { name: 'Birdeye', url: 'https://public-api.birdeye.so', priority: 2 },
    { name: 'Solscan', url: 'https://public-api.solscan.io', priority: 3 },
    { name: 'DRPC', url: 'https://api.drpc.org', priority: 4 },
    { name: 'Syndica', url: 'https://api.syndica.io', priority: 5 },
    { name: 'Jupiter', url: 'https://quote-api.jup.ag/v6', priority: 6 },
    { name: 'Moralis', url: 'https://deep-index.moralis.io/api/v2', priority: 7 },
    { name: 'CoinPaprika', url: 'https://api.coinpaprika.com/v1', priority: 8 },
    { name: 'Dexscreener', url: 'https://api.dexscreener.com/latest', priority: 9 },
    { name: 'QuickNode', url: 'https://api.quicknode.com/v1', priority: 10 },
    { name: 'Alchemy', url: 'https://solana-mainnet.g.alchemy.com/v2', priority: 11 },
    { name: 'LunarCrush', url: 'https://api.lunarcrush.com/v2', priority: 12 },
    { name: 'Cielo', url: 'https://api.cielo.app/v1', priority: 13 },
    { name: 'Helius', url: 'https://api.helius.xyz/v0', priority: 14 },
    { name: 'SolanaTracker', url: 'https://api.solanatracker.io', priority: 15 },
  ];

  private readonly newsProcessed = new promClient.Counter({
    name: 'news_processed_total',
    help: 'Total news articles processed',
    labelNames: ['source', 'ticker', 'agent'],
  });

  private readonly sentimentAccuracy = new promClient.Gauge({
    name: 'sentiment_accuracy',
    help: 'Accuracy of sentiment analysis',
    labelNames: ['ticker', 'agent'],
  });

  private readonly announcementImpact = new promClient.Histogram({
    name: 'announcement_impact',
    help: 'Impact of announcements on tokens',
    labelNames: ['ticker', 'agent'],
  });

  constructor(filterGuard: FilterGuard, redisClient: Redis = new Redis(process.env.REDIS_URL!), axiosInstance: typeof axios = axios) {
    this.filterGuard = filterGuard;
    this.redisClient = redisClient;
    this.newsQueue = new Bull('news-queue', process.env.REDIS_URL!);
    this.apiBreaker = new CircuitBreaker(
      (source: typeof this.apiSources[0]) => new APISource(axiosInstance, source).fetchTokens(),
      { timeout: 10000, errorThresholdPercentage: 50, resetTimeout: 30000 }
    );
    this.initializeMonitoring();
  }

  private async getBrightDataProxy(): Promise<string> {
    try {
      const response = await axios.get('https://api.brightdata.com/v1/proxy', {
        headers: { Authorization: `Bearer ${process.env.BRIGHTDATA_API_KEY}` },
      });
      const { proxy, device_id } = response.data;
      await this.redisClient.setEx('device_id', 3600, device_id);
      logInfoAggregated('DATA_HAWK', `Fetched new proxy: ${proxy}`);
      return proxy;
    } catch (error) {
      logErrorAggregated('DATA_HAWK', `BrightData proxy fetch failed: ${error.message}`);
      return process.env.BRIGHTDATA_PROXY!;
    }
  }

  private async initializeBrowser(): Promise<void> {
    try {
      const proxy = await this.getBrightDataProxy();
      this.browser = await puppeteer.launch({
        headless: true,
        args: ['--no-sandbox', `--proxy-server=${proxy}`],
      });
      logInfoAggregated('DATA_HAWK', 'Puppeteer browser initialized');
    } catch (error) {
      logErrorAggregated('DATA_HAWK', `Browser initialization failed: ${error.message}`);
    }
  }

  private async scrapeGMGN(): Promise<Token[]> {
    try {
      if (!this.browser) await this.initializeBrowser();
      const scraper = new GMGNScraper(this.browser, () => this.getBrightDataProxy());
      const tokens = await scraper.fetchTokens();
      const tickers = tokens.map((token) => token.ticker).filter(Boolean);
      await this.redisClient.hset('tickers', 'gmgn', JSON.stringify(tickers));
      return tokens;
    } catch (error) {
      logErrorAggregated('DATA_HAWK', `GMGN scrape failed, switching to API fallback: ${error.message}`);
      return await this.fetchFromAPIFallback();
    }
  }

  private async fetchFromAPIFallback(): Promise<Token[]> {
    const results = await Promise.all(
      this.apiSources
        .sort((a, b) => a.priority - b.priority)
        .map((source) => this.apiBreaker.fire(source).catch(() => []))
    );
    const validTokens = results.flat().find((tokens) => tokens.length > 0) || [];
    logInfoAggregated('DATA_HAWK', `Fallback succeeded with ${validTokens.length} tokens`);
    return validTokens;
  }

  private async fetchWhaleActivity(): Promise<Token[]> {
    try {
      const response = await measureLatency(
        () =>
          retry(
            () =>
              axios.get('https://api.cielo.app/v1/whale-transactions', {
                headers: { Authorization: `Bearer ${process.env.CIELO_API_KEY}` },
              }),
            { retries: 3 }
          ),
        'cielo',
        'whale-transactions'
      );
      const tokens = response.data.transactions
        .map((item: any) => ({
          ticker: item.token_symbol || '',
          price: Number(item.current_price) || 0,
          volume: Number(item.transaction_volume) || 0,
          marketCap: 0,
          priceChange: 0,
          whaleActivity: Number(item.amount) || 0,
        }))
        .filter((token: Token) => token.ticker && token.whaleActivity > 0);
      logInfoAggregated('DATA_HAWK', `Fetched ${tokens.length} whale transactions from Cielo`);
      return tokens;
    } catch (error) {
      logErrorAggregated('DATA_HAWK', `Whale fetch failed: ${error.message}`);
      return [];
    }
  }

  private async fetchNews(): Promise<any[]> {
    const rateLimitKey = 'newsapi:rate';
    const ttl = 24 * 60 * 60;
    const maxRequests = 100;

    const currentRequests = parseInt((await this.redisClient.get(rateLimitKey)) || '0');
    if (currentRequests >= maxRequests) {
      logErrorAggregated('DATA_HAWK', 'NewsAPI rate limit exceeded');
      return [];
    }

    try {
      const response = await measureLatency(
        () =>
          retry(
            () =>
              axios.get('https://newsapi.org/v2/everything', {
                params: {
                  q: 'solana OR memecoin OR cryptocurrency',
                  sources: 'coindesk,cointelegraph,the-block',
                  apiKey: process.env.NEWSAPI_KEY,
                },
              }),
            { retries: 3 }
          ),
        'newsapi',
        'everything'
      );
      await this.redisClient.incr(rateLimitKey);
      await this.redisClient.expire(rateLimitKey, ttl);
      logInfoAggregated('DATA_HAWK', `Fetched ${response.data.articles.length} news articles`);
      return response.data.articles.filter((article: any) => article.title && article.description);
    } catch (error) {
      logErrorAggregated('DATA_HAWK', `News fetch failed: ${error.message}`);
      return [];
    }
  }

  private async fetchRedditPosts(): Promise<any[]> {
    const cacheKey = 'reddit:solana';
    const cached = await this.redisClient.get(cacheKey);
    if (cached) {
      logInfoAggregated('DATA_HAWK', 'Fetched Reddit posts from cache');
      return JSON.parse(cached);
    }

    try {
      const response = await measureLatency(
        () =>
          retry(
            () =>
              axios.get('https://www.reddit.com/r/solana/hot.json', {
                headers: { 'User-Agent': 'SwingSensei/1.0' },
              }),
            { retries: 3 }
          ),
        'reddit',
        'solana'
      );
      const posts = response.data.data.children
        .map((post: any) => post.data)
        .filter((post: any) => post.title || post.selftext);
      await this.redisClient.setEx(cacheKey, 3600, JSON.stringify(posts));
      logInfoAggregated('DATA_HAWK', `Fetched ${posts.length} Reddit posts`);
      return posts;
    } catch (error) {
      logErrorAggregated('DATA_HAWK', `Reddit fetch failed: ${error.message}`);
      return [];
    }
  }

  private async fetchFearGreedIndex(): Promise<number> {
    const cacheKey = 'fear_greed_index';
    const historyKey = 'fear_greed_history';
    const cached = await this.redisClient.get(cacheKey);
    if (cached) {
      logInfoAggregated('DATA_HAWK', 'Fetched Fear & Greed Index from cache');
      return parseInt(cached);
    }

    try {
      const response = await measureLatency(
        () =>
          retry(
            () => axios.get('https://api.alternative.me/fng/'),
            { retries: 3 }
          ),
        'alternative',
        'fng'
      );
      const value = Number(response.data.data[0].value) || 50;
      await this.redisClient.setEx(cacheKey, 3600, value.toString());
      await this.redisClient.lpush(historyKey, value.toString());
      await this.redisClient.ltrim(historyKey, 0, 23);
      logInfoAggregated('DATA_HAWK', `Fetched Fear & Greed Index: ${value}`);
      return value;
    } catch (error) {
      logErrorAggregated('DATA_HAWK', `Fear & Greed fetch failed: ${error.message}`);
      const history = await this.redisClient.lrange(historyKey, 0, -1);
      if (history.length) {
        const avg = history.reduce((sum, val) => sum + Number(val), 0) / history.length;
        logInfoAggregated('DATA_HAWK', `Using historical Fear & Greed average: ${avg}`);
        return Math.round(avg);
      }
      return 50;
    }
  }

  private async fetchInfluencerPosts(): Promise<any[]> {
    const cacheKey = 'influencer_posts';
    const cached = await this.redisClient.get(cacheKey);
    if (cached) {
      logInfoAggregated('DATA_HAWK', 'Fetched influencer posts from cache');
      return JSON.parse(cached);
    }

    try {
      const tweets = await this.redisClient.lrange('tweets:raw', 0, 100);
      const posts = tweets
        .map((tweet) => JSON.parse(tweet))
        .filter((post) => post.text && post.timestamp);
      await this.redisClient.setEx(cacheKey, 60, JSON.stringify(posts));
      logInfoAggregated('DATA_HAWK', `Fetched ${posts.length} influencer posts`);
      return posts;
    } catch (error) {
      logErrorAggregated('DATA_HAWK', `Influencer posts fetch failed: ${error.message}`);
      return [];
    }
  }

  private async queryDeepSeek(prompt: string): Promise<string> {
    try {
      const response = await retry(
        () =>
          axios.post(
            'https://openrouter.ai/api/v1/completions',
            { prompt, model: 'deepseek' },
            { headers: { Authorization: `Bearer ${process.env.DEEPSEEK_API_KEY}` } }
          ),
        { retries: 3 }
      );
      logInfoAggregated('DEEPSEEK', `Queried DeepSeek: ${prompt}`);
      return response.data.choices[0].text;
    } catch (error) {
      logErrorAggregated('DEEPSEEK', `DeepSeek query failed: ${error.message}`);
      return await this.queryOpenAI(prompt);
    }
  }

  private async queryOpenAI(prompt: string): Promise<string> {
    try {
      const response = await retry(
        () =>
          axios.post(
            'https://api.openai.com/v1/completions',
            { prompt, model: 'text-davinci-003' },
            { headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` } }
          ),
        { retries: 3 }
      );
      logInfoAggregated('OPENAI', `Queried OpenAI: ${prompt}`);
      return response.data.choices[0].text;
    } catch (error) {
      logErrorAggregated('OPENAI', `OpenAI query failed: ${error.message}`);
      return await this.queryChatHub(prompt);
    }
  }

  private async queryYandexGPT(prompt: string): Promise<string> {
    try {
      const response = await retry(
        () =>
          axios.post(
            'https://api.yandex.cloud/v1/completions',
            { prompt },
            { headers: { Authorization: `Bearer ${process.env.YANDEXGPT_API_KEY}` } }
          ),
        { retries: 3 }
      );
      logInfoAggregated('YANDEXGPT', `Queried YandexGPT: ${prompt}`);
      return response.data.result;
    } catch (error) {
      logErrorAggregated('YANDEXGPT', `YandexGPT query failed: ${error.message}`);
      return await this.queryChatHub(prompt);
    }
  }

  private async queryHuggingFace(prompt: string): Promise<string> {
    try {
      const response = await retry(
        () =>
          axios.post(
            'https://api-inference.huggingface.co/models/facebook/bart-large',
            { inputs: prompt },
            { headers: { Authorization: `Bearer ${process.env.HUGGINGFACE_API_KEY}` } }
          ),
        { retries: 3 }
      );
      logInfoAggregated('HUGGINGFACE', `Queried HuggingFace: ${prompt}`);
      return JSON.stringify(response.data[0]);
    } catch (error) {
      logErrorAggregated('HUGGINGFACE', `HuggingFace query failed: ${error.message}`);
      return await this.queryDeepSeek(prompt);
    }
  }

  private async queryChatHub(prompt: string): Promise<string> {
    try {
      const response = await retry(
        () =>
          axios.post(
            'https://api.chathub.io/v1/completions',
            { prompt },
            { headers: { Authorization: `Bearer ${process.env.CHATHUB_API_KEY}` } }
          ),
        { retries: 3 }
      );
      logInfoAggregated('CHATHUB', `Queried ChatHub: ${prompt}`);
      return response.data.result;
    } catch (error) {
      logErrorAggregated('CHATHUB', `ChatHub query failed: ${error.message}`);
      return JSON.stringify({ sentimentScore: 0, impact: 0, confidence: 0.5 });
    }
  }

  private async analyzeText(text: string, ticker: string): Promise<{ sentimentScore: number; impact: number; confidence: number }> {
    if (!text || !ticker) throw new Error('Text and ticker are required');
    const cacheKey = `analysis:${ticker}:${text.slice(0, 50)}`;
    const cached = await this.redisClient.get(cacheKey);
    if (cached) return JSON.parse(cached);

    const prompt = `Analyze text for ${ticker}: "${text}". Return JSON: {"sentimentScore": number, "impact": number, "confidence": number}`;
    try {
      const [deepSeekResponse, secondaryResponse] = await Promise.all([
        this.queryDeepSeek(prompt),
        text.match(/[а-яА-Я]/) ? this.queryYandexGPT(prompt) : this.queryOpenAI(prompt),
      ]);
      const parsedDeepSeek = JSON.parse(deepSeekResponse || '{}');
      const parsedSecondary = JSON.parse(secondaryResponse || '{}');

      const sentimentScore = (parsedDeepSeek.sentimentScore || 0) * 0.7 + (parsedSecondary.sentimentScore || 0) * 0.3;
      const impact = (parsedDeepSeek.impact || 0) * 0.7 + (parsedSecondary.impact || 0) * 0.3;
      const confidence = (parsedDeepSeek.confidence || 0.5) * 0.7 + (parsedSecondary.confidence || 0.5) * 0.3;

      const result = { sentimentScore, impact, confidence };
      await this.redisClient.setEx(cacheKey, 3600, JSON.stringify(result));
      logInfoAggregated('DATA_HAWK', `Analyzed text for ${ticker}: sentiment=${sentimentScore}, impact=${impact}, confidence=${confidence}`);
      return result;
    } catch (error) {
      logErrorAggregated('DATA_HAWK', `Text analysis failed for ${ticker}: ${error.message}`);
      throw new Error(`Text analysis failed: ${error.message}`);
    }
  }

  private async getDynamicTickers(): Promise<string[]> {
    const gmgnTickers = await this.redisClient.hget('tickers', 'gmgn');
    if (gmgnTickers) return JSON.parse(gmgnTickers);

    const apiTickers = await Promise.all(
      this.apiSources.map(async (source) => {
        const cached = await this.redisClient.hget('tickers', source.name);
        return cached ? JSON.parse(cached) : [];
      })
    );
    const tickers = Array.from(new Set(apiTickers.flat())).filter(Boolean);
    logInfoAggregated('DATA_HAWK', `Fetched ${tickers.length} dynamic tickers from APIs`);
    return tickers;
  }

  private async generateSignals(): Promise<NewsSignal[]> {
    const signals: NewsSignal[] = [];
    const fearGreedIndex = await this.fetchFearGreedIndex();
    const [news, redditPosts, influencerPosts] = await Promise.all([
      this.fetchNews(),
      this.fetchRedditPosts(),
      this.fetchInfluencerPosts(),
    ]);

    const allData = [
      ...news.map((article) => ({
        text: article.title + ' ' + article.description,
        source: 'news',
        timestamp: article.publishedAt,
      })),
      ...redditPosts.map((post) => ({
        text: post.title + ' ' + post.selftext,
        source: 'reddit',
        timestamp: new Date(post.created_utc * 1000).toISOString(),
      })),
      ...influencerPosts.map((post) => ({
        text: post.text,
        source: 'twitter',
        timestamp: post.timestamp,
      })),
    ];

    const tickers = await this.getDynamicTickers();
    for (const item of allData) {
      this.newsProcessed.inc({ source: item.source, ticker: 'N/A', agent: 'DataHawk' });
      for (const ticker of tickers) {
        if (item.text.toLowerCase().includes(ticker.toLowerCase())) {
          await retry(
            () =>
              this.newsQueue.add({
                text: item.text,
                ticker,
                source: item.source,
                timestamp: item.timestamp,
                fearGreedIndex,
              }),
            { retries: 3 }
          );
          logInfoAggregated('DATA_HAWK', `Queued signal for ${ticker} from ${item.source}`);
        }
      }
    }

    return signals;
  }

  private async monitorTokens(): Promise<void> {
    const [gmgnTokens, whaleTokens, ...apiTokens] = await Promise.all([
      this.scrapeGMGN(),
      this.fetchWhaleActivity(),
      ...this.apiSources.map((source) => this.apiBreaker.fire(source)),
    ]);
    const allTokens = [...gmgnTokens, ...whaleTokens, ...apiTokens.flat()].filter((token) => token.ticker);
    if (allTokens.length) {
      const validatedTokens = await this.validateTokens(allTokens);
      await this.redisClient.publish('tokens:new', JSON.stringify(validatedTokens));
      logInfoAggregated('DATA_HAWK', `Published ${validatedTokens.length} new tokens`);
    }
  }

  private async validateTokens(tokens: Token[]): Promise<Token[]> {
    const [trending, nextBC, sniper] = await Promise.all([
      this.filterGuard.applyTrending5min(tokens),
      this.filterGuard.applyNextBC5min(tokens),
      this.filterGuard.applySolanaSwingSniper(tokens),
    ]);
    return [...trending, ...nextBC, ...sniper];
  }

  private async processTweetMessages(channel: string, message: string): Promise<void> {
    try {
      if (channel === 'tweets:raw') {
        const tweets = JSON.parse(message);
        await this.redisClient.setEx('influencer_posts', 60, JSON.stringify(tweets));
        logInfoAggregated('DATA_HAWK', `Processed ${tweets.length} tweets`);
      } else if (channel === 'errors:detected') {
        const error = JSON.parse(message);
        logErrorAggregated('DATA_HAWK', `Detected error: ${error.message}`);
      }
    } catch (error) {
      logErrorAggregated('DATA_HAWK', `Failed to process message on ${channel}: ${error.message}`);
    }
  }

  private async setupNewsQueue(): Promise<void> {
    this.newsQueue.process(async (job) => {
      const { text, ticker, source, timestamp, fearGreedIndex } = job.data;
      try {
        const analysis = await this.analyzeText(text, ticker);
        const signal: NewsSignal = {
          ticker,
          sentimentScore: analysis.sentimentScore,
          fearGreedIndex,
          announcementImpact: analysis.impact,
          confidence: analysis.confidence,
          source,
          text,
          timestamp,
        };

        const validated = await this.filterGuard.applyFilters([{ ticker, price: 0, volume: 0, marketCap: 0, priceChange: 0 }], {
          minVolume: 0,
          minPriceChange: 0,
          minMarketCap: 0,
        });
        if (!validated.length) {
          logErrorAggregated('DATA_HAWK', `Signal for ${ticker} failed validation`);
          return;
        }

        await this.redisClient.publish('news:signals', JSON.stringify(signal));
        this.sentimentAccuracy.set({ ticker, agent: 'DataHawk' }, analysis.confidence);
        this.announcementImpact.observe({ ticker, agent: 'DataHawk' }, analysis.impact);

        if (analysis.impact > 0.7) {
          await this.redisClient.publish('signals:notify', JSON.stringify(signal));
        }

        logInfoAggregated('DATA_HAWK', `Published signal for ${ticker} from ${source}`);
      } catch (error) {
        logErrorAggregated('DATA_HAWK', `Queue processing failed for ${ticker}: ${error.message}`);
      }
    });
  }

  private initializeMonitoring(): void {
    this.initializeBrowser().then(() => {
      setInterval(() => this.monitorTokens(), 5 * 60 * 1000);
      this.generateSignals();
      this.redisClient.subscribe('tweets:raw', 'errors:detected', (err, count) => {
        if (err) logErrorAggregated('DATA_HAWK', `Subscription failed: ${err.message}`);
        else logInfoAggregated('DATA_HAWK', `Subscribed to ${count} channels`);
      });
      this.redisClient.on('message', (channel, message) => this.processTweetMessages(channel, message));
      this.setupNewsQueue();
      logInfoAggregated('DATA_HAWK', 'Monitoring initialized');
    });
  }

  async close(): Promise<void> {
    if (this.browser) await this.browser.close();
    logInfoAggregated('DATA_HAWK', 'Browser closed');
  }
}

export default DataHawk;
