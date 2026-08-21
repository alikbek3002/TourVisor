import pg from 'pg';
import type Anthropic from '@anthropic-ai/sdk';
import { config } from '../config.js';
import { logger } from '../logger.js';
import type { Conversation, ConversationMode, Lead } from './conversation.js';

/**
 * Durable storage for conversations. The in-memory ConversationStore stays the
 * authoritative working set (single Railway instance); this layer just loads it
 * on boot and write-behinds mutations so state survives restarts/redeploys.
 *
 * When DATABASE_URL is unset, createPersistence() returns null and the store
 * runs purely in memory (the previous behaviour).
 */
export interface ConversationPersistence {
  /** Create the schema if needed. */
  init(): Promise<void>;
  /** Load conversations updated at/after `sinceMs`. */
  loadAll(sinceMs: number): Promise<Conversation[]>;
  /** Insert or update one conversation. */
  upsert(convo: Conversation): Promise<void>;
  /** Remove a conversation (used when it's swept for inactivity). */
  delete(session: string, chatId: string): Promise<void>;
}

class PostgresPersistence implements ConversationPersistence {
  private pool: pg.Pool;

  constructor(connectionString: string) {
    this.pool = new pg.Pool({
      connectionString,
      // Railway's public Postgres URLs require SSL; internal ones don't.
      ssl: /sslmode=require/.test(connectionString) ? { rejectUnauthorized: false } : undefined,
      max: 4,
    });
    this.pool.on('error', (err) => logger.warn({ err: err.message }, 'pg pool error'));
  }

  async init(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS conversations (
        session     TEXT NOT NULL DEFAULT 'default',
        chat_id     TEXT NOT NULL,
        phone       TEXT NOT NULL,
        name        TEXT,
        mode        TEXT NOT NULL,
        muted_until BIGINT,
        messages    JSONB NOT NULL DEFAULT '[]'::jsonb,
        lead        JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at  BIGINT NOT NULL,
        updated_at  BIGINT NOT NULL,
        PRIMARY KEY (session, chat_id)
      );
    `);
    // Migrate pre-multitenant installs (chat_id-only PK) in place, idempotently.
    await this.pool.query(
      `ALTER TABLE conversations ADD COLUMN IF NOT EXISTS session TEXT NOT NULL DEFAULT 'default';`,
    );
    await this.pool.query(`
      DO $$ BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.key_column_usage
          WHERE table_name = 'conversations'
            AND constraint_name = 'conversations_pkey'
            AND column_name = 'session'
        ) THEN
          ALTER TABLE conversations DROP CONSTRAINT IF EXISTS conversations_pkey;
          ALTER TABLE conversations ADD CONSTRAINT conversations_pkey PRIMARY KEY (session, chat_id);
        END IF;
      END $$;
    `);
    if (config.WAHA_SESSION !== 'default') {
      // Old rows predate the session column; move them under the owner's session.
      await this.pool.query(`UPDATE conversations SET session = $1 WHERE session = 'default'`, [
        config.WAHA_SESSION,
      ]);
    }
    await this.pool.query(
      `CREATE INDEX IF NOT EXISTS conversations_updated_at_idx ON conversations (updated_at);`,
    );
  }

  async loadAll(sinceMs: number): Promise<Conversation[]> {
    const { rows } = await this.pool.query(
      `SELECT session, chat_id, phone, name, mode, muted_until, messages, lead, created_at, updated_at
         FROM conversations
        WHERE updated_at >= $1
        ORDER BY updated_at DESC
        LIMIT 5000`,
      [sinceMs],
    );
    return rows.map(rowToConversation);
  }

  async upsert(c: Conversation): Promise<void> {
    await this.pool.query(
      `INSERT INTO conversations
         (session, chat_id, phone, name, mode, muted_until, messages, lead, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9, $10)
       ON CONFLICT (session, chat_id) DO UPDATE SET
         phone       = EXCLUDED.phone,
         name        = EXCLUDED.name,
         mode        = EXCLUDED.mode,
         muted_until = EXCLUDED.muted_until,
         messages    = EXCLUDED.messages,
         lead        = EXCLUDED.lead,
         updated_at  = EXCLUDED.updated_at`,
      [
        c.session,
        c.chatId,
        c.phone,
        c.name ?? null,
        c.mode,
        c.mutedUntil,
        JSON.stringify(c.messages),
        JSON.stringify(c.lead),
        c.createdAt,
        c.updatedAt,
      ],
    );
  }

  async delete(session: string, chatId: string): Promise<void> {
    await this.pool.query(`DELETE FROM conversations WHERE session = $1 AND chat_id = $2`, [
      session,
      chatId,
    ]);
  }
}

interface ConversationRow {
  session: string;
  chat_id: string;
  phone: string;
  name: string | null;
  mode: string;
  muted_until: string | null; // pg returns BIGINT as string
  messages: unknown;
  lead: unknown;
  created_at: string;
  updated_at: string;
}

function rowToConversation(r: ConversationRow): Conversation {
  return {
    session: r.session,
    chatId: r.chat_id,
    phone: r.phone,
    name: r.name ?? undefined,
    mode: r.mode as ConversationMode,
    mutedUntil: r.muted_until != null ? Number(r.muted_until) : null,
    messages: (Array.isArray(r.messages) ? r.messages : []) as Anthropic.MessageParam[],
    lead: (r.lead && typeof r.lead === 'object' ? r.lead : {}) as Lead,
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
  };
}

/** Construct a Postgres-backed persistence from a connection string. */
export function postgresPersistence(connectionString: string): ConversationPersistence {
  return new PostgresPersistence(connectionString);
}

/** Build the configured persistence backend, or null for in-memory only. */
export function createPersistence(): ConversationPersistence | null {
  if (!config.DATABASE_URL) return null;
  logger.info('Postgres persistence enabled for conversations');
  return postgresPersistence(config.DATABASE_URL);
}
