// Der Massstab, an dem das Sprachmodell gemessen wird, muss selbst stimmen.
//
// Waere urteil() falsch, wuerde das Werkzeug einem Modell Widerspruch
// vorwerfen, wo es recht hat - und der ganze Vergleich waere wertlos. Deshalb
// wird hier der deterministische Teil geprueft, nicht das Modell: er ist der
// Teil, der auch ohne Ollama Bestand hat.

import test from 'node:test';
import assert from 'node:assert/strict';
import { merkmale, urteil, beschreibung } from '../tools/hypothese.mjs';

const MIN = 60000;
const T0 = Date.UTC(2026, 0, 1, 12, 0, 0);

/**
 * Baut eine Reihe aus Zyklen: voll, leer, wieder voll.
 * @param dauern  Minuten zwischen leerem Regal und Nachschub, je Zyklus
 * @param mengen  nachgelegte Menge je Zyklus
 */
function reihe(dauern, mengen) {
  const punkte = [];
  let t = T0;
  dauern.forEach((dauer, i) => {
    const menge = mengen[i % mengen.length];
    punkte.push([t, menge]);              // Ware da
    t += 5 * MIN;
    punkte.push([t, 0]);                  // leer
    t += dauer * MIN;
    punkte.push([t, menge]);              // nachgelegt
    t += 5 * MIN;
  });
  return punkte;
}

test('gleichbleibende Dauern werden als fester Timer erkannt', () => {
  const s = reihe([15, 15, 16, 15, 15, 16], [200]);
  const m = merkmale(s);
  assert.ok(m.zyklen >= 5, `nur ${m.zyklen} Zyklen erkannt`);
  assert.equal(urteil(m).key, 'fester-timer');
});

test('zu wenige Zyklen ergeben kein Urteil, sondern ein Achselzucken', () => {
  // Lieber "zu wenig Daten" als ein Muster, das aus zwei Beobachtungen kommt.
  const m = merkmale(reihe([15, 15], [200]));
  assert.equal(urteil(m).key, 'kein-muster');
  assert.match(urteil(m).warum, /zu wenige/);
});

test('stark schwankende Dauern ergeben keinen festen Timer', () => {
  const m = merkmale(reihe([5, 40, 12, 90, 20, 60], [200]));
  assert.notEqual(urteil(m).key, 'fester-timer');
});

test('die Beschreibung nennt nur Zahlen, die auch gemessen wurden', () => {
  // Das Modell darf keine Zahl zu sehen bekommen, die niemand gemessen hat -
  // sonst waere onlyKnownNumbers() im Werkzeug wirkungslos.
  const m = merkmale(reihe([15, 15, 16, 15, 15], [200]));
  const text = beschreibung('mex:8', m);
  assert.match(text, /5 vollständige|6 vollständige/);
  assert.match(text, /Minuten/);
  assert.ok(!/NaN|undefined|null/.test(text), `unsaubere Zahl im Text: ${text}`);
});

test('ohne abgeschlossene Zyklen bleibt alles leer statt geraten', () => {
  const m = merkmale([[T0, 100], [T0 + 5 * MIN, 50]]);
  assert.equal(m.zyklen, 0);
  assert.equal(m.dauerMedian, null);
  assert.equal(urteil(m).key, 'kein-muster');
});
