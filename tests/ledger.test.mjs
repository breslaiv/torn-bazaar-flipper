import test from 'node:test';
import assert from 'node:assert/strict';
import {
  makeEvent, isValidEvent, dedupe, matchFifo, summarise, filterByPeriod, profitByItem,
} from '../js/ledger.js';

const DAY = 86400000;
const T0 = 1700000000000;

const buy = (ts, qty, price, extra = {}) => makeEvent({
  id: `b${ts}-${qty}`, ts, kind: 'buy', itemId: 206, itemName: 'Xanax', quantity: qty, unitPrice: price, ...extra,
});
const sell = (ts, qty, price, extra = {}) => makeEvent({
  id: `s${ts}-${qty}`, ts, kind: 'sell', itemId: 206, itemName: 'Xanax', quantity: qty, unitPrice: price, ...extra,
});

test('ein Kauf ohne Verkauf ist eine offene Position', () => {
  const { sales, openLots } = matchFifo([buy(T0, 4, 700000)]);
  assert.equal(sales.length, 0);
  assert.equal(openLots.length, 1);
  assert.equal(openLots[0].remaining, 4);
  assert.equal(openLots[0].cost, 2800000);
});

test('ein glatter Kauf-Verkauf ergibt den erwarteten Profit', () => {
  const { sales, openLots } = matchFifo([buy(T0, 4, 700000), sell(T0 + DAY, 4, 780000)]);
  assert.equal(openLots.length, 0);
  assert.equal(sales.length, 1);
  assert.equal(sales[0].cost, 2800000);
  assert.equal(sales[0].proceeds, 3120000);
  assert.equal(sales[0].profit, 320000);
  assert.ok(Math.abs(sales[0].margin - 11.4286) < 0.001);
});

test('ein Teilverkauf laesst den Rest im Bestand', () => {
  const { sales, openLots } = matchFifo([buy(T0, 10, 100), sell(T0 + DAY, 4, 150)]);
  assert.equal(sales[0].cost, 400);
  assert.equal(sales[0].profit, 200);
  assert.equal(openLots[0].remaining, 6);
  assert.equal(openLots[0].cost, 600);
});

test('ein Verkauf zieht sich nach FIFO aus mehreren Kaeufen', () => {
  // 5 Stueck zu 100, danach 5 zu 200; verkauft werden 8 zu 300.
  const { sales, openLots } = matchFifo([
    buy(T0, 5, 100),
    buy(T0 + DAY, 5, 200),
    sell(T0 + 2 * DAY, 8, 300),
  ]);
  // Einstand: 5x100 + 3x200 = 1100
  assert.equal(sales[0].cost, 1100);
  assert.equal(sales[0].proceeds, 2400);
  assert.equal(sales[0].profit, 1300);
  assert.deepEqual(sales[0].consumed.map((c) => c.quantity), [5, 3]);
  assert.equal(openLots.length, 1);
  assert.equal(openLots[0].remaining, 2);
});

test('der aeltere Kauf wird zuerst verbraucht, auch bei hoeherem Preis', () => {
  const { sales } = matchFifo([buy(T0, 1, 900), buy(T0 + DAY, 1, 100), sell(T0 + 2 * DAY, 1, 1000)]);
  assert.equal(sales[0].cost, 900, 'FIFO, nicht der guenstigste Einstand');
});

test('ein Verkauf ohne Deckung zaehlt nur den gedeckten Teil', () => {
  // Ware von ausserhalb des Ledgers: 2 gekauft, 5 verkauft.
  const { sales } = matchFifo([buy(T0, 2, 100), sell(T0 + DAY, 5, 300)]);
  assert.equal(sales[0].coveredQuantity, 2);
  assert.equal(sales[0].uncoveredQuantity, 3);
  assert.equal(sales[0].cost, 200);
  assert.equal(sales[0].proceeds, 600, 'nur die gedeckten 2 Stueck');
  assert.equal(sales[0].profit, 400, 'die ungedeckten 3 waeren sonst reiner Fantasiegewinn');
});

test('ein Kauf nach dem Verkauf deckt ihn nicht', () => {
  const { sales, openLots } = matchFifo([sell(T0 + DAY, 1, 300), buy(T0 + 2 * DAY, 1, 100)]);
  assert.equal(sales[0].uncoveredQuantity, 1);
  assert.equal(sales[0].profit, 0);
  assert.equal(openLots[0].remaining, 1);
});

test('verschiedene Items werden getrennt abgerechnet', () => {
  const events = [
    buy(T0, 1, 100),
    sell(T0 + DAY, 1, 150),
    makeEvent({ id: 'b2', ts: T0, kind: 'buy', itemId: 4, itemName: 'Apple', quantity: 10, unitPrice: 5 }),
    makeEvent({ id: 's2', ts: T0 + DAY, kind: 'sell', itemId: 4, itemName: 'Apple', quantity: 10, unitPrice: 9 }),
  ];
  const { sales } = matchFifo(events);
  assert.equal(sales.length, 2);
  const byItem = Object.fromEntries(sales.map((s) => [s.sale.itemId, s.profit]));
  assert.equal(byItem[206], 50);
  assert.equal(byItem[4], 40);
});

