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
  recordSnapshot, estimate, predict, predictRange, chanceAtLeast, backtest,
  weightAt, weightedQuantile, seriesFor, loadStock, saveStock,
  MAX_SAMPLES, HALF_LIFE_MINUTES,
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

test('brauchbar wird eine Vorhersage erst durch bestandene Kontrollen', () => {
  // Zwei Messungen ergeben eine Zahl, aber keine Grundlage, ihr zu trauen.
  assert.equal(predict(series([[0, 100], [10, 90]]), 10, T0 + 10 * MIN).confidence, 'grob');

  const gleichmaessig = series(Array.from({ length: 8 }, (_, i) => [i * 10, 500 - i * 20]));
  const gut = predict(gleichmaessig, 10, T0 + 70 * MIN);
  assert.equal(gut.confidence, 'brauchbar');
  assert.ok(gut.accuracy.coverage >= 0.5);

  // Alte Daten sind keine Grundlage mehr, egal wie gut das Modell passte.
  assert.equal(predict(gleichmaessig, 10, T0 + 70 * MIN + 5 * 3600e3).confidence, 'grob');
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

// ---------- Gewichtung ----------

test('juengere Messungen wiegen mehr, aeltere verlieren nach Halbwertszeit', () => {
  const now = T0 + 100 * MIN;
  assert.equal(weightAt(now, now), 1);
  assert.ok(Math.abs(weightAt(now - HALF_LIFE_MINUTES * MIN, now) - 0.5) < 1e-12);
  assert.ok(weightAt(now - 2 * HALF_LIFE_MINUTES * MIN, now) < 0.26);
});

test('eine alte Reihe wird alt gewichtet, nicht auf null', () => {
  // Der Fehler, den die Umstellung behoben hat: gegen die Uhr gemessen fiel
  // bei einer Reihe von gestern jedes Gewicht auf null - und die Schaetzung
  // war leer statt alt.
  const gestern = series([[0, 100], [10, 80], [20, 60]]);
  const e = estimate(gestern, T0 + 3 * 24 * 60 * MIN);
  assert.equal(e.drainPerMinute, 2, 'die Reihe sagt weiterhin 2/min');
});

test('das gewichtete Quantil folgt den Gewichten, nicht der Anzahl', () => {
  // Fuenf alte Messungen mit Tempo 1 gegen eine frische mit Tempo 10:
  // ungewichtet gewaenne die Mehrheit, gewichtet zaehlt die Gegenwart mit.
  const samples = [
    ...Array.from({ length: 5 }, () => ({ value: 1, weight: 0.05 })),
    { value: 10, weight: 1 },
  ];
  assert.equal(weightedQuantile(samples, 0.5), 10);
  assert.equal(weightedQuantile([], 0.5), null);
  assert.equal(weightedQuantile([{ value: 5, weight: 0 }], 0.5), null, 'gewichtslos ist keine Aussage');
});

test('das Tempo von heute schlaegt das von vorgestern', () => {
  // Abends leert sich das Regal schneller als nachts. Ein Median ueber alles
  // ergaebe eine Zahl, die zu keiner Tageszeit stimmt.
  const langsamDannSchnell = series([
    [0, 500], [60, 490], [120, 480], [180, 470],   // 1/6 pro Minute
    [1200, 400], [1260, 340], [1320, 280],          // 1/min, zuletzt
  ]);
  const e = estimate(langsamDannSchnell, T0 + 1320 * MIN);
  assert.ok(e.drainPerMinute > 0.5, `zu traege gewichtet: ${e.drainPerMinute}`);
});

// ---------- Bereich und Wahrscheinlichkeit ----------

test('der Bereich spannt langsamen gegen schnellen Abverkauf', () => {
  // Mal 1/min, mal 7/min: der Bereich muss beide Tempi umfassen. Dass die
  // mittlere Zahl dabei auf einem Rand liegen kann, ist kein Fehler - bei
  // zwei gleich haeufigen Tempi gibt es keine Mitte dazwischen.
  const s = series([[0, 500], [10, 490], [20, 420], [30, 410], [40, 340]]);
  const p = predictRange(s, 30, T0 + 40 * MIN);
  assert.ok(p.low <= p.quantity && p.quantity <= p.high, `${p.low} ≤ ${p.quantity} ≤ ${p.high}`);
  assert.ok(p.high - p.low >= 100, 'zwei so verschiedene Tempi muessen einen Bereich ergeben');
  assert.equal(p.low, 130, 'schnellstes Tempo: 340 minus 30 Minuten à 7');
  assert.equal(p.high, 310, 'langsamstes: 340 minus 30 Minuten à 1');
});

test('ohne Beobachtung gibt es weder Zahl noch Bereich', () => {
  const p = predict(series([[0, 100]]), 60, T0);
  assert.equal(p.quantity, null);
  assert.equal(p.low, null);
  assert.equal(p.confidence, 'unbekannt');
  assert.equal(chanceAtLeast(series([[0, 100]]), 5, 60, T0), null);
});

test('die Chance auf die eigene Kapazitaet ist die eigentliche Auskunft', () => {
  // Gleichmaessiger Abverkauf: was rechnerisch reicht, reicht in allen
  // beobachteten Szenarien - und was nicht reicht, in keinem.
  const s = series([[0, 100], [10, 90], [20, 80], [30, 70]]);
  const now = T0 + 30 * MIN;
  assert.equal(chanceAtLeast(s, 5, 10, now), 1, '60 Stueck erwartet, 5 gesucht');
  assert.equal(chanceAtLeast(s, 80, 10, now), 0, 'so viel wird es sicher nicht');
});

test('uneinheitliches Tempo ergibt eine Chance zwischen 0 und 1', () => {
  // Mal 1/min, mal 9/min: ob 40 Stueck reichen, haengt am Tempo - und genau
  // das soll die Zahl sagen, statt sich auf eines festzulegen.
  const s = series([[0, 100], [10, 90], [20, 10], [30, 100], [40, 90]]);
  const chance = chanceAtLeast(s, 40, 10, T0 + 40 * MIN);
  assert.ok(chance > 0 && chance < 1, `${chance} sollte dazwischen liegen`);
});

// ---------- Selbstkontrolle ----------

test('backtest sagt aus der Vergangenheit die Gegenwart vorher', () => {
  // Eine perfekt gleichmaessige Reihe muss die App fehlerfrei treffen -
  // sonst stimmt etwas an der Rechnung nicht.
  const gleichmaessig = series(Array.from({ length: 8 }, (_, i) => [i * 10, 500 - i * 20]));
  const a = backtest(gleichmaessig);
  assert.equal(a.checks, 6);
  assert.equal(a.medianAbsError, 0);
  assert.equal(a.coverage, 1);
});

test('ein einzelner Einbruch zeigt sich im groessten Fehler', () => {
  // Der Median bleibt klein - das ist sein Sinn. Aufdecken muss ihn deshalb
  // der schlechteste Fall, und der wird mitgefuehrt.
  const einbruch = series([[0, 500], [10, 480], [20, 460], [30, 10], [40, 5]]);
  const a = backtest(einbruch);
  assert.ok(a.checks >= 2);
  assert.ok(a.worstAbsError > 300, `groesster Fehler ${a.worstAbsError}`);
  assert.ok(a.coverage < 1, 'nicht jeder Wert lag im Bereich');
});

test('ein dauerhaft unberechenbares Regal ergibt einen grossen Median-Fehler', () => {
  // Hin und her ohne Muster: hier irrt das Modell nicht einmal, sondern
  // staendig - und dann darf die Guete das nicht verschweigen.
  const zickzack = series([[0, 400], [10, 20], [20, 380], [30, 30], [40, 390], [50, 25], [60, 400]]);
  const a = backtest(zickzack);
  assert.ok(a.medianAbsError > 100, `Median-Fehler ${a.medianAbsError}`);
  assert.equal(predict(zickzack, 10, T0 + 60 * MIN).confidence, 'grob');
});

test('unter drei Messungen gibt es nichts zu pruefen', () => {
  assert.equal(backtest(series([[0, 100], [10, 90]])).checks, 0);
  assert.equal(backtest([]).checks, 0);
});

test('die Guete kommt aus der Selbstkontrolle, sobald es sie gibt', () => {
  const gleichmaessig = series(Array.from({ length: 8 }, (_, i) => [i * 10, 500 - i * 20]));
  const gut = predict(gleichmaessig, 10, T0 + 70 * MIN);
  assert.equal(gut.confidence, 'brauchbar');
  assert.ok(gut.accuracy.checks >= 3);
  assert.match(gut.why, /Selbstkontrollen/);

  const ruckartig = series([[0, 500], [10, 480], [20, 460], [30, 10], [40, 400], [50, 20], [60, 380]]);
  const schlecht = predict(ruckartig, 10, T0 + 60 * MIN);
  assert.equal(schlecht.confidence, 'grob', 'wer sich oft irrt, sagt das auch');
});

test('ein gemessener Fehler weitet den Bereich', () => {
  // Ein Bereich, den die eigene Vergangenheit widerlegt hat, waere
  // Scheingenauigkeit.
  const ruckartig = series([[0, 500], [10, 480], [20, 100], [30, 480], [40, 120], [50, 470]]);
  const p = predict(ruckartig, 20, T0 + 50 * MIN);
  const roh = predictRange(ruckartig, 20, T0 + 50 * MIN);
  assert.ok(p.high - p.low >= roh.high - roh.low, 'der Bereich darf nur breiter werden');
  assert.ok(p.low >= 0);
});

test('auch nach der Weitung bleibt der Bereich im Moeglichen', () => {
  const s = series([[0, 60], [10, 40], [20, 55], [30, 30], [40, 50]]);
  const p = predict(s, 15, T0 + 40 * MIN);
  assert.ok(p.low >= 0, 'kein negativer Vorrat');
  assert.ok(p.high <= 60, `${p.high} liegt ueber dem groessten gesehenen Bestand`);
});

test('ein Bereich, der nie traf, ist nicht brauchbar', () => {
  // Der Fall aus dem Browsertest: ein Saegezahn, bei dem der Median-Fehler
  // klein gegen die Menge bleibt, der angegebene Bereich den echten Wert aber
  // in keinem einzigen Fall enthielt. Das darf nicht "brauchbar" heissen.
  const saegezahn = series([
    [0, 400], [20, 280], [40, 340], [60, 400], [80, 280], [100, 340],
    [120, 400], [140, 280], [160, 340], [180, 400],
  ]);
  const a = backtest(saegezahn);
  assert.ok(a.checks >= 5);
  assert.ok(a.coverage < 0.5, `Trefferquote ${a.coverage} sollte niedrig sein`);
  assert.equal(predict(saegezahn, 20, T0 + 180 * MIN).confidence, 'grob');
});
