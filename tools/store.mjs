// Messreihen in SQLite statt in einer JSON-Datei.
//
// Warum ueberhaupt: die gesammelte Datei im Repository ist auf 120 Punkte je
// Reihe gedeckelt und wird bei jedem Schreiben vollstaendig neu geschrieben.
// Das ist fuer einen stuendlichen Lauf in Actions richtig - fuer eine Kiste,
// die im Sekundentakt misst und Monate durchhaelt, nicht mehr. Eine Datenbank
// haengt nur die neue Zeile an, kennt keinen Deckel, und ein Absturz mitten im
// Schreiben laesst keine halbe Datei zurueck.
//
// Keine Abhaengigkeit: node:sqlite ist seit Node 22.5 eingebaut. Unter Node 22
// meldet es sich mit einer Experimental-Warnung, ab Node 24 ist es still.
//
// Der Rest der App merkt davon nichts. readSeries() liefert exakt die Form,
// die data/travel-stock.json schon hat, und die Seite liest sie unveraendert.

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS samples (
  country  TEXT    NOT NULL,
  item     INTEGER NOT NULL,
  ts       INTEGER NOT NULL,
  quantity INTEGER NOT NULL,
  PRIMARY KEY (country, item, ts)
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS samples_ts ON samples (ts);

CREATE TABLE IF NOT EXISTS runs (
  ts       INTEGER PRIMARY KEY,
  source   TEXT,
  polls    INTEGER NOT NULL DEFAULT 0,
  changes  INTEGER NOT NULL DEFAULT 0,
  errors   INTEGER NOT NULL DEFAULT 0
);
`;

// ---------- reine Umrechnung, ohne Datenbank ----------

/**
 * "mex:8" -> {country:'mex', item:8}
 *
 * Getrennt gespeichert, weil "alle Items eines Landes" und "ein Item ueber
 * alle Laender" die beiden Fragen sind, die man spaeter stellt. Als eine
 * Zeichenkette waere beides ein LIKE ueber die ganze Tabelle.
 */
export function splitKey(key) {
  const at = String(key).indexOf(':');
  if (at <= 0) return null;
  const country = key.slice(0, at);
  const item = Number(key.slice(at + 1));
  return Number.isFinite(item) ? { country, item } : null;
}

export function joinKey(country, item) {
  return `${country}:${item}`;
}

/** {series} -> flache Zeilenliste. Unbrauchbare Eintraege fallen still weg. */
export function toRows(series = {}) {
  const rows = [];
  for (const [key, points] of Object.entries(series)) {
    const parsed = splitKey(key);
    if (!parsed || !Array.isArray(points)) continue;
    for (const point of points) {
      if (!Array.isArray(point) || point.length < 2) continue;
      const ts = Number(point[0]);
      const quantity = Number(point[1]);
      if (!Number.isFinite(ts) || !Number.isFinite(quantity)) continue;
      rows.push({ country: parsed.country, item: parsed.item, ts, quantity });
    }
  }
  return rows;
}

/**
 * Zeilenliste -> {series}, je Reihe die neuesten `limit` Punkte.
 *
 * Die Datenbank kennt keinen Deckel, der Browser braucht einen: was hier
 * herausgeht, wandert in den localStorage des Telefons.
 */
export function fromRows(rows = [], { limit = 500 } = {}) {
  const series = {};
  for (const row of rows) {
    const key = joinKey(row.country, row.item);
    (series[key] ||= []).push([Number(row.ts), Number(row.quantity)]);
  }
  for (const key of Object.keys(series)) {
    series[key].sort((a, b) => a[0] - b[0]);
    if (series[key].length > limit) series[key] = series[key].slice(-limit);
  }
  return series;
}

// ---------- Datenbank ----------

export function openStore(file = 'data/local/stock.db') {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  // WAL: der Sammler schreibt, der Webserver liest - ohne WAL sperren die
  // beiden sich gegenseitig aus.
  db.exec('PRAGMA journal_mode = WAL');
  // NORMAL statt FULL: bei jedem Schreibvorgang auf die Platte zu warten
  // kostet im Sekundentakt mehr, als ein Stromausfall hier anrichten kann -
  // schlimmstenfalls fehlt die letzte Messung.
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec(SCHEMA);
  return db;
}

/**
 * Traegt Messpunkte ein und meldet, wie viele davon neu waren.
 *
 * INSERT OR IGNORE statt einer Vorabpruefung: derselbe Zeitstempel derselben
 * Reihe ist per Primaerschluessel derselbe Punkt. Damit ist ein wiederholter
 * Lauf ueber dieselben Daten folgenlos - und genau das passiert staendig,
 * weil YATA seine Antwort bis zum naechsten Import festhaelt.
 */
export function saveSeries(db, series) {
  const rows = toRows(series);
  if (!rows.length) return 0;

  const insert = db.prepare(
    'INSERT OR IGNORE INTO samples (country, item, ts, quantity) VALUES (?, ?, ?, ?)',
  );
  let added = 0;
  db.exec('BEGIN');
  try {
    for (const row of rows) {
      added += insert.run(row.country, row.item, row.ts, row.quantity).changes;
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return added;
}

/** Die neuesten Punkte je Reihe, in der Form, die die Seite erwartet. */
export function readSeries(db, { limit = 500, country = null } = {}) {
  const sql = country
    ? 'SELECT country, item, ts, quantity FROM samples WHERE country = ? ORDER BY ts'
    : 'SELECT country, item, ts, quantity FROM samples ORDER BY ts';
  const rows = country ? db.prepare(sql).all(country) : db.prepare(sql).all();
  return fromRows(rows, { limit });
}

export function recordRun(db, { ts = Date.now(), source = null, polls = 0, changes = 0, errors = 0 } = {}) {
  db.prepare(
    'INSERT OR REPLACE INTO runs (ts, source, polls, changes, errors) VALUES (?, ?, ?, ?, ?)',
  ).run(ts, source, polls, changes, errors);
}

/** Kennzahlen fuer die Statuszeile - und fuer die Frage, ob ueberhaupt etwas ankommt. */
export function storeStats(db) {
  const row = db.prepare(`
    SELECT COUNT(*) AS points,
           COUNT(DISTINCT country || ':' || item) AS series,
           MIN(ts) AS first,
           MAX(ts) AS last
    FROM samples
  `).get();
  const lastRun = db.prepare('SELECT ts, source FROM runs ORDER BY ts DESC LIMIT 1').get();
  return {
    points: Number(row?.points) || 0,
    series: Number(row?.series) || 0,
    first: row?.first ?? null,
    last: row?.last ?? null,
    collectedAt: lastRun?.ts ?? row?.last ?? null,
    source: lastRun?.source ?? null,
  };
}

/**
 * Der Inhalt von data/travel-stock.json, aus der Datenbank gebaut.
 *
 * Dieselben Felder wie die Datei aus GitHub Actions - deshalb laeuft die
 * Flug-Seite gegen den lokalen Server, ohne dass eine Zeile im Browser
 * geaendert werden muss.
 */
export function stockPayload(db, { limit = 500 } = {}) {
  const series = readSeries(db, { limit });
  const info = storeStats(db);
  return {
    collectedAt: info.collectedAt,
    source: info.source,
    countries: new Set(Object.keys(series).map((k) => splitKey(k)?.country)).size,
    points: Object.values(series).reduce((sum, s) => sum + s.length, 0),
    series,
  };
}
