import { config } from '../config.js';
import { logger } from '../logger.js';
import { companies } from './companies.js';
import { conversations, convoKey } from './conversation.js';
import { matchesAllowlist } from './allowlist.js';
import { runAgentTurn } from '../services/claude/agent.js';
import { searchTours } from '../services/tourvisor/search.js';
import { notifyAdmin, notifyError } from '../services/telegram/notifier.js';
import { sendSeen, sendText, startTyping, stopTyping } from '../services/waha/client.js';
import type { InboundMessage } from '../services/waha/types.js';

/**
 * Message pipeline: turns a normalized inbound WhatsApp message into a reply.
 *
 * Guarantees:
 *  - Messages for the same chat are processed one-at-a-time (serialized) so a
 *    burst of texts doesn't spawn overlapping Claude turns.
 *  - Failures never crash the process; the client gets a graceful fallback and
 *    the admin is alerted.
 */

// Per-chat serialization: chain promises so each chat processes sequentially.
// Keyed by (session, chatId) — the same client texting two companies is two chats.
const chatQueues = new Map<string, Promise<void>>();

// Per-chat debounce buffer: collect a burst of messages and answer once.
interface PendingBatch {
  latest: InboundMessage; // keep latest metadata (name/phone/session)
  texts: string[];
  timer: NodeJS.Timeout;
}
const pendingBatches = new Map<string, PendingBatch>();

export function enqueueInbound(msg: InboundMessage): void {
  const company = companies.bySession(msg.session);
  if (!company?.active) {
    logger.warn({ session: msg.session, phone: msg.phone }, 'message for unknown/inactive company — dropped');
    return;
  }

  const debounceMs = config.MESSAGE_DEBOUNCE_MS;
  if (debounceMs <= 0) {
    schedule(msg);
    return;
  }

  // Acknowledge delivery right away (blue ticks) even though we hold the reply.
  void sendSeen(msg.session, msg.chatId).catch(() => {});

  const key = convoKey(msg.session, msg.chatId);
  const existing = pendingBatches.get(key);
  if (existing) {
    clearTimeout(existing.timer);
    existing.texts.push(msg.text);
    existing.latest = msg;
    existing.timer = armBatchTimer(key, debounceMs);
  } else {
    pendingBatches.set(key, {
      latest: msg,
      texts: [msg.text],
      timer: armBatchTimer(key, debounceMs),
    });
  }
}

function armBatchTimer(key: string, ms: number): NodeJS.Timeout {
  const t = setTimeout(() => flushBatch(key), ms);
  t.unref?.();
  return t;
}

/** Fire the collected burst as a single combined message. */
function flushBatch(key: string): void {
  const batch = pendingBatches.get(key);
  if (!batch) return;
  pendingBatches.delete(key);
  const combined: InboundMessage = { ...batch.latest, text: batch.texts.join('\n') };
  schedule(combined);
}

/** Queue a message for sequential per-chat processing. */
function schedule(msg: InboundMessage): void {
  const key = convoKey(msg.session, msg.chatId);
  const prev = chatQueues.get(key) ?? Promise.resolve();
  const next = prev.then(() => handleInbound(msg)).catch((err) => {
    logger.error({ err: (err as Error).message, chatId: msg.chatId, session: msg.session }, 'pipeline error');
  });
  // Clean the map entry once this is the tail of the queue.
  chatQueues.set(key, next);
  void next.finally(() => {
    if (chatQueues.get(key) === next) chatQueues.delete(key);
  });
}

