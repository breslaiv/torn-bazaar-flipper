import test from 'node:test';
import assert from 'node:assert/strict';

function fakeStorage() {
  const map = new Map();
  return { getItem: () => null, setItem: () => {}, removeItem: () => {} };
}
globalThis.localStorage = fakeStorage();

const { MODELS, modelByKey, runModel, clampQuantity } = await import('../js/travelModels.js');
const {
  evaluateModels, chooseModel, chooseModelFor, rankModels, scoreModels, conformalInterval,
  predict, MIN_CHECKS, DEFAULT_MODEL,
} = await import('../js/travelStock.js');

const MIN = 60000;
const T0 = 1_700_000_000_000;
const series = (pairs) => pairs.map(([m, q]) => [T0 + m * MIN, q]);
const at = (m) => T0 + m * MIN;

test('jedes Modell ist benannt und nach Einfachheit geordnet', () => {
  const keys = MODELS.map((m) => m.key);
  assert.deepEqual(keys, ['flat', 'drift', 'cycle', 'daily']);
  const complexity = MODELS.map((m) => m.complexity);
  assert.deepEqual([...complexity].sort((a, b) => a - b), complexity, 'aufsteigend, sonst greift der Gleichstand falsch');
  assert.ok(MODELS.every((m) => m.label && typeof m.predict === 'function'));
});

test('ein Modell ohne Grundlage meldet sich ab, statt zu raten', () => {
  // "Tempo nach Tageszeit" braucht Abschnitte aus derselben Tageszeit.
  const zuWenig = series([[0, 100], [10, 90]]);
  assert.equal(runModel(modelByKey('daily'), zuWenig, 10, at(10)), null);
  assert.equal(runModel(modelByKey('flat'), [[T0, 5]], 10, T0), null, 'ein Punkt ist keine Reihe');
});

test('Vorhersagen bleiben im Moeglichen', () => {
  const points = series([[0, 100], [10, 50]]);
  assert.equal(clampQuantity(-40, points), 0, 'kein negativer Vorrat');
  assert.equal(clampQuantity(999, points), 100, 'nie mehr als je gesehen');
  assert.equal(clampQuantity(null, points), null);
});

test('bei gleichmaessigem Fall gewinnt der Trend, nicht das Stillstand-Modell', () => {
  const fallend = series(Array.from({ length: 9 }, (_, i) => [i * 10, 400 - i * 20]));
  const results = evaluateModels(fallend);
  const choice = chooseModel(results);

  assert.equal(choice.key, 'drift');
  assert.ok(results.get('drift').medianAbsError < results.get('flat').medianAbsError);
});

test('bei einem stehenden Regal gewinnt das einfachste Modell', () => {
  // Nichts passiert. Dann soll die App auch nichts hineinlesen.
  const steht = series([[0, 200], [30, 200], [60, 200], [90, 200], [120, 200], [150, 200]]);
  assert.equal(chooseModel(evaluateModels(steht)).key, 'flat');
});

test('ohne genug Kontrollen bleibt es beim Standard', () => {
  // Zwei Bremsen gegen Ueberanpassung, und das ist die erste: erst messen,
  // dann wechseln.
  const kurz = series([[0, 100], [10, 90], [20, 80]]);
  const choice = chooseModel(evaluateModels(kurz));
  assert.equal(choice.key, DEFAULT_MODEL);
  assert.match(choice.reason, /zu wenig/);
});

test('bei nahezu gleichem Fehler gewinnt das einfachere Modell', () => {
  // Die zweite Bremse: ein Wechsel wegen zwei Prozent Vorsprung waere kein
  // Lernen, sondern Rauschen.
  const results = new Map([
    ['flat', { key: 'flat', label: 'bleibt', checks: 10, medianAbsError: 10.4 }],
    ['drift', { key: 'drift', label: 'Trend', checks: 10, medianAbsError: 10 }],
    ['cycle', { key: 'cycle', label: 'Zyklus', checks: 10, medianAbsError: 9.9 }],
  ]);
  assert.equal(chooseModel(results).key, 'flat', 'alle innerhalb der Toleranz');

  const deutlich = new Map([
    ['flat', { key: 'flat', label: 'bleibt', checks: 10, medianAbsError: 80 }],
    ['drift', { key: 'drift', label: 'Trend', checks: 10, medianAbsError: 10 }],
  ]);
  assert.equal(chooseModel(deutlich).key, 'drift', 'ein echter Unterschied setzt sich durch');
});

test('die Auswahl braucht die Mindestzahl an Kontrollen je Modell', () => {
  const knapp = new Map([
    ['flat', { key: 'flat', label: 'bleibt', checks: MIN_CHECKS - 1, medianAbsError: 1 }],
  ]);
  assert.equal(chooseModel(knapp).key, DEFAULT_MODEL);
});

