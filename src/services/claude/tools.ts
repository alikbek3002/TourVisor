import type Anthropic from '@anthropic-ai/sdk';

/**
 * Tool definitions for the sales agent (Anthropic tool-use).
 *
 * The tool INPUT schemas are intentionally client-friendly (country/city names,
 * ISO dates). The Tourvisor client is responsible for translating them into the
 * provider's own parameter format (reference ids, dd.mm.yyyy dates).
 */

export const TOOL_SEARCH_TOURS = 'search_tours';
export const TOOL_ESCALATE = 'escalate_to_manager';
export const TOOL_COLLECT_LEAD = 'collect_lead';

export const tools: Anthropic.Tool[] = [
  {
    name: TOOL_SEARCH_TOURS,
    description:
      'Ищет актуальные туры через Tourvisor по заданным параметрам. Вызывай, когда собрал хотя бы направление (страну), примерные даты/месяц и количество человек. Возвращает список из нескольких лучших вариантов туров с ценами и ссылками. НЕ выдумывай цены — используй только результаты этого инструмента.',
    input_schema: {
      type: 'object',
      properties: {
        country: {
          type: 'string',
          description: 'Страна назначения на русском, напр. "Турция", "Египет", "ОАЭ", "Таиланд".',
        },
        hotelName: {
          type: 'string',
          description:
            'Название конкретного отеля, если клиент его назвал (напр. «Rixos Premium Belek», «Delphin Imperial», «Titanic Deluxe»). Бот сам найдёт код этого отеля в справочнике страны и покажет туры ИМЕННО в него. Обязательно вместе с country (страна, где находится отель). Если название написано с ошибкой или отель не найден — бот сообщит, тогда уточни название у клиента.',
        },
        departureCity: {
          type: 'string',
          description:
            'Город вылета на русском, напр. "Москва", "Бишкек", "Алматы". Если клиент не указал — оставь пустым, будет использован город по умолчанию.',
        },
        dateFrom: {
          type: 'string',
          description: 'Дата начала диапазона вылета в формате YYYY-MM-DD. Если известен только месяц — возьми начало месяца.',
        },
        dateTo: {
          type: 'string',
          description: 'Дата конца диапазона вылета в формате YYYY-MM-DD. Обычно dateFrom + 7-14 дней.',
        },
        nightsFrom: { type: 'integer', description: 'Минимум ночей, напр. 7.' },
        nightsTo: { type: 'integer', description: 'Максимум ночей, напр. 10.' },
        adults: { type: 'integer', description: 'Количество взрослых. По умолчанию 2.' },
        children: { type: 'integer', description: 'Количество детей. По умолчанию 0.' },
        childrenAges: {
          type: 'array',
          items: { type: 'integer' },
          description: 'Возраст каждого ребёнка в годах, если есть дети.',
        },
        starsFrom: {
          type: 'integer',
          description: 'Минимальная звёздность отеля (1-5), если клиент указал пожелание.',
        },
        meal: {
          type: 'string',
          description:
            'Тип питания, если важно клиенту: "всё включено", "завтрак", "полупансион" и т.п.',
        },
        priceTo: {
          type: 'integer',
          description: 'Максимальный бюджет за тур (в валюте агентства), если клиент назвал.',
        },
        priceFrom: {
          type: 'integer',
          description:
            'Нижняя граница цены за тур — жёсткий пол: в выдачу попадут ТОЛЬКО туры дороже этой суммы. Ставь ОБЯЗАТЕЛЬНО, когда клиент называет минимум: «есть выше 5000?», «от 5000 долларов», «дороже 4000», «не меньше 3000» → priceFrom = названная сумма. Также ставь, когда клиент хочет подороже/премиум или назвал вилку (тогда priceFrom ≈ 50–60% от потолка). Без него бот покажет только самые дешёвые. Примеры: «есть что-то выше 5000?» → priceFrom=5000; «до 6000, отели получше» → priceFrom≈3500, priceTo=6000.',
        },
        sort: {
          type: 'string',
          enum: ['cheapest', 'premium'],
          description:
            'Как отбирать варианты. cheapest (по умолчанию) — самые бюджетные. premium — лучшие/подороже: клиент просит премиум, «подороже», отели высокого класса, или ищем аналог названным дорогим отелям. Тогда бот сортирует по рейтингу и цене от лучших к дешёвым и автоматически поднимает класс отелей (от 4★), даже если starsFrom не задан — так в выдачу реально попадают отели классом выше, а не те же дешёвые.',
        },
      },
      required: ['country'],
      additionalProperties: false,
    },
  },
  {
    name: TOOL_ESCALATE,
    description:
      'Передаёт диалог живому менеджеру и отправляет уведомление администратору в Telegram. Вызывай, когда: клиент готов бронировать или оплачивать; клиент просит человека/менеджера; клиент недоволен, жалуется или у него проблема с уже купленным туром; вопрос выходит за рамки подбора (визы, возврат денег, спецусловия). После вызова спокойно сообщи клиенту, что менеджер скоро свяжется.',
    input_schema: {
      type: 'object',
      properties: {
        reason: {
          type: 'string',
          enum: ['buying_intent', 'complaint', 'manager_request', 'other'],
          description:
            'buying_intent — готов купить/забронировать; complaint — жалоба/проблема; manager_request — просит менеджера; other — прочее вне подбора.',
        },
        summary: {
          type: 'string',
          description:
            'Короткое резюме для менеджера: что хочет клиент или в чём проблема, с ключевыми деталями (направление, даты, тур, суть жалобы).',
        },
        urgency: {
          type: 'string',
          enum: ['normal', 'high'],
          description: 'high — если срочно (форс-мажор, задержка рейса, острая жалоба).',
        },
        tourLink: {
          type: 'string',
          description: 'Ссылка на конкретный тур, если клиент выбрал вариант из поиска.',
        },
      },
      required: ['reason', 'summary'],
      additionalProperties: false,
    },
  },
  {
    name: TOOL_COLLECT_LEAD,
    description:
      'Сохраняет контактные данные и параметры клиента, когда он проявил серьёзный интерес. Не спрашивай данные навязчиво — заполняй тем, что клиент уже сообщил.',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Имя клиента.' },
        country: { type: 'string', description: 'Интересующее направление.' },
        dateFrom: { type: 'string', description: 'Желаемая дата/месяц поездки.' },
        nights: { type: 'integer', description: 'Количество ночей.' },
        adults: { type: 'integer', description: 'Взрослых.' },
        children: { type: 'integer', description: 'Детей.' },
        budget: { type: 'string', description: 'Ориентировочный бюджет.' },
        notes: { type: 'string', description: 'Дополнительные пожелания.' },
      },
      required: [],
      additionalProperties: false,
    },
  },
];

/** Parsed input shapes (Claude guarantees the schema, we trust-but-narrow). */
export interface SearchToursInput {
  country: string;
  hotelName?: string;
  departureCity?: string;
  dateFrom?: string;
  dateTo?: string;
  nightsFrom?: number;
  nightsTo?: number;
  adults?: number;
  children?: number;
  childrenAges?: number[];
  starsFrom?: number;
  meal?: string;
  priceTo?: number;
  priceFrom?: number;
  sort?: 'cheapest' | 'premium';
}

export interface EscalateInput {
  reason: 'buying_intent' | 'complaint' | 'manager_request' | 'other';
  summary: string;
  urgency?: 'normal' | 'high';
  tourLink?: string;
}

export interface CollectLeadInput {
  name?: string;
  country?: string;
  dateFrom?: string;
  nights?: number;
  adults?: number;
  children?: number;
  budget?: string;
  notes?: string;
}
