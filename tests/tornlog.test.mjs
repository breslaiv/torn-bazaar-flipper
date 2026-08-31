import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normaliseLog, normaliseLogTypes, normaliseLogCategories, deriveLogTypes, deriveCategories,
  classify, mapEntry, inspect, RULES,
} from '../js/tornlog.js';

// Die echte Typenliste aus Torn, gekuerzt auf das Wesentliche plus die
// Trade-Typen, die den Serverfilter gesprengt haben.
const REAL_TYPES = [
  { id: 1103, title: 'Item market buy (old)' }, { id: 1104, title: 'Item market sell (old)' },
  { id: 1112, title: 'Item market buy' }, { id: 1113, title: 'Item market sell' },
  { id: 1220, title: 'Bazaar buy (legacy)' }, { id: 1221, title: 'Bazaar sell (legacy)' },
  { id: 1225, title: 'Bazaar buy' }, { id: 1226, title: 'Bazaar sell' },
  { id: 4400, title: 'Trade initiate outgoing' }, { id: 4410, title: 'Trade cancel outgoing' },
  { id: 4412, title: 'Trade decline outgoing' }, { id: 4420, title: 'Trade expire' },
  { id: 4430, title: 'Trade completed' }, { id: 4431, title: 'Trade accepted' },
  { id: 4440, title: 'Trade money outgoing' }, { id: 4442, title: 'Trade money add' },
  { id: 4445, title: 'Trade items outgoing' }, { id: 4446, title: 'Trade items incoming' },
  { id: 4447, title: 'Trade items add' }, { id: 4460, title: 'Trade NAPs (legacy)' },
  { id: 4465, title: 'Trade peace treaties' }, { id: 4470, title: 'Trade faction outgoing' },
  { id: 4475, title: 'Trade company outgoing' }, { id: 4498, title: 'Trade comment' },
  { id: 8150, title: 'Attack won' },
];

test('nur Kategorien mit Warenbewegung werden gelesen', () => {
  // Aus einem echten Abzug: 100 Eintraege, davon 8 relevant. Der Rest waren
  // Crimes, Company, Nachrichten. Ohne Kategoriefilter liest man am Ziel vorbei.
  const cats = deriveCategories([
    { id: 1, title: 'Bazaars' }, { id: 2, title: 'Item market' }, { id: 3, title: 'Trades' },
    { id: 4, title: 'Crimes' }, { id: 5, title: 'Company' }, { id: 6, title: 'Messages' },
    { id: 7, title: 'Attacking' }, { id: 8, title: 'Shops' },
  ]);
  assert.deepEqual(cats.map((c) => c.title), ['Bazaars', 'Item market', 'Trades']);
});

test('normaliseLogCategories versteht Array und Objektform', () => {
  assert.deepEqual(normaliseLogCategories({ logcategories: [{ id: 3, title: 'Trades' }] }),
    [{ id: 3, title: 'Trades' }]);
  assert.deepEqual(normaliseLogCategories({ 3: 'Trades' }), [{ id: 3, title: 'Trades' }]);
  assert.deepEqual(normaliseLogCategories({}), []);
});

test('die vier Trade-Typen mit Warenbewegung bleiben im Bericht', () => {
  const { byId } = deriveLogTypes(REAL_TYPES);
  for (const id of [4430, 4431, 4445, 4446]) {
    assert.equal(byId.get(id), 'trade', `Typ ${id} fehlt`);
  }
});

test('alle Kauf- und Verkaufstypen bleiben erhalten', () => {
  const { byId } = deriveLogTypes(REAL_TYPES);
  for (const id of [1103, 1112, 1220, 1225]) assert.equal(byId.get(id), 'buy', `Typ ${id}`);
  for (const id of [1104, 1113, 1221, 1226]) assert.equal(byId.get(id), 'sell', `Typ ${id}`);
});

