// Persistenz des Ledgers.
//
// Der Ledger liegt im localStorage. Das ist bequem, aber nicht dauerhaft:
// iOS Safari raeumt Daten von Seiten weg, die sieben Tage nicht besucht
// wurden. Deshalb gibt es Export und Import als JSON, und die Oberflaeche
// weist darauf hin, solange nie exportiert wurde.

import { makeEvent, isValidEvent, dedupe } from './ledger.js?v=2';

export const LEDGER_KEY = 'tbf.ledger.v1';
export const EXPORT_KEY = 'tbf.ledger.exported.v1';

export function loadEvents() {
  let raw;
  try {
    raw = JSON.parse(localStorage.getItem(LEDGER_KEY) || '[]');
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) return [];
  return raw.filter(isValidEvent);
}

export function saveEvents(events) {
  const clean = events.filter(isValidEvent);
  try {
    localStorage.setItem(LEDGER_KEY, JSON.stringify(clean));
  } catch (err) {
    throw new Error(`Ledger konnte nicht gespeichert werden: ${err.message}`);
  }
  return clean;
}

/**
 * Neue Ereignisse anhaengen, ohne bereits Importiertes zu verdoppeln.
 * @returns {{events: Array, added: number, duplicates: number, invalid: number}}
 */
export function addEvents(incoming) {
  const existing = loadEvents();
  const valid = incoming.filter(isValidEvent);
  const invalid = incoming.length - valid.length;

  const merged = dedupe([...existing, ...valid]);
  const added = merged.length - existing.length;

  saveEvents(merged);
  return { events: merged, added, duplicates: valid.length - added, invalid };
}

export function removeEvent(id) {
  const events = loadEvents().filter((e) => e.id !== id);
  saveEvents(events);
  return events;
}

export function clearLedger() {
  localStorage.removeItem(LEDGER_KEY);
  localStorage.removeItem(EXPORT_KEY);
}

export function exportJson(events = loadEvents()) {
  return JSON.stringify({
    format: 'torn-bazaar-flipper-ledger',
    version: 1,
    exportedAt: new Date().toISOString(),
    events,
  }, null, 2);
}

export function markExported() {
  try {
    localStorage.setItem(EXPORT_KEY, String(Date.now()));
  } catch { /* ohne Merker geht es auch, nur ohne Hinweis */ }
}

export function lastExport() {
  const v = Number(localStorage.getItem(EXPORT_KEY));
  return Number.isFinite(v) && v > 0 ? v : null;
}

/**
 * Liest eine Exportdatei ein. Akzeptiert auch ein blankes Array, damit ein
 * von Hand zusammengestelltes JSON nicht am Rahmen scheitert.
 */
export function parseImport(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`Kein gültiges JSON: ${err.message}`);
  }
  const list = Array.isArray(parsed) ? parsed : parsed?.events;
  if (!Array.isArray(list)) {
    throw new Error('Die Datei enthält kein events-Array.');
  }
  return list.map((e) => makeEvent(e)).filter(isValidEvent);
}
