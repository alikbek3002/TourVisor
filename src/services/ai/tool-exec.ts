import { logger } from '../../logger.js';
import type { Company } from '../../core/companies.js';
import type { Conversation } from '../../core/conversation.js';
import { conversations } from '../../core/conversation.js';
import type { TourSearchOutcome } from '../../core/types.js';
import { notifyAdmin } from '../telegram/notifier.js';
import {
  TOOL_COLLECT_LEAD,
  TOOL_ESCALATE,
  TOOL_SEARCH_TOURS,
  type CollectLeadInput,
  type EscalateInput,
  type SearchToursInput,
} from '../claude/tools.js';

/**
 * Provider-agnostic tool execution for the agent loop. Both the Claude and the
 * Gemini agents call the same three business tools; only the model API differs.
 */

export const MAX_TOOL_ITERATIONS = 6;

export interface AgentDeps {
  /** Runs a Tourvisor search and returns normalized options. */
  searchTours: (input: SearchToursInput, convo: Conversation) => Promise<TourSearchOutcome>;
}

export interface AgentResult {
  reply: string;
  escalated: boolean;
}

export const FALLBACK_REPLY = 'Извините, не расслышала 🙏 Повторите, пожалуйста?';
export const ITERATION_CAP_REPLY = 'Секунду, уточняю детали — с вами свяжется менеджер. 🙌';

export async function executeTool(
  name: string,
  input: unknown,
  convo: Conversation,
  deps: AgentDeps,
  company: Company,
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
          clientChatId: convo.chatId,
          clientName: convo.name || convo.lead.name,
          company: company.name,
          session: convo.session,
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
    const note = outcome.note ? `${outcome.note}\n` : '';
    return `${note}Ничего не найдено по этим параметрам${outcome.message ? ` (${outcome.message})` : ''}. Предложи смягчить условия: другие даты, бюджет или направление.`;
  }
  const lines = outcome.options.slice(0, 5).map((o, i) => {
    const parts = [
      `${i + 1}. ${o.hotelName}${o.stars ? ` ${o.stars}★` : ''}`,
      o.rating && o.rating > 0 ? `рейтинг ${o.rating}` : undefined,
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
  const note = outcome.note ? `${outcome.note}\n` : '';
  return `${note}Найдены варианты. Перескажи 2–4 лучших человеческим языком (отель, класс, питание, даты, цена за весь тур). Для КАЖДОГО показанного варианта ОБЯЗАТЕЛЬНО добавь его «ссылку» целиком, отдельной строкой — без неё вариант не показывай. Не используй markdown-выделение (* и **); символ звезды ★ для класса отеля — можно:\n${lines.join('\n')}${footer}`;
}

function lastUserText(convo: Conversation): string | undefined {
  for (let i = convo.messages.length - 1; i >= 0; i--) {
    const m = convo.messages[i];
    if (m?.role === 'user' && typeof m.content === 'string') return m.content;
  }
  return undefined;
}
