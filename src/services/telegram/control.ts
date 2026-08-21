import { createHash } from 'node:crypto';
import { config } from '../../config.js';
import { logger } from '../../logger.js';
import { companies, type Company } from '../../core/companies.js';
import { conversations, type Conversation } from '../../core/conversation.js';
import { postJson } from '../../util/http.js';
import { apiUrl, escapeHtml, sendTelegram, sendTelegramPhoto } from './notifier.js';
import {
  ensureScannable,
  ensureSession,
  fetchQrImage,
  getSession,
  logoutSession,
  phoneToChatId,
  requestPairingCode,
  stopSession,
} from '../waha/client.js';

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

/** All conversations matching an admin-typed phone/chatId, across companies. */
function findConvos(arg: string): Conversation[] {
  const byChat = conversations.findAllByChatId(resolveChatId(arg));
  if (byChat.length) return byChat;
  return conversations.getAllByPhone(arg);
}

/** Human label for a conversation's tenant. */
function companyLabel(session: string): string {
  return companies.bySession(session)?.name ?? session;
}

const HELP = [
  '<b>Управление ботом</b>',
  '',
  '<b>Компании</b>',
  '/newco &lt;название&gt; — новая тур-компания + QR для её WhatsApp',
  '/companies — список компаний и статусы',
  '/qr [компания] — QR для подключения WhatsApp (без аргумента — основная)',
  '/code &lt;номер&gt; [компания] — код привязки WhatsApp (без сканирования)',
  '/delco &lt;компания&gt; — отключить компанию',
  '',
  '<b>Диалоги</b>',
  '/status — статус WhatsApp и диалогов',
  '/resume &lt;номер&gt; — вернуть диалог боту',
  '/pause &lt;номер&gt; [минуты] — пауза (без числа — бессрочно)',
  '/reset &lt;номер&gt; — сбросить диалог клиента (начать с нуля)',
  '',
  'Компания — это id из /companies, сессия или название.',
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
  const from = message.chat?.id;
  if (!isFromAdmin(from)) return; // silently ignore non-admins
  const to = String(from); // reply only to the admin who sent the command
  const text = (message.text ?? '').trim();
  if (!text.startsWith('/')) return;

  const parts = text.split(/\s+/);
  const cmd = (parts[0] ?? '').toLowerCase().split('@')[0];

  switch (cmd) {
    case '/start':
    case '/help':
      await sendTelegram(HELP, { chatId: to });
      return;
    case '/status':
      await handleStatus(to);
      return;
    case '/resume':
      await handleResume(to, parts[1]);
      return;
    case '/pause':
      await handlePause(to, parts[1], parts[2]);
      return;
    case '/qr':
      await handleQr(to, parts.slice(1).join(' '));
      return;
    case '/code':
      await handleCode(to, parts[1], parts.slice(2).join(' '));
      return;
    case '/reset':
      await handleReset(to, parts[1]);
      return;
    case '/newco':
      await handleNewco(to, parts.slice(1).join(' ').trim());
      return;
    case '/companies':
      await handleCompanies(to);
      return;
    case '/delco':
      await handleDelco(to, parts.slice(1).join(' '));
      return;
    default:
      await sendTelegram('Неизвестная команда. /help — список команд.', { chatId: to });
  }
}

async function handleStatus(to: string): Promise<void> {
  const list = companies.list().filter((c) => c.active);
  const sessions = await Promise.all(list.map((c) => getSession(c.session)));
  const perSession = conversations.statsBySession();
  const lines = ['<b>Статус</b>'];
  list.forEach((c, i) => {
    const status = sessions[i]?.status ?? 'UNKNOWN';
    const s = perSession.get(c.session) ?? { total: 0, human: 0 };
    lines.push(
      `• ${escapeHtml(c.name)}: <b>${status}</b> — диалогов ${s.total} (на менеджере: ${s.human})`,
    );
  });
  const humans = conversations
    .listHuman(15)
    .map((h) => `• +${h.phone} — ${escapeHtml(companyLabel(h.session))}`)
    .join('\n');
  if (humans) lines.push('', 'На ручном режиме:', humans);
  await sendTelegram(lines.join('\n'), { chatId: to });
}

async function handleResume(to: string, arg?: string): Promise<void> {
  if (!arg) {
    await sendTelegram('Укажите номер: <code>/resume 996555123456</code>', { chatId: to });
    return;
  }
  const convos = findConvos(arg);
  if (!convos.length) {
    await sendTelegram(`Диалог не найден: ${resolveChatId(arg)}`, { chatId: to });
    return;
  }
  for (const convo of convos) {
    conversations.returnToBot(convo);
    logger.info({ chatId: convo.chatId, session: convo.session }, 'bot resumed via telegram');
  }
  await sendTelegram(
    convos
      .map((c) => `✅ Бот снова отвечает клиенту +${c.phone} («${escapeHtml(companyLabel(c.session))}»).`)
      .join('\n'),
    { chatId: to },
  );
}

