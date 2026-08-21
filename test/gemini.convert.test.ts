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

  it('renders past tool loops as text — no functionCall parts without signatures', () => {
    // Gemini 3.x rejects functionCall parts lacking thoughtSignature, and stored
    // history has none (incl. Claude-era turns) — so old loops become prose.
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
    const allParts = contents.flatMap((c) => c.parts ?? []);
    expect(allParts.every((p) => 'text' in p && !('functionCall' in p) && !('functionResponse' in p))).toBe(true);
    expect(contents[1]!.parts![1]!.text).toContain('search_tours');
    expect(contents[1]!.parts![1]!.text).toContain('Турция');
    expect(contents[2]!.parts![0]!.text).toContain('Найдено 3 варианта');
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
