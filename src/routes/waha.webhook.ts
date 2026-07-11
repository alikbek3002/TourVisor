import { Router } from 'express';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { enqueueInbound, handleManagerManualReply } from '../core/pipeline.js';
import { parseInbound, parseManagerReply } from '../services/waha/client.js';
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

    // Outgoing messages arrive via 'message.any'. If a human manager replied
    // manually (not the bot's own API send), pause the bot for that chat.
    // Incoming messages are handled via the 'message' event below.
    if (envelope.event === 'message.any') {
      const mr = parseManagerReply(envelope);
      if (mr) {
        logger.info({ chatId: mr.chatId }, 'manager manual reply detected');
        handleManagerManualReply(mr.chatId);
      }
      return;
    }

    const msg = parseInbound(envelope);
    if (msg) {
      logger.debug({ phone: msg.phone, event: envelope.event }, 'inbound message');
      enqueueInbound(msg);
    }
  } catch (err) {
    logger.error({ err: (err as Error).message }, 'failed to handle waha webhook');
  }
});
