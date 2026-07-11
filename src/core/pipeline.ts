import { config } from '../config.js';
import { logger } from '../logger.js';
import { conversations } from './conversation.js';
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
const chatQueues = new Map<string, Promise<void>>();

// Per-chat debounce buffer: collect a burst of messages and answer once.
interface PendingBatch {
  latest: InboundMessage; // keep latest metadata (name/phone/session)
  texts: string[];
  timer: NodeJS.Timeout;
}
const pendingBatches = new Map<string, PendingBatch>();

export function enqueueInbound(msg: InboundMessage): void {
  const debounceMs = config.MESSAGE_DEBOUNCE_MS;
  if (debounceMs <= 0) {
    schedule(msg);
    return;
  }

  // Acknowledge delivery right away (blue ticks) even though we hold the reply.
  void sendSeen(msg.chatId).catch(() => {});

  const existing = pendingBatches.get(msg.chatId);
  if (existing) {
    clearTimeout(existing.timer);
    existing.texts.push(msg.text);
    existing.latest = msg;
    existing.timer = armBatchTimer(msg.chatId, debounceMs);
  } else {
    pendingBatches.set(msg.chatId, {
      latest: msg,
      texts: [msg.text],
      timer: armBatchTimer(msg.chatId, debounceMs),
    });
  }
}

function armBatchTimer(chatId: string, ms: number): NodeJS.Timeout {
  const t = setTimeout(() => flushBatch(chatId), ms);
  t.unref?.();
  return t;
}

/** Fire the collected burst as a single combined message. */
function flushBatch(chatId: string): void {
  const batch = pendingBatches.get(chatId);
  if (!batch) return;
  pendingBatches.delete(chatId);
  const combined: InboundMessage = { ...batch.latest, text: batch.texts.join('\n') };
  schedule(combined);
}

/** Queue a message for sequential per-chat processing. */
function schedule(msg: InboundMessage): void {
  const prev = chatQueues.get(msg.chatId) ?? Promise.resolve();
  const next = prev.then(() => handleInbound(msg)).catch((err) => {
    logger.error({ err: (err as Error).message, chatId: msg.chatId }, 'pipeline error');
  });
  // Clean the map entry once this is the tail of the queue.
  chatQueues.set(msg.chatId, next);
  void next.finally(() => {
    if (chatQueues.get(msg.chatId) === next) chatQueues.delete(msg.chatId);
  });
}

async function handleInbound(msg: InboundMessage): Promise<void> {
  if (!isAllowed(msg)) {
    logger.debug({ phone: msg.phone }, 'message from non-allowlisted number, ignoring');
    return;
  }

  const convo = conversations.getOrCreate(msg.chatId, msg.phone, msg.name);

  // If a human has taken over, stay silent (but keep the message in history).
  if (!conversations.isBotActive(convo)) {
    conversations.appendUser(convo, msg.text);
    logger.info({ phone: msg.phone }, 'chat in human mode — bot staying silent');
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
      summary: 'AI отключён — требуется ручной ответ',
      lastMessage: msg.text,
    });
    await sendText(
      msg.chatId,
      `Здравствуйте! Спасибо за сообщение 🙌 Наш менеджер ${config.MANAGER_NAME} скоро свяжется с вами.`,
    );
    return;
  }

  await sendSeen(msg.chatId);
  await startTyping(msg.chatId);
  try {
    const result = await runAgentTurn(convo, { searchTours });
    await stopTyping(msg.chatId);
    await sendText(msg.chatId, result.reply);
    logger.info({ phone: msg.phone, escalated: result.escalated }, 'replied');
  } catch (err) {
    await stopTyping(msg.chatId).catch(() => {});
    logger.error({ err: (err as Error).message, phone: msg.phone }, 'agent turn failed');
    await notifyError(`Ошибка при ответе клиенту +${msg.phone}`, err);
    await sendText(
      msg.chatId,
      'Извините, возникла техническая заминка 🙏 Я передал ваш запрос менеджеру — он скоро свяжется.',
    ).catch(() => {});
    conversations.handToHuman(convo, 1000 * 60 * 30); // mute bot for 30 min
    await notifyAdmin({
      reason: 'error',
      clientPhone: msg.phone,
      clientChatId: msg.chatId,
      clientName: msg.name,
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
export function handleManagerManualReply(chatId: string): void {
  const digits = chatId.split('@')[0]?.replace(/\D/g, '') ?? '';
  const convo = conversations.get(chatId) ?? conversations.getByPhone(digits);
  if (!convo) return; // no active bot conversation to pause

  const wasHuman = convo.mode === 'human';
  conversations.handToHuman(convo, MANAGER_TAKEOVER_MS); // (re)start the 24h window
  logger.info({ chatId: convo.chatId, wasHuman }, 'manager replied manually — bot paused 24h');

  if (!wasHuman) {
    void notifyAdmin({
      reason: 'handoff',
      clientPhone: convo.phone,
      clientChatId: convo.chatId,
      clientName: convo.name,
      summary: 'Менеджер подключился к диалогу вручную — бот замолчал на 24 часа. Вернуть раньше — кнопкой ниже или /resume.',
    }).catch(() => {});
  }
}
