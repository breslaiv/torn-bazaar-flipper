// Torn API v2 - optional. Der Kern des Scanners laeuft ohne Torn-Key, weil
// weav3r Item-Namen und Marktpreise bereits mitliefert. Der Key erlaubt nur
// die Gegenprobe gegen den echten Item-Market-Tiefstpreis.

import { TORN_API_BASE, TORN_RATE_LIMIT } from './config.js?v=10';
import { RateLimiter } from './ratelimit.js?v=10';

export const limiter = new RateLimiter(TORN_RATE_LIMIT, 'torn');

export class TornApiError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'TornApiError';
    this.code = code;
  }
}

// Der Key wandert als Query-Parameter mit, nicht als Authorization-Header:
// der Header wuerde einen CORS-Preflight ausloesen.
async function tornGet(path, key, params = {}, { signal } = {}) {
  await limiter.acquire();
  const url = new URL(`${TORN_API_BASE}${path}`);
  url.searchParams.set('key', key);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

  let res;
  try {
    res = await fetch(url, { headers: { Accept: 'application/json' }, signal });
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    // Ein nacktes "Failed to fetch" hilft niemandem weiter.
    throw new TornApiError(0,
      `api.torn.com ist nicht erreichbar (${err.message}). Pruef die Internetverbindung `
      + 'und ob ein Adblocker oder eine Firewall den Request blockt.');
  }

  if (!res.ok) throw new TornApiError(res.status, `Torn API HTTP ${res.status}`);
  const data = await res.json();
  if (data && data.error) {
    throw new TornApiError(data.error.code, data.error.error || 'Unbekannter Torn-Fehler');
  }
  return data;
}

export async function fetchKeyInfo(key) {
  return tornGet('/key/info', key);
}

/** Niedrigstes aktives Item-Market-Listing, oder null wenn keins existiert. */
export async function fetchItemMarketLow(key, itemId, opts = {}) {
  const data = await tornGet(`/market/${itemId}/itemmarket`, key, {}, opts);
  const raw = data?.itemmarket?.listings ?? data?.listings ?? [];
  const arr = Array.isArray(raw) ? raw : Object.values(raw);
  let low = null;
  for (const l of arr) {
    const price = Number(l.price ?? l.cost);
    if (!Number.isFinite(price) || price <= 0) continue;
    if (low === null || price < low) low = price;
  }
  return low;
}
