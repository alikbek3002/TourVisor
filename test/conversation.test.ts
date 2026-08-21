import { describe, it, expect, vi } from 'vitest';
import { conversations, convoKey } from '../src/core/conversation.js';

const S = 'default'; // tenant (WAHA session) used by most tests

describe('ConversationStore', () => {
  it('creates a conversation in bot mode', () => {
    const c = conversations.getOrCreate(S, '1@c.us', '1', 'Ann');
    expect(c.mode).toBe('bot');
    expect(conversations.isBotActive(c)).toBe(true);
    expect(c.name).toBe('Ann');
    expect(c.session).toBe(S);
  });

  it('isolates the same phone across tenants', () => {
    const a = conversations.getOrCreate('company-1', '77@c.us', '77');
    const b = conversations.getOrCreate('company-2', '77@c.us', '77');
    expect(a).not.toBe(b);

    conversations.handToHuman(a, null);
    expect(conversations.isBotActive(a)).toBe(false);
    expect(conversations.isBotActive(b)).toBe(true); // other tenant unaffected

    expect(conversations.get('company-1', '77@c.us')).toBe(a);
    expect(conversations.get('company-2', '77@c.us')).toBe(b);
    expect(conversations.getAllByPhone('77')).toHaveLength(2);
    expect(conversations.findAllByChatId('77@c.us')).toHaveLength(2);
  });

  it('handToHuman(null) silences the bot until returnToBot', () => {
    const c = conversations.getOrCreate(S, '2@c.us', '2');
    conversations.handToHuman(c, null);
    expect(c.mode).toBe('human');
    expect(conversations.isBotActive(c)).toBe(false);

    conversations.returnToBot(c);
    expect(c.mode).toBe('bot');
    expect(conversations.isBotActive(c)).toBe(true);
  });

  it('handToHuman(muteMs) auto-resumes after the mute window elapses', () => {
    vi.useFakeTimers();
    try {
      const c = conversations.getOrCreate(S, '3@c.us', '3');
      conversations.handToHuman(c, 30 * 60_000);
      expect(conversations.isBotActive(c)).toBe(false);

      vi.advanceTimersByTime(31 * 60_000);
      expect(conversations.isBotActive(c)).toBe(true); // auto-resumed
      expect(c.mode).toBe('bot');
    } finally {
      vi.useRealTimers();
    }
  });

  it('stats and listHuman reflect human-mode chats', () => {
    const c = conversations.getOrCreate(S, 'h1@c.us', '111');
    conversations.handToHuman(c, null);

    expect(conversations.stats().human).toBeGreaterThan(0);
    expect(conversations.listHuman().some((h) => h.chatId === 'h1@c.us' && h.session === S)).toBe(
      true,
    );
    expect(conversations.statsBySession().get(S)?.human).toBeGreaterThan(0);
  });

  it('trims history but keeps it starting on a user turn', () => {
    const c = conversations.getOrCreate(S, 'trim@c.us', '999');
    for (let i = 0; i < 60; i++) {
      conversations.append(c, { role: i % 2 === 0 ? 'user' : 'assistant', content: `m${i}` });
    }
    expect(c.messages.length).toBeLessThanOrEqual(40);
    expect(c.messages[0]?.role).toBe('user');
  });
});

describe('convoKey', () => {
  it('splits unambiguously on the first colon', () => {
    const key = convoKey('company-2', '996555123456@c.us');
    const sep = key.indexOf(':');
    expect(key.slice(0, sep)).toBe('company-2');
    expect(key.slice(sep + 1)).toBe('996555123456@c.us');
  });
});
