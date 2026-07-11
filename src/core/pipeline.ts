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

export function enqueueInbound(msg: InboundMessage): void {
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
      clientName: msg.name,
      summary: 'Бот не смог обработать запрос',
      lastMessage: msg.text,
    }).catch(() => {});
  }
}

function isAllowed(msg: InboundMessage): boolean {
  return matchesAllowlist(msg.phone, msg.chatId, config.allowlist);
}
