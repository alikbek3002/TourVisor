import { describe, it, expect } from 'vitest';
import { matchesAllowlist } from '../src/core/allowlist.js';

const CHAT = '996555123456@c.us';
const PHONE = '996555123456';

describe('matchesAllowlist', () => {
  it('allows everyone when the allowlist is empty', () => {
    expect(matchesAllowlist(PHONE, CHAT, [])).toBe(true);
  });

  it('matches an exact phone', () => {
    expect(matchesAllowlist(PHONE, CHAT, ['996555123456'])).toBe(true);
  });

  it('matches an exact chatId', () => {
    expect(matchesAllowlist(PHONE, CHAT, ['996555123456@c.us'])).toBe(true);
  });

  it('matches a digit suffix (local number)', () => {
    expect(matchesAllowlist(PHONE, CHAT, ['555123456'])).toBe(true);
  });

  it('matches an entry with punctuation and spaces', () => {
    expect(matchesAllowlist(PHONE, CHAT, ['+996 555 123456'])).toBe(true);
  });

  it('rejects a number that is not listed', () => {
    expect(matchesAllowlist(PHONE, CHAT, ['996111000000'])).toBe(false);
  });

  it('does NOT allow everyone when an entry has no digits', () => {
    expect(matchesAllowlist(PHONE, CHAT, ['abc'])).toBe(false);
  });
});