async function handlePause(to: string, arg?: string, minutesArg?: string): Promise<void> {
  if (!arg) {
    await sendTelegram('Укажите номер: <code>/pause 996555123456 [минуты]</code>', { chatId: to });
    return;
  }
  const convos = findConvos(arg);
  if (!convos.length) {
    await sendTelegram(`Диалог не найден: ${resolveChatId(arg)}`, { chatId: to });
    return;
  }
  const minutes = Number(minutesArg);
  const muteMs = Number.isFinite(minutes) && minutes > 0 ? minutes * 60_000 : null;
  for (const convo of convos) {
    conversations.handToHuman(convo, muteMs);
    logger.info({ chatId: convo.chatId, session: convo.session, muteMs }, 'bot paused via telegram');
  }
  await sendTelegram(
    convos
      .map(
        (c) =>
          `⏸ Бот на паузе для +${c.phone} («${escapeHtml(companyLabel(c.session))}»)${
            muteMs ? ` на ${minutes} мин` : ' (бессрочно)'
          }.`,
      )
      .join('\n'),
    { chatId: to },
  );
}

async function handleReset(to: string, arg?: string): Promise<void> {
  if (!arg) {
    await sendTelegram('Укажите номер: <code>/reset 996555123456</code>', { chatId: to });
    return;
  }
  const convos = findConvos(arg);
  if (!convos.length) {
    await sendTelegram(`Диалог не найден: ${resolveChatId(arg)}`, { chatId: to });
    return;
  }
  for (const convo of convos) {
    conversations.remove(convo.session, convo.chatId);
    logger.info({ chatId: convo.chatId, session: convo.session }, 'conversation reset via telegram');
  }
  await sendTelegram(
    convos
      .map((c) => `🧹 Диалог с +${c.phone} («${escapeHtml(companyLabel(c.session))}») сброшен.`)
      .join('\n'),
    { chatId: to },
  );
}

/** Resolve the company an admin referenced, defaulting to the owner's. */
async function resolveCompanyArg(to: string, arg?: string): Promise<Company | null> {
  const q = (arg ?? '').trim();
  if (!q) return companies.bySession(config.WAHA_SESSION) ?? null;
  const company = companies.find(q);
  if (!company) {
    await sendTelegram(
      `Компания не найдена: ${escapeHtml(q)}. Список — /companies.`,
      { chatId: to },
    );
    return null;
  }
  return company;
}

/** Bring a company's session to a scannable state and push its QR to the admin. */
async function sendQrFor(company: Company, to: string): Promise<void> {
  const session = company.session;
  if ((await getSession(session))?.status !== 'SCAN_QR_CODE') {
    await sendTelegram(`Готовлю WhatsApp-сессию «${escapeHtml(company.name)}», подождите ~20–40 сек…`, {
      chatId: to,
    });
  }
  const st = await ensureScannable(session);
  if (st === 'WORKING') {
    await sendTelegram(`✅ WhatsApp «${escapeHtml(company.name)}» уже подключён — бот готов.`, {
      chatId: to,
    });
    return;
  }
  if (st !== 'SCAN_QR_CODE') {
    await sendTelegram(
      `Не удалось подготовить сессию «${escapeHtml(company.name)}». Попробуйте /qr ${company.id} ещё раз через минуту.`,
      { chatId: to },
    );
    return;
  }
  const qr = await fetchQrImage(session);
  if (qr) {
    await sendTelegramPhoto(
      qr,
      `📲 QR для «${escapeHtml(company.name)}». На телефоне компании: WhatsApp → Связанные устройства → Привязка устройства. Код живёт ~20 сек — не успели, отправьте /qr ${company.id} снова. Или кодом: /code &lt;номер&gt; ${company.id}.`,
      to,
    );
  } else {
    await sendTelegram(`QR пока недоступен, отправьте /qr ${company.id} ещё раз через несколько секунд.`, {
      chatId: to,
    });
  }
}

async function handleQr(to: string, arg?: string): Promise<void> {
  const company = await resolveCompanyArg(to, arg);
  if (company) await sendQrFor(company, to);
}

async function handleCode(to: string, phone?: string, companyArg?: string): Promise<void> {
  const digits = (phone ?? '').replace(/\D/g, '');
  if (digits.length < 8) {
    await sendTelegram(
      'Укажите номер бота: <code>/code 996700112233 [компания]</code> (тот, что станет номером WhatsApp-бота).',
      { chatId: to },
    );
    return;
  }
  const company = await resolveCompanyArg(to, companyArg);
  if (!company) return;
  const session = company.session;
  if ((await getSession(session))?.status !== 'SCAN_QR_CODE') {
    await sendTelegram(`Готовлю WhatsApp-сессию «${escapeHtml(company.name)}», подождите ~20–40 сек…`, {
      chatId: to,
    });
  }
  const st = await ensureScannable(session);
  if (st === 'WORKING') {
    await sendTelegram(`✅ WhatsApp «${escapeHtml(company.name)}» уже подключён — бот готов.`, {
      chatId: to,
    });
    return;
  }
  if (st !== 'SCAN_QR_CODE') {
    await sendTelegram('Не удалось подготовить сессию. Попробуйте /code ещё раз через минуту.', {
      chatId: to,
    });
    return;
  }
  const code = await requestPairingCode(session, digits);
  if (code) {
    await sendTelegram(
      `🔑 Код привязки для «${escapeHtml(company.name)}»: <code>${code}</code>\n\nНа телефоне с номером +${digits}:\nWhatsApp → Настройки → Связанные устройства → Привязка устройства → «Вводить номер телефона вместо этого» → введите этот код.\n\nКод действует несколько минут. Не сработал — отправьте /code снова.`,
      { chatId: to },
    );
  } else {
    await sendTelegram('Не удалось получить код. Попробуйте /code &lt;номер&gt; ещё раз или /qr.', {
      chatId: to,
    });
  }
}

