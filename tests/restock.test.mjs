import test from 'node:test';
import assert from 'node:assert/strict';
import {
  findCycles, estimateTimer, estimateCapacity, simulate, nextRestock,
} from '../js/restock.js';

const MIN = 60000;
const T0 = 1_700_000_000_000;
const series = (pairs) => pairs.map(([m, q]) => [T0 + m * MIN, q]);
const at = (m) => T0 + m * MIN;
const inMinutes = (ts) => (ts - T0) / MIN;

test('ein Zyklus ist die Null-Strecke zwischen Ware und Ware', () => {
  // 40 → leer → leer → wieder voll: der Ausverkauf liegt zwischen Minute 20
  // und 30, der Nachschub zwischen 50 und 60.
  const [zyklus] = findCycles(series([[10, 80], [20, 40], [30, 0], [50, 0], [60, 200]]));

  assert.equal(inMinutes(zyklus.selloutFrom), 20, 'zuletzt war noch Ware da');
  assert.equal(inMinutes(zyklus.selloutTo), 30, 'dann war es leer');
  assert.equal(inMinutes(zyklus.restockFrom), 50, 'noch leer');
  assert.equal(inMinutes(zyklus.restockTo), 60, 'wieder Ware');
  assert.equal(zyklus.amount, 200);
  assert.equal(zyklus.open, false);
});

test('ein laufender Zyklus wird als solcher erkannt', () => {
  // Das Regal ist gerade leer und der Timer laeuft - die wichtigste Lage
  // ueberhaupt, denn genau darauf wartet man.
  const [zyklus] = findCycles(series([[10, 40], [20, 0], [30, 0]]));
  assert.equal(zyklus.open, true);
  assert.equal(zyklus.restockFrom, null);
  assert.equal(inMinutes(zyklus.selloutTo), 20);
});

test('mehrere Zyklen werden getrennt gehalten', () => {
  const zyklen = findCycles(series([
    [0, 50], [10, 0], [20, 200], [30, 60], [40, 0], [55, 180],
  ]));
  assert.equal(zyklen.length, 2);
  assert.equal(zyklen[0].amount, 200);
  assert.equal(zyklen[1].amount, 180);
});

test('ohne beobachtete Null gibt es keinen Zyklus', () => {
  assert.deepEqual(findCycles(series([[0, 50], [10, 30], [20, 10]])), []);
});

// ---------- Der Timer ----------

test('jeder Zyklus grenzt den Timer von zwei Seiten ein', () => {
  // Ausverkauf zwischen 20 und 30, Nachschub zwischen 50 und 60. Der Timer
  // liegt also zwischen 20 (50−30) und 40 (60−20) Minuten.
  const timer = estimateTimer(findCycles(series([[20, 40], [30, 0], [50, 0], [60, 200]])));
  assert.equal(timer.low, 20);
  assert.equal(timer.high, 40);
  assert.equal(timer.minutes, 30);
  assert.equal(timer.cycles, 1);
});

test('mehrere Zyklen verengen den Timer, ohne dass ein Zeitpunkt bekannt waere', () => {
  // Das ist der Kern: niemand sieht je den genauen Moment, und trotzdem wird
  // die Schaetzung mit jedem Zyklus enger.
  const weit = estimateTimer(findCycles(series([
    [0, 40], [30, 0], [90, 0], [120, 200],
  ])));
  const eng = estimateTimer(findCycles(series([
    [0, 40], [30, 0], [90, 0], [120, 200],       // Timer in [60, 120]
    [130, 40], [150, 0], [200, 0], [210, 200],   // Timer in [50, 90]
    [220, 40], [240, 0], [285, 0], [295, 200],   // Timer in [45, 75]
  ])));

  assert.equal(weit.high - weit.low, 60);
  assert.ok(eng.high - eng.low < weit.high - weit.low, 'mehr Zyklen, engerer Timer');
  assert.equal(eng.method, 'schnitt');
  assert.equal(eng.low, 60, 'die schaerfste Untergrenze aller Zyklen');
  assert.equal(eng.high, 75, 'die schaerfste Obergrenze');
  assert.equal(eng.cycles, 3);
});

test('widerspruechliche Zyklen werden nicht zu einem falschen Schnitt gezwungen', () => {
  // Ein Timer von 30 und einer von 300 Minuten koennen nicht beide stimmen.
  // Dann lieber der Median mit offener Spanne als eine Zahl, die keine
  // Beobachtung stuetzt.
  const timer = estimateTimer(findCycles(series([
    [0, 40], [10, 0], [40, 0], [45, 200],
    [50, 40], [60, 0], [350, 0], [360, 200],
  ])));
  assert.equal(timer.method, 'median');
  assert.ok(timer.low < timer.minutes && timer.minutes < timer.high);
});

