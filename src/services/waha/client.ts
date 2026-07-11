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
  const name = p.notifyName || p._data?.notifyName;

  if (fromMe) return null; // ignore our own echoes
  if (isGroup) return null; // 1:1 sales bot — ignore groups
  if (!text) return null; // ignore media-only / empty

  return {
    chatId,
    phone: chatIdToPhone(chatId),
    text,
    name,
    isGroup,
    fromMe,
    session: envelope.session,
  };
}
