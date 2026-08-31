import test from 'node:test';
import assert from 'node:assert/strict';
import { tableHtml } from '../js/table.js';
import { makeEvent } from '../js/ledger.js';

// Minimaler localStorage-Ersatz, damit der Store ohne Browser laeuft.
function fakeStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
    _map: map,
  };
}
globalThis.localStorage = fakeStorage();

const store = await import('../js/ledgerStore.js');

function reset() {
  globalThis.localStorage = fakeStorage();
}

const ev = (over = {}) => makeEvent({
  ts: 1700000000000, kind: 'buy', itemId: 206, itemName: 'Xanax', quantity: 2, unitPrice: 100, ...over,
});

// ---------- Speicherung ----------

test('gespeicherte Ereignisse kommen unveraendert zurueck', () => {
  reset();
  store.saveEvents([ev()]);
  const back = store.loadEvents();
  assert.equal(back.length, 1);
  assert.equal(back[0].itemName, 'Xanax');
  assert.equal(back[0].unitPrice, 100);
});

test('kaputter Speicherinhalt ergibt einen leeren Ledger statt eines Absturzes', () => {
  reset();
  localStorage.setItem(store.LEDGER_KEY, '{kein json');
  assert.deepEqual(store.loadEvents(), []);
  localStorage.setItem(store.LEDGER_KEY, '{"nicht":"ein array"}');
  assert.deepEqual(store.loadEvents(), []);
});

test('unbrauchbare Zeilen werden beim Laden aussortiert', () => {
  reset();
  localStorage.setItem(store.LEDGER_KEY, JSON.stringify([ev(), { kind: 'buy' }, null]));
  assert.equal(store.loadEvents().length, 1);
});

test('addEvents zaehlt neu, doppelt und unbrauchbar getrennt', () => {
  reset();
  const a = ev({ source: 'torn-log', ref: 'L1' });
  const b = ev({ source: 'torn-log', ref: 'L2' });

  let r = store.addEvents([a, b]);
  assert.equal(r.added, 2);

  // Derselbe Log-Eintrag noch einmal: kein Duplikat.
  r = store.addEvents([a, ev({ source: 'torn-log', ref: 'L3' }), { kind: 'quatsch' }]);
  assert.equal(r.added, 1);
  assert.equal(r.duplicates, 1);
  assert.equal(r.invalid, 1);
  assert.equal(store.loadEvents().length, 3);
});

test('removeEvent loescht genau einen Eintrag', () => {
  reset();
  store.addEvents([ev({ id: 'a' }), ev({ id: 'b' })]);
  const rest = store.removeEvent('a');
  assert.deepEqual(rest.map((e) => e.id), ['b']);
  assert.equal(store.loadEvents().length, 1);
});

test('Export und Import sind zueinander passend', () => {
  reset();
  store.addEvents([ev({ id: 'a' }), ev({ id: 'b', kind: 'sell', unitPrice: 150 })]);
  const json = store.exportJson();

  reset();
  assert.equal(store.loadEvents().length, 0);
  const incoming = store.parseImport(json);
  assert.equal(incoming.length, 2);
  store.addEvents(incoming);
  assert.equal(store.loadEvents().length, 2);
});

test('parseImport akzeptiert auch ein blankes Array', () => {
  reset();
  const list = store.parseImport(JSON.stringify([ev()]));
  assert.equal(list.length, 1);
});

test('parseImport meldet klar, woran es liegt', () => {
  assert.throws(() => store.parseImport('kein json'), /Kein gültiges JSON/);
  assert.throws(() => store.parseImport('{"a":1}'), /events-Array/);
});

test('der Export-Merker haelt fest, wann zuletzt gesichert wurde', () => {
  reset();
  assert.equal(store.lastExport(), null);
  store.markExported();
  assert.ok(store.lastExport() > 0);
});

test('clearLedger raeumt Eintraege und Merker weg', () => {
  reset();
  store.addEvents([ev()]);
  store.markExported();
  store.clearLedger();
  assert.deepEqual(store.loadEvents(), []);
  assert.equal(store.lastExport(), null);
});

// ---------- Tabellenbau ----------

const COLS = [
  { key: 'name', label: 'Item', align: 'left', cell: (r) => ({ text: r.name }) },
  { key: 'n', label: 'Menge', cell: (r) => ({ text: String(r.n), cls: 'strong' }) },
];

test('tableHtml beschriftet jede Zelle fuer die Kartenansicht', () => {
  const { head, body } = tableHtml(COLS, [{ name: 'Xanax', n: 4 }]);
  assert.match(head, /<th class="left">Item<\/th>/);
  assert.match(body, /data-label="Item"/);
  assert.match(body, /data-label="Menge"/);
  assert.match(body, /class="num strong"/);
});

test('tableHtml escaped Textzellen', () => {
  const { body } = tableHtml(COLS, [{ name: '<img src=x onerror=alert(1)>', n: 1 }]);
  assert.ok(!body.includes('<img'));
  assert.match(body, /&lt;img/);
});

test('tableHtml laesst bewusst gesetztes Markup durch', () => {
  const cols = [{ key: 'a', label: 'A', cell: () => ({ html: '<button data-del="x">weg</button>' }) }];
  const { body } = tableHtml(cols, [{}]);
  assert.match(body, /<button data-del="x">/);
});

test('eine leere Tabelle spannt ueber alle Spalten', () => {
  const { body } = tableHtml(COLS, [], { empty: 'Nichts da.' });
  assert.match(body, /colspan="2"/);
  assert.match(body, /Nichts da\./);
});
