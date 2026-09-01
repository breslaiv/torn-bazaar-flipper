#!/usr/bin/env node
// Der Sammler fuer die eigene Maschine: laeuft durch, statt stuendlich zu
// starten, und schreibt in die Datenbank statt in eine Datei.
//
// Der Unterschied zu tools/collect-travel.mjs ist nur das Drumherum. Gemessen
// wird mit demselben collectOnce() und derselben watch()-Schleife - also nach
// exakt denselben Regeln, inklusive der wichtigsten: eine zwischengespeicherte
// Antwort von YATA ist keine neue Messung, weil ihr Zeitstempel derselbe
// bleibt. Zwei Sammler mit zwei Rechnungen waeren zwei Wahrheiten.
//
// Warum das hier dichter messen darf: in GitHub Actions kostet jeder Lauf ein
// Zeitfenster und jeder Stand einen Commit, deshalb ein Lauf pro Stunde mit
// Minutentakt und einer Luecke am Stundenwechsel. Hier kostet nichts etwas.
// Der Engpass ist ab jetzt nicht mehr unser Takt, sondern wie oft die
// YATA-Gemeinschaft ueberhaupt neue Vorraete einliefert - und genau das laesst
// sich an --stats endlich ablesen.
//
// Aufruf:  node tools/collect-local.mjs [--interval 30] [--db data/local/stock.db]

import { collectOnce, watch } from './collect-travel.mjs';
import { openStore, saveSeries, readSeries, recordRun, storeStats } from './store.mjs';
import { findCycles } from '../js/restock.js';
import { YATA_URL } from '../js/yata.js';

export function parseArgs(argv = []) {
  const value = (name, fallback) => {
    const i = argv.indexOf(name);
    return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback;
  };
  return {
    // Dreissig Sekunden, und das ist gemessen, nicht geraten: der kleinste
    // Abstand zwischen zwei YATA-Zeitstempeln ist exakt 60 s (1599 Luecken
    // ueber elf Laender, Minimum 60, Median 69). Ein Takt von 30 s hat damit
    // die doppelte Sicherheitsmarge und verliert nichts. Haeufiger zu fragen
    // bringt keinen einzigen Messpunkt mehr - die Quelle rechnet nur einmal
    // je Minute neu.
    //
    // Nach oben ist 60 s die Grenze, die man nicht anfassen darf: eine Abfrage
    // dauert selbst 0,5 bis 5,6 s, ein auf 60 s gestellter Sammler laeuft also
    // real langsamer als die Quelle und verliert regelmaessig eine ganze
    // Aktualisierung. Fuenf Sekunden bleiben die Untergrenze - darunter
    // belaestigt man eine fremde Quelle fuer nichts.
    intervalSeconds: Math.max(5, Number(value('--interval', 30)) || 30),
    db: value('--db', 'data/local/stock.db'),
    stats: argv.includes('--stats'),
    once: argv.includes('--once'),
  };
}

/**
 * Der Sammellauf. Alles Aeussere ist einspeisbar, damit der Test ihn ohne
 * Netz, ohne Uhr und ohne Warten durchspielen kann.
 */
export async function run({
  db, fetchJson, intervalMs, minutes = Infinity,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  now = () => Date.now(),
  log = () => {},
}) {
  // Der Startzustand kommt aus der Datenbank: nach einem Neustart weiss der
  // Sammler damit noch, was zuletzt im Regal stand, und meldet nicht jede
  // unveraenderte Zahl als neue Messung.
  let state = { series: readSeries(db, { limit: 120 }) };

  // watch() zaehlt Abfragen und Fehler mit, reicht diese Zahlen aber nicht an
  // save() weiter - und save() laeuft ohnehin nur bei einer Aenderung. Ohne
  // die Huelle hier stuende in runs.polls dauerhaft 0 und in runs.errors
  // ebenso, und damit waere die eine Frage, fuer die es die Tabelle gibt,
  // aus der Datenbank nicht mehr zu beantworten: wie viele Abfragen brachten
  // ueberhaupt etwas Neues? collectOnce() holt genau einmal je Abfrage,
  // deshalb zaehlt ein Aufruf dieser Huelle exakt eine Abfrage.
  let polls = 0;
  let errors = 0;
  let gebucht = { polls: 0, errors: 0 };

  const zaehlend = async (...args) => {
    polls += 1;
    try {
      return await fetchJson(...args);
    } catch (err) {
      errors += 1;
      throw err;
    }
  };

  const result = await watch({
    state,
    fetchJson: zaehlend,
    save: (next, meta) => {
      state = next;
      const added = saveSeries(db, next.series);
      // Gebucht wird der Zuwachs seit dem letzten Eintrag, nicht der
      // Gesamtstand: nur so bleibt SUM(polls) ueber die Tabelle die Zahl
      // aller Abfragen, auch ueber Neustarts hinweg.
      recordRun(db, {
        ts: now(),
        source: YATA_URL,
        polls: polls - gebucht.polls,
        changes: 1,
        errors: errors - gebucht.errors,
      });
      gebucht = { polls, errors };
      if (added) log(`  ${new Date(now()).toISOString().slice(11, 19)}  ${added} neue Messpunkte`);
    },
    minutes,
    intervalMs,
    sleep,
    now,
    log,
  });

  return result;
}

