import { config } from '../../config.js';
import { logger } from '../../logger.js';
import { getJson, httpFetch, postJson } from '../../util/http.js';
import type { InboundMessage, WahaSessionInfo, WahaWebhookEnvelope, WahaMessagePayload } from './types.js';

/**
 * WAHA (WhatsApp HTTP API) client.
 * Docs: https://waha.devlike.pro/docs/
 * Auth: X-Api-Key header. Endpoints are under /api.
 */

function headers(): Record<string, string> {
  return config.WAHA_API_KEY ? { 'X-Api-Key': config.WAHA_API_KEY } : {};
}

function url(path: string): string {
  return `${config.WAHA_BASE_URL.replace(/\/$/, '')}${path}`;
}

// --- chatId helpers ---------------------------------------------------------

export function phoneToChatId(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  return digits.endsWith('@c.us') ? digits : `${digits}@c.us`;
}

export function chatIdToPhone(chatId: string): string {
  return chatId.split('@')[0]!.replace(/\D/g, '');
}

export function isGroupChat(chatId: string): boolean {
  return chatId.endsWith('@g.us');
}

// --- messaging --------------------------------------------------------------

export async function sendText(chatId: string, text: string): Promise<void> {
  await postJson(
    url('/api/sendText'),
    { session: config.WAHA_SESSION, chatId, text },
    { headers: headers(), retries: 2 },
  );
}

export async function startTyping(chatId: string): Promise<void> {
  try {
    await postJson(
      url('/api/startTyping'),
      { session: config.WAHA_SESSION, chatId },
      { headers: headers(), retries: 0, timeoutMs: 5000 },
    );
  } catch {
    /* typing indicators are best-effort */
  }
}

export async function stopTyping(chatId: string): Promise<void> {
  try {
    await postJson(
      url('/api/stopTyping'),
      { session: config.WAHA_SESSION, chatId },
      { headers: headers(), retries: 0, timeoutMs: 5000 },
    );
  } catch {
    /* best-effort */
  }
}

export async function sendSeen(chatId: string): Promise<void> {
  try {
    await postJson(
      url('/api/sendSeen'),
      { session: config.WAHA_SESSION, chatId },
      { headers: headers(), retries: 0, timeoutMs: 5000 },
    );
  } catch {
    /* best-effort */
  }
}

// --- sessions ---------------------------------------------------------------

export async function getSession(): Promise<WahaSessionInfo | null> {
  try {
    return await getJson<WahaSessionInfo>(url(`/api/sessions/${config.WAHA_SESSION}`), {
      headers: headers(),
      retries: 1,
    });
  } catch (err) {
    logger.debug({ err: (err as Error).message }, 'getSession failed');
    return null;
  }
}

/** Restart the WAHA session (recovers from STOPPED/FAILED before showing a QR). */
export async function restartSession(): Promise<void> {
  await postJson(
    url(`/api/sessions/${config.WAHA_SESSION}/restart`),
    {},
    { headers: headers(), retries: 1, timeoutMs: 20_000 },
  );
}

/**
 * Request a WhatsApp pairing code for `phone` (digits only). The user enters it
 * via WhatsApp → Linked devices → "Link with phone number instead" — no QR scan.
 */
