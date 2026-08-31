import test from 'node:test';
import assert from 'node:assert/strict';
import { runFlipScan, runDollarScan, poolSize } from '../js/scan.js';

const settings = {
  referenceMode: 'trader',
  sellFactor: 100,
  marketFeePct: 0,
  prescreenPct: 90,
  maxCandidates: 10,
  listingsPerItem: 20,
  tradersPerItem: 10,
  tradedWithinHours: 48,
  minBuyerRating: 0,
  minProfitAbs: 0,
  minProfitPct: 0,
  maxBuyPrice: 0,
  budget: 0,
};

function deps({ catalog = [], listings = {}, traders = {}, dollar = [] } = {}) {
  const calls = { listings: [], traders: [] };
  return {
    calls,
    deps: {
      fetchMarketplace: async () => ({ items: catalog, generatedAt: 1700000000 }),
      fetchItemListings: async (id) => {
        calls.listings.push(id);
        return { itemId: id, itemName: `Item ${id}`, marketPrice: 1000, listings: listings[id] || [] };
      },
      fetchItemTraders: async (id) => {
        calls.traders.push(id);
        return { itemId: id, traders: traders[id] || [] };
      },
      fetchDollarItems: async () => dollar,
    },
  };
}

test('nur vorgesiebte Items loesen Detail-Requests aus', async () => {
  const { calls, deps: d } = deps({
    catalog: [
      { itemId: 1, itemName: 'Billig', marketPrice: 1000, lowestPrice: 500, totalBazaars: 3 },
      { itemId: 2, itemName: 'Teuer', marketPrice: 1000, lowestPrice: 990, totalBazaars: 3 },
    ],
    listings: { 1: [{ price: 500, quantity: 2, playerId: 7, playerName: 'S', sponsored: false }] },
    traders: { 1: [{ playerId: 8, playerName: 'B', price: 900, ratingScore: 3 }] },
  });

  const { rows, stats } = await runFlipScan(settings, { deps: d });
  assert.deepEqual(calls.listings, [1]);
  assert.deepEqual(calls.traders, [1]);
  assert.equal(stats.catalogSize, 2);
  assert.equal(stats.candidates, 1);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].profitPerUnit, 400);
  assert.equal(rows[0].totalProfit, 800);
});

test('Items ohne Kaeufer werden gezaehlt statt still verschluckt', async () => {
  const { deps: d } = deps({
    catalog: [{ itemId: 1, itemName: 'Billig', marketPrice: 1000, lowestPrice: 500, totalBazaars: 3 }],
    listings: { 1: [{ price: 500, quantity: 2, playerId: 7, playerName: 'S', sponsored: false }] },
    traders: {},
  });
  const { rows, stats } = await runFlipScan(settings, { deps: d });
  assert.equal(rows.length, 0);
  assert.equal(stats.withoutBuyer, 1);
  assert.equal(stats.buyerBelowRating, 0, 'ohne Kaeufer ist kein Bewertungsproblem');
});

test('ein fehlgeschlagenes Item bricht den Scan nicht ab', async () => {
  const { deps: d } = deps({
    catalog: [
      { itemId: 1, itemName: 'Kaputt', marketPrice: 1000, lowestPrice: 400, totalBazaars: 3 },
      { itemId: 2, itemName: 'Heil', marketPrice: 1000, lowestPrice: 500, totalBazaars: 3 },
    ],
    listings: { 2: [{ price: 500, quantity: 1, playerId: 7, playerName: 'S', sponsored: false }] },
    traders: { 2: [{ playerId: 8, playerName: 'B', price: 900, ratingScore: 0 }] },
  });
  const broken = {
    ...d,
    fetchItemListings: async (id, s, o) => {
      if (id === 1) throw new Error('HTTP 500');
      return d.fetchItemListings(id, s, o);
    },
  };

  const { rows } = await runFlipScan(settings, { deps: broken });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].itemId, 2);
});

