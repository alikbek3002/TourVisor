import { describe, it, expect } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import { sanitizeHistory } from '../src/core/conversation.js';

const user = (text: string): Anthropic.MessageParam => ({ role: 'user', content: text });
const toolUse = (id: string): Anthropic.MessageParam => ({
  role: 'assistant',
  content: [{ type: 'tool_use', id, name: 'search_tours', input: {} }],
});
const toolResult = (id: string): Anthropic.MessageParam => ({
  role: 'user',
  content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }],
});
const assistant = (text: string): Anthropic.MessageParam => ({ role: 'assistant', content: text });

describe('sanitizeHistory', () => {
  it('leaves a short, valid history untouched', () => {
    const h = [user('привет'), assistant('здравствуйте')];
    expect(sanitizeHistory(h)).toBe(h);
  });

  it('never starts on a tool_result (the 400 "unexpected tool_use_id" bug)', () => {
    // Trimming to the last 3 would land exactly on the tool_result.
    const h = [user('a'), toolUse('t1'), toolResult('t1'), assistant('b'), user('c')];
    const out = sanitizeHistory(h, 3);
    expect(out).toEqual([user('c')]);
  });

  it('repairs a history already poisoned by the old trim', () => {
    const broken = [toolResult('t1'), assistant('b'), user('c'), assistant('d')];
    const out = sanitizeHistory(broken, 40);
    expect(out).toEqual([user('c'), assistant('d')]);
  });

  it('trims to the last N when the cut already lands on a plain user turn', () => {
    const h = [user('1'), assistant('1'), user('2'), assistant('2'), user('3')];
    expect(sanitizeHistory(h, 3).map((m) => m.content)).toEqual(['2', '2', '3']);
  });

  it('falls back to the earliest valid turn when the tail is one long tool loop', () => {
    const h = [user('a'), toolUse('t1'), toolResult('t1'), toolUse('t2'), toolResult('t2')];
    const out = sanitizeHistory(h, 2);
    expect(out[0]).toEqual(user('a') as never);
    expect(out).toHaveLength(5);
  });

  it('handles an empty history', () => {
    expect(sanitizeHistory([])).toEqual([]);
  });
});
