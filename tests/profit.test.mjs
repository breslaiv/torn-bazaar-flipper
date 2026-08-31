import test from 'node:test';
import assert from 'node:assert/strict';
import {
  prescreen, pickBuyer, minRating, buildFlipRows, buildDollarRows, passesFilters, sortByTotalProfit,
} from '../js/profit.js';

const base = {
  referenceMode: 'trader',
  sellFactor: 100,
  marketFeePct: 0,
  prescreenPct: 90,
  maxCandidates: 10,
  minBuyerRating: 0,
  minProfitAbs: 0,
  minProfitPct: 0,
  maxBuyPrice: 0,
  budget: 0,
};

const catalog = [
  { itemId: 1, itemName: 'Tief rabattiert', marketPrice: 1000000, lowestPrice: 600000, totalBazaars: 5 },
  { itemId: 2, itemName: 'Knapp drunter', marketPrice: 100000, lowestPrice: 89000, totalBazaars: 2 },
  { itemId: 3, itemName: 'Kein Rabatt', marketPrice: 100000, lowestPrice: 99000, totalBazaars: 2 },
  { itemId: 4, itemName: 'Kein Bazaar', marketPrice: 100000, lowestPrice: null, totalBazaars: 0 },
];

test('prescreen nimmt nur Items unter der Rabattschwelle', () => {
  const out = prescreen(catalog, base);
  assert.deepEqual(out.map((i) => i.itemId), [1, 2]);
});

test('prescreen sortiert nach absoluter Spanne und deckelt die Anzahl', () => {
  const out = prescreen(catalog, { ...base, maxCandidates: 1 });
  assert.equal(out.length, 1);
  assert.equal(out[0].itemId, 1);
  assert.equal(out[0].gap, 400000);
});

test('prescreen respektiert den maximalen Kaufpreis', () => {
  const out = prescreen(catalog, { ...base, maxBuyPrice: 100000 });
  assert.deepEqual(out.map((i) => i.itemId), [2]);
});

const TRADERS = [
  { playerId: 1, playerName: 'Teuer aber mies', price: 900, ratingScore: -5 },
  { playerId: 2, playerName: 'Solide', price: 800, ratingScore: 10 },
  { playerId: 3, playerName: 'Sehr gut', price: 700, ratingScore: 50 },
];

test('pickBuyer nimmt den hoechsten Preis oberhalb der Mindestbewertung', () => {
  assert.equal(pickBuyer(TRADERS, base).playerId, 2);
  assert.equal(pickBuyer([], base), null);
});

test('eine hoehere Mindestbewertung verschiebt die Wahl auf den besseren Kaeufer', () => {
  assert.equal(pickBuyer(TRADERS, { ...base, minBuyerRating: 20 }).playerId, 3);
  assert.equal(pickBuyer(TRADERS, { ...base, minBuyerRating: 50 }).playerId, 3);
  assert.equal(pickBuyer(TRADERS, { ...base, minBuyerRating: 51 }), null);
});

test('ein negativer Wert laesst auch schlecht bewertete Kaeufer zu', () => {
  assert.equal(pickBuyer(TRADERS, { ...base, minBuyerRating: -10 }).playerId, 1);
});

test('die Grenze ist einschliesslich', () => {
  assert.equal(pickBuyer(TRADERS, { ...base, minBuyerRating: 10 }).playerId, 2);
});

test('minRating faengt ein leeres oder unsinniges Feld ab', () => {
  assert.equal(minRating({ minBuyerRating: 5 }), 5);
  assert.equal(minRating({ minBuyerRating: -3 }), -3);
  assert.equal(minRating({ minBuyerRating: '' }), 0);
  assert.equal(minRating({ minBuyerRating: 'abc' }), 0);
  assert.equal(minRating({}), 0);
});

const item = {
  itemId: 206,
  itemName: 'Xanax',
  marketPrice: 800000,
  listings: [
    { price: 700000, quantity: 4, playerId: 11, playerName: 'Seller', sponsored: false },
    { price: 740000, quantity: 2, playerId: 12, playerName: 'Other', sponsored: true },
  ],
  traders: [{ playerId: 99, playerName: 'Buyer', price: 780000, ratingScore: 20 }],
};

