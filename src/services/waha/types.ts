/**
 * WAHA webhook + API types (subset we use).
 * WAHA posts an envelope per event: { event, session, me, payload, ... }.
 * The 'message' / 'message.any' payload carries the WhatsApp message.
 * Shapes vary slightly by engine (WEBJS/NOWEB/GOWS); we read only stable fields.
 */

export interface WahaMessagePayload {
  id: string;
  timestamp?: number;
  /** chatId of the sender, e.g. "79991234567@c.us" (or "...@g.us" for groups). */
  from: string;
  to?: string;
  /** true when the message was sent BY us (echo) — must be ignored. */
  fromMe: boolean;
  body?: string;
  hasMedia?: boolean;
  /** Display name of the contact (engine-dependent; may be nested in _data). */
  notifyName?: string;
  _data?: {
    notifyName?: string;
    [k: string]: unknown;
  };
  [k: string]: unknown;
}

export interface WahaWebhookEnvelope {
  event: string; // "message" | "message.any" | "session.status" | ...
  session: string;
  me?: { id?: string; pushName?: string };
  payload: WahaMessagePayload | Record<string, unknown>;
  [k: string]: unknown;
}

/** Normalized inbound message we act on. */
export interface InboundMessage {
  chatId: string; // e.g. 79991234567@c.us
  phone: string; // digits only
  text: string;
  name?: string;
  isGroup: boolean;
  fromMe: boolean;
  session: string;
}

export interface WahaSessionInfo {
  name: string;
  status: string; // STARTING | SCAN_QR_CODE | WORKING | FAILED | STOPPED ...
  me?: { id?: string; pushName?: string } | null;
  [k: string]: unknown;
}
