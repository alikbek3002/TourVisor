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
 * History is stored in Anthropic MessageParam format — the store's canonical
 * shape, shared with the Claude agent and persisted to Postgres — so switching
 * providers keeps every existing conversation. Convert at request time:
 * assistant→model, tool_use→functionCall, tool_result→functionResponse.
 * Function ids are omitted: Gemini matches responses to calls by name/order,
 * and rejects nothing that way regardless of which provider minted the history.
 */
export function toGeminiContents(messages: Anthropic.MessageParam[]): Content[] {
  const out: Content[] = [];
  const toolNames = new Map<string, string>(); // tool_use_id → tool name
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
          toolNames.set(block.id, block.name);
          parts.push({
            functionCall: { name: block.name, args: (block.input ?? {}) as Record<string, unknown> },
          });
        } else if (block.type === 'tool_result') {
          const name = toolNames.get(block.tool_use_id) ?? 'unknown_tool';
          const output =
            typeof block.content === 'string' ? block.content : JSON.stringify(block.content ?? '');
          parts.push({ functionResponse: { name, response: { output } } });
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

  for (let iter = 0; iter < MAX_TOOL_ITERATIONS; iter++) {
    const response = await getClient().models.generateContent({
      model: config.GEMINI_MODEL,
      contents: toGeminiContents(convo.messages),
      config: {
        systemInstruction: system,
        tools: [{ functionDeclarations }],
        maxOutputTokens: config.CLAUDE_MAX_TOKENS,
        // Snappy chat replies; only flash/lite models allow disabling thinking.
        ...(/flash|lite/i.test(config.GEMINI_MODEL)
          ? { thinkingConfig: { thinkingBudget: 0 } }
          : {}),
      },
    });

    const text = (response.text ?? '').trim();
    const calls = response.functionCalls ?? [];

    if (!calls.length) {
      conversations.append(convo, { role: 'assistant', content: text || FALLBACK_REPLY });
      return { reply: text || FALLBACK_REPLY, escalated };
    }

    // Preserve the model turn (text + tool calls) in the canonical history shape.
    const blocks: Anthropic.ContentBlockParam[] = [];
    if (text) blocks.push({ type: 'text', text });
    const ids = calls.map((fc, i) => fc.id ?? `fc_${Date.now()}_${iter}_${i}`);
    calls.forEach((fc, i) => {
      blocks.push({ type: 'tool_use', id: ids[i]!, name: fc.name ?? '', input: fc.args ?? {} });
    });
    conversations.append(convo, { role: 'assistant', content: blocks });

    // Execute every call, collect results into ONE user message.
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
      toolResults.push({ type: 'tool_result', tool_use_id: ids[i]!, content: resultText });
    }
    conversations.append(convo, { role: 'user', content: toolResults });
  }

  logger.warn({ chatId: convo.chatId, session: convo.session }, 'gemini agent hit tool-iteration cap');
  return { reply: ITERATION_CAP_REPLY, escalated: true };
}
