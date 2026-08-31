// Vorhersage der Auslandsvorraete.
//
// Ein Vorrat bewegt sich in zwei Richtungen: Spieler kaufen ihn leer, und in
// Abstaenden legt der Shop nach. Beides laesst sich nicht ausrechnen, nur
// beobachten - also merkt sich die App jede gesehene Menge und leitet aus der
// Reihe ab, wie schnell es faellt und wieviel wann dazukommt.
//
// Drei Entscheidungen praegen das Modell:
//
//   Gewichtung   Juengere Messungen zaehlen mehr. Der Abverkauf schwankt ueber
//                den Tag - nachts steht die Ware, abends ist sie in Minuten
//                weg -, und ein Median ueber eine Woche mittelt beides zu
//                einer Zahl zusammen, die zu keiner Tageszeit stimmt.
//
//   Bereich      Statt einer Zahl ein Bereich und die Wahrscheinlichkeit, dass
//                es fuer die eigene Kapazitaet reicht. Das ist die
//                Entscheidung, um die es geht - "6 Stueck" klingt nach Wissen,
//                "Chance auf 5 Stueck: 40%" ist eine Auskunft.
//
//   Selbstkontrolle  Jede Reihe wird gegen sich selbst geprueft: aus dem
//                Anfang vorhersagen, mit dem naechsten echten Wert
//                vergleichen. So kommt die Guete aus Messung statt aus einer
//                Faustregel, die ich mir ausgedacht habe.

import { median, weightAt, weightedQuantile, HALF_LIFE_MINUTES } from './stats.js?v=10';
import { MODELS, modelByKey, runModel, drainRate } from './travelModels.js?v=10';
import { findCycles, estimateTimer, estimateCapacity, nextRestock } from './restock.js?v=10';

// Weitergereicht, damit Aufrufer nur ein Modul kennen muessen.
export { weightAt, weightedQuantile, HALF_LIFE_MINUTES };

export const STOCK_KEY = 'tbf.travelstock.v1';

/** Beobachtungen je Item. Mehr braucht keine Schaetzung, und der Platz ist knapp. */
export const MAX_SAMPLES = 40;

/** Naeher beieinander liegende Messungen sagen nichts Neues. */
export const MIN_GAP_MS = 60 * 1000;

const MINUTE = 60 * 1000;

const seriesKey = (country, itemId) => `${country}:${itemId}`;

/**
 * Traegt eine Beobachtung nach.
 * @param {object} store  {key: [[ts, quantity], ...]}
 */
export function recordSnapshot(store, country, items, ts = Date.now()) {
  const next = { ...store };
  for (const item of items) {
    if (!Number.isFinite(item.itemId) || !Number.isFinite(item.quantity)) continue;
    const key = seriesKey(country, item.itemId);
    const series = next[key] ? [...next[key]] : [];
    const last = series[series.length - 1];

    // Derselbe Abzug zweimal gelesen ist eine Messung, nicht zwei: YATA cacht
    // die Antwort bis zum naechsten Import, und aus lauter gleichen Mengen
    // entstuende sonst ein Abverkauf von null.
    if (last && ts - last[0] < MIN_GAP_MS) continue;
    if (last && last[1] === item.quantity && ts - last[0] < 5 * MIN_GAP_MS) continue;

    series.push([ts, item.quantity]);
    next[key] = series.slice(-MAX_SAMPLES);
  }
  return next;
}

/** Aufeinanderfolgende Messungen als Veraenderungen. */
function intervals(points) {
  const out = [];
  for (let i = 1; i < points.length; i++) {
    const [t0, q0] = points[i - 1];
    const [t1, q1] = points[i];
    const minutes = (t1 - t0) / MINUTE;
    if (minutes <= 0) continue;
    out.push({ at: t1, minutes, from: q0, to: q1, change: q1 - q0 });
  }
  return out;
}

/**
 * Schaetzt Abverkauf und Nachschub aus einer Messreihe.
 *
 * Der Abverkauf kommt aus den fallenden Abschnitten, gewichtet nach Alter.
 * Der Nachschub aus den steigenden - dessen Menge ist die Untergrenze des
 * echten Nachschubs, weil zwischen zwei Messungen auch wieder gekauft wurde.
 */
