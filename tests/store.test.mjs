// Der Speicher ist die Stelle, an der Monate an Messungen liegen. Ein Fehler
// hier faellt nicht beim Schreiben auf, sondern erst, wenn die Reihe gebraucht
// wird - und dann ist die Zeit vorbei, in der man sie haette messen koennen.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  splitKey, joinKey, toRows, fromRows,
  openStore, saveSeries, readSeries, recordRun, storeStats, stockPayload,
} from '../tools/store.mjs';

// ---------- Umrechnung, ohne Datenbank ----------

test('der Reihenschluessel zerfaellt in Land und Item', () => {
  assert.deepEqual(splitKey('mex:8'), { country: 'mex', item: 8 });
  assert.equal(joinKey('mex', 8), 'mex:8');
});

test('unbrauchbare Schluessel geben null statt halber Daten', () => {
  assert.equal(splitKey('mex'), null);
  assert.equal(splitKey(':8'), null, 'kein Land');
  assert.equal(splitKey('mex:abc'), null, 'keine Item-ID');
});

test('toRows ueberspringt Schrott, statt daran zu scheitern', () => {
  const rows = toRows({
    'mex:8': [[1000, 5], [2000, 3]],
    'kaputt': [[1000, 1]],
    'swi:20': 'keine Liste',
    'swi:21': [[1000], ['x', 'y'], [3000, 7]],
  });
  assert.deepEqual(rows, [
    { country: 'mex', item: 8, ts: 1000, quantity: 5 },
    { country: 'mex', item: 8, ts: 2000, quantity: 3 },
    { country: 'swi', item: 21, ts: 3000, quantity: 7 },
  ]);
});

test('fromRows sortiert nach Zeit und deckelt je Reihe', () => {
  const rows = [
    { country: 'mex', item: 8, ts: 3000, quantity: 1 },
    { country: 'mex', item: 8, ts: 1000, quantity: 5 },
    { country: 'mex', item: 8, ts: 2000, quantity: 3 },
  ];
  assert.deepEqual(fromRows(rows), { 'mex:8': [[1000, 5], [2000, 3], [3000, 1]] });
  // Der Deckel nimmt die neuesten, nicht die ersten: alte Punkte sind fuer die
  // Vorhersage die uninteressanten.
  assert.deepEqual(fromRows(rows, { limit: 2 }), { 'mex:8': [[2000, 3], [3000, 1]] });
});

// ---------- Datenbank ----------

const withDb = (fn) => {
  const db = openStore(':memory:');
  try { fn(db); } finally { db.close(); }
};

test('gespeicherte Reihen kommen unveraendert zurueck', () => {
  withDb((db) => {
    saveSeries(db, { 'mex:8': [[1000, 5], [2000, 3]], 'swi:20': [[1500, 40]] });
    assert.deepEqual(readSeries(db), {
      'mex:8': [[1000, 5], [2000, 3]],
      'swi:20': [[1500, 40]],
    });
  });
});

test('derselbe Messpunkt zweimal bleibt ein Messpunkt', () => {
  // Der Normalfall, nicht die Ausnahme: YATA haelt seine Antwort fest, bis
  // jemand importiert. Ohne diese Eigenschaft waere jede Reihe voller
  // Wiederholungen und jede Zaehlung darueber falsch.
  withDb((db) => {
    const series = { 'mex:8': [[1000, 5]] };
    assert.equal(saveSeries(db, series), 1);
    assert.equal(saveSeries(db, series), 0);
    assert.equal(storeStats(db).points, 1);
  });
});

test('ein spaeterer Lauf haengt an, statt zu ersetzen', () => {
  withDb((db) => {
    saveSeries(db, { 'mex:8': [[1000, 5]] });
    saveSeries(db, { 'mex:8': [[2000, 4]] });
    assert.deepEqual(readSeries(db)['mex:8'], [[1000, 5], [2000, 4]]);
  });
});

test('die Grenze nimmt die juengsten Punkte, je Reihe getrennt', () => {
  // Gelesen wird jetzt je Reihe mit ORDER BY ts DESC LIMIT statt der ganzen
  // Tabelle. Beim Umbau ist genau das die Stelle, an der man sich vertut: DESC
  // holt die neuesten, aber die Seite erwartet aufsteigende Zeit.
  withDb((db) => {
    saveSeries(db, {
      'mex:8': Array.from({ length: 50 }, (_, i) => [1000 + i * 1000, 100 - i]),
      'swi:20': Array.from({ length: 50 }, (_, i) => [1000 + i * 1000, 500 - i]),
    });

    const s = readSeries(db, { limit: 10 });
    assert.equal(s['mex:8'].length, 10, 'die Grenze greift je Reihe');
    assert.equal(s['swi:20'].length, 10, 'und nicht ueber alle zusammen');

    // Aufsteigend, und es sind die juengsten zehn.
    assert.deepEqual(s['mex:8'][0], [41000, 60]);
    assert.deepEqual(s['mex:8'][9], [50000, 51]);
    for (let i = 1; i < s['mex:8'].length; i++) {
      assert.ok(s['mex:8'][i][0] > s['mex:8'][i - 1][0], 'nicht aufsteigend sortiert');
    }
  });
});

