import { Router } from 'express';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { enqueueInbound } from '../core/pipeline.js';
import { parseInbound } from '../services/waha/client.js';
import type { WahaWebhookEnvelope } from '../services/waha/types.js';

export const wahaWebhookRouter: Router = Router();

/** The path WAHA should POST events to (optionally guarded by a shared secret). */
export function webhookPath(): string {
  return config.WAHA_WEBHOOK_SECRET
    ? `/webhooks/waha/${config.WAHA_WEBHOOK_SECRET}`
    : '/webhooks/waha';
}

wahaWebhookRouter.post(webhookPath(), (req, res) => {
  // ACK immediately — WAHA retries on non-2xx and would duplicate the event.
  res.status(200).json({ ok: true });

  try {
    const envelope = req.body as WahaWebhookEnvelope;
    const msg = parseInbound(envelope);
    if (msg) {
      logger.debug({ phone: msg.phone, event: envelope.event }, 'inbound message');
      enqueueInbound(msg);
    }
  } catch (err) {
    logger.error({ err: (err as Error).message }, 'failed to handle waha webhook');
  }
});