export function estimate(series = [], now = Date.now()) {
  const points = [...series].sort((a, b) => a[0] - b[0]);
  const spans = intervals(points);

  // Bezugspunkt ist die juengste Messung der Reihe selbst.
  const reference = points.length ? points[points.length - 1][0] : now;

  const drains = spans
    .filter((s) => s.change < 0)
    .map((s) => ({ value: -s.change / s.minutes, weight: weightAt(s.at, reference) }));

  const restocks = spans.filter((s) => s.change > 0);
  const restockSamples = restocks.map((s) => ({ value: s.change, weight: weightAt(s.at, reference) }));

  const gaps = [];
  for (let i = 1; i < restocks.length; i++) {
    gaps.push((restocks[i].at - restocks[i - 1].at) / MINUTE);
  }

  return {
    samples: points.length,
    first: points.length ? points[0][0] : null,
    last: points.length ? points[points.length - 1][0] : null,
    latest: points.length ? points[points.length - 1][1] : null,
    maxSeen: points.length ? Math.max(...points.map((p) => p[1])) : null,
    drainPerMinute: weightedQuantile(drains, 0.5),
    // Die Spanne der beobachteten Tempi ist die Unsicherheit der Vorhersage.
    drainSlow: weightedQuantile(drains, 0.1),
    drainFast: weightedQuantile(drains, 0.9),
    drainSamples: drains,
    restockAmount: weightedQuantile(restockSamples, 0.5),
    restockIntervalMinutes: median(gaps),
    lastRestockAt: restocks.length ? restocks[restocks.length - 1].at : null,
    restocksSeen: restocks.length,
  };
}

// ---------- Wettbewerb der Modelle ----------

/** Erst ab so vielen Kontrollen darf ein Modell das bisherige abloesen. */
export const MIN_CHECKS = 4;

/** Standard, solange nichts gemessen ist: das Modell, mit dem die App startete. */
export const DEFAULT_MODEL = 'cycle';

/**
 * Prueft alle Modelle gegen die Vergangenheit der Reihe.
 *
 * Rollender Ursprung: von jedem Punkt aus wird der naechste vorhergesagt und
 * mit dem echten Wert verglichen. Zusaetzlich der uebernaechste und der
 * darauffolgende - so entstehen Fehler auch fuer laengere Horizonte, ohne
 * dass man sie annehmen muss. Ein Flug nach Suedafrika ist eine andere
 * Aufgabe als einer nach Mexiko, und der Bereich soll das wissen.
 */
export function evaluateModels(series = []) {
  const points = [...series].sort((a, b) => a[0] - b[0]);
  const results = new Map();
  for (const model of MODELS) results.set(model.key, { key: model.key, label: model.label, residuals: [] });

  for (let i = 2; i < points.length; i++) {
    const known = points.slice(0, i);
    const asOf = known[known.length - 1][0];

    // Bis zu drei Schritte in die Zukunft, solange die Reihe reicht.
    for (let step = 0; step < 3 && i + step < points.length; step++) {
      const [ts, actual] = points[i + step];
      const ahead = (ts - asOf) / MINUTE;
      if (ahead <= 0) continue;

      // Ob das Regal beim Vorhersagen leer war, wird mitgeschrieben: ein
      // Modell, das im Normalbetrieb gut ist, kann ausgerechnet aus der Null
      // heraus nichts taugen.
      const fromEmpty = known[known.length - 1][1] === 0;
      for (const model of MODELS) {
        const predicted = runModel(model, known, ahead, asOf);
        if (predicted === null) continue;
        results.get(model.key).residuals.push({ horizon: ahead, residual: actual - predicted, fromEmpty });
      }
    }
  }

  for (const r of results.values()) {
    const errors = r.residuals.map((x) => Math.abs(x.residual));
    r.checks = errors.length;
    r.medianAbsError = median(errors);
    r.worstAbsError = errors.length ? Math.max(...errors) : null;
  }
  return results;
}

/**
 * Waehlt das Modell fuer diese Reihe.
 *
 * Zwei Bremsen gegen Ueberanpassung: ohne Mindestzahl an Kontrollen bleibt es
 * beim Standard, und bei annaehernd gleichem Fehler gewinnt das einfachere
 * Modell. Ein Wechsel wegen zwei Prozent Vorsprung waere kein Lernen,
 * sondern Rauschen.
 */
