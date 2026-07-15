import { config } from '../../config.js';
import { logger } from '../../logger.js';
import { num, tvGet, toArray } from './client.js';
import type {
  TvCountry,
  TvDeparture,
  TvListCountriesResponse,
  TvListDeparturesResponse,
  TvListHotelsResponse,
  TvRefHotel,
} from './types.js';

/**
 * Tourvisor reference dictionaries (departures, countries) — fetched once and
 * cached (they change rarely). Used to resolve human names → numeric ids that
 * search.php requires.
 */

const TTL_MS = 1000 * 60 * 60 * 12; // refresh twice a day

interface Cache {
  departures: TvDeparture[];
  countries: TvCountry[];
  loadedAt: number;
}

let cache: Cache | null = null;
let inflight: Promise<Cache> | null = null;

async function load(): Promise<Cache> {
  const [dep, cnt] = await Promise.all([
    tvGet<TvListDeparturesResponse>('list.php', { type: 'departure' }),
    tvGet<TvListCountriesResponse>('list.php', { type: 'country' }),
  ]);
  const departures = toArray(dep.lists?.departures?.departure).filter((d) => d?.id != null);
  const countries = toArray(cnt.lists?.countries?.country).filter((c) => c?.id != null);
  logger.info({ departures: departures.length, countries: countries.length }, 'tourvisor refs loaded');
  return { departures, countries, loadedAt: Date.now() };
}

async function getCache(): Promise<Cache> {
  if (cache && Date.now() - cache.loadedAt < TTL_MS) return cache;
  if (inflight) return inflight;
  inflight = load()
    .then((c) => {
      cache = c;
      return c;
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

export function normalize(s: string): string {
  return s.trim().toLowerCase().replace(/ё/g, 'е').replace(/[^a-zа-я0-9]/gi, '');
}

/** Resolve a departure-city name to its Tourvisor id (falls back to default). */
export async function resolveDeparture(name?: string): Promise<string | undefined> {
  const fallback = config.TOURVISOR_DEFAULT_DEPARTURE;
  if (!name) return fallback;
  const { departures } = await getCache();
  const q = normalize(name);
  const hit =
    departures.find((d) => normalize(d.name) === q || normalize(d.namefrom ?? '') === q) ??
    departures.find((d) => normalize(d.name).includes(q) || q.includes(normalize(d.name)));
  return hit ? String(hit.id) : fallback;
}

/** Resolve a country name to its Tourvisor id. */
export async function resolveCountry(name: string): Promise<string | undefined> {
  const { countries } = await getCache();
  const q = normalize(name);
  const hit =
    countries.find((c) => normalize(c.name) === q) ??
    countries.find((c) => normalize(c.name).includes(q) || q.includes(normalize(c.name)));
  return hit ? String(hit.id) : undefined;
}

/** Warm the cache on startup (best-effort). */
export async function warmReferences(): Promise<void> {
  if (!config.features.tourvisor) return;
  try {
    await getCache();
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'tourvisor reference warmup failed');
  }
}

// --- hotels (per-country) ---------------------------------------------------
// The hotel dictionary is huge (e.g. ~11.5k for Turkey) and requires a country
// id (hotcountry), so it's cached separately, keyed by country id. Tourvisor has
// no name-search endpoint, so we fetch the country's list once and match names
// locally.

interface HotelCacheEntry {
  hotels: TvRefHotel[];
  loadedAt: number;
}
const hotelCache = new Map<string, HotelCacheEntry>();
const hotelInflight = new Map<string, Promise<TvRefHotel[]>>();

async function loadHotels(countryId: string): Promise<TvRefHotel[]> {
  const res = await tvGet<TvListHotelsResponse>('list.php', { type: 'hotel', hotcountry: countryId });
  const hotels = toArray(res.lists?.hotels?.hotel).filter((h) => h?.id != null && h?.name);
  logger.info({ countryId, hotels: hotels.length }, 'tourvisor hotel list loaded');
  return hotels;
}

async function getHotels(countryId: string): Promise<TvRefHotel[]> {
  const cached = hotelCache.get(countryId);
  if (cached && Date.now() - cached.loadedAt < TTL_MS) return cached.hotels;
  const existing = hotelInflight.get(countryId);
  if (existing) return existing;
  const p = loadHotels(countryId)
    .then((hotels) => {
      hotelCache.set(countryId, { hotels, loadedAt: Date.now() });
      return hotels;
    })
    .finally(() => hotelInflight.delete(countryId));
  hotelInflight.set(countryId, p);
  return p;
}

export interface HotelMatch {
  id: string;
  name: string;
  stars?: number;
}

/**
 * Match a free-text hotel name against a country's hotel dictionary. Pure and
 * unit-testable. Ranks exact > prefix > substring; when an exact match exists we
 * return only exact hits (so "Rixos Premium Belek" doesn't get diluted by every
 * other "Rixos"). A bare word like "rixos" returns the closest few, shortest
 * name first.
 */
export function matchHotels(hotels: TvRefHotel[], name: string, limit = 5): HotelMatch[] {
  const q = normalize(name);
  if (q.length < 3) return [];
  const scored: Array<{ h: TvRefHotel; score: number }> = [];
  for (const h of hotels) {
    const n = normalize(h.name);
    if (!n) continue;
    let score = -1;
    if (n === q) score = 100;
    else if (n.startsWith(q)) score = 80;
    else if (n.includes(q)) score = 60;
    else if (n.length >= 4 && q.includes(n)) score = 40;
    if (score < 0) continue;
    // Tie-break toward shorter (closer) names.
    scored.push({ h, score: score - n.length / 1000 });
  }
  scored.sort((a, b) => b.score - a.score);
  const exactOnly = scored.filter((s) => s.score >= 100 - 1);
  const chosen = exactOnly.length ? exactOnly : scored;
  return chosen.slice(0, limit).map(({ h }) => ({ id: String(h.id), name: h.name, stars: num(h.stars) }));
}

/** Resolve a hotel name to Tourvisor hotel codes within a country (empty = no match). */
export async function resolveHotels(countryId: string, name: string, limit = 5): Promise<HotelMatch[]> {
  try {
    const hotels = await getHotels(countryId);
    return matchHotels(hotels, name, limit);
  } catch (err) {
    logger.warn({ err: (err as Error).message, countryId, name }, 'resolveHotels failed');
    return [];
  }
}
