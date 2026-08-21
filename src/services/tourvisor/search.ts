import { config } from '../../config.js';
import { logger } from '../../logger.js';
import type { Conversation } from '../../core/conversation.js';
import type { TourOption, TourSearchOutcome } from '../../core/types.js';
import type { SearchToursInput } from '../claude/tools.js';
import { num, toArray, tvGet } from './client.js';
import { createCartId } from './cart.js';
import { resolveCountry, resolveDeparture, resolveHotels } from './references.js';
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
const RESULT_LIMIT = 5; // formatOutcomeForModel forwards at most 5 anyway

/**
 * A named budget means "close to this money", not "as cheap as possible": the
 * search floor is set to this share of the ceiling, so «до 5000» yields a
 * 3000–5000 pool instead of the country's cheapest tours.
 */
export const BUDGET_FLOOR_RATIO = 0.6;

/** Budget signals used to pick a tour per hotel and to rank the results. */
export interface BudgetContext {
  /** EXPLICIT client floor only (derived floors are request-side, not display-side). */
  priceFrom?: number;
  priceTo?: number;
  cheap?: boolean;
}

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

  // If the client named a specific hotel, resolve it to Tourvisor hotel code(s)
  // within that country and filter the search to it. If we can't find it, fall
  // back to a normal country search and tell the model so it can explain.
  let hotelCodes: string[] | undefined;
  let note: string | undefined;
  if (input.hotelName?.trim()) {
    const matches = await resolveHotels(country, input.hotelName);
    if (matches.length) {
      hotelCodes = matches.map((m) => m.id);
      logger.info(
        { hotelName: input.hotelName, matched: matches.map((m) => m.name) },
        'resolved hotel name → codes',
      );
    } else {
      note = `Отель «${input.hotelName}» не найден в справочнике по стране — искал БЕЗ фильтра по отелю. Скажи клиенту, что именно этот отель не нашёл (возможно, опечатка в названии или он не у этого туроператора), уточни название или предложи похожие варианты.`;
      logger.info({ hotelName: input.hotelName, country }, 'hotel name not resolved');
    }
  }

  const budget: BudgetContext = {
    priceFrom: input.priceFrom,
    priceTo: input.priceTo,
    cheap: input.sort === 'cheapest',
  };
  const params = buildSearchParams(input, departure, country, hotelCodes);
  const relaxedParams = buildSearchParams(input, departure, country, hotelCodes, { relaxed: true });
  // Whether this search carries constraints WE derived from the budget (floor,
  // 4★) rather than ones the client named — those are safe to drop on retry.
  const hasDerived =
    params.pricefrom !== relaxedParams.pricefrom || params.stars !== relaxedParams.stars;

  logger.info({ params }, 'tourvisor search start');
  let run = await executeSearch(params, budget);
  if (run.error) return { status: 'error', options: [], message: run.error };

  let usedFallback = false;
  if (run.mapped.length === 0 && hasDerived) {
    // Nothing near the budget with a 4★ floor — retry once without the derived
    // constraints (the client's own parameters stay) and show the best available.
    logger.info({ relaxedParams }, 'near-budget search empty — retrying relaxed');
    run = await executeSearch(relaxedParams, budget);
    if (run.error) return { status: 'error', options: [], message: run.error };
    usedFallback = true;
  }

  const ranked = rankOptions(applyPriceFloor(run.mapped, input.priceFrom), input);
  const options = ranked.slice(0, RESULT_LIMIT);
  if (options.length === 0) {
    // If the client named a price floor and it removed everything, say so
    // explicitly so the model offers to lower it instead of silently falling
    // back to the cheap tours the client just rejected.
    const flooredOut = Boolean(input.priceFrom) && run.mapped.length > 0;
    let message: string | undefined;
    if (hotelCodes) {
      message = `по отелю «${input.hotelName}» на эти даты/условия туров нет — предложи клиенту другие даты, похожие отели того же уровня или убрать часть фильтров`;
    } else if (flooredOut) {
      message = `все найденные туры дешевле порога priceFrom=${input.priceFrom}; дороже этой суммы в этих условиях ничего нет — предложи клиенту снизить порог или сменить даты/направление`;
    } else if (!run.finished) {
      message = 'поиск не успел завершиться — можно повторить';
    }
    return { status: 'empty', options: [], message, note };
  }
  if (usedFallback) {
    const fallbackNote = `Около бюджета ${input.priceTo} с отелями 4★+ ничего не нашлось — показаны лучшие ДОСТУПНЫЕ варианты (дешевле или классом ниже). Честно скажи об этом клиенту и предложи сменить даты/направление, если хочет ближе к бюджету.`;
    note = note ? `${note}\n${fallbackNote}` : fallbackNote;
  }
  await enrichCartLinks(options);
  return { status: 'ok', options, note };
}

