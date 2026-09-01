// Der Trichter ist die Erklaerung fuer eine leere Trefferliste. Wenn er die
// falsche Stufe beschuldigt, dreht man am falschen Regler - schlimmer als gar
// keine Erklaerung.

import test from 'node:test';
import assert from 'node:assert/strict';
import { funnelStages, biggestDrop } from '../js/funnel.js';

const SETTINGS = {
  scanMode: 'flip',
  prescreenPct: 90,
  maxCandidates: 35,
  minProfitAbs: 10000,
  minProfitPct: 5,
  minBuyerRating: 0,
  maxBuyPrice: 0,
  budget: 0,
};

const STATS = {
  catalogSize: 1000,
  listed: 800,
  discounted: 60,
  affordable: 60,
  profitable: 40,
  candidates: 35,
  checked: 35,
  withoutBuyer: 10,
  buyerBelowRating: 5,
  rowsBuilt: 48,
  belowProfit: 44,
  filteredOut: 2,
};

const byKey = (stages) => Object.fromEntries(stages.map((s) => [s.key, s]));

test('die Stufen folgen der Reihenfolge, in der wirklich gesiebt wird', () => {
  const keys = funnelStages(STATS, [], SETTINGS).map((s) => s.key);
  assert.deepEqual(keys, [
    'catalog', 'listed', 'discounted', 'profitable', 'candidates', 'buyer',
    'rows', 'profit', 'limits',
  ]);
});

test('jede Stufe zeigt, was sie wegnimmt', () => {
  const s = byKey(funnelStages(STATS, [], SETTINGS));
  assert.equal(s.listed.lost, 200);
  assert.equal(s.discounted.lost, 740);
  assert.equal(s.profitable.lost, 20);
  assert.equal(s.candidates.lost, 5);
  // Ohne Kaeufer plus unter Mindestbewertung.
  assert.equal(s.buyer.lost, 15);
  assert.equal(s.buyer.kept, 20);
  assert.equal(s.profit.lost, 44);
  assert.equal(s.limits.lost, 2);
});

test('der Uebergang von Items auf Angebote ist als eigener Abschnitt markiert', () => {
  // Sonst steigt die Zahl mitten im Trichter und sieht aus wie ein Fehler:
  // ein Item bringt mehrere Listings mit.
  const s = byKey(funnelStages(STATS, [], SETTINGS));
  assert.equal(s.buyer.section, 'items');
  assert.equal(s.rows.section, 'offers');
  assert.ok(s.rows.kept > s.buyer.kept, 'Testdaten treffen den Sprung nicht');
});

test('der Grund nennt beide Kaeufer-Faelle getrennt', () => {
  // "kein Abnehmer" laesst sich nicht einstellen, "unter der Bewertung" schon.
  const s = byKey(funnelStages(STATS, [], SETTINGS));
  assert.match(s.buyer.why, /10 ohne aktiven Abnehmer/);
  assert.match(s.buyer.why, /5 nur unter Bewertung 0/);
  assert.equal(s.buyer.control, 'Mindestbewertung Käufer');
});

test('ohne Ausschluss wegen Bewertung nennt die Stufe keinen Regler', () => {
  const s = byKey(funnelStages({ ...STATS, buyerBelowRating: 0 }, [], SETTINGS));
  assert.equal(s.buyer.control, null);
});

test('Stufen ohne gesetzten Regler tauchen gar nicht erst auf', () => {
  const ohne = funnelStages(STATS, [], SETTINGS).map((s) => s.key);
  assert.ok(!ohne.includes('affordable'), 'Preisgrenze steht auf 0');
  assert.ok(!ohne.includes('budget'), 'Budget steht auf 0');

  const mit = funnelStages(STATS, [], { ...SETTINGS, maxBuyPrice: 500000, budget: 1000000 })
    .map((s) => s.key);
  assert.ok(mit.includes('affordable'));
  assert.ok(mit.includes('budget'));
});

test('das Budget wird aus den Zeilen gezaehlt, nicht aus stats', () => {
  // allocateBudget() verteilt erst, wenn alle Zeilen feststehen - vorher weiss
  // keine Zeile, welche besseren es noch gibt.
  const rows = [{ units: 3 }, { units: 0 }, { units: 0 }];
  const s = byKey(funnelStages(STATS, rows, { ...SETTINGS, budget: 250000 }));
  assert.equal(s.budget.kept, 1);
  assert.equal(s.budget.lost, 2);
});

test('der $1-Modus zeigt keine Kaeufer- und Vorauswahlstufen', () => {
  const keys = funnelStages(
    { catalogSize: 200, rowsBuilt: 200, belowProfit: 190, filteredOut: 5 },
    [],
    { ...SETTINGS, scanMode: 'dollar' },
  ).map((s) => s.key);
  assert.deepEqual(keys, ['catalog', 'rows', 'profit', 'limits']);
});

test('der groesste Verlust zeigt auf einen Regler, nicht auf den Markt', () => {
  // "Kein Bazaar-Listing hinterlegt" ist der groesste Posten, aber daran
  // laesst sich nichts drehen - der Hinweis waere eine Sackgasse.
  const stats = { ...STATS, listed: 100, discounted: 90 };
  const worst = biggestDrop(funnelStages(stats, [], SETTINGS));
  assert.equal(worst.key, 'profit');
  assert.ok(worst.control);
});

test('ohne jeden Verlust gibt es keine Empfehlung', () => {
  const clean = {
    catalogSize: 5, listed: 5, discounted: 5, affordable: 5, profitable: 5,
    candidates: 5, checked: 5, withoutBuyer: 0, buyerBelowRating: 0,
    rowsBuilt: 5, belowProfit: 0, filteredOut: 0,
  };
  assert.equal(biggestDrop(funnelStages(clean, [], SETTINGS)), null);
});

test('fehlgeschlagene Abfragen verschwinden nicht stillschweigend', () => {
  // Sonst sieht ein Rate-Limit oder ein Netzaussetzer aus wie ein Markt, der
  // nichts hergibt - und man dreht am Rabatt statt es noch einmal zu versuchen.
  const s = byKey(funnelStages({ ...STATS, checked: 30, failed: 5 }, [], SETTINGS));
  assert.equal(s.checked.kept, 30);
  assert.equal(s.checked.lost, 5);
  assert.match(s.checked.why, /nicht der Markt/);
  // Die Kaeuferstufe rechnet danach von den tatsaechlich geprueften weiter.
  assert.equal(s.buyer.kept, 15);
});

test('ohne Fehlschlaege gibt es die Stufe gar nicht', () => {
  const keys = funnelStages(STATS, [], SETTINGS).map((x) => x.key);
  assert.ok(!keys.includes('checked'));
});

test('fehlende Zaehler kippen den Trichter nicht um', () => {
  // Ein alter Stand oder ein abgebrochener Scan liefert nicht jedes Feld.
  const stages = funnelStages({ catalogSize: 10, candidates: 3 }, [], SETTINGS);
  for (const stage of stages) {
    assert.ok(Number.isFinite(stage.kept), `${stage.key}: kept ist keine Zahl`);
    assert.ok(stage.lost >= 0, `${stage.key}: negativer Verlust`);
  }
});
