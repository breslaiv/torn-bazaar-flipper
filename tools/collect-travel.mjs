#!/usr/bin/env node
// Sammelt die Auslandsvorraete, damit das Modell nicht an der Aufmerksamkeit
// eines Menschen haengt.
//
// Der Punkt: eine Messreihe entsteht nur, wenn jemand nachsieht. Solange das
// der Browser des Nutzers tut, gibt es Daten genau dann, wenn er die Seite
// offen hat - also ausgerechnet nicht nachts, und nicht in dem Fenster, in
// dem ein Timer ablaeuft. Dieses Skript laeuft in GitHub Actions nach Plan
// und schreibt das Ergebnis ins Repository; die Seite liest es beim Start.
//
// Zwei Eigenschaften, die kein Zufall sind:
//
//   Gleiche Rechnung   Es benutzt parseTravelExport und recordSnapshot aus
//                      der App. Was hier gesammelt wird, entsteht nach
//                      exakt denselben Regeln wie eine Eingabe von Hand -
//                      inklusive der Regel, dass eine zwischengespeicherte
//                      Antwort keine neue Messung ist.
//
//   Kein CORS          Serverseitig gibt es die Beschraenkung nicht, an der
//                      der Browser scheitern kann. Selbst wenn yata.yt
//                      Zugriffe aus fremden Seiten verweigert, fuellt sich
//                      die Historie hier weiter.
//
// Dichte schlaegt Haeufigkeit. Ein Zeitplan alle zehn Minuten trifft den
// Moment eines Nachschubs nur auf zehn Minuten genau, und genau diese
// Unsicherheit steckt danach im Timer. Deshalb laeuft ein einziger Lauf pro
// Stunde und misst darin im Minutentakt: dieselbe Zahl an Commits, aber
// sechzigfach genauere Grenzen.
//
// Aufruf:  node tools/collect-travel.mjs [--out data/travel-stock.json]
//                                        [--watch 55] [--interval 60]

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { parseTravelExport, YATA_URL } from '../js/yata.js';
import { recordSnapshot } from '../js/travelStock.js';

// Im Repository darf die Reihe laenger sein als im Browser: Platz kostet hier
// nichts, und je mehr Zyklen bekannt sind, desto enger wird der Timer.
const KEEP_PER_SERIES = 120;

export function parseArgs(argv = []) {
  const value = (name, fallback) => {
    const i = argv.indexOf(name);
    return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback;
  };
  return {
    out: value('--out', 'data/travel-stock.json'),
    // 0 heisst: einmal messen und fertig. So laeuft es in Tests und von Hand.
    watchMinutes: Math.max(0, Number(value('--watch', 0)) || 0),
    intervalSeconds: Math.max(10, Number(value('--interval', 60)) || 60),
  };
}

const OPTIONS = parseArgs(process.argv.slice(2));
const OUT = OPTIONS.out;

function loadExisting(path) {
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8'));
    return raw && typeof raw === 'object' && raw.series && typeof raw.series === 'object'
      ? raw
      : { series: {} };
  } catch {
    return { series: {} };
  }
}

/**
 * Eine Messung: lesen, eintragen, Ergebnis melden.
 *
 * @param {object} state  {series}
 * @returns {{series:object, changed:boolean, countries:number, items:number, unknown:string[]}}
 */
export async function collectOnce(state, { fetchJson }) {
  const { countries, updated, unknown, payloadAt } = parseTravelExport(await fetchJson());
  if (!countries.size) throw new Error('kein Land in der Antwort erkannt');

  let series = { ...state.series };
  let items = 0;
  for (const [code, list] of countries) {
    items += list.length;
    // Der Zeitstempel der Quelle, nicht die eigene Uhr: YATA liefert bis zum
    // naechsten Import dieselbe Nutzlast, und die ist keine neue Messung.
    series = recordSnapshot(series, code, list, updated.get(code) || payloadAt || Date.now());
  }
  for (const key of Object.keys(series)) series[key] = series[key].slice(-KEEP_PER_SERIES);

  return {
    series,
    changed: JSON.stringify(series) !== JSON.stringify(state.series),
    countries: countries.size,
    items,
    unknown,
  };
}