test('die Reihenfolge der Eingabe aendert das Ergebnis nicht', () => {
  const events = [buy(T0, 5, 100), buy(T0 + DAY, 5, 200), sell(T0 + 2 * DAY, 8, 300)];
  const forward = matchFifo(events);
  const shuffled = matchFifo([events[2], events[1], events[0]]);
  assert.equal(forward.sales[0].profit, shuffled.sales[0].profit);
  assert.equal(forward.openLots[0].remaining, shuffled.openLots[0].remaining);
});

test('summarise fasst realisiert und offen getrennt zusammen', () => {
  const matched = matchFifo([
    buy(T0, 10, 100),
    sell(T0 + DAY, 4, 150),
    makeEvent({ id: 'b9', ts: T0, kind: 'buy', itemId: 9, itemName: 'X', quantity: 2, unitPrice: 500 }),
  ]);
  const s = summarise(matched);
  assert.equal(s.realizedProfit, 200);
  assert.equal(s.realizedCost, 400);
  assert.equal(s.proceeds, 600);
  assert.equal(s.salesCount, 1);
  assert.equal(s.openUnits, 6 + 2);
  assert.equal(s.openCost, 600 + 1000);
  assert.equal(s.openCount, 2);
  assert.equal(s.uncoveredUnits, 0);
});

test('summarise vertraegt einen leeren Ledger', () => {
  const s = summarise(matchFifo([]));
  assert.equal(s.realizedProfit, 0);
  assert.equal(s.openUnits, 0);
  assert.equal(s.margin, null);
});

test('ein Verlust wird als solcher ausgewiesen', () => {
  const { sales } = matchFifo([buy(T0, 1, 1000), sell(T0 + DAY, 1, 600)]);
  assert.equal(sales[0].profit, -400);
  assert.equal(sales[0].margin, -40);
});

test('dedupe erkennt denselben Log-Eintrag wieder', () => {
  const a = makeEvent({ id: 'x1', ts: T0, kind: 'buy', itemId: 1, quantity: 1, unitPrice: 1, source: 'torn-log', ref: 'L42' });
  const b = makeEvent({ id: 'x2', ts: T0, kind: 'buy', itemId: 1, quantity: 1, unitPrice: 1, source: 'torn-log', ref: 'L42' });
  assert.equal(dedupe([a, b]).length, 1);
});

test('dedupe verschont manuelle Eintraege ohne Referenz', () => {
  const a = makeEvent({ ts: T0, kind: 'buy', itemId: 1, quantity: 1, unitPrice: 1 });
  const b = makeEvent({ ts: T0, kind: 'buy', itemId: 1, quantity: 1, unitPrice: 1 });
  assert.equal(dedupe([a, b]).length, 2, 'zweimal dasselbe gekauft ist erlaubt');
});

test('dieselbe Referenz aus verschiedenen Quellen bleibt bestehen', () => {
  const a = makeEvent({ ts: T0, kind: 'buy', itemId: 1, quantity: 1, unitPrice: 1, source: 'torn-log', ref: '7' });
  const b = makeEvent({ ts: T0, kind: 'buy', itemId: 1, quantity: 1, unitPrice: 1, source: 'manual', ref: '7' });
  assert.equal(dedupe([a, b]).length, 2);
});

test('isValidEvent weist unbrauchbare Zeilen ab', () => {
  assert.equal(isValidEvent(buy(T0, 1, 100)), true);
  assert.equal(isValidEvent(buy(T0, 0, 100)), false, 'Menge 0');
  assert.equal(isValidEvent(buy(T0, -1, 100)), false);
  assert.equal(isValidEvent({ ...buy(T0, 1, 100), kind: 'schenken' }), false);
  assert.equal(isValidEvent({ ...buy(T0, 1, 100), ts: NaN }), false);
  assert.equal(isValidEvent(null), false);
  assert.equal(isValidEvent(makeEvent({ ts: T0, kind: 'buy', itemId: 1, quantity: 1, unitPrice: 0 })), true,
    'ein $1-Bazaar-Fund darf 0 kosten');
});

test('filterByPeriod schneidet nach Tagen ab', () => {
  const now = T0 + 30 * DAY;
  const events = [buy(T0, 1, 1), buy(now - 3 * DAY, 1, 1), buy(now - 1 * DAY, 1, 1)];
  assert.equal(filterByPeriod(events, 7, now).length, 2);
  assert.equal(filterByPeriod(events, 60, now).length, 3);
  assert.equal(filterByPeriod(events, 0, now).length, 3, '0 = kein Filter');
});

test('profitByItem summiert je Item und sortiert nach Profit', () => {
  const matched = matchFifo([
    buy(T0, 1, 100), sell(T0 + DAY, 1, 150),
    makeEvent({ id: 'b4', ts: T0, kind: 'buy', itemId: 4, itemName: 'Apple', quantity: 10, unitPrice: 5 }),
    makeEvent({ id: 's4', ts: T0 + DAY, kind: 'sell', itemId: 4, itemName: 'Apple', quantity: 10, unitPrice: 100 }),
  ]);
  const rows = profitByItem(matched.sales);
  assert.deepEqual(rows.map((r) => r.itemName), ['Apple', 'Xanax']);
  assert.equal(rows[0].profit, 950);
  assert.equal(rows[0].units, 10);
  assert.equal(rows[1].profit, 50);
});
