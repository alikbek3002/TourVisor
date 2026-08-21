import type Anthropic from '@anthropic-ai/sdk';
import { logger } from '../logger.js';
import type { ConversationPersistence } from './persistence.js';

/**
 * In-memory per-user conversation store.
 *
 * Keyed by (WAHA session, WhatsApp chatId) — the same client phone talking to
 * two different companies is two independent conversations. Holds the Claude
 * message history plus lead/handoff state. This is intentionally simple (a Map)
 * — good enough for a single Railway instance. Swap for Redis/Postgres if you
 * scale horizontally (see README).
 */

export type ConversationMode = 'bot' | 'human';

export interface Lead {
  name?: string;
  departureCity?: string;
  country?: string;
  dateFrom?: string;
  nights?: number;
  adults?: number;
  children?: number;
  budget?: string;
  notes?: string;
}

export interface Conversation {
  session: string; // WAHA session (tenant), e.g. company-2
  chatId: string; // e.g. 996555123456@c.us
  phone: string; // digits only, e.g. 996555123456
  name?: string;
  mode: ConversationMode;
  /** When mode === 'human', the bot stays silent until this time (ms epoch) or forever if null. */
  mutedUntil: number | null;
  messages: Anthropic.MessageParam[];
  lead: Lead;
  createdAt: number;
  updatedAt: number;
}

const MAX_HISTORY = 40; // keep last N turns to bound token usage
const TTL_MS = 1000 * 60 * 60 * 24 * 7; // keep conversation context up to a week

/**
 * Can this message legally be the FIRST one sent to the Messages API?
 *
 * A `tool_result` block also carries role 'user', but the API rejects it unless
 * the matching `tool_use` sits in the preceding assistant turn. So "starts on a
 * user turn" is not enough — it must be a *plain* user turn.
 */
function isStandaloneUserTurn(m?: Anthropic.MessageParam): boolean {
  if (!m || m.role !== 'user') return false;
  if (typeof m.content === 'string') return true;
  return !m.content.some((b) => typeof b === 'object' && b.type === 'tool_result');
}

/**
 * Trim history to the last `max` messages while keeping it API-valid.
 *
 * Cutting in the middle of a tool loop leaves an orphan `tool_result` at index 0,
 * which makes EVERY later turn fail with 400 "unexpected tool_use_id" — the chat
 * is then permanently dead. So we always advance the cut to a plain user turn.
 * Also repairs histories already poisoned by the old trim.
 */
export function sanitizeHistory(
  messages: Anthropic.MessageParam[],
  max = MAX_HISTORY,
): Anthropic.MessageParam[] {
  if (messages.length === 0) return messages;
  let start = Math.max(0, messages.length - max);
  while (start < messages.length && !isStandaloneUserTurn(messages[start])) start++;
  if (start >= messages.length) {
    // The whole tail is one long tool loop — fall back to the earliest valid turn
    // rather than wiping the conversation.
    start = messages.findIndex(isStandaloneUserTurn);
    if (start < 0) return [];
  }
  return start === 0 ? messages : messages.slice(start);
}

/** Map key. Sessions and chatIds never contain ':' — split on the first one. */
export function convoKey(session: string, chatId: string): string {
  return `${session}:${chatId}`;
}

class ConversationStore {
  private map = new Map<string, Conversation>();
  private persistence: ConversationPersistence | null = null;
  private dirty = new Set<string>();
  private flushTimer: NodeJS.Timeout | null = null;

  /** Attach durable storage: load existing conversations, then write-behind changes. */
  async init(persistence: ConversationPersistence): Promise<void> {
    await persistence.init();
    const rows = await persistence.loadAll(nowMs() - TTL_MS);
    this.persistence = persistence;
    // Repair histories left invalid by an earlier trim (orphan tool_result at the
    // head), otherwise those chats keep 400-ing forever.
    let repaired = 0;
    for (const c of rows) {
      const key = convoKey(c.session, c.chatId);
      const fixed = sanitizeHistory(c.messages);
      if (fixed !== c.messages) {
        c.messages = fixed;
        repaired++;
        this.markDirty(key);
      }
      this.map.set(key, c);
    }
    logger.info({ loaded: rows.length, repaired }, 'conversations hydrated from persistence');
    if (!this.flushTimer) {
      this.flushTimer = setInterval(() => void this.flush(), 2000);
      this.flushTimer.unref();
    }
  }

  get(session: string, chatId: string): Conversation | undefined {
    return this.map.get(convoKey(session, chatId));
  }

  /** All conversations with this phone across tenants (handles @c.us vs @lid suffixes). */
  getAllByPhone(phone: string): Conversation[] {
    const digits = phone.replace(/\D/g, '');
    if (!digits) return [];
    const out: Conversation[] = [];
    for (const c of this.map.values()) {
      if (c.phone === digits) out.push(c);
    }
    return out;
  }

  /** Conversations with this chatId across sessions (admin commands, legacy buttons). */
  findAllByChatId(chatId: string): Conversation[] {
    const out: Conversation[] = [];
    for (const c of this.map.values()) {
      if (c.chatId === chatId) out.push(c);
    }
    return out;
  }

  /** Remove a conversation entirely — the client starts fresh on their next message. */
  remove(session: string, chatId: string): void {
    if (this.map.delete(convoKey(session, chatId))) this.markDirty(convoKey(session, chatId));
  }