test('Profit ist die Spanne zwischen Bazaar-Preis und Ankaufspreis', () => {
  const rows = buildFlipRows(item, base);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].reference, 780000);
  assert.equal(rows[0].profitPerUnit, 80000);
  assert.equal(rows[0].totalProfit, 320000);
  assert.equal(rows[0].buyerName, 'Buyer');
  assert.equal(rows[0].referenceLabel, 'Käufer');
  assert.equal(rows[1].sponsored, true);
});

test('ohne Kaeufer entsteht im Trader-Modus keine Zeile', () => {
  assert.deepEqual(buildFlipRows({ ...item, traders: [] }, base), []);
});

test('ohne Kaeufer rechnet der Marktpreis-Modus weiter', () => {
  const rows = buildFlipRows({ ...item, traders: [] }, { ...base, referenceMode: 'market_price' });
  assert.equal(rows.length, 2);
  assert.equal(rows[0].reference, 800000);
  assert.equal(rows[0].buyerId, null);
  assert.equal(rows[0].referenceLabel, 'Marktpreis');
});

test('faellt der einzige Kaeufer durch den Filter, entstehen keine Zeilen', () => {
  const shady = { ...item, traders: [{ playerId: 99, playerName: 'Shady', price: 780000, ratingScore: -1 }] };
  assert.deepEqual(buildFlipRows(shady, base), []);
  assert.equal(buildFlipRows(shady, { ...base, minBuyerRating: -5 }).length, 2);
});

test('Sicherheitsabschlag und Gebuehr wirken multiplikativ', () => {
  const rows = buildFlipRows(item, { ...base, sellFactor: 90, marketFeePct: 10 });
  // 780000 * 0.9 * 0.9 = 631800
  assert.equal(rows[0].sellNet, 631800);
  assert.equal(rows[0].profitPerUnit, -68200);
});

test('Budget deckelt die Stueckzahl', () => {
  const rows = buildFlipRows(item, { ...base, budget: 1500000 });
  assert.equal(rows[0].units, 2);
  assert.equal(rows[0].totalProfit, 160000);
});

test('ohne Budget zaehlt die volle Menge', () => {
  assert.equal(buildFlipRows(item, base)[0].units, 4);
});

test('absurd billige Listings werden markiert, nicht verworfen', () => {
  const cheap = { ...item, listings: [{ price: 1000, quantity: 1, playerId: 1, playerName: 'X', sponsored: false }] };
  const rows = buildFlipRows(cheap, base);
  assert.equal(rows[0].suspicious, true);
  assert.equal(buildFlipRows(item, base)[0].suspicious, false);
});

test('$1-Zeilen setzen den Kaufpreis auf 1 und den Marktpreis als Referenz', () => {
  const rows = buildDollarRows([
    { itemId: 206, itemName: 'Xanax', playerId: 5, playerName: 'Gen', quantity: 3, marketPrice: 800000 },
    { itemId: 9, itemName: 'Ohne Preis', playerId: 6, playerName: 'Y', quantity: 1, marketPrice: 0 },
  ], base);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].buy, 1);
  assert.equal(rows[0].profitPerUnit, 799999);
  assert.equal(rows[0].totalProfit, 2399997);
});

test('Filter greifen auf allen drei Achsen', () => {
  const row = buildFlipRows(item, base)[0];
  assert.equal(passesFilters(row, { ...base, minProfitAbs: 100000 }), false);
  assert.equal(passesFilters(row, { ...base, minProfitPct: 20 }), false);
  assert.equal(passesFilters(row, { ...base, maxBuyPrice: 500000 }), false);
  assert.equal(passesFilters(row, { ...base, minProfitAbs: 50000, minProfitPct: 10 }), true);
});

test('sortByTotalProfit ordnet absteigend', () => {
  const sorted = sortByTotalProfit([
    { totalProfit: 10, profitPerUnit: 1 },
    { totalProfit: 90, profitPerUnit: 9 },
  ]);
  assert.deepEqual(sorted.map((r) => r.totalProfit), [90, 10]);
});