/**
 * Bewertet die Modelle in der Lage, in der sie gefragt werden.
 *
 * Der Grund: ein leeres Regal mit laufendem Timer ist ein anderer Fall als
 * ein volles, das sich leert. Ueber alle Kontrollen gemittelt gewinnt der
 * Netto-Trend, weil die meisten Pruefpunkte aus der Leerlaufphase stammen -
 * und sagt dann fuer die Null einen Nachschub von nichts voraus. Genau das
 * Ziel, auf das man wartet, faellt damit aus der Planung.
 *
 * Gibt es zu wenige Kontrollen aus derselben Lage, wird auf alle
 * zurueckgegriffen: eine schmale Grundlage ist besser als keine.
 */
export function scoreModels(results, { fromEmpty = null, horizon = null } = {}) {
  const scored = new Map();

  for (const r of results.values()) {
    // Drei Stufen, von der schaerfsten Passung zur breitesten Grundlage.
    const gleicheLage = fromEmpty === null
      ? r.residuals
      : r.residuals.filter((x) => Boolean(x.fromEmpty) === fromEmpty);
    const gleicherHorizont = horizon
      ? gleicheLage.filter((x) => x.horizon >= horizon / 3 && x.horizon <= horizon * 3)
      : [];

    let residuals = r.residuals;
    let matched = 'alle';
    if (gleicherHorizont.length >= MIN_CHECKS) {
      residuals = gleicherHorizont;
      matched = 'lage+horizont';
    } else if (gleicheLage.length >= MIN_CHECKS) {
      residuals = gleicheLage;
      matched = 'lage';
    }

    const errors = residuals.map((x) => Math.abs(x.residual));
    scored.set(r.key, {
      key: r.key,
      label: r.label,
      residuals,
      checks: errors.length,
      // Gewichtet wird mit dem Mittelwert, nicht mit dem Median. Der Median
      // ist robust gegen Ausreisser - aber hier ist der Ausreisser genau das
      // Ereignis, um das es geht. Bei zehnminuetigen Messungen ist ein leeres
      // Regal fuenfmal hintereinander leer und einmal voll; ein Modell, das
      // den Nachschub nie sieht, gewinnt jeden Median-Vergleich mit Fehler
      // null. Der Mittelwert laesst den einen grossen Fehler durch.
      meanAbsError: errors.length ? errors.reduce((s, e) => s + e, 0) / errors.length : null,
      medianAbsError: median(errors),
      matched,
    });
  }
  return scored;
}

export function rankModels(results) {
  const score = (r) => (Number.isFinite(r.meanAbsError) ? r.meanAbsError : r.medianAbsError);
  const usable = [...results.values()]
    .filter((r) => r.checks >= MIN_CHECKS && Number.isFinite(score(r)));
  if (!usable.length) return [];

  const best = Math.min(...usable.map(score));
  // Toleranz statt strengem Minimum: der Zuschlag faengt den Fall ab, dass
  // alle Fehler nahe null liegen und ein Zufall entscheidet.
  const tolerance = best * 1.1 + 0.5;
  const eligible = usable.filter((r) => score(r) <= tolerance)
    .sort((a, b) => modelByKey(a.key).complexity - modelByKey(b.key).complexity);
  const rest = usable.filter((r) => score(r) > tolerance).sort((a, b) => score(a) - score(b));

  return [...eligible, ...rest].map((r) => ({
    key: r.key,
    label: r.label,
    checks: r.checks,
    meanAbsError: r.meanAbsError,
    medianAbsError: r.medianAbsError,
    matched: r.matched,
    reason: usable.length > 1 ? `bester von ${usable.length} geprüften Modellen` : 'einziges prüfbares Modell',
  }));
}

const fallbackChoice = (key, reason) => ({
  key,
  label: modelByKey(key)?.label ?? key,
  checks: 0,
  reason,
});

export function chooseModel(results) {
  return rankModels(results)[0] || fallbackChoice(DEFAULT_MODEL, 'zu wenig geprüft');
}

/**
 * Waehlt das beste Modell, das die gestellte Frage auch beantworten kann.
 *
 * Ein Modell darf sich abmelden - "Tempo nach Tageszeit" tut das, wenn fuer
 * die Ankunftszeit keine vergleichbaren Abschnitte vorliegen. Frueher hat
 * genau das die ganze Vorhersage blockiert: der Sieger schwieg, und die Zeile
 * sagte "zu wenig Daten", obwohl drei andere Modelle bereitstanden. Bei einem
 * Zehn-Stunden-Flug ist das der Regelfall, nicht die Ausnahme.
 */
