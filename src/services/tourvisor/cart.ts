import { config } from '../../config.js';
import { logger } from '../../logger.js';
import { httpFetch } from '../../util/http.js';

/**
 * Tourvisor "module cart" integration. The agency's site embeds Tourvisor's
 * search module; a shareable per-tour link on that site looks like
 * `<site>/podbor-tura#tvcartid=<cartId>`. That cartId is created via the
 * module's cart API (not the search API):
 *   1. POST /api/v1.1/sessions {ModuleId}          -> session key `k`
 *   2. GET  /xml/cart2.php?k=<k>&tourid=<id>&action=add -> { status: { cartid } }
 *
 * TOURVISOR_MODULE_ID enables this; the site origin (for the required Referer)
 * is taken from TOUR_LINK_TEMPLATE.
 */

const SESSION_URL = 'https://tourvisor.ru/api/v1.1/sessions';
const CART_URL = 'https://tourvisor.ru/xml/cart2.php';
const KEY_TTL_MS = 1000 * 60 * 30;

let cachedKey: { key: string; at: number } | null = null;

function siteOrigin(): string {
  try {
    return config.TOUR_LINK_TEMPLATE ? new URL(config.TOUR_LINK_TEMPLATE).origin : '';
  } catch {
    return '';
  }
}

async function sessionKey(): Promise<string | null> {
  if (cachedKey && Date.now() - cachedKey.at < KEY_TTL_MS) return cachedKey.key;
  const origin = siteOrigin();
  try {
    const res = await httpFetch(SESSION_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Referer: `${origin}/`, Origin: origin },
      body: JSON.stringify({ ModuleId: Number(config.TOURVISOR_MODULE_ID) }),
      timeoutMs: 10_000,
      retries: 1,
    });
    const data = (await res.json()) as { k?: string };
    if (data.k) {
      cachedKey = { key: data.k, at: Date.now() };
      return data.k;
    }
  } catch (err) {
    logger.debug({ err: (err as Error).message }, 'tourvisor session key failed');
  }
  return null;
}

/** Create a single-tour module cart and return its cart id (for #tvcartid links). */
export async function createCartId(tourid: string): Promise<string | null> {
  if (!config.TOURVISOR_MODULE_ID || !tourid) return null;
  const k = await sessionKey();
  if (!k) return null;
  try {
    const u = new URL(CART_URL);
    u.searchParams.set('k', k);
    u.searchParams.set('tourid', tourid);
    u.searchParams.set('action', 'add');
    u.searchParams.set('format', 'json');
    const res = await httpFetch(u.toString(), {
      headers: { Referer: `${siteOrigin()}/` },
      timeoutMs: 10_000,
      retries: 1,
    });
    const data = (await res.json()) as { status?: { cartid?: number } };
    const id = data.status?.cartid;
    return id ? String(id) : null;
  } catch (err) {
    logger.debug({ err: (err as Error).message, tourid }, 'createCartId failed');
    return null;
  }
}