async function handleNewco(to: string, name: string): Promise<void> {
  if (!name) {
    await sendTelegram('Укажите название: <code>/newco Название компании</code>', { chatId: to });
    return;
  }
  let company: Company;
  try {
    company = await companies.create(name);
  } catch (err) {
    await sendTelegram(`Не удалось создать компанию: ${escapeHtml((err as Error).message)}`, {
      chatId: to,
    });
    return;
  }
  await sendTelegram(
    `🏢 Компания «${escapeHtml(company.name)}» создана (id ${company.id}, сессия <code>${company.session}</code>).`,
    { chatId: to },
  );
  // Create + start the WAHA session, then walk the admin through the QR scan.
  await ensureSession(company.session);
  await sendQrFor(company, to);
}

async function handleCompanies(to: string): Promise<void> {
  const list = companies.list();
  const sessions = await Promise.all(list.map((c) => getSession(c.session)));
  const lines = list.map((c, i) => {
    const status = c.active ? (sessions[i]?.status ?? 'UNKNOWN') : 'отключена';
    const meId = sessions[i]?.me?.id;
    const digits = meId ? String(meId).split('@')[0]?.split(':')[0]?.replace(/\D/g, '') : '';
    return `• [${c.id}] ${escapeHtml(c.name)} — <code>${c.session}</code> — <b>${status}</b>${
      digits ? ` (+${digits})` : ''
    }`;
  });
  await sendTelegram(
    ['<b>Компании</b>', ...lines, '', 'Новая компания: /newco &lt;название&gt;'].join('\n'),
    { chatId: to },
  );
}

async function handleDelco(to: string, arg?: string): Promise<void> {
  if (!arg?.trim()) {
    await sendTelegram('Укажите компанию: <code>/delco &lt;id|сессия|название&gt;</code>', {
      chatId: to,
    });
    return;
  }
  const company = companies.find(arg);
  if (!company) {
    await sendTelegram(`Компания не найдена: ${escapeHtml(arg)}. Список — /companies.`, {
      chatId: to,
    });
    return;
  }
  if (company.session === config.WAHA_SESSION) {
    await sendTelegram('Нельзя отключить основную компанию.', { chatId: to });
    return;
  }
  try {
    await logoutSession(company.session);
  } catch {
    /* session may already be gone */
  }
  try {
    await stopSession(company.session);
  } catch {
    /* ignore */
  }
  await companies.deactivate(company.session);
  await sendTelegram(
    `🗑 Компания «${escapeHtml(company.name)}» отключена: WhatsApp отвязан, сообщения не обрабатываются.`,
    { chatId: to },
  );
  logger.info({ session: company.session }, 'company deactivated via telegram');
}

async function handleCallback(cq: TgCallbackQuery): Promise<void> {
  const from = cq.message?.chat?.id;
  if (!isFromAdmin(from)) {
    await callTg('answerCallbackQuery', { callback_query_id: cq.id, text: '⛔ Не авторизовано' });
    return;
  }
  const to = String(from); // confirmation goes only to the admin who tapped

  // New format: "<action>:<session>:<chatId>"; legacy buttons: "<action>:<chatId>".
  const [action, ...rest] = (cq.data ?? '').split(':');
  let convo: Conversation | undefined;
  if (rest.length >= 2 && companies.bySession(rest[0]!)) {
    convo = conversations.get(rest[0]!, rest.slice(1).join(':'));
  } else {
    const clientChatId = rest.join(':');
    convo = clientChatId ? conversations.findAllByChatId(clientChatId)[0] : undefined;
  }

  let toast: string;
  if (!convo) {
    toast = 'Диалог не найден';
  } else if (action === 'resume') {
    conversations.returnToBot(convo);
    toast = '▶️ Бот включён';
    await sendTelegram(
      `✅ Бот снова отвечает клиенту +${convo.phone} («${escapeHtml(companyLabel(convo.session))}»).`,
      { chatId: to },
    );
    logger.info({ chatId: convo.chatId, session: convo.session }, 'bot resumed via telegram button');
  } else if (action === 'pause') {
    conversations.handToHuman(convo, null);
    toast = '⏸ Пауза';
    await sendTelegram(`⏸ Бот на паузе для +${convo.phone}.`, { chatId: to });
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
