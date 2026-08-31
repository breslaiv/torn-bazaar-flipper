import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeBazaar, urlNeedsItemId } from '../js/weav3r.js';

test('flaches Array mit item_id/price', () => {
  const { listings } = normalizeBazaar([
    { item_id: 206, price: 700000, quantity: 5, player_id: 12345 },
    { item_id: 207, price: 1200, quantity: 100, player_id: 999 },
  ]);
  assert.equal(listings.length, 2);
  assert.deepEqual(
    listings.map((l) => [l.itemId, l.price, l.quantity, l.playerId]),
    [[206, 700000, 5, 12345], [207, 1200, 100, 999]],
  );
});

test('nach Item-ID gruppiertes Objekt', () => {
  const { listings } = normalizeBazaar({
    206: [{ cost: 690000, amount: 3, userID: 42 }],
    815: [{ cost: 40000, amount: 1, userID: 43 }],
  });
  assert.equal(listings.length, 2);
  assert.equal(listings[0].itemId, 206);
  assert.equal(listings[0].price, 690000);
  assert.equal(listings[1].itemId, 815);
});

test('verschachtelte Huelle mit data/listings', () => {
  const { listings } = normalizeBazaar({
    success: true,
    data: { listings: [{ itemId: 180, price: 25000, qty: 2, seller_id: 7 }] },
  });
  assert.equal(listings.length, 1);
  assert.equal(listings[0].itemId, 180);
  assert.equal(listings[0].quantity, 2);
  assert.equal(listings[0].playerId, 7);
});

test('Preise als formatierte Strings', () => {
  const { listings } = normalizeBazaar([{ item_id: 1, price: '1,250,000', quantity: '3' }]);
  assert.equal(listings[0].price, 1250000);
  assert.equal(listings[0].quantity, 3);
});

test('Zeilen ohne Preis oder Item-ID fallen raus', () => {
  const { listings } = normalizeBazaar([
    { item_id: 1, price: 100 },
    { item_id: 2 },
    { price: 500 },
    { item_id: 3, price: 0 },
  ]);
  assert.equal(listings.length, 1);
  assert.equal(listings[0].itemId, 1);
});

test('fehlende Menge faellt auf 1 zurueck', () => {
  const { listings } = normalizeBazaar([{ item_id: 4, price: 100 }]);
  assert.equal(listings[0].quantity, 1);
});

test('Diagnose meldet die gefundenen Pfade', () => {
  const { diagnostics } = normalizeBazaar({ data: { listings: [{ item_id: 1, price: 5 }] } });
  assert.equal(diagnostics.listingsParsed, 1);
  assert.equal(diagnostics.arraysFound.length, 1);
  assert.equal(diagnostics.arraysFound[0].path, '$.data.listings');
});

test('unbrauchbare Antwort liefert leer statt zu werfen', () => {
  assert.equal(normalizeBazaar({ error: 'nope' }).listings.length, 0);
  assert.equal(normalizeBazaar(null).listings.length, 0);
  assert.equal(normalizeBazaar([]).listings.length, 0);
});

test('urlNeedsItemId erkennt den Platzhalter', () => {
  assert.equal(urlNeedsItemId('https://x/api/bazaar/{ITEM_ID}'), true);
  assert.equal(urlNeedsItemId('https://x/api/bazaar'), false);
  assert.equal(urlNeedsItemId(''), false);
});
