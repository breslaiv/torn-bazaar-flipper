// Das Userscript liest mit, was im Auslandsshop steht, und meldet es.
//
// Geprueft wird hier der Teil, der stabil ist: die Entprellung, die Zuordnung
// zum Land und das Herausloesen von Menge und Item aus einer beliebigen
// Struktur. Der Rest - welcher Aufruf welche Form hat - haengt an Torns Seite
// und wird erst gegen die Wirklichkeit geschaerft.
//
// Zwei Dinge stehen auf dem Spiel. Ohne Land ist eine Menge wertlos, weil
// dieselbe Item-ID in mehreren Shops vorkommt; sie landete in der falschen
// Reihe. Und ohne Entprellung entsteht aus zwei Meldungen im Sekundenabstand
// ein Nachschub, den es nie gab - derselbe Fehler, der beim Eingabe-Endpunkt
// erst im Praxistest auffiel.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Das Skript ist fuer den Browser gebaut. Diese Attrappen reichen ihm - sie
// muessen nur so viel koennen, dass es ohne DOM nicht stolpert.
const knoten = () => ({
  style: {},
  textContent: '',
  addEventListener() {},
  append() {},
  appendChild() {},
  remove() {},
});

globalThis.window = { fetch: async () => ({}) };
globalThis.XMLHttpRequest = function XHR() {};
globalThis.XMLHttpRequest.prototype.open = function open() {};
globalThis.location = { pathname: '/travelagency.php', search: '' };
globalThis.document = {
  body: { innerText: '', appendChild() {} },
  createElement: knoten,
};

await import('../userscript/torn-beobachter.user.js');
const B = globalThis.__beobachter;

const quelle = readFileSync('./userscript/torn-beobachter.user.js', 'utf8');

test('das Skript liegt bei und meldet sich als Userscript an', () => {
  assert.match(quelle, /==UserScript==/);
  assert.match(quelle, /@match\s+https:\/\/www\.torn\.com/);
  assert.match(quelle, /@grant\s+GM_xmlhttpRequest/);
});

