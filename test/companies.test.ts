import { describe, it, expect, beforeAll } from 'vitest';
import { companies } from '../src/core/companies.js';

// Tests run without DATABASE_URL (vitest.config.ts nulls dotenv), so init()
// falls back to the in-memory owner-only registry — the single-tenant mode.
describe('CompanyStore (no database)', () => {
  beforeAll(async () => {
    await companies.init();
  });

  it('always contains the owner company from env defaults', () => {
    const owner = companies.bySession('default');
    expect(owner).toBeDefined();
    expect(owner?.name).toBe('Aisuluu Travel');
    expect(owner?.active).toBe(true);
    expect(companies.list()).toHaveLength(1);
  });

  it('find() resolves by id, session, and case-insensitive name', () => {
    expect(companies.find('0')?.session).toBe('default');
    expect(companies.find('default')?.session).toBe('default');
    expect(companies.find('aisuluu travel')?.session).toBe('default');
    expect(companies.find('AISULUU TRAVEL')?.session).toBe('default');
    expect(companies.find('no-such-company')).toBeUndefined();
    expect(companies.find('')).toBeUndefined();
  });

  it('create() refuses without a database', async () => {
    await expect(companies.create('Тест Тревел')).rejects.toThrow(/база/i);
  });
});
