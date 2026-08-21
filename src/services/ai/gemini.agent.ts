import { GoogleGenAI, type Content, type FunctionDeclaration, type Part } from '@google/genai';
import type Anthropic from '@anthropic-ai/sdk';
import { config } from '../../config.js';
import { logger } from '../../logger.js';
import type { Company } from '../../core/companies.js';
import type { Conversation } from '../../core/conversation.js';
import { conversations } from '../../core/conversation.js';
import { buildSystemPrompt } from '../claude/prompts.js';
import { tools } from '../claude/tools.js';
import {
  executeTool,
  FALLBACK_REPLY,
  ITERATION_CAP_REPLY,
  MAX_TOOL_ITERATIONS,
  type AgentDeps,
  type AgentResult,
} from './tool-exec.js';

// Lazy singleton — only constructed when Gemini is actually used.
let client: GoogleGenAI | null = null;
function getClient(): GoogleGenAI {
  if (!client) client = new GoogleGenAI({ apiKey: config.GEMINI_API_KEY });
  return client;
}

/** The same business tools, declared in Gemini's format (JSON Schema passthrough). */
const functionDeclarations: FunctionDeclaration[] = tools.map((t) => ({
  name: t.name,
  description: t.description,
  parametersJsonSchema: t.input_schema,
}));

/**
 * Gemini 3.x replaced thinkingBudget with thinkingLevel (a numeric budget is a
 * hard 400 there); 2.5-flash models still take thinkingBudget: 0. Either way we
 * want minimal thinking — this is a snappy sales chat.
 */
function thinkingConfigFor(model: string): Record<string, unknown> | undefined {
  if (/^gemini-[3-9]/.test(model)) return { thinkingLevel: 'low' };
  if (/flash|lite/i.test(model)) return { thinkingBudget: 0 };
  return undefined;
}

/**
 * History is stored in Anthropic MessageParam format — the store's canonical
 * shape, shared with the Claude agent and persisted to Postgres — so switching
 * providers keeps every existing conversation.
 *
 * Gemini 3.x validates thought signatures on functionCall parts, and stored
 * history has none (Claude-era turns never had them; ours are stripped by the
 * canonical format). So PAST tool loops are rendered as plain text — the model
 * still sees what was searched and found — while the LIVE loop inside
 * runGeminiTurn keeps Gemini's own parts verbatim, signatures included.
 */
export function toGeminiContents(messages: Anthropic.MessageParam[]): Content[] {
  const out: Content[] = [];
  for (const m of messages) {
    const role = m.role === 'assistant' ? 'model' : 'user';
    const parts: Part[] = [];
    if (typeof m.content === 'string') {
      if (m.content.trim()) parts.push({ text: m.content });
    } else {
      for (const block of m.content) {
        if (typeof block !== 'object' || block == null) continue;
        if (block.type === 'text' && block.text.trim()) {
          parts.push({ text: block.text });
        } else if (block.type === 'tool_use') {
          parts.push({
            text: `(вызов инструмента ${block.name} с параметрами ${JSON.stringify(block.input ?? {})})`,
          });
        } else if (block.type === 'tool_result') {
          const output =
            typeof block.content === 'string' ? block.content : JSON.stringify(block.content ?? '');
          parts.push({ text: `(результат инструмента: ${output})` });
        }
        // other block types (thinking, images, …) are not produced by this bot
      }
    }
    if (parts.length) out.push({ role, parts });
  }
  return out;
}

/**
 * Run one assistant turn via Gemini: the user's latest message is already
 * appended to `convo.messages`. Drives the function-calling loop until the
 * model stops calling tools, then returns the text to send back to the client.
 */
export async function runGeminiTurn(
  convo: Conversation,
  deps: AgentDeps,
  company: Company,
): Promise<AgentResult> {
  const system = buildSystemPrompt(company.name);
  let escalated = false;

  // Live request contents: converted history + this turn's verbatim exchanges.
  const contents = toGeminiContents(convo.messages);

  for (let iter = 0; iter < MAX_TOOL_ITERATIONS; iter++) {
    const response = await getClient().models.generateContent({
      model: config.GEMINI_MODEL,
      contents,
      config: {
        systemInstruction: system,
        tools: [{ functionDeclarations }],
        maxOutputTokens: config.CLAUDE_MAX_TOKENS,
        ...(thinkingConfigFor(config.GEMINI_MODEL)
          ? { thinkingConfig: thinkingConfigFor(config.GEMINI_MODEL) }
          : {}),
      },
    });

    const text = (response.text ?? '').trim();
    const calls = response.functionCalls ?? [];

    if (!calls.length) {
      conversations.append(convo, { role: 'assistant', content: text || FALLBACK_REPLY });
      return { reply: text || FALLBACK_REPLY, escalated };
    }

    // Keep the model's own parts verbatim in the live request — Gemini 3.x
    // requires the thoughtSignature they carry on every functionCall part.
    const modelParts = response.candidates?.[0]?.content?.parts;
    contents.push({ role: 'model', parts: modelParts ?? [] });

    // Mirror the turn into the canonical history shape for storage.
    const blocks: Anthropic.ContentBlockParam[] = [];
    if (text) blocks.push({ type: 'text', text });
    const ids = calls.map((fc, i) => fc.id ?? `fc_${Date.now()}_${iter}_${i}`);
    calls.forEach((fc, i) => {
      blocks.push({ type: 'tool_use', id: ids[i]!, name: fc.name ?? '', input: fc.args ?? {} });
    });
    conversations.append(convo, { role: 'assistant', content: blocks });

    // Execute every call; feed results back both to Gemini and to the store.
    const responseParts: Part[] = [];
    const toolResults: Anthropic.ToolResultBlockParam[] = [];
    for (let i = 0; i < calls.length; i++) {
      const fc = calls[i]!;
      const { text: resultText, didEscalate } = await executeTool(
        fc.name ?? '',
        fc.args ?? {},
        convo,
        deps,
        company,
      );
      escalated ||= didEscalate;
      responseParts.push({
        functionResponse: {
          ...(fc.id ? { id: fc.id } : {}),
          name: fc.name ?? '',
          response: { output: resultText },
        },
      });
      toolResults.push({ type: 'tool_result', tool_use_id: ids[i]!, content: resultText });
    }
    contents.push({ role: 'user', parts: responseParts });
    conversations.append(convo, { role: 'user', content: toolResults });
  }

  logger.warn({ chatId: convo.chatId, session: convo.session }, 'gemini agent hit tool-iteration cap');
  return { reply: ITERATION_CAP_REPLY, escalated: true };
}
