// Nachschubzeiten in Torn City Time.
//
// Im Spiel steht jede Zeitangabe in TCT (= UTC), im Browser in der Zone des
// Geraets. Wer die beiden verwechselt, fliegt drei Stunden und landet zwei
// Stunden zu frueh - deshalb steht die Uhrzeit jetzt in beiden Zonen.
//
// Der Test setzt TZ selbst, denn sonst pruefte er, wo er zufaellig laeuft: auf
// dieser Maschine ist die Ortszeit UTC, im Browser des Nutzers nicht.

import test from 'node:test';
import assert from 'node:assert/strict';

const T = Date.UTC(2026, 8, 1, 20, 50, 0);   // 20:50 UTC

/** Laedt ui.js frisch unter einer bestimmten Zeitzone. */
async function unterZeitzone(tz) {
  const vorher = process.env.TZ;
  process.env.TZ = tz;
  // Frischer Import, damit die Intl-Formatierer die neue Zone sehen.
  const mod = await import(`../js/ui.js?tz=${encodeURIComponent(tz)}&t=${Date.now()}`);
  process.env.TZ = vorher;
  return mod;
}

test('bei abweichender Ortszeit stehen beide Uhrzeiten da', async () => {
  const { fmtClockTct, fmtTct, fmtClock } = await unterZeitzone('Europe/Vienna');

  assert.equal(fmtTct(T), '20:50', 'TCT ist UTC');
  assert.equal(fmtClock(T), '22:50', 'Wien liegt im Sommer zwei Stunden davor');
  assert.equal(fmtClockTct(T), '22:50 · 20:50 TCT');
});

test('auf einem Geraet in UTC steht die Zahl nicht zweimal', async () => {
  // Der lokale Server laeuft auf UTC. Dieselbe Uhrzeit doppelt waere kein
  // Dienst, sondern Rauschen - aber das Kuerzel muss bleiben, sonst weiss
  // niemand, welche Zone gemeint ist.
  const { fmtClockTct } = await unterZeitzone('UTC');
  assert.equal(fmtClockTct(T), '20:50 TCT');
});

test('auch westlich von Greenwich stimmt die Reihenfolge', async () => {
  // Dort geht die Ortszeit nach, nicht vor - die Ortszeit steht trotzdem
  // vorne, weil der Leser sie zuerst braucht.
  const { fmtClockTct } = await unterZeitzone('America/New_York');
  assert.match(fmtClockTct(T), /^16:50 · 20:50 TCT$/);
});

test('die Nachschubzeiten der Flugseite gehen durch diesen Formatierer', async () => {
  // Sonst stuende TCT an einer Stelle und an der naechsten nicht - und
  // ausgerechnet beim Vergleich zweier Ziele faellt das keinem auf.
  const { readFileSync } = await import('node:fs');
  const src = readFileSync('./js/travelPage.js', 'utf8');

  for (const stelle of [
    /html: `\$\{escapeHtml\(fmtClockTct\(p\.restock\.at\)\)\}`/,     // Tabelle "Nächster Nachschub"
    /landet zum Nachschub um \$\{fmtClockTct\(p\.restock\.at\)\}/,   // Kachel "Abflug"
    /text: `\$\{fmtClockTct\(r\.at\)\} · \$\{relative\(r\.at\)\}`/,  // Zyklen eines Items
  ]) {
    assert.match(src, stelle);
  }
});