export async function requestPairingCode(phone: string): Promise<string | null> {
  try {
    const res = await postJson<{ code?: string }>(
      url(`/api/${config.WAHA_SESSION}/auth/request-code`),
      { phoneNumber: phone },
      { headers: headers(), retries: 1, timeoutMs: 20_000 },
    );
    return res?.code ?? null;
  } catch (err) {
    logger.debug({ err: (err as Error).message }, 'requestPairingCode failed');
    return null;
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Stop the WAHA session. */
export async function stopSession(): Promise<void> {
  await postJson(url(`/api/sessions/${config.WAHA_SESSION}/stop`), {}, { headers: headers(), retries: 1, timeoutMs: 20_000 });
}

/** Start the WAHA session. */
export async function startSession(): Promise<void> {
  await postJson(url(`/api/sessions/${config.WAHA_SESSION}/start`), {}, { headers: headers(), retries: 1, timeoutMs: 20_000 });
}

/** Log the session out — clears stored credentials (recovers a stale-creds login loop). */
export async function logoutSession(): Promise<void> {
  await postJson(url(`/api/sessions/${config.WAHA_SESSION}/logout`), {}, { headers: headers(), retries: 1, timeoutMs: 20_000 });
}

/**
 * Bring the session to a scannable state and return the final status. Tries a
 * plain restart first; if the session is stuck (e.g. stale credentials after the
 * phone unlinked the device → STARTING/FAILED loop), it does a full
 * stop → logout → start to clear the credentials.
 */
export async function ensureScannable(): Promise<string> {
  const statusOf = async (): Promise<string | undefined> => (await getSession())?.status;
  let st = await statusOf();
  if (st === 'WORKING' || st === 'SCAN_QR_CODE') return st;

  try {
    await restartSession();
  } catch {
    /* ignore */
  }
  for (let i = 0; i < 10; i++) {
    await sleep(2000);
    st = await statusOf();
    if (st === 'WORKING' || st === 'SCAN_QR_CODE') return st;
  }

  // Full recovery — clears stale credentials that keep the engine looping.
  try {
    await stopSession();
  } catch {
    /* ignore */
  }
  await sleep(1500);
  try {
    await logoutSession();
  } catch {
    /* ignore */
  }
  await sleep(1500);
  try {
    await startSession();
  } catch {
    /* ignore */
  }
  for (let i = 0; i < 12; i++) {
    await sleep(2500);
    st = await statusOf();
    if (st === 'WORKING' || st === 'SCAN_QR_CODE') return st;
  }
  return st ?? 'UNKNOWN';
}

/**
 * Ensure the session exists, is started, and is configured to POST webhooks to
 * our public URL. Uses the modern WAHA sessions API (create-or-update).
 * If the session isn't authenticated yet, the caller should surface the QR code.
 */
export async function ensureSession(webhookUrl: string): Promise<WahaSessionInfo | null> {
  const body = {
    name: config.WAHA_SESSION,
    start: true,
    config: {
      webhooks: [
        {
          url: webhookUrl,
          events: ['message'],
        },
      ],
    },
  };

  // Try to create; if it already exists, update it instead.
  try {
    return await postJson<WahaSessionInfo>(url('/api/sessions'), body, {
      headers: headers(),
      retries: 1,
    });
  } catch {
    try {
      return await postJson<WahaSessionInfo>(
        url(`/api/sessions/${config.WAHA_SESSION}`),
        { config: body.config },
        { headers: headers(), retries: 1 },
      );
    } catch (err2) {
      logger.warn({ err: (err2 as Error).message }, 'ensureSession update failed');
      return null;
    }
  }
}

/**
 * Fetch the current login QR code as PNG bytes so an operator can scan it
 * (we forward it to Telegram on startup when the session isn't connected).
 * Returns null if the QR isn't available (already authenticated, or WAHA down).
 */
export async function fetchQrImage(): Promise<Uint8Array | null> {
  try {
    const res = await httpFetch(url(`/api/${config.WAHA_SESSION}/auth/qr?format=image`), {
      method: 'GET',
      headers: { ...headers(), Accept: 'image/png' },
      retries: 1,
      timeoutMs: 8000,
    });
    if (!res.ok) return null;
    return new Uint8Array(await res.arrayBuffer());
  } catch (err) {
    logger.debug({ err: (err as Error).message }, 'fetchQrImage failed');
    return null;
  }
}

// --- webhook parsing --------------------------------------------------------

/** Matches a real phone-bearing WhatsApp JID (not the privacy "@lid" id). */
const REAL_JID_RE = /@(?:c\.us|s\.whatsapp\.net)$/i;

/** Extract the digits of a JID ("123:4@s.whatsapp.net" -> "123"). */
function jidToDigits(jid?: unknown): string {
  if (typeof jid !== 'string') return '';
  return jid.split('@')[0]?.split(':')[0]?.replace(/\D/g, '') ?? '';
}

function firstString(...vals: unknown[]): string | undefined {
  for (const v of vals) if (typeof v === 'string' && v.trim()) return v.trim();
  return undefined;
}

/**
 * Walk a WAHA payload (bounded depth) collecting real-phone JIDs and display
 * names. NOWEB delivers "@lid" chats whose `from` is a privacy id, not a phone;
 * the real number and pushName live in engine-specific nested fields (e.g.
 * key.remoteJidAlt / senderPn / pushName), so we scan for them rather than
 * hard-coding one shape.
 */
function scanPayload(obj: unknown, depth: number, acc: { jids: string[]; names: string[] }): void {
  if (obj == null || depth > 5 || typeof obj !== 'object') return;
  if (Array.isArray(obj)) {
    for (const v of obj) scanPayload(v, depth + 1, acc);
    return;
  }
  for (const [key, val] of Object.entries(obj as Record<string, unknown>)) {
    if (typeof val === 'string') {
      if (REAL_JID_RE.test(val)) acc.jids.push(val);
      else if (/(?:push|notify|verified).*name/i.test(key) && val.trim()) acc.names.push(val.trim());
    } else if (typeof val === 'object') {
      scanPayload(val, depth + 1, acc);
    }
  }
}

/** Resolve the client's real phone (digits) and display name from a payload. */
function resolveSender(p: WahaMessagePayload, meJid?: unknown): { phone: string; name?: string } {
  const acc: { jids: string[]; names: string[] } = { jids: [], names: [] };
  scanPayload(p, 0, acc);
  const myDigits = jidToDigits(meJid);
  const phone = acc.jids.map(jidToDigits).find((d) => d.length >= 8 && d !== myDigits) ?? '';
  const name = firstString(p.notifyName, p._data?.notifyName, p._data?.pushName, acc.names[0]);
  return { phone, name };
}

/**
 * Normalize a WAHA webhook envelope into an InboundMessage, or null if it's not
 * a text message we should handle (wrong event, group, echo, empty body).
 */
export function parseInbound(envelope: WahaWebhookEnvelope): InboundMessage | null {
  if (envelope.event !== 'message' && envelope.event !== 'message.any') return null;

  const p = envelope.payload as WahaMessagePayload;
  if (!p || typeof p.from !== 'string') return null;

  const chatId = p.from;
  const isGroup = isGroupChat(chatId);
  const fromMe = Boolean(p.fromMe);
  const text = (p.body ?? '').trim();

  if (fromMe) return null; // ignore our own echoes
  if (isGroup) return null; // 1:1 sales bot — ignore groups
  if (!text) return null; // ignore media-only / empty

  // For "@lid" privacy chats the chatId isn't a phone number — dig the real one
  // (and the display name) out of the payload so the manager card is usable.
  const { phone: realPhone, name } = resolveSender(p, envelope.me?.id);
  const phone = realPhone || chatIdToPhone(chatId);

  if (chatId.endsWith('@lid')) {
    if (realPhone) {
      logger.info({ chatId, phone, name }, 'resolved @lid sender');
    } else {
      // Couldn't find a phone-bearing JID — log the raw payload so we can map
      // whatever engine-specific field carries it.
      logger.info(
        { chatId, name, payload: JSON.stringify(p).slice(0, 2000) },
        'unresolved @lid sender — raw payload',
      );
    }
  }

  return { chatId, phone, text, name, isGroup, fromMe, session: envelope.session };
}
