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
  valueLots, summariseValuation, buyerLookupOrder, priceMap,
  readPriceCache, writePriceCache, PRICE_TTL_MS, PRICE_CACHE_KEY,
} = await import('../js/valuation.js');

const lot = (itemId, remaining, unitPrice) => ({
  event: { itemId, itemName: `Item ${itemId}`, unitPrice, ts: 1000, id: `l${itemId}` },
  remaining,
  cost: remaining * unitPrice,
});

test('bewertet gegen den Einstand, nicht gegen den Kurs von gestern', () => {
  const prices = new Map([[206, { marketPrice: 900000 }]]);
  const [v] = valueLots([lot(206, 10, 800000)], prices);

  assert.equal(v.value, 9000000);
  assert.equal(v.unrealised, 1000000, '9 Mio. Wert gegen 8 Mio. Einstand');
  assert.equal(v.unrealisedPct, 12.5);
});

test('ohne Kurs wird nicht geschaetzt', () => {
  // Der Einstand als Ersatzwert waere bequem und falsch: die Position saehe
  // dann immer nach plus/minus null aus.
  const [v] = valueLots([lot(999, 5, 100)], new Map());
  assert.equal(v.value, null);
  assert.equal(v.unrealised, null);
  assert.equal(v.marketPrice, null);
});

test('Ankaufspreis und Marktwert bleiben getrennt', () => {
  // Was ein Kaeufer zahlt, liegt unter dem Marktwert. Beides in eine Zahl zu
  // giessen wuerde den Bestand entweder zu gut oder zu schlecht aussehen lassen.
  const prices = new Map([[206, { marketPrice: 900000 }]]);
  const buyers = new Map([[206, 780000]]);
  const [v] = valueLots([lot(206, 10, 800000)], prices, buyers);

  assert.equal(v.value, 9000000);
  assert.equal(v.buyerValue, 7800000);
  assert.equal(v.unrealised, 1000000);
  assert.equal(v.buyerUnrealised, -200000, 'beim Kaeufer waere es ein Verlust');
});

test('die Zusammenfassung zaehlt Unbewertetes, statt es zu verschweigen', () => {
  const prices = new Map([[1, { marketPrice: 200 }]]);
  const summary = summariseValuation(valueLots([lot(1, 10, 100), lot(2, 5, 500)], prices));

  assert.equal(summary.priced, 1);
  assert.equal(summary.unpriced, 1);
  assert.equal(summary.cost, 1000, 'nur der bewertete Teil zaehlt mit');
  assert.equal(summary.value, 2000);
  assert.equal(summary.unrealised, 1000);
  assert.equal(summary.unrealisedPct, 100);
});

test('leerer Bestand ergibt keine Division durch null', () => {
  const s = summariseValuation([]);
  assert.equal(s.unrealised, 0);
  assert.equal(s.unrealisedPct, null);
  assert.equal(s.buyerValue, null);
});

test('Kaeufer werden fuer die groessten Positionen abgefragt', () => {
  // Jede Abfrage kostet einen Request, also zuerst dort, wo das meiste Geld liegt.
  const prices = new Map([[1, { marketPrice: 100 }], [2, { marketPrice: 10000 }], [3, { marketPrice: 50 }]]);
  const valued = valueLots([lot(1, 10, 90), lot(2, 10, 9000), lot(3, 10, 40)], prices);
  assert.deepEqual(buyerLookupOrder(valued, 2), [2, 1]);
});

test('mehrere Lots desselben Items zaehlen fuer die Abfrage zusammen', () => {
  const prices = new Map([[1, { marketPrice: 100 }], [2, { marketPrice: 150 }]]);
  const valued = valueLots([lot(1, 10, 90), lot(1, 10, 90), lot(2, 10, 140)], prices);
  assert.deepEqual(buyerLookupOrder(valued, 1), [1], '2000 aus zwei Lots schlagen 1500 aus einem');
});

test('der Kurs-Zwischenspeicher altert', () => {
  globalThis.localStorage = fakeStorage();
  const now = 1_700_000_000_000;
  writePriceCache([{ itemId: 206, marketPrice: 900000, itemName: 'Xanax' }], now);

  assert.equal(readPriceCache(now + 60_000).prices.get(206).marketPrice, 900000);
  assert.equal(readPriceCache(now + PRICE_TTL_MS + 1), null, 'zu alt, lieber neu holen');
});

test('kaputter Zwischenspeicher blockiert die Seite nicht', () => {
  globalThis.localStorage = fakeStorage();
  globalThis.localStorage.setItem(PRICE_CACHE_KEY, 'kein json');
  assert.equal(readPriceCache(), null);
});

test('priceMap uebernimmt nur brauchbare Zeilen', () => {
  const map = priceMap([
    { itemId: 1, marketPrice: 100, itemName: 'A' },
    { itemId: 2, marketPrice: 0, itemName: 'Ohne Preis' },
    { itemId: NaN, marketPrice: 100, itemName: 'Ohne Id' },
  ]);
  assert.deepEqual([...map.keys()], [1]);
});
