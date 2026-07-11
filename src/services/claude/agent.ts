import Anthropic from '@anthropic-ai/sdk';
import { config } from '../../config.js';
import { logger } from '../../logger.js';
import type { Conversation } from '../../core/conversation.js';
import { conversations } from '../../core/conversation.js';
import type { TourSearchOutcome } from '../../core/types.js';
import { notifyAdmin } from '../telegram/notifier.js';
import { buildSystemPrompt } from './prompts.js';
import {
  tools,
  TOOL_COLLECT_LEAD,
  TOOL_ESCALATE,
  TOOL_SEARCH_TOURS,
  type CollectLeadInput,
  type EscalateInput,
  type SearchToursInput,
} from './tools.js';

const MAX_TOOL_ITERATIONS = 6;

// Reuse a single client. thinking disabled → snappy replies + simple history
// (no thinking blocks to preserve across the tool-use loop).
const client = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY });

export interface AgentDeps {
  /** Runs a Tourvisor search and returns normalized options. */
  searchTours: (input: SearchToursInput, convo: Conversation) => Promise<TourSearchOutcome>;
}

export interface AgentResult {
  reply: string;
  escalated: boolean;
}

/**
 * Run one assistant turn: the user's latest message is already appended to
 * `convo.messages`. Drives the tool-use loop until the model stops calling
 * tools, then returns the text to send back on WhatsApp.
 */
export async function runAgentTurn(convo: Conversation, deps: AgentDeps): Promise<AgentResult> {
  const system = buildSystemPrompt();
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
      const { text, didEscalate } = await executeTool(block.name, block.input, convo, deps);
      escalated ||= didEscalate;
      toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: text });
    }

    conversations.append(convo, { role: 'user', content: toolResults });
  }

  logger.warn({ chatId: convo.chatId }, 'agent hit tool-iteration cap');
  return {
    reply: 'Секунду, уточняю детали — с вами свяжется менеджер. 🙌',
    escalated: true,
  };
}

async function executeTool(
  name: string,
  input: unknown,
  convo: Conversation,
  deps: AgentDeps,
): Promise<{ text: string; didEscalate: boolean }> {
  try {
    switch (name) {
      case TOOL_SEARCH_TOURS: {
        const outcome = await deps.searchTours(input as SearchToursInput, convo);
        return { text: formatOutcomeForModel(outcome), didEscalate: false };
      }
      case TOOL_ESCALATE: {
        const args = input as EscalateInput;
        conversations.handToHuman(convo);
        await notifyAdmin({
          reason:
            args.reason === 'other'
              ? 'manager_request'
              : (args.reason as 'buying_intent' | 'complaint' | 'manager_request'),
          clientPhone: convo.phone,
          clientName: convo.name || convo.lead.name,
          summary: args.summary + (args.urgency === 'high' ? ' [СРОЧНО]' : ''),
          lastMessage: lastUserText(convo),
          tourLink: args.tourLink,
        });
        return {
          text: 'Готово: менеджер уведомлён и скоро свяжется с клиентом. Сообщи клиенту об этом.',
          didEscalate: true,
        };
      }
      case TOOL_COLLECT_LEAD: {
        const args = input as CollectLeadInput;
        conversations.updateLead(convo, {
          name: args.name,
          country: args.country,
          dateFrom: args.dateFrom,
          nights: args.nights,
          adults: args.adults,
          children: args.children,
          budget: args.budget,
          notes: args.notes,
        });
        return { text: 'Данные клиента сохранены.', didEscalate: false };
      }
      default:
        logger.warn({ name }, 'unknown tool call');
        return { text: `Неизвестный инструмент: ${name}`, didEscalate: false };
    }
  } catch (err) {
    logger.error({ err: (err as Error).message, name }, 'tool execution failed');
    return {
      text: `Инструмент временно недоступен (${(err as Error).message}). Предложи клиенту повторить чуть позже или передай менеджеру.`,
      didEscalate: false,
    };
  }
}

/** Render tour options into compact text the model turns into a friendly reply. */
function formatOutcomeForModel(outcome: TourSearchOutcome): string {
  if (outcome.status === 'error') {
    return `Поиск не удался: ${outcome.message ?? 'ошибка сервиса'}. Предложи клиенту уточнить параметры или повторить.`;
  }
  if (outcome.status === 'empty' || outcome.options.length === 0) {
    return `Ничего не найдено по этим параметрам${outcome.message ? ` (${outcome.message})` : ''}. Предложи смягчить условия: другие даты, бюджет или направление.`;
  }
  const lines = outcome.options.slice(0, 5).map((o, i) => {
    const parts = [
      `${i + 1}. ${o.hotelName}${o.stars ? ` ${o.stars}★` : ''}`,
      o.region && `${o.region}${o.country ? `, ${o.country}` : ''}`,
      o.meal,
      o.nights && `${o.nights} ноч.`,
      o.flyDate && `вылет ${o.flyDate}`,
      `${Math.round(o.price)} ${o.currency ?? ''}`.trim(),
      o.operator && `(${o.operator})`,
      o.link && `ссылка: ${o.link}`,
    ].filter(Boolean);
    return parts.join(' — ');
  });
  const footer = outcome.searchLink ? `\nВсе варианты: ${outcome.searchLink}` : '';
  return `Найдены варианты (перескажи 2-4 лучших человеческим языком, с ценой и ссылкой):\n${lines.join('\n')}${footer}`;
}

function extractText(content: Anthropic.ContentBlock[]): string {
  const text = content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim();
  return text || 'Извините, не расслышала 🙏 Повторите, пожалуйста?';
}

function lastUserText(convo: Conversation): string | undefined {
  for (let i = convo.messages.length - 1; i >= 0; i--) {
    const m = convo.messages[i];
    if (m?.role === 'user' && typeof m.content === 'string') return m.content;
  }
  return undefined;
}