/** One search.php → poll → result.php round trip, mapped with budget context. */
async function executeSearch(
  params: Record<string, string | number | undefined>,
  budget: BudgetContext,
): Promise<{ mapped: TourOption[]; finished: boolean; error?: string }> {
  const started = await tvGet<TvSearchResponse>('search.php', params);
  const requestId = started.result?.requestid;
  if (!requestId) {
    return {
      mapped: [],
      finished: false,
      error: started.result?.error ?? started.error ?? 'search.php не вернул requestid',
    };
  }
  const finished = await pollUntilReady(String(requestId));
  const result = await tvGet<TvResultResponse>('result.php', {
    requestid: requestId,
    type: 'result',
    page: 1,
    onpage: 50, // wider set so premium/pricier options are available to rank
    nodescription: 1,
  });
  return { mapped: mapResults(result, budget), finished };
}

/**
 * Order results for display.
 * - explicit 'cheapest' (or no budget at all) — price ascending (mapResults order);
 * - named budget (priceTo, not cheapest) — closest to the budget first, better
 *   hotels breaking ties, so «до 5000» shows the 4700-5000 options, not the 700 ones;
 * - 'premium' — best hotels first (rating/stars), pricier breaking ties.
 */
export function rankOptions(
  options: TourOption[],
  input: Pick<SearchToursInput, 'sort' | 'priceFrom' | 'priceTo'>,
): TourOption[] {
  const premium = input.sort === 'premium';
  const nearBudget = input.sort !== 'cheapest' && Boolean(input.priceTo);
  if (premium) {
    return [...options].sort((a, b) => quality(b) - quality(a) || b.price - a.price);
  }
  if (nearBudget) {
    return [...options].sort((a, b) => b.price - a.price || quality(b) - quality(a));
  }
  return options; // mapResults already sorts by price asc
}

/**
 * Hotel quality for ranking. Tourvisor's hotelrating is often 0/absent — fall
 * back to stars (slightly discounted) so an unrated 5★ doesn't sink below a
 * rated 3★.
 */
function quality(o: TourOption): number {
  return o.rating && o.rating > 0 ? o.rating : (o.stars ?? 0) * 0.9;
}

/**
 * Enforce a client-named price floor on the results. Tourvisor's `pricefrom`
 * already filters server-side, but this guarantees the client-facing promise —
 * when someone asks for "варианты выше 5000" we never show anything cheaper,
 * even if the provider slips a below-floor tour into the set.
 */