test('leerer Katalog liefert leeres Ergebnis ohne Detail-Requests', async () => {
  const { calls, deps: d } = deps({ catalog: [] });
  const { rows, stats } = await runFlipScan(settings, { deps: d });
  assert.deepEqual(rows, []);
  assert.equal(stats.candidates, 0);
  assert.equal(calls.listings.length, 0);
});

test('ein bereits abgebrochener Scan stellt keine Detail-Requests', async () => {
  const { calls, deps: d } = deps({
    catalog: [{ itemId: 1, itemName: 'Billig', marketPrice: 1000, lowestPrice: 500, totalBazaars: 3 }],
  });
  const ac = new AbortController();
  ac.abort();
  const { rows } = await runFlipScan(settings, { deps: d, signal: ac.signal });
  assert.equal(rows.length, 0);
  assert.equal(calls.listings.length, 0);
});

test('Fortschritt wird pro Kandidat gemeldet', async () => {
  const { deps: d } = deps({
    catalog: [{ itemId: 1, itemName: 'Billig', marketPrice: 1000, lowestPrice: 500, totalBazaars: 3 }],
    listings: { 1: [] },
    traders: { 1: [] },
  });
  const phases = [];
  await runFlipScan(settings, { deps: d, onProgress: (p) => phases.push(p.phase) });
  assert.deepEqual(phases, ['catalog', 'detail']);
});

test('Dollar-Scan filtert und sortiert nach Gesamtwert', async () => {
  const { deps: d } = deps({
    dollar: [
      { itemId: 1, itemName: 'Klein', playerId: 5, playerName: 'A', quantity: 1, marketPrice: 5000 },
      { itemId: 2, itemName: 'Gross', playerId: 6, playerName: 'B', quantity: 10, marketPrice: 20000 },
    ],
  });
  const { rows } = await runDollarScan({ ...settings, maxCandidates: 50 }, { deps: d });
  assert.deepEqual(rows.map((r) => r.itemName), ['Gross', 'Klein']);
  assert.equal(rows[0].buy, 1);
  assert.equal(rows[0].totalProfit, 199990);
});

// ---------- Parallelitaet ----------

const catalogOf = (n) => Array.from({ length: n }, (_, i) => ({
  itemId: i + 1, itemName: `Item ${i + 1}`, marketPrice: 1000, lowestPrice: 500, totalBazaars: 3,
}));

/** Zaehlt, wie viele Abfragen zu einem Zeitpunkt gleichzeitig offen sind. */
function tracking(delay = 5) {
  const state = { open: 0, peak: 0, seen: [] };
  const hold = async (id) => {
    state.open += 1;
    state.peak = Math.max(state.peak, state.open);
    await new Promise((r) => setTimeout(r, delay));
    state.open -= 1;
  };
  return {
    state,
    deps: {
      fetchMarketplace: async () => ({ items: catalogOf(8), generatedAt: 0 }),
      fetchItemListings: async (id) => {
        state.seen.push(id);
        await hold(id);
        return { itemId: id, itemName: `Item ${id}`, marketPrice: 1000,
          listings: [{ price: 500, quantity: 1, playerId: 7, playerName: 'S', sponsored: false }] };
      },
      fetchItemTraders: async (id) => {
        await hold(id);
        return { itemId: id, traders: [{ playerId: 8, playerName: 'B', price: 900, ratingScore: 0 }] };
      },
    },
  };
}

test('poolSize bleibt in vernuenftigen Grenzen', () => {
  assert.equal(poolSize({ concurrency: 4 }), 4);
  assert.equal(poolSize({ concurrency: 99 }), 8, 'nach oben gedeckelt');
  assert.equal(poolSize({ concurrency: 0 }), 1);
  assert.equal(poolSize({}), 1, 'ohne Angabe seriell - so lief es vorher');
  assert.equal(poolSize({ concurrency: 'drei' }), 1);
});