export function chooseModelFor(results, points, minutesAhead, now) {
  for (const candidate of rankModels(results)) {
    if (runModel(modelByKey(candidate.key), points, minutesAhead, now) !== null) return candidate;
  }

  // Rueckfallkette. Der Standard ist der Zyklus, weil er den Mechanismus des
  // Spiels abbildet - aber er kann erst antworten, wenn ein Ausverkauf
  // beobachtet wurde. Vorher traegt der Trend, zur Not die letzte Menge.
  // Wichtig: zurueckgegeben wird der Schluessel, der tatsaechlich geantwortet
  // hat. Vorher stand hier immer der Standard, und die Vorhersage lief gegen
  // ein Modell, das gerade geschwiegen hatte.
  const geprueft = rankModels(results).length;
  for (const key of [DEFAULT_MODEL, 'drift', 'flat']) {
    if (runModel(modelByKey(key), points, minutesAhead, now) !== null) {
      return fallbackChoice(key, geprueft ? 'Ersatz für ein Modell ohne Grundlage' : 'zu wenig geprüft');
    }
  }
  return fallbackChoice(DEFAULT_MODEL, 'kein Modell mit Grundlage');
}

/**
 * Bereich aus den eigenen vergangenen Fehlern (Konformalprognose).
 *
 * Statt von mir gesetzter Quantile die Verteilung der tatsaechlichen
 * Abweichungen: ein 80%-Bereich ist dann einer, der in der Vergangenheit zu
 * 80% getroffen hat - nachpruefbar, und mit jeder Messung genauer.
 *
 * Herangezogen werden Fehler aus aehnlich langen Horizonten, denn die
 * Unsicherheit waechst mit der Flugzeit. Gibt es davon zu wenige, werden alle
 * genommen und mit der Wurzel des Verhaeltnisses gestreckt - eine Annahme,
 * aber eine benannte.
 */
export function conformalInterval(residuals, horizon, level = 0.8) {
  if (!residuals.length) return null;

  const near = residuals.filter((r) => r.horizon >= horizon / 3 && r.horizon <= horizon * 3);
  const used = near.length >= 3 ? near : residuals;
  const scale = near.length >= 3
    ? 1
    : Math.min(4, Math.max(1, Math.sqrt(horizon / Math.max(1, median(residuals.map((r) => r.horizon))))));

  const values = used.map((r) => r.residual).sort((a, b) => a - b);
  const tail = (1 - level) / 2;
  const at = (q) => values[Math.min(values.length - 1, Math.max(0, Math.floor(q * (values.length - 1))))];

  return {
    lowOffset: at(tail) * scale,
    highOffset: at(1 - tail) * scale,
    samples: used.length,
    scaled: scale !== 1,
  };
}

/**
 * Alles zum Nachschub-Zyklus einer Reihe - unabhaengig davon, welches Modell
 * gerade die Menge vorhersagt.
 *
 * Das ist die Auskunft, auf die es beim Item-Running ankommt: nicht wieviel
 * dasteht, sondern wann wieder nachgelegt wird. Ein leeres Regal mit
 * bekanntem Timer ist eine bessere Nachricht als ein halbvolles ohne.
 */
export function restockInfo(series = [], now = Date.now()) {
  const points = [...series].sort((a, b) => a[0] - b[0]);
  if (points.length < 2) return { timer: null, restock: null, cycles: 0, capacity: null };

  const cycles = findCycles(points);
  const timer = estimateTimer(cycles);
  const [lastAt, lastQuantity] = points[points.length - 1];
  const laufend = cycles[cycles.length - 1];

  return {
    timer,
    cycles: cycles.length,
    openCycle: Boolean(laufend?.open),
    capacity: estimateCapacity(points, cycles),
    drainPerMinute: drainRate(points),
    restock: nextRestock({
      quantity: lastQuantity,
      at: lastAt,
      drainPerMinute: drainRate(points),
      timer,
      lastSelloutAt: laufend && lastQuantity === 0 ? laufend.selloutTo : null,
    }, now),
  };
}

