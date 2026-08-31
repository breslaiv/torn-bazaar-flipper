import test from 'node:test';
import assert from 'node:assert/strict';

// Minimaler localStorage-Ersatz, damit der Store ohne Browser laeuft.
function fakeStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
  };
}
globalThis.localStorage = fakeStorage();

const store = await import('../js/offersStore.js');

const reset = () => { globalThis.localStorage = fakeStorage(); };

const offer = (over = {}) => ({
  tradeId: 1, ref: 'trade-1', status: 'open', statusBy: null,
  openedAt: 1000, endedAt: null, lastSeen: 1000, counterpartyId: 42,
  openedBy: 'me', direction: 'sell', myItems: [], theirItems: [],
  myMoney: 0, theirMoney: 0, quantity: 1, money: 0,
  askedUnitPrice: null, unitPrice: null, description: '', note: '', ...over,
});

test('gespeichert wird nur, was wie ein Angebot aussieht', () => {
  reset();
  store.saveOffers([offer(), { tradeId: 2 }, offer({ tradeId: 3, status: 'quatsch' }), null]);
  assert.deepEqual(store.loadOffers().map((o) => o.tradeId), [1]);
});

test('ein beendeter Trade wird nicht wieder geoeffnet', () => {
  // Der Fall: der naechste Import liest ein kuerzeres Stueck Log, in dem nur
  // noch die Eroeffnung steht. Ohne diese Regel stuende ein abgeschlossener
  // Trade danach wieder als "offen" da.
  reset();
  store.mergeOffers([offer({ status: 'completed', endedAt: 2000, lastSeen: 2000 })]);
  const { offers, updated } = store.mergeOffers([offer({ status: 'open', lastSeen: 3000 })]);

  assert.equal(offers[0].status, 'completed');
  assert.equal(offers[0].endedAt, 2000, 'auch das Ende bleibt stehen');
  assert.equal(updated, 0);
});

test('ein offener Trade nimmt ein spaeteres Ende an', () => {
  reset();
  store.mergeOffers([offer()]);
  const { offers, updated } = store.mergeOffers([offer({ status: 'expired', endedAt: 5000, lastSeen: 5000 })]);
  assert.equal(offers[0].status, 'expired');
  assert.equal(updated, 1);
});

test('die eigene Notiz ueberlebt jeden Import', () => {
  reset();
  store.mergeOffers([offer()]);
  store.setNote(1, 'für Klaus reserviert');
  const { offers } = store.mergeOffers([offer({ status: 'expired', lastSeen: 9000 })]);
  assert.equal(offers[0].note, 'für Klaus reserviert', 'die Notiz gehoert dem Nutzer, nicht dem Log');
  assert.equal(offers[0].status, 'expired', 'der Status kommt trotzdem vom Log');
});

test('neu und aktualisiert werden getrennt gezaehlt', () => {
  reset();
  const erste = store.mergeOffers([offer(), offer({ tradeId: 2 })]);
  assert.deepEqual([erste.added, erste.updated], [2, 0]);
  const zweite = store.mergeOffers([offer(), offer({ tradeId: 3 })]);
  assert.deepEqual([zweite.added, zweite.updated], [1, 0]);
  assert.equal(zweite.offers.length, 3);
});

test('der Speicher laeuft nicht ueber, aelteste fliegen zuerst', () => {
  reset();
  const viele = Array.from({ length: store.LIMIT + 20 }, (_, i) => offer({ tradeId: i + 1, lastSeen: i + 1 }));
  const saved = store.saveOffers(viele);
  assert.equal(saved.length, store.LIMIT);
  assert.equal(saved[0].tradeId, store.LIMIT + 20, 'zuletzt gesehen steht vorn');
  assert.ok(!saved.some((o) => o.tradeId === 1), 'das aelteste ist weg');
});

test('Notiz und Loeschen treffen nur das gemeinte Angebot', () => {
  reset();
  store.mergeOffers([offer(), offer({ tradeId: 2 })]);
  store.setNote(2, 'Notiz');
  assert.deepEqual(store.loadOffers().map((o) => o.note), ['', 'Notiz']);
  const rest = store.removeOffer(1);
  assert.deepEqual(rest.map((o) => o.tradeId), [2]);
  assert.equal(rest[0].note, 'Notiz');
});

test('kaputter Speicherinhalt fuehrt nicht zu einer leeren Seite', () => {
  reset();
  globalThis.localStorage.setItem(store.OFFERS_KEY, '{kein json');
  assert.deepEqual(store.loadOffers(), []);
});