// Wortwoertlich aus einem echten Log-Eintrag.
const REAL_TRADE_COMPLETED = {
  id: 'fHSU6t6nBYFJuYORf5ND', timestamp: 1788185437,
  details: { id: 4430, title: 'Trade completed', category: 'Trades' },
  data: {
    italic: 1, color: 'green', user: 3459156,
    trade_id: '[<a href = "/trade.php#step=view&ID=13118650"target = "_self">view</a>]',
    parsed_trade_id: 13118650,
  },
};

test('ein echtes "Trade completed" traegt weder Items noch Betrag', () => {
  // Damit ist der Eintrag allein nie buchbar - Ware und Geld stehen in den
  // Zwischenschritten desselben Trades.
  const [e] = normaliseLog({ log: [REAL_TRADE_COMPLETED] });
  const r = mapEntry(e, new Map(), new Map([[4430, 'trade']]));
  assert.equal(r.event, undefined);
  assert.match(r.skip, /Richtung/);
  assert.equal(e.data.parsed_trade_id, 13118650, 'die Trade-Id verbindet die Zwischenschritte');
});

test('inspect liefert je Titel ein eigenes Rohbeispiel', () => {
  // 80 uebersprungene Eintraege aus fuenfzehn Titeln teilten sich vorher eins.
  const entries = normaliseLog({ log: [
    REAL_TRADE_COMPLETED,
    { id: 'c1', timestamp: 1, details: { id: 6284, title: 'Company deposit', category: 'Company' }, data: { deposited: 1 } },
    { id: 'c2', timestamp: 2, details: { id: 6284, title: 'Company deposit', category: 'Company' }, data: { deposited: 2 } },
  ] });
  const report = inspect(entries);
  const unresolved = report.categories.filter((c) => !c.imported);
  assert.equal(unresolved.length, 2, 'zwei verschiedene Titel');
  for (const c of unresolved) assert.ok(c.sample?.data, `kein Beispiel fuer ${c.key}`);
});

// Form laut OpenAPI 6.13.1: Titel und Kategorie stecken unter details.
const raw = (over = {}) => ({
  id: 'abc123',
  timestamp: 1700000000,
  details: { id: 5360, title: 'Bazaar buy', category: 'Bazaar' },
  data: { item: 206, quantity: 4, cost: 2800000, seller: 12 },
  params: {},
  ...over,
});

const entry = (over = {}) => normaliseLog({ log: [raw(over)] })[0];

test('normaliseLog liest Titel und Kategorie aus details', () => {
  // Frueher standen sie faelschlich auf der obersten Ebene erwartet - damit
  // haette der Import gegen die echte API nie etwas erkannt.
  const [e] = normaliseLog({ log: [raw()] });
  assert.equal(e.title, 'Bazaar buy');
  assert.equal(e.category, 'Bazaar');
  assert.equal(e.typeId, 5360);
  assert.equal(e.id, 'abc123');
  assert.equal(e.ts, 1700000000000, 'Sekunden werden zu Millisekunden');
});

test('normaliseLog legt params und data zusammen', () => {
  const [e] = normaliseLog({ log: [raw({ params: { seller: 99, extra: 1 }, data: { item: 5, seller: 12 } })] });
  assert.equal(e.data.extra, 1, 'params bleibt erhalten');
  assert.equal(e.data.seller, 12, 'data gewinnt bei Kollision');
});

test('normaliseLog vertraegt eine leere oder kaputte Antwort', () => {
  assert.deepEqual(normaliseLog({}), []);
  assert.deepEqual(normaliseLog({ log: null }), []);
  assert.deepEqual(normaliseLog({ log: [null, 5, 'x'] }), []);
  assert.deepEqual(normaliseLog(null), []);
});

test('normaliseLog kommt auch ohne details zurecht', () => {
  const [e] = normaliseLog({ log: [{ id: 'x', timestamp: 1, title: 'Alt', category: 'Bazaar' }] });
  assert.equal(e.title, 'Alt');
  assert.equal(e.category, 'Bazaar');
});