test('mit jeder Messung waechst die Pruefmenge', () => {
  // Der Kern von "wird mit jeder Messung besser": mehr Kontrollen, und die
  // Auswahl kann sich aendern.
  const kurz = series([[0, 400], [10, 380], [20, 360]]);
  const lang = series(Array.from({ length: 10 }, (_, i) => [i * 10, 400 - i * 20]));
  const wenig = evaluateModels(kurz).get('drift').checks;
  const viel = evaluateModels(lang).get('drift').checks;
  assert.ok(viel > wenig, `${viel} sollte mehr sein als ${wenig}`);
  assert.equal(chooseModel(evaluateModels(kurz)).key, DEFAULT_MODEL, 'anfangs der Standard');
  assert.equal(chooseModel(evaluateModels(lang)).key, 'drift', 'spaeter das gemessen bessere');
});

test('die Bewertung deckt auch laengere Horizonte ab', () => {
  // Ein Flug nach Suedafrika ist eine andere Aufgabe als einer nach Mexiko.
  // Deshalb wird nicht nur der naechste Punkt vorhergesagt.
  const lang = series(Array.from({ length: 8 }, (_, i) => [i * 10, 400 - i * 20]));
  const horizons = evaluateModels(lang).get('drift').residuals.map((r) => r.horizon);
  assert.ok(Math.max(...horizons) >= 30, `groesster Horizont nur ${Math.max(...horizons)}`);
  assert.ok(new Set(horizons).size > 1, 'mehrere Horizonte, nicht nur einer');
});

// ---------- Konformalprognose ----------

test('der Bereich kommt aus den eigenen Fehlern', () => {
  const residuals = [-20, -10, -5, 0, 5, 10, 20].map((residual) => ({ horizon: 30, residual }));
  const band = conformalInterval(residuals, 30, 0.8);
  assert.ok(band.lowOffset < 0 && band.highOffset > 0);
  assert.equal(band.samples, 7);
  assert.equal(band.scaled, false);
});

test('ohne passende Horizonte wird gestreckt, und das steht dabei', () => {
  // Alle Fehler stammen aus 10-Minuten-Abstaenden, gefragt ist ein Flug ueber
  // Stunden. Die Streckung ist eine Annahme - also wird sie benannt.
  const residuals = [-6, -3, 0, 3, 6].map((residual) => ({ horizon: 10, residual }));
  const kurz = conformalInterval(residuals, 10, 0.8);
  const lang = conformalInterval(residuals, 300, 0.8);
  assert.equal(kurz.scaled, false);
  assert.equal(lang.scaled, true);
  assert.ok(Math.abs(lang.highOffset) > Math.abs(kurz.highOffset), 'weiter weg heisst unsicherer');
});

test('ohne Fehler gibt es keinen Bereich', () => {
  assert.equal(conformalInterval([], 30), null);
});

test('das gewaehlte Modell steht in der Auskunft', () => {
  // Nachvollziehbar statt Blackbox: es muss ablesbar sein, warum diese Zahl.
  const fallend = series(Array.from({ length: 9 }, (_, i) => [i * 10, 400 - i * 20]));
  const p = predict(fallend, 20, at(80));
  assert.equal(p.model.key, 'drift');
  assert.match(p.why, /Netto-Trend/);
  assert.match(p.why, /Selbstkontrollen/);
});

test('ein Sieger ohne Grundlage blockiert nicht die ganze Vorhersage', () => {
  // Aus dem Browsertest: "Tempo nach Tageszeit" gewann auf kurzen Abstaenden
  // und meldete sich beim Zehn-Stunden-Flug ab - die Zeile sagte daraufhin
  // "zu wenig Daten", obwohl drei andere Modelle bereitstanden.
  const unruhig = series([
    [0, 40], [30, 3], [60, 38], [90, 2], [120, 36], [150, 4], [180, 35], [210, 5],
  ]);
  const results = evaluateModels(unruhig);
  const langerFlug = 594;

  const gewaehlt = chooseModelFor(results, unruhig, langerFlug, at(210));
  assert.ok(runModel(modelByKey(gewaehlt.key), unruhig, langerFlug, at(210)) !== null,
    `${gewaehlt.key} kann die Frage nicht beantworten`);

  const p = predict(unruhig, langerFlug, at(210));
  assert.ok(Number.isFinite(p.quantity), 'es muss eine Zahl herauskommen');
});

test('rankModels ordnet nach Fehler, mit Einfachheit als Gleichstand', () => {
  const results = new Map([
    ['flat', { key: 'flat', label: 'bleibt', checks: 10, medianAbsError: 10.2 }],
    ['drift', { key: 'drift', label: 'Trend', checks: 10, medianAbsError: 10 }],
    ['daily', { key: 'daily', label: 'Tageszeit', checks: 10, medianAbsError: 90 }],
  ]);
  const rang = rankModels(results).map((r) => r.key);
  assert.deepEqual(rang, ['flat', 'drift', 'daily'], 'zwei gleichauf, der klar schlechtere hinten');
});

// ---------- Bewertung in der richtigen Lage ----------

