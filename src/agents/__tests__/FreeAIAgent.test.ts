import { FreeAIAgent } from './FreeAIAgent';
import Redis from 'ioredis';
import axios from 'axios';
import { jest } from '@jest/globals';

jest.mock('axios');
jest.mock('free-proxy', () => ({
  getProxies: jest.fn().mockResolvedValue([{ ip: '1.2.3.4', port: '8080' }]),
}));
jest.mock('ioredis');

describe('FreeAIAgent', () => {
  let agent: FreeAIAgent;
  let redisClient: jest.Mocked<Redis>;

  beforeEach(() => {
    redisClient = new Redis(process.env.REDIS_URL) as jest.Mocked<Redis>;
    agent = new FreeAIAgent({ redisClient });
    jest.clearAllMocks();
  });

  test('should return cached response', async () => {
    const cached = { text: 'negative', confidence: 0.9, provider: 'you' };
    redisClient.get.mockResolvedValue(JSON.stringify(cached));

    const result = await agent.analyze('Test prompt');
    expect(result).toEqual(cached);
    expect(redisClient.get).toHaveBeenCalledWith('gpt4free:response:sentiment:Test prompt');
  });

  test('should rotate providers on failure', async () => {
    axios.post = jest.fn()
      .mockRejectedValueOnce(new Error('You.com failed'))
      .mockResolvedValueOnce({ data: { choices: [{ text: 'negative', confidence: 0.9 }] } });

    const result = await agent.analyze('Test prompt');
    expect(result.provider).toBe('quora');
    expect(axios.post).toHaveBeenCalledTimes(2);
  });

  test('should fallback to gpt4free on io.net 429', async () => {
    axios.post = jest.fn()
      .mockRejectedValueOnce({ response: { status: 429 } })
      .mockResolvedValueOnce({ data: { choices: [{ message: { content: 'negative' } }] } });

    const result = await agent.analyze('Test prompt');
    expect(result.provider).toBe('you');
  });

  test('should log gpt4free block', async () => {
    axios.post = jest.fn().mockRejectedValue({ response: { status: 403 } });
    redisClient.incr.mockResolvedValue(1);

    await expect(agent.analyze('Test prompt')).rejects.toThrow();
    expect(redisClient.incr).toHaveBeenCalledWith('gpt4free:block:you');
  });

  test('should handle invalid task', async () => {
    await expect(agent.processTask('invalid', 'Test prompt')).rejects.toThrow('Invalid task: invalid');
  });

  test('should process all tasks', async () => {
    axios.post = jest.fn().mockResolvedValue({ data: { choices: [{ text: 'result', confidence: 0.9 }] } });
    const tasks = ['analyze', 'arbitrate', 'validate', 'train'];

    for (const task of tasks) {
      const result = await agent[task as keyof FreeAIAgent](['Test prompt']);
      expect(result).toHaveProperty('text', 'result');
    }
  });
});