  getOrCreate(session: string, chatId: string, phone: string, name?: string): Conversation {
    const key = convoKey(session, chatId);
    let convo = this.map.get(key);
    if (!convo) {
      convo = {
        session,
        chatId,
        phone,
        name,
        mode: 'bot',
        mutedUntil: null,
        messages: [],
        lead: {},
        createdAt: nowMs(),
        updatedAt: nowMs(),
      };
      this.map.set(key, convo);
      this.markDirty(key);
    } else {
      if (name && !convo.name) {
        convo.name = name;
        this.markDirty(key);
      }
      // Upgrade a placeholder phone (the "@lid" id copied from the chatId) once
      // the real number gets resolved from a later message.
      const lidDigits = chatId.split('@')[0]?.replace(/\D/g, '') ?? '';
      if (phone && phone !== lidDigits && convo.phone !== phone) {
        convo.phone = phone;
        this.markDirty(key);
      }
    }
    return convo;
  }

  appendUser(convo: Conversation, text: string): void {
    // A previous turn may have died between the assistant's `tool_use` and its
    // `tool_result`; that dangling tool_use would 400 the next request.
    const last = convo.messages[convo.messages.length - 1];
    if (
      last?.role === 'assistant' &&
      typeof last.content !== 'string' &&
      last.content.some((b) => typeof b === 'object' && b.type === 'tool_use')
    ) {
      convo.messages.pop();
    }
    convo.messages.push({ role: 'user', content: text });
    this.touch(convo);
  }

  append(convo: Conversation, message: Anthropic.MessageParam): void {
    convo.messages.push(message);
    this.touch(convo);
  }

  /** Hand the conversation to a human; optionally mute the bot for `muteMs`. */
  handToHuman(convo: Conversation, muteMs: number | null = null): void {
    convo.mode = 'human';
    convo.mutedUntil = muteMs == null ? null : nowMs() + muteMs;
    this.touch(convo);
  }

  returnToBot(convo: Conversation): void {
    convo.mode = 'bot';
    convo.mutedUntil = null;
    this.touch(convo);
  }

  /** Whether the bot should currently respond automatically. */
  isBotActive(convo: Conversation): boolean {
    if (convo.mode === 'bot') return true;
    if (convo.mutedUntil != null && nowMs() > convo.mutedUntil) {
      // mute window expired → resume bot
      this.returnToBot(convo);
      return true;
    }
    return false;
  }

  updateLead(convo: Conversation, patch: Partial<Lead>): void {
    convo.lead = { ...convo.lead, ...patch };
    this.touch(convo);
  }

  /** Snapshot counts for status reporting. */
  stats(): { total: number; human: number } {
    let human = 0;
    for (const c of this.map.values()) if (c.mode === 'human') human++;
    return { total: this.map.size, human };
  }

  /** Per-tenant counts for the multi-company /status view. */
  statsBySession(): Map<string, { total: number; human: number }> {
    const out = new Map<string, { total: number; human: number }>();
    for (const c of this.map.values()) {
      const s = out.get(c.session) ?? { total: 0, human: 0 };
      s.total++;
      if (c.mode === 'human') s.human++;
      out.set(c.session, s);
    }
    return out;
  }

  /** List chats currently handled by a human (for status reporting). */
  listHuman(limit = 20): Array<{ phone: string; chatId: string; session: string }> {
    const out: Array<{ phone: string; chatId: string; session: string }> = [];
    for (const c of this.map.values()) {
      if (c.mode === 'human') out.push({ phone: c.phone, chatId: c.chatId, session: c.session });
      if (out.length >= limit) break;
    }
    return out;
  }

  private touch(convo: Conversation): void {
    convo.updatedAt = nowMs();
    convo.messages = sanitizeHistory(convo.messages);
    this.markDirty(convoKey(convo.session, convo.chatId));
  }

  private markDirty(key: string): void {
    if (this.persistence) this.dirty.add(key);
  }

  /** Write pending changes to storage (write-behind, coalesced). */
  private async flush(): Promise<void> {
    if (!this.persistence || this.dirty.size === 0) return;
    const keys = [...this.dirty];
    this.dirty.clear();
    for (const key of keys) {
      const convo = this.map.get(key);
      try {
        if (convo) await this.persistence.upsert(convo);
        else {
          const sep = key.indexOf(':');
          await this.persistence.delete(key.slice(0, sep), key.slice(sep + 1));
        }
      } catch (err) {
        this.dirty.add(key); // retry on the next tick
        logger.debug({ err: (err as Error).message, key }, 'persist flush failed');
      }
    }
  }

  /** Force a flush now (e.g. on shutdown). */
  async flushNow(): Promise<void> {
    await this.flush();
  }

  /** Periodic cleanup of stale conversations. */
  sweep(): void {
    const cutoff = nowMs() - TTL_MS;
    let removed = 0;
    for (const [id, convo] of this.map) {
      if (convo.updatedAt < cutoff) {
        this.map.delete(id);
        this.markDirty(id);
        removed++;
      }
    }
    if (removed) logger.debug({ removed }, 'conversation sweep');
  }

  get size(): number {
    return this.map.size;
  }
}

function nowMs(): number {
  return Date.now();
}

export const conversations = new ConversationStore();

// Sweep hourly.
setInterval(() => conversations.sweep(), 1000 * 60 * 60).unref();
