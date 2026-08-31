// Import aus dem persoenlichen Torn-Log (/user/log).
//
// WICHTIG: Die genauen Titel und Datenfelder der Log-Eintraege sind hier nicht
// verifiziert - sie liessen sich ohne Key und ohne Zugriff auf api.torn.com
// nicht nachschlagen. Deshalb zwei Vorkehrungen:
//
//   1. Die Zuordnung steckt in RULES, einer kurzen Tabelle aus Stichwoertern.
//      Stimmt ein Titel nicht, ist das eine Zeile Aenderung.
//   2. inspect() meldet jede unbekannte Kategorie samt Anzahl und Beispiel
//      zurueck, statt sie stillschweigend zu verwerfen. Damit laesst sich die
//      Tabelle aus echten Daten vervollstaendigen.
//
// Ein Import, der nichts erkennt, ist damit kein Raetsel, sondern ein Bericht.

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
 * Stichwortregeln auf Kategorie und Titel eines Log-Eintrags.
 * Die erste passende Regel gewinnt.
 */
export const RULES = [
  { kind: 'buy', category: /bazaar/i, title: /(buy|bought|purchas)/i },
  { kind: 'buy', category: /item market/i, title: /(buy|bought|purchas)/i },
  { kind: 'sell', category: /bazaar/i, title: /(sold|sell)/i },
  { kind: 'sell', category: /item market/i, title: /(sold|sell)/i },
  { kind: 'sell', category: /trad/i, title: /(accept|complet|receiv)/i },
];

const ITEM_ID_KEYS = ['item', 'item_id', 'itemId', 'itemID'];
// In einem items-Array heisst das Feld schlicht id; auf der obersten Ebene
// waere id dagegen die Kennung des Log-Eintrags, nicht die des Items.
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

/** v1 lieferte ein Objekt {hash: eintrag}, v2 ein Array. Beides auf eine Liste bringen. */
export function normaliseLog(payload) {
  if (!payload || typeof payload !== 'object') return [];
  const raw = 'log' in payload ? payload.log : payload;
  if (!raw || typeof raw !== 'object') return [];
  const list = Array.isArray(raw)
    ? raw
    : Object.entries(raw).map(([id, v]) => (v && typeof v === 'object' ? { id, ...v } : null));
  return list
    .filter((e) => e && typeof e === 'object')
    .map((e) => ({
      id: String(e.id ?? e.log ?? `${e.timestamp}-${e.title}`),
      ts: (Number(e.timestamp) || 0) * 1000,
      category: String(e.category ?? ''),
      title: String(e.title ?? ''),
      data: e.data ?? e.params ?? {},
    }));
}

export function classify(entry) {
  for (const rule of RULES) {
    if (rule.category.test(entry.category) && rule.title.test(entry.title)) return rule.kind;
  }
  return null;
}

/**
 * Macht aus einem Log-Eintrag ein Ledger-Ereignis.
 * @returns {{event: object}|{skip: string}} - skip nennt den Grund.
 */
export function mapEntry(entry, itemNames = new Map()) {
  const kind = classify(entry);
  if (!kind) return { skip: 'unbekannte Kategorie' };

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
 * Genau das braucht man, um RULES aus echten Daten zu vervollstaendigen.
 */
export function inspect(entries, itemNames = new Map()) {
  const events = [];
  const skipped = new Map();
  const categories = new Map();

  for (const entry of entries) {
    const key = `${entry.category} / ${entry.title}`;
    const cat = categories.get(key) || { key, count: 0, recognised: false, sample: entry };
    cat.count += 1;
    categories.set(key, cat);

    const result = mapEntry(entry, itemNames);
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

/** Holt Log-Seiten, neueste zuerst, bis maxEntries erreicht sind. */
export async function fetchLog(key, { maxEntries = 300, from = null, signal } = {}) {
  const collected = [];
  let to = null;

  while (collected.length < maxEntries) {
    await limiter.acquire();
    const url = new URL(`${TORN_API_BASE}/user/log`);
    url.searchParams.set('key', key);
    url.searchParams.set('limit', '100');
    if (from) url.searchParams.set('from', String(Math.floor(from / 1000)));
    if (to) url.searchParams.set('to', String(Math.floor(to / 1000)));

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
      // 16 ist der haeufige Fall: der Key darf den Log nicht lesen.
      const hint = code === 16
        ? ' Der Log braucht einen Key mit mindestens Limited Access; ein Public-Only-Key reicht nicht.'
        : '';
      throw new TornLogError(code, `${payload.error.error || 'Torn-Fehler'}.${hint}`);
    }

    const page = normaliseLog(payload);
    if (!page.length) break;
    collected.push(...page);

    const oldest = Math.min(...page.map((e) => e.ts));
    if (!Number.isFinite(oldest) || oldest <= 0) break;
    // Eine Sekunde vor dem aeltesten Eintrag weitermachen.
    const next = oldest - 1000;
    if (to !== null && next >= to) break;
    to = next;
    if (page.length < 100) break;
  }

  return collected.slice(0, maxEntries);
}