test('es handelt nicht, es liest', () => {
  // Torn-Regeln, und die Projektregel dazu: das Werkzeug rechnet und
  // empfiehlt, es handelt nicht. Ein Klick oder ein Formularabsenden haette
  // hier nichts zu suchen.
  assert.doesNotMatch(quelle, /\.click\(\)|\.submit\(\)|dispatchEvent\(\s*new\s+MouseEvent/);
});

test('Laendernamen werden auf die Kuerzel des Sammlers abgebildet', () => {
  globalThis.document.body.innerText = 'Welcome to Canada — Travel Agency';
  assert.equal(B.findeLand(), 'can');

  globalThis.document.body.innerText = 'You are in the Cayman Islands';
  assert.equal(B.findeLand(), 'cay');

  globalThis.document.body.innerText = 'Torn City — irgendeine Seite';
  assert.equal(B.findeLand(), null, 'ohne Land wird nichts gemeldet');
});

test('Menge und Item werden aus beliebiger Verschachtelung geholt', () => {
  // Welche Form Torn liefert, weiss ich nicht - also darf das Ablesen nicht an
  // einer bestimmten haengen.
  const treffer = B.sammleAusJson({
    DB: { travel: { stocks: [{ id: 206, quantity: 42, name: 'Xanax' }] } },
    weiteres: [{ item_id: 260, amount: 0 }],
  });
  assert.deepEqual(
    treffer.map((t) => [t.item, t.quantity]).sort((a, b) => a[0] - b[0]),
    [[206, 42], [260, 0]],
  );
});

test('null Stueck ist eine Aussage, kein Grund zum Verwerfen', () => {
  // Das leere Regal ist die halbe Messung - ohne es gibt es keinen Zyklus.
  assert.deepEqual(B.sammleAusJson({ id: 8, quantity: 0 }), [{ item: 8, quantity: 0, name: null }]);
});

test('Unfug faellt heraus', () => {
  assert.deepEqual(B.sammleAusJson({ id: 0, quantity: 5 }), []);
  assert.deepEqual(B.sammleAusJson({ id: 8, quantity: -1 }), []);
  assert.deepEqual(B.sammleAusJson({ id: 'Xanax', quantity: 5 }), []);
  assert.deepEqual(B.sammleAusJson(null), []);
});

test('derselbe Wert kurz hintereinander wird nur einmal gemeldet', () => {
  B.zuletzt.clear();
  const t = Date.UTC(2026, 8, 2, 12, 0, 0);
  assert.equal(B.melden({ country: 'can', item: 206, quantity: 42, ts: t }), true);
  assert.equal(B.melden({ country: 'can', item: 206, quantity: 42, ts: t + 5000 }), false,
    'fuenf Sekunden spaeter derselbe Stand ist keine neue Messung');
});

test('eine geaenderte Menge wird sofort gemeldet, auch nach Sekunden', () => {
  // Der Sprung von null auf voll ist der wertvollste Moment ueberhaupt - ihn
  // wegen einer Sperre zu verschlucken waere das Gegenteil des Zwecks.
  B.zuletzt.clear();
  const t = Date.UTC(2026, 8, 2, 12, 0, 0);
  assert.equal(B.melden({ country: 'can', item: 206, quantity: 0, ts: t }), true);
  assert.equal(B.melden({ country: 'can', item: 206, quantity: 500, ts: t + 3000 }), true);
});

test('nach der Sperrfrist zaehlt auch der unveraenderte Stand wieder', () => {
  B.zuletzt.clear();
  const t = Date.UTC(2026, 8, 2, 12, 0, 0);
  B.melden({ country: 'can', item: 206, quantity: 42, ts: t });
  assert.equal(B.melden({ country: 'can', item: 206, quantity: 42, ts: t + 61_000 }), true);
});

test('im Auslieferungszustand wird nichts gesendet', () => {
  // Erkundung zuerst: ein geratener Selektor wuerde sonst Unfug in die
  // Messreihe schreiben, bevor jemand ihn bemerkt.
  assert.equal(B.EINSTELLUNGEN.erkunden, true);
  assert.equal(B.EINSTELLUNGEN.server, '', 'keine Adresse voreingestellt');
});

test('die Sperrfrist entspricht der des Sammlers', async () => {
  const { MIN_GAP_MS } = await import('../js/travelStock.js');
  assert.equal(B.EINSTELLUNGEN.mindestabstandMs, MIN_GAP_MS,
    'zwei Regeln fuer dieselbe Frage waeren zwei Wahrheiten');
});

test('der Bericht sammelt, was gefunden wurde — auch ohne Land', () => {
  // Auf dem Telefon gibt es keine Entwicklerkonsole. Ein Skript, dessen
  // Ergebnis nur in console.log steht, ist dort stumm - und die Erkundung
  // lebt davon, dass man sieht, was es gefunden hat.
  B.bericht.funde.length = 0;
  B.bericht.quellen.length = 0;
  B.bericht.form = null;
  B.zuletzt.clear();

  globalThis.document.body.innerText = 'irgendeine Torn-Seite ohne Land';
  B.verarbeite({ DB: { stocks: [{ id: 206, quantity: 42 }] } }, 'xhr /test');

  assert.equal(B.bericht.funde.length, 1, 'ohne Land wird trotzdem notiert');
  assert.deepEqual(B.bericht.quellen, ['xhr /test']);
  assert.match(B.bericht.form, /206/, 'die Rohform gehoert dazu, sonst laesst sich nichts schaerfen');
});

test('der Bericht laesst sich als Text ausgeben und bleibt handlich', () => {
  B.bericht.funde.length = 0;
  for (let i = 0; i < 100; i++) B.bericht.funde.push({ item: 1000 + i, quantity: i, name: null });

  const text = B.berichtText();
  const gelesen = JSON.parse(text);
  assert.equal(gelesen.insgesamt, 100, 'die Gesamtzahl bleibt sichtbar');
  assert.ok(gelesen.funde.length <= 25, 'aber nicht alle hundert werden abgetippt');
  assert.match(text, /travelagency/, 'die Adresse gehoert dazu');
});
