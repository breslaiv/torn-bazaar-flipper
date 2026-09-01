// Der Panel-Speicher fasst localStorage an. Der darf fehlen, gesperrt sein
// oder Muell enthalten - in keinem dieser Faelle darf die Seite stehenbleiben.

import test from 'node:test';
import assert from 'node:assert/strict';
import { loadPanelState, setPanelState, panelKey, restorePanels } from '../js/panels.js';

function fakeStorage(initial = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (k) => (data.has(k) ? data.get(k) : null),
    setItem: (k, v) => data.set(k, String(v)),
    _dump: () => Object.fromEntries(data),
  };
}

function fakeDetails(id, open = false) {
  const listeners = [];
  return {
    id,
    open,
    tagName: 'DETAILS',
    addEventListener: (type, fn) => listeners.push([type, fn]),
    toggle() {
      this.open = !this.open;
      for (const [type, fn] of listeners) if (type === 'toggle') fn();
    },
  };
}

const fakeRoot = (panels) => ({ querySelectorAll: () => panels });

test('Zustand wird je Seite getrennt gehalten', () => {
  const storage = fakeStorage();
  setPanelState('index', 'settingsPanel', true, storage);
  setPanelState('travel', 'settingsPanel', false, storage);

  assert.equal(loadPanelState('index', storage).get('settingsPanel'), true);
  assert.equal(loadPanelState('travel', storage).get('settingsPanel'), false);
});

test('ein Schluessel mit Doppelpunkt im Namen zerfaellt nicht', () => {
  const storage = fakeStorage();
  setPanelState('index', 'a:b', true, storage);
  assert.equal(loadPanelState('index', storage).get('a:b'), true);
  assert.equal(panelKey('index', 'a:b'), 'index:a:b');
});

test('kaputter Speicherinhalt liefert einen leeren Zustand', () => {
  const storage = fakeStorage({ 'tbf.panels.v1': '{kein json' });
  assert.equal(loadPanelState('index', storage).size, 0);
});

test('ein Speicher, der nur Unsinn enthaelt, wird ignoriert', () => {
  const storage = fakeStorage({ 'tbf.panels.v1': '"eine Zeichenkette"' });
  assert.equal(loadPanelState('index', storage).size, 0);
});

test('ohne Speicher passiert nichts Schlimmes', () => {
  assert.equal(loadPanelState('index', null).size, 0);
  assert.doesNotThrow(() => setPanelState('index', 'x', true, null));
});

test('gespeicherter Zustand schlaegt die Vorgabe', () => {
  const storage = fakeStorage();
  setPanelState('index', 'settingsPanel', true, storage);

  const panel = fakeDetails('settingsPanel', false);
  restorePanels({
    page: 'index', root: fakeRoot([panel]), storage, defaults: { settingsPanel: false },
  });
  assert.equal(panel.open, true);
});

test('ohne gespeicherten Zustand greift die Vorgabe', () => {
  const panel = fakeDetails('importPanel', false);
  restorePanels({
    page: 'ledger', root: fakeRoot([panel]), storage: fakeStorage(), defaults: { importPanel: true },
  });
  assert.equal(panel.open, true);
});

test('was weder gemerkt noch vorgegeben ist, behaelt den Zustand aus dem Markup', () => {
  const panel = fakeDetails('sourcePanel', true);
  restorePanels({ page: 'travel', root: fakeRoot([panel]), storage: fakeStorage() });
  assert.equal(panel.open, true);
});

test('Auf- und Zuklappen wird gemerkt', () => {
  const storage = fakeStorage();
  const panel = fakeDetails('itemPanel', false);
  restorePanels({ page: 'travel', root: fakeRoot([panel]), storage });

  panel.toggle();
  assert.equal(loadPanelState('travel', storage).get('itemPanel'), true);

  panel.toggle();
  assert.equal(loadPanelState('travel', storage).get('itemPanel'), false);
});

test('ein schreibgeschuetzter Speicher wirft nicht durch', () => {
  // Safari im privaten Modus laesst setItem werfen.
  const storage = {
    getItem: () => null,
    setItem: () => { throw new Error('QuotaExceededError'); },
  };
  const panel = fakeDetails('itemPanel', false);
  restorePanels({ page: 'travel', root: fakeRoot([panel]), storage });
  assert.doesNotThrow(() => panel.toggle());
});
