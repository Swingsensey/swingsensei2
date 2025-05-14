import winston, { createLogger, format, transports } from 'winston';
import DailyRotateFile from 'winston-daily-rotate-file';
import TelegramBot from 'node-telegram-bot-api';
import { Counter } from 'prom-client';

const { combine, timestamp, printf, json } = format;

class Logger {
  private logger: winston.Logger;
  private telegramBot: TelegramBot | null = null;
  private logErrorsTotal: Counter<string>;

  constructor() {
    // Инициализация Prometheus-метрики
    this.logErrorsTotal = new Counter({
      name: 'log_errors_total',
      help: 'Total number of logged errors',
      labelNames: ['module'],
    });

    // Формат для консоли
    const consoleFormat = printf(({ level, message, timestamp, module }) => {
      return `${timestamp} [${module}] ${level}: ${message}`;
    });

    // Транспорт для файлов (JSON, ротация)
    const fileTransport = new DailyRotateFile({
      filename: 'logs/swingsensei-%DATE%.log',
      datePattern: 'YYYY-MM-DD',
      maxFiles: '7d',
      format: combine(timestamp(), json()),
    });

    // Инициализация Winston
    this.logger = createLogger({
      level: 'info',
      format: combine(timestamp(), json()),
      transports: [
        new transports.Console({ format: consoleFormat }),
        fileTransport,
      ],
    });

    // Инициализация Telegram-бота, если указан токен
    if (process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID) {
      this.telegramBot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN);
    }
  }

  info(module: string, message: string): void {
    this.logger.info(message, { module });
  }

  error(module: string, message: string): void {
    this.logger.error(message, { module });
    this.logErrorsTotal.inc({ module });

    // Отправка критических ошибок в Telegram
    if (this.telegramBot && process.env.TELEGRAM_CHAT_ID) {
      const telegramMessage = `❌ [${module}] ERROR: ${message}`;
      this.telegramBot
        .sendMessage(process.env.TELEGRAM_CHAT_ID, telegramMessage)
        .catch(err => {
          this.logger.error(`Failed to send Telegram notification: ${err.message}`, { module: 'LOGGER' });
        });
    }
  }

  telegram(message: string): void {
    if (this.telegramBot && process.env.TELEGRAM_CHAT_ID) {
      this.telegramBot
        .sendMessage(process.env.TELEGRAM_CHAT_ID, message)
        .catch(err => {
          this.logger.error(`Failed to send Telegram notification: ${err.message}`, { module: 'LOGGER' });
        });
    } else {
      this.logger.warn('Telegram bot not initialized or chat ID missing', { module: 'LOGGER' });
    }
  }
}

// Экземпляр логгера
const logger = new Logger();

// Экспорт функций для совместимости с systemGuard.ts
export const logInfo = (module: string, message: string) => logger.info(module, message);
export const logError = (module: string, message: string) => logger.error(module, message);
export const sendTelegramNotification = (message: string) => logger.telegram(message);
