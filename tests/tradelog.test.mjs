import test from 'node:test';
import assert from 'node:assert/strict';
import { normaliseLog } from '../js/tornlog.js';
import { tradeRole, groupByTrade, resolveTrade, reconstructTrades } from '../js/tradelog.js';

// Wortwoertlich aus einem echten Log: ein Verkauf von 12x Item 1252 fuer
// 212784, also 17732 je Stueck.
const VERKAUF = [
  { id: 'i1', timestamp: 1788185840, details: { id: 4400, title: 'Trade initiate outgoing', category: 'Trades' },
    data: { user: 3608714, parsed_trade_id: 13118955, description: 'Brass Imgot @ $17,732' } },
  { id: 'i2', timestamp: 1788185853, details: { id: 4447, title: 'Trade items add', category: 'Trades' },
    data: { user: 3608714, parsed_trade_id: 13118955, items: [{ id: 1252, uid: null, qty: 12 }] } },
  { id: 'i3', timestamp: 1788185888, details: { id: 4480, title: 'Trade money add other user', category: 'Trades' },
    data: { user: 3608714, parsed_trade_id: 13118955, money: 212784, total: 212784 } },
  { id: 'i4', timestamp: 1788185969, details: { id: 4430, title: 'Trade completed', category: 'Trades' },
    data: { user: 3608714, parsed_trade_id: 13118955 } },
  { id: 'i5', timestamp: 1788185969, details: { id: 4441, title: 'Trade money incoming', category: 'Trades' },
    data: { user: 3608714, parsed_trade_id: 13118955, money: 212784 } },
];

const parse = (raw) => normaliseLog({ log: raw });

test('die Rollen kommen aus Torns Titeln, mit dem Suffix als Unterscheidung', () => {
  // "trade items add" darf nicht auch auf "trade items add other user"
  // passen - genau daran haengt die Richtung.
  assert.equal(tradeRole('Trade items add'), 'itemsMine');
  assert.equal(tradeRole('Trade items add other user'), 'itemsTheirs');
  assert.equal(tradeRole('Trade money add'), 'moneyMine');
  assert.equal(tradeRole('Trade money add other user'), 'moneyTheirs');
  assert.equal(tradeRole('Trade money incoming'), 'moneyIn');
  assert.equal(tradeRole('Trade money outgoing'), 'moneyOut');
  assert.equal(tradeRole('Trade completed'), 'completed');
  assert.equal(tradeRole('Trade comment'), null);
  assert.equal(tradeRole('Trade initiate outgoing'), null);
});

test('ein echter Verkauf wird vollstaendig rekonstruiert', () => {
  const [group] = groupByTrade(parse(VERKAUF));
  const { event, skip } = resolveTrade(group, new Map([[1252, 'Brass Ingot']]));
  assert.equal(skip, undefined, `unerwartet uebersprungen: ${skip}`);
  assert.equal(event.kind, 'sell');
  assert.equal(event.itemId, 1252);
  assert.equal(event.itemName, 'Brass Ingot');
  assert.equal(event.quantity, 12);
  assert.equal(event.unitPrice, 17732, '212784 / 12, wie im Eroeffnungstext genannt');
  assert.equal(event.counterpartyId, 3608714);
  assert.equal(event.ts, 1788185969000, 'Zeitpunkt des Abschlusses');
  assert.equal(event.ref, 'trade-13118955');
});

test('ein Kauf ist der gespiegelte Fall', () => {
  const kauf = [
    { id: 'k1', timestamp: 100, details: { id: 4482, title: 'Trade items add other user', category: 'Trades' },
      data: { user: 42, parsed_trade_id: 777, items: [{ id: 206, qty: 4 }] } },
    { id: 'k2', timestamp: 110, details: { id: 4442, title: 'Trade money add', category: 'Trades' },
      data: { user: 42, parsed_trade_id: 777, money: 2800000 } },
    { id: 'k3', timestamp: 120, details: { id: 4430, title: 'Trade completed', category: 'Trades' },
      data: { user: 42, parsed_trade_id: 777 } },
    { id: 'k4', timestamp: 120, details: { id: 4440, title: 'Trade money outgoing', category: 'Trades' },
      data: { user: 42, parsed_trade_id: 777, money: 2800000 } },
  ];
  const [group] = groupByTrade(parse(kauf));
  const { event } = resolveTrade(group);
  assert.equal(event.kind, 'buy');
  assert.equal(event.quantity, 4);
  assert.equal(event.unitPrice, 700000);
});

test('ohne Abschluss wird nichts gebucht', () => {
  // Abgebrochene Trades hinterlassen dieselben Bestueckungs-Eintraege.
  const abgebrochen = VERKAUF.filter((e) => e.details.title !== 'Trade completed');
  const [group] = groupByTrade(parse(abgebrochen));
  const r = resolveTrade(group);
  assert.equal(r.event, undefined);
  assert.match(r.skip, /ohne Abschluss/);
});

