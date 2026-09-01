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
  recordSnapshot, estimate, predict, chanceAtLeast, backtest,
  evaluateModels, chooseModel, conformalInterval,
  weightAt, weightedQuantile, seriesFor, loadStock, saveStock, mergeStock,
  MAX_SAMPLES, MAX_HISTORY, BACKTEST_POINTS, BACKTEST_ORIGINS, HALF_LIFE_MINUTES, MIN_CHECKS,
} = await import('../js/travelStock.js');
const { MODELS, modelByKey, runModel } = await import('../js/travelModels.js');

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
  for (let i = 0; i < MAX_HISTORY + 15; i++) {
    store = recordSnapshot(store, 'mex', [{ itemId: 1, quantity: 500 - i }], T0 + i * 2 * MIN);
  }
  const s = seriesFor(store, 'mex', 1);
  assert.equal(s.length, MAX_HISTORY);
  assert.equal(s[s.length - 1][1], 500 - (MAX_HISTORY + 14), 'die juengste bleibt');
});

test('die Rechnung sieht mehr als der Browserspeicher behaelt', () => {
  // Der Kern der Trennung: gekuerzt wird nur beim Ablegen. Vorher bestimmte
  // die Groesse des localStorage, wie viel die Schaetzung sehen darf - und
  // damit sah sie bei wachsender Datenbank einen immer kleineren Ausschnitt.
  globalThis.localStorage = fakeStorage();

  const lang = Array.from({ length: MAX_SAMPLES + 60 }, (_, i) => [T0 + i * 2 * MIN, 500 - i]);
  const zurueck = saveStock({ 'mex:1': lang });

  assert.equal(zurueck['mex:1'].length, lang.length, 'zurueck kommt die volle Reihe');
  assert.equal(loadStock()['mex:1'].length, MAX_SAMPLES, 'abgelegt wird nur der Rest');
  assert.deepEqual(
    loadStock()['mex:1'][MAX_SAMPLES - 1],
    lang[lang.length - 1],
    'und zwar die juengsten Punkte',
  );
});

test('die Schaetzung sieht die ganze Reihe, die Bewertung nur ihr juengeres Ende', () => {
  // Der Handel, der lange Historie ueberhaupt erlaubt: Abverkauf, Zyklen und
  // Timer laufen linear und bekommen alles. Der Modellwettbewerb waechst
  // quadratisch und bekommt deshalb einen festen Ausschnitt - gemessen sonst
  // 140 s fuer eine Ansicht mit 227 Reihen statt 0,5 s.
  const lang = Array.from({ length: 400 }, (_, i) => [T0 + i * 5 * MIN, 300 - (i % 60) * 5]);

  assert.equal(estimate(lang).samples, 400, 'der Abverkauf sieht jeden Punkt');

  // Gleiches Ergebnis wie mit dem blossen Ausschnitt: mehr schaut die
  // Bewertung nicht an.
  assert.deepEqual(backtest(lang), backtest(lang.slice(-BACKTEST_POINTS)));
});

test('geprueft wird auf Flugfristen, nicht auf den naechsten Messpunkt', () => {
  // Der Fehler, den das behebt: geprueft wurde auf die naechsten drei
  // Messungen, also im Mittel 8 Minuten. Auf dieser Frist aendert sich ein
  // Regal in 86 % der Faelle nicht - "bleibt wie es ist" gewann damit 81 %
  // der Reihen mit Fehler 0,0, und kein besseres Verfahren konnte sich
  // zeigen. Entschieden wird aber auf Flugdauer, 26 bis 297 Minuten.
  const lang = series(Array.from({ length: 80 }, (_, i) => [i * 5, 400 - (i % 40) * 10]));
  const results = evaluateModels(lang);

  const fristen = [...results.values()].flatMap((r) => r.residuals.map((x) => x.horizon));
  assert.ok(fristen.length > 0, 'ohne Kontrollen ist die Bewertung wertlos');
  assert.ok(
    Math.min(...fristen) >= 24,
    `kuerzeste geprüfte Frist ${Math.min(...fristen)} min - unter der kuerzesten Flugzeit`,
  );
  assert.ok(Math.max(...fristen) >= 100, `laengste geprüfte Frist nur ${Math.max(...fristen)} min`);
});

