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

-- Wer im Shop steht, sieht die Wahrheit: eine eigene Beobachtung ist genauer
-- als jede fremde Quelle. Sie gehoert deshalb in dieselbe Reihe wie alles
-- andere - der Messpunkt landet in samples, und hier steht nur, dass er von
-- einem Menschen kam.
--
-- Warum getrennt statt einer Spalte in samples: die heisse Tabelle bleibt
-- unveraendert (keine Wanderung von Millionen Zeilen), alle bestehenden
-- Abfragen finden die Beobachtung automatisch, und wer nachsehen will, wo
-- eine Zahl herkommt, hat trotzdem eine Antwort.
CREATE TABLE IF NOT EXISTS manual (
  country  TEXT    NOT NULL,
  item     INTEGER NOT NULL,
  ts       INTEGER NOT NULL,
  note     TEXT,
  PRIMARY KEY (country, item, ts)
) WITHOUT ROWID;
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

/**
 * Die neuesten Punkte je Reihe, in der Form, die die Seite erwartet.
 *
 * Gefragt wird je Reihe einzeln, und das ist der ganze Punkt. Vorher stand
 * hier `SELECT ... FROM samples ORDER BY ts` - die **ganze** Tabelle, dazu
 * sortiert nach einer Spalte, die nicht am Anfang des Primaerschluessels
 * steht. SQLite musste also alles lesen und extern sortieren, um am Ende in
 * JS auf die letzten `limit` Punkte je Reihe zu kuerzen. Der Aufwand wuchs
 * mit dem Alter der Sammlung, nicht mit dem, was gebraucht wird.
 *
 * Gemessen an 227 Reihen, jeweils mit `limit` 1000:
 *
 *   Historie      ganze Tabelle   je Reihe
 *   0,3 Tage           113 ms       54 ms
 *   5,7 Tage          1236 ms      406 ms
 *  22,7 Tage          6063 ms      673 ms
 *
 * Die Tabelle ist WITHOUT ROWID mit Schluessel (country, item, ts), liegt
 * also physisch in dieser Ordnung. Damit ist jede Reihenabfrage ein Sprung
 * plus ein kurzer Rueckwaertslauf, und die Gesamtzeit haengt nur noch an
 * Reihenzahl mal `limit` - nicht mehr daran, wie lange schon gesammelt wird.
 */
export function readSeries(db, { limit = 500, country = null } = {}) {
  const reihen = country
    ? db.prepare('SELECT country, item FROM samples WHERE country = ? GROUP BY country, item').all(country)
    : db.prepare('SELECT country, item FROM samples GROUP BY country, item').all();

  const abfrage = db.prepare(
    'SELECT ts, quantity FROM samples WHERE country = ? AND item = ? ORDER BY ts DESC LIMIT ?',
  );

  const series = {};
  for (const r of reihen) {
    const rows = abfrage.all(r.country, r.item, limit);
    if (!rows.length) continue;
    // DESC gelesen, damit die Grenze die *neuesten* Punkte nimmt - gedreht
    // wird erst hier, weil die Seite aufsteigende Zeit erwartet.
    series[joinKey(r.country, r.item)] = rows
      .reverse()
      .map((x) => [Number(x.ts), Number(x.quantity)]);
  }
  return series;
}

/** Obergrenzen, damit ein Tippfehler keine Reihe verdirbt. */
export const MANUAL_LIMITS = {
  maxQuantity: 1_000_000,
  // Rueckwirkend hoechstens einen Tag: wer sich an gestern erinnert, erinnert
  // sich nicht an die Minute - und der Zeitpunkt ist hier die halbe Messung.
  maxAgeMs: 24 * 3600 * 1000,
  // Ein bisschen Vorlauf gegen Uhren, die leicht vorgehen.
  maxFutureMs: 2 * 60 * 1000,
};

/**
 * Prueft eine von Hand gemeldete Beobachtung.
 *
 * Getrennt von der Datenbank, damit sich die Regeln ohne Datei testen lassen -
 * und weil eine Pruefung, die im Server steht, beim naechsten Aufrufer fehlt.
 *
 * @returns {{ok:true, wert:object} | {ok:false, grund:string}}
 */
