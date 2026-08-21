import Anthropic from '@anthropic-ai/sdk';
import { config } from '../../config.js';
import { logger } from '../../logger.js';
import type { Company } from '../../core/companies.js';
import type { Conversation } from '../../core/conversation.js';
import { conversations } from '../../core/conversation.js';
import { buildSystemPrompt } from './prompts.js';
import { tools } from './tools.js';
import {
  executeTool,
  FALLBACK_REPLY,
  ITERATION_CAP_REPLY,
  MAX_TOOL_ITERATIONS,
  type AgentDeps,
  type AgentResult,
} from '../ai/tool-exec.js';

// Reuse a single client. thinking disabled → snappy replies + simple history
// (no thinking blocks to preserve across the tool-use loop).
const client = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY });

/**
 * Run one assistant turn via Claude: the user's latest message is already
 * appended to `convo.messages`. Drives the tool-use loop until the model stops
 * calling tools, then returns the text to send back to the client.
 */
export async function runClaudeTurn(
  convo: Conversation,
  deps: AgentDeps,
  company: Company,
): Promise<AgentResult> {
  const system = buildSystemPrompt(company.name);
  let escalated = false;

  for (let iter = 0; iter < MAX_TOOL_ITERATIONS; iter++) {
    const response = await client.messages.create({
      model: config.CLAUDE_MODEL,
      max_tokens: config.CLAUDE_MAX_TOKENS,
      system,
      tools,
      thinking: { type: 'disabled' },
      messages: convo.messages,
    });

    // Preserve the assistant turn (text + tool_use blocks) in history.
    conversations.append(convo, { role: 'assistant', content: response.content });

    if (response.stop_reason !== 'tool_use') {
      return { reply: extractText(response.content), escalated };
    }

    // Execute every tool_use block, collect results into ONE user message.
    const toolResults: Anthropic.ToolResultBlockParam[] = [];
    for (const block of response.content) {
      if (block.type !== 'tool_use') continue;
      const { text, didEscalate } = await executeTool(block.name, block.input, convo, deps, company);
      escalated ||= didEscalate;
      toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: text });
    }

    conversations.append(convo, { role: 'user', content: toolResults });
  }

  logger.warn({ chatId: convo.chatId }, 'agent hit tool-iteration cap');
  return { reply: ITERATION_CAP_REPLY, escalated: true };
}

function extractText(content: Anthropic.ContentBlock[]): string {
  const text = content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim();
  return text || FALLBACK_REPLY;
}
