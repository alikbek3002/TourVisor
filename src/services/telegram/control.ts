import { createHash } from 'node:crypto';
import { config } from '../../config.js';
import { logger } from '../../logger.js';
import { conversations } from '../../core/conversation.js';
import { postJson } from '../../util/http.js';
import { apiUrl, sendTelegram, sendTelegramPhoto } from './notifier.js';
import { fetchQrImage, getSession, phoneToChatId } from '../waha/client.js';

/**
 * Telegram control plane — lets the manager drive the bot from the admin chat:
 * resume a conversation the bot handed off, pause the bot, check status, or
 * re-request the WhatsApp login QR. Works via webhook (when PUBLIC_URL is set,
 * e.g. on Railway) or long-polling as a fallback for local dev.
 *
 * Only the configured admin chat is allowed to issue commands.
 */

// --- minimal Telegram update shapes (only the fields we read) ---------------
interface TgChat {
  id: number | string;
  type?: string;
}
interface TgUser {
  id: number;
  first_name?: string;
}
interface TgMessage {
  message_id: number;
  chat: TgChat;
  from?: TgUser;
  text?: string;
}
interface TgCallbackQuery {
  id: string;
  from: TgUser;
  message?: TgMessage;
  data?: string;
}
export interface TgUpdate {
  update_id: number;
  message?: TgMessage;
  callback_query?: TgCallbackQuery;
}

/** Path Telegram posts updates to (guarded by a secret header, not the path). */
export function telegramWebhookPath(): string {
  return '/webhooks/telegram';
}

/**
 * Secret used as Telegram's `secret_token` (sent back in the
 * X-Telegram-Bot-Api-Secret-Token header). Derived from the bot token so no
 * extra env var is needed, and unguessable without the token.
 */
export function telegramSecretToken(): string {
  return createHash('sha256')
    .update(config.TELEGRAM_BOT_TOKEN ?? 'no-token')
    .digest('hex')
    .slice(0, 40);
}

interface TgResponse<T = unknown> {
  ok: boolean;
  result?: T;
  description?: string;
}

async function callTg<T = unknown>(method: string, body: unknown): Promise<TgResponse<T> | null> {
  try {
    return await postJson<TgResponse<T>>(apiUrl(method), body, {
      retries: 1,
      timeoutMs: method === 'getUpdates' ? 35_000 : 10_000,
    });
  } catch (err) {
    logger.debug({ err: (err as Error).message, method }, 'telegram api call failed');
    return null;
  }
}

function isFromAdmin(chatId?: number | string): boolean {
  return chatId != null && config.adminChatIds.includes(String(chatId));
}

/** Accept either a bare phone ("996...") or a full chatId ("996...@c.us"). */
function resolveChatId(arg: string): string {
  return arg.includes('@') ? arg : phoneToChatId(arg);
}

const HELP = [
  '<b>Управление ботом</b>',
  '',
  '/status — статус WhatsApp и диалогов',
  '/resume &lt;номер&gt; — вернуть диалог боту',
  '/pause &lt;номер&gt; [минуты] — пауза (без числа — бессрочно)',
  '/qr — получить QR для подключения WhatsApp',
  '',
  'Номер в международном формате, напр. <code>996555123456</code>.',
].join('\n');

export async function handleTelegramUpdate(update: TgUpdate): Promise<void> {
  try {
    if (update.callback_query) {
      await handleCallback(update.callback_query);
      return;
    }
    if (update.message?.text) {
      await handleCommand(update.message);
    }
  } catch (err) {
    logger.error({ err: (err as Error).message }, 'telegram update handler failed');
  }
}

async function handleCommand(message: TgMessage): Promise<void> {
  if (!isFromAdmin(message.chat?.id)) return; // silently ignore non-admins
  const text = (message.text ?? '').trim();
  if (!text.startsWith('/')) return;

  const parts = text.split(/\s+/);
  const cmd = (parts[0] ?? '').toLowerCase().split('@')[0];

  switch (cmd) {
    case '/start':
    case '/help':
      await sendTelegram(HELP);
      return;
    case '/status':
      await handleStatus();
      return;
    case '/resume':
      await handleResume(parts[1]);
      return;
    case '/pause':
      await handlePause(parts[1], parts[2]);
      return;
    case '/qr':
      await handleQr();
      return;
    default:
      await sendTelegram('Неизвестная команда. /help — список команд.');
  }
}

async function handleStatus(): Promise<void> {
  const { total, human } = conversations.stats();
  const session = await getSession();
  const status = session?.status ?? 'UNKNOWN';
  const humans =
    conversations
      .listHuman(15)
      .map((h) => `• +${h.phone}`)
      .join('\n') || '—';
  await sendTelegram(
    [
      '<b>Статус</b>',
      `WhatsApp-сессия: <b>${status}</b>`,
      `Диалогов в памяти: ${total} (на менеджере: ${human})`,
      human ? `\nНа ручном режиме:\n${humans}` : '',
    ]
      .filter(Boolean)
      .join('\n'),
  );
}