export function applyPriceFloor(options: TourOption[], priceFrom?: number): TourOption[] {
  if (!priceFrom) return options;
  return options.filter((o) => o.price >= priceFrom);
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
  hotelCodes?: string[],
  opts?: { relaxed?: boolean },
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

  // Budget semantics live HERE, not in the model's judgement:
  // - a named ceiling (priceTo, and the client didn't ask for "подешевле")
  //   means "close to this money" → derive a floor at BUDGET_FLOOR_RATIO and
  //   a 4★ class floor, so the candidate pool is actually near the budget;
  // - premium always means at least 4★, even when starsFrom was sent lower;
  // - explicit client values (priceFrom, starsFrom, a range) always win.
  // `relaxed: true` drops only the DERIVED constraints — used for the retry
  // when nothing exists near the budget.
  const cheap = input.sort === 'cheapest';
  const premium = input.sort === 'premium';
  const nearBudget = !cheap && Boolean(input.priceTo);
  const derive = !opts?.relaxed;

  let starsFrom = input.starsFrom;
  if (derive) {
    if (premium) starsFrom = Math.max(starsFrom ?? 0, 4);
    else if (nearBudget && starsFrom == null) starsFrom = 4;
  }
  if (starsFrom) {
    params.stars = starsFrom;
    params.starsbetter = 1;
  }
  // Restrict the search to specific hotel(s) when the client named one.
  if (hotelCodes?.length) params.hotels = hotelCodes.join(',');

  if (input.priceTo) params.priceto = input.priceTo;
  if (input.priceFrom) params.pricefrom = input.priceFrom;
  else if (derive && nearBudget) params.pricefrom = Math.round(input.priceTo! * BUDGET_FLOOR_RATIO);

  const meal = mealCode(input.meal);
  if (meal) {
    params.meal = meal;
    params.mealbetter = 1; // include this meal type or better
  }

  return params;
}

/** Map a free-text meal preference to Tourvisor's numeric meal code (or undefined). */
export function mealCode(meal?: string): number | undefined {
  if (!meal) return undefined;
  const m = meal.toLowerCase();
  if (/ультра|uai|ultra/.test(m)) return 7; // ultra all inclusive
  if (/всё включ|все включ|all\s*incl|\bai\b|инклюзив/.test(m)) return 5; // all inclusive
  if (/полный пансион|\bfb\b|full board/.test(m)) return 4;
  if (/полупансион|полу-?пансион|\bhb\b|half board/.test(m)) return 3;
  if (/завтрак|\bbb\b|breakfast/.test(m)) return 2;
  return undefined; // "любое"/неизвестно — не фильтруем
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

export function mapResults(res: TvResultResponse, budget?: BudgetContext): TourOption[] {
  const hotels = toArray(res.data?.result?.hotel);
  const options: TourOption[] = [];

  for (const hotel of hotels) {
    const best = pickTour(hotel, budget);
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
      rating: num(hotel.hotelrating),
      tourId: best.tourid,
      link: buildTourLink(hotel, best),
    });
  }
  options.sort((a, b) => a.price - b.price);
  return options;
}

/**
 * Pick the hotel's representative tour. Historically this was always the
 * CHEAPEST one, which made a 5★ hotel with a $4800 suite show up (and rank) as
 * its $2900 standard room. With a named budget we take the most expensive tour
 * that still fits, so each hotel is represented by its closest-to-budget offer.
 * With only an explicit floor — the cheapest tour that clears it, so the hotel
 * isn't dropped by applyPriceFloor when a qualifying tour exists.
 */
export function pickTour(hotel: TvHotel, budget?: BudgetContext): TvTour | undefined {
  const tours = toArray(hotel.tours?.tour);
  if (tours.length === 0) return undefined;
  const priceOf = (t: TvTour): number => num(t.price) ?? Infinity;

  if (budget && !budget.cheap && budget.priceTo) {
    const fits = tours.filter((t) => {
      const p = num(t.price);
      return p != null && p <= budget.priceTo! && (budget.priceFrom == null || p >= budget.priceFrom);
    });
    if (fits.length) return fits.reduce((max, t) => (priceOf(t) > priceOf(max) ? t : max));
  } else if (budget?.priceFrom) {
    const above = tours.filter((t) => {
      const p = num(t.price);
      return p != null && p >= budget.priceFrom!;
    });
    if (above.length) return above.reduce((min, t) => (priceOf(t) < priceOf(min) ? t : min));
  }

  return tours.reduce((min, t) => (priceOf(t) < priceOf(min) ? t : min));
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
