import express, { type Express, type Request } from 'express';
import { logger } from './logger.js';
import { healthRouter } from './routes/health.js';
import { wahaWebhookRouter, webhookPath } from './routes/waha.webhook.js';

/** Extend Express Request to carry the raw body (for webhook signature checks). */
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      rawBody?: Buffer;
    }
  }
}

export function createServer(): Express {
  const app = express();
  app.disable('x-powered-by');

  // Capture the raw body so webhook handlers can verify signatures if needed.
  app.use(
    express.json({
      limit: '2mb',
      verify: (req: Request, _res, buf) => {
        req.rawBody = buf;
      },
    }),
  );

  // Lightweight request log (skip health noise).
  app.use((req, _res, next) => {
    if (req.path !== '/health') logger.debug({ method: req.method, path: req.path }, 'request');
    next();
  });

  app.use(healthRouter);
  app.use(wahaWebhookRouter);
  logger.info({ path: webhookPath() }, 'WAHA webhook endpoint mounted');

  return app;
}
