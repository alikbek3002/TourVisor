import { config } from '../../config.js';
import { logger } from '../../logger.js';
import { postJson } from '../../util/http.js';

/**
 * Telegram admin notifier.
 *
 * Purpose: push operational alerts to a human (admin/manager) when the bot
 * needs attention — a client wants to buy, a complaint, or an internal error.
 * Outbound-only; no polling. Uses the plain Bot API sendMessage endpoint.
 */

interface InlineButton {
  text: string;
  url?: string;
  callback_data?: string;
}

interface SendMessagePayload {
  chat_id: string;
  text: string;
  parse_mode?: 'HTML' | 'MarkdownV2';
  disable_web_page_preview?: boolean;
  reply_markup?: { inline_keyboard: InlineButton[][] };
}

export function apiUrl(method: string): string {
  return `https://api.telegram.org/bot${config.TELEGRAM_BOT_TOKEN}/${method}`;
}

/** Escape text for Telegram HTML parse mode. */
export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Low-level send. No-op (logged) if Telegram isn't configured. */
export async function sendTelegram(
  text: string,
  opts: { buttons?: InlineButton[][]; chatId?: string } = {},
): Promise<void> {
  if (!config.features.telegram) {
    logger.warn({ text: text.slice(0, 120) }, 'telegram not configured — alert dropped');
    return;
  }
  const targets = opts.chatId ? [opts.chatId] : config.adminChatIds;
  for (const chatId of targets) {
    const payload: SendMessagePayload = {
      chat_id: chatId,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      ...(opts.buttons ? { reply_markup: { inline_keyboard: opts.buttons } } : {}),
    };
    try {
      await postJson(apiUrl('sendMessage'), payload, { retries: 2 });
    } catch (err) {
      logger.error({ err: (err as Error).message, chatId }, 'failed to send telegram alert');
    }
  }
}

/**
 * Send a photo (e.g. the WAHA login QR code) to the admin chat via multipart
 * upload. Used so an operator can connect WhatsApp straight from Telegram.
 */
export async function sendTelegramPhoto(
  photo: Uint8Array,
  caption?: string,
  chatId?: string,
): Promise<void> {
  if (!config.features.telegram) {
    logger.warn('telegram not configured — photo dropped');
    return;
  }
  const targets = chatId ? [chatId] : config.adminChatIds;
  for (const target of targets) {
    try {
      const form = new FormData();
      form.set('chat_id', target);
      if (caption) {
        form.set('caption', caption);
        form.set('parse_mode', 'HTML');
      }
      form.set('photo', new Blob([photo], { type: 'image/png' }), 'qr.png');
      const res = await fetch(apiUrl('sendPhoto'), { method: 'POST', body: form });
      if (!res.ok) {
        const t = await res.text().catch(() => '');
        logger.error(
          { status: res.status, body: t.slice(0, 200), chatId: target },
          'telegram sendPhoto failed',
        );
      }
    } catch (err) {
      logger.error({ err: (err as Error).message, chatId: target }, 'failed to send telegram photo');
    }
  }
}

/** Build a wa.me deep link to open a WhatsApp chat with a phone (digits only). */
export function waMeLink(phoneDigits: string, prefilledText?: string): string {
  const base = `https://wa.me/${phoneDigits.replace(/\D/g, '')}`;
  return prefilledText ? `${base}?text=${encodeURIComponent(prefilledText)}` : base;
}

export interface LeadAlert {
  reason: 'buying_intent' | 'complaint' | 'manager_request' | 'error' | 'handoff';
  clientPhone: string; // digits, e.g. 996555123456
  clientName?: string;
  /** WhatsApp chatId (may be an "@lid" id) — used for the resume button. */
  clientChatId?: string;
  summary: string; // what the client wants / the problem
  lastMessage?: string;
  tourLink?: string;
}

const REASON_LABEL: Record<LeadAlert['reason'], string> = {
  buying_intent: '🟢 Клиент готов к покупке',
  complaint: '🔴 Жалоба / проблема клиента',
  manager_request: '🟡 Клиент просит менеджера',
  handoff: '🤝 Передача менеджеру',
  error: '⚠️ Техническая ошибка',
};

/**
 * Send a structured lead/alert to the admin chat with quick-action buttons:
 * open the WhatsApp chat with the client, and (optionally) the tour link.
 */
export async function notifyAdmin(alert: LeadAlert): Promise<void> {
  const chatId = alert.clientChatId;
  // Phone is "unknown" when it's just the "@lid" privacy id copied verbatim
  // (WhatsApp hid the real number) — don't show it as a callable +number.
  const phoneKnown =
    Boolean(alert.clientPhone) && chatId?.split('@')[0]?.replace(/\D/g, '') !== alert.clientPhone;

  const lines = [
    `<b>${REASON_LABEL[alert.reason]}</b>`,
    '',
    `<b>Клиент:</b> ${escapeHtml(alert.clientName || 'без имени')}${
      phoneKnown ? ` (+${alert.clientPhone})` : ' (номер скрыт WhatsApp)'
    }`,
    `<b>Суть:</b> ${escapeHtml(alert.summary)}`,
  ];
  if (alert.lastMessage) lines.push(`<b>Последнее сообщение:</b> ${escapeHtml(alert.lastMessage)}`);
  if (alert.tourLink) lines.push(`<b>Тур:</b> ${escapeHtml(alert.tourLink)}`);

  const buttons: InlineButton[][] = [];
  if (phoneKnown) {
    buttons.push([{ text: '💬 Написать клиенту в WhatsApp', url: waMeLink(alert.clientPhone) }]);
  }
  if (alert.tourLink) buttons.push([{ text: '🔗 Открыть тур', url: alert.tourLink }]);
  // Let the manager hand the conversation back to the bot with one tap.
  buttons.push([
    { text: '▶️ Вернуть диалог боту', callback_data: `resume:${chatId ?? `${alert.clientPhone}@c.us`}` },
  ]);

  await sendTelegram(lines.join('\n'), { buttons: buttons.length ? buttons : undefined });
}

/** Plain error/ops alert (no client context). */
export async function notifyError(context: string, err: unknown): Promise<void> {
  const msg = err instanceof Error ? err.message : String(err);
  await sendTelegram(
    `${REASON_LABEL.error}\n\n<b>${escapeHtml(context)}</b>\n<pre>${escapeHtml(msg.slice(0, 500))}</pre>`,
  );
}
