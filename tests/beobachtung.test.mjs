// Eigene Beobachtungen: der einzige Weg, auf dem etwas in die Messreihe
// hineinkommt, ohne vom Sammler gemessen worden zu sein.
//
// Zweierlei steht hier auf dem Spiel. Erstens die Reihe selbst: ein Tippfehler
// erzeugt einen falschen Zyklus, und der verdirbt einen Timer, den man erst
// nach Tagen wieder hat. Zweitens der Dienst: er beantwortete bisher
// ausschliesslich GET, und diese Eigenschaft wird hier so eng wie moeglich
// aufgegeben - genau ein Pfad, genau eine Methode, genau ein Inhaltstyp.

import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import {
  openStore, saveManual, saveSeries, pruefeBeobachtung, manualCount, readSeries,
  MANUAL_LIMITS,
} from '../tools/store.mjs';
import { createServer, BEOBACHTUNG_PFAD } from '../tools/serve.mjs';

const LAENDER = new Set(['mex', 'can', 'swi']);
const JETZT = Date.UTC(2026, 8, 2, 12, 0, 0);

// ---------- Pruefung, ohne Datenbank ----------

test('eine brauchbare Beobachtung kommt durch', () => {
  const r = pruefeBeobachtung({ country: 'mex', item: 260, quantity: 42 }, { laender: LAENDER, now: JETZT });
  assert.equal(r.ok, true);
  assert.deepEqual(r.wert, { country: 'mex', item: 260, ts: JETZT, quantity: 42, note: null });
});

test('null Stueck ist eine Aussage, kein Fehler', () => {
  // Das leere Regal ist die halbe Messung - ohne es gibt es keinen Zyklus.
  const r = pruefeBeobachtung({ country: 'mex', item: 260, quantity: 0 }, { laender: LAENDER, now: JETZT });
  assert.equal(r.ok, true);
  assert.equal(r.wert.quantity, 0);
});

test('eine fehlende Menge wird nicht zu null', () => {
  // Number(null) und Number('') sind 0. Ohne die ausdrueckliche Pruefung
  // meldete ein leeres Formularfeld ein leergekauftes Regal - und das ist die
  // teuerste Falschmeldung, die es hier gibt.
  for (const menge of [null, undefined, '']) {
    const r = pruefeBeobachtung({ country: 'mex', item: 260, quantity: menge }, { laender: LAENDER, now: JETZT });
    assert.equal(r.ok, false, `${JSON.stringify(menge)} kam durch`);
    assert.match(r.grund, /Menge fehlt/);
  }
});

test('unbekannte Laender und Items werden abgewiesen', () => {
  const schlecht = [
    { country: 'xyz', item: 260, quantity: 5 },
    { country: '', item: 260, quantity: 5 },
    { country: 'mex', item: 0, quantity: 5 },
    { country: 'mex', item: -3, quantity: 5 },
    { country: 'mex', item: 'Xanax', quantity: 5 },
    { country: 'mex', item: 260, quantity: -1 },
    { country: 'mex', item: 260, quantity: 1.5 },
    { country: 'mex', item: 260, quantity: MANUAL_LIMITS.maxQuantity + 1 },
  ];
  for (const s of schlecht) {
    assert.equal(pruefeBeobachtung(s, { laender: LAENDER, now: JETZT }).ok, false, JSON.stringify(s));
  }
  assert.equal(pruefeBeobachtung(null, { laender: LAENDER, now: JETZT }).ok, false);
});

test('der Zeitpunkt muss plausibel sein', () => {
  // Der Zeitpunkt ist hier die halbe Messung: eine Menge ohne verlaesslichen
  // Zeitpunkt sagt ueber den Timer nichts.
  const basis = { country: 'mex', item: 260, quantity: 5 };
  const zukunft = pruefeBeobachtung({ ...basis, ts: JETZT + 3600e3 }, { laender: LAENDER, now: JETZT });
  assert.equal(zukunft.ok, false);
  assert.match(zukunft.grund, /Zukunft/);

  const alt = pruefeBeobachtung({ ...basis, ts: JETZT - 48 * 3600e3 }, { laender: LAENDER, now: JETZT });
  assert.equal(alt.ok, false);
  assert.match(alt.grund, /aelter/);

  // Wenige Minuten rueckwirkend ist der Normalfall - man tippt ja nach dem Blick.
  assert.equal(pruefeBeobachtung({ ...basis, ts: JETZT - 5 * 60000 }, { laender: LAENDER, now: JETZT }).ok, true);
});

// ---------- Speichern ----------

function mitDb(fn) {
  const db = openStore(':memory:');
  try { fn(db); } finally { db.close(); }
}

test('die Beobachtung landet in der Reihe und ihre Herkunft daneben', () => {
  mitDb((db) => {
    const { added } = saveManual(db, { country: 'mex', item: 8, ts: JETZT, quantity: 42, note: 'im Shop' });
    assert.equal(added, 1);

    // Dort, wo alle Auswertungen suchen.
    assert.deepEqual(readSeries(db)['mex:8'], [[JETZT, 42]]);
    // Und nachvollziehbar als eigene Messung.
    assert.equal(manualCount(db), 1);
  });
});