/**
 * Misst wiederholt, bis die Zeit um ist.
 *
 * Ein Fehler beendet den Lauf nicht - die Quelle ist fremd und darf mal
 * huesteln. Stattdessen wird der Abstand verdoppelt, bis sie wieder
 * antwortet; danach geht es im normalen Takt weiter. Ohne diese Bremse
 * klopfte der Sammler bei einem Ausfall eine Stunde lang im Minutentakt an.
 */
export async function watch({
  state, fetchJson, save, minutes, intervalMs, sleep, now = () => Date.now(), log = () => {},
}) {
  const until = now() + minutes * 60000;
  const stats = { polls: 0, changes: 0, errors: 0 };
  let current = state;
  let wait = intervalMs;

  for (;;) {
    stats.polls += 1;
    try {
      const result = await collectOnce(current, { fetchJson });
      wait = intervalMs;
      if (result.changed) {
        stats.changes += 1;
        current = { series: result.series };
        // Nach jeder Aenderung sichern: wird der Lauf abgebrochen, ist die
        // Arbeit trotzdem da.
        save(current, result);
        log(`  ${new Date(now()).toISOString().slice(11, 19)}  neue Messungen (${stats.changes}.)`);
      }
    } catch (err) {
      stats.errors += 1;
      wait = Math.min(wait * 2, 10 * 60000);
      log(`  Fehler: ${err.message} — nächster Versuch in ${Math.round(wait / 1000)} s`);
    }

    if (now() + wait > until) break;
    await sleep(wait);
  }

  return { ...stats, state: current };
}

function writeOut(state, meta) {
  const points = Object.values(state.series).reduce((sum, s) => sum + s.length, 0);
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, `${JSON.stringify({
    // Damit die Seite weiss, wie frisch die Sammlung ist.
    collectedAt: Date.now(),
    source: YATA_URL,
    countries: meta?.countries ?? 0,
    points,
    series: state.series,
  }, null, 0)}\n`);
  return points;
}

async function main() {
  const fetchJson = async () => {
    const res = await fetch(YATA_URL, { headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error(`yata.yt HTTP ${res.status}`);
    return res.json();
  };

  const before = loadExisting(OUT);
  let state = { series: before.series };
  let lastMeta = null;

  if (OPTIONS.watchMinutes > 0) {
    console.log(`Messe ${OPTIONS.watchMinutes} Minuten lang alle ${OPTIONS.intervalSeconds} s.`);
    const result = await watch({
      state,
      fetchJson,
      save: (next, meta) => { state = next; lastMeta = meta; writeOut(next, meta); },
      minutes: OPTIONS.watchMinutes,
      intervalMs: OPTIONS.intervalSeconds * 1000,
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      log: (line) => console.log(line),
    });
    console.log(`${result.polls} Abfragen, ${result.changes} mit neuen Messungen, ${result.errors} Fehler.`);
    if (!result.changes) console.log('Nichts Neues — YATA lieferte durchgehend dieselbe Antwort.');
  } else {
    const result = await collectOnce(state, { fetchJson });
    state = { series: result.series };
    lastMeta = result;
    writeOut(state, result);
    console.log(`${result.countries} Länder, ${result.items} Items gelesen.`);
    console.log(result.changed ? 'Neue Messungen — Datei geändert.' : 'Nichts Neues (gecachte Antwort).');
    if (result.unknown.length) console.log(`nicht zugeordnet: ${result.unknown.join(', ')}`);
  }

  const points = writeOut(state, lastMeta);
  console.log(`${Object.keys(state.series).length} Reihen, ${points} Messpunkte.`);
}

// Nur ausfuehren, wenn direkt aufgerufen - die Tests importieren die Bausteine.
if (process.argv[1] && process.argv[1].endsWith('collect-travel.mjs')) {
  main().catch((err) => {
    console.error(`Sammeln fehlgeschlagen: ${err.message}`);
    process.exit(1);
  });
}
