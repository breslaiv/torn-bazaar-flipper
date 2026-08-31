import test from 'node:test';
import assert from 'node:assert/strict';

function fakeStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
  };
}
globalThis.localStorage = fakeStorage();

const {
  recordSnapshot, estimate, predict, seriesFor, loadStock, saveStock, MAX_SAMPLES,
} = await import('../js/travelStock.js');

const MIN = 60000;
const T0 = 1_700_000_000_000;

/** Reihe aus [Minute, Menge]-Paaren. */
const series = (pairs) => pairs.map(([m, q]) => [T0 + m * MIN, q]);

test('Abverkauf wird aus fallenden Mengen gelesen', () => {
  const e = estimate(series([[0, 100], [10, 80], [20, 60]]));
  assert.equal(e.drainPerMinute, 2, '20 Stueck in 10 Minuten');
  assert.equal(e.samples, 3);
  assert.equal(e.latest, 60);
});

test('ein Sprung nach oben ist Nachschub, kein negativer Abverkauf', () => {
  const e = estimate(series([[0, 100], [10, 20], [15, 320], [30, 200], [45, 500]]));
  assert.equal(e.restocksSeen, 2);
  assert.equal(e.restockAmount, 300, 'zweimal +300');
  assert.equal(e.restockIntervalMinutes, 30);
  assert.ok(e.drainPerMinute > 0);
});

test('der Median haelt einen Grosseinkauf aus', () => {
  // Ein einzelner Spieler raeumt das Regal leer. Ein Mittelwert wuerde
  // daraus dauerhaft ein falsches Tempo machen.
  const ruhig = series([[0, 100], [10, 90], [20, 80], [30, 70]]);
  const mitAusreisser = series([[0, 100], [10, 90], [20, 80], [30, 70], [31, 5]]);
  assert.equal(estimate(ruhig).drainPerMinute, 1);
  assert.equal(estimate(mitAusreisser).drainPerMinute, 1, 'der Ausreisser verschiebt den Median nicht');
});

test('ohne zwei Messungen wird nichts vorhergesagt', () => {
  // Eine erfundene Zahl ist hier besonders teuer: man fliegt drei Stunden
  // und steht vor einem leeren Regal.
  const p = predict(series([[0, 100]]), 60, T0);
  assert.equal(p.quantity, null);
  assert.equal(p.confidence, 'unbekannt');
  assert.match(p.why, /zu wenige/);
});

test('die Vorhersage rechnet Abverkauf ab und Nachschub dazu', () => {
  const s = series([[0, 500], [10, 400], [20, 300]]);   // 10/min
  const now = T0 + 20 * MIN;

  const p = predict(s, 10, now);
  assert.equal(p.quantity, 200, '300 minus 10 Minuten à 10');

  // Nach unten bei null: negativer Vorrat waere Unsinn.
  assert.equal(predict(s, 600, now).quantity, 0);
});

test('die Vorhersage rechnet ab der letzten Messung, nicht ab jetzt', () => {
  // Zwischen Messung und Aufruf liegt oft eine Stunde - wer die ignoriert,
  // sagt einen Vorrat vorher, den es seit einer Stunde nicht mehr gibt.
  const s = series([[0, 500], [10, 400]]);  // 10/min
  const now = T0 + 40 * MIN;                // 30 min nach der letzten Messung
  assert.equal(predict(s, 0, now).quantity, 100, '400 minus 30 Minuten à 10');
});

test('mehr Vorrat als je gesehen sagt die App nicht vorher', () => {
  const s = series([[0, 100], [30, 400], [60, 100], [90, 400]]);
  const p = predict(s, 600, T0 + 90 * MIN);
  assert.ok(p.quantity <= 400, `${p.quantity} liegt ueber dem groessten gesehenen Bestand`);
});

test('Zuversicht steigt erst mit Messungen und beobachtetem Nachschub', () => {
  const duenn = predict(series([[0, 100], [10, 90]]), 10, T0 + 10 * MIN);
  assert.equal(duenn.confidence, 'grob');

  const dicht = series([[0, 100], [10, 80], [20, 60], [25, 300], [35, 260], [45, 220], [50, 300]]);
  const gut = predict(dicht, 10, T0 + 50 * MIN);
  assert.equal(gut.confidence, 'brauchbar');

  // Alte Daten sind keine Grundlage mehr, egal wie viele es sind.
  assert.equal(predict(dicht, 10, T0 + 50 * MIN + 5 * 3600e3).confidence, 'grob');
});

test('Beobachtungen werden gesammelt, nicht geflutet', () => {
  let store = {};
  const items = [{ itemId: 260, quantity: 100 }];
  store = recordSnapshot(store, 'mex', items, T0);
  store = recordSnapshot(store, 'mex', items, T0 + 30_000);
  assert.equal(seriesFor(store, 'mex', 260).length, 1, 'eine halbe Minute spaeter sagt nichts Neues');

  store = recordSnapshot(store, 'mex', [{ itemId: 260, quantity: 90 }], T0 + 2 * MIN);
  assert.equal(seriesFor(store, 'mex', 260).length, 2, 'eine geaenderte Menge schon');

  // Unveraenderte Menge nach laengerer Zeit ist ebenfalls eine Aussage.
  store = recordSnapshot(store, 'mex', [{ itemId: 260, quantity: 90 }], T0 + 20 * MIN);
  assert.equal(seriesFor(store, 'mex', 260).length, 3);
});

test('Laender und Items bleiben getrennt', () => {
  let store = {};
  store = recordSnapshot(store, 'mex', [{ itemId: 260, quantity: 100 }], T0);
  store = recordSnapshot(store, 'can', [{ itemId: 260, quantity: 7 }], T0);
  assert.equal(seriesFor(store, 'mex', 260)[0][1], 100);
  assert.equal(seriesFor(store, 'can', 260)[0][1], 7);
});

test('die Reihe waechst nicht unbegrenzt', () => {
  let store = {};
  for (let i = 0; i < MAX_SAMPLES + 15; i++) {
    store = recordSnapshot(store, 'mex', [{ itemId: 1, quantity: 500 - i }], T0 + i * 2 * MIN);
  }
  const s = seriesFor(store, 'mex', 1);
  assert.equal(s.length, MAX_SAMPLES);
  assert.equal(s[s.length - 1][1], 500 - (MAX_SAMPLES + 14), 'die juengste bleibt');
});

test('unbrauchbare Mengen landen nicht in der Reihe', () => {
  const store = recordSnapshot({}, 'mex', [
    { itemId: 1, quantity: null },
    { itemId: 2, quantity: 5 },
    { itemId: NaN, quantity: 5 },
  ], T0);
  assert.deepEqual(Object.keys(store), ['mex:2']);
});

test('kaputter Speicher ergibt eine leere Sammlung', () => {
  globalThis.localStorage = fakeStorage();
  globalThis.localStorage.setItem('tbf.travelstock.v1', '[]');
  assert.deepEqual(loadStock(), {}, 'ein Array ist nicht die erwartete Form');
  globalThis.localStorage.setItem('tbf.travelstock.v1', 'kein json');
  assert.deepEqual(loadStock(), {});
  saveStock({ 'mex:1': [[T0, 5]] });
  assert.deepEqual(loadStock(), { 'mex:1': [[T0, 5]] });
});
