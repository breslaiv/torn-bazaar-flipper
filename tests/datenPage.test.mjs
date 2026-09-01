// Die Datenlage-Seite zeigt den Fortschritt der Sammlung. Ihr eigentlicher
// Zweck ist, eine Luecke als Luecke sichtbar zu machen - deshalb wird hier
// geprueft, dass sie kein Vorhandenes zu Nichts rundet und keine fremde
// Stelle anfragt.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

function fakeStorage() {
  return { getItem: () => null, setItem: () => {}, removeItem: () => {} };
}
globalThis.localStorage = fakeStorage();

const { balkenBreite } = await import('../js/datenPage.js');

const html = readFileSync('./daten.html', 'utf8');
const js = readFileSync('./js/datenPage.js', 'utf8');

test('ein vorhandener Wert wird nie zu einem unsichtbaren Balken', () => {
  // Der Fund aus dem Browsertest: "1 von 227" rundete auf 0 % und war von
  // "gar keine" nicht zu unterscheiden. Genau dieser Unterschied ist beim
  // Sammeln die interessante Information.
  assert.equal(balkenBreite(1, 227), 2, 'ein Zwanzigstel Prozent bleibt sichtbar');
  assert.equal(balkenBreite(97, 227), 43);
  assert.equal(balkenBreite(227, 227), 100);
});

test('nichts bleibt nichts', () => {
  // Die Umkehrung ist genauso wichtig: ein Mindestbalken fuer null wuerde
  // Beobachtungen behaupten, die es nicht gibt.
  assert.equal(balkenBreite(0, 227), 0);
  assert.equal(balkenBreite(5, 0), 0, 'ohne Maximum gibt es keinen Anteil');
  assert.equal(balkenBreite(null, 10), 0);
});

test('die Seite fragt keine fremde Stelle', () => {
  // Sie rechnet nur mit dem, was schon gesammelt wurde. Jeder Host hier waere
  // eine Stelle, an die etwas abfliessen koennte - und keiner wird gebraucht.
  const csp = html.match(/connect-src([^;"]*)/);
  assert.ok(csp, 'keine connect-src');
  assert.equal(csp[1].trim(), "'self'");
  assert.doesNotMatch(js, /https?:\/\//, 'im Skript steht eine absolute Adresse');
});

test('sie rechnet mit denselben Funktionen wie die Flug-Seite', () => {
  // Eine zweite Rechnung waere eine zweite Wahrheit: dann zeigte das
  // Dashboard einen anderen Timer an als die Seite, die entscheidet.
  assert.match(js, /from '\.\/restock\.js/);
  assert.match(js, /from '\.\/travelStock\.js/);
  assert.match(js, /findCycles|estimateTimer/);
  assert.match(js, /backtest/);
});

test('jede Kennzahl der Seite hat ihr Ziel im Markup', () => {
  // Ein getElementById ins Leere faellt beim Lesen nicht auf und macht die
  // halbe Seite still leer.
  const ids = new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
  for (const m of js.matchAll(/\bel\('([^']+)'\)/g)) {
    assert.ok(ids.has(m[1]), `el('${m[1]}') hat kein Ziel in daten.html`);
  }
});
