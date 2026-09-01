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
// Aufruf:  node tools/collect-local.mjs [--interval 15] [--db data/local/stock.db]

import { collectOnce, watch } from './collect-travel.mjs';
import { openStore, saveSeries, readSeries, recordRun, storeStats } from './store.mjs';
import { YATA_URL } from '../js/yata.js';

export function parseArgs(argv = []) {
  const value = (name, fallback) => {
    const i = argv.indexOf(name);
    return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback;
  };
  return {
    // Fuenf Sekunden sind die Untergrenze: darunter belaestigt man eine fremde
    // Quelle fuer nichts. YATA liefert ohnehin nur neue Zeitstempel, wenn
    // jemand importiert hat.
    intervalSeconds: Math.max(5, Number(value('--interval', 15)) || 15),
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

  const result = await watch({
    state,
    fetchJson,
    save: (next, meta) => {
      state = next;
      const added = saveSeries(db, next.series);
      recordRun(db, { ts: now(), source: YATA_URL, changes: 1 });
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
