import { config } from '../../config.js';
import { logger } from '../../logger.js';
import { ensureSession, fetchQrImage, getSession } from './client.js';
import { escapeHtml, sendTelegramPhoto } from '../telegram/notifier.js';
import { webhookPath } from '../../routes/waha.webhook.js';

/**
 * Called once on startup. Reports the WAHA session state and (optionally)
 * registers our webhook. On Railway the recommended setup is to configure the
 * webhook via WAHA's own WHATSAPP_HOOK_URL env var, so auto-registration is off
 * by default (WAHA_AUTOREGISTER=true opts in — needs PUBLIC_URL).
 */
export async function bootstrapWaha(): Promise<void> {
  const session = await getSession();

  if (config.WAHA_AUTOREGISTER) {
    if (config.PUBLIC_URL) {
      const hook = `${config.PUBLIC_URL.replace(/\/$/, '')}${webhookPath()}`;
      await ensureSession(hook);
      logger.info({ hook }, 'WAHA webhook auto-registered');
    } else {
      logger.warn('WAHA_AUTOREGISTER=true but PUBLIC_URL is not set — cannot register webhook.');
    }
  } else {
    logger.info(
      { expectedHook: webhookPath() },
      'WAHA auto-register disabled — ensure WAHA has WHATSAPP_HOOK_URL pointing at this path.',
    );
  }

  const status = session?.status ?? 'UNKNOWN';
  if (status === 'WORKING') {
    logger.info({ me: session?.me }, 'WAHA session authenticated ✅');
  } else {
    logger.warn(
      { status, dashboard: `${config.WAHA_BASE_URL}/dashboard` },
      '⚠️ WAHA session not connected. Open the WAHA dashboard, start the "default" session, and scan the QR code with WhatsApp → Linked devices.',
    );
    // Best-effort: forward the login QR to the admin's Telegram so they can
    // connect WhatsApp without opening the WAHA dashboard (handy on Railway).
    if (config.features.telegram) {
      try {
        const qr = await fetchQrImage();
        if (qr) {
          await sendTelegramPhoto(
            qr,
            `📲 <b>Подключение WhatsApp</b>\nОткройте WhatsApp → Связанные устройства → Привязка устройства и отсканируйте этот QR, чтобы включить бота «${escapeHtml(config.COMPANY_NAME)}».`,
          );
          logger.info('WAHA login QR sent to admin Telegram');
        }
      } catch (err) {
        logger.debug({ err: (err as Error).message }, 'QR forward to Telegram failed');
      }
    }
  }
}
