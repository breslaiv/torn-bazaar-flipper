// Der Sortier-Controller braucht ein DOM. Statt einer Bibliothek reicht hier
// ein Stub der drei Elemente, die installSorting anfasst - so laesst sich der
// Fehler festnageln, bei dem ein neuer Scan die gewaehlte Sortierung verwarf,
// waehrend das Bedienelement weiter die alte Auswahl anzeigte.

import test from 'node:test';
import assert from 'node:assert/strict';
import { installSorting, COLUMNS } from '../js/ui.js';

function makeDom() {
  const listeners = new Map();
  const el = (id, extra = {}) => ({
    id,
    value: '',
    textContent: '',
    setAttribute() {},
    addEventListener(type, fn) { listeners.set(`${id}:${type}`, fn); },
    ...extra,
  });
  const select = el('sortSelect');
  const dirBtn = el('sortDir');
  const headers = COLUMNS.map((col) => el(`th-${col.key}`, {
    dataset: { sort: col.key },
    classList: { toggle() {} },
  }));

  globalThis.document = {
    getElementById: (id) => ({ sortSelect: select, sortDir: dirBtn }[id] ?? null),
    querySelectorAll: () => headers,
  };
  return {
    select,
    dirBtn,
    headers,
    fire: (id, type) => listeners.get(`${id}:${type}`)?.(),
  };
}

function setup(rows) {
  const dom = makeDom();
  const state = { rows, rendered: null };
  const sorter = installSorting(() => state.rows, (sorted) => {
    state.rows = sorted;
    state.rendered = sorted;
  });
  return { dom, state, sorter };
}

const A = { itemName: 'A', buy: 300, totalProfit: 10 };
const B = { itemName: 'B', buy: 100, totalProfit: 30 };
const C = { itemName: 'C', buy: 200, totalProfit: 20 };

test('sortiert beim Aufsetzen nach Gesamtprofit absteigend', () => {
  const { state } = setup([A, B, C]);
  assert.deepEqual(state.rendered.map((r) => r.totalProfit), [30, 20, 10]);
});

test('das Auswahlfeld wechselt den Schluessel', () => {
  const { dom, state } = setup([A, B, C]);
  dom.select.value = 'buy';
  dom.fire('sortSelect', 'change');
  assert.deepEqual(state.rendered.map((r) => r.buy), [300, 200, 100]);
});

test('der Richtungsknopf dreht um und beschriftet sich passend', () => {
  const { dom, state } = setup([A, B, C]);
  assert.equal(dom.dirBtn.textContent, '↓');
  dom.fire('sortDir', 'click');
  assert.equal(dom.dirBtn.textContent, '↑');
  assert.deepEqual(state.rendered.map((r) => r.totalProfit), [10, 20, 30]);
});

test('neue Daten uebernehmen die gewaehlte Sortierung', () => {
  // Der eigentliche Fehler: nach einem Scan stand die Tabelle wieder auf
  // Gesamtprofit, obwohl das Bedienelement "Kaufpreis, aufsteigend" zeigte.
  const { dom, state, sorter } = setup([A, B, C]);
  dom.select.value = 'buy';
  dom.fire('sortSelect', 'change');
  dom.fire('sortDir', 'click');
  assert.deepEqual(state.rendered.map((r) => r.buy), [100, 200, 300]);

  state.rows = [{ itemName: 'X', buy: 900, totalProfit: 5 },
                { itemName: 'Y', buy: 50, totalProfit: 999 }];
  sorter.resort();

  assert.deepEqual(state.rendered.map((r) => r.buy), [50, 900],
    'nach dem Scan wurde nicht nach Kaufpreis aufsteigend sortiert');
  assert.deepEqual(sorter.state(), { key: 'buy', asc: true },
    'Bedienelement und tatsaechliche Sortierung muessen uebereinstimmen');
});

test('ein Klick auf denselben Spaltenkopf dreht nur die Richtung', () => {
  const { dom, state } = setup([A, B, C]);
  const buyHeader = dom.headers.find((h) => h.dataset.sort === 'buy');
  dom.fire(buyHeader.id, 'click');
  assert.deepEqual(state.rendered.map((r) => r.buy), [300, 200, 100]);
  dom.fire(buyHeader.id, 'click');
  assert.deepEqual(state.rendered.map((r) => r.buy), [100, 200, 300]);
});

test('ein Wechsel auf eine andere Spalte startet wieder absteigend', () => {
  const { dom, state, sorter } = setup([A, B, C]);
  dom.fire(dom.headers.find((h) => h.dataset.sort === 'buy').id, 'click');
  dom.fire(dom.headers.find((h) => h.dataset.sort === 'buy').id, 'click');
  assert.equal(sorter.state().asc, true);
  dom.fire(dom.headers.find((h) => h.dataset.sort === 'itemName').id, 'click');
  assert.deepEqual(sorter.state(), { key: 'itemName', asc: false });
  assert.deepEqual(state.rendered.map((r) => r.itemName), ['C', 'B', 'A']);
});
