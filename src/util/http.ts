import { logger } from '../logger.js';

export interface FetchOptions extends RequestInit {
  /** Milliseconds before the request is aborted. Default 15000. */
  timeoutMs?: number;
  /** How many times to retry on network error / 5xx. Default 2. */
  retries?: number;
  /** Base backoff in ms between retries (exponential). Default 400. */
  backoffMs?: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * fetch with timeout + bounded exponential-backoff retries.
 * Retries only on network failures and 5xx responses (never on 4xx).
 */
export async function httpFetch(url: string, opts: FetchOptions = {}): Promise<Response> {
  const { timeoutMs = 15_000, retries = 2, backoffMs = 400, ...init } = opts;

  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, { ...init, signal: controller.signal });
      clearTimeout(timer);
      if (res.status >= 500 && attempt < retries) {
        logger.warn({ url, status: res.status, attempt }, 'http 5xx, retrying');
        await sleep(backoffMs * 2 ** attempt);
        continue;
      }
      return res;
    } catch (err) {
      clearTimeout(timer);
      lastErr = err;
      if (attempt < retries) {
        logger.warn({ url, attempt, err: (err as Error).message }, 'http error, retrying');
        await sleep(backoffMs * 2 ** attempt);
        continue;
      }
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(`Request to ${url} failed`);
}

/** GET JSON with retries. Throws on non-2xx. */
export async function getJson<T>(url: string, opts: FetchOptions = {}): Promise<T> {
  const res = await httpFetch(url, { ...opts, method: 'GET' });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`GET ${url} -> ${res.status}: ${body.slice(0, 300)}`);
  }
  return (await res.json()) as T;
}

/** POST JSON with retries. Throws on non-2xx. */
export async function postJson<T>(
  url: string,
  body: unknown,
  opts: FetchOptions = {},
): Promise<T> {
  const res = await httpFetch(url, {
    ...opts,
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(opts.headers ?? {}) },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`POST ${url} -> ${res.status}: ${text.slice(0, 300)}`);
  }
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}
