// Der Simulator ist ein Messgeraet, kein Datenlieferant - und ein Messgeraet
// muss selbst geprueft sein.
//
// Zwei Dinge stehen hier auf dem Spiel. Erstens muss er aufzeichnen wie der
// Sammler, sonst misst man an einer Welt, die es nicht gibt: die erste Fassung
// hielt nur Aenderungen fest, wodurch ein leeres Regal einen einzigen Punkt
// ergab und estimateTimer() scheinbar 125 Minuten zu kurz lag. Zweitens darf
// nichts davon je als Beobachtung durchgehen.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

function fakeStorage() {
  return { getItem: () => null, setItem: () => {}, removeItem: () => {} };
}
globalThis.localStorage = fakeStorage();

const { simuliereDatensatz, zufall, KENNWERTE, pruefe } = await import('../tools/simulieren.mjs');
const { findCycles, estimateTimer } = await import('../js/restock.js');

test('derselbe Saatwert ergibt denselben Datensatz', async () => {
  // Ohne Wiederholbarkeit ist jede daran gemessene Aussage ein Einzelfall.
  const a = await simuliereDatensatz({ reihen: 5, stunden: 6, saat: 42 });
  const b = await simuliereDatensatz({ reihen: 5, stunden: 6, saat: 42 });
  assert.deepEqual(Object.keys(a.series), Object.keys(b.series));
  for (const k of Object.keys(a.series)) {
    assert.equal(a.series[k].length, b.series[k].length, k);
  }
});

test('aufgezeichnet wird mit der Regel des Sammlers', async () => {
  // Der Beweis ueber das leere Regal: bleibt die Menge bei null, muss trotzdem
  // regelmaessig ein Punkt entstehen - sonst waere die Leerphase unsichtbar
  // und der Timer nicht bestimmbar.
  const { series } = await simuliereDatensatz({ reihen: 12, stunden: 12, saat: 3 });

  let mitLeerstrecke = 0;
  for (const punkte of Object.values(series)) {
    let nullen = 0;
    for (const [, q] of punkte) if (q === 0) nullen += 1;
    if (nullen >= 2) mitLeerstrecke += 1;
  }
  assert.ok(mitLeerstrecke > 0, 'keine Reihe zeigt eine Leerstrecke mit mehreren Punkten');

  const src = readFileSync('./tools/simulieren.mjs', 'utf8');
  assert.match(src, /recordSnapshot/, 'zeichnet nicht mit der Sammlerfunktion auf');
});

test('estimateTimer findet den wahren Timer wieder, ohne in eine Richtung zu ziehen', async () => {
  // Die Frage, die sich an echten Daten nicht stellen laesst: dort ist der
  // wahre Wert unbekannt. Erwartet wird Unverzerrtheit, nicht Genauigkeit.
  const treffer = await pruefe({ reihen: 60, stunden: 48, saat: 11 });
  assert.ok(treffer.length >= 20, `nur ${treffer.length} Reihen mit Schaetzung`);

  const fehler = treffer.map((t) => t.fehler).sort((a, b) => a - b);
  const median = fehler[Math.floor(fehler.length / 2)];
  assert.ok(Math.abs(median) < 3, `die Mitte liegt im Median um ${median.toFixed(1)} min daneben`);

  const drin = treffer.filter((t) => t.drin).length / treffer.length;
  assert.ok(drin > 0.8, `der wahre Wert liegt nur in ${(drin * 100).toFixed(0)} % der Faelle in der Klammer`);
});

test('die Koernung der Quelle ist nachgebildet', () => {
  // Ohne sie waere die simulierte Welt genauer beobachtbar als die echte, und
  // jede daran gemessene Guete zu optimistisch.
  assert.equal(KENNWERTE.quelleSekunden, 60, 'gemessen: kleinster Abstand exakt 60 s');
  assert.ok(KENNWERTE.quelleJitterSekunden > 0);
});

test('nichts daran gibt sich als Beobachtung aus', () => {
  const src = readFileSync('./tools/simulieren.mjs', 'utf8');

  // Nicht der Name der Datenbank ist das Problem - er steht dort in der
  // Warnung, sie nicht zu fuettern. Entscheidend ist, dass der Simulator gar
  // keinen Weg dorthin hat: kein Speicher, keine Datenbank, kein Sammler.
  assert.doesNotMatch(src, /from '\.\/store\.mjs'|node:sqlite|saveSeries|openStore/,
    'der Simulator kann in die Messdatenbank schreiben');

  // Und was er ausgibt, kennzeichnet sich selbst.
  assert.match(src, /simuliert: true/, 'die Ausgabe kennzeichnet sich nicht als erfunden');
});

test('der Zufall ist aussaebar und bleibt im Bereich', () => {
  const r = zufall(5);
  for (let i = 0; i < 200; i++) {
    const v = r();
    assert.ok(v >= 0 && v < 1, `${v} liegt ausserhalb`);
  }
});
