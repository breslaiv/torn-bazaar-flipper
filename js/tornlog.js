// Import aus dem persoenlichen Torn-Log (/user/log), gebaut gegen die
// offizielle OpenAPI-Spec (Torn API 6.13.1).
//
// Zwei Dinge aus der Spec bestimmen den Aufbau:
//
//   1. /user/log verlangt einen Key mit FULL ACCESS. Das ist der weiteste
//      Zugriff, den Torn kennt - siehe README.
//   2. /torn/logtypes liefert alle Log-Typen mit Id und Titel und braucht nur
//      einen Public-Key. Damit muss nichts geraten werden: die Typen werden
//      einmal geholt, per Stichwort auf Kauf/Verkauf abgebildet, und
//      /user/log filtert dann serverseitig ueber log=<ids>.
//
// Die Feldnamen innerhalb von data/params sind in der Spec bewusst offen
// ("Dynamic key-value pairs"), deshalb bleibt die Extraktion defensiv.

import { TORN_API_BASE, TORN_RATE_LIMIT } from './config.js?v=8';
import { RateLimiter } from './ratelimit.js?v=8';
import { makeEvent, isValidEvent } from './ledger.js?v=8';
import { isTradeEntry } from './tradelog.js?v=8';

export const limiter = new RateLimiter(TORN_RATE_LIMIT, 'torn-log');

export class TornLogError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'TornLogError';
    this.code = code;
  }
}

/**
 * Stichwoerter auf den Titel eines Log-Typs. Die Titel kommen von Torn selbst
 * (/torn/logtypes), es wird also nur zugeordnet, nicht erfunden.
 * Die erste passende Regel gewinnt.
 */
export const RULES = [
  { kind: 'buy', title: /\b(bazaar|item market|itemmarket)\b.*\b(buy|bought|purchas)/i },
  { kind: 'sell', title: /\b(bazaar|item market|itemmarket)\b.*\b(sell|sold)/i },
  { kind: 'buy', title: /^(buy|bought|purchas)/i },
  { kind: 'sell', title: /^(sell|sold)/i },
  // Trades stehen bewusst nicht hier: ein einzelner Trade-Eintrag ist nie
  // buchbar. "Trade completed" nennt weder Ware noch Betrag, "Trade items add"
  // keinen Preis. Sie werden ueber parsed_trade_id zusammengefasst - siehe
  // js/tradelog.js.
];

// Kategorien, die ueberhaupt Warenbewegungen enthalten. Gefiltert wird ueber
// cat=, nicht ueber log=: der Id-Filter lieferte im echten Betrieb auch mit
// nur 12 Ids nichts zurueck. Ueber die Kategorie kommen dagegen genau die
// Eintraege, um die es geht - ohne sie besteht ein Log-Abzug zu ueber 90%
// aus Crimes, Company und Nachrichten.
export const CATEGORY_RULES = [/bazaar/i, /item market|itemmarket/i, /^trades?$/i];

const ITEM_ID_KEYS = ['item', 'item_id', 'itemId', 'itemID'];
const ITEM_ID_KEYS_IN_ARRAY = ['id', ...ITEM_ID_KEYS];
const QTY_KEYS = ['quantity', 'qty', 'amount', 'items_amount'];
// Aus echten Log-Eintraegen: Bazaar und Item Market nennen cost_each und
// cost_total. cost_each ist der Stueckpreis und wird bevorzugt - Summe durch
// Menge zu teilen waere derselbe Wert mit Rundungsrisiko.
const MONEY_EACH_KEYS = ['cost_each', 'price_each', 'unit_price', 'unitPrice', 'each'];
const MONEY_TOTAL_KEYS = ['cost_total', 'total_cost', 'cost', 'price', 'money', 'value', 'total', 'worth'];
const PARTNER_KEYS = ['seller', 'buyer', 'user', 'user_id', 'userId', 'partner', 'sender', 'receiver'];

function pick(obj, keys) {
  for (const k of keys) if (obj && obj[k] !== undefined && obj[k] !== null) return obj[k];
  return undefined;
}