test('Kandidaten laufen parallel, aber nicht mehr als erlaubt', async () => {
  const { state, deps } = tracking();
  const { rows } = await runFlipScan({ ...settings, maxCandidates: 8, concurrency: 3 }, { deps });
  assert.equal(rows.length, 8, 'jeder Kandidat kommt genau einmal an');
  assert.equal(state.seen.length, 8);
  assert.equal(new Set(state.seen).size, 8, 'keiner doppelt');
  // Zwei Requests je Kandidat laufen ohnehin zusammen, drei Kandidaten
  // gleichzeitig ergeben also bis zu sechs offene Abfragen.
  assert.ok(state.peak > 2, `parallel gelaufen ist es nicht (Spitze ${state.peak})`);
  assert.ok(state.peak <= 6, `zu viele gleichzeitig: ${state.peak}`);
});

test('seriell bleibt seriell', async () => {
  const { state, deps } = tracking();
  await runFlipScan({ ...settings, maxCandidates: 8, concurrency: 1 }, { deps });
  assert.equal(state.peak, 2, 'nur die beiden Abfragen desselben Kandidaten');
});

test('ein Abbruch stoppt auch den parallelen Scan', async () => {
  const controller = new AbortController();
  const { state, deps } = tracking(20);
  const promise = runFlipScan({ ...settings, maxCandidates: 8, concurrency: 2 }, {
    deps, signal: controller.signal,
  });
  setTimeout(() => controller.abort(), 25);
  const { rows } = await promise;
  assert.ok(state.seen.length < 8, `es wurden trotzdem alle geholt: ${state.seen.length}`);
  assert.ok(rows.length < 8);
});

test('das Budget wird ueber den ganzen Scan verteilt, nicht je Zeile', async () => {
  const { deps: d } = deps({
    catalog: [
      { itemId: 1, itemName: 'A', marketPrice: 1000, lowestPrice: 500, totalBazaars: 3 },
      { itemId: 2, itemName: 'B', marketPrice: 1000, lowestPrice: 600, totalBazaars: 3 },
    ],
    listings: {
      1: [{ price: 500, quantity: 10, playerId: 7, playerName: 'S', sponsored: false }],
      2: [{ price: 600, quantity: 10, playerId: 7, playerName: 'S', sponsored: false }],
    },
    traders: {
      1: [{ playerId: 8, playerName: 'B', price: 900, ratingScore: 0 }],
      2: [{ playerId: 8, playerName: 'B', price: 900, ratingScore: 0 }],
    },
  });

  const { rows } = await runFlipScan({ ...settings, budget: 5000 }, { deps: d });
  const spend = rows.reduce((s, r) => s + r.spend, 0);
  assert.ok(spend <= 5000, `Einsatz ${spend} ueber Budget`);
  const profit = rows.reduce((s, r) => s + r.totalProfit, 0);
  assert.equal(profit, 4000, '10 Stueck der besseren Zeile zu 400 Profit');
});

test('profitable Zeilen, die am Alter scheitern, werden gezaehlt', async () => {
  const alt = Date.now() - 200 * 3600e3;
  const { deps: d } = deps({
    catalog: [{ itemId: 1, itemName: 'Alt', marketPrice: 1000, lowestPrice: 500, totalBazaars: 3 }],
    listings: { 1: [{ price: 500, quantity: 2, playerId: 7, playerName: 'S', sponsored: false, contentUpdated: alt }] },
    traders: { 1: [{ playerId: 8, playerName: 'B', price: 900, ratingScore: 0 }] },
  });
  const { rows, stats } = await runFlipScan({ ...settings, maxListingAgeHours: 48 }, { deps: d });
  assert.equal(rows.length, 0);
  assert.equal(stats.filteredOut, 1, 'sonst sieht ein strenger Filter aus wie ein leerer Markt');
});
