// Zentrale Konfiguration. Alles hier ist ueber die Einstellungen im UI
// ueberschreibbar und landet dann in localStorage.

export const TORN_API_BASE = 'https://api.torn.com/v2';

// Torn erlaubt 100 Requests pro Minute. Wir bleiben bewusst darunter.
export const TORN_RATE_LIMIT_PER_MIN = 80;

// Der weav3r-Endpoint ist nicht fest verdrahtet: die Doku auf
// https://weav3r.dev/api-docs.html ist die Quelle der Wahrheit, und der
// Nutzer traegt die konkrete URL in den Einstellungen ein.
export const DEFAULTS = {
  // {ITEM_ID} wird, falls vorhanden, pro Item ersetzt. Ohne Platzhalter
  // wird die URL einmal aufgerufen und als Sammel-Response behandelt.
  weav3rUrl: '',
  weav3rKey: '',
  // Wohin der API-Key gehoert: 'none', 'query:<name>', 'header:<name>' oder 'bearer'.
  weav3rAuthMode: 'none',

  tornKey: '',

  // Verkaufsseite
  priceSource: 'market_value',   // 'market_value' | 'itemmarket'
  sellFactor: 100,               // % vom Referenzpreis, die du real erloest
  marketFeePct: 0,               // Gebuehr beim Verkauf, in %
  verifyTopN: 15,                // Live-Itemmarket-Check fuer die besten N Treffer

  // Nur relevant, wenn die weav3r-URL {ITEM_ID} enthaelt und deshalb pro Item
  // abgefragt werden muss: kommaseparierte Item-IDs. Leer = die N teuersten Items.
  itemFilterIds: '',
  perItemScanLimit: 40,

  // Filter
  minProfitAbs: 10000,
  minProfitPct: 5,
  maxBuyPrice: 0,                // 0 = kein Limit
  budget: 0,                     // 0 = kein Limit

  // Betrieb
  autoRefreshSec: 0,             // 0 = aus
  itemCacheMinutes: 60,
};

export const STORAGE_KEY = 'tbf.settings.v1';
export const ITEM_CACHE_KEY = 'tbf.items.v1';
