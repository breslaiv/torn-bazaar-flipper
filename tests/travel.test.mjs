import test from 'node:test';
import assert from 'node:assert/strict';
import {
  COUNTRIES, countryCode, countryName, travelFactor, oneWayMinutes,
  rateItem, planCountry, planTrips,
} from '../js/travel.js';

const base = { travelCapacity: 5, budget: 0, marketFeePct: 0, travelAirstrip: 'standard' };
const item = (over = {}) => ({ itemId: 260, itemName: 'Dahlia', cost: 400, quantity: 100, ...over });

test('Laendernamen kommen in mehreren Schreibweisen an', () => {
  // YATA benennt Laender je nach Route anders; ein Land, das nur am
  // Schluessel scheitert, waere ein stiller Verlust.
  assert.equal(countryCode('mex'), 'mex');
  assert.equal(countryCode('Mexico'), 'mex');
  assert.equal(countryCode('United Kingdom'), 'uni');
  assert.equal(countryCode('south africa'), 'sou');
  assert.equal(countryCode('southafrica'), 'sou');
  assert.equal(countryCode('Mars'), null);
  assert.equal(countryName('jap'), 'Japan');
});

test('der Flieger kuerzt die Reisezeit, die gemessene Zeit schlaegt alles', () => {
  assert.equal(oneWayMinutes('mex', base), 26);
  assert.equal(oneWayMinutes('mex', { ...base, travelAirstrip: 'airstrip' }), 26 * 0.7);
  assert.equal(travelFactor('business'), 0.3);

  // Eine gemessene Zeit enthaelt bereits alles an Perks - sie darf nicht
  // noch einmal mit dem Faktor multipliziert werden.
  assert.equal(oneWayMinutes('mex', { ...base, travelAirstrip: 'business', travelTimes: { mex: 18 } }), 18);
  assert.equal(oneWayMinutes('nirgendwo', base), null);
});

test('drei Grenzen, und die kleinste gewinnt', () => {
  // Koffer, Regal, Geldbeutel - eine Menge, die an einer davon scheitert,
  // waere eine Zahl, die man nicht kaufen kann.
  assert.equal(rateItem(item(), 1000, { ...base, travelCapacity: 5 }).units, 5);
  assert.equal(rateItem(item({ quantity: 2 }), 1000, base).units, 2);
  assert.equal(rateItem(item(), 1000, { ...base, budget: 1200 }).units, 3);

  assert.equal(rateItem(item({ quantity: 2 }), 1000, base).limitedBy, 'Vorrat');
  assert.equal(rateItem(item(), 1000, { ...base, budget: 1200 }).limitedBy, 'Budget');
  assert.equal(rateItem(item(), 1000, base).limitedBy, 'Kapazität');
});

test('der Ertrag rechnet mit dem Netto nach Gebuehr', () => {
  const r = rateItem(item(), 1000, { ...base, marketFeePct: 10 });
  assert.equal(r.netPrice, 900);
  assert.equal(r.profitPerUnit, 500);
  assert.equal(r.tripProfit, 2500, '5 Stueck');
  assert.equal(r.spend, 2000);
});

test('ohne Marktpreis wird kein Ertrag behauptet', () => {
  const r = rateItem(item(), 0, base);
  assert.equal(r.profitPerUnit, null);
  assert.equal(r.tripProfit, null);
});

test('pro Minute, nicht pro Flug - sonst fliegt man zu weit', () => {
  // Suedafrika bringt pro Flug mehr, dauert aber elfmal so lang wie Mexiko.
  const prices = new Map([[1, { marketPrice: 1000 }], [2, { marketPrice: 12000 }]]);
  const stocks = new Map([
    ['mex', [{ itemId: 1, itemName: 'Nah', cost: 100, quantity: 100 }]],
    ['sou', [{ itemId: 2, itemName: 'Fern', cost: 5000, quantity: 100 }]],
  ]);

  const trips = planTrips(stocks, prices, base);
  // Mexiko: 4500 in 52 min = 87/min. Suedafrika: 35000 in 594 min = 59/min.
  assert.equal(trips[0].code, 'mex');
  assert.ok(trips[0].profitPerMinute > trips[1].profitPerMinute);
  assert.ok(trips[1].tripProfit > trips[0].tripProfit, 'pro Flug ist Suedafrika trotzdem groesser');
});

test('ein Land ohne lohnende Ware faellt aus der Planung', () => {
  const prices = new Map([[1, { marketPrice: 100 }]]);
  const plan = planCountry('mex', [{ itemId: 1, itemName: 'Teuer', cost: 500, quantity: 10 }], prices, base);
  assert.equal(plan.items.length, 0);
  assert.equal(plan.best, null);
  assert.equal(plan.profitPerMinute, null);
});

test('jedes Land der Tabelle hat eine Zeit', () => {
  for (const c of COUNTRIES) {
    assert.ok(oneWayMinutes(c.code, base) > 0, c.name);
  }
});