test('ein laufender Zyklus zaehlt nicht fuer die Schaetzung', () => {
  // Solange der Nachschub nicht gesehen wurde, sagt er nichts ueber die Dauer.
  assert.equal(estimateTimer(findCycles(series([[0, 40], [10, 0], [30, 0]]))), null);
});

test('die Regalgroesse ist das je gesehene Maximum', () => {
  const s = series([[0, 40], [10, 0], [20, 200], [30, 150]]);
  assert.equal(estimateCapacity(s, findCycles(s)), 200);
  assert.equal(estimateCapacity([], []), null);
});

// ---------- Vorwaertsrechnung ----------

test('leeres Regal: der Nachschub kommt nach Ablauf des Timers', () => {
  const lauf = simulate({
    quantity: 0,
    from: at(0),
    drainPerMinute: 2,
    timerMinutes: 60,
    capacity: 200,
    lastSelloutAt: at(-10),   // vor zehn Minuten ausverkauft
  }, at(60));

  assert.equal(lauf.restocks.length, 1);
  assert.equal(inMinutes(lauf.restocks[0]), 50, 'zehn Minuten waren schon um');
  assert.equal(lauf.quantity, 200 - 2 * 10, 'danach laeuft es wieder ab');
});

test('volles Regal: erst leer, dann Timer, dann voll', () => {
  // 100 Stueck bei 5/min sind in 20 Minuten weg, plus 60 Minuten Timer:
  // der Nachschub faellt auf Minute 80.
  const lauf = simulate({
    quantity: 100, from: at(0), drainPerMinute: 5, timerMinutes: 60, capacity: 300,
  }, at(90));

  assert.equal(inMinutes(lauf.selloutAt), 20);
  assert.deepEqual(lauf.restocks.map(inMinutes), [80]);
  assert.equal(lauf.quantity, 300 - 5 * 10);
});

test('ueber einen langen Flug faellt mehr als ein Nachschub an', () => {
  const lauf = simulate({
    quantity: 0, from: at(0), drainPerMinute: 10, timerMinutes: 60, capacity: 300,
    lastSelloutAt: at(0),
  }, at(400));
  assert.ok(lauf.restocks.length >= 2, `nur ${lauf.restocks.length} Nachschuebe`);
});

test('ohne Timer wird nicht ueber die Null hinaus geraten', () => {
  // Die Ware ist weg, und wann sie wiederkommt, ist unbekannt. Dann bleibt es
  // bei null, statt einen Nachschub zu erfinden.
  const lauf = simulate({
    quantity: 50, from: at(0), drainPerMinute: 5, timerMinutes: null, capacity: 300,
  }, at(600));
  assert.equal(lauf.quantity, 0);
  assert.deepEqual(lauf.restocks, []);
});

test('ohne Abverkauf bleibt der Bestand stehen', () => {
  const lauf = simulate({
    quantity: 80, from: at(0), drainPerMinute: 0, timerMinutes: 60, capacity: 300,
  }, at(600));
  assert.equal(lauf.quantity, 80);
});

// ---------- Der naechste Nachschub ----------

test('bei leerem Regal steht der Zeitpunkt fest', () => {
  const timer = { minutes: 60, low: 55, high: 65 };
  const r = nextRestock({
    quantity: 0, at: at(0), drainPerMinute: 3, timer, lastSelloutAt: at(-20),
  }, at(0));

  assert.equal(r.waiting, true);
  assert.equal(inMinutes(r.at), 40, '20 Minuten des Timers sind um');
  assert.equal(inMinutes(r.from), 35);
  assert.equal(inMinutes(r.to), 45);
});

test('bei vollem Regal kommt die Unsicherheit des Ausverkaufs dazu', () => {
  const timer = { minutes: 60, low: 55, high: 65 };
  const r = nextRestock({
    quantity: 60, at: at(0), drainPerMinute: 3, timer, lastSelloutAt: null,
  }, at(0));

  assert.equal(r.waiting, false);
  assert.equal(inMinutes(r.at), 80, '20 Minuten bis leer, dann 60 Timer');
  assert.ok(r.to - r.from > 0);
});

test('ohne Timer oder ohne Abverkauf gibt es keinen Zeitpunkt', () => {
  assert.equal(nextRestock({ quantity: 0, at: at(0), drainPerMinute: 3, timer: null }), null);
  assert.equal(nextRestock({
    quantity: 50, at: at(0), drainPerMinute: 0, timer: { minutes: 60, low: 55, high: 65 },
  }), null, 'ohne Abverkauf ist kein Ausverkauf absehbar');
});
