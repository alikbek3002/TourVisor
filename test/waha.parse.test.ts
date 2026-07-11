import { describe, it, expect } from 'vitest';
import {
  parseInbound,
  phoneToChatId,
  chatIdToPhone,
  isGroupChat,
} from '../src/services/waha/client.js';
import type { WahaWebhookEnvelope } from '../src/services/waha/types.js';

const envelope = (payload: Record<string, unknown>, event = 'message'): WahaWebhookEnvelope =>
  ({ event, session: 'default', payload }) as WahaWebhookEnvelope;

describe('parseInbound', () => {
  it('parses a normal 1:1 text message', () => {
    const msg = parseInbound(
      envelope({ id: '1', from: '996555123456@c.us', fromMe: false, body: 'Привет', notifyName: 'Иван' }),
    );
    expect(msg).not.toBeNull();
    expect(msg?.phone).toBe('996555123456');
    expect(msg?.text).toBe('Привет');
    expect(msg?.name).toBe('Иван');
    expect(msg?.isGroup).toBe(false);
  });

  it('trims surrounding whitespace from the body', () => {
    const msg = parseInbound(envelope({ id: '1', from: '996555123456@c.us', fromMe: false, body: '  hi  ' }));
    expect(msg?.text).toBe('hi');
  });

  it('ignores our own echoes (fromMe)', () => {
    expect(parseInbound(envelope({ id: '1', from: '996555123456@c.us', fromMe: true, body: 'hi' }))).toBeNull();
  });

  it('ignores group chats', () => {
    expect(parseInbound(envelope({ id: '1', from: '120363@g.us', fromMe: false, body: 'hi' }))).toBeNull();
  });

  it('ignores empty / media-only messages', () => {
    expect(parseInbound(envelope({ id: '1', from: '996555123456@c.us', fromMe: false, body: '   ' }))).toBeNull();
  });

  it('ignores non-message events', () => {
    expect(
      parseInbound(envelope({ from: '996555123456@c.us', fromMe: false, body: 'hi' }, 'session.status')),
    ).toBeNull();
  });

  it('accepts message.any events', () => {
    expect(
      parseInbound(envelope({ id: '1', from: '996555123456@c.us', fromMe: false, body: 'hi' }, 'message.any')),
    ).not.toBeNull();
  });

  it('reads notifyName nested in _data', () => {
    const msg = parseInbound(
      envelope({ id: '1', from: '996555123456@c.us', fromMe: false, body: 'hi', _data: { notifyName: 'Пётр' } }),
    );
    expect(msg?.name).toBe('Пётр');
  });
});

describe('chatId helpers', () => {
  it('phoneToChatId strips non-digits and appends @c.us', () => {
    expect(phoneToChatId('+996 555 123456')).toBe('996555123456@c.us');
  });

  it('chatIdToPhone extracts digits', () => {
    expect(chatIdToPhone('996555123456@c.us')).toBe('996555123456');
  });

  it('isGroupChat distinguishes groups from 1:1', () => {
    expect(isGroupChat('120363@g.us')).toBe(true);
    expect(isGroupChat('996555123456@c.us')).toBe(false);
  });
});
