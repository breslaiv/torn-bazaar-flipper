// Client fuer die TornW3B-API (https://weav3r.dev/api-docs.html).
//
// Genutzt werden ausschliesslich die oeffentlichen Marketplace- und
// Dollar-Bazaar-Routen. Der API-Key ist optional und wird, falls gesetzt, als
// Query-Parameter mitgeschickt statt als Header: ein X-API-Key-Header wuerde
// einen CORS-Preflight ausloesen, den wir von github.io aus nicht brauchen.

import { WEAV3R_BASE, WEAV3R_RATE_LIMIT } from './config.js?v=10';
import { RateLimiter } from './ratelimit.js?v=10';

export const limiter = new RateLimiter(WEAV3R_RATE_LIMIT, 'weav3r');

export class Weav3rError extends Error {
  constructor(message, status = 0) {
    super(message);
    this.name = 'Weav3rError';
    this.status = status;
  }
}

function buildUrl(path, params = {}, apiKey = '') {
  const url = new URL(WEAV3R_BASE + path);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  }
  if (apiKey) url.searchParams.set('apiKey', apiKey);
  return url;
}

async function get(path, params, settings, { signal } = {}) {
  await limiter.acquire();
  const url = buildUrl(path, params, settings.weav3rKey);

  let res;
  try {
    res = await fetch(url, { headers: { Accept: 'application/json' }, signal });
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    throw new Weav3rError(
      `weav3r.dev ist vom Browser aus nicht erreichbar (${err.message}). `
      + 'Moeglich sind ein fehlender CORS-Header, eine Blockade durch einen Adblocker '
      + 'oder ein Netzwerkproblem. Details liefert die API-Diagnose.',
    );
  }

  if (res.status === 429) {
    throw new Weav3rError('weav3r hat mit 429 geantwortet (Rate-Limit). Kandidatenzahl senken.', 429);
  }
  if (!res.ok) {
    let detail = '';
    try {
      const body = await res.json();
      detail = body.error || body.message || '';
    } catch { /* Body war kein JSON */ }
    throw new Weav3rError(`weav3r HTTP ${res.status}${detail ? `: ${detail}` : ''}`, res.status);
  }

  return res.json();
}

// ---------- Marketplace ----------

/**
 * Alle Items mit Marktpreis, Bazaar-Durchschnitt und billigstem Listing.
 * Ein einziger Request deckt den gesamten Katalog ab - das ist die Basis
 * fuer die Vorauswahl.
 */
export async function fetchMarketplace(settings, opts = {}) {
  const data = await get('/marketplace', {}, settings, opts);
  const items = Array.isArray(data.items) ? data.items : [];
  return {
    generatedAt: data.generated_at ?? null,
    items: items.map((i) => ({
      itemId: Number(i.item_id),
      itemName: i.item_name ?? `Item ${i.item_id}`,
      marketPrice: Number(i.market_price) || 0,
      bazaarAverage: i.bazaar_average == null ? null : Number(i.bazaar_average),
      lowestPrice: i.lowest_price == null ? null : Number(i.lowest_price),
      totalBazaars: Number(i.total_bazaars) || 0,
    })).filter((i) => Number.isFinite(i.itemId)),
  };
}

/**
 * Bazaar-Listings eines Items, guenstigste zuerst.
 * $1-Listings sind hier per API ausgeschlossen - die stehen unter /dollar-bazaars.
 * Ist ein gesponsertes Listing dabei, haengt die API es unabhaengig vom Preis
 * vorne an; wir sortieren deshalb selbst nach und markieren die Zeile.
 */
export async function fetchItemListings(itemId, settings, opts = {}) {
  const data = await get(`/marketplace/${itemId}`, {
    limit: Math.min(settings.listingsPerItem || 20, 100),
    maxPrice: settings.maxBuyPrice > 0 ? settings.maxBuyPrice : undefined,
  }, settings, opts);

  const listings = (Array.isArray(data.listings) ? data.listings : [])
    .map((l) => ({
      itemId: Number(l.item_id ?? itemId),
      uid: l.uid ?? null,
      playerId: l.player_id == null ? null : Number(l.player_id),
      playerName: l.player_name ?? null,
      quantity: Number(l.quantity) || 0,
      price: Number(l.price) || 0,
      contentUpdated: l.content_updated ?? null,
      sponsored: l.sponsored === 1,
    }))
    .filter((l) => l.price > 0 && l.quantity > 0)
    .sort((a, b) => a.price - b.price);

  return {
    itemId: Number(data.item_id ?? itemId),
    itemName: data.item_name ?? null,
    marketPrice: Number(data.market_price) || 0,
    bazaarAverage: data.bazaar_average == null ? null : Number(data.bazaar_average),
    listings,
  };
}

/**
 * Aktive Kaeufer mit oeffentlicher Pricelist fuer ein Item, hoechster
 * Ankaufspreis zuerst. Das ist die Verkaufsseite des Flips.
 */
export async function fetchItemTraders(itemId, settings, opts = {}) {
  const data = await get(`/marketplace/${itemId}/traders`, {
    limit: Math.min(settings.tradersPerItem || 10, 100),
    sort: 'price',
    tradedWithinHours: settings.tradedWithinHours > 0 ? settings.tradedWithinHours : undefined,
  }, settings, opts);

  const traders = (Array.isArray(data.traders) ? data.traders : [])
    .map((t) => {
      const rating = t.rating || {};
      const up = Number(rating.upvotes) || 0;
      const down = Number(rating.downvotes) || 0;
      return {
        playerId: Number(t.player_id),
        playerName: t.player_name ?? `Spieler ${t.player_id}`,
        price: Number(t.price) || 0,
        upvotes: up,
        downvotes: down,
        ratingScore: up - down,
        lastTrade: t.last_trade ?? null,
        lastAction: t.last_action ?? null,
        sponsored: t.sponsored === 1,
      };
    })
    .filter((t) => t.price > 0)
    .sort((a, b) => b.price - a.price);

  return { itemId: Number(data.item_id ?? itemId), itemName: data.item_name ?? null, traders };
}

// ---------- Dollar-Bazaare ----------

/** Items, die fuer $1 im Bazaar stehen. Reiner Gewinn, wenn man sie erwischt. */
export async function fetchDollarItems(settings, { page = 1, limit = 100, ...opts } = {}) {
  const data = await get('/dollar-bazaars/items', { page, limit: Math.min(limit, 100) }, settings, opts);
  const items = Array.isArray(data.items) ? data.items : [];
  return items.map((i) => ({
    itemId: Number(i.itemId),
    itemName: i.itemName ?? `Item ${i.itemId}`,
    itemType: i.itemType ?? '',
    playerId: i.playerId == null ? null : Number(i.playerId),
    playerName: i.sellerName ?? null,
    quantity: Number(i.quantity) || 0,
    marketPrice: Number(i.marketPrice) || 0,
    lastUpdated: i.lastUpdated ?? null,
  })).filter((i) => Number.isFinite(i.itemId) && i.quantity > 0);
}

// ---------- Diagnose ----------

export async function fetchHealth(settings) {
  return get('/health', {}, settings);
}
