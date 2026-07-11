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
const TTL_MS = 1000 * 60 * 60 * 24; // drop conversations idle > 24h

class ConversationStore {
  private map = new Map<string, Conversation>();
  private persistence: ConversationPersistence | null = null;
  private dirty = new Set<string>();
  private flushTimer: NodeJS.Timeout | null = null;

  /** Attach durable storage: load existing conversations, then write-behind changes. */
  async init(persistence: ConversationPersistence): Promise<void> {
    await persistence.init();
    const rows = await persistence.loadAll(nowMs() - TTL_MS);
    for (const c of rows) this.map.set(c.chatId, c);
    this.persistence = persistence;
    logger.info({ loaded: rows.length }, 'conversations hydrated from persistence');
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
    } else if (name && !convo.name) {
      convo.name = name;
      this.markDirty(chatId);
    }
    return convo;
  }

  appendUser(convo: Conversation, text: string): void {
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
    // Trim history but always keep it starting on a user turn so the API accepts it.
    if (convo.messages.length > MAX_HISTORY) {
      const overflow = convo.messages.length - MAX_HISTORY;
      convo.messages.splice(0, overflow);
      while (convo.messages.length && convo.messages[0]?.role !== 'user') {
        convo.messages.shift();
      }
    }
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
