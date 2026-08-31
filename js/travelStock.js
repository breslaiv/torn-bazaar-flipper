// Vorhersage der Auslandsvorraete.
//
// Ein Vorrat bewegt sich in zwei Richtungen: Spieler kaufen ihn leer, und in
// festen Abstaenden legt der Shop nach. Beides laesst sich nicht ausrechnen,
// nur beobachten - also merkt sich die App jede gesehene Menge und leitet aus
// der Reihe zwei Groessen ab:
//
//   Abverkauf   Stueck pro Minute, waehrend die Menge faellt.
//   Nachschub   Wieviel bei einem Sprung nach oben dazukommt, und in welchem
//               Abstand solche Spruenge passieren.
//
// Genommen wird jeweils der Median, nicht der Durchschnitt: ein einzelner
// Grosseinkauf zieht einen Mittelwert sonst so weit, dass die Vorhersage fuer
// alle folgenden Fluege unbrauchbar wird.
//
// Was die App nicht gesehen hat, sagt sie auch nicht vorher. Eine Zahl ohne
// Grundlage waere hier besonders teuer: man fliegt drei Stunden und steht vor
// einem leeren Regal.

export const STOCK_KEY = 'tbf.travelstock.v1';

/** Beobachtungen je Item. Mehr braucht keine Schaetzung, und der Platz ist knapp. */
export const MAX_SAMPLES = 40;

/** Naeher beieinander liegende Messungen sagen nichts Neues. */
export const MIN_GAP_MS = 60 * 1000;

const MINUTE = 60 * 1000;

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
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

    // Unveraenderte Menge kurz nacheinander bringt nichts; unveraenderte
    // Menge nach laengerer Zeit schon - sie zeigt, dass nichts passiert ist.
    if (last && ts - last[0] < MIN_GAP_MS) continue;
    if (last && last[1] === item.quantity && ts - last[0] < 5 * MIN_GAP_MS) continue;

    series.push([ts, item.quantity]);
    next[key] = series.slice(-MAX_SAMPLES);
  }
  return next;
}

/**
 * Schaetzt Abverkauf und Nachschub aus einer Messreihe.
 * @param {Array<[number, number]>} series
 */
export function estimate(series = []) {
  const points = [...series].sort((a, b) => a[0] - b[0]);
  const drains = [];
  const restockAmounts = [];
  const restockTimes = [];

  for (let i = 1; i < points.length; i++) {
    const [t0, q0] = points[i - 1];
    const [t1, q1] = points[i];
    const minutes = (t1 - t0) / MINUTE;
    if (minutes <= 0) continue;

    if (q1 < q0) {
      drains.push((q0 - q1) / minutes);
    } else if (q1 > q0) {
      restockAmounts.push(q1 - q0);
      restockTimes.push(t1);
    }
  }

  const gaps = [];
  for (let i = 1; i < restockTimes.length; i++) {
    gaps.push((restockTimes[i] - restockTimes[i - 1]) / MINUTE);
  }

  return {
    samples: points.length,
    first: points.length ? points[0][0] : null,
    last: points.length ? points[points.length - 1][0] : null,
    latest: points.length ? points[points.length - 1][1] : null,
    maxSeen: points.length ? Math.max(...points.map((p) => p[1])) : null,
    drainPerMinute: median(drains),
    restockAmount: median(restockAmounts),
    restockIntervalMinutes: median(gaps),
    lastRestockAt: restockTimes.length ? restockTimes[restockTimes.length - 1] : null,
    restocksSeen: restockTimes.length,
  };
}

/**
 * Wieviel duerfte in `minutesAhead` Minuten noch dastehen?
 *
 * @returns {{quantity: number|null, confidence: 'unbekannt'|'grob'|'brauchbar', why: string}}
 */
export function predict(series, minutesAhead, now = Date.now()) {
  const e = estimate(series);
  if (e.samples < 2 || e.latest === null) {
    return {
      quantity: null,
      confidence: 'unbekannt',
      why: 'zu wenige Beobachtungen — beim nächsten Blick wird es besser',
      estimate: e,
    };
  }

  // Von der letzten Messung aus rechnen, nicht von jetzt: zwischen beiden
  // liegt oft schon eine Stunde.
  const elapsed = Math.max(0, (now - e.last) / MINUTE);
  const horizon = elapsed + Math.max(0, minutesAhead);

  const drain = e.drainPerMinute ?? 0;
  let quantity = e.latest - drain * horizon;

  let restocks = 0;
  if (e.restockAmount && e.restockIntervalMinutes > 0 && e.lastRestockAt) {
    const sinceRestock = (now - e.lastRestockAt) / MINUTE + Math.max(0, minutesAhead);
    restocks = Math.floor(sinceRestock / e.restockIntervalMinutes);
    quantity += restocks * e.restockAmount;
  }

  // Nach unten bei null, nach oben beim groessten je gesehenen Bestand: der
  // Shop haelt ein Maximum, auch wenn die Rechnung darueber hinauslaeuft.
  quantity = Math.max(0, Math.min(quantity, e.maxSeen ?? quantity));

  const parts = [];
  if (drain > 0) parts.push(`${drain.toFixed(1)}/min Abverkauf`);
  if (restocks > 0) parts.push(`${restocks}× Nachschub à ${e.restockAmount}`);
  if (!parts.length) parts.push('keine Bewegung beobachtet');

  // Brauchbar wird es erst, wenn beide Richtungen belegt sind und die Daten
  // nicht von gestern stammen.
  const fresh = elapsed < 180;
  const confidence = e.samples >= 5 && e.restocksSeen >= 1 && fresh ? 'brauchbar' : 'grob';

  return { quantity: Math.round(quantity), confidence, why: parts.join(', '), estimate: e };
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
