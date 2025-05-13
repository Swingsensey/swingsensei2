import { Client } from 'gpt4free';
import axios, { AxiosError } from 'axios';
import axiosRetry from 'axios-retry';
import Redis from 'ioredis';
import CircuitBreaker from 'opossum';
import { getProxies } from 'free-proxy';
import { logInfo, logError } from './systemGuard';

interface AIResponse {
  text: string;
  confidence: number;
  provider: string;
}

interface FreeAIAgentConfig {
  redisClient: Redis;
  poolSize?: number;
  defaultProxy?: string;
}

class FreeAIAgent {
  private readonly client: Client;
  private readonly redisClient: Redis;
  private readonly providers: string[] = ['you', 'quora', 'cocalc'];
  private readonly ionetBaseUrl = 'https://api.io.net/v1/intelligence';
  private readonly circuitBreaker: CircuitBreaker;
  private proxies: string[] = [];

  constructor({ redisClient, poolSize = 1, defaultProxy = '' }: FreeAIAgentConfig) {
    this.redisClient = redisClient;
    this.client = new Client({ poolSize, proxy: defaultProxy });
    this.initializeCircuitBreaker();
    this.initializeProxies().catch(err => logError('FREE_AI_AGENT', `Proxy init error: ${err.message}`));

    axiosRetry(axios, {
      retries: 3,
      retryDelay: axiosRetry.exponentialDelay,
      retryCondition: (error) => error.response?.status >= 500 || error.code === 'ECONNABORTED',
    });
  }

  private initializeCircuitBreaker(): void {
    this.circuitBreaker = new CircuitBreaker(
      async (provider: string, task: string, prompt: string) => this.executeRequest(provider, task, prompt),
      { timeout: 10000, errorThresholdPercentage: 50, resetTimeout: 30000 }
    );
  }

  private async initializeProxies(): Promise<void> {
    this.proxies = (await getProxies()).map(p => `http://${p.ip}:${p.port}`);
    if (this.proxies.length === 0) {
      this.proxies = [process.env.HTTP_PROXY || ''];
      logError('FREE_AI_AGENT', 'No proxies available, using default');
    }
    logInfo('FREE_AI_AGENT', `Initialized ${this.proxies.length} proxies`);
  }

  private getRandomProxy(): string {
    return this.proxies[Math.floor(Math.random() * this.proxies.length)] || process.env.HTTP_PROXY || '';
  }

  private async getCachedResponse(task: string, prompt: string): Promise<AIResponse | null> {
    const cacheKey = `gpt4free:response:${task}:${prompt}`;
    const cached = await this.redisClient.get(cacheKey);
    if (cached) {
      logInfo('FREE_AI_AGENT', `Cache hit for ${cacheKey}`);
      return JSON.parse(cached);
    }
    return null;
  }

  private async cacheResponse(task: string, prompt: string, response: AIResponse): Promise<void> {
    const cacheKey = `gpt4free:response:${task}:${prompt}`;
    await this.redisClient.setEx(cacheKey, 3600, JSON.stringify(response));
  }

  private async executeRequest(provider: string, task: string, prompt: string): Promise<AIResponse> {
    const cachedResponse = await this.getCachedResponse(task, prompt);
    if (cachedResponse) return cachedResponse;

    const response = provider === 'ionet' ? await this.callIoNet(task, prompt) : await this.callGpt4Free(provider, task, prompt);
    await this.cacheResponse(task, prompt, response);
    return response;
  }

  private async callGpt4Free(provider: string, task: string, prompt: string): Promise<AIResponse> {
    try {
      this.client.proxy = this.getRandomProxy();
      const response = await this.client.chat.completions.create({
        model: 'gpt-4o',
        messages: [{ role: 'user', content: prompt }],
        provider,
      });
      const result: AIResponse = {
        text: response.choices[0].message.content,
        confidence: 0.9,
        provider,
      };
      await this.redisClient.incr(`free_api_requests:${provider}:${task}`);
      return result;
    } catch (error) {
      const err = error as Error | AxiosError;
      await this.redisClient.incr(`error:${provider}:${task}`);
      if (err.message.includes('blocked') || (err as AxiosError).response?.status === 403) {
        await this.redisClient.incr(`gpt4free:block:${provider}`);
        logInfo('FREE_AI_AGENT', `Provider ${provider} blocked`);
      }
      logError('FREE_AI_AGENT', `Gpt4free error with ${provider}: ${err.message}`);
      throw new Error(`Gpt4free failed: ${err.message}`);
    }
  }

  private async callIoNet(task: string, prompt: string): Promise<AIResponse> {
    try {
      const response = await axios.post(
        `${this.ionetBaseUrl}/completions`,
        { prompt, model: 'default' },
        { headers: { Authorization: `Bearer ${process.env.IONET_API_KEY}` } }
      );
      const result: AIResponse = {
        text: response.data.choices[0].text,
        confidence: response.data.choices[0].confidence || 0.9,
        provider: 'ionet',
      };
      await this.redisClient.incr(`free_api_requests:ionet:${task}`);
      return result;
    } catch (error) {
      const err = error as AxiosError;
      await this.redisClient.incr(`error:ionet:${task}`);
      if (err.response?.status === 429 || err.response?.status === 401) {
        logInfo('FREE_AI_AGENT', `Io.net error ${err.response.status}, falling back to gpt4free`);
        return this.callGpt4Free(this.providers[0], task, prompt);
      }
      logError('FREE_AI_AGENT', `Io.net error: ${err.message}`);
      throw new Error(`Io.net failed: ${err.message}`);
    }
  }

  async processTask(task: string, prompt: string): Promise<AIResponse> {
    if (!['sentiment', 'arbitrage', 'validation', 'training'].includes(task)) {
      throw new Error(`Invalid task: ${task}`);
    }
    for (const provider of [...this.providers, 'ionet']) {
      try {
        return await this.circuitBreaker.fire(provider, task, prompt);
      } catch {
        logError('FREE_AI_AGENT', `Provider ${provider} failed, trying next`);
      }
    }
    throw new Error('All providers failed');
  }

  async analyze(prompt: string): Promise<AIResponse> {
    return this.processTask('sentiment', prompt);
  }

  async arbitrate(prompt: string): Promise<AIResponse> {
    return this.processTask('arbitrage', prompt);
  }

  async validate(prompt: string): Promise<AIResponse> {
    return this.processTask('validation', prompt);
  }

  async train(prompt: string): Promise<AIResponse> {
    return this.processTask('training', prompt);
  }
}
