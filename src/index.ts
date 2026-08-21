import { config } from './config.js';
import { logger } from './logger.js';
import { conversations } from './core/conversation.js';
import { createServer } from './server.js';

async function main(): Promise<void> {
  logger.info(
    {
      features: config.features,
      model: config.features.gemini ? config.GEMINI_MODEL : config.CLAUDE_MODEL,
      env: config.NODE_ENV,
    },
    'starting Aisuluu Tourbot',
  );

  // Warn loudly about anything not configured so setup problems are obvious.
  if (!config.features.ai)
    logger.warn('AI disabled (no GEMINI_API_KEY / ANTHROPIC_API_KEY or DISABLE_AI=true)');
  if (!config.features.tourvisor) logger.warn('Tourvisor disabled (missing TOURVISOR_AUTH_LOGIN/PASS)');
  if (!config.features.telegram) logger.warn('Telegram alerts disabled (missing token/chat id)');
  if (!config.features.postgres)
    logger.warn('Persistence disabled (no DATABASE_URL) — conversations are in-memory only');

  // Durable storage: load persisted conversations before we start taking messages.
  try {
    const { createPersistence } = await import('./core/persistence.js');
    const persistence = createPersistence();
    if (persistence) await conversations.init(persistence);
  } catch (err) {
    logger.error(
      { err: (err as Error).message },
      'persistence init failed — continuing in-memory only',
    );
  }

  // Tenant registry: must be loaded before we accept webhooks, or inbound
  // messages would hit an unknown session and be dropped.
  try {
    const { companies } = await import('./core/companies.js');
    await companies.init();
  } catch (err) {
    logger.error({ err: (err as Error).message }, 'company registry init failed');
  }

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

  // Wire up Telegram control (resume/pause/status/qr) via webhook or polling.
  try {
    const { initTelegramControl } = await import('./services/telegram/control.js');
    await initTelegramControl();
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'Telegram control init skipped/failed');
  }

  // Public demo bot (second Telegram token) — lets prospects try the assistant.
  try {
    const { initDemoBot } = await import('./services/telegram/demo.js');
    await initDemoBot();
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'Telegram demo bot init skipped/failed');
  }

  const shutdown = (signal: string) => {
    logger.info({ signal }, 'shutting down');
    // Best-effort flush of pending conversation writes before we close.
    void conversations
      .flushNow()
      .catch(() => {})
      .finally(() => server.close(() => process.exit(0)));
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  logger.fatal({ err }, 'fatal startup error');
  process.exit(1);
});
