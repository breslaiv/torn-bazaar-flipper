import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseTravelExport, fetchTravelStocks, travelUrl, YataError, YATA_URL,
} from '../js/yata.js';

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

// ---------- Adresse ----------

test('ohne Angabe gilt die Vorgabe', () => {
  assert.equal(String(travelUrl({})), YATA_URL);
  assert.equal(String(travelUrl({ yataUrl: '  ' })), YATA_URL);
});

test('die Adresse bleibt ohne Query-Parameter', () => {
  // YATA cacht die Antwort bis zum naechsten Import und sagt ausdruecklich:
  // genau diese URL aufrufen, keine Variante davon. Ein angehaengter
  // Parameter - auch ein harmloser Cache-Buster - liefe an der
  // zwischengespeicherten Antwort vorbei.
  assert.equal(String(travelUrl({ yataUrl: 'https://yata.yt/api/v1/travel/export/?key=abc' })),
    'https://yata.yt/api/v1/travel/export/');
  assert.equal(String(travelUrl({ yataUrl: 'https://yata.yt/api/v1/travel/export/#travel' })),
    'https://yata.yt/api/v1/travel/export/');
  assert.equal(String(travelUrl({ yataKey: 'abc123' })), YATA_URL, 'ein Key gehoert nicht an diese Route');
});

test('die Vorgabe ist die dokumentierte Route', () => {
  assert.equal(YATA_URL, 'https://yata.yt/api/v1/travel/export/');
});

test('eine andere Route auf demselben Host ist erlaubt', () => {
  // Der Sinn der Einstellung: aendert YATA die Route, laesst sie sich ohne
  // neuen Deploy korrigieren.
  assert.equal(String(travelUrl({ yataUrl: 'https://yata.yt/api/v1/travel/export/v2/' })),
    'https://yata.yt/api/v1/travel/export/v2/');
});

test('weav3r ist als Quelle ebenfalls zugelassen', () => {
  // Deren Website zeigt Auslandsvorraete an; sobald die Route bekannt ist,
  // soll die Umstellung eine Einstellung sein und kein Deployment.
  const url = travelUrl({ yataUrl: 'https://weav3r.dev/api/travel/stocks?limit=100' });
  assert.equal(url.hostname, 'weav3r.dev');
  assert.equal(url.searchParams.get('limit'), '100',
    'Parameter bleiben hier stehen - der Cache-Hinweis gilt nur für YATA');
});

test('ein fremder Host wird benannt, nicht durchgereicht', () => {
  // Die CSP dieser Seiten laesst nur die beiden bekannten Hosts durch. Ohne
  // diese Pruefung saehe die Blockade spaeter wie ein Netzwerkfehler aus.
  for (const url of ['https://example.com/export/', 'http://yata.yt/api/', 'https://evil.yata.yt.example/']) {
    assert.throws(() => travelUrl({ yataUrl: url }), (err) => {
      assert.ok(err instanceof YataError);
      assert.match(err.message, /yata\.yt/);
      return true;
    }, url);
  }
  assert.throws(() => travelUrl({ yataUrl: 'kaputt' }), /keine gültige Adresse/);
});

test('die Einstellungen bestimmen, was abgerufen wird', async () => {
  const original = globalThis.fetch;
  let gesehen = null;
  globalThis.fetch = async (url) => {
    gesehen = String(url);
    return { ok: true, json: async () => EXPORT };
  };
  try {
    await fetchTravelStocks({ settings: { yataUrl: 'https://yata.yt/api/v1/travel/export/?x=1' } });
    assert.equal(gesehen, 'https://yata.yt/api/v1/travel/export/', 'ohne Parameter, sonst am Cache vorbei');
  } finally {
    globalThis.fetch = original;
  }
});

// ---------- Zeitstempel der Nutzlast ----------

test('der Zeitstempel der Nutzlast gilt, wo ein Land keinen eigenen hat', () => {
  const { updated, payloadAt } = parseTravelExport({
    timestamp: 1788185900,
    stocks: {
      mex: { update: 1788185840, stocks: [{ id: 1, cost: 1, quantity: 1 }] },
      cay: { stocks: [{ id: 2, cost: 1, quantity: 1 }] },
    },
  });
  assert.equal(payloadAt, 1788185900000);
  assert.equal(updated.get('mex'), 1788185840000, 'das Land kennt seinen eigenen Stand');
  assert.equal(updated.get('cay'), 1788185900000, 'sonst gilt der der Nutzlast');
});

test('eine zwischengespeicherte Antwort ist keine neue Messung', async () => {
  // YATA liefert bis zum naechsten Import dieselbe Nutzlast. Wuerde jeder
  // Abruf als eigene Messung zaehlen, entstuende aus lauter gleichen Mengen
  // ein Abverkauf von null - und die Vorhersage saehe zuversichtlich aus,
  // ohne dass jemand hingeschaut hat.
  const { recordSnapshot, seriesFor, estimate } = await import('../js/travelStock.js');
  const payload = {
    timestamp: 1788185900,
    stocks: { mex: { update: 1788185840, stocks: [{ id: 260, name: 'Dahlia', quantity: 300, cost: 400 }] } },
  };

  const { countries, updated } = parseTravelExport(payload);
  let store = {};
  for (let i = 0; i < 5; i++) {
    store = recordSnapshot(store, 'mex', countries.get('mex'), updated.get('mex'));
  }
  assert.equal(seriesFor(store, 'mex', 260).length, 1, 'fünf Abrufe derselben Antwort, eine Messung');
  assert.equal(estimate(seriesFor(store, 'mex', 260)).drainPerMinute, null);
});
