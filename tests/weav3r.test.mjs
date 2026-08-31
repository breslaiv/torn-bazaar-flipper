import test from 'node:test';
import assert from 'node:assert/strict';
import {
  fetchMarketplace, fetchItemListings, fetchItemTraders, fetchDollarItems, Weav3rError,
} from '../js/weav3r.js';

const settings = { weav3rKey: '', listingsPerItem: 20, tradersPerItem: 10, tradedWithinHours: 48, maxBuyPrice: 0 };
let lastUrl = null;

function stubFetch(body, { status = 200 } = {}) {
  globalThis.fetch = async (url) => {
    lastUrl = url.toString();
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    };
  };
}

test('fetchMarketplace mappt die Katalogfelder', async () => {
  stubFetch({
    total_count: 2,
    generated_at: 1700000000,
    items: [
      { item_id: 206, item_name: 'Xanax', market_price: 800000, bazaar_average: 790000, lowest_price: 700000, total_bazaars: 12 },
      { item_id: 180, item_name: 'Erotic DVD', market_price: 5000, bazaar_average: null, lowest_price: null, total_bazaars: 0 },
    ],
  });

  const { items, generatedAt } = await fetchMarketplace(settings);
  assert.equal(generatedAt, 1700000000);
  assert.equal(items.length, 2);
  assert.deepEqual(items[0], {
    itemId: 206, itemName: 'Xanax', marketPrice: 800000,
    bazaarAverage: 790000, lowestPrice: 700000, totalBazaars: 12,
  });
  assert.equal(items[1].lowestPrice, null);
  assert.equal(items[1].bazaarAverage, null);
});

test('gesponsertes Listing wird markiert und nach Preis einsortiert', async () => {
  // Die API haengt den gesponserten Eintrag unabhaengig vom Preis vorne an.
  stubFetch({
    item_id: 206,
    item_name: 'Xanax',
    market_price: 800000,
    listings: [
      { item_id: 206, player_id: 1, player_name: 'Ad', quantity: 1, price: 780000, sponsored: 1 },
      { item_id: 206, player_id: 2, player_name: 'Cheap', quantity: 5, price: 700000 },
      { item_id: 206, player_id: 3, player_name: 'Mid', quantity: 2, price: 740000 },
    ],
  });

  const res = await fetchItemListings(206, settings);
  assert.deepEqual(res.listings.map((l) => l.price), [700000, 740000, 780000]);
  assert.equal(res.listings[0].sponsored, false);
  assert.equal(res.listings[2].sponsored, true);
});

test('Listings ohne Preis oder Menge fallen raus', async () => {
  stubFetch({
    item_id: 1,
    listings: [
      { item_id: 1, quantity: 1, price: 100 },
      { item_id: 1, quantity: 0, price: 100 },
      { item_id: 1, quantity: 5, price: 0 },
    ],
  });
  const res = await fetchItemListings(1, settings);
  assert.equal(res.listings.length, 1);
});

test('maxBuyPrice wird als Query-Filter mitgeschickt', async () => {
  stubFetch({ item_id: 1, listings: [] });
  await fetchItemListings(1, { ...settings, maxBuyPrice: 50000 });
  assert.match(lastUrl, /maxPrice=50000/);
  assert.match(lastUrl, /limit=20/);

  await fetchItemListings(1, settings);
  assert.doesNotMatch(lastUrl, /maxPrice/);
});

test('fetchItemTraders sortiert nach Ankaufspreis und rechnet die Bewertung aus', async () => {
  stubFetch({
    item_id: 206,
    item_name: 'Xanax',
    traders: [
      { player_id: 9, player_name: 'Sponsor', price: 700000, rating: { upvotes: 1, downvotes: 4 }, sponsored: 1 },
      { player_id: 1, player_name: 'Best', price: 780000, rating: { upvotes: 30, downvotes: 2 } },
      { player_id: 2, player_name: 'Ok', price: 760000, rating: { upvotes: 5, downvotes: 5 } },
    ],
  });

  const res = await fetchItemTraders(206, settings);
  assert.deepEqual(res.traders.map((t) => t.playerName), ['Best', 'Ok', 'Sponsor']);
  assert.equal(res.traders[0].ratingScore, 28);
  assert.equal(res.traders[1].ratingScore, 0);
  assert.equal(res.traders[2].ratingScore, -3);
  assert.equal(res.traders[2].sponsored, true);
});

test('tradedWithinHours=0 sendet keinen Zeitfilter', async () => {
  stubFetch({ item_id: 1, traders: [] });
  await fetchItemTraders(1, { ...settings, tradedWithinHours: 0 });
  assert.doesNotMatch(lastUrl, /tradedWithinHours/);

  await fetchItemTraders(1, { ...settings, tradedWithinHours: 24 });
  assert.match(lastUrl, /tradedWithinHours=24/);
});

test('fetchDollarItems mappt camelCase und filtert leere Mengen', async () => {
  stubFetch({
    items: [
      { itemId: 206, itemName: 'Xanax', itemType: 'Drug', playerId: 5, sellerName: 'Gen', quantity: 3, marketPrice: 800000 },
      { itemId: 207, itemName: 'Leer', playerId: 6, sellerName: 'X', quantity: 0, marketPrice: 100 },
    ],
  });
  const items = await fetchDollarItems(settings, { page: 2, limit: 50 });
  assert.equal(items.length, 1);
  assert.equal(items[0].playerName, 'Gen');
  assert.match(lastUrl, /page=2/);
  assert.match(lastUrl, /limit=50/);
});

test('API-Key landet als Query-Parameter, nicht als Header', async () => {
  stubFetch({ items: [] });
  await fetchMarketplace({ ...settings, weav3rKey: 'geheim' });
  assert.match(lastUrl, /apiKey=geheim/);
});

test('429 wird als klarer Rate-Limit-Fehler gemeldet', async () => {
  stubFetch({}, { status: 429 });
  await assert.rejects(
    () => fetchMarketplace(settings),
    (err) => err instanceof Weav3rError && err.status === 429 && /Rate-Limit/.test(err.message),
  );
});

test('Netzwerkfehler nennt CORS als wahrscheinliche Ursache', async () => {
  globalThis.fetch = async () => { throw new TypeError('Failed to fetch'); };
  await assert.rejects(
    () => fetchMarketplace(settings),
    (err) => err instanceof Weav3rError && /CORS/.test(err.message),
  );
});
