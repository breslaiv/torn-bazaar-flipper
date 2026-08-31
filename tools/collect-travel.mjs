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
// Aufruf:  node tools/collect-travel.mjs [--out data/travel-stock.json]

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { parseTravelExport, YATA_URL } from '../js/yata.js';
import { recordSnapshot } from '../js/travelStock.js';

// Im Repository darf die Reihe laenger sein als im Browser: Platz kostet hier
// nichts, und je mehr Zyklen bekannt sind, desto enger wird der Timer.
const KEEP_PER_SERIES = 120;

const args = process.argv.slice(2);
const outIndex = args.indexOf('--out');
const OUT = outIndex >= 0 ? args[outIndex + 1] : 'data/travel-stock.json';

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

async function main() {
  const res = await fetch(YATA_URL, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`yata.yt HTTP ${res.status}`);

  const { countries, updated, unknown, payloadAt } = parseTravelExport(await res.json());
  if (!countries.size) throw new Error('kein Land in der Antwort erkannt');

  const before = loadExisting(OUT);
  let series = { ...before.series };
  let items = 0;

  for (const [code, list] of countries) {
    items += list.length;
    // Der Zeitstempel der Quelle, nicht die eigene Uhr: YATA liefert bis zum
    // naechsten Import dieselbe Nutzlast, und die ist keine neue Messung.
    series = recordSnapshot(series, code, list, updated.get(code) || payloadAt || Date.now());
  }

  for (const key of Object.keys(series)) series[key] = series[key].slice(-KEEP_PER_SERIES);

  const points = Object.values(series).reduce((sum, s) => sum + s.length, 0);
  const changed = JSON.stringify(series) !== JSON.stringify(before.series);

  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, `${JSON.stringify({
    // Damit die Seite weiss, wie frisch die Sammlung ist.
    collectedAt: Date.now(),
    source: YATA_URL,
    countries: countries.size,
    points,
    series,
  }, null, 0)}\n`);

  console.log(`${countries.size} Länder, ${items} Items gelesen.`);
  console.log(`${Object.keys(series).length} Reihen, ${points} Messpunkte.`);
  if (unknown.length) console.log(`nicht zugeordnet: ${unknown.join(', ')}`);
  console.log(changed ? 'Neue Messungen — Datei geändert.' : 'Nichts Neues (gecachte Antwort).');
}

main().catch((err) => {
  console.error(`Sammeln fehlgeschlagen: ${err.message}`);
  process.exit(1);
});
