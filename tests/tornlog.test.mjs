import test from 'node:test';
import assert from 'node:assert/strict';
import { normaliseLog, classify, mapEntry, inspect, RULES } from '../js/tornlog.js';

const entry = (over = {}) => ({
  id: 'L1', ts: 1700000000000, category: 'Bazaar', title: 'Bazaar buy',
  data: { item: 206, quantity: 4, cost: 2800000, seller: 12 }, ...over,
});

test('normaliseLog versteht das Array-Format', () => {
  const out = normaliseLog({ log: [{ id: 7, timestamp: 1700000000, category: 'Bazaar', title: 'Bazaar buy', data: { item: 1 } }] });
  assert.equal(out.length, 1);
  assert.equal(out[0].id, '7');
  assert.equal(out[0].ts, 1700000000000, 'Sekunden werden zu Millisekunden');
  assert.equal(out[0].category, 'Bazaar');
});

test('normaliseLog versteht das nach Hash geschluesselte Format', () => {
  const out = normaliseLog({ log: { abc123: { timestamp: 1700000000, category: 'Trades', title: 'Trade accept', data: {} } } });
  assert.equal(out.length, 1);
  assert.equal(out[0].id, 'abc123');
  assert.equal(out[0].category, 'Trades');
});

test('normaliseLog vertraegt eine leere oder kaputte Antwort', () => {
  assert.deepEqual(normaliseLog({}), []);
  assert.deepEqual(normaliseLog({ log: null }), []);
  assert.deepEqual(normaliseLog({ log: [null, 5, 'x'] }), []);
});

test('classify erkennt Kauf und Verkauf', () => {
  assert.equal(classify({ category: 'Bazaar', title: 'Bazaar buy' }), 'buy');
  assert.equal(classify({ category: 'Item market', title: 'Item market bought' }), 'buy');
  assert.equal(classify({ category: 'Trades', title: 'Trade accepted' }), 'sell');
  assert.equal(classify({ category: 'Bazaar', title: 'Bazaar sold' }), 'sell');
});

test('classify laesst Unbekanntes unbeantwortet statt zu raten', () => {
  assert.equal(classify({ category: 'Attacking', title: 'Attack hospitalize' }), null);
  assert.equal(classify({ category: 'Jail', title: 'Jail bust' }), null);
  assert.equal(classify({ category: '', title: '' }), null);
});

test('mapEntry rechnet die Summe auf den Stueckpreis herunter', () => {
  const { event } = mapEntry(entry());
  assert.equal(event.kind, 'buy');
  assert.equal(event.itemId, 206);
  assert.equal(event.quantity, 4);
  assert.equal(event.unitPrice, 700000, 'der Log nennt die Summe, der Ledger den Stueckpreis');
  assert.equal(event.counterpartyId, 12);
  assert.equal(event.source, 'torn-log');
  assert.equal(event.ref, 'L1');
});

test('mapEntry nimmt Itemnamen aus dem Katalog, wenn vorhanden', () => {
  const { event } = mapEntry(entry(), new Map([[206, 'Xanax']]));
  assert.equal(event.itemName, 'Xanax');
  assert.equal(mapEntry(entry()).event.itemName, 'Item 206');
});

test('mapEntry kommt mit abweichenden Feldnamen zurecht', () => {
  const { event } = mapEntry(entry({ data: { item_id: 4, amount: 2, price: 1000 } }));
  assert.equal(event.itemId, 4);
  assert.equal(event.quantity, 2);
  assert.equal(event.unitPrice, 500);
});

test('mapEntry versteht ein einzelnes Item in einem items-Array', () => {
  const { event } = mapEntry(entry({ data: { items: [{ id: 9, qty: 5 }], cost: 500 } }));
  assert.equal(event.itemId, 9);
  assert.equal(event.quantity, 5);
  assert.equal(event.unitPrice, 100);
});

test('mehrere Items in einem Vorgang werden gemeldet statt geraten', () => {
  // Ohne Einzelpreise laesst sich die Summe nicht fair aufteilen.
  const r = mapEntry(entry({ data: { items: [{ id: 1, qty: 1 }, { id: 2, qty: 1 }], cost: 500 } }));
  assert.equal(r.event, undefined);
  assert.match(r.skip, /mehrere Items/);
});

test('unvollstaendige Eintraege nennen ihren Grund', () => {
  assert.match(mapEntry(entry({ data: { quantity: 1, cost: 5 } })).skip, /Item-ID/);
  assert.match(mapEntry(entry({ data: { item: 1, quantity: 1 } })).skip, /Betrag/);
  assert.match(mapEntry(entry({ data: { item: 1, quantity: 0, cost: 5 } })).skip, /Menge/);
  assert.match(mapEntry(entry({ category: 'Jail', title: 'Bust' })).skip, /unbekannte Kategorie/);
});

test('inspect trennt Erkanntes von Unerkanntem und zaehlt beides', () => {
  const entries = [
    entry(),
    entry({ id: 'L2' }),
    entry({ id: 'L3', category: 'Attacking', title: 'Attack won', data: {} }),
    entry({ id: 'L4', category: 'Attacking', title: 'Attack won', data: {} }),
    entry({ id: 'L5', category: 'Crimes', title: 'Crime success', data: {} }),
  ];
  const report = inspect(entries);

  assert.equal(report.events.length, 2);
  assert.equal(report.skipped[0].reason, 'unbekannte Kategorie');
  assert.equal(report.skipped[0].count, 3);

  const attacking = report.categories.find((c) => c.key.startsWith('Attacking'));
  assert.equal(attacking.count, 2);
  assert.equal(attacking.recognised, false);
  const bazaar = report.categories.find((c) => c.key.startsWith('Bazaar'));
  assert.equal(bazaar.recognised, true);
});

test('inspect liefert zu jeder Kategorie ein Beispiel fuer die Fehlersuche', () => {
  const report = inspect([entry({ category: 'Unbekannt', title: 'Irgendwas', data: { foo: 1 } })]);
  assert.equal(report.categories[0].sample.data.foo, 1);
});

test('die Regeln sind so gebaut, dass sie sich erweitern lassen', () => {
  // Wenn sich ein Titel als falsch herausstellt, ist das eine Zeile.
  assert.ok(RULES.length >= 4);
  for (const rule of RULES) {
    assert.ok(rule.kind === 'buy' || rule.kind === 'sell');
    assert.ok(rule.category instanceof RegExp);
    assert.ok(rule.title instanceof RegExp);
  }
});