test('wieder entfernte Ware zaehlt nicht mit', () => {
  const mitRuecknahme = [
    ...VERKAUF,
    { id: 'r1', timestamp: 1788185860, details: { id: 4448, title: 'Trade items remove', category: 'Trades' },
      data: { user: 3608714, parsed_trade_id: 13118955, items: [{ id: 1252, qty: 2 }] } },
  ];
  const [group] = groupByTrade(parse(mitRuecknahme));
  const { event } = resolveTrade(group);
  assert.equal(event.quantity, 10, '12 eingelegt, 2 zurueckgenommen');
  assert.equal(event.unitPrice, 21278.4, 'der ueberwiesene Betrag bleibt der Massstab');
});

test('Ware auf beiden Seiten laesst sich nicht bewerten', () => {
  const tausch = [
    ...VERKAUF.filter((e) => e.details.title !== 'Trade money add other user'),
    { id: 't1', timestamp: 1788185860, details: { id: 4482, title: 'Trade items add other user', category: 'Trades' },
      data: { user: 3608714, parsed_trade_id: 13118955, items: [{ id: 999, qty: 1 }] } },
  ];
  const [group] = groupByTrade(parse(tausch));
  assert.match(resolveTrade(group).skip, /beiden Seiten/);
});

test('mehrere verschiedene Items werden gemeldet statt aufgeteilt', () => {
  const gemischt = [
    ...VERKAUF,
    { id: 'm1', timestamp: 1788185855, details: { id: 4447, title: 'Trade items add', category: 'Trades' },
      data: { user: 3608714, parsed_trade_id: 13118955, items: [{ id: 999, qty: 3 }] } },
  ];
  const [group] = groupByTrade(parse(gemischt));
  assert.match(resolveTrade(group).skip, /2 verschiedenen Items/);
});

test('mehrere Portionen desselben Items werden addiert', () => {
  const zweimal = [
    ...VERKAUF,
    { id: 'z1', timestamp: 1788185855, details: { id: 4447, title: 'Trade items add', category: 'Trades' },
      data: { user: 3608714, parsed_trade_id: 13118955, items: [{ id: 1252, qty: 8 }] } },
  ];
  const [group] = groupByTrade(parse(zweimal));
  const { event } = resolveTrade(group);
  assert.equal(event.quantity, 20);
});

test('ein reiner Geldtransfer ist kein Handel', () => {
  const nurGeld = [
    { id: 'g1', timestamp: 100, details: { id: 4430, title: 'Trade completed', category: 'Trades' },
      data: { user: 1, parsed_trade_id: 5 } },
    { id: 'g2', timestamp: 100, details: { id: 4441, title: 'Trade money incoming', category: 'Trades' },
      data: { user: 1, parsed_trade_id: 5, money: 1000 } },
  ];
  const [group] = groupByTrade(parse(nurGeld));
  assert.match(resolveTrade(group).skip, /ohne Ware/);
});

test('Ware ohne Geld wird nicht als Gratisgewinn gebucht', () => {
  const geschenk = VERKAUF.filter((e) => !/money/i.test(e.details.title));
  const [group] = groupByTrade(parse(geschenk));
  assert.match(resolveTrade(group).skip, /ohne Gegenwert/);
});

test('mehrere Trades werden getrennt gehalten', () => {
  const zwei = [
    ...VERKAUF,
    { id: 'x1', timestamp: 200, details: { id: 4447, title: 'Trade items add', category: 'Trades' },
      data: { user: 9, parsed_trade_id: 888, items: [{ id: 5, qty: 2 }] } },
    { id: 'x2', timestamp: 210, details: { id: 4430, title: 'Trade completed', category: 'Trades' },
      data: { user: 9, parsed_trade_id: 888 } },
    { id: 'x3', timestamp: 210, details: { id: 4441, title: 'Trade money incoming', category: 'Trades' },
      data: { user: 9, parsed_trade_id: 888, money: 500 } },
  ];
  const { events, groups } = reconstructTrades(parse(zwei), new Map());
  assert.equal(groups, 2);
  assert.equal(events.length, 2);
  assert.deepEqual(events.map((e) => e.ref).sort(), ['trade-13118955', 'trade-888']);
});

test('reconstructTrades nennt die Gruende fuer Uebersprungenes', () => {
  const abgebrochen = VERKAUF.filter((e) => e.details.title !== 'Trade completed');
  const report = reconstructTrades(parse(abgebrochen));
  assert.equal(report.events.length, 0);
  assert.equal(report.skipped[0].count, 1);
  assert.match(report.skipped[0].reason, /ohne Abschluss/);
  assert.ok(report.skipped[0].sample, 'ein Rohbeispiel gehoert dazu');
});

test('Nicht-Trade-Eintraege werden ignoriert', () => {
  const gemischt = parse([
    ...VERKAUF,
    { id: 'b1', timestamp: 1, details: { id: 1226, title: 'Bazaar sell', category: 'Bazaars' },
      data: { items: [{ id: 196, qty: 1 }], cost_each: 100 } },
  ]);
  assert.equal(groupByTrade(gemischt).length, 1);
});

test('derselbe Trade ergibt bei erneutem Import dieselbe Referenz', () => {
  const a = reconstructTrades(parse(VERKAUF)).events[0];
  const b = reconstructTrades(parse(VERKAUF)).events[0];
  assert.equal(a.ref, b.ref, 'sonst waechst der Ledger bei jedem Import');
});