test('das Lesen haengt nicht daran, wie alt die Sammlung ist', () => {
  // Der Grund fuer den Umbau: vorher las jede Anfrage die ganze Tabelle und
  // sortierte sie nach ts - einer Spalte, die nicht am Anfang des
  // Primaerschluessels steht. Gemessen an 227 Reihen wuchs das von 113 ms bei
  // 0,3 Tagen Historie auf 6063 ms bei 22,7 Tagen; je Reihe gefragt blieb es
  // bei 673 ms. Hier wird die Eigenschaft geprueft, nicht die Zeit: was
  // zurueckkommt, darf nicht davon abhaengen, wieviel Alteres darunter liegt.
  withDb((db) => {
    const jung = Array.from({ length: 5 }, (_, i) => [900000 + i * 1000, 10 + i]);
    saveSeries(db, { 'mex:8': jung });
    const vorher = readSeries(db, { limit: 5 })['mex:8'];

    // Viel Altes dazu - es liegt zeitlich davor und darf nichts aendern.
    saveSeries(db, {
      'mex:8': Array.from({ length: 2000 }, (_, i) => [1000 + i * 100, i % 90]),
    });
    const nachher = readSeries(db, { limit: 5 })['mex:8'];

    assert.deepEqual(nachher, vorher, 'aeltere Punkte veraendern die juengsten');
  });
});

test('nur ein Land lesen', () => {
  withDb((db) => {
    saveSeries(db, { 'mex:8': [[1000, 5]], 'swi:20': [[1000, 40]] });
    assert.deepEqual(Object.keys(readSeries(db, { country: 'mex' })), ['mex:8']);
  });
});

test('Kennzahlen ueber den ganzen Bestand', () => {
  withDb((db) => {
    saveSeries(db, { 'mex:8': [[1000, 5], [3000, 1]], 'swi:20': [[2000, 40]] });
    const s = storeStats(db);
    assert.equal(s.points, 3);
    assert.equal(s.series, 2);
    assert.equal(s.first, 1000);
    assert.equal(s.last, 3000);
  });
});

test('ohne Daten steht da nicht 0 statt nichts', () => {
  withDb((db) => {
    const s = storeStats(db);
    assert.equal(s.points, 0);
    assert.equal(s.first, null);
    assert.equal(s.collectedAt, null, 'nie gesammelt heisst nicht 1970');
  });
});

test('der letzte Lauf schlaegt den letzten Messpunkt', () => {
  // Sonst zeigt die Seite "zuletzt vor 6 Stunden", obwohl der Sammler die
  // ganze Zeit lief - YATA hatte nur nichts Neues.
  withDb((db) => {
    saveSeries(db, { 'mex:8': [[1000, 5]] });
    recordRun(db, { ts: 9000, source: 'https://yata.yt/x' });
    const s = storeStats(db);
    assert.equal(s.collectedAt, 9000);
    assert.equal(s.source, 'https://yata.yt/x');
  });
});

test('die Nutzlast hat genau die Form, die die Seite erwartet', () => {
  // data/travel-stock.json aus GitHub Actions: collectedAt, source, countries,
  // points, series. Weicht das ab, laedt die Flug-Seite still nichts.
  withDb((db) => {
    saveSeries(db, { 'mex:8': [[1000, 5], [2000, 3]], 'swi:20': [[1000, 40]] });
    recordRun(db, { ts: 5000, source: 'https://yata.yt/api/v1/travel/export/' });
    const payload = stockPayload(db);

    assert.deepEqual(Object.keys(payload).sort(),
      ['collectedAt', 'countries', 'points', 'series', 'source']);
    assert.equal(payload.countries, 2);
    assert.equal(payload.points, 3);
    assert.equal(payload.collectedAt, 5000);
    assert.deepEqual(payload.series['mex:8'], [[1000, 5], [2000, 3]]);
  });
});

test('der Deckel gilt fuer die Nutzlast, nicht fuer die Datenbank', () => {
  // Was rausgeht, landet im localStorage eines Telefons. Was drin bleibt, ist
  // die Grundlage fuer jede spaetere Auswertung - und darf wachsen.
  withDb((db) => {
    const points = Array.from({ length: 50 }, (_, i) => [1000 + i, i]);
    saveSeries(db, { 'mex:8': points });
    assert.equal(stockPayload(db, { limit: 10 }).series['mex:8'].length, 10);
    assert.equal(storeStats(db).points, 50);
  });
});