function num(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined;
  if (typeof v === 'string') {
    const n = Number(v.replace(/[^0-9.-]/g, ''));
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

/**
 * UserLog laut Spec: { id, timestamp, details: { id, title, category }, data, params }.
 * Titel und Kategorie stecken unter details, nicht auf der obersten Ebene.
 */
export function normaliseLog(payload) {
  if (!payload || typeof payload !== 'object') return [];
  const raw = 'log' in payload ? payload.log : payload;
  if (!raw || typeof raw !== 'object') return [];

  const list = Array.isArray(raw)
    ? raw
    : Object.entries(raw).map(([id, v]) => (v && typeof v === 'object' ? { id, ...v } : null));

  return list
    .filter((e) => e && typeof e === 'object')
    .map((e) => {
      const details = e.details && typeof e.details === 'object' ? e.details : {};
      return {
        id: String(e.id ?? `${e.timestamp}-${details.id ?? ''}`),
        ts: (Number(e.timestamp) || 0) * 1000,
        typeId: num(details.id ?? e.log),
        category: String(details.category ?? e.category ?? ''),
        title: String(details.title ?? e.title ?? ''),
        // Beide Objekte sind laut Spec frei belegt; data gewinnt bei Kollision.
        data: { ...(e.params || {}), ...(e.data || {}) },
      };
    });
}

/** Normalisiert die Antwort von /torn/logtypes. */
export function normaliseLogTypes(payload) {
  const raw = payload?.logtypes ?? payload;
  const list = Array.isArray(raw)
    ? raw
    : Object.entries(raw || {}).map(([id, title]) => ({ id: Number(id), title }));
  return list
    .map((t) => ({ id: num(t?.id), title: String(t?.title ?? '') }))
    .filter((t) => Number.isFinite(t.id) && t.title);
}

/**
 * Bildet Torns eigene Log-Typen auf Kauf/Verkauf ab.
 * @returns {{ids: number[], byId: Map<number,string>, matched: Array}}
 */
export function deriveLogTypes(logTypes) {
  const byId = new Map();
  const matched = [];
  for (const type of logTypes) {
    const rule = RULES.find((r) => r.title.test(type.title));
    if (!rule) continue;
    byId.set(type.id, rule.kind);
    matched.push({ ...type, kind: rule.kind });
  }
  return { byId, matched };
}

/** Kategorien, die es zu lesen lohnt, aus Torns eigener Kategorienliste. */
export function deriveCategories(categories) {
  return categories.filter((c) => CATEGORY_RULES.some((r) => r.test(c.title)));
}

/** Normalisiert die Antwort von /torn/logcategories. */
export function normaliseLogCategories(payload) {
  const raw = payload?.logcategories ?? payload;
  const list = Array.isArray(raw)
    ? raw
    : Object.entries(raw || {}).map(([id, title]) => ({ id: Number(id), title }));
  return list
    .map((c) => ({ id: num(c?.id), title: String(c?.title ?? '') }))
    .filter((c) => Number.isFinite(c.id) && c.title);
}

/** Kauf oder Verkauf - ueber die Typ-Id, ersatzweise ueber den Titel. */
export function classify(entry, byId = new Map()) {
  if (entry.typeId !== undefined && byId.has(entry.typeId)) return byId.get(entry.typeId);
  // Die Regeln sind gegen die Titel aus /torn/logtypes geschrieben, also
  // zuerst gegen den blossen Titel pruefen. Kategorie plus Titel bleibt als
  // zweiter Versuch, verankerte Muster wuerden daran sonst scheitern.
  const rule = RULES.find((r) => r.title.test(entry.title))
    || RULES.find((r) => r.title.test(`${entry.category} ${entry.title}`.trim()));
  return rule ? rule.kind : null;
}

/**
 * Macht aus einem Log-Eintrag ein Ledger-Ereignis.
 * @returns {{event: object}|{skip: string}} - skip nennt den Grund.
 */
export function mapEntry(entry, itemNames = new Map(), byId = new Map()) {
  // Trade-Eintraege gehoeren in die Rekonstruktion, nicht in die
  // Einzelauswertung - sonst zaehlt jeder Zwischenschritt als eigener Vorgang.
  if (isTradeEntry(entry)) return { skip: 'Teil eines Trades (wird zusammengefasst)' };

  const kind = classify(entry, byId);
  if (!kind) return { skip: 'unbekannter Log-Typ' };

  const data = entry.data || {};

  // Mehrere Items in einem Vorgang lassen sich ohne Einzelpreise nicht fair
  // auf die Summe aufteilen. Lieber melden als raten.
  const itemsArray = Array.isArray(data.items) ? data.items : null;
  if (itemsArray && itemsArray.length > 1) {
    return { skip: 'mehrere Items in einem Vorgang - bitte von Hand erfassen' };
  }

  const single = itemsArray ? itemsArray[0] : data;
  const itemId = num(pick(single, itemsArray ? ITEM_ID_KEYS_IN_ARRAY : ITEM_ID_KEYS));
  if (itemId === undefined) return { skip: 'keine Item-ID im Eintrag' };

  const quantity = num(pick(single, QTY_KEYS)) ?? 1;
  if (quantity <= 0) return { skip: 'Menge ist null' };

  const each = num(pick(data, MONEY_EACH_KEYS));
  const total = num(pick(data, MONEY_TOTAL_KEYS));
  if (each === undefined && total === undefined) return { skip: 'kein Betrag im Eintrag' };
  const unitPrice = each !== undefined ? each : total / quantity;

  const event = makeEvent({
    ts: entry.ts,
    kind,
    itemId,
    itemName: itemNames.get(itemId) || `Item ${itemId}`,
    quantity,
    unitPrice,
    counterpartyId: num(pick(data, PARTNER_KEYS)) ?? null,
    source: 'torn-log',
    ref: entry.id,
    note: entry.title,
  });

  return isValidEvent(event) ? { event } : { skip: 'unplausible Werte' };
}

/**
 * Bericht ueber einen Log-Abzug: was liess sich zuordnen, was nicht und warum.
 */
export function inspect(entries, itemNames = new Map(), byId = new Map()) {
  const events = [];
  const skipped = new Map();
  const categories = new Map();

  for (const entry of entries) {
    const key = `${entry.category} / ${entry.title}`;
    const cat = categories.get(key)
      || { key, count: 0, classified: false, imported: false, sample: entry };
    cat.count += 1;
    // Zwei verschiedene Dinge: der Typ ist bekannt, und die Daten liessen sich
    // lesen. Beides zusammenzuwerfen verschleiert, woran es haengt.
    if (classify(entry, byId)) cat.classified = true;
    categories.set(key, cat);

    const result = mapEntry(entry, itemNames, byId);
    if (result.event) {
      cat.imported = true;
      events.push(result.event);
    } else {
      const s = skipped.get(result.skip)
        || { reason: result.skip, count: 0, examples: [], sample: entry };
      s.count += 1;
      if (s.examples.length < 3) s.examples.push(key);
      skipped.set(result.skip, s);
    }
  }

  return {
    events,
    skipped: [...skipped.values()].sort((a, b) => b.count - a.count),
    categories: [...categories.values()].sort((a, b) => b.count - a.count),
  };
}

async function tornGet(url, signal) {
  await limiter.acquire();
  let res;
  try {
    res = await fetch(url, { headers: { Accept: 'application/json' }, signal });
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    throw new TornLogError(0, `api.torn.com ist nicht erreichbar (${err.message}).`);
  }
  if (!res.ok) throw new TornLogError(res.status, `Torn API HTTP ${res.status}`);

  const payload = await res.json();
  if (payload?.error) {
    const code = payload.error.code;
    const hints = {
      2: ' Der Key ist unbekannt oder falsch geschrieben.',
      15: ' Torn stellt den Log gerade nicht bereit.',
      16: ' /user/log verlangt einen Key mit Full Access; Public oder Limited reichen nicht.',
      28: ' Eine der angefragten Log-Ids kennt Torn nicht.',
    };
    throw new TornLogError(code, `${payload.error.error || 'Torn-Fehler'}.${hints[code] || ''}`);
  }
  return payload;
}

/** Alle Log-Typen samt Id und Titel. Braucht nur einen Public-Key. */
export async function fetchLogTypes(key, { signal } = {}) {
  const url = new URL(`${TORN_API_BASE}/torn/logtypes`);
  url.searchParams.set('key', key);
  return normaliseLogTypes(await tornGet(url, signal));
}

/** Alle Log-Kategorien samt Id und Titel. Braucht nur einen Public-Key. */
export async function fetchLogCategories(key, { signal } = {}) {
  const url = new URL(`${TORN_API_BASE}/torn/logcategories`);
  url.searchParams.set('key', key);
  return normaliseLogCategories(await tornGet(url, signal));
}

/** Eine Seitenfolge lesen, optional auf eine Kategorie eingeschraenkt. */
async function fetchPages(key, { maxEntries, cat = null, signal }) {
  const collected = [];
  let next = null;

  while (collected.length < maxEntries) {
    let url;
    if (next) {
      url = new URL(next);
      // Der Folgelink von Torn traegt den Key nicht mit.
      if (!url.searchParams.get('key')) url.searchParams.set('key', key);
    } else {
      url = new URL(`${TORN_API_BASE}/user/log`);
      url.searchParams.set('key', key);
      url.searchParams.set('limit', '100');
      if (cat !== null) url.searchParams.set('cat', String(cat));
    }

    const payload = await tornGet(url, signal);
    const page = normaliseLog(payload);
    if (!page.length) break;
    collected.push(...page);

    next = payload?._metadata?.links?.next || null;
    if (!next || page.length < 100) break;
  }

  return collected.slice(0, maxEntries);
}

/**
 * Holt Log-Eintraege, neueste zuerst.
 *
 * Gefiltert wird ueber cat= je Kategorie. Der Id-Filter log= wurde
 * aufgegeben: er lieferte im echten Betrieb auch mit nur zwoelf Ids nichts
 * zurueck. Bringt auch cat= nichts, wird einmal ungefiltert gelesen - dann
 * besteht der Abzug zwar groesstenteils aus Irrelevantem, aber ein leeres
 * Ergebnis bleibt nie unerklaert.
 */
export async function fetchLog(key, { maxEntries = 300, categoryIds = [], signal } = {}) {
  const perCategory = categoryIds.length
    ? Math.max(100, Math.ceil(maxEntries / categoryIds.length))
    : maxEntries;

  const seen = new Set();
  const entries = [];
  for (const cat of categoryIds) {
    if (signal?.aborted) break;
    for (const entry of await fetchPages(key, { maxEntries: perCategory, cat, signal })) {
      if (seen.has(entry.id)) continue;
      seen.add(entry.id);
      entries.push(entry);
    }
  }

  if (entries.length) {
    entries.sort((a, b) => b.ts - a.ts);
    return { entries: entries.slice(0, maxEntries), usedFilter: true, fellBack: false };
  }

  const fallback = await fetchPages(key, { maxEntries, cat: null, signal });
  return { entries: fallback, usedFilter: false, fellBack: categoryIds.length > 0 };
}
