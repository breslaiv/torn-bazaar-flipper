import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readRuns, summarise } from '../tools/collect-prices.mjs';

const HOUR = 3600000;
const T0 = 1_700_000_000_000;

/** Laeufe, wie der Sammler sie anhaengt: ein Objekt je Zeile. */
function schreibeLaeufe(zeilen) {
  const dir = mkdtempSync(join(tmpdir(), 'prices-'));
  const path = join(dir, '2026-09.ndjson');
  writeFileSync(path, `${zeilen.map((z) => JSON.stringify(z)).join('\n')}\n`);
  return path;
}

test('gelesen wird nur, was ins Fenster fällt', () => {
  const path = schreibeLaeufe([
    { t: T0 - 30 * 24 * HOUR, p: { 206: [900000, 800000] } },
    { t: T0 - 2 * HOUR, p: { 206: [900000, 810000] } },
    { t: T0, p: { 206: [900000, 820000] } },
  ]);
  assert.equal(readRuns(path, T0 - 7 * 24 * HOUR).length, 2, 'der Lauf von vor einem Monat fällt raus');
});

test('kaputte Zeilen kippen den Lauf nicht', () => {
  // Ein abgebrochener Schreibvorgang darf nicht die ganze Historie entwerten.
  const dir = mkdtempSync(join(tmpdir(), 'prices-'));
  const path = join(dir, '2026-09.ndjson');
  writeFileSync(path, `${JSON.stringify({ t: T0, p: { 206: [900000, 820000] } })}\n{kaputt\n\n`);
  assert.equal(readRuns(path, 0).length, 1);
});

test('eine fehlende Datei ist kein Fehler, nur eine leere Historie', () => {
  assert.deepEqual(readRuns('/gibt/es/nicht.ndjson', 0), []);
});

test('der Normalbereich beschreibt das Item, nicht den Markt', () => {
  // Der Kern der Sache: 41.000 sind für dieses Item normal, nicht billig.
  const runs = [820000, 815000, 830000, 810000, 825000].map((low, i) => ({
    t: T0 + i * HOUR,
    p: { 206: [900000, low], 260: [60000, 41000 + i * 100] },
  }));

  const stats = summarise(runs);
  assert.equal(stats['206'].n, 5);
  assert.equal(stats['206'].lowMedian, 820000);
  assert.equal(stats['206'].lowMin, 810000);
  assert.equal(stats['206'].marketMedian, 900000);
  assert.ok(stats['206'].lowP10 <= stats['206'].lowMedian);
});

test('unter drei Beobachtungen gibt es keinen Normalbereich', () => {
  // Lieber weiter gegen den Marktpreis messen als gegen zwei Zufallswerte.
  const stats = summarise([
    { t: T0, p: { 206: [900000, 820000] } },
    { t: T0 + HOUR, p: { 206: [900000, 810000] } },
  ]);
  assert.equal(stats['206'], undefined);
});

test('Items ohne Listing tauchen gar nicht erst auf', () => {
  const stats = summarise(Array.from({ length: 4 }, (_, i) => ({
    t: T0 + i * HOUR,
    p: { 206: [900000, 0], 260: [60000, 41000] },
  })));
  assert.equal(stats['206'], undefined, 'ohne Tiefstpreis kein Normalbereich');
  assert.ok(stats['260']);
});

test('das untere Quantil liegt unter dem üblichen Preis', () => {
  // Es ist die Schwelle für "ungewöhnlich billig, auch für dieses Item".
  const preise = [100, 100, 100, 100, 100, 100, 100, 100, 60, 100];
  const stats = summarise(preise.map((low, i) => ({ t: T0 + i * HOUR, p: { 1: [200, low] } })));
  assert.equal(stats['1'].lowMedian, 100);
  assert.equal(stats['1'].lowP10, 60, 'der eine Ausreißer nach unten ist die Schwelle');
});

test('der Preis-Workflow läuft seltener als der Vorratssammler', () => {
  // Jeder Commit löst ein Pages-Deployment aus; Preise bewegen sich langsamer.
  const yml = readFileSync('./.github/workflows/collect-prices.yml', 'utf8');
  assert.match(yml, /cron: '7 \* \* \* \*'/, 'stündlich, versetzt zur vollen Stunde');
  assert.match(yml, /contents: write/);
  assert.doesNotMatch(yml, /secrets\./);
});

// ---------- Der Vergleich im Scanner ----------

const { statsMap, compareToNormal, withNormal } = await import('../js/normal.js');

test('der Vergleich misst am Item, nicht am Markt', () => {
  // Zwei Items, beide 20% unter Marktpreis - aber nur eines davon ist
  // ungewöhnlich billig. Genau diesen Unterschied kann market_price nicht
  // ausdrücken.
  const stats = statsMap({ stats: {
    206: { n: 40, lowMedian: 820000, lowP10: 780000, lowMin: 770000, marketMedian: 900000 },
    260: { n: 40, lowMedian: 41000, lowP10: 40000, lowMin: 39000, marketMedian: 60000 },
  } });

  const xanax = compareToNormal(720000, stats.get(206));
  assert.ok(xanax.discount > 10, `${xanax.discount}% unter dem üblichen Preis`);
  assert.equal(xanax.unusual, true, 'unter dem unteren Zehntel');

  const dahlia = compareToNormal(48000, stats.get(260));
  assert.ok(dahlia.discount < 0, 'teurer als üblich, obwohl weit unter Marktpreis');
  assert.equal(dahlia.unusual, false);
});

test('ohne Kennzahlen bleibt die Zeile unverändert', () => {
  const rows = [{ itemId: 999, buy: 100 }];
  assert.deepEqual(withNormal(rows, new Map()), rows);
  assert.equal(compareToNormal(100, undefined), null);
  assert.equal(compareToNormal(0, { lowMedian: 50, lowP10: 40 }), null);
});

test('unbrauchbare Kennzahlen kommen nicht in die Karte', () => {
  const map = statsMap({ stats: {
    1: { n: 5, lowMedian: 100, lowP10: 90 },
    2: { n: 5, lowMedian: 0 },
    x: { n: 5, lowMedian: 100 },
  } });
  assert.deepEqual([...map.keys()], [1]);
});

test('fehlende Datei ergibt eine leere Karte, keinen Fehler', () => {
  assert.equal(statsMap(null).size, 0);
  assert.equal(statsMap({}).size, 0);
});
