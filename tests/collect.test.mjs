import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

function fakeStorage() {
  return { getItem: () => null, setItem: () => {}, removeItem: () => {} };
}
globalThis.localStorage = fakeStorage();

const { mergeStock, MAX_SAMPLES } = await import('../js/travelStock.js');

const T0 = 1_700_000_000_000;
const MIN = 60000;
const at = (m) => T0 + m * MIN;

test('gesammelte und eigene Messungen ergeben eine Reihe', () => {
  // Der Sammler laeuft nachts, der Nutzer sieht tagsueber selbst nach.
  // Zusammen ist es dieselbe Geschichte desselben Regals.
  const lokal = { 'mex:260': [[at(10), 90], [at(30), 50]] };
  const gesammelt = { 'mex:260': [[at(0), 100], [at(20), 70], [at(40), 20]] };

  const merged = mergeStock(lokal, gesammelt);
  assert.deepEqual(merged['mex:260'].map(([ts]) => (ts - T0) / MIN), [0, 10, 20, 30, 40]);
});

test('doppelte Zeitstempel zaehlen einmal, und die eigene Messung gewinnt', () => {
  // Wer selbst im Shop stand, hat genauer hingesehen als eine fremde Quelle.
  const merged = mergeStock(
    { 'mex:260': [[at(10), 42]] },
    { 'mex:260': [[at(10), 40], [at(20), 30]] },
  );
  assert.equal(merged['mex:260'].length, 2);
  assert.equal(merged['mex:260'][0][1], 42);
});

test('Reihen, die es nur auf einer Seite gibt, bleiben erhalten', () => {
  const merged = mergeStock({ 'mex:1': [[at(0), 5]] }, { 'sou:2': [[at(0), 7]] });
  assert.deepEqual(Object.keys(merged).sort(), ['mex:1', 'sou:2']);
});

test('unbrauchbare Punkte kommen nicht durch', () => {
  const merged = mergeStock({}, { 'mex:1': [[at(0), 5], [null, 3], [at(10), NaN], ['x', 1]] });
  assert.deepEqual(merged['mex:1'], [[at(0), 5]]);
});

test('die Reihe bleibt gedeckelt', () => {
  const viele = Array.from({ length: MAX_SAMPLES + 30 }, (_, i) => [at(i), 500 - i]);
  const merged = mergeStock({}, { 'mex:1': viele });
  assert.equal(merged['mex:1'].length, MAX_SAMPLES);
  assert.equal(merged['mex:1'][MAX_SAMPLES - 1][0], viele[viele.length - 1][0], 'die juengsten bleiben');
});

test('leere Sammlungen aendern nichts', () => {
  const lokal = { 'mex:1': [[at(0), 5]] };
  assert.deepEqual(mergeStock(lokal, {}), lokal);
  assert.deepEqual(mergeStock({}, {}), {});
});

// ---------- Der Sammler ----------

test('der Sammler benutzt dieselben Funktionen wie die App', () => {
  // Sonst entstehen zwei Wahrheiten: eine im Browser, eine im Workflow.
  const src = readFileSync('./tools/collect-travel.mjs', 'utf8');
  assert.match(src, /from '\.\.\/js\/yata\.js'/, 'parst nicht mit dem App-Parser');
  assert.match(src, /from '\.\.\/js\/travelStock\.js'/, 'schreibt nicht mit der App-Logik');
  assert.match(src, /recordSnapshot/);
});

test('der Sammler nimmt den Zeitstempel der Quelle, nicht die eigene Uhr', () => {
  // YATA liefert bis zum naechsten Import dieselbe Nutzlast. Mit der eigenen
  // Uhr wuerde daraus alle zehn Minuten eine neue Messung - und aus lauter
  // gleichen Mengen ein Abverkauf von null.
  const src = readFileSync('./tools/collect-travel.mjs', 'utf8');
  assert.match(src, /updated\.get\(code\)\s*\|\|\s*payloadAt/);
});

test('der Sammler-Workflow läuft nach Plan und schreibt ins Repository', () => {
  const yml = readFileSync('./.github/workflows/collect.yml', 'utf8');
  assert.match(yml, /schedule:/, 'ohne Zeitplan sammelt niemand');
  assert.match(yml, /cron:/);
  assert.match(yml, /contents: write/, 'ohne Schreibrecht kann er nichts festhalten');
  assert.match(yml, /concurrency:/, 'zwei Läufe würden sich beim Schreiben stören');
  assert.doesNotMatch(yml, /actions\/deploy-pages/, 'der Sammler deployt nicht');
});

test('die gesammelte Datei liegt neben der Seite und ist gültiges JSON', () => {
  // Same-origin: kein CORS, und keine zusaetzliche Domain in der CSP.
  const data = JSON.parse(readFileSync('./data/travel-stock.json', 'utf8'));
  assert.equal(typeof data.series, 'object');
  assert.ok('collectedAt' in data);
});

test('kein Workflow trägt ein Geheimnis in die Sammlung', () => {
  // Die Datei landet in einem oeffentlichen Repository.
  const yml = readFileSync('./.github/workflows/collect.yml', 'utf8');
  assert.doesNotMatch(yml, /secrets\./, 'der Sammler braucht keinen Key — und soll keinen bekommen');
});
