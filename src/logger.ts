import pino from 'pino';
import { config } from './config.js';

export const logger = pino({
  level: config.LOG_LEVEL,
  // Pretty logs only in local development; structured JSON everywhere else
  // (production on Railway captures stdout; test runs avoid spawning a worker).
  transport:
    config.NODE_ENV === 'development'
      ? {
          target: 'pino-pretty',
          options: { colorize: true, translateTime: 'HH:MM:ss', ignore: 'pid,hostname' },
        }
      : undefined,
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers["x-api-key"]',
      'authpass',
      'ANTHROPIC_API_KEY',
      'TELEGRAM_BOT_TOKEN',
      'WAHA_API_KEY',
    ],
    remove: true,
  },
});

export type Logger = typeof logger;