test('normaliseLogTypes versteht Array und Objektform', () => {
  assert.deepEqual(
    normaliseLogTypes({ logtypes: [{ id: 5360, title: 'Bazaar buy' }] }),
    [{ id: 5360, title: 'Bazaar buy' }],
  );
  assert.deepEqual(
    normaliseLogTypes({ 4900: 'Item market buy' }),
    [{ id: 4900, title: 'Item market buy' }],
  );
  assert.deepEqual(normaliseLogTypes({}), []);
});

test('deriveLogTypes bildet Torns eigene Typen auf Kauf und Verkauf ab', () => {
  const { byId, matched } = deriveLogTypes([
    { id: 5360, title: 'Bazaar buy' },
    { id: 5361, title: 'Bazaar sell' },
    { id: 4900, title: 'Item market buy' },
    { id: 8150, title: 'Attack won' },
    { id: 1000, title: 'Jail bust' },
  ]);
  assert.equal(byId.get(5360), 'buy');
  assert.equal(byId.get(5361), 'sell');
  assert.equal(byId.get(4900), 'buy');
  assert.equal(byId.has(8150), false, 'irrelevante Typen bleiben draussen');
  assert.equal(matched.length, 3);
  assert.ok(matched.every((m) => m.title && m.kind));
});

test('deriveLogTypes liefert eine leere Auswahl statt zu raten', () => {
  const { byId, matched } = deriveLogTypes([{ id: 1, title: 'Gym train' }]);
  assert.equal(byId.size, 0);
  assert.deepEqual(matched, []);
});

test('classify bevorzugt die Typ-Id vor dem Titel', () => {
  const byId = new Map([[5360, 'sell']]);
  // Der Titel saehe nach Kauf aus; die Id von Torn hat Vorrang.
  assert.equal(classify(entry(), byId), 'sell');
  assert.equal(classify(entry()), 'buy', 'ohne Id-Tabelle greift der Titel');
});

test('classify laesst Unbekanntes unbeantwortet', () => {
  assert.equal(classify(entry({ details: { id: 1, title: 'Attack won', category: 'Attacking' } })), null);
});

test('mapEntry rechnet die Summe auf den Stueckpreis herunter', () => {
  const { event } = mapEntry(entry());
  assert.equal(event.kind, 'buy');
  assert.equal(event.itemId, 206);
  assert.equal(event.quantity, 4);
  assert.equal(event.unitPrice, 700000);
  assert.equal(event.counterpartyId, 12);
  assert.equal(event.source, 'torn-log');
  assert.equal(event.ref, 'abc123');
});

// Wortwoertlich aus einem echten Log-Eintrag.
const REAL_BAZAAR_SELL = {
  id: 'zGxCCTdTIB637jMzb8oa',
  timestamp: 1788167064,
  details: { id: 1226, title: 'Bazaar sell', category: 'Bazaars' },
  data: {
    italic: 1, color: 'green', buyer: 3814288,
    items: [{ id: 196, uid: null, qty: 28 }],
    cost_each: 6590, cost_total: 184520,
  },
};

test('ein echter Bazaar-Verkauf wird vollstaendig gelesen', () => {
  const [e] = normaliseLog({ log: [REAL_BAZAAR_SELL] });
  const { event, skip } = mapEntry(e, new Map([[196, 'Drug Pack']]),
    new Map([[1226, 'sell']]));
  assert.equal(skip, undefined, `unerwartet uebersprungen: ${skip}`);
  assert.equal(event.kind, 'sell');
  assert.equal(event.itemId, 196);
  assert.equal(event.itemName, 'Drug Pack');
  assert.equal(event.quantity, 28);
  assert.equal(event.unitPrice, 6590);
  assert.equal(event.counterpartyId, 3814288);
  assert.equal(event.ts, 1788167064000);
});

