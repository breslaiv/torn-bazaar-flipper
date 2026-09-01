// Der Dauersammler soll Wochen laufen. Was hier schiefgeht, faellt nicht beim
// Start auf, sondern nach dem ersten Ausfall der Quelle oder dem ersten
// Neustart - und dann fehlt genau das Fenster, in dem ein Timer ablief.

import test from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs, run } from '../tools/collect-local.mjs';
import { openStore, saveSeries, storeStats, readSeries } from '../tools/store.mjs';

const T0 = Date.UTC(2026, 0, 1, 12, 0, 0);

/** Eine YATA-Antwort mit einem Land und zwei Items. */
function payload(updatedAt, quantities) {
  return {
    stocks: {
      mex: {
        update: Math.floor(updatedAt / 1000),
        stocks: quantities.map(([id, quantity]) => ({ id, quantity, cost: 500 })),
      },
    },
  };
}

/** Uhr und Schlaf, die nicht wirklich warten. */
function fakeClock(start = T0) {
  let ms = start;
  return {
    now: () => ms,
    sleep: async (wait) => { ms += wait; },
    advance: (wait) => { ms += wait; },
  };
}

test('Vorgaben: dreissig Sekunden, und nie schneller als fuenf', () => {
  // Dreissig ist gemessen: der kleinste Abstand zwischen zwei YATA-
  // Zeitstempeln ist exakt 60 s, also hat dieser Takt die doppelte Marge.
  // Ein Takt von 60 s waere zu langsam - eine Abfrage dauert selbst mehrere
  // Sekunden, der Sammler liefe real hinter der Quelle her.
  assert.equal(parseArgs([]).intervalSeconds, 30);
  assert.equal(parseArgs(['--interval', '15']).intervalSeconds, 15);
  // Eine fremde Quelle im Sekundentakt anzuklopfen bringt nichts: YATA
  // liefert erst neue Zeitstempel, wenn jemand importiert hat.
  assert.equal(parseArgs(['--interval', '1']).intervalSeconds, 5);
  assert.equal(parseArgs(['--interval', 'quatsch']).intervalSeconds, 30);
});

test('gemessene Punkte landen in der Datenbank', async () => {
  const db = openStore(':memory:');
  const clock = fakeClock();
  let step = 0;

  await run({
    db,
    fetchJson: async () => payload(T0 + step++ * 60000, [[8, 10 - step], [20, 40]]),
    intervalMs: 60000,
    minutes: 3,
    sleep: clock.sleep,
    now: clock.now,
  });

  const stats = storeStats(db);
  assert.ok(stats.points >= 4, `nur ${stats.points} Punkte`);
  assert.equal(stats.series, 2, 'zwei Items, zwei Reihen');
  db.close();
});

test('eine gecachte Antwort ist keine neue Messung', async () => {
  // Der wichtigste Fall im Betrieb: YATA haelt seine Antwort fest, bis jemand
  // importiert. Zaehlte jede Abfrage als Messpunkt, waere jede Reihe voller
  // erfundener Beobachtungen - und der Timer daraus wertlos.
  const db = openStore(':memory:');
  const clock = fakeClock();

  await run({
    db,
    fetchJson: async () => payload(T0, [[8, 5]]),   // immer derselbe Zeitstempel
    intervalMs: 60000,
    minutes: 5,
    sleep: clock.sleep,
    now: clock.now,
  });

  assert.equal(storeStats(db).points, 1, 'aus sechs Abfragen wurde ein Punkt');
  db.close();
});

test('ein Ausfall der Quelle beendet den Sammler nicht', async () => {
  const db = openStore(':memory:');
  const clock = fakeClock();
  let call = 0;

  const result = await run({
    db,
    fetchJson: async () => {
      call += 1;
      if (call <= 3) throw new Error('yata.yt HTTP 502');
      return payload(T0 + call * 60000, [[8, 7]]);
    },
    intervalMs: 60000,
    minutes: 60,
    sleep: clock.sleep,
    now: clock.now,
  });

  assert.equal(result.errors, 3);
  assert.ok(result.changes > 0, 'nach dem Ausfall wurde wieder gemessen');
  assert.ok(storeStats(db).points > 0);
  db.close();
});

test('nach einem Neustart gilt der letzte Stand, nicht ein leeres Blatt', async () => {
  // Ohne den Startzustand aus der Datenbank meldet der Sammler nach jedem
  // Neustart den unveraenderten Regalinhalt als frische Messung - und die
  // Zeitreihe bekaeme Punkte, die nie beobachtet wurden.
  const db = openStore(':memory:');
  saveSeries(db, { 'mex:8': [[T0, 5]] });
  const before = storeStats(db).points;

  const clock = fakeClock(T0 + 3600000);
  await run({
    db,
    fetchJson: async () => payload(T0, [[8, 5]]),   // exakt der bekannte Stand
    intervalMs: 60000,
    minutes: 3,
    sleep: clock.sleep,
    now: clock.now,
  });

  assert.equal(storeStats(db).points, before, 'nichts Neues erfunden');
  db.close();
});

test('Abfragen und Fehler werden gebucht, nicht nur die Aenderungen', async () => {
  // runs.polls stand im Dauerbetrieb dauerhaft auf 0: watch() zaehlt Abfragen
  // zwar mit, reicht die Zahl aber nicht an save() weiter, und save() laeuft
  // nur bei einer Aenderung. Damit war die einzige Frage, fuer die es diese
  // Tabelle gibt, aus der Datenbank nicht mehr zu beantworten - wie viele
  // Abfragen brachten ueberhaupt etwas Neues?
  const db = openStore(':memory:');
  const clock = fakeClock();
  let call = 0;

  await run({
    db,
    fetchJson: async () => {
      call += 1;
      if (call === 2) throw new Error('yata.yt HTTP 502');
      // Nur jede dritte Abfrage traegt einen neuen Zeitstempel - so wie im
      // Betrieb, wo YATA seine Antwort bis zum naechsten Import festhaelt.
      const schritt = Math.floor(call / 3);
      return payload(T0 + schritt * 60000, [[8, 5 + schritt]]);
    },
    intervalMs: 60000,
    minutes: 10,
    sleep: clock.sleep,
    now: clock.now,
  });

  const bilanz = db
    .prepare('SELECT SUM(polls) AS polls, SUM(changes) AS changes, SUM(errors) AS errors FROM runs')
    .get();

  assert.ok(bilanz.polls > 0, 'ohne gebuchte Abfragen ist die Tabelle wertlos');
  assert.ok(
    bilanz.polls > bilanz.changes,
    `Abfragen (${bilanz.polls}) muessen ueber den Aenderungen (${bilanz.changes}) liegen`,
  );
  assert.ok(bilanz.errors >= 1, 'der Ausfall der Quelle muss gebucht sein');
  db.close();
});

test('der Zeitstempel der Quelle zaehlt, nicht die eigene Uhr', async () => {
  // Sonst haengt die Messreihe daran, wann der Sammler zufaellig hinsah,
  // statt daran, wann sich der Vorrat wirklich geaendert hat.
  const db = openStore(':memory:');
  const clock = fakeClock();
  const quelle = T0 - 7 * 3600000;

  await run({
    db,
    fetchJson: async () => payload(quelle, [[8, 3]]),
    intervalMs: 60000,
    minutes: 2,
    sleep: clock.sleep,
    now: clock.now,
  });

  assert.deepEqual(readSeries(db)['mex:8'], [[quelle, 3]]);
  db.close();
});
