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

import { countryCode } from './travel.js?v=15';

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

// Die CSP dieser Seiten laesst genau diese beiden fremden Hosts durch. Eine
// andere Adresse waere im Browser wirkungslos, und der Fehler saehe aus wie
// ein Netzwerkproblem - deshalb wird sie hier abgefangen und benannt.
//
// weav3r steht dabei, weil deren Website Auslandsvorraete anzeigt. Sobald die
// Route bekannt ist (die Diagnose-Seite sucht danach), laesst sich die Quelle
// umstellen, ohne dass etwas neu ausgeliefert werden muss.
const ALLOWED_HOSTS = ['yata.yt', 'weav3r.dev', 'prombot.co.uk'];

/**
 * Baut die Abrufadresse aus den Einstellungen.
 *
 * Konfigurierbar, falls YATA die Route aendert - dann laesst sie sich hier
 * korrigieren statt per Deploy.
 *
 * Ohne Query-Parameter, und das ist keine Stilfrage: YATA cacht die Antwort
 * bis zum naechsten Import und weist ausdruecklich darauf hin, genau diese
 * URL aufzurufen und keine Variante davon. Ein angehaengter Parameter - auch
 * ein harmloser Cache-Buster - liefe sonst an der zwischengespeicherten
 * Antwort vorbei. Ein Key ist fuer diese Route nicht vorgesehen.
 */
export function travelUrl(settings = {}) {
  const raw = String(settings.yataUrl || '').trim() || YATA_URL;
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new YataError(`"${raw}" ist keine gültige Adresse.`);
  }
  if (url.protocol !== 'https:' || !ALLOWED_HOSTS.includes(url.hostname)) {
    throw new YataError(
      `Nur ${ALLOWED_HOSTS.map((h) => `https://${h}/…`).join(' oder ')} ist erlaubt — die Seite `
      + 'darf laut ihrer eigenen Sicherheitsregel (CSP) keine anderen Server ansprechen.',
    );
  }

  // Der Zwischenspeicher-Hinweis gilt nur fuer YATA: dort liefert eine
  // Adresse mit Parametern eine andere, moeglicherweise aeltere Antwort.
  // Andere Routen brauchen ihre Parameter unter Umstaenden.
  if (url.hostname === 'yata.yt') {
    url.search = '';
    url.hash = '';
  }
  return url;
}

function num(v) {
  const n = typeof v === 'string' ? Number(v.replace(/[^0-9.-]/g, '')) : v;
  return Number.isFinite(n) ? n : null;
}

/** Sekunden oder Millisekunden - beides kommt vor. */
function stamp(value) {
  const n = num(value);
  if (n === null || n <= 0) return null;
  return n > 1e11 ? n : n * 1000;
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

  // Der Zeitstempel der ganzen Nutzlast gilt fuer jedes Land, das keinen
  // eigenen mitbringt. Ohne ihn saehe eine zwischengespeicherte Antwort aus
  // wie eine frische Messung - und genau daraus entstuende ein Abverkauf,
  // den es nie gab.
  const payloadAt = stamp(data?.timestamp);

  const root = data?.stocks && typeof data.stocks === 'object' ? data.stocks : data;
  if (!root || typeof root !== 'object') return { countries, updated, unknown, payloadAt };

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

    const at = stamp(value?.update ?? value?.updated ?? value?.timestamp) ?? payloadAt;
    if (at !== null) updated.set(code, at);
  }

  return { countries, updated, unknown, payloadAt };
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
