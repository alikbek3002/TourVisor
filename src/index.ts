import { config } from './config.js';
import { logger } from './logger.js';
import { createServer } from './server.js';

async function main(): Promise<void> {
  logger.info(
    { features: config.features, model: config.CLAUDE_MODEL, env: config.NODE_ENV },
    'starting Aisuluu Tourbot',
  );

  // Warn loudly about anything not configured so setup problems are obvious.
  if (!config.features.claude) logger.warn('Claude disabled (no ANTHROPIC_API_KEY or DISABLE_AI=true)');
  if (!config.features.tourvisor) logger.warn('Tourvisor disabled (missing TOURVISOR_AUTH_LOGIN/PASS)');
  if (!config.features.telegram) logger.warn('Telegram alerts disabled (missing token/chat id)');

  const app = createServer();

  const server = app.listen(config.PORT, () => {
    logger.info({ port: config.PORT }, 'HTTP server listening');
  });

  // Warm Tourvisor reference dictionaries (departures/countries) in the background.
  void import('./services/tourvisor/references.js')
    .then(({ warmReferences }) => warmReferences())
    .catch((err) => logger.warn({ err: (err as Error).message }, 'reference warmup failed'));

  // Report WAHA session state + (optionally) register the webhook.
  try {
    const { bootstrapWaha } = await import('./services/waha/bootstrap.js');
    await bootstrapWaha();
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'WAHA bootstrap skipped/failed');
  }

  const shutdown = (signal: string) => {
    logger.info({ signal }, 'shutting down');
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  logger.fatal({ err }, 'fatal startup error');
  process.exit(1);
});
