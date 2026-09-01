// Persistenz der Trade-Angebote.
//
// Warum ueberhaupt speichern, wo der Log doch alles weiss: der Import liest
// nur die letzten paar hundert Eintraege. Ein Angebot von letzter Woche ist
// dort laengst herausgerutscht - genau das, an das man sich nicht mehr
// erinnert. Also wandert jeder gesehene Trade in den Speicher und bleibt
// dort, bis er verdraengt wird.

import { STATUS_LABELS } from './tradelog.js?v=17';

export const OFFERS_KEY = 'tbf.offers.v1';

// Grob ein halbes Jahr Handel bei zwanzig Trades die Woche. Der localStorage
// hat ein paar Megabyte, und ein Angebot ist ein knappes Kilobyte.
export const LIMIT = 500;

// Ein beendeter Trade bleibt beendet. Sieht ein spaeterer Import nur noch die
// Eroeffnung - weil der Abschluss aus dem Fenster gerutscht ist -, darf das
// den Status nicht zurueckdrehen.
const TERMINAL = new Set(['completed', 'expired', 'cancelled', 'declined']);

export function isOffer(o) {
  return Boolean(o)
    && Number.isFinite(Number(o.tradeId))
    && typeof o.status === 'string'
    && Object.prototype.hasOwnProperty.call(STATUS_LABELS, o.status);
}

export function loadOffers() {
  let raw;
  try {
    raw = JSON.parse(localStorage.getItem(OFFERS_KEY) || '[]');
  } catch {
    return [];
  }
  return Array.isArray(raw) ? raw.filter(isOffer) : [];
}

export function saveOffers(offers) {
  const clean = offers
    .filter(isOffer)
    .sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0))
    .slice(0, LIMIT);
  try {
    localStorage.setItem(OFFERS_KEY, JSON.stringify(clean));
  } catch (err) {
    throw new Error(`Angebote konnten nicht gespeichert werden: ${err.message}`);
  }
  return clean;
}

/**
 * Fuegt frisch gelesene Angebote zu den gespeicherten.
 *
 * @returns {{offers: Array, added: number, updated: number}}
 */
export function mergeOffers(incoming, existing = loadOffers()) {
  const byId = new Map(existing.map((o) => [Number(o.tradeId), o]));
  let added = 0;
  let updated = 0;

  for (const fresh of incoming.filter(isOffer)) {
    const id = Number(fresh.tradeId);
    const old = byId.get(id);
    if (!old) {
      byId.set(id, fresh);
      added += 1;
      continue;
    }

    // Die eigene Notiz gehoert dem Nutzer, nicht dem Log.
    const merged = { ...old, ...fresh, note: old.note || fresh.note || '' };
    if (TERMINAL.has(old.status) && !TERMINAL.has(fresh.status)) {
      merged.status = old.status;
      merged.statusBy = old.statusBy;
      merged.endedAt = old.endedAt;
    }
    if (merged.status !== old.status) updated += 1;
    byId.set(id, merged);
  }

  return { offers: saveOffers([...byId.values()]), added, updated };
}

export function setNote(tradeId, note) {
  const offers = loadOffers().map((o) => (
    Number(o.tradeId) === Number(tradeId) ? { ...o, note: String(note || '').slice(0, 500) } : o
  ));
  return saveOffers(offers);
}

export function removeOffer(tradeId) {
  return saveOffers(loadOffers().filter((o) => Number(o.tradeId) !== Number(tradeId)));
}

export function clearOffers() {
  localStorage.removeItem(OFFERS_KEY);
}
