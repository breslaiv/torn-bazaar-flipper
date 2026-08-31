import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluate, passesFilters, buildRows, topItemIdsForVerification } from '../js/profit.js';

const baseSettings = {
  priceSource: 'market_value',
  sellFactor: 100,
  marketFeePct: 0,
  budget: 0,
  minProfitAbs: 0,
  minProfitPct: 0,
  maxBuyPrice: 0,
};

const xanax = { id: 206, name: 'Xanax', type: 'Drug', marketValue: 800000 };

test('Profit ohne Faktor und Gebuehr', () => {
  const row = evaluate({ itemId: 206, price: 700000, quantity: 4 }, xanax, baseSettings);
  assert.equal(row.profitPerUnit, 100000);
  assert.ok(Math.abs(row.profitPct - 14.2857) < 0.001);
  assert.equal(row.totalProfit, 400000);
  assert.equal(row.referenceSource, 'market_value');
});

test('Verkaufsfaktor und Gebuehr wirken multiplikativ', () => {
  const settings = { ...baseSettings, sellFactor: 90, marketFeePct: 10 };
  const row = evaluate({ itemId: 206, price: 500000, quantity: 1 }, xanax, settings);
  // 800000 * 0.9 * 0.9 = 648000
  assert.equal(row.sellNet, 648000);
  assert.equal(row.profitPerUnit, 148000);
});

test('Budget deckelt die Stueckzahl', () => {
  const settings = { ...baseSettings, budget: 1500000 };
  const row = evaluate({ itemId: 206, price: 700000, quantity: 10 }, xanax, settings);
  assert.equal(row.units, 2);
  assert.equal(row.totalProfit, 200000);
});

test('ohne Budget zaehlt die volle Menge', () => {
  const row = evaluate({ itemId: 206, price: 700000, quantity: 10 }, xanax, baseSettings);
  assert.equal(row.units, 10);
  assert.equal(row.totalProfit, 1000000);
});

test('verifizierter Itemmarket-Preis schlaegt market_value', () => {
  const row = evaluate({ itemId: 206, price: 700000, quantity: 1 }, xanax, baseSettings, 750000);
  assert.equal(row.reference, 750000);
  assert.equal(row.profitPerUnit, 50000);
  assert.equal(row.verified, true);
});

test('absurd billige Listings werden markiert, nicht verworfen', () => {
  const row = evaluate({ itemId: 206, price: 1000, quantity: 1 }, xanax, baseSettings);
  assert.equal(row.suspicious, true);
  const normal = evaluate({ itemId: 206, price: 700000, quantity: 1 }, xanax, baseSettings);
  assert.equal(normal.suspicious, false);
});

test('unbekanntes Item ergibt keine Fantasie-Marge', () => {
  const row = evaluate({ itemId: 999, price: 5000, quantity: 1 }, undefined, baseSettings);
  assert.equal(row.reference, 0);
  assert.equal(row.profitPerUnit, -5000);
  assert.equal(row.itemName, 'Item 999');
});

test('Filter greifen auf allen drei Achsen', () => {
  const row = evaluate({ itemId: 206, price: 700000, quantity: 1 }, xanax, baseSettings);
  assert.equal(passesFilters(row, { ...baseSettings, minProfitAbs: 200000 }), false);
  assert.equal(passesFilters(row, { ...baseSettings, minProfitPct: 20 }), false);
  assert.equal(passesFilters(row, { ...baseSettings, maxBuyPrice: 500000 }), false);
  assert.equal(passesFilters(row, { ...baseSettings, minProfitAbs: 50000, minProfitPct: 10 }), true);
});

test('buildRows sortiert nach Gesamtprofit', () => {
  const items = new Map([
    [206, xanax],
    [207, { id: 207, name: 'Erotic DVD', marketValue: 5000 }],
  ]);
  const listings = [
    { itemId: 207, price: 3000, quantity: 100 }, // 200000 gesamt
    { itemId: 206, price: 700000, quantity: 1 }, // 100000 gesamt
  ];
  const rows = buildRows(listings, items, baseSettings);
  assert.deepEqual(rows.map((r) => r.itemId), [207, 206]);
});

test('buildRows wirft Verlustzeilen per Filter raus', () => {
  const items = new Map([[206, xanax]]);
  const rows = buildRows(
    [{ itemId: 206, price: 900000, quantity: 1 }],
    items,
    { ...baseSettings, minProfitAbs: 1 },
  );
  assert.equal(rows.length, 0);
});

test('topItemIdsForVerification dedupliziert und deckelt', () => {
  const rows = [{ itemId: 1 }, { itemId: 1 }, { itemId: 2 }, { itemId: 3 }];
  assert.deepEqual(topItemIdsForVerification(rows, 2), [1, 2]);
  assert.deepEqual(topItemIdsForVerification(rows, 10), [1, 2, 3]);
});
