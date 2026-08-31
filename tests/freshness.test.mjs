import test from 'node:test';
import assert from 'node:assert/strict';
import { toMillis, ageHours, fmtAge, tooOld } from '../js/freshness.js';

const NOW = Date.UTC(2026, 7, 31, 12, 0, 0);

test('Sekunden und Millisekunden werden an der Groessenordnung unterschieden', () => {
  const seconds = Math.floor(NOW / 1000);
  assert.equal(toMillis(seconds, NOW), NOW, 'zehnstellig = Sekunden');
  assert.equal(toMillis(NOW, NOW), NOW, 'dreizehnstellig = Millisekunden');
  assert.equal(toMillis(String(seconds), NOW), NOW, 'auch als Zeichenkette');
});

test('ISO-Zeitstempel werden gelesen', () => {
  assert.equal(toMillis('2026-08-31T12:00:00Z', NOW), NOW);
  assert.equal(toMillis('2026-08-31T10:00:00Z', NOW), NOW - 2 * 3600e3);
});

test('was sich nicht deuten laesst, gilt als unbekannt - nicht als uralt', () => {
  // Der ganze Punkt: ein Fehlgriff beim Format darf nicht stillschweigend
  // jede Zeile aus der Liste werfen.
  for (const value of [null, undefined, '', 'gestern', {}, [], NaN, 0, -5]) {
    assert.equal(toMillis(value, NOW), null, JSON.stringify(value));
    assert.equal(ageHours(value, NOW), null, JSON.stringify(value));
  }
});

test('Zeitstempel aus der Zukunft sind ein Formatfehler, kein Alter', () => {
  assert.equal(toMillis(NOW + 48 * 3600e3, NOW), null);
  // Etwas Vorlauf bleibt erlaubt: Server- und Browseruhr laufen nie gleich.
  assert.equal(toMillis(NOW + 3600e3, NOW), NOW + 3600e3);
});

test('ageHours rechnet in Stunden und wird nie negativ', () => {
  assert.equal(ageHours(NOW - 3 * 3600e3, NOW), 3);
  assert.equal(ageHours(NOW - 36 * 3600e3, NOW), 36);
  assert.equal(ageHours(NOW + 60e3, NOW), 0, 'kleine Uhrabweichung ist kein negatives Alter');
});

test('fmtAge bleibt kurz genug fuer eine Tabellenzelle', () => {
  assert.equal(fmtAge(0.4), '<1 h');
  assert.equal(fmtAge(5.6), '6 h');
  assert.equal(fmtAge(47), '47 h');
  assert.equal(fmtAge(72), '3 d');
  assert.equal(fmtAge(null), '—');
});

test('tooOld laesst unbekanntes Alter durch', () => {
  assert.equal(tooOld(100, 48), true);
  assert.equal(tooOld(12, 48), false);
  assert.equal(tooOld(null, 48), false, 'unbekannt ist kein Ausschlussgrund');
  assert.equal(tooOld(1000, 0), false, '0 = kein Limit');
  assert.equal(tooOld(1000, ''), false);
});
