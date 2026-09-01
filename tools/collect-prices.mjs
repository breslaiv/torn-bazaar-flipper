#!/usr/bin/env node
// Sammelt Marktpreise, damit "billig" einen Massstab bekommt.
//
// Der Scanner vergleicht heute gegen market_price. Der ist selbst ein
// nachlaufender Wert - er entsteht aus vergangenen Verkaeufen -, und bei
// schwankenden Items ist er der falsche Massstab: 20% unter Marktpreis kann
// fuer das eine Item ein Fund sein und fuer das andere der Normalzustand.
//
// Keine der drei Quellen bietet einen Preisverlauf an. Also legen wir ihn
// selbst an, und zwar ab jetzt - Historie laesst sich nicht nachtraeglich
// erzeugen.
//
// Zwei Dateien, aus einem Grund:
//
//   prices/JJJJ-MM.ndjson   Rohdaten, eine Zeile je Lauf. Angehaengt statt
//                           umgeschrieben, damit Git die Datei in Deltas
//                           speichern kann statt jedes Mal von vorn.
//   price-stats.json        Das, was der Browser liest: je Item ein paar
//                           Kennzahlen statt tausender Messpunkte. Ein
//                           Telefon soll keine Megabytes laden, um zu
//                           erfahren, ob ein Preis niedrig ist.
//
// Aufruf:  node tools/collect-prices.mjs [--dir data]

import { readFileSync, writeFileSync, appendFileSync, mkdirSync, existsSync } from 'node:fs';
import { WEAV3R_BASE } from '../js/config.js';
import { median } from '../js/stats.js';

const args = process.argv.slice(2);
const dirIndex = args.indexOf('--dir');
const DIR = dirIndex >= 0 ? args[dirIndex + 1] : 'data';

/** Fenster fuer den Normalbereich. Kuerzer waere anfaellig, laenger traege. */
const WINDOW_DAYS = 7;

const monthFile = (now) => {
  const d = new Date(now);
  return `${DIR}/prices/${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}.ndjson`;
};

/** Quantil einer sortierten Stichprobe, ohne Interpolation. */
function quantile(sorted, q) {
  if (!sorted.length) return null;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.floor(q * (sorted.length - 1))));
  return sorted[i];
}

/** Liest die Zeilen des laufenden Monats, juengste zuerst begrenzt. */
export function readRuns(path, since) {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => { try { return JSON.parse(line); } catch { return null; } })
    .filter((run) => run && Number.isFinite(run.t) && run.p && run.t >= since);
}

/**
 * Rechnet aus den Laeufen je Item den Normalbereich aus.
 *
 * Gespeichert wird bewusst wenig: der uebliche Tiefstpreis, ein unteres
 * Quantil als Schwelle fuer "ungewoehnlich billig", und der uebliche
 * Marktpreis. Mehr braucht die Entscheidung nicht, und weniger waere nicht
 * pruefbar.
 */
export function summarise(runs) {
  const byItem = new Map();
  for (const run of runs) {
    for (const [id, pair] of Object.entries(run.p)) {
      const [marketPrice, lowest] = pair;
      if (!byItem.has(id)) byItem.set(id, { market: [], low: [] });
      const acc = byItem.get(id);
      if (Number.isFinite(marketPrice) && marketPrice > 0) acc.market.push(marketPrice);
      if (Number.isFinite(lowest) && lowest > 0) acc.low.push(lowest);
    }
  }

  const stats = {};
  for (const [id, acc] of byItem) {
    // Ohne mehrere Beobachtungen gibt es keinen Normalbereich - dann bleibt
    // es beim Marktpreis als Massstab, wie bisher.
    if (acc.low.length < 3) continue;
    const low = [...acc.low].sort((a, b) => a - b);
    stats[id] = {
      n: low.length,
      lowMedian: Math.round(median(low)),
      lowP10: Math.round(quantile(low, 0.1)),
      lowMin: low[0],
      marketMedian: acc.market.length ? Math.round(median(acc.market)) : null,
    };
  }
  return stats;
}

async function main() {
  const res = await fetch(`${WEAV3R_BASE}/marketplace`, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`weav3r HTTP ${res.status}`);
  const data = await res.json();
  const items = Array.isArray(data.items) ? data.items : [];
  if (!items.length) throw new Error('leerer Katalog');

  const now = Date.now();
  const p = {};
  for (const item of items) {
    const id = Number(item.item_id);
    const marketPrice = Number(item.market_price) || 0;
    const lowest = Number(item.lowest_price) || 0;
    // Nur Items, die ueberhaupt irgendwo liegen: der Rest hat keinen
    // Tiefstpreis und blaeht die Datei nur auf.
    if (!Number.isFinite(id) || marketPrice <= 0 || lowest <= 0) continue;
    p[id] = [marketPrice, lowest];
  }

  mkdirSync(`${DIR}/prices`, { recursive: true });
  const path = monthFile(now);
  appendFileSync(path, `${JSON.stringify({ t: now, p })}\n`);

  const runs = readRuns(path, now - WINDOW_DAYS * 86400000);
  const stats = summarise(runs);

  writeFileSync(`${DIR}/price-stats.json`, `${JSON.stringify({
    computedAt: now,
    windowDays: WINDOW_DAYS,
    runs: runs.length,
    items: Object.keys(stats).length,
    stats,
  })}\n`);

  console.log(`${Object.keys(p).length} Items mit Listing erfasst.`);
  console.log(`${runs.length} Läufe im Fenster, ${Object.keys(stats).length} Items mit Normalbereich.`);
}

// Nur ausfuehren, wenn direkt aufgerufen - die Tests importieren die
// Rechenfunktionen.
if (process.argv[1] && process.argv[1].endsWith('collect-prices.mjs')) {
  main().catch((err) => {
    console.error(`Preise sammeln fehlgeschlagen: ${err.message}`);
    process.exit(1);
  });
}