export function pruefeBeobachtung(roh, { laender, now = Date.now() } = {}) {
  if (!roh || typeof roh !== 'object') return { ok: false, grund: 'kein Objekt' };

  const country = String(roh.country ?? '').trim().toLowerCase();
  if (!laender || !laender.has(country)) return { ok: false, grund: `unbekanntes Land: ${country || '(leer)'}` };

  const item = Number(roh.item);
  if (!Number.isInteger(item) || item <= 0) return { ok: false, grund: `unbrauchbare Item-ID: ${roh.item}` };

  // Number(null) und Number('') sind 0 - ohne diese Zeile wuerde aus einem
  // fehlenden Feld eine gemeldete Null, also ein leeres Regal.
  if (roh.quantity === null || roh.quantity === undefined || roh.quantity === '') {
    return { ok: false, grund: 'Menge fehlt' };
  }
  const quantity = Number(roh.quantity);
  if (!Number.isInteger(quantity) || quantity < 0 || quantity > MANUAL_LIMITS.maxQuantity) {
    return { ok: false, grund: `unbrauchbare Menge: ${roh.quantity}` };
  }

  const ts = roh.ts === undefined || roh.ts === null ? now : Number(roh.ts);
  if (!Number.isFinite(ts)) return { ok: false, grund: 'unbrauchbarer Zeitstempel' };
  if (ts > now + MANUAL_LIMITS.maxFutureMs) return { ok: false, grund: 'Zeitstempel liegt in der Zukunft' };
  if (ts < now - MANUAL_LIMITS.maxAgeMs) return { ok: false, grund: 'Zeitstempel ist aelter als ein Tag' };

  const note = roh.note === undefined || roh.note === null ? null : String(roh.note).slice(0, 200);

  return { ok: true, wert: { country, item, ts: Math.round(ts), quantity, note } };
}

/**
 * Zwei Messungen dicht hintereinander sind eine Messung.
 *
 * Derselbe Wert wie im Sammler (MIN_GAP_MS in js/travelStock.js), und aus
 * demselben Grund: aus zwei Punkten im Sekundenabstand liest die
 * Zyklenerkennung einen Sprung, den es nie gab.
 */
export const MANUAL_GAP_MS = 60 * 1000;

/**
 * Legt eine eigene Beobachtung neben die des Sammlers.
 *
 * Der Messpunkt geht nach samples - dort suchen ihn alle Auswertungen - und
 * die Herkunft nach manual. Beides in einer Transaktion: eine Beobachtung
 * ohne Herkunftseintrag waere spaeter nicht mehr als eigene zu erkennen.
 *
 * **Was im Umkreis einer Minute liegt, wird ersetzt statt ergaenzt.** Zwei
 * Klicks auf denselben Knopf ergaben sonst zwei widerspruechliche Punkte im
 * Millisekundenabstand - und daraus liest findCycles() einen Nachschub, den es
 * nie gab. Ersetzen statt ablehnen, weil der zweite Klick meistens eine
 * Korrektur ist; und wer im Shop steht, sieht genauer als eine Quelle, die
 * ihre Antwort bis zum naechsten Import festhaelt.
 *
 * @returns {{added:number, ersetzt:number}}
 */
export function saveManual(db, { country, item, ts, quantity, note = null }) {
  db.exec('BEGIN');
  try {
    const von = ts - MANUAL_GAP_MS;
    const bis = ts + MANUAL_GAP_MS;

    const ersetzt = db
      .prepare('DELETE FROM samples WHERE country = ? AND item = ? AND ts BETWEEN ? AND ?')
      .run(country, item, von, bis).changes;
    db.prepare('DELETE FROM manual WHERE country = ? AND item = ? AND ts BETWEEN ? AND ?')
      .run(country, item, von, bis);

    const added = db
      .prepare('INSERT OR REPLACE INTO samples (country, item, ts, quantity) VALUES (?, ?, ?, ?)')
      .run(country, item, ts, quantity).changes;
    db.prepare('INSERT OR REPLACE INTO manual (country, item, ts, note) VALUES (?, ?, ?, ?)')
      .run(country, item, ts, note);

    db.exec('COMMIT');
    return { added, ersetzt };
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

/** Wie viele Punkte einer Reihe von Hand kamen - fuer die Datenlage-Seite. */
export function manualCount(db) {
  return Number(db.prepare('SELECT COUNT(*) AS n FROM manual').get()?.n) || 0;
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
