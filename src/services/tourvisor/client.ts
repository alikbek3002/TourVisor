import { config } from '../../config.js';
import { httpFetch } from '../../util/http.js';

/**
 * Low-level Tourvisor gateway client.
 * Base: https://tourvisor.ru/xml/ — all calls are GET with authlogin/authpass
 * and format=json. Quirks handled here:
 *  - Auth failure returns HTTP 200 with the plaintext body "Authorization Error".
 *  - Responses are gzip/deflate (Node fetch decompresses automatically).
 *  - Numbers come back as strings; single items may be objects, not arrays.
 */

export class TourvisorAuthError extends Error {}
export class TourvisorError extends Error {}

function buildUrl(endpoint: string, params: Record<string, string | number | undefined>): string {
  const base = config.TOURVISOR_BASE_URL.replace(/\/$/, '');
  const qs = new URLSearchParams({
    authlogin: config.TOURVISOR_AUTH_LOGIN ?? '',
    authpass: config.TOURVISOR_AUTH_PASS ?? '',
    format: 'json',
  });
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') qs.set(k, String(v));
  }
  return `${base}/${endpoint}?${qs.toString()}`;
}

/** GET a Tourvisor endpoint and parse JSON, surfacing auth/format errors clearly. */
export async function tvGet<T>(
  endpoint: string,
  params: Record<string, string | number | undefined>,
  opts: { timeoutMs?: number } = {},
): Promise<T> {
  if (!config.features.tourvisor) {
    throw new TourvisorError('Tourvisor не настроен (нет authlogin/authpass)');
  }
  const url = buildUrl(endpoint, params);
  const res = await httpFetch(url, {
    method: 'GET',
    headers: { Accept: 'application/json', 'Accept-Encoding': 'gzip, deflate' },
    timeoutMs: opts.timeoutMs ?? 15_000,
    retries: 1,
  });
  const body = (await res.text()).trim();

  // Auth failures come back as HTTP 200 + plaintext, not JSON.
  if (body.startsWith('Authorization Error')) {
    throw new TourvisorAuthError('Tourvisor: неверные authlogin/authpass');
  }
  if (!body) {
    // Empty body (e.g. missing required filter like regcountry) — treat as empty result.
    return {} as T;
  }
  try {
    return JSON.parse(body) as T;
  } catch {
    throw new TourvisorError(`Tourvisor: неожиданный ответ (${body.slice(0, 120)})`);
  }
}

/** Normalize Tourvisor's "single item may be an object, not an array" quirk. */
export function toArray<T>(v: T[] | T | undefined | null): T[] {
  if (v == null) return [];
  return Array.isArray(v) ? v : [v];
}

/** Tourvisor returns numbers as strings; parse defensively. */
export function num(v: unknown): number | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  const n = typeof v === 'number' ? v : parseFloat(String(v).replace(',', '.'));
  return Number.isFinite(n) ? n : undefined;
}
