import { describe, it, expect } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import { toGeminiContents } from '../src/services/ai/gemini.agent.js';

describe('toGeminiContents', () => {
  it('maps plain user/assistant turns to user/model text parts', () => {
    const messages: Anthropic.MessageParam[] = [
      { role: 'user', content: 'Привет' },
      { role: 'assistant', content: 'Здравствуйте! 😊' },
    ];
    const contents = toGeminiContents(messages);
    expect(contents).toEqual([
      { role: 'user', parts: [{ text: 'Привет' }] },
      { role: 'model', parts: [{ text: 'Здравствуйте! 😊' }] },
    ]);
  });

  it('converts a full tool-use round trip (Claude-era history included)', () => {
    const messages: Anthropic.MessageParam[] = [
      { role: 'user', content: 'Тур в Турцию' },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Сейчас поищу' },
          { type: 'tool_use', id: 'toolu_123', name: 'search_tours', input: { country: 'Турция' } },
        ],
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'toolu_123', content: 'Найдено 3 варианта' }],
      },
      { role: 'assistant', content: 'Вот варианты…' },
    ];
    const contents = toGeminiContents(messages);
    expect(contents).toHaveLength(4);
    expect(contents[1]).toEqual({
      role: 'model',
      parts: [
        { text: 'Сейчас поищу' },
        { functionCall: { name: 'search_tours', args: { country: 'Турция' } } },
      ],
    });
    // functionResponse resolves the tool NAME from the preceding tool_use id.
    expect(contents[2]).toEqual({
      role: 'user',
      parts: [{ functionResponse: { name: 'search_tours', response: { output: 'Найдено 3 варианта' } } }],
    });
  });

  it('skips empty text blocks and empty turns entirely', () => {
    const messages: Anthropic.MessageParam[] = [
      { role: 'user', content: '  ' },
      { role: 'user', content: 'ок' },
      { role: 'assistant', content: [{ type: 'text', text: '' }] },
    ];
    const contents = toGeminiContents(messages);
    expect(contents).toEqual([{ role: 'user', parts: [{ text: 'ок' }] }]);
  });
});
