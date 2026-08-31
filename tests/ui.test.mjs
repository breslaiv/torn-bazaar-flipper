import test from 'node:test';
import assert from 'node:assert/strict';
import {
  COLUMNS, headToHtml, rowsToHtml, sortOptionsToHtml, sortRows, fmtMoney, fmtPct, escapeHtml,
} from '../js/ui.js';

const row = {
  itemId: 206,
  itemName: 'Xanax',
  buy: 700000,
  units: 4,
  quantity: 4,
  sellerId: 12,
  sellerName: 'CheapSeller',
  buyerId: 92,
  buyerName: 'GoodBuyer',
  buyerRating: 39,
  reference: 780000,
  sellNet: 780000,
  profitPerUnit: 80000,
  profitPct: 11.43,
  totalProfit: 320000,
  sponsored: false,
  suspicious: false,
};

test('Spaltenschluessel sind eindeutig', () => {
  const keys = COLUMNS.map((c) => c.key);
  assert.equal(new Set(keys).size, keys.length);
});

test('Kopfzeile und Auswahlfeld stammen aus derselben Definition', () => {
  const head = headToHtml();
  const sortAttrs = [...head.matchAll(/data-sort="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(sortAttrs, COLUMNS.map((c) => c.key));

  const options = [...sortOptionsToHtml().matchAll(/value="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(options, COLUMNS.map((c) => c.key));
});

test('jede Zelle traegt ihr Label - sonst ist die Kartenansicht unbeschriftet', () => {
  const html = rowsToHtml([row]);
  const labels = [...html.matchAll(/data-label="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(labels, COLUMNS.map((c) => c.label));
});

test('leere Trefferliste spannt ueber alle Spalten', () => {
  assert.match(rowsToHtml([]), new RegExp(`colspan="${COLUMNS.length}"`));
});

test('Itemnamen werden escaped, nicht als HTML eingesetzt', () => {
  const html = rowsToHtml([{ ...row, itemName: '<img src=x onerror=alert(1)>' }]);
  assert.ok(!html.includes('<img'), 'Rohes <img> im Markup gelandet');
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
});

test('Verkaeufer- und Kaeufernamen werden ebenfalls escaped', () => {
  const html = rowsToHtml([{ ...row, sellerName: '"><script>x</script>', buyerName: '<b>bold</b>' }]);
  assert.ok(!html.includes('<script>'));
  assert.ok(!html.includes('<b>bold</b>'));
});

test('Spieler-IDs landen unveraendert im Link', () => {
  const html = rowsToHtml([row]);
  assert.match(html, /bazaar\.php\?userId=12"/);
  assert.match(html, /trade\.php#step=start&userID=92"/);
});

test('fehlende Gegenpartei ergibt einen Strich statt eines toten Links', () => {
  const html = rowsToHtml([{ ...row, sellerId: null, buyerId: null }]);
  assert.ok(!html.includes('bazaar.php'));
  assert.ok(!html.includes('trade.php'));
});

test('Verlustzeilen werden rot markiert, Gewinnzeilen gruen', () => {
  assert.match(rowsToHtml([row]), /class="num strong pos"/);
  assert.match(rowsToHtml([{ ...row, profitPerUnit: -5 }]), /class="num strong neg"/);
});

test('Marker erscheinen am Itemnamen', () => {
  const html = rowsToHtml([{ ...row, sponsored: true, suspicious: true, itemMarketLow: 750000 }]);
  assert.match(html, /gesponsert/);
  assert.match(html, /prüfen/);
  assert.match(html, /IM \$750,000/);
});

test('sortRows sortiert Zahlen in beide Richtungen', () => {
  const rows = [{ totalProfit: 10 }, { totalProfit: 90 }, { totalProfit: 50 }];
  assert.deepEqual(sortRows(rows, 'totalProfit', false).map((r) => r.totalProfit), [90, 50, 10]);
  assert.deepEqual(sortRows(rows, 'totalProfit', true).map((r) => r.totalProfit), [10, 50, 90]);
});

test('sortRows sortiert Text und vertraegt fehlende Werte', () => {
  const rows = [{ itemName: 'Beta' }, { itemName: 'Alpha' }, {}];
  assert.deepEqual(sortRows(rows, 'itemName', true).map((r) => r.itemName), [undefined, 'Alpha', 'Beta']);
});

test('sortRows laesst die Vorlage unangetastet', () => {
  const rows = [{ totalProfit: 1 }, { totalProfit: 2 }];
  sortRows(rows, 'totalProfit', false);
  assert.deepEqual(rows.map((r) => r.totalProfit), [1, 2]);
});

test('Formatierung', () => {
  assert.equal(fmtMoney(1234567), '$1,234,567');
  assert.equal(fmtMoney(-500), '-$500');
  assert.equal(fmtMoney(NaN), '—');
  assert.equal(fmtPct(11.43), '11.4%');
  assert.equal(escapeHtml('<&">'), '&lt;&amp;&quot;&gt;');
});
