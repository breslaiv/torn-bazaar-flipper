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

export const STOCK_KEY = 'tbf.travelstock.v1';

/** Beobachtungen je Item. Mehr braucht keine Schaetzung, und der Platz ist knapp. */
export const MAX_SAMPLES = 40;

/** Naeher beieinander liegende Messungen sagen nichts Neues. */
export const MIN_GAP_MS = 60 * 1000;

/**
 * Nach dieser Zeit zaehlt eine Messung nur noch halb. Sechs Stunden decken
 * eine Tageshaelfte ab: genug, um aus mehreren Beobachtungen zu schoepfen,
 * kurz genug, dass der Abend nicht mit dem Vormittag verrechnet wird.
 */
export const HALF_LIFE_MINUTES = 360;

const MINUTE = 60 * 1000;

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Gewicht einer Beobachtung, gemessen gegen die juengste Messung derselben
 * Reihe - nicht gegen die Uhr.
 *
 * Der Unterschied ist entscheidend: liegt die letzte Messung einen Tag
 * zurueck, faellt bei einem Bezug auf "jetzt" jedes Gewicht auf null und die
 * Schaetzung waere leer statt alt. Innerhalb der Reihe ist die juengste
 * Messung immer die schwerste, und das ist genau die Aussage - "neuere
 * zaehlen mehr". Wie alt die Reihe insgesamt ist, sagt getrennt die Guete.
 */
export function weightAt(ts, reference) {
  const ageMinutes = Math.max(0, (reference - ts) / MINUTE);
  return 0.5 ** (ageMinutes / HALF_LIFE_MINUTES);
}

/**
 * Quantil einer gewichteten Stichprobe.
 * @param {Array<{value:number, weight:number}>} samples
 */
export function weightedQuantile(samples, q) {
  const rows = samples
    .filter((s) => Number.isFinite(s.value) && s.weight > 0)
    .sort((a, b) => a.value - b.value);
  if (!rows.length) return null;

  const total = rows.reduce((sum, r) => sum + r.weight, 0);
  let acc = 0;
  for (const row of rows) {
    acc += row.weight;
    if (acc >= q * total) return row.value;
  }
  return rows[rows.length - 1].value;
}

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

/** Menge nach `horizon` Minuten bei einem angenommenen Abverkaufstempo. */
function project(e, horizon, drain, minutesAhead, now) {
  let quantity = e.latest - drain * horizon;

  if (e.restockAmount && e.restockIntervalMinutes > 0 && e.lastRestockAt) {
    const since = (now - e.lastRestockAt) / MINUTE + Math.max(0, minutesAhead);
    quantity += Math.floor(since / e.restockIntervalMinutes) * e.restockAmount;
  }

  // Nach unten bei null, nach oben beim groessten je gesehenen Bestand: der
  // Shop haelt ein Maximum, auch wenn die Rechnung darueber hinauslaeuft.
  return Math.max(0, Math.min(quantity, e.maxSeen ?? quantity));
}

/**
 * Bereich statt Punktzahl: was bei langsamem, mittlerem und schnellem
 * Abverkauf herauskommt.
 */
export function predictRange(series, minutesAhead, now = Date.now()) {
  const e = estimate(series, now);
  if (e.samples < 2 || e.latest === null) return { quantity: null, low: null, high: null, estimate: e };

  // Von der letzten Messung aus rechnen, nicht von jetzt: zwischen beiden
  // liegt bei einer fremden Quelle oft schon eine Stunde.
  const elapsed = Math.max(0, (now - e.last) / MINUTE);
  const horizon = elapsed + Math.max(0, minutesAhead);
  const at = (drain) => project(e, horizon, drain ?? 0, minutesAhead, now);

  return {
    quantity: Math.round(at(e.drainPerMinute)),
    low: Math.round(at(e.drainFast)),
    high: Math.round(at(e.drainSlow)),
    horizon,
    estimate: e,
  };
}

/**
 * Wahrscheinlichkeit, dass mindestens `units` Stueck dastehen.
 *
 * Gerechnet wird ueber die beobachteten Tempi selbst, nicht ueber eine
 * angenommene Verteilung: jedes gemessene Tempo ist ein Szenario, gewichtet
 * nach seinem Alter. Mit wenigen Messungen kommen dabei grobe Werte heraus -
 * das ist ehrlicher als eine glatte Kurve ueber drei Punkte.
 */
export function chanceAtLeast(series, units, minutesAhead, now = Date.now()) {
  const e = estimate(series, now);
  if (e.samples < 2 || e.latest === null) return null;

  const elapsed = Math.max(0, (now - e.last) / MINUTE);
  const horizon = elapsed + Math.max(0, minutesAhead);

  // Ohne beobachteten Abverkauf gibt es nur ein Szenario: es bleibt, wie es ist.
  const scenarios = e.drainSamples.length ? e.drainSamples : [{ value: 0, weight: 1 }];
  const total = scenarios.reduce((sum, s) => sum + s.weight, 0);
  if (total <= 0) return null;

  const hits = scenarios.reduce((sum, s) => (
    project(e, horizon, s.value, minutesAhead, now) >= units ? sum + s.weight : sum
  ), 0);
  return hits / total;
}