/**
 * Vorhersage: gewaehltes Modell, Bereich aus gemessenen Fehlern, Guete aus
 * bestandenen Kontrollen.
 */
export function predict(series, minutesAhead, now = Date.now()) {
  const points = [...series].sort((a, b) => a[0] - b[0]);
  const e = estimate(points, now);

  if (points.length < 2) {
    return {
      quantity: null,
      low: null,
      high: null,
      confidence: 'unbekannt',
      why: 'zu wenige Beobachtungen — beim nächsten Blick wird es besser',
      model: null,
      estimate: e,
      accuracy: { checks: 0, medianAbsError: null, coverage: null },
      timer: null,
      restock: null,
      cycles: 0,
    };
  }

  const leer = points[points.length - 1][1] === 0;
  const elapsedNow = Math.max(0, (now - points[points.length - 1][0]) / MINUTE);
  const results = scoreModels(evaluateModels(points), {
    fromEmpty: leer,
    horizon: elapsedNow + Math.max(0, minutesAhead),
  });
  const choice = chooseModelFor(results, points, minutesAhead, now);
  const model = modelByKey(choice.key);
  const quantity = runModel(model, points, minutesAhead, now);

  if (quantity === null) {
    return {
      quantity: null,
      low: null,
      high: null,
      confidence: 'unbekannt',
      why: `${choice.label} hat für diese Reihe keine Grundlage`,
      model: choice,
      estimate: e,
      accuracy: { checks: 0, medianAbsError: null, coverage: null },
    };
  }

  const elapsed = Math.max(0, (now - points[points.length - 1][0]) / MINUTE);
  const horizon = elapsed + Math.max(0, minutesAhead);
  const residuals = results.get(choice.key).residuals;
  const band = conformalInterval(residuals, horizon);
  const maxSeen = e.maxSeen ?? quantity;

  let low = quantity;
  let high = quantity;
  if (band) {
    low = quantity + band.lowOffset;
    high = quantity + band.highOffset;
  }
  low = Math.max(0, Math.round(Math.min(low, quantity)));
  high = Math.min(maxSeen, Math.round(Math.max(high, quantity)));

  const accuracy = accuracyOf(residuals, band, horizon);
  const parts = [`Modell „${choice.label}"`];
  const matched = results.get(choice.key)?.matched;
  if (matched === 'lage+horizont') parts.push(leer ? 'geprüft aus leerem Regal, gleiche Flugdauer' : 'geprüft für diese Flugdauer');
  else if (matched === 'lage') parts.push(leer ? 'geprüft aus leerem Regal' : 'geprüft aus laufendem Bestand');
  if (accuracy.checks) {
    parts.push(`${accuracy.checks} Selbstkontrollen, Median-Fehler ${Math.round(accuracy.medianAbsError)}`);
  } else {
    parts.push(choice.reason);
  }
  if (band?.scaled) parts.push('Bereich auf die Flugzeit hochgerechnet');

  // Guete heisst zweierlei, und beides muss stimmen: der Bereich muss halten
  // *und* schmal genug sein, um darauf zu entscheiden. Seit er aus den
  // eigenen Fehlern kommt, haelt er fast immer - ein Bereich von 0 bis 400
  // trifft zuverlaessig und sagt nichts. Deshalb zaehlt jetzt seine Breite
  // im Verhaeltnis zur vorhergesagten Menge.
  const fresh = elapsed < 180;
  const width = (high - low) / Math.max(1, quantity);
  const confidence = accuracy.checks >= MIN_CHECKS && fresh
    && accuracy.coverage >= 0.5 && width <= 0.5
    ? 'brauchbar'
    : 'grob';

  return {
    quantity: Math.round(quantity),
    low,
    high,
    confidence,
    why: parts.join(', '),
    model: choice,
    estimate: e,
    accuracy,
    ...restockInfo(points, now),
  };
}

/** Guete des gewaehlten Modells, inklusive Treffer des angegebenen Bereichs. */
function accuracyOf(residuals, band, horizon) {
  if (!residuals.length) return { checks: 0, medianAbsError: null, worstAbsError: null, coverage: null };
  const errors = residuals.map((r) => Math.abs(r.residual));
  const covered = band
    ? residuals.filter((r) => r.residual >= band.lowOffset && r.residual <= band.highOffset).length
    : 0;
  return {
    checks: residuals.length,
    medianAbsError: median(errors),
    worstAbsError: Math.max(...errors),
    coverage: band ? covered / residuals.length : null,
    horizon,
  };
}

