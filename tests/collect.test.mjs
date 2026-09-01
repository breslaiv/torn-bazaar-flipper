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

// ---------- Messen im Minutentakt ----------

const { parseArgs, collectOnce, watch } = await import('../tools/collect-travel.mjs');

const payload = (quantity, stamp) => ({
  timestamp: Math.floor(stamp / 1000),
  stocks: { mex: { update: Math.floor(stamp / 1000), stocks: [{ id: 260, name: 'Dahlia', quantity, cost: 400 }] } },
});

test('ohne --watch bleibt es bei einer Messung', () => {
  const a = parseArgs([]);
  assert.equal(a.watchMinutes, 0);
  assert.equal(a.intervalSeconds, 60);
  assert.equal(a.out, 'data/travel-stock.json');
});

test('der Takt lässt sich einstellen, aber nicht beliebig eng', () => {
  // Sekundentakt wäre gegenüber einer fremden Quelle unhöflich und brächte
  // nichts: YATA liefert bis zum nächsten Import dieselbe Antwort.
  assert.equal(parseArgs(['--watch', '55', '--interval', '60']).watchMinutes, 55);
  assert.equal(parseArgs(['--interval', '1']).intervalSeconds, 10, 'nach unten begrenzt');
  assert.equal(parseArgs(['--watch', '-5']).watchMinutes, 0);
});

test('eine Messung trägt nur Neues ein', async () => {
  const stamp = T0;
  const first = await collectOnce({ series: {} }, { fetchJson: async () => payload(200, stamp) });
  assert.equal(first.changed, true);
  assert.equal(first.countries, 1);

  // Dieselbe Antwort noch einmal: derselbe Zeitstempel, also keine neue Messung.
  const again = await collectOnce({ series: first.series }, { fetchJson: async () => payload(200, stamp) });
  assert.equal(again.changed, false);
});

test('der lange Lauf misst dicht und sichert jede Änderung sofort', async () => {
  // Der Kern der Umstellung: 55 Messungen in einem Lauf statt einer.
  let clock = T0;
  let quantity = 300;
  const gespeichert = [];

  const result = await watch({
    state: { series: {} },
    // Der Vorrat fällt jede Minute - jede Messung bringt also etwas Neues.
    fetchJson: async () => { quantity -= 5; return payload(quantity, clock); },
    save: (next) => gespeichert.push(Object.values(next.series)[0].length),
    minutes: 10,
    intervalMs: 60000,
    sleep: async (ms) => { clock += ms; },
    now: () => clock,
  });

  // Elf, nicht zehn: gemessen wird sofort beim Start und dann jede Minute.
  assert.equal(result.polls, 11, 'zehn Minuten, Minutentakt, plus die Messung bei Beginn');
  assert.equal(result.errors, 0);
  assert.ok(gespeichert.length >= 9, 'nach jeder Änderung wird gesichert, nicht erst am Ende');
  assert.equal(gespeichert[gespeichert.length - 1], result.polls, 'jede Messung ist ein Punkt');
});

test('eine unveränderte Antwort erzeugt keinen Messpunkt', async () => {
  let clock = T0;
  const result = await watch({
    state: { series: {} },
    fetchJson: async () => payload(200, T0),   // immer derselbe Zeitstempel
    save: () => {},
    minutes: 10,
    intervalMs: 60000,
    sleep: async (ms) => { clock += ms; },
    now: () => clock,
  });
  assert.equal(result.polls, 11);
  assert.equal(result.changes, 1, 'nur die allererste Antwort war neu');
});

test('ein Ausfall der Quelle beendet den Lauf nicht, bremst ihn aber', async () => {
  // Ohne Bremse klopfte der Sammler bei einem Ausfall eine Stunde lang im
  // Minutentakt an.
  let clock = T0;
  const abstaende = [];
  let vorher = clock;

  const result = await watch({
    state: { series: {} },
    fetchJson: async () => { throw new Error('yata.yt HTTP 503'); },
    save: () => {},
    minutes: 30,
    intervalMs: 60000,
    sleep: async (ms) => { abstaende.push(ms); clock += ms; vorher = clock; },
    now: () => clock,
  });

  assert.ok(result.errors > 0);
  assert.ok(result.polls < 30, `bei Ausfall wird seltener gefragt: ${result.polls} Versuche`);
  assert.ok(abstaende[1] > abstaende[0], 'der Abstand wächst');
  assert.ok(Math.max(...abstaende) <= 10 * 60000, 'aber nicht ins Unendliche');
});

test('nach einem Fehler geht es im normalen Takt weiter', async () => {
  let clock = T0;
  let calls = 0;
  const abstaende = [];
  let quantity = 500;

  await watch({
    state: { series: {} },
    fetchJson: async () => {
      calls += 1;
      if (calls === 1) throw new Error('einmalig kaputt');
      quantity -= 5;
      return payload(quantity, clock);
    },
    save: () => {},
    minutes: 8,
    intervalMs: 60000,
    sleep: async (ms) => { abstaende.push(ms); clock += ms; },
    now: () => clock,
  });

  assert.equal(abstaende[0], 120000, 'nach dem Fehler doppelter Abstand');
  assert.equal(abstaende[1], 60000, 'danach wieder normal');
});

test('der Workflow misst lange und committet einmal', () => {
  const yml = readFileSync('./.github/workflows/collect.yml', 'utf8');
  assert.match(yml, /cron: '2 \* \* \* \*'/, 'stündlich statt alle zehn Minuten');
  assert.match(yml, /--watch/, 'ohne watch wäre es wieder eine Einzelmessung');
  assert.match(yml, /timeout-minutes: 70/, 'ein 55-Minuten-Lauf braucht Luft');
});
