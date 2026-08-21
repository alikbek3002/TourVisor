import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { postgresPersistence, type ConversationPersistence } from '../src/core/persistence.js';
import type { Conversation } from '../src/core/conversation.js';

// Opt-in: point TEST_DATABASE_URL at a throwaway Postgres to run these.
//   docker run -d -e POSTGRES_PASSWORD=pass -e POSTGRES_DB=tourbot -p 55432:5432 postgres:16-alpine
//   TEST_DATABASE_URL=postgres://postgres:pass@localhost:55432/tourbot npm test
const DB = process.env.TEST_DATABASE_URL;

describe.skipIf(!DB)('PostgresPersistence (integration)', () => {
  let p: ConversationPersistence;
  const chatId = 'itest-9999@c.us';
  const session = 'default';

  const sample: Conversation = {
    session,
    chatId,
    phone: '9999',
    name: 'Тест',
    mode: 'human',
    mutedUntil: null,
    messages: [
      { role: 'user', content: 'Привет' },
      { role: 'assistant', content: [{ type: 'text', text: 'Здравствуйте ☀️' }] },
    ],
    lead: { country: 'Турция', adults: 2 },
    createdAt: 1000,
    updatedAt: 2000,
  };

  beforeAll(async () => {
    p = postgresPersistence(DB!);
    await p.init();
    await p.init(); // migration must be idempotent — a second boot must not throw
    await p.delete(session, chatId);
    await p.delete('itest-other', chatId);
  });

  afterAll(async () => {
    await p.delete(session, chatId);
    await p.delete('itest-other', chatId);
  });

  it('round-trips a conversation (mode, lead and messages survive)', async () => {
    await p.upsert(sample);
    const found = (await p.loadAll(0)).find((r) => r.chatId === chatId && r.session === session);
    expect(found).toBeDefined();
    expect(found?.mode).toBe('human'); // escalation state survives a restart
    expect(found?.name).toBe('Тест');
    expect(found?.lead).toEqual({ country: 'Турция', adults: 2 });
    expect(found?.messages).toHaveLength(2);
    expect(found?.messages[0]?.role).toBe('user');
  });

  it('stores the same chatId under two sessions independently', async () => {
    await p.upsert(sample);
    await p.upsert({ ...sample, session: 'itest-other', mode: 'bot', updatedAt: 2500 });
    const rows = (await p.loadAll(0)).filter((r) => r.chatId === chatId);
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.session === 'itest-other')?.mode).toBe('bot');
    expect(rows.find((r) => r.session === session)?.mode).toBe('human');
  });

  it('respects the sinceMs filter', async () => {
    const rows = await p.loadAll(3000); // updatedAt 2000/2500 < 3000 → excluded
    expect(rows.find((r) => r.chatId === chatId)).toBeUndefined();
  });

  it('deletes only the addressed (session, chatId)', async () => {
    await p.delete(session, chatId);
    const rows = await p.loadAll(0);
    expect(rows.find((r) => r.chatId === chatId && r.session === session)).toBeUndefined();
    expect(rows.find((r) => r.chatId === chatId && r.session === 'itest-other')).toBeDefined();
  });
});