/**
 * Wahrscheinlichkeit, dass mindestens `units` Stueck dastehen.
 *
 * Aus derselben Fehlerverteilung wie der Bereich: jeder frueher gemessene
 * Fehler ist ein Szenario fuer den kommenden. Damit sagen Bereich und
 * Wahrscheinlichkeit dasselbe aus, statt zwei Rechnungen nebeneinander.
 */
export function chanceAtLeast(series, units, minutesAhead, now = Date.now()) {
  const points = [...series].sort((a, b) => a[0] - b[0]);
  if (points.length < 2) return null;

  const leer = points[points.length - 1][1] === 0;
  const vergangen = Math.max(0, (now - points[points.length - 1][0]) / MINUTE);
  const results = scoreModels(evaluateModels(points), {
    fromEmpty: leer,
    horizon: vergangen + Math.max(0, minutesAhead),
  });
  const choice = chooseModelFor(results, points, minutesAhead, now);
  const quantity = runModel(modelByKey(choice.key), points, minutesAhead, now);
  if (quantity === null) return null;

  const residuals = results.get(choice.key).residuals;
  if (residuals.length < 3) return null;

  const elapsed = Math.max(0, (now - points[points.length - 1][0]) / MINUTE);
  const horizon = elapsed + Math.max(0, minutesAhead);
  const near = residuals.filter((r) => r.horizon >= horizon / 3 && r.horizon <= horizon * 3);
  const used = near.length >= 3 ? near : residuals;
  const maxSeen = Math.max(...points.map((p) => p[1]));

  const hits = used.filter((r) => {
    const outcome = Math.max(0, Math.min(quantity + r.residual, maxSeen));
    return outcome >= units;
  }).length;
  return hits / used.length;
}

/** Guete der Reihe unter dem gewaehlten Modell - fuer die Anzeige. */
export function backtest(series = []) {
  const points = [...series].sort((a, b) => a[0] - b[0]);
  if (points.length < 3) return { checks: 0, medianAbsError: null, worstAbsError: null, coverage: null, model: null };

  const results = scoreModels(evaluateModels(points), { fromEmpty: points[points.length - 1][1] === 0 });
  const choice = chooseModel(results);
  const residuals = results.get(choice.key).residuals;
  const horizon = median(residuals.map((r) => r.horizon)) ?? 0;
  return { ...accuracyOf(residuals, conformalInterval(residuals, horizon), horizon), model: choice };
}

/**
 * Fuehrt zwei Messsammlungen zusammen.
 *
 * Der Sammler in GitHub Actions und der eigene Browser sehen dasselbe Regal,
 * aber nicht zur selben Zeit. Zusammengelegt wird nach Zeitstempel, doppelte
 * Punkte fallen weg - so bleibt eine Reihe entstehen, egal aus welcher
 * Richtung sie gefuellt wurde.
 */
export function mergeStock(local = {}, remote = {}, limit = MAX_SAMPLES) {
  const out = {};
  for (const key of new Set([...Object.keys(local), ...Object.keys(remote)])) {
    const seen = new Map();
    for (const [ts, quantity] of [...(remote[key] || []), ...(local[key] || [])]) {
      if (!Number.isFinite(ts) || !Number.isFinite(quantity)) continue;
      // Bei gleichem Zeitstempel gewinnt der lokale Wert: wer selbst im Shop
      // stand, hat genauer hingesehen als eine gesammelte Quelle.
      seen.set(ts, quantity);
    }
    const series = [...seen.entries()].sort((a, b) => a[0] - b[0]).slice(-limit);
    if (series.length) out[key] = series;
  }
  return out;
}

// ---------- Speicher ----------

export function loadStock() {
  try {
    const raw = JSON.parse(localStorage.getItem(STOCK_KEY) || '{}');
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  } catch {
    return {};
  }
}

export function saveStock(store) {
  try {
    localStorage.setItem(STOCK_KEY, JSON.stringify(store));
  } catch {
    // Voller Speicher darf die Planung nicht verhindern.
  }
  return store;
}

export function seriesFor(store, country, itemId) {
  return store[seriesKey(country, itemId)] || [];
}