/** Ein Regal, das leerlaeuft, 60 Minuten leer bleibt und dann voll ist. */
function zyklusReihe(zyklen = 3) {
  const punkte = [];
  let m = 0;
  for (let i = 0; i < zyklen; i++) {
    punkte.push([m, 200], [m + 10, 150], [m + 20, 100], [m + 30, 50], [m + 40, 0]);
    // Alle zehn Minuten gemessen, waehrend der Timer laeuft.
    for (let leer = 50; leer < 100; leer += 10) punkte.push([m + leer, 0]);
    m += 100;
  }
  punkte.push([m, 200]);
  return series(punkte);
}

test('der Mittelwert laesst den einen grossen Fehler durch, den der Median schluckt', () => {
  // Der Fund aus dem Browsertest: bei zehnminuetigen Messungen ist ein leeres
  // Regal fuenfmal hintereinander leer und einmal voll. "Bleibt wie es ist"
  // liegt in fuenf von sechs Faellen exakt richtig - der Median seines
  // Fehlers ist null, und damit gewinnt es jeden Vergleich. Nur ist es genau
  // im entscheidenden Moment um 200 daneben.
  const reihe = zyklusReihe();
  const roh = evaluateModels(reihe);
  const ausLeer = scoreModels(roh, { fromEmpty: true });

  const flat = ausLeer.get('flat');
  assert.ok(
    flat.meanAbsError > flat.medianAbsError * 2,
    `Median ${flat.medianAbsError} gegen Mittelwert ${flat.meanAbsError}`,
  );
});

test('aus dem leeren Regal gewinnt auf kurze Frist das Modell, das den Nachschub kennt', () => {
  // Mit Frist geprueft, weil die App genau so waehlt: predict() reicht den
  // Horizont an scoreModels() weiter. Ohne ihn werden alle Fristen vermischt,
  // und das Ergebnis beantwortet keine Frage, die jemand stellt.
  const reihe = zyklusReihe();
  const roh = evaluateModels(reihe);
  assert.equal(chooseModel(scoreModels(roh, { fromEmpty: true, horizon: 30 })).key, 'cycle');
});

test('drei Stunden voraus laesst sich die Phase eines Zyklus nicht mehr raten', () => {
  // Der Zyklus dieser Reihe dauert 100 Minuten. Auf 180 Minuten Frist weiss
  // auch das Modell mit Timer nicht, wo im Zyklus man landet - und dann
  // gewinnt zu Recht das einfachste Verfahren. Das ist kein Mangel der
  // Auswahl, sondern eine Grenze der Vorhersagbarkeit, und sie soll
  // sichtbar bleiben.
  const roh = evaluateModels(zyklusReihe());
  assert.equal(chooseModel(scoreModels(roh, { fromEmpty: true, horizon: 180 })).key, 'flat');

  // Aus dem vollen Regal traegt der Mechanismus dagegen auch weit: dort ist
  // der Ausverkauf die Hauptbewegung, und den kennt cycle.
  assert.equal(chooseModel(scoreModels(roh, { fromEmpty: false, horizon: 180 })).key, 'cycle');
});

test('die Bewertung nimmt nur Kontrollen aus derselben Lage', () => {
  const roh = evaluateModels(zyklusReihe());
  const ausLeer = scoreModels(roh, { fromEmpty: true });
  const ausVoll = scoreModels(roh, { fromEmpty: false });

  assert.ok(ausLeer.get('flat').checks > 0 && ausVoll.get('flat').checks > 0);
  assert.notEqual(ausLeer.get('flat').checks, ausVoll.get('flat').checks);
  assert.equal(ausLeer.get('flat').matched, 'lage');
});

test('bei zu wenigen passenden Kontrollen wird die Grundlage verbreitert', () => {
  // Lieber eine schmale Grundlage als keine - aber es steht dabei, welche.
  const kaumLeer = series([[0, 200], [10, 150], [20, 100], [30, 50], [40, 20], [50, 10]]);
  const scored = scoreModels(evaluateModels(kaumLeer), { fromEmpty: true });
  assert.equal(scored.get('flat').matched, 'alle');
});

test('bei passender Flugdauer wird auf den Horizont geschaerft', () => {
  const reihe = zyklusReihe(4);
  const scored = scoreModels(evaluateModels(reihe), { fromEmpty: true, horizon: 20 });
  assert.equal(scored.get('flat').matched, 'lage+horizont');
  assert.ok(scored.get('flat').residuals.every((r) => r.horizon >= 20 / 3 && r.horizon <= 60));
});

test('ein leeres Regal mit laufendem Timer bleibt ein Ziel', () => {
  // Das Ergebnis, auf das alles hinauslaeuft: wer jetzt hinschaut, sieht
  // nichts - wer in einer halben Stunde landet, ein volles Regal.
  const reihe = zyklusReihe();
  const jetzt = reihe[reihe.length - 1][0];
  const leerJetzt = [...reihe.slice(0, -1), [jetzt, 0]];

  const p = predict(leerJetzt, 30, jetzt + 5 * 60000);
  assert.equal(p.model.key, 'cycle');
  assert.ok(p.quantity > 0, `bei Landung ${p.quantity} — der Nachschub fehlt in der Rechnung`);
  assert.ok(p.restock, 'und der Zeitpunkt gehört dazu');
});