/**
 * Prueft das Modell gegen die eigene Vergangenheit: aus dem Anfang der Reihe
 * vorhersagen, mit dem naechsten echten Wert vergleichen.
 *
 * Das ist der Unterschied zwischen einer Guete, die gemessen ist, und einer,
 * die ich mir ausgedacht habe. Es kostet keinen zusaetzlichen Speicher - die
 * Antworten stehen schon in der Reihe.
 */
export function backtest(series = []) {
  const points = [...series].sort((a, b) => a[0] - b[0]);
  const errors = [];
  let covered = 0;

  for (let i = 2; i < points.length; i++) {
    const known = points.slice(0, i);
    const asOf = known[known.length - 1][0];
    const ahead = (points[i][0] - asOf) / MINUTE;
    const p = predictRange(known, ahead, asOf);
    if (p.quantity === null) continue;

    const actual = points[i][1];
    errors.push(Math.abs(p.quantity - actual));
    if (actual >= Math.min(p.low, p.high) && actual <= Math.max(p.low, p.high)) covered += 1;
  }

  return {
    checks: errors.length,
    medianAbsError: median(errors),
    worstAbsError: errors.length ? Math.max(...errors) : null,
    // Anteil der Faelle, in denen der echte Wert im angegebenen Bereich lag.
    // Deutlich unter der Haelfte heisst: der Bereich ist zu schmal.
    coverage: errors.length ? covered / errors.length : null,
  };
}

/**
 * Vorhersage samt Bereich und Guete.
 *
 * @returns {{quantity:number|null, low:number, high:number,
 *            confidence:'unbekannt'|'grob'|'brauchbar', why:string}}
 */
export function predict(series, minutesAhead, now = Date.now()) {
  const range = predictRange(series, minutesAhead, now);
  const e = range.estimate;

  if (range.quantity === null) {
    return {
      quantity: null,
      low: null,
      high: null,
      confidence: 'unbekannt',
      why: 'zu wenige Beobachtungen — beim nächsten Blick wird es besser',
      estimate: e,
      accuracy: { checks: 0, medianAbsError: null, coverage: null },
    };
  }

  const accuracy = backtest(series);

  // Der gemessene Fehler weitet den Bereich, wenn er groesser ist als die
  // Streuung der Tempi hergibt. Ein Bereich, den die eigene Vergangenheit
  // schon widerlegt hat, waere eine Scheingenauigkeit.
  let { low, high } = range;
  if (Number.isFinite(accuracy.medianAbsError)) {
    low = Math.min(low, range.quantity - accuracy.medianAbsError);
    high = Math.max(high, range.quantity + accuracy.medianAbsError);
  }
  low = Math.max(0, Math.round(low));
  high = Math.max(low, Math.round(Math.min(high, e.maxSeen ?? high)));

  const parts = [];
  if (e.drainPerMinute) parts.push(`${e.drainPerMinute.toFixed(1)}/min Abverkauf`);
  if (e.restockAmount && e.restockIntervalMinutes) {
    parts.push(`Nachschub ~${Math.round(e.restockAmount)} alle ${Math.round(e.restockIntervalMinutes)} min`);
  }
  if (!parts.length) parts.push('keine Bewegung beobachtet');
  if (accuracy.checks) {
    parts.push(`${accuracy.checks} Selbstkontrollen, Median-Fehler ${Math.round(accuracy.medianAbsError)}`);
  }

  // Die Guete kommt aus der Selbstkontrolle, sobald es genug davon gibt.
  // Zwei Bedingungen, und beide muessen halten: der typische Fehler klein
  // gegen die vorhergesagte Menge, und der angegebene Bereich muss den echten
  // Wert wenigstens in der Haelfte der Faelle enthalten haben. Ein kleiner
  // Median-Fehler bei einem Bereich, der nie traf, ist keine Verlaesslichkeit
  // - genau dieser Fall stand im Test auf dem Schirm und hiess "brauchbar".
  // Vor der dritten Kontrolle gibt es keine Grundlage fuer "brauchbar" - und
  // da jede Messung ab der dritten eine Kontrolle liefert, heisst das
  // schlicht: wenige Messungen bleiben grob.
  const elapsed = (now - e.last) / MINUTE;
  const fresh = elapsed < 180;
  const relative = accuracy.checks ? accuracy.medianAbsError / Math.max(1, range.quantity) : Infinity;
  const confidence = accuracy.checks >= 3 && fresh && relative <= 0.25 && accuracy.coverage >= 0.5
    ? 'brauchbar'
    : 'grob';

  return { quantity: range.quantity, low, high, confidence, why: parts.join(', '), estimate: e, accuracy };
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
