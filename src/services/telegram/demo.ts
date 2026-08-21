import { createHash } from 'node:crypto';
import { config } from '../../config.js';
import { logger } from '../../logger.js';
import type { Company } from '../../core/companies.js';
import { conversations, convoKey } from '../../core/conversation.js';
import { runAgentTurn } from '../ai/index.js';
import { searchTours } from '../tourvisor/search.js';
import { postJson } from '../../util/http.js';
import type { TgUpdate } from './control.js';

/**
 * Public demo bot: a SECOND Telegram bot (own token) where anyone — e.g. a tour
 * agency the owner is pitching — can chat with the AI assistant, no WhatsApp
 * needed. Conversations live in the shared store under the `telegram-demo`
 * session, so escalations/leads surface in the ADMIN bot (labeled with the demo
 * company) and /status, /pause and /resume work on them like on any tenant.
 */

export const DEMO_SESSION = 'telegram-demo';

/** Virtual tenant for the demo — not in the DB registry, WAHA never sees it. */
export function demoCompany(): Company {
  return { id: -1, name: config.DEMO_COMPANY_NAME, session: DEMO_SESSION, active: true, createdAt: 0 };
}

export function demoWebhookPath(): string {
  return '/webhooks/telegram-demo';
}

/** Secret echoed back by Telegram in the webhook header (derived from the token). */
export function demoSecretToken(): string {
  return createHash('sha256')
    .update(config.TELEGRAM_DEMO_BOT_TOKEN ?? 'no-token')
    .digest('hex')
    .slice(0, 40);
}

function apiUrl(method: string): string {
  return `https://api.telegram.org/bot${config.TELEGRAM_DEMO_BOT_TOKEN}/${method}`;
}

async function callDemo<T = unknown>(method: string, body: unknown): Promise<{ ok: boolean; result?: T } | null> {
  try {
    return await postJson(apiUrl(method), body, {
      retries: 1,
      timeoutMs: method === 'getUpdates' ? 35_000 : 10_000,
    });
  } catch (err) {
    logger.debug({ err: (err as Error).message, method }, 'demo bot api call failed');
    return null;
  }
}

async function reply(chatId: number | string, text: string): Promise<void> {
  await callDemo('sendMessage', { chat_id: chatId, text });
}

const WELCOME = [
  `Здравствуйте! Я — ИИ-ассистент турагентства «${config.DEMO_COMPANY_NAME}» (демо-версия) 🌴`,
  '',
  'Я подбираю реальные туры: напишите, куда и когда хотите поехать — и я найду варианты с ценами.',
  'Например: «Хочу в Турцию в сентябре на неделю, нас двое».',
].join('\n');

// Per-chat serialization — a burst of messages must not spawn parallel AI turns.
const queues = new Map<string, Promise<void>>();

export async function handleDemoUpdate(update: TgUpdate): Promise<void> {
  try {
    const msg = update.message;
    const text = msg?.text?.trim();
    if (!msg || !text) return;
    if (msg.chat.type && msg.chat.type !== 'private') return; // 1:1 demo only

    const chatId = String(msg.chat.id);
    if (text === '/start') {
      conversations.remove(DEMO_SESSION, chatId); // fresh demo on every /start
      await reply(msg.chat.id, WELCOME);
      return;
    }

    const key = convoKey(DEMO_SESSION, chatId);
    const prev = queues.get(key) ?? Promise.resolve();
    const next = prev.then(() => handleDemoMessage(chatId, text, msg.from?.first_name)).catch((err) => {
      logger.error({ err: (err as Error).message, chatId }, 'demo pipeline error');
    });
    queues.set(key, next);
    void next.finally(() => {
      if (queues.get(key) === next) queues.delete(key);
    });
  } catch (err) {
    logger.error({ err: (err as Error).message }, 'demo update handler failed');
  }
}

async function handleDemoMessage(chatId: string, text: string, name?: string): Promise<void> {
  const convo = conversations.getOrCreate(DEMO_SESSION, chatId, chatId.replace(/\D/g, ''), name);

  if (!conversations.isBotActive(convo)) {
    conversations.appendUser(convo, text);
    return; // admin paused this demo chat
  }
  conversations.appendUser(convo, text);

  if (!config.features.ai) {
    await reply(chatId, 'Демо временно недоступно — ИИ не настроен 🙏');
    return;
  }

  void callDemo('sendChatAction', { chat_id: chatId, action: 'typing' });
  try {
    const result = await runAgentTurn(convo, { searchTours }, demoCompany());
    await reply(chatId, result.reply);
    logger.info({ chatId, escalated: result.escalated }, 'demo replied');
  } catch (err) {
    logger.error({ err: (err as Error).message, chatId }, 'demo agent turn failed');
    await reply(chatId, 'Извините, техническая заминка 🙏 Попробуйте ещё раз через минуту.');
  }
}

// --- startup wiring ---------------------------------------------------------

let polling = false;

/** Register the demo bot webhook (with PUBLIC_URL) or start long-polling. */
export async function initDemoBot(): Promise<void> {
  if (!config.features.telegramDemo) return;

  if (config.PUBLIC_URL) {
    const url = `${config.PUBLIC_URL.replace(/\/$/, '')}${demoWebhookPath()}`;
    const res = await callDemo('setWebhook', {
      url,
      secret_token: demoSecretToken(),
      allowed_updates: ['message'],
      drop_pending_updates: false,
    });
    if (res?.ok) logger.info({ url }, 'Telegram DEMO bot webhook registered ✅');
    else logger.warn({ url }, 'Telegram DEMO bot setWebhook did not confirm');
  } else {
    logger.info('No PUBLIC_URL — demo bot using long-polling');
    await callDemo('deleteWebhook', { drop_pending_updates: false });
    startPolling();
  }
}

function startPolling(): void {
  if (polling) return;
  polling = true;
  let offset = 0;
  const loop = async (): Promise<void> => {
    while (polling) {
      const res = await callDemo<TgUpdate[]>('getUpdates', {
        offset,
        timeout: 30,
        allowed_updates: ['message'],
      });
      const updates = res?.result ?? [];
      for (const u of updates) {
        offset = u.update_id + 1;
        await handleDemoUpdate(u);
      }
      if (!res) await new Promise((r) => setTimeout(r, 2000));
    }
  };
  void loop();
}