async function handleResume(arg?: string): Promise<void> {
  if (!arg) {
    await sendTelegram('Укажите номер: <code>/resume 996555123456</code>');
    return;
  }
  const chatId = resolveChatId(arg);
  const convo = conversations.get(chatId);
  if (!convo) {
    await sendTelegram(`Диалог не найден: ${chatId}`);
    return;
  }
  conversations.returnToBot(convo);
  await sendTelegram(`✅ Бот снова отвечает клиенту +${convo.phone}.`);
  logger.info({ chatId }, 'bot resumed via telegram');
}

async function handlePause(arg?: string, minutesArg?: string): Promise<void> {
  if (!arg) {
    await sendTelegram('Укажите номер: <code>/pause 996555123456 [минуты]</code>');
    return;
  }
  const chatId = resolveChatId(arg);
  const convo = conversations.get(chatId);
  if (!convo) {
    await sendTelegram(`Диалог не найден: ${chatId}`);
    return;
  }
  const minutes = Number(minutesArg);
  const muteMs = Number.isFinite(minutes) && minutes > 0 ? minutes * 60_000 : null;
  conversations.handToHuman(convo, muteMs);
  await sendTelegram(
    `⏸ Бот на паузе для +${convo.phone}${muteMs ? ` на ${minutes} мин` : ' (бессрочно)'}.`,
  );
  logger.info({ chatId, muteMs }, 'bot paused via telegram');
}

async function handleQr(): Promise<void> {
  const qr = await fetchQrImage();
  if (qr) {
    await sendTelegramPhoto(qr, '📲 Отсканируйте QR в WhatsApp → Связанные устройства.');
  } else {
    await sendTelegram('QR недоступен — возможно, сессия уже подключена. Проверьте /status.');
  }
}

async function handleCallback(cq: TgCallbackQuery): Promise<void> {
  if (!isFromAdmin(cq.message?.chat?.id)) {
    await callTg('answerCallbackQuery', { callback_query_id: cq.id, text: '⛔ Не авторизовано' });
    return;
  }

  const [action, ...rest] = (cq.data ?? '').split(':');
  const chatId = rest.join(':');
  const convo = chatId ? conversations.get(chatId) : undefined;

  let toast: string;
  if (!convo) {
    toast = 'Диалог не найден';
  } else if (action === 'resume') {
    conversations.returnToBot(convo);
    toast = '▶️ Бот включён';
    await sendTelegram(`✅ Бот снова отвечает клиенту +${convo.phone}.`);
    logger.info({ chatId }, 'bot resumed via telegram button');
  } else if (action === 'pause') {
    conversations.handToHuman(convo, null);
    toast = '⏸ Пауза';
    await sendTelegram(`⏸ Бот на паузе для +${convo.phone}.`);
  } else {
    toast = 'Неизвестное действие';
  }

  await callTg('answerCallbackQuery', { callback_query_id: cq.id, text: toast });
}

// --- startup wiring ---------------------------------------------------------

let polling = false;

/** Register the webhook (with PUBLIC_URL) or start long-polling as a fallback. */
export async function initTelegramControl(): Promise<void> {
  if (!config.features.telegram) return;

  if (config.PUBLIC_URL) {
    const url = `${config.PUBLIC_URL.replace(/\/$/, '')}${telegramWebhookPath()}`;
    const res = await callTg('setWebhook', {
      url,
      secret_token: telegramSecretToken(),
      allowed_updates: ['message', 'callback_query'],
      drop_pending_updates: false,
    });
    if (res?.ok) logger.info({ url }, 'Telegram control webhook registered ✅');
    else logger.warn({ url, description: res?.description }, 'Telegram setWebhook did not confirm');
  } else {
    logger.info('No PUBLIC_URL — using Telegram long-polling for control commands');
    await callTg('deleteWebhook', { drop_pending_updates: false });
    startPolling();
  }
}

function startPolling(): void {
  if (polling) return;
  polling = true;
  let offset = 0;
  const loop = async (): Promise<void> => {
    while (polling) {
      const res = await callTg<TgUpdate[]>('getUpdates', {
        offset,
        timeout: 30,
        allowed_updates: ['message', 'callback_query'],
      });
      const updates = res?.result ?? [];
      for (const u of updates) {
        offset = u.update_id + 1;
        await handleTelegramUpdate(u);
      }
      if (!res) await new Promise((r) => setTimeout(r, 2000)); // brief backoff on error
    }
  };
  void loop();
}