const fetchYata = async () => {
  const res = await fetch(YATA_URL, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`yata.yt HTTP ${res.status}`);
  return res.json();
};

/**
 * Wie reif ist die Datenlage je Reihe?
 *
 * Messpunkte sind die falsche Waehrung. Ein Regal, das seit Stunden voll
 * dasteht, liefert hunderte Punkte und verraet nichts ueber seinen Timer -
 * gebraucht werden abgeschlossene Nachfuell-Zyklen, und die entstehen nur,
 * wenn das Regal leerlaeuft. Genau daran haengt, ab wann eine Vorhersage fuer
 * ein Item ueberhaupt etwas taugt.
 *
 * @returns {{reihen:number, zyklen:number, stufen:object, mitTimer:number}}
 */
export function reifegrad(series = {}) {
  const werte = Object.values(series).map((reihe) => findCycles(reihe).filter((z) => !z.open).length);
  const stufen = {};
  for (const grenze of [1, 3, 10, 20]) stufen[grenze] = werte.filter((n) => n >= grenze).length;
  return {
    reihen: werte.length,
    zyklen: werte.reduce((a, b) => a + b, 0),
    stufen,
    // Vier Zyklen sind die Schwelle, ab der MIN_CHECKS im Modellwettbewerb
    // ueberhaupt erreichbar wird.
    mitTimer: werte.filter((n) => n >= 4).length,
  };
}

function printStats(db) {
  const s = storeStats(db);
  if (!s.points) {
    console.log('Noch nichts gesammelt.');
    return;
  }
  const hours = (s.last - s.first) / 3600000;
  console.log(`${s.series} Reihen, ${s.points} Messpunkte`);
  console.log(`von ${new Date(s.first).toISOString()} bis ${new Date(s.last).toISOString()}`);
  console.log(`= ${hours.toFixed(1)} h, im Schnitt ${(s.points / s.series / Math.max(hours, 1)).toFixed(1)} Punkte je Reihe und Stunde`);
  console.log('Das ist die Dichte, die YATA hergibt — nicht die, mit der wir fragen.');

  const r = reifegrad(readSeries(db, { limit: 1000 }));
  console.log(`\n${r.zyklen} abgeschlossene Nachfüll-Zyklen. Reihen mit mindestens`);
  for (const [grenze, n] of Object.entries(r.stufen)) {
    const anteil = r.reihen ? (n / r.reihen) * 100 : 0;
    console.log(`  ${String(grenze).padStart(2)} Zyklen: ${String(n).padStart(3)} von ${r.reihen}  (${anteil.toFixed(0)} %)`);
  }
  console.log(`\n${r.mitTimer} Reihen haben genug Zyklen für eine geprüfte Vorhersage.`);
  console.log('Zyklen sind die Währung, nicht Messpunkte: ein volles Regal liefert');
  console.log('beliebig viele Punkte und verrät nichts über seinen Timer.');
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const db = openStore(opts.db);

  if (opts.stats) {
    printStats(db);
    db.close();
    return;
  }

  if (opts.once) {
    const result = await collectOnce({ series: readSeries(db, { limit: 120 }) }, { fetchJson: fetchYata });
    const added = saveSeries(db, result.series);
    recordRun(db, { source: YATA_URL, polls: 1, changes: result.changed ? 1 : 0 });
    console.log(`${result.countries} Länder, ${result.items} Items — ${added} neue Messpunkte.`);
    db.close();
    return;
  }

  console.log(`Sammle alle ${opts.intervalSeconds} s in ${opts.db}. Beenden mit Strg-C.`);
  let stopping = false;
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
      if (stopping) process.exit(1);
      stopping = true;
      console.log('\nEnde — Datenbank wird geschlossen.');
      db.close();
      process.exit(0);
    });
  }

  await run({
    db,
    fetchJson: fetchYata,
    intervalMs: opts.intervalSeconds * 1000,
    log: (line) => console.log(line),
  });
}

if (process.argv[1] && process.argv[1].endsWith('collect-local.mjs')) {
  main().catch((err) => {
    console.error(`Sammeln fehlgeschlagen: ${err.message}`);
    process.exit(1);
  });
}
