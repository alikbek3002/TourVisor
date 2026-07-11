import { config } from '../../config.js';
import { logger } from '../../logger.js';
import { tvGet, toArray } from './client.js';
import type {
  TvCountry,
  TvDeparture,
  TvListCountriesResponse,
  TvListDeparturesResponse,
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
