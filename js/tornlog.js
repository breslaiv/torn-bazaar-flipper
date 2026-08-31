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

import { TORN_API_BASE, TORN_RATE_LIMIT } from './config.js';
import { RateLimiter } from './ratelimit.js';
import { makeEvent, isValidEvent } from './ledger.js';

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
  { kind: 'sell', title: /\btrade\b.*\b(accept|complet|receiv)/i },
];

const ITEM_ID_KEYS = ['item', 'item_id', 'itemId', 'itemID'];
const ITEM_ID_KEYS_IN_ARRAY = ['id', ...ITEM_ID_KEYS];
const QTY_KEYS = ['quantity', 'qty', 'amount', 'items_amount'];
const MONEY_KEYS = ['cost', 'price', 'money', 'value', 'total', 'total_cost', 'worth'];
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
  return { ids: [...byId.keys()], byId, matched };
}

/** Kauf oder Verkauf - ueber die Typ-Id, ersatzweise ueber den Titel. */
export function classify(entry, byId = new Map()) {
  if (entry.typeId !== undefined && byId.has(entry.typeId)) return byId.get(entry.typeId);
  const rule = RULES.find((r) => r.title.test(`${entry.category} ${entry.title}`.trim()));
  return rule ? rule.kind : null;
}

/**
 * Macht aus einem Log-Eintrag ein Ledger-Ereignis.
 * @returns {{event: object}|{skip: string}} - skip nennt den Grund.
 */
export function mapEntry(entry, itemNames = new Map(), byId = new Map()) {
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
  const money = num(pick(data, MONEY_KEYS));
  if (money === undefined) return { skip: 'kein Betrag im Eintrag' };
  if (quantity <= 0) return { skip: 'Menge ist null' };

  const event = makeEvent({
    ts: entry.ts,
    kind,
    itemId,
    itemName: itemNames.get(itemId) || `Item ${itemId}`,
    quantity,
    // Der Log nennt die Summe des Vorgangs, der Ledger rechnet je Stueck.
    unitPrice: money / quantity,
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
    const cat = categories.get(key) || { key, count: 0, recognised: false, sample: entry };
    cat.count += 1;
    categories.set(key, cat);

    const result = mapEntry(entry, itemNames, byId);
    if (result.event) {
      cat.recognised = true;
      events.push(result.event);
    } else {
      const s = skipped.get(result.skip) || { reason: result.skip, count: 0, examples: [] };
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

/**
 * Holt Log-Eintraege, neueste zuerst.
 * Mit logIds filtert Torn serverseitig; ohne sie kommt alles, damit der
 * Bericht zeigen kann, was das Log ueberhaupt enthaelt.
 */
export async function fetchLog(key, { maxEntries = 300, logIds = [], signal } = {}) {
  const collected = [];
  let next = null;

  while (collected.length < maxEntries) {
    let url;
    if (next) {
      url = new URL(next);
      // Der Link von Torn traegt den Key nicht mit.
      if (!url.searchParams.get('key')) url.searchParams.set('key', key);
    } else {
      url = new URL(`${TORN_API_BASE}/user/log`);
      url.searchParams.set('key', key);
      url.searchParams.set('limit', '100');
      if (logIds.length) url.searchParams.set('log', logIds.join(','));
    }

    const payload = await tornGet(url, signal);
    const page = normaliseLog(payload);
    if (!page.length) break;
    collected.push(...page);

    // Die Spec liefert fertige Folgelinks; nanostamp loest den Fall, dass
    // mehr als 100 Eintraege dieselbe Sekunde tragen.
    next = payload?._metadata?.links?.next || null;
    if (!next || page.length < 100) break;
  }

  return collected.slice(0, maxEntries);
}