test('eine zu kurze Reihe wird nicht geprueft statt scheinbar geprueft', () => {
  // Lieber "zu wenig Daten" als eine Guete, die auf einer Frist entstand,
  // auf der niemand fliegt.
  const kurz = series([[0, 100], [5, 90], [10, 80], [15, 70]]);
  const results = evaluateModels(kurz);
  const checks = [...results.values()].reduce((s, r) => s + r.residuals.length, 0);
  assert.equal(checks, 0, 'zwanzig Minuten Verlauf ergeben keine Flugfrist');
});

test('der Modellwettbewerb bleibt bei langen Reihen bezahlbar', () => {
  const lang = Array.from({ length: 400 }, (_, i) => [T0 + i * 5 * MIN, 300 - (i % 60) * 5]);
  const results = evaluateModels(lang.slice(-BACKTEST_POINTS));
  for (const r of results.values()) {
    // Je Pruefpunkt hoechstens drei Horizonte.
    assert.ok(
      r.residuals.length <= BACKTEST_ORIGINS * 3,
      `${r.key}: ${r.residuals.length} Pruefungen, mehr als ${BACKTEST_ORIGINS * 3}`,
    );
  }
});

test('zusammenfuehren wirft die Historie des Servers nicht weg', () => {
  // Der lokale Server liefert die Reihen aus SQLite - deutlich mehr als in den
  // Browserspeicher passt. Frueher schnitt mergeStock() sie auf 40 zurecht,
  // bevor irgendeine Schaetzung sie zu sehen bekam.
  const viele = Array.from({ length: 300 }, (_, i) => [T0 + i * 2 * MIN, 500 - i]);
  const merged = mergeStock({}, { 'mex:1': viele });
  assert.equal(merged['mex:1'].length, 300, 'nichts abgeschnitten');
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

test('der Bereich umschliesst die Vorhersage und bleibt im Moeglichen', () => {
  const s = series([[0, 500], [10, 490], [20, 420], [30, 410], [40, 340], [50, 330], [60, 260]]);
  const p = predict(s, 30, T0 + 60 * MIN);
  assert.ok(p.low <= p.quantity && p.quantity <= p.high, `${p.low} ≤ ${p.quantity} ≤ ${p.high}`);
  assert.ok(p.low >= 0);
  assert.ok(p.high <= 500, 'nie mehr als je gesehen');
});

test('ein unruhiges Regal bekommt einen breiteren Bereich als ein ruhiges', () => {
  // Genau das soll die Konformalprognose leisten: die Breite kommt aus den
  // eigenen Fehlern, also aus der Unruhe der Reihe selbst.
  const ruhig = series(Array.from({ length: 9 }, (_, i) => [i * 10, 400 - i * 20]));
  const unruhig = series([[0, 400], [10, 120], [20, 380], [30, 90], [40, 360], [50, 100], [60, 340], [70, 80], [80, 300]]);

  const a = predict(ruhig, 20, T0 + 80 * MIN);
  const b = predict(unruhig, 20, T0 + 80 * MIN);
  assert.ok((b.high - b.low) > (a.high - a.low),
    `unruhig ${b.high - b.low} sollte breiter sein als ruhig ${a.high - a.low}`);
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
  //
  // Die Reihe misst in Halbstundenschritten, nicht mehr in Zehnminuten: seit
  // die Bewertung auf Flugfristen ab 30 Minuten prueft, entsteht aus einer
  // Reihe ueber 70 Minuten keine einzige Kontrolle mehr.
  const s = series(Array.from({ length: 10 }, (_, i) => [i * 30, 400 - i * 10]));
  const now = T0 + 270 * MIN;
  assert.equal(chanceAtLeast(s, 5, 30, now), 1, 'reichlich vorhanden, 5 gesucht');
  assert.equal(chanceAtLeast(s, 900, 30, now), 0, 'so viel wird es sicher nicht');
});

test('uneinheitliches Tempo ergibt eine Chance zwischen 0 und 1', () => {
  // Mal langsam, mal schnell: ob 40 Stueck reichen, haengt am Tempo - und
  // genau das soll die Zahl sagen, statt sich auf eines festzulegen.
  const s = series([
    [0, 100], [30, 90], [60, 10], [90, 100], [120, 90], [150, 20], [180, 100], [210, 90],
  ]);
  const chance = chanceAtLeast(s, 40, 30, T0 + 210 * MIN);
  assert.ok(chance > 0 && chance < 1, `${chance} sollte dazwischen liegen`);
});

// ---------- Selbstkontrolle ----------

test('backtest sagt aus der Vergangenheit die Gegenwart vorher', () => {
  // Eine perfekt gleichmaessige Reihe muss die App fehlerfrei treffen -
  // sonst stimmt etwas an der Rechnung nicht.
  const gleichmaessig = series(Array.from({ length: 8 }, (_, i) => [i * 10, 500 - i * 20]));
  const a = backtest(gleichmaessig);
  assert.ok(a.checks >= 6, `nur ${a.checks} Kontrollen`);
  assert.equal(a.medianAbsError, 0);
  assert.equal(a.coverage, 1);
  assert.equal(a.model.key, 'drift', 'der einfachste Kandidat, der die Reihe erklaert');
});

test('ein einzelner Einbruch zeigt sich im groessten Fehler', () => {
  // Der Median bleibt klein - das ist sein Sinn. Aufdecken muss ihn deshalb
  // der schlechteste Fall, und der wird mitgefuehrt.
  const einbruch = series([
    [0, 500], [30, 480], [60, 460], [90, 440], [120, 10], [150, 8], [180, 6], [210, 5],
  ]);
  const a = backtest(einbruch);
  assert.ok(a.checks >= 2, `nur ${a.checks} Kontrollen`);
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
  assert.ok(gut.accuracy.checks >= MIN_CHECKS);
  assert.match(gut.why, /Selbstkontrollen/);

  const ruckartig = series([[0, 500], [10, 480], [20, 460], [30, 10], [40, 400], [50, 20], [60, 380]]);
  const schlecht = predict(ruckartig, 10, T0 + 60 * MIN);
  assert.equal(schlecht.confidence, 'grob', 'wer sich oft irrt, sagt das auch');
});

test('der Bereich haelt, was er verspricht', () => {
  // Konformalprognose: die Breite kommt aus der Verteilung der eigenen
  // Fehler, also muss der angegebene Bereich die Vergangenheit auch
  // ueberwiegend enthalten haben.
  const ruckartig = series([[0, 500], [10, 480], [20, 100], [30, 480], [40, 120], [50, 470], [60, 130], [70, 460]]);
  const p = predict(ruckartig, 20, T0 + 70 * MIN);
  assert.ok(p.accuracy.coverage >= 0.5, `Trefferquote ${p.accuracy.coverage}`);
  assert.ok(p.low >= 0);
});

test('auch nach der Weitung bleibt der Bereich im Moeglichen', () => {
  const s = series([[0, 60], [10, 40], [20, 55], [30, 30], [40, 50]]);
  const p = predict(s, 15, T0 + 40 * MIN);
  assert.ok(p.low >= 0, 'kein negativer Vorrat');
  assert.ok(p.high <= 60, `${p.high} liegt ueber dem groessten gesehenen Bestand`);
});

test('ein Bereich, der alles umfasst, ist keine Auskunft', () => {
  // Seit die Breite aus den eigenen Fehlern kommt, trifft der Bereich fast
  // immer - er wird eben breit. Ein Bereich von 0 bis 400 ist verlaesslich
  // und wertlos, also entscheidet die Breite mit ueber die Guete.
  const saegezahn = series([
    [0, 400], [20, 40], [40, 380], [60, 30], [80, 390],
    [100, 20], [120, 400], [140, 35], [160, 395],
  ]);
  const p = predict(saegezahn, 20, T0 + 160 * MIN);
  assert.ok(p.high - p.low > p.quantity * 0.5, `Bereich ${p.low}–${p.high} sollte breit sein`);
  assert.equal(p.confidence, 'grob');
});
