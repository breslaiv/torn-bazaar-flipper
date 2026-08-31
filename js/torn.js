import { TORN_API_BASE, TORN_RATE_LIMIT_PER_MIN } from './config.js';

// Schlichtes Sliding-Window: nie mehr als TORN_RATE_LIMIT_PER_MIN Requests
// in 60 Sekunden, sonst sperrt Torn den Key temporaer.
const recentCalls = [];

async function throttle() {
  for (;;) {
    const cutoff = Date.now() - 60000;
    while (recentCalls.length && recentCalls[0] < cutoff) recentCalls.shift();
    if (recentCalls.length < TORN_RATE_LIMIT_PER_MIN) {
      recentCalls.push(Date.now());
      return;
    }
    const waitMs = recentCalls[0] - cutoff + 50;
    await new Promise((r) => setTimeout(r, waitMs));
  }
}

export class TornApiError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'TornApiError';
    this.code = code;
  }
}

// Der Key wandert als Query-Parameter mit, nicht als Header: ein
// Authorization-Header wuerde einen CORS-Preflight ausloesen, den wir
// von einer github.io-Origin aus nicht brauchen.
async function tornGet(path, key, params = {}) {
  await throttle();
  const url = new URL(`${TORN_API_BASE}${path}`);
  url.searchParams.set('key', key);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

  let res;
  try {
    res = await fetch(url, { headers: { Accept: 'application/json' } });
  } catch (err) {
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

// Torn v2 liefert items als Array, v1 lieferte ein Objekt {id: {...}}.
// Beide Formen auf eine Map id -> {id, name, marketValue, type} bringen.
function indexItems(payload) {
  const raw = payload && payload.items;
  const list = Array.isArray(raw) ? raw : Object.entries(raw || {}).map(([id, v]) => ({ id: Number(id), ...v }));
  const byId = new Map();
  for (const item of list) {
    const id = Number(item.id);
    if (!Number.isFinite(id)) continue;
    byId.set(id, {
      id,
      name: item.name || `Item ${id}`,
      type: item.type || '',
      marketValue: Number(item.market_value ?? item.value?.market_price ?? 0) || 0,
      circulation: Number(item.circulation ?? 0) || 0,
    });
  }
  return byId;
}

export async function fetchItems(key) {
  const data = await tornGet('/torn/items', key);
  return indexItems(data);
}

export async function fetchKeyInfo(key) {
  return tornGet('/key/info', key);
}

// Niedrigstes aktives Item-Market-Listing fuer ein Item.
export async function fetchItemMarketLow(key, itemId) {
  const data = await tornGet(`/market/${itemId}/itemmarket`, key);
  const listings = data?.itemmarket?.listings ?? data?.itemmarket ?? data?.listings ?? [];
  const arr = Array.isArray(listings) ? listings : Object.values(listings);
  let low = null;
  for (const l of arr) {
    const price = Number(l.price ?? l.cost);
    if (!Number.isFinite(price) || price <= 0) continue;
    if (low === null || price < low) low = price;
  }
  return low;
}