async function handleInbound(msg: InboundMessage): Promise<void> {
  // Re-resolve — the company may have been deactivated while the message was queued.
  const company = companies.bySession(msg.session);
  if (!company?.active) return;

  if (!isAllowed(msg)) {
    logger.debug({ phone: msg.phone }, 'message from non-allowlisted number, ignoring');
    return;
  }

  const convo = conversations.getOrCreate(msg.session, msg.chatId, msg.phone, msg.name);

  // If a human has taken over, stay silent (but keep the message in history).
  if (!conversations.isBotActive(convo)) {
    conversations.appendUser(convo, msg.text);
    logger.info({ phone: msg.phone, session: msg.session }, 'chat in human mode — bot staying silent');
    return;
  }

  conversations.appendUser(convo, msg.text);

  // If AI is not configured, hand off to a human immediately.
  if (!config.features.claude) {
    conversations.handToHuman(convo);
    await notifyAdmin({
      reason: 'manager_request',
      clientPhone: msg.phone,
      clientChatId: msg.chatId,
      clientName: msg.name,
      company: company.name,
      session: msg.session,
      summary: 'AI отключён — требуется ручной ответ',
      lastMessage: msg.text,
    });
    await sendText(
      msg.session,
      msg.chatId,
      `Здравствуйте! Спасибо за сообщение 🙌 Наш менеджер ${config.MANAGER_NAME} скоро свяжется с вами.`,
    );
    return;
  }

  await sendSeen(msg.session, msg.chatId);
  await startTyping(msg.session, msg.chatId);
  try {
    const result = await runAgentTurn(convo, { searchTours }, company);
    await stopTyping(msg.session, msg.chatId);
    await sendText(msg.session, msg.chatId, result.reply);
    logger.info({ phone: msg.phone, session: msg.session, escalated: result.escalated }, 'replied');
  } catch (err) {
    await stopTyping(msg.session, msg.chatId).catch(() => {});
    logger.error({ err: (err as Error).message, phone: msg.phone, session: msg.session }, 'agent turn failed');
    await notifyError(`Ошибка при ответе клиенту +${msg.phone} («${company.name}»)`, err);
    await sendText(
      msg.session,
      msg.chatId,
      'Извините, возникла техническая заминка 🙏 Я передал ваш запрос менеджеру — он скоро свяжется.',
    ).catch(() => {});
    conversations.handToHuman(convo, 1000 * 60 * 30); // mute bot for 30 min
    await notifyAdmin({
      reason: 'error',
      clientPhone: msg.phone,
      clientChatId: msg.chatId,
      clientName: msg.name,
      company: company.name,
      session: msg.session,
      summary: 'Бот не смог обработать запрос',
      lastMessage: msg.text,
    }).catch(() => {});
  }
}

function isAllowed(msg: InboundMessage): boolean {
  return matchesAllowlist(msg.phone, msg.chatId, config.allowlist);
}

/** How long the bot stays silent after a manager replies manually (24h). */
const MANAGER_TAKEOVER_MS = 24 * 60 * 60 * 1000;

/**
 * A human manager replied to the client manually from the bot's WhatsApp.
 * Pause the bot for that chat for 24h (context is kept; the bot auto-resumes
 * afterwards). Notifies admins once, on the first takeover.
 */
export function handleManagerManualReply(session: string, chatId: string): void {
  const digits = chatId.split('@')[0]?.replace(/\D/g, '') ?? '';
  const convo =
    conversations.get(session, chatId) ??
    conversations.getAllByPhone(digits).find((c) => c.session === session);
  if (!convo) return; // no active bot conversation to pause

  const wasHuman = convo.mode === 'human';
  conversations.handToHuman(convo, MANAGER_TAKEOVER_MS); // (re)start the 24h window
  logger.info({ chatId: convo.chatId, session, wasHuman }, 'manager replied manually — bot paused 24h');

  if (!wasHuman) {
    void notifyAdmin({
      reason: 'handoff',
      clientPhone: convo.phone,
      clientChatId: convo.chatId,
      clientName: convo.name,
      company: companies.bySession(session)?.name,
      session,
      summary: 'Менеджер подключился к диалогу вручную — бот замолчал на 24 часа. Вернуть раньше — кнопкой ниже или /resume.',
    }).catch(() => {});
  }
}
