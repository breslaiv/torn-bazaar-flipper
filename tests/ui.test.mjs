import test from 'node:test';
import assert from 'node:assert/strict';
import {
  COLUMNS, headToHtml, rowsToHtml, sortOptionsToHtml, sortRows, itemUrl,
  fmtMoney, fmtPct, escapeHtml,
} from '../js/ui.js';

const W3B = { itemUrlTemplate: 'https://weav3r.dev/marketplace/{ITEM_ID}' };

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


test('itemUrl setzt die Item-ID ein', () => {
  assert.equal(itemUrl('https://weav3r.dev/marketplace/{ITEM_ID}', 206),
    'https://weav3r.dev/marketplace/206');
  assert.equal(itemUrl('https://x.dev/i?id={ITEM_ID}', 4), 'https://x.dev/i?id=4');
});

test('itemUrl lehnt alles ab, was keine Web-Adresse ist', () => {
  // Das Muster kommt aus dem eigenen localStorage, gehoert aber trotzdem
  // nicht ungeprueft in ein href.
  assert.equal(itemUrl('javascript:alert(1)', 206), null);
  assert.equal(itemUrl('data:text/html,<script>x</script>', 206), null);
  assert.equal(itemUrl('', 206), null);
  assert.equal(itemUrl(undefined, 206), null);
  assert.equal(itemUrl('https://weav3r.dev/marketplace/{ITEM_ID}', 'nope'), null);
});

test('der Itemname verlinkt auf die Gegencheck-Seite', () => {
  const html = rowsToHtml([row], W3B);
  assert.match(html, /<a class="item-link" href="https:\/\/weav3r\.dev\/marketplace\/206"/);
  assert.match(html, /target="_blank" rel="noopener"/);
  assert.match(html, />Xanax</);
});

test('ohne Muster bleibt der Itemname schlichter Text', () => {
  const html = rowsToHtml([row], { itemUrlTemplate: '' });
  assert.ok(!html.includes('item-link'));
  assert.match(html, />Xanax</);
  // Auch ohne uebergebene Optionen darf nichts brechen.
  assert.ok(!rowsToHtml([row]).includes('item-link'));
});

test('ein boesartiges Muster landet nicht im href', () => {
  const html = rowsToHtml([row], { itemUrlTemplate: 'javascript:alert(1)' });
  assert.ok(!html.includes('javascript:'));
  assert.ok(!html.includes('item-link'));
});

test('Anfuehrungszeichen im Muster brechen das Attribut nicht auf', () => {
  const html = rowsToHtml([row], { itemUrlTemplate: 'https://x.dev/{ITEM_ID}" onmouseover="alert(1)' });
  assert.ok(!html.includes('onmouseover="alert(1)"'));
  assert.match(html, /&quot;/);
});

test('Marker stehen weiterhin neben dem verlinkten Namen', () => {
  const html = rowsToHtml([{ ...row, sponsored: true }], W3B);
  assert.match(html, /item-link/);
  assert.match(html, /gesponsert/);
});
