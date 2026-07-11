import { config } from '../../config.js';
import { logger } from '../../logger.js';
import type { Conversation } from '../../core/conversation.js';
import type { TourOption, TourSearchOutcome } from '../../core/types.js';
import type { SearchToursInput } from '../claude/tools.js';
import { num, toArray, tvGet } from './client.js';
import { resolveCountry, resolveDeparture } from './references.js';
import type { TvHotel, TvResultResponse, TvSearchResponse, TvTour } from './types.js';

/**
 * Orchestrates the async Tourvisor search:
 *   search.php -> requestid -> poll result.php?type=status -> result.php?type=result
 * and maps hotels/tours into client-facing TourOption[]. This is the function
 * injected into the Claude agent as the `search_tours` tool implementation.
 */

const POLL_INITIAL_MS = 4000;
const POLL_INTERVAL_MS = 2000;
const POLL_MAX_MS = 22_000; // keep WhatsApp replies reasonably snappy
const RESULT_LIMIT = 8;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function searchTours(
  input: SearchToursInput,
  _convo: Conversation,
): Promise<TourSearchOutcome> {
  const departure = await resolveDeparture(input.departureCity);
  if (!departure) {
    return {
      status: 'error',
      options: [],
      message: 'не задан город вылета (уточни у клиента или настрой TOURVISOR_DEFAULT_DEPARTURE)',
    };
  }
  const country = await resolveCountry(input.country);
  if (!country) {
    return { status: 'empty', options: [], message: `страна "${input.country}" не найдена` };
  }

  const params = buildSearchParams(input, departure, country);
  logger.info({ params }, 'tourvisor search start');

  const started = await tvGet<TvSearchResponse>('search.php', params);
  const requestId = started.result?.requestid;
  if (!requestId) {
    return { status: 'error', options: [], message: started.result?.error ?? started.error ?? 'search.php не вернул requestid' };
  }

  const finished = await pollUntilReady(String(requestId));
  const result = await tvGet<TvResultResponse>('result.php', {
    requestid: requestId,
    type: 'result',
    page: 1,
    onpage: 25,
    nodescription: 1,
  });

  const options = mapResults(result);
  if (options.length === 0) {
    return {
      status: 'empty',
      options: [],
      message: finished ? undefined : 'поиск не успел завершиться — можно повторить',
    };
  }
  return { status: 'ok', options: options.slice(0, RESULT_LIMIT) };
}

function buildSearchParams(
  input: SearchToursInput,
  departure: string,
  country: string,
): Record<string, string | number | undefined> {
  const { datefrom, dateto } = resolveDateRange(input.dateFrom, input.dateTo);
  const nightsfrom = input.nightsFrom ?? 7;
  const nightsto = input.nightsTo ?? Math.max(nightsfrom, nightsfrom + 3);

  const params: Record<string, string | number | undefined> = {
    departure,
    country,
    datefrom,
    dateto,
    nightsfrom,
    nightsto,
    adults: input.adults ?? 2,
    child: input.children ?? 0,
    currency: config.TOURVISOR_CURRENCY,
    pricetype: 0, // price per room
  };

  const ages = input.childrenAges ?? [];
  if (ages[0] != null) params.childage1 = ages[0];
  if (ages[1] != null) params.childage2 = ages[1];
  if (ages[2] != null) params.childage3 = ages[2];

  if (input.starsFrom) {
    params.stars = input.starsFrom;
    params.starsbetter = 1;
  }
  if (input.priceTo) params.priceto = input.priceTo;

  return params;
}

async function pollUntilReady(requestId: string): Promise<boolean> {
  await sleep(POLL_INITIAL_MS);
  const deadline = Date.now() + POLL_MAX_MS;
  while (Date.now() < deadline) {
    const status = await tvGet<TvResultResponse>('result.php', { requestid: requestId, type: 'status' });
    const st = status.data?.status ?? status.status;
    const state = String(st?.state ?? '').toLowerCase();
    const timepassed = num(st?.timepassed);
    if (state === 'finished') return true;
    if (timepassed !== undefined && timepassed > 7) return true; // render partial per docs
    await sleep(POLL_INTERVAL_MS);
  }
  return false;
}

function mapResults(res: TvResultResponse): TourOption[] {
  const hotels = toArray(res.data?.result?.hotel);
  const options: TourOption[] = [];

  for (const hotel of hotels) {
    const best = cheapestTour(hotel);
    if (!best) continue;
    const price = num(best.price) ?? num(hotel.price);
    if (price === undefined) continue;
    options.push({
      hotelName: hotel.hotelname ?? 'Отель',
      stars: num(hotel.hotelstars),
      region: hotel.regionname,
      country: hotel.countryname,
      meal: best.mealrussian || best.meal,
      nights: num(best.nights),
      flyDate: best.flydate,
      price,
      currency: normalizeCurrency(best.currency),
      operator: best.operatorname,
      link: hotel.fulldesclink || hotel.reviewlink,
    });
  }
  options.sort((a, b) => a.price - b.price);
  return options;
}

function cheapestTour(hotel: TvHotel): TvTour | undefined {
  const tours = toArray(hotel.tours?.tour);
  if (tours.length === 0) return undefined;
  return tours.reduce((min, t) => {
    const p = num(t.price) ?? Infinity;
    const mp = num(min.price) ?? Infinity;
    return p < mp ? t : min;
  });
}

function normalizeCurrency(cur?: string): string | undefined {
  if (!cur) return undefined;
  const map: Record<string, string> = { RUB: '₽', EUR: '€', USD: '$', KZT: '₸', BYN: 'Br' };
  return map[cur.toUpperCase()] ?? cur;
}

// --- date helpers -----------------------------------------------------------

/** Convert ISO YYYY-MM-DD to Tourvisor's dd.mm.yyyy. */
function isoToTv(iso: string): string | undefined {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return undefined;
  return `${m[3]}.${m[2]}.${m[1]}`;
}

/** Build a valid departure-date range (max 14-day span). Omit to use Tourvisor defaults. */
function resolveDateRange(
  dateFrom?: string,
  dateTo?: string,
): { datefrom?: string; dateto?: string } {
  const from = dateFrom ? isoToTv(dateFrom) : undefined;
  if (!from) return {}; // let Tourvisor default (tomorrow .. +8)
  let to = dateTo ? isoToTv(dateTo) : undefined;
  if (!to && dateFrom) {
    const d = new Date(dateFrom);
    if (!Number.isNaN(d.getTime())) {
      d.setDate(d.getDate() + 7);
      to = isoToTv(d.toISOString());
    }
  }
  // Cap span at 14 days.
  if (from && to) {
    const [df, mf, yf] = from.split('.').map(Number) as [number, number, number];
    const [dt, mt, yt] = to.split('.').map(Number) as [number, number, number];
    const a = new Date(yf, mf - 1, df);
    const b = new Date(yt, mt - 1, dt);
    if ((b.getTime() - a.getTime()) / 86_400_000 > 14) {
      a.setDate(a.getDate() + 14);
      to = isoToTv(a.toISOString());
    }
  }
  return { datefrom: from, dateto: to };
}