test('zwei Eingaben dicht hintereinander ergeben keinen erfundenen Sprung', () => {
  // Der Fund aus dem Praxistest: zwei Klicks im Abstand von acht
  // Millisekunden legten zwei widersprechende Punkte ab - 137 und 999 -, und
  // daraus liest findCycles() einen Nachschub von +862 in acht Millisekunden.
  // Genau der erfundene Zyklus, den die Eingabe verhindern sollte.
  mitDb((db) => {
    saveManual(db, { country: 'mex', item: 8, ts: JETZT, quantity: 137 });
    const zweite = saveManual(db, { country: 'mex', item: 8, ts: JETZT + 8, quantity: 999 });

    assert.equal(zweite.ersetzt, 1, 'der erste Punkt haette weichen muessen');
    assert.deepEqual(readSeries(db)['mex:8'], [[JETZT + 8, 999]], 'nur die Korrektur bleibt');
    assert.equal(manualCount(db), 1, 'und auch nur eine Herkunft');
  });
});

test('auch eine Messung des Sammlers weicht der eigenen Beobachtung', () => {
  // Wer im Shop steht, sieht genauer als eine Quelle, die ihre Antwort bis
  // zum naechsten Import festhaelt. Zwei widersprechende Zahlen im
  // Sekundenabstand nebeneinander stehen zu lassen, waere die schlechteste
  // aller Loesungen.
  mitDb((db) => {
    saveSeries(db, { 'mex:8': [[JETZT - 20000, 900]] });
    const r = saveManual(db, { country: 'mex', item: 8, ts: JETZT, quantity: 137 });

    assert.equal(r.ersetzt, 1);
    assert.deepEqual(readSeries(db)['mex:8'], [[JETZT, 137]]);
  });
});

test('was weiter zurueckliegt, bleibt unangetastet', () => {
  mitDb((db) => {
    saveSeries(db, { 'mex:8': [[JETZT - 10 * 60000, 900]] });
    const r = saveManual(db, { country: 'mex', item: 8, ts: JETZT, quantity: 137 });

    assert.equal(r.ersetzt, 0, 'zehn Minuten sind zwei Messungen, nicht eine');
    assert.deepEqual(readSeries(db)['mex:8'], [[JETZT - 10 * 60000, 900], [JETZT, 137]]);
  });
});

// ---------- Der Endpunkt ----------

async function mitServer(opts, fn) {
  const server = createServer({ root: '.', ...opts });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const basis = `http://127.0.0.1:${server.address().port}`;
  try { await fn(basis); } finally { server.close(); await once(server, 'close'); }
}

const sende = (basis, koerper, kopf = { 'Content-Type': 'application/json' }) => fetch(
  `${basis}${BEOBACHTUNG_PFAD}`,
  { method: 'POST', headers: kopf, body: typeof koerper === 'string' ? koerper : JSON.stringify(koerper) },
);

test('ohne Empfaenger bleibt der Dienst reines GET', async () => {
  // Auf GitHub Pages und bei jedem Aufrufer, der keinen Empfaenger uebergibt,
  // darf der Pfad nicht existieren.
  await mitServer({}, async (basis) => {
    assert.equal((await sende(basis, { country: 'mex', item: 8, quantity: 1 })).status, 405);
  });
});

test('eine Beobachtung wird angenommen und quittiert', async () => {
  let gesehen = null;
  await mitServer({
    beobachtung: (k) => { gesehen = k; return { ok: true, added: 1 }; },
  }, async (basis) => {
    const res = await sende(basis, { country: 'mex', item: 8, quantity: 42 });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, added: 1 });
    assert.deepEqual(gesehen, { country: 'mex', item: 8, quantity: 42 });
  });
});

test('eine abgelehnte Beobachtung kommt als 400 zurueck, nicht als Erfolg', async () => {
  await mitServer({
    beobachtung: () => ({ ok: false, error: 'unbekanntes Land' }),
  }, async (basis) => {
    const res = await sende(basis, { country: 'xyz', item: 8, quantity: 1 });
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /unbekanntes Land/);
  });
});

test('nur application/json wird entgegengenommen', async () => {
  // Nicht Formalismus: dieser Inhaltstyp erzwingt im Browser einen Preflight,
  // und den beantwortet der Server nicht. Damit kann keine fremde Seite in die
  // Messreihe schreiben, obwohl der Dienst im Tailnet erreichbar ist.
  await mitServer({ beobachtung: () => ({ ok: true, added: 1 }) }, async (basis) => {
    for (const typ of ['text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data']) {
      const res = await sende(basis, '{"country":"mex","item":8,"quantity":1}', { 'Content-Type': typ });
      assert.equal(res.status, 415, typ);
    }
  });
});

test('Unsinn im Koerper wird abgewiesen, nicht durchgereicht', async () => {
  let aufgerufen = false;
  await mitServer({
    beobachtung: () => { aufgerufen = true; return { ok: true, added: 1 }; },
  }, async (basis) => {
    const res = await sende(basis, 'kein json');
    assert.equal(res.status, 400);
    assert.equal(aufgerufen, false, 'der Empfaenger haette nichts sehen duerfen');
  });
});

test('ein zu grosser Koerper wird abgebrochen', async () => {
  // Ohne Grenze haelt ein einziger Aufruf den Speicher des Servers auf.
  await mitServer({ beobachtung: () => ({ ok: true, added: 1 }) }, async (basis) => {
    const riesig = JSON.stringify({ country: 'mex', item: 8, quantity: 1, note: 'x'.repeat(20000) });
    const antwort = await sende(basis, riesig).catch(() => null);
    // Entweder 400 oder abgebrochene Verbindung - nur nicht 200.
    if (antwort) assert.notEqual(antwort.status, 200);
  });
});

test('andere Pfade nehmen weiterhin nichts entgegen', async () => {
  await mitServer({ beobachtung: () => ({ ok: true, added: 1 }) }, async (basis) => {
    for (const pfad of ['/', '/health', '/data/travel-stock.json', '/api/beobachtung/../etwas']) {
      const res = await fetch(`${basis}${pfad}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      assert.equal(res.status, 405, pfad);
    }
  });
});
