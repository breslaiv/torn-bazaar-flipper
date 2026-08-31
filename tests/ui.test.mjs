import test from 'node:test';
import assert from 'node:assert/strict';
import {
  COLUMNS, headToHtml, rowsToHtml, sortOptionsToHtml, sortRows, itemUrl,
  fmtMoney, fmtPct, escapeHtml, fmtMoneyShort,
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

test('fmtMoneyShort haelt die Statusleiste in einer Zeile', () => {
  // Die Leiste schneidet auf dem Handy hinten ab; lange Zahlen kosten den
  // halben Satz.
  assert.equal(fmtMoneyShort(7174400), '$7.17M');
  assert.equal(fmtMoneyShort(25125600), '$25.1M');
  assert.equal(fmtMoneyShort(348000), '$348k');
  assert.equal(fmtMoneyShort(1500000000), '$1.5B');
  assert.equal(fmtMoneyShort(-2400000), '-$2.4M');
  assert.equal(fmtMoneyShort(9500), '$9,500', 'kleine Betraege bleiben genau');
  assert.equal(fmtMoneyShort(NaN), '—');
});

test('die Alter-Spalte trennt "unbekannt" von "alt"', () => {
  const row = (extra) => ({
    itemId: 1, itemName: 'X', buy: 1, quantity: 1, units: 1, spend: 1,
    profitPerUnit: 1, profitPct: 1, totalProfit: 1, sellNet: 2, reference: 2, ...extra,
  });
  const html = (extra) => rowsToHtml([row(extra)], {});

  assert.match(html({ listingAgeHours: 10 }), /class="age">10 h</);
  // Ab drei Tagen liegt die Ware oft nur noch im Crawl.
  assert.match(html({ listingAgeHours: 100 }), /class="age warn">4 d</);
  // Kein Zeitstempel ist keine Aussage ueber das Alter - und darf deshalb
  // auch nicht wie "frisch" aussehen.
  assert.match(html({ listingAgeHours: null }), /class="muted">\?</);
});

test('die Menge nennt den noetigen Einsatz mit', () => {
  const row = {
    itemId: 1, itemName: 'X', buy: 5000, quantity: 8, units: 8, spend: 40000,
    profitPerUnit: 1, profitPct: 1, totalProfit: 8, sellNet: 2, reference: 2,
  };
  assert.match(rowsToHtml([row], {}), /8<span class="tag">\$40,000<\/span>/);
  // Ohne Menge waere der Einsatz null und die Angabe nur Ballast.
  assert.doesNotMatch(rowsToHtml([{ ...row, units: 0, spend: 0 }], {}), /class="tag">\$0</);
});

test('eine Zeile ausserhalb des Budgets sagt das auch', () => {
  const row = {
    itemId: 1, itemName: 'X', buy: 5000, quantity: 8, units: 0, spend: 0,
    profitPerUnit: 1, profitPct: 1, totalProfit: 0, sellNet: 2, reference: 2, overBudget: true,
  };
  assert.match(rowsToHtml([row], {}), /über Budget/);
});
