import pg from 'pg';
import { config } from '../config.js';
import { logger } from '../logger.js';

/**
 * Company (tenant) registry. Each company is a tour agency with its own
 * WhatsApp number, connected as a separate WAHA session. The Claude prompt is
 * shared — only the company name is interpolated per tenant.
 *
 * The owner's company (COMPANY_NAME + WAHA_SESSION from env) always exists:
 * it's seeded into the DB on first boot, or kept as an in-memory entry when
 * DATABASE_URL is unset (single-tenant mode, the pre-multitenant behaviour).
 */

export interface Company {
  id: number;
  name: string;
  /** WAHA session name, e.g. "company-2". The owner's is config.WAHA_SESSION. */
  session: string;
  active: boolean;
  /** Optional per-company Telegram chat for lead alerts (not used yet). */
  telegramChatId?: string;
  createdAt: number;
}

interface CompanyRow {
  id: number;
  name: string;
  session: string;
  telegram_chat_id: string | null;
  active: boolean;
  created_at: string; // pg returns BIGINT as string
}

function rowToCompany(r: CompanyRow): Company {
  return {
    id: r.id,
    name: r.name,
    session: r.session,
    active: r.active,
    telegramChatId: r.telegram_chat_id ?? undefined,
    createdAt: Number(r.created_at),
  };
}

function ownerCompany(): Company {
  return {
    id: 0,
    name: config.COMPANY_NAME,
    session: config.WAHA_SESSION,
    active: true,
    createdAt: 0,
  };
}

class CompanyStore {
  private map = new Map<string, Company>(); // session → company
  private pool: pg.Pool | null = null;

  /** Load companies from Postgres (seeding the owner's row) or fall back to in-memory owner-only. */
  async init(): Promise<void> {
    // The owner always exists, even with no database (overridden by the DB row below).
    this.map.set(config.WAHA_SESSION, ownerCompany());

    if (!config.DATABASE_URL) return;
    this.pool = new pg.Pool({
      connectionString: config.DATABASE_URL,
      ssl: /sslmode=require/.test(config.DATABASE_URL) ? { rejectUnauthorized: false } : undefined,
      max: 2,
    });
    this.pool.on('error', (err) => logger.warn({ err: err.message }, 'companies pg pool error'));

    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS companies (
        id               SERIAL PRIMARY KEY,
        name             TEXT NOT NULL,
        session          TEXT NOT NULL UNIQUE,
        telegram_chat_id TEXT,
        active           BOOLEAN NOT NULL DEFAULT TRUE,
        created_at       BIGINT NOT NULL
      );
    `);
    // Seed/refresh the owner's company; env stays the source of truth for its name.
    await this.pool.query(
      `INSERT INTO companies (name, session, created_at) VALUES ($1, $2, $3)
       ON CONFLICT (session) DO UPDATE SET name = EXCLUDED.name`,
      [config.COMPANY_NAME, config.WAHA_SESSION, Date.now()],
    );

    const { rows } = await this.pool.query<CompanyRow>(
      `SELECT id, name, session, telegram_chat_id, active, created_at FROM companies ORDER BY id`,
    );
    for (const r of rows) this.map.set(r.session, rowToCompany(r));
    logger.info({ companies: this.map.size }, 'company registry loaded');
  }

  bySession(session: string): Company | undefined {
    return this.map.get(session);
  }

  list(): Company[] {
    return [...this.map.values()].sort((a, b) => a.id - b.id);
  }

  /** Resolve an admin-typed reference: numeric id, session name, or company name. */
  find(arg: string): Company | undefined {
    const q = arg.trim();
    if (!q) return undefined;
    if (/^\d+$/.test(q)) {
      const id = Number(q);
      return this.list().find((c) => c.id === id);
    }
    return (
      this.map.get(q) ?? this.list().find((c) => c.name.toLowerCase() === q.toLowerCase())
    );
  }

  /** Create a new company; its WAHA session name is derived from the row id. */
  async create(name: string): Promise<Company> {
    if (!this.pool) {
      throw new Error('нужна база данных (DATABASE_URL), чтобы добавлять компании');
    }
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      // Placeholder session keeps the UNIQUE constraint happy until we know the id.
      const inserted = await client.query<{ id: number }>(
        `INSERT INTO companies (name, session, created_at)
         VALUES ($1, 'pending-' || md5(clock_timestamp()::text || random()::text), $2)
         RETURNING id`,
        [name, Date.now()],
      );
      const id = inserted.rows[0]!.id;
      const updated = await client.query<CompanyRow>(
        `UPDATE companies SET session = 'company-' || id WHERE id = $1
         RETURNING id, name, session, telegram_chat_id, active, created_at`,
        [id],
      );
      await client.query('COMMIT');
      const company = rowToCompany(updated.rows[0]!);
      this.map.set(company.session, company);
      logger.info({ id: company.id, name: company.name, session: company.session }, 'company created');
      return company;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  /** Deactivate a company — its messages stop being processed; the row is kept. */
  async deactivate(session: string): Promise<Company | undefined> {
    const company = this.map.get(session);
    if (!company) return undefined;
    if (this.pool) {
      await this.pool.query(`UPDATE companies SET active = FALSE WHERE session = $1`, [session]);
    }
    company.active = false;
    return company;
  }
}

export const companies = new CompanyStore();
