import pino from 'pino';
import { config } from './config.js';

export const logger = pino({
  level: config.LOG_LEVEL,
  // Pretty logs in dev; structured JSON in production (Railway captures stdout).
  transport: config.isProd
    ? undefined
    : {
        target: 'pino-pretty',
        options: { colorize: true, translateTime: 'HH:MM:ss', ignore: 'pid,hostname' },
      },
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
