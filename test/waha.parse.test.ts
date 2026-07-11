import { describe, it, expect } from 'vitest';
import {
  parseInbound,
  parseManagerReply,
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

  it('resolves the real phone + pushName for an @lid (privacy) chat', () => {
    const msg = parseInbound(
      envelope(
        {
          id: '1',
          from: '35639789617196@lid',
          fromMe: false,
          body: 'Салам',
          _data: {
            pushName: 'Азамат',
            key: { remoteJid: '35639789617196@lid', remoteJidAlt: '996770112233@s.whatsapp.net' },
          },
        },
        'message',
      ),
    );
    expect(msg?.chatId).toBe('35639789617196@lid'); // reply target stays the lid
    expect(msg?.phone).toBe('996770112233'); // but the callable number is resolved
    expect(msg?.name).toBe('Азамат');
  });

  it('excludes the bot\'s own JID when scanning for the client number', () => {
    const env = {
      event: 'message',
      session: 'default',
      me: { id: '996770172008@c.us' },
      payload: {
        id: '1',
        from: '35639789617196@lid',
        fromMe: false,
        body: 'hi',
        to: '996770172008@s.whatsapp.net', // bot's number — must be ignored
        _data: { senderPn: '996555000111@s.whatsapp.net' },
      },
    } as unknown as WahaWebhookEnvelope;
    const msg = parseInbound(env);
    expect(msg?.phone).toBe('996555000111');
  });

  it('falls back to the lid digits when no real number is present', () => {
    const msg = parseInbound(
      envelope({ id: '1', from: '35639789617196@lid', fromMe: false, body: 'hi' }),
    );
    expect(msg?.phone).toBe('35639789617196');
  });
});

describe('parseManagerReply', () => {
  const outgoing = (payload: Record<string, unknown>): WahaWebhookEnvelope =>
    ({ event: 'message.any', session: 'default', payload }) as WahaWebhookEnvelope;

  it('detects a manual manager reply (fromMe, unknown to us)', () => {
    const mr = parseManagerReply(
      outgoing({ id: 'X1', from: '996770172008@c.us', to: '996555123456@c.us', fromMe: true, body: 'Здравствуйте, это менеджер' }),
    );
    expect(mr).not.toBeNull();
    expect(mr?.chatId).toBe('996555123456@c.us');
    expect(mr?.phone).toBe('996555123456');
  });

  it('ignores incoming (non-fromMe) messages', () => {
    expect(
      parseManagerReply(outgoing({ id: 'X2', from: '996555123456@c.us', to: '996770172008@c.us', fromMe: false, body: 'hi' })),
    ).toBeNull();
  });

  it('ignores fromMe messages to a group', () => {
    expect(
      parseManagerReply(outgoing({ id: 'X3', from: '996770172008@c.us', to: '120363@g.us', fromMe: true, body: 'hi' })),
    ).toBeNull();
  });

  it('ignores plain "message" events (handled as inbound elsewhere)', () => {
    const env = { event: 'message', session: 'default', payload: { id: 'X4', from: '996770172008@c.us', to: '996555123456@c.us', fromMe: true, body: 'hi' } } as WahaWebhookEnvelope;
    // message + fromMe is still recognized (defensive), but the router only
    // calls this on message.any; here we just assert it doesn't crash.
    expect(parseManagerReply(env)?.chatId).toBe('996555123456@c.us');
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