test('cost_each wird der Division vorgezogen', () => {
  // Beides fuehrt hier zum selben Wert; bei krummen Summen nicht mehr.
  const [e] = normaliseLog({ log: [REAL_BAZAAR_SELL] });
  assert.equal(mapEntry(e, new Map(), new Map([[1226, 'sell']])).event.unitPrice, 6590);

  const krumm = { ...REAL_BAZAAR_SELL, data: { ...REAL_BAZAAR_SELL.data, cost_each: 333, cost_total: 1000 } };
  const [e2] = normaliseLog({ log: [krumm] });
  assert.equal(mapEntry(e2, new Map(), new Map([[1226, 'sell']])).event.unitPrice, 333);
});

test('ohne cost_each bleibt die Division als Rueckfall', () => {
  const ohne = {
    ...REAL_BAZAAR_SELL,
    data: { items: [{ id: 196, qty: 4 }], cost_total: 2000 },
  };
  const [e] = normaliseLog({ log: [ohne] });
  assert.equal(mapEntry(e, new Map(), new Map([[1226, 'sell']])).event.unitPrice, 500);
});

test('Trades werden nicht blind als Verkauf gebucht', () => {
  // Ueber einen Trade kann man genauso einkaufen. Als Verkauf gebucht waere
  // ein Einkauf reiner Fantasiegewinn - lieber melden.
  const trade = {
    id: 't1', timestamp: 1788167064,
    details: { id: 4431, title: 'Trade accepted', category: 'Trades' },
    data: { trade_id: 55, user: 3814288 },
  };
  const [e] = normaliseLog({ log: [trade] });
  const r = mapEntry(e);
  assert.equal(r.event, undefined);
  assert.match(r.skip, /Richtung/);
});

test('deriveLogTypes ordnet die echten Torn-Titel zu', () => {
  const { byId } = deriveLogTypes([
    { id: 1103, title: 'Item market buy (old)' },
    { id: 1112, title: 'Item market buy' },
    { id: 1113, title: 'Item market sell' },
    { id: 1220, title: 'Bazaar buy (legacy)' },
    { id: 1225, title: 'Bazaar buy' },
    { id: 1226, title: 'Bazaar sell' },
    { id: 4430, title: 'Trade completed' },
    { id: 4431, title: 'Trade accepted' },
    { id: 8150, title: 'Attack won' },
  ]);
  assert.equal(byId.get(1103), 'buy');
  assert.equal(byId.get(1112), 'buy');
  assert.equal(byId.get(1113), 'sell');
  assert.equal(byId.get(1220), 'buy');
  assert.equal(byId.get(1225), 'buy');
  assert.equal(byId.get(1226), 'sell');
  assert.equal(byId.get(4430), 'trade', 'Richtung offen, nicht geraten');
  assert.equal(byId.get(4431), 'trade');
  assert.equal(byId.has(8150), false);
});

test('inspect trennt "Typ bekannt" von "Daten gelesen"', () => {
  // Genau dieser Unterschied fehlte im ersten Bericht: die Typen stimmten,
  // die Betragsfelder hiessen anders.
  const ohneBetrag = { ...REAL_BAZAAR_SELL, data: { items: [{ id: 196, qty: 28 }] } };
  const report = inspect(normaliseLog({ log: [ohneBetrag] }), new Map(), new Map([[1226, 'sell']]));
  const cat = report.categories[0];
  assert.equal(cat.classified, true);
  assert.equal(cat.imported, false);
  assert.equal(report.skipped[0].reason, 'kein Betrag im Eintrag');
});

test('jeder Grund traegt ein Rohbeispiel mit', () => {
  const entries = normaliseLog({ log: [
    { ...REAL_BAZAAR_SELL, id: 'x', data: { items: [{ id: 1, qty: 1 }] } },
    { id: 't', timestamp: 1, details: { id: 4431, title: 'Trade accepted', category: 'Trades' }, data: {} },
  ] });
  const report = inspect(entries, new Map(), new Map([[1226, 'sell'], [4431, 'trade']]));
  assert.equal(report.skipped.length, 2);
  for (const s of report.skipped) {
    assert.ok(s.sample && s.sample.data, `kein Rohbeispiel fuer "${s.reason}"`);
  }
});

