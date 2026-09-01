import test from 'node:test';
import assert from 'node:assert/strict';
import {
  prescreen, prescreenBreakdown, pickBuyer, minRating, buildFlipRows, buildDollarRows,
  passesFilters, rejectionReason, sortByTotalProfit, allocateBudget,
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

test('prescreen sortiert nach erwartetem Profit und deckelt die Anzahl', () => {
  const out = prescreen(catalog, { ...base, maxCandidates: 1 });
  assert.equal(out.length, 1);
  assert.equal(out[0].itemId, 1);
  assert.equal(out[0].expectedProfit, 400000);
});

test('prescreen verschenkt keinen Platz an Items, die die Filter reissen', () => {
  // Der teure Kandidat hat die groessere Spanne, aber nur 4% Marge; der
  // billige haette 100%. Nach reiner Spanne belegte der teure den einzigen
  // Platz und der echte Flip wuerde nie geprueft.
  const items = [
    { itemId: 10, itemName: 'Teuer, duenn', marketPrice: 10000000, lowestPrice: 9600000, totalBazaars: 3 },
    { itemId: 11, itemName: 'Billig, fett', marketPrice: 100000, lowestPrice: 50000, totalBazaars: 3 },
  ];
  // Rabattschwelle weit offen, damit hier wirklich die Reihenfolge zur
  // Debatte steht und nicht schon die Vorauswahl davor.
  const weit = { ...base, prescreenPct: 99, maxCandidates: 1 };
  assert.deepEqual(prescreen(items, { ...weit, minProfitPct: 10 }).map((i) => i.itemId), [11]);

  // Ohne Margenfilter gewinnt weiterhin der absolute Profit - dann ist die
  // duenne Marge ja auch erlaubt.
  assert.deepEqual(prescreen(items, weit).map((i) => i.itemId), [10]);
});

test('prescreen misst am selben Netto wie die spaetere Zeile', () => {
  // Sicherheitsabschlag von 20%: aus 1.000.000 Marktpreis werden 800.000
  // erwarteter Erloes, also 200.000 statt 400.000 erwarteter Profit.
  const [erste] = prescreen(catalog, { ...base, sellFactor: 80 });
  assert.equal(erste.expectedProfit, 200000);

  // Und wer damit unter die Schwelle faellt, kostet keinen Request mehr.
  const streng = prescreen(catalog, { ...base, sellFactor: 80, minProfitAbs: 250000 });
  assert.deepEqual(streng.map((i) => i.itemId), []);
});

test('prescreen schaetzt eher zu guenstig als zu streng', () => {
  // Der Marktpreis steht nur als Platzhalter fuer den Ankaufspreis eines
  // Kaeufers, und Kaeufer zahlen darunter. Ein Kandidat, der die Schwelle
  // gegen den Marktpreis genau erreicht, muss also drin bleiben.
  const items = [{ itemId: 12, itemName: 'Grenzfall', marketPrice: 100000, lowestPrice: 90000, totalBazaars: 1 }];
  const out = prescreen(items, { ...base, prescreenPct: 90, minProfitAbs: 10000 });
  assert.deepEqual(out.map((i) => i.itemId), [12]);
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

// ---------- Budget ----------

const flip = (id, buy, quantity, profitPerUnit) => ({
  itemId: id, itemName: `Item ${id}`, buy, quantity, profitPerUnit,
  units: quantity, spend: buy * quantity, totalProfit: profitPerUnit * quantity,
});

test('ohne Budget bleibt alles wie es ist', () => {
  const rows = [flip(1, 100, 5, 50)];
  assert.equal(allocateBudget(rows, 0), rows, 'dieselbe Liste, nicht nur derselbe Inhalt');
});

test('das Budget wird ueber alle Zeilen verteilt statt jeder Zeile ganz zugestanden', () => {
  // Vorher rechnete jede Zeile mit den vollen 1000 und die Summe oben gab
  // dasselbe Geld dreimal aus.
  const rows = [flip(1, 100, 10, 50), flip(2, 100, 10, 40)];
  const out = allocateBudget(rows, 1000);
  const spend = out.reduce((s, r) => s + r.spend, 0);
  assert.ok(spend <= 1000, `Einsatz ${spend} darf das Budget nicht ueberschreiten`);
  assert.equal(out[0].units, 10, 'die bessere Zeile zuerst');
  assert.equal(out[1].units, 0);
  assert.equal(out[1].totalProfit, 0);
  assert.equal(out[1].overBudget, true, 'sonst sieht Menge 0 nach einem Rechenfehler aus');
});

test('zugeteilt wird nach Rendite je Dollar, nicht nach absolutem Gewinn', () => {
  // Die teure Zeile bringt pro Stueck mehr, bindet aber das ganze Budget.
  // Mit 1000 Dollar sind 10x50 mehr wert als 1x200.
  const teuer = flip(1, 1000, 5, 200);
  const guenstig = flip(2, 100, 10, 50);
  const out = allocateBudget([teuer, guenstig], 1000);
  const byId = new Map(out.map((r) => [r.itemId, r]));
  assert.equal(byId.get(2).units, 10);
  assert.equal(byId.get(1).units, 0);
  assert.equal(out.reduce((s, r) => s + r.totalProfit, 0), 500);
});

test('Restgeld fliesst in die naechste bezahlbare Zeile', () => {
  const out = allocateBudget([flip(1, 300, 3, 100), flip(2, 50, 4, 10)], 1000);
  const byId = new Map(out.map((r) => [r.itemId, r]));
  assert.equal(byId.get(1).units, 3, '900 von 1000');
  assert.equal(byId.get(2).units, 2, 'die restlichen 100');
  assert.equal(out.reduce((s, r) => s + r.spend, 0), 1000);
});

test('die Reihenfolge der Liste bleibt erhalten', () => {
  // Sortiert wird spaeter im UI; allocateBudget darf die Liste nicht umbauen.
  const out = allocateBudget([flip(1, 100, 1, 10), flip(2, 10, 1, 5)], 50);
  assert.deepEqual(out.map((r) => r.itemId), [1, 2]);
});


// --- Zwischenstaende, aus denen der Trichter gebaut wird ---

test('prescreenBreakdown zaehlt jede Siebstufe einzeln', () => {
  const b = prescreenBreakdown(catalog, base);
  assert.equal(b.total, 4);
  // "Kein Bazaar" hat weder Listing noch Preis.
  assert.deepEqual(b.listed.map((i) => i.itemId), [1, 2, 3]);
  assert.deepEqual(b.discounted.map((i) => i.itemId), [1, 2]);
  assert.deepEqual(b.affordable.map((i) => i.itemId), [1, 2]);
  assert.deepEqual(b.capped.map((i) => i.itemId), [1, 2]);
});

test('die Preisgrenze wirkt als eigene Stufe', () => {
  const b = prescreenBreakdown(catalog, { ...base, maxBuyPrice: 100000 });
  assert.deepEqual(b.discounted.map((i) => i.itemId), [1, 2]);
  assert.deepEqual(b.affordable.map((i) => i.itemId), [2], 'Item 1 kostet 600.000');
});

test('das Kandidatenlimit ist die letzte Stufe, nicht die erste', () => {
  // Sonst sieht ein zu kleines Limit aus wie ein zu strenger Rabatt.
  const b = prescreenBreakdown(catalog, { ...base, maxCandidates: 1 });
  assert.equal(b.profitable.length, 2);
  assert.equal(b.capped.length, 1);
});

test('prescreen liefert weiterhin genau die gekappte Liste', () => {
  for (const settings of [base, { ...base, maxCandidates: 1 }, { ...base, maxBuyPrice: 100000 }]) {
    assert.deepEqual(
      prescreen(catalog, settings).map((i) => i.itemId),
      prescreenBreakdown(catalog, settings).capped.map((i) => i.itemId),
    );
  }
});

// --- Warum eine Zeile durchfaellt ---

const row = (over = {}) => ({
  profitPerUnit: 50000, profitPct: 20, buy: 100000, listingAgeHours: 1, ...over,
});

test('der Ablehnungsgrund unterscheidet Profit, Preis und Alter', () => {
  const settings = { ...base, minProfitAbs: 10000, minProfitPct: 5, maxBuyPrice: 200000, maxListingAgeHours: 24 };
  assert.equal(rejectionReason(row(), settings), null);
  assert.equal(rejectionReason(row({ profitPerUnit: 500 }), settings), 'profit');
  assert.equal(rejectionReason(row({ profitPct: 1 }), settings), 'profit');
  assert.equal(rejectionReason(row({ buy: 300000 }), settings), 'price');
  assert.equal(rejectionReason(row({ listingAgeHours: 48 }), settings), 'age');
});

test('passesFilters und rejectionReason koennen nicht auseinanderlaufen', () => {
  const settings = { ...base, minProfitAbs: 10000, minProfitPct: 5, maxBuyPrice: 200000, maxListingAgeHours: 24 };
  const cases = [row(), row({ profitPerUnit: 500 }), row({ buy: 300000 }), row({ listingAgeHours: 48 })];
  for (const r of cases) {
    assert.equal(passesFilters(r, settings), rejectionReason(r, settings) === null);
  }
});
