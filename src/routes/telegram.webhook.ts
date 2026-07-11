import { Router } from 'express';
import { logger } from '../logger.js';
import {
  handleTelegramUpdate,
  telegramSecretToken,
  telegramWebhookPath,
  type TgUpdate,
} from '../services/telegram/control.js';

export const telegramWebhookRouter: Router = Router();

telegramWebhookRouter.post(telegramWebhookPath(), (req, res) => {
  // ACK immediately so Telegram doesn't retry.
  res.status(200).json({ ok: true });

  // Verify the secret token Telegram echoes back (set via setWebhook).
  const secret = req.header('x-telegram-bot-api-secret-token');
  if (secret !== telegramSecretToken()) {
    logger.warn('telegram webhook: bad/missing secret token, ignoring');
    return;
  }

  void handleTelegramUpdate(req.body as TgUpdate);
});
