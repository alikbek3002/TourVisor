import { Router } from 'express';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { companies } from '../core/companies.js';
import { enqueueInbound, handleManagerManualReply } from '../core/pipeline.js';
import { escapeHtml, sendTelegram } from '../services/telegram/notifier.js';
import { parseInbound, parseManagerReply } from '../services/waha/client.js';
import type { WahaWebhookEnvelope } from '../services/waha/types.js';

export const wahaWebhookRouter: Router = Router();

/** The path WAHA should POST events to (optionally guarded by a shared secret). */
export function webhookPath(): string {
  return config.WAHA_WEBHOOK_SECRET
    ? `/webhooks/waha/${config.WAHA_WEBHOOK_SECRET}`
    : '/webhooks/waha';
}

// Last seen status per session — so we announce a company connecting exactly
// once (SCAN_QR_CODE → WORKING), not on every WAHA restart.
const lastSessionStatus = new Map<string, string>();

wahaWebhookRouter.post(webhookPath(), (req, res) => {
  // ACK immediately — WAHA retries on non-2xx and would duplicate the event.
  res.status(200).json({ ok: true });

  try {
    const envelope = req.body as WahaWebhookEnvelope;

    // A session changed state. When a freshly-scanned company session comes
    // online, tell the admins the sale flow is complete.
    if (envelope.event === 'session.status') {
      const status = String((envelope.payload as Record<string, unknown>)?.status ?? '');
      const prev = lastSessionStatus.get(envelope.session);
      lastSessionStatus.set(envelope.session, status);
      logger.info({ session: envelope.session, status }, 'waha session status');
      if (status === 'WORKING' && prev && prev !== 'WORKING') {
        const company = companies.bySession(envelope.session);
        const digits = String(envelope.me?.id ?? '').split('@')[0]?.split(':')[0]?.replace(/\D/g, '');
        void sendTelegram(
          `✅ WhatsApp подключён: «${escapeHtml(company?.name ?? envelope.session)}»${
            digits ? ` (+${digits})` : ''
          } — бот готов отвечать клиентам.`,
        );
      }
      return;
    }

    // Outgoing messages arrive via 'message.any'. If a human manager replied
    // manually (not the bot's own API send), pause the bot for that chat.
    // Incoming messages are handled via the 'message' event below.
    if (envelope.event === 'message.any') {
      const mr = parseManagerReply(envelope);
      if (mr) {
        logger.info({ chatId: mr.chatId, session: envelope.session }, 'manager manual reply detected');
        handleManagerManualReply(envelope.session, mr.chatId);
      }
      return;
    }

    const msg = parseInbound(envelope);
    if (msg) {
      logger.debug({ phone: msg.phone, event: envelope.event, session: msg.session }, 'inbound message');
      enqueueInbound(msg);
    }
  } catch (err) {
    logger.error({ err: (err as Error).message }, 'failed to handle waha webhook');
  }
});
