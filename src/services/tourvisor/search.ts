import { config } from '../../config.js';
import { logger } from '../../logger.js';
import type { Conversation } from '../../core/conversation.js';
import type { TourOption, TourSearchOutcome } from '../../core/types.js';
import type { SearchToursInput } from '../claude/tools.js';
import { num, toArray, tvGet } from './client.js';
import { createCartId } from './cart.js';
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

  const options = mapResults(result).slice(0, RESULT_LIMIT);
  if (options.length === 0) {
    return {
      status: 'empty',
      options: [],
      message: finished ? undefined : 'поиск не успел завершиться — можно повторить',
    };
  }
  await enrichCartLinks(options);
  return { status: 'ok', options };
}

/** Replace each option's link with a per-tour Tourvisor module cart link (#tvcartid). */
async function enrichCartLinks(options: TourOption[]): Promise<void> {
  const tpl = config.TOUR_LINK_TEMPLATE;
  if (!config.TOURVISOR_MODULE_ID || !tpl || !tpl.includes('{cartid}')) return;
  await Promise.all(
    options.map(async (o) => {
      if (!o.tourId) return;
      const cartId = await createCartId(o.tourId);
      if (cartId) o.link = tpl.replace('{cartid}', cartId);
    }),
  );
}

export function buildSearchParams(
  input: SearchToursInput,
  departure: string,
  country: string,
): Record<string, string | number | undefined> {
  const { datefrom, dateto } = resolveDateRange(input.dateFrom, input.dateTo);
  const nightsfrom = input.nightsFrom ?? 7;
  const nightsto = input.nightsTo ?? Math.max(nightsfrom, nightsfrom + 3);

  const childCount = Math.min(Math.max(input.children ?? 0, 0), 3); // Tourvisor supports up to 3 children
  const ages = input.childrenAges ?? [];

  const params: Record<string, string | number | undefined> = {
    departure,
    country,
    datefrom,
    dateto,
    nightsfrom,
    nightsto,
    adults: input.adults ?? 2,
    child: childCount,
    currency: config.TOURVISOR_CURRENCY,
    pricetype: 0, // price per room
  };

  // Tourvisor requires an age for every child (childage1..3). Default to 7 when
  // the client didn't specify, otherwise the search errors out or returns nothing.
  for (let i = 0; i < childCount; i++) {
    const age = ages[i];
    params[`childage${i + 1}`] = age != null && age >= 0 && age <= 17 ? age : 7;
  }

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

export function mapResults(res: TvResultResponse): TourOption[] {
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
      tourId: best.tourid,
      link: buildTourLink(hotel, best),
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

/** Build the client-facing tour link from TOUR_LINK_TEMPLATE, else Tourvisor's own. */
export function buildTourLink(hotel: TvHotel, tour: TvTour): string | undefined {
  const tpl = config.TOUR_LINK_TEMPLATE;
  if (tpl) {
    let link = tpl
      .replaceAll('{tourid}', tour.tourid ?? '')
      .replaceAll('{hotelcode}', hotel.hotelcode ?? '');
    // {cartid} is filled in asynchronously later; until then drop the fragment
    // so the fallback is a clean base URL rather than a broken "#tvcartid={cartid}".
    if (link.includes('{cartid}')) link = link.replace(/#.*$/, '');
    return link;
  }
  return hotel.fulldesclink || hotel.reviewlink || undefined;
}

export function normalizeCurrency(cur?: string): string | undefined {
  if (!cur) return undefined;
  const map: Record<string, string> = { RUB: '₽', EUR: '€', USD: '$', KZT: '₸', BYN: 'Br' };
  return map[cur.toUpperCase()] ?? cur;
}

// --- date helpers -----------------------------------------------------------

/** Convert ISO YYYY-MM-DD to Tourvisor's dd.mm.yyyy. */
export function isoToTv(iso: string): string | undefined {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return undefined;
  return `${m[3]}.${m[2]}.${m[1]}`;
}

/** Parse ISO YYYY-MM-DD into a UTC Date (no local-timezone drift). */
function parseIsoUtc(iso: string): Date | undefined {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return undefined;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return Number.isNaN(d.getTime()) ? undefined : d;
}

/** Format a UTC Date as Tourvisor's dd.mm.yyyy. */
function tvFromDate(d: Date): string {
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  return `${dd}.${mm}.${d.getUTCFullYear()}`;
}

const DAY_MS = 86_400_000;

/**
 * Build a valid departure-date range (max 14-day span). Omit to use Tourvisor
 * defaults. All math is done in UTC so results don't depend on the server's
 * timezone.
 */
export function resolveDateRange(
  dateFrom?: string,
  dateTo?: string,
): { datefrom?: string; dateto?: string } {
  const from = dateFrom ? parseIsoUtc(dateFrom) : undefined;
  if (!from) return {}; // let Tourvisor default (tomorrow .. +8)

  let to = dateTo ? parseIsoUtc(dateTo) : undefined;
  if (!to) {
    to = new Date(from);
    to.setUTCDate(to.getUTCDate() + 7);
  }
  // Cap the span at 14 days.
  if (to.getTime() - from.getTime() > 14 * DAY_MS) {
    to = new Date(from);
    to.setUTCDate(to.getUTCDate() + 14);
  }
  return { datefrom: tvFromDate(from), dateto: tvFromDate(to) };
}
