// Bei jeder Aenderung hochzaehlen und danach tools/version-assets.py laufen
// lassen: der Stempel haengt an jedem Import und macht eine neue Fassung zu
// einer eigenen URL. Ohne ihn liefert der Browser tagelang den alten Stand.
export const APP_VERSION = '6';

// Zentrale Konfiguration. Alles hier ist ueber die Einstellungen im UI
// ueberschreibbar und landet dann in localStorage.

export const WEAV3R_BASE = 'https://weav3r.dev/api';
export const TORN_API_BASE = 'https://api.torn.com/v2';

// weav3r: 100 Aufrufe/Minute via Cloudflare. Torn: 100/Minute.
// Wir bleiben bei beiden unter dem Limit, damit ein paralleler Tab
// oder ein Retry nicht sofort in ein 429 laeuft.
export const WEAV3R_RATE_LIMIT = 80;
export const TORN_RATE_LIMIT = 80;

export const DEFAULTS = {
  // Optional. Die genutzten Marketplace-Routen sind oeffentlich; der Key
  // existiert nur, falls weav3r spaeter eine davon absichert.
  weav3rKey: '',
  // Optional: erlaubt die Gegenprobe gegen den echten Item-Market-Tiefstpreis.
  tornKey: '',

  scanMode: 'flip',            // 'flip' = Bazaar -> Trader | 'dollar' = $1-Bazaare

  // Ziel des Gegencheck-Links am Itemnamen. {ITEM_ID} wird ersetzt, leer = kein
  // Link. Die OpenAPI-Spec beschreibt nur die API-Routen, nicht die Seiten der
  // Weboberflaeche - deshalb konfigurierbar statt fest verdrahtet.
  w3bItemUrl: 'https://weav3r.dev/marketplace/{ITEM_ID}',

  // Verkaufsseite
  referenceMode: 'trader',     // 'trader' = Ankaufspreis eines Kaeufers | 'market_price'
  sellFactor: 100,             // Sicherheitsabschlag auf die Referenz, in %
  marketFeePct: 0,             // Trades sind gebuehrenfrei; nur fuer Item-Market-Exit relevant

  // Vorauswahl: welche Items ueberhaupt einen Detail-Request wert sind.
  // Jeder Kandidat kostet zwei Requests (Listings + Trader).
  prescreenPct: 90,            // lowest_price <= market_price * X%
  maxCandidates: 35,
  listingsPerItem: 20,
  tradersPerItem: 10,
  tradedWithinHours: 48,       // 0 = kein Zeitfilter
  // Upvotes minus Downvotes, wie im Chip neben dem Kaeufer. 0 entspricht dem
  // frueheren "keine negativ bewerteten Kaeufer"; negative Werte lassen auch
  // schlecht bewertete zu.
  minBuyerRating: 0,

  // Filter
  minProfitAbs: 10000,
  minProfitPct: 5,
  maxBuyPrice: 0,              // 0 = kein Limit
  budget: 0,                   // 0 = kein Limit

  // Ledger: zuletzt gewaehlter Zeitraum, siehe PERIODS in js/ledger.js.
  ledgerPeriod: 'all',

  // Betrieb
  autoRefreshSec: 0,           // 0 = aus
};

export const STORAGE_KEY = 'tbf.settings.v2';
