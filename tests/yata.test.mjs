import test from 'node:test';
import assert from 'node:assert/strict';
import { parseTravelExport, fetchTravelStocks, YataError } from '../js/yata.js';

// So sieht der Export laut YATA-Doku aus. Da die Form nicht vertraglich
// zugesichert ist, muss der Parser auch die naheliegenden Abweichungen
// verkraften - sonst steht der Flugplaner beim naechsten Umbau leer da.
const EXPORT = {
  stocks: {
    mex: {
      update: 1788185840,
      stocks: [
        { id: 260, name: 'Dahlia', quantity: 320, cost: 400 },
        { id: 261, name: 'Orchid', quantity: 0, cost: 3000 },
      ],
    },
    sou: { update: 1788185800, stocks: [{ id: 266, name: 'Nixie', quantity: 40, cost: 1500 }] },
  },
};

test('der dokumentierte Export wird vollstaendig gelesen', () => {
  const { countries, updated, unknown } = parseTravelExport(EXPORT);
  assert.deepEqual([...countries.keys()].sort(), ['mex', 'sou']);
  assert.deepEqual(countries.get('mex')[0], { itemId: 260, itemName: 'Dahlia', quantity: 320, cost: 400 });
  assert.equal(countries.get('mex')[1].quantity, 0, 'ausverkauft ist eine Aussage, kein fehlender Wert');
  assert.equal(updated.get('mex'), 1788185840000, 'Sekunden werden zu Millisekunden');
  assert.deepEqual(unknown, []);
});

test('andere Feldnamen und Schachtelungen werden mitgenommen', () => {
  const anders = {
    mexico: [{ item_id: 260, item_name: 'Dahlia', stock: 12, price: 400 }],
    'south africa': { updated: 1788185800000, items: [{ id: 266, qty: 3, buy_price: 1500 }] },
  };
  const { countries, updated } = parseTravelExport(anders);
  assert.equal(countries.get('mex')[0].quantity, 12);
  assert.equal(countries.get('sou')[0].cost, 1500);
  assert.equal(countries.get('sou')[0].itemName, 'Item 266', 'ohne Namen bleibt die Id');
  assert.equal(updated.get('sou'), 1788185800000, 'Millisekunden bleiben Millisekunden');
});

test('was sich nicht zuordnen laesst, wird gemeldet statt verschluckt', () => {
  const { countries, unknown } = parseTravelExport({ stocks: { mex: { stocks: [] }, mars: { stocks: [] }, foo: 42 } });
  assert.deepEqual([...countries.keys()], ['mex']);
  assert.deepEqual(unknown.sort(), ['foo', 'mars']);
});

test('Eintraege ohne Id oder Preis sind keine Ware', () => {
  const { countries } = parseTravelExport({ stocks: { mex: { stocks: [
    { id: 1, cost: 100, quantity: 5 },
    { name: 'ohne Id', cost: 100 },
    { id: 3, cost: 0, quantity: 5 },
    null,
  ] } } });
  assert.deepEqual(countries.get('mex').map((i) => i.itemId), [1]);
});

test('eine fehlende Mengenangabe ist nicht null Stueck', () => {
  // Der Unterschied entscheidet, ob die Seite "ausverkauft" oder "unbekannt"
  // anzeigt - und ob man hinfliegt.
  const { countries } = parseTravelExport({ stocks: { mex: { stocks: [{ id: 1, cost: 100 }] } } });
  assert.equal(countries.get('mex')[0].quantity, null);
});

test('ein Netzwerkfehler nennt CORS als wahrscheinliche Ursache', async () => {
  // Genau der Fall, der beim Bauen nicht pruefbar war: YATA entscheidet, ob
  // fremde Seiten lesen duerfen. Ein nacktes "Failed to fetch" hilft niemandem.
  const original = globalThis.fetch;
  globalThis.fetch = async () => { throw new TypeError('Failed to fetch'); };
  try {
    await assert.rejects(fetchTravelStocks(), (err) => {
      assert.ok(err instanceof YataError);
      assert.match(err.message, /CORS/);
      assert.match(err.message, /von Hand/);
      return true;
    });
  } finally {
    globalThis.fetch = original;
  }
});

test('eine Antwort ohne erkennbares Land ist ein Fehler, keine leere Liste', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ stocks: { mars: { stocks: [] } } }) });
  try {
    await assert.rejects(fetchTravelStocks(), /kein Land war zu erkennen/);
  } finally {
    globalThis.fetch = original;
  }
});

test('HTTP-Fehler kommen mit ihrem Status an', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: false, status: 503 });
  try {
    await assert.rejects(fetchTravelStocks(), /503/);
  } finally {
    globalThis.fetch = original;
  }
});
