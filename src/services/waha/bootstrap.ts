import { config } from '../../config.js';
import { logger } from '../../logger.js';
import { companies } from '../../core/companies.js';
import { ensureSession, fetchQrImage, getSession } from './client.js';
import { escapeHtml, sendTelegram, sendTelegramPhoto } from '../telegram/notifier.js';
import { webhookPath } from '../../routes/waha.webhook.js';

/**
 * Called once on startup. Reports every company's WAHA session state and
 * (optionally) registers our webhook per session. On Railway the recommended
 * setup is WAHA's own WHATSAPP_HOOK_URL (a global default that covers all
 * sessions), so auto-registration is off by default (WAHA_AUTOREGISTER=true
 * opts in — needs PUBLIC_URL).
 */
export async function bootstrapWaha(): Promise<void> {
  const active = companies.list().filter((c) => c.active);

  if (config.WAHA_AUTOREGISTER) {
    if (config.PUBLIC_URL) {
      const hook = `${config.PUBLIC_URL.replace(/\/$/, '')}${webhookPath()}`;
      for (const c of active) await ensureSession(c.session, hook);
      logger.info({ hook, sessions: active.length }, 'WAHA webhooks auto-registered');
    } else {
      logger.warn('WAHA_AUTOREGISTER=true but PUBLIC_URL is not set — cannot register webhook.');
    }
  } else {
    logger.info(
      { expectedHook: webhookPath() },
      'WAHA auto-register disabled — ensure WAHA has WHATSAPP_HOOK_URL pointing at this path.',
    );
  }

  const disconnected: typeof active = [];
  for (const c of active) {
    const info = await getSession(c.session);
    const status = info?.status ?? 'UNKNOWN';
    if (status === 'WORKING') {
      logger.info({ session: c.session, company: c.name, me: info?.me }, 'WAHA session authenticated ✅');
    } else {
      logger.warn(
        { session: c.session, company: c.name, status, dashboard: `${config.WAHA_BASE_URL}/dashboard` },
        '⚠️ WAHA session not connected',
      );
      disconnected.push(c);
    }
  }
  if (!disconnected.length || !config.features.telegram) return;

  // Owner's session keeps the old behaviour: push the login QR straight to
  // Telegram. Other companies just get a summary — spamming N QR codes on
  // every redeploy would be noise; /qr <id> fetches one on demand.
  const owner = disconnected.find((c) => c.session === config.WAHA_SESSION);
  if (owner) {
    try {
      const qr = await fetchQrImage(owner.session);
      if (qr) {
        await sendTelegramPhoto(
          qr,
          `📲 <b>Подключение WhatsApp</b>\nОткройте WhatsApp → Связанные устройства → Привязка устройства и отсканируйте этот QR, чтобы включить бота «${escapeHtml(owner.name)}».`,
        );
        logger.info('WAHA login QR sent to admin Telegram');
      }
    } catch (err) {
      logger.debug({ err: (err as Error).message }, 'QR forward to Telegram failed');
    }
  }

  const others = disconnected.filter((c) => c.session !== config.WAHA_SESSION);
  if (others.length) {
    await sendTelegram(
      [
        '⚠️ <b>Не подключены WhatsApp-сессии компаний:</b>',
        ...others.map((c) => `• [${c.id}] ${escapeHtml(c.name)}`),
        '',
        'Получить QR: /qr &lt;id&gt;',
      ].join('\n'),
    ).catch(() => {});
  }
}