test('mapEntry nimmt Itemnamen aus dem Katalog, wenn vorhanden', () => {
  assert.equal(mapEntry(entry(), new Map([[206, 'Xanax']])).event.itemName, 'Xanax');
  assert.equal(mapEntry(entry()).event.itemName, 'Item 206');
});

test('mapEntry kommt mit abweichenden Feldnamen zurecht', () => {
  const { event } = mapEntry(entry({ data: { item_id: 4, amount: 2, price: 1000 } }));
  assert.equal(event.itemId, 4);
  assert.equal(event.unitPrice, 500);
});

test('mapEntry versteht ein einzelnes Item in einem items-Array', () => {
  const { event } = mapEntry(entry({ data: { items: [{ id: 9, qty: 5 }], cost: 500 } }));
  assert.equal(event.itemId, 9);
  assert.equal(event.unitPrice, 100);
});

test('mehrere Items in einem Vorgang werden gemeldet statt geraten', () => {
  const r = mapEntry(entry({ data: { items: [{ id: 1, qty: 1 }, { id: 2, qty: 1 }], cost: 500 } }));
  assert.equal(r.event, undefined);
  assert.match(r.skip, /mehrere Items/);
});

test('unvollstaendige Eintraege nennen ihren Grund', () => {
  assert.match(mapEntry(entry({ data: { quantity: 1, cost: 5 } })).skip, /Item-ID/);
  assert.match(mapEntry(entry({ data: { item: 1, quantity: 1 } })).skip, /Betrag/);
  assert.match(mapEntry(entry({ data: { item: 1, quantity: 0, cost: 5 } })).skip, /Menge/);
  assert.match(
    mapEntry(entry({ details: { id: 1, title: 'Jail bust', category: 'Jail' } })).skip,
    /unbekannter Log-Typ/,
  );
});

test('inspect trennt Erkanntes von Unerkanntem und zaehlt beides', () => {
  const entries = normaliseLog({ log: [
    raw(),
    raw({ id: 'b' }),
    raw({ id: 'c', details: { id: 8150, title: 'Attack won', category: 'Attacking' }, data: {} }),
    raw({ id: 'd', details: { id: 8150, title: 'Attack won', category: 'Attacking' }, data: {} }),
  ] });
  const report = inspect(entries);
  assert.equal(report.events.length, 2);
  assert.equal(report.skipped[0].count, 2);
  assert.equal(report.categories.find((c) => c.key.startsWith('Attacking')).imported, false);
  assert.equal(report.categories.find((c) => c.key.startsWith('Bazaar')).imported, true);
});

test('inspect nutzt die Typ-Tabelle, wenn sie uebergeben wird', () => {
  const entries = normaliseLog({ log: [
    raw({ details: { id: 9999, title: 'Etwas Neues', category: 'Sonstiges' } }),
  ] });
  assert.equal(inspect(entries).events.length, 0, 'ohne Tabelle unbekannt');
  assert.equal(inspect(entries, new Map(), new Map([[9999, 'buy']])).events.length, 1);
});

test('die Regeln greifen auf Titel, wie Torn sie schreibt', () => {
  const titles = [
    ['Bazaar buy', 'buy'],
    ['Bazaar sell', 'sell'],
    ['Item market buy', 'buy'],
    ['Item market sell', 'sell'],
    ['Item market buy (old)', 'buy'],
    ['Bazaar buy (legacy)', 'buy'],
    ['Trade completed', 'trade'],
    ['Attack won', null],
  ];
  for (const [title, expected] of titles) {
    const rule = RULES.find((r) => r.title.test(title));
    assert.equal(rule ? rule.kind : null, expected, title);
  }
});
