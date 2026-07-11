import { describe, it, expect, vi } from 'vitest';
import { conversations } from '../src/core/conversation.js';

describe('ConversationStore', () => {
  it('creates a conversation in bot mode', () => {
    const c = conversations.getOrCreate('1@c.us', '1', 'Ann');
    expect(c.mode).toBe('bot');
    expect(conversations.isBotActive(c)).toBe(true);
    expect(c.name).toBe('Ann');
  });

  it('handToHuman(null) silences the bot until returnToBot', () => {
    const c = conversations.getOrCreate('2@c.us', '2');
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
      const c = conversations.getOrCreate('3@c.us', '3');
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
    const c = conversations.getOrCreate('h1@c.us', '111');
    conversations.handToHuman(c, null);

    expect(conversations.stats().human).toBeGreaterThan(0);
    expect(conversations.listHuman().some((h) => h.chatId === 'h1@c.us')).toBe(true);
  });

  it('trims history but keeps it starting on a user turn', () => {
    const c = conversations.getOrCreate('trim@c.us', '999');
    for (let i = 0; i < 60; i++) {
      conversations.append(c, { role: i % 2 === 0 ? 'user' : 'assistant', content: `m${i}` });
    }
    expect(c.messages.length).toBeLessThanOrEqual(40);
    expect(c.messages[0]?.role).toBe('user');
  });
});
