import winston from 'winston';
import { Counter, Gauge } from 'prom-client';
import axios from 'axios';

// Инициализация логгера Winston
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [
    new winston.transports.File({ filename: 'logs/error.log', level: 'error' }),
    new winston.transports.File({ filename: 'logs/combined.log' }),
    new winston.transports.Console()
  ]
});

// Инициализация метрик Prometheus
const metricCounter = new Counter({
  name: 'swingsensei_events_total',
  help: 'Total events in SwingSensei',
  labelNames: ['event', 'ticker', 'filter']
});

const healthGauge = new Gauge({
  name: 'swingsensei_health_status',
  help: 'Health status of SwingSensei agents',
  labelNames: ['agent']
});

// Логирование информационных сообщений
export function logInfoAggregated(module: string, message: string): void {
  logger.info({ module, message });
}

// Логирование ошибок
export function logErrorAggregated(module: string, message: string): void {
  logger.error({ module, message });
}

// Отправка алертов в Telegram
export async function sendTelegramAlert(message: string, chatId: string): Promise<void> {
  try {
    const botToken = process.env.TELEGRAM_BOT_TOKEN;
    if (!botToken || !chatId) {
      logger.error({ module: 'SYSTEMGUARD', message: 'Telegram bot token or chat ID missing' });
      return;
    }
    const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
    await axios.post(url, {
      chat_id: chatId,
      text: message
    });
    logger.info({ module: 'SYSTEMGUARD', message: `Telegram alert sent: ${message}` });
  } catch (error) {
    logger.error({ module: 'SYSTEMGUARD', message: `Telegram alert error: ${error.message}` });
  }
}

// Запись метрик для Prometheus
export function recordMetric(event: string, labels: Record<string, string>): void {
  try {
    metricCounter.inc({ event, ...labels });
    logger.info({ module: 'SYSTEMGUARD', message: `Metric recorded: ${event}`, labels });
  } catch (error) {
    logger.error({ module: 'SYSTEMGUARD', message: `Metric recording error: ${error.message}` });
  }
}

// Установка статуса здоровья агента
export function setAgentHealth(agent: string, status: 'up' | 'down'): void {
  const value = status === 'up' ? 1 : 0;
  healthGauge.set({ agent }, value);
  logger.info({ module: 'SYSTEMGUARD', message: `Agent ${agent} health set to ${status}` });
}
