import type Anthropic from '@anthropic-ai/sdk';
import { logger } from '../logger.js';
import type { ConversationPersistence } from './persistence.js';

/**
 * In-memory per-user conversation store.
 *
 * Keyed by WhatsApp chatId. Holds the Claude message history plus lead/handoff
 * state. This is intentionally simple (a Map) — good enough for a single Railway
 * instance. Swap for Redis/Postgres if you scale horizontally (see README).
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
      const fixed = sanitizeHistory(c.messages);
      if (fixed !== c.messages) {
        c.messages = fixed;
        repaired++;
        this.markDirty(c.chatId);
      }
      this.map.set(c.chatId, c);
    }
    logger.info({ loaded: rows.length, repaired }, 'conversations hydrated from persistence');
    if (!this.flushTimer) {
      this.flushTimer = setInterval(() => void this.flush(), 2000);
      this.flushTimer.unref();
    }
  }

  get(chatId: string): Conversation | undefined {
    return this.map.get(chatId);
  }

  /** Find a conversation by phone digits (handles @c.us vs @lid chatId suffixes). */
  getByPhone(phone: string): Conversation | undefined {
    const digits = phone.replace(/\D/g, '');
    if (!digits) return undefined;
    for (const c of this.map.values()) {
      if (c.phone === digits) return c;
    }
    return undefined;
  }

  /** Remove a conversation entirely — the client starts fresh on their next message. */
  remove(chatId: string): void {
    if (this.map.delete(chatId)) this.markDirty(chatId);
  }

  getOrCreate(chatId: string, phone: string, name?: string): Conversation {
    let convo = this.map.get(chatId);
    if (!convo) {
      convo = {
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
      this.map.set(chatId, convo);
      this.markDirty(chatId);
    } else {
      if (name && !convo.name) {
        convo.name = name;
        this.markDirty(chatId);
      }
      // Upgrade a placeholder phone (the "@lid" id copied from the chatId) once
      // the real number gets resolved from a later message.
      const lidDigits = chatId.split('@')[0]?.replace(/\D/g, '') ?? '';
      if (phone && phone !== lidDigits && convo.phone !== phone) {
        convo.phone = phone;
        this.markDirty(chatId);
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

  /** List chats currently handled by a human (for status reporting). */
  listHuman(limit = 20): Array<{ phone: string; chatId: string }> {
    const out: Array<{ phone: string; chatId: string }> = [];
    for (const c of this.map.values()) {
      if (c.mode === 'human') out.push({ phone: c.phone, chatId: c.chatId });
      if (out.length >= limit) break;
    }
    return out;
  }

  private touch(convo: Conversation): void {
    convo.updatedAt = nowMs();
    convo.messages = sanitizeHistory(convo.messages);
    this.markDirty(convo.chatId);
  }

  private markDirty(chatId: string): void {
    if (this.persistence) this.dirty.add(chatId);
  }

  /** Write pending changes to storage (write-behind, coalesced). */
  private async flush(): Promise<void> {
    if (!this.persistence || this.dirty.size === 0) return;
    const ids = [...this.dirty];
    this.dirty.clear();
    for (const id of ids) {
      const convo = this.map.get(id);
      try {
        if (convo) await this.persistence.upsert(convo);
        else await this.persistence.delete(id);
      } catch (err) {
        this.dirty.add(id); // retry on the next tick
        logger.debug({ err: (err as Error).message, chatId: id }, 'persist flush failed');
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
