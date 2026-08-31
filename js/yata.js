// Client fuer YATAs Travel-Export (https://yata.yt).
//
// Warum eine dritte Quelle: weder Torns API v2 (6.13.1) noch weav3r kennen
// die Vorraete der Auslandsshops. In Torn werden die seit jeher von Spielern
// gesammelt, und YATA ist die verbreitetste Sammelstelle.
//
// Zwei Unsicherheiten, die der Code aushalten muss:
//
//   CORS   Ob YATA Browser-Zugriffe von fremden Seiten erlaubt, entscheidet
//          deren Server. Schlaegt es fehl, sieht man im Browser nur ein
//          nacktes "Failed to fetch" - deshalb sagt die Fehlermeldung hier,
//          was wahrscheinlich los ist, und die Diagnose-Seite prueft es.
//   Form   Die genaue Gestalt der Antwort ist nicht vertraglich zugesichert.
//          Der Parser akzeptiert deshalb mehrere Schreibweisen und meldet,
//          was er nicht deuten konnte, statt still eine leere Liste zu
//          liefern.

import { countryCode } from './travel.js?v=9';

export class YataError extends Error {
  constructor(message, status = 0) {
    super(message);
    this.name = 'YataError';
    this.status = status;
  }
}

export const YATA_BASE = 'https://yata.yt/api/v1';
export const YATA_TRAVEL_PATH = '/travel/export/';
export const YATA_URL = `${YATA_BASE}${YATA_TRAVEL_PATH}`;

// Die CSP dieser Seiten laesst genau einen fremden Host durch. Eine andere
// Adresse waere im Browser wirkungslos, und der Fehler saehe aus wie ein
// Netzwerkproblem - deshalb wird sie hier abgefangen und benannt.
const ALLOWED_HOST = 'yata.yt';

/**
 * Baut die Abrufadresse aus den Einstellungen.
 *
 * Konfigurierbar, weil die genaue Route dieser App nicht bekannt sein kann:
 * aendert YATA sie, oder stimmt die Vorgabe nicht, laesst sie sich hier
 * korrigieren, statt auf einen neuen Deploy zu warten.
 */
export function travelUrl(settings = {}) {
  const raw = String(settings.yataUrl || '').trim() || YATA_URL;
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new YataError(`"${raw}" ist keine gültige Adresse.`);
  }
  if (url.protocol !== 'https:' || url.hostname !== ALLOWED_HOST) {
    throw new YataError(
      `Nur https://${ALLOWED_HOST}/… ist erlaubt — die Seite darf laut ihrer eigenen `
      + 'Sicherheitsregel (CSP) keine anderen Server ansprechen.',
    );
  }
  const key = String(settings.yataKey || '').trim();
  if (key) url.searchParams.set('key', key);
  return url;
}

function num(v) {
  const n = typeof v === 'string' ? Number(v.replace(/[^0-9.-]/g, '')) : v;
  return Number.isFinite(n) ? n : null;
}

/** Ein einzelner Shop-Eintrag, egal unter welchen Feldnamen er ankommt. */
function readItem(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const itemId = num(raw.id ?? raw.item_id ?? raw.itemId);
  const quantity = num(raw.quantity ?? raw.qty ?? raw.amount ?? raw.stock);
  const cost = num(raw.cost ?? raw.price ?? raw.buy_price);
  if (itemId === null || cost === null || cost <= 0) return null;

  return {
    itemId,
    itemName: raw.name ?? raw.item_name ?? `Item ${itemId}`,
    quantity: quantity === null ? null : Math.max(0, quantity),
    cost,
  };
}

/**
 * Deutet die Antwort des Travel-Exports.
 *
 * @returns {{countries: Map<string, Array>, updated: Map<string, number>, unknown: string[]}}
 */
export function parseTravelExport(data) {
  const countries = new Map();
  const updated = new Map();
  const unknown = [];

  const root = data?.stocks && typeof data.stocks === 'object' ? data.stocks : data;
  if (!root || typeof root !== 'object') return { countries, updated, unknown };

  for (const [key, value] of Object.entries(root)) {
    const code = countryCode(key);
    if (!code) {
      unknown.push(key);
      continue;
    }

    // Die Liste steckt entweder direkt unter dem Land oder unter "stocks".
    const list = Array.isArray(value) ? value
      : (Array.isArray(value?.stocks) ? value.stocks
        : (Array.isArray(value?.items) ? value.items : null));
    if (!list) {
      unknown.push(key);
      continue;
    }

    const items = list.map(readItem).filter(Boolean);
    countries.set(code, items);

    // Sekunden oder Millisekunden - beides kommt vor.
    const stamp = num(value?.update ?? value?.updated ?? value?.timestamp);
    if (stamp !== null) updated.set(code, stamp > 1e11 ? stamp : stamp * 1000);
  }

  return { countries, updated, unknown };
}

/** Holt die aktuellen Auslandsvorraete. */
export async function fetchTravelStocks({ signal, settings = {} } = {}) {
  const url = travelUrl(settings);
  let res;
  try {
    res = await fetch(url, { headers: { Accept: 'application/json' }, signal });
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    throw new YataError(
      `yata.yt ist vom Browser aus nicht erreichbar (${err.message}). `
      + 'Wahrscheinlich erlaubt YATA keine Zugriffe von fremden Seiten (CORS) — '
      + 'dann hilft nur, die Vorräte von Hand zu erfassen. Die API-Diagnose sagt es genauer.',
    );
  }

  if (!res.ok) throw new YataError(`yata.yt HTTP ${res.status}`, res.status);

  let data;
  try {
    data = await res.json();
  } catch {
    throw new YataError('yata.yt hat kein JSON geliefert.');
  }

  const parsed = parseTravelExport(data);
  if (!parsed.countries.size) {
    throw new YataError(
      'yata.yt hat geantwortet, aber kein Land war zu erkennen'
      + `${parsed.unknown.length ? ` (unbekannte Schlüssel: ${parsed.unknown.slice(0, 5).join(', ')})` : ''}.`,
    );
  }
  return parsed;
}
