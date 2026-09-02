// Die konkurrierenden Vorhersagemodelle.
//
// Statt eines fest verdrahteten Modells treten mehrere gegeneinander an, und
// je Messreihe gewinnt das, welches auf deren eigener Vergangenheit am besten
// lag. Das ist die ehrliche Form von "lernt dazu": die App misst, welche
// Erklaerung zu diesem Regal passt, statt dass sie geraten wird.
//
// Bewusst wenige und einfache Kandidaten. Wer auf zehn Pruefpunkten unter
// fuenfzig Modellen waehlt, waehlt Rauschen - deshalb vier Stueck, eine
// Mindestzahl an Kontrollen vor jedem Wechsel, und bei Gleichstand gewinnt
// das einfachere.

import { weightAt, weightedQuantile, median } from './stats.js?v=21';
import { findCycles, estimateTimer, estimateCapacity, simulate } from './restock.js?v=21';

const MINUTE = 60 * 1000;

function intervals(points) {
  const out = [];
  for (let i = 1; i < points.length; i++) {
    const [t0, q0] = points[i - 1];
    const [t1, q1] = points[i];
    const minutes = (t1 - t0) / MINUTE;
    if (minutes > 0) out.push({ at: t1, minutes, change: q1 - q0 });
  }
  return out;
}

const reference = (points) => points[points.length - 1][0];

/** Gewichteter Median einer Groesse ueber die Abschnitte einer Reihe. */
function weightedRate(spans, points, pick) {
  const samples = spans
    .map((s) => ({ value: pick(s), weight: weightAt(s.at, reference(points)) }))
    .filter((s) => s.value !== null && s.value !== undefined);
  return weightedQuantile(samples, 0.5);
}

/** Gewichtetes Abverkaufstempo aus den fallenden Abschnitten. */
export function drainRate(points) {
  const spans = intervals(points).filter((s) => s.change < 0);
  return weightedRate(spans, points, (s) => -s.change / s.minutes) ?? 0;
}

/**
 * Jedes Modell bekommt die bekannten Punkte und sagt eine Menge voraus.
 * `null` heisst: dieses Modell hat fuer diese Reihe keine Grundlage.
 *
 * complexity entscheidet den Gleichstand - je kleiner, desto lieber.
 */
export const MODELS = [
  {
    key: 'flat',
    label: 'bleibt wie es ist',
    complexity: 0,
    predict: (points) => points[points.length - 1][1],
  },
  {
    key: 'drift',
    label: 'Netto-Trend',
    complexity: 1,
    // Nimmt die Reihe, wie sie ist: Zu- und Abgaenge in einer Zahl. Wo
    // Nachschub und Abverkauf sich nicht trennen lassen - und bei
    // stundenlangen Messabstaenden lassen sie sich das oft nicht -, ist das
    // ehrlicher als zwei Groessen, die beide daneben liegen.
    predict: (points, horizon) => {
      const spans = intervals(points);
      if (!spans.length) return null;
      const rate = weightedRate(spans, points, (s) => s.change / s.minutes);
      if (rate === null) return null;
      return points[points.length - 1][1] + rate * horizon;
    },
  },
  {
    key: 'cycle',
    label: 'Ausverkauf + Timer',
    complexity: 2,
    // Der Mechanismus des Spiels: erreicht ein Item 0, laeuft ein Timer los,
    // und danach ist das Regal wieder voll. Der Zyklus haengt am Ausverkauf,
    // nicht an der Uhr - deshalb wird hier nicht gerechnet, sondern
    // vorwaerts simuliert.
    predict: (points, horizon, now) => {
      const cycles = findCycles(points);
      const timer = estimateTimer(cycles);
      if (!timer) return null;

      const drain = drainRate(points);
      const capacity = estimateCapacity(points, cycles);
      const [lastAt, lastQuantity] = points[points.length - 1];

      // Wann zuletzt ausverkauft war, bestimmt den laufenden Timer.
      const laufend = cycles[cycles.length - 1];
      const lastSelloutAt = laufend && lastQuantity === 0 ? laufend.selloutTo : null;

      return simulate({
        quantity: lastQuantity,
        from: lastAt,
        drainPerMinute: drain,
        timerMinutes: timer.minutes,
        capacity,
        lastSelloutAt,
      }, lastAt + horizon * MINUTE).quantity;
    },
  },
  {
    key: 'daily',
    label: 'Tempo nach Tageszeit',
    complexity: 3,
    // Abends leert sich ein Regal schneller als nachts. Dieses Modell nimmt
    // nur Abschnitte aus derselben Tageszeit wie der Zielzeitpunkt - und
    // meldet sich ab, wenn davon zu wenige da sind.
    predict: (points, horizon, now, minutesAhead) => {
      const target = new Date(now + minutesAhead * MINUTE).getHours();
      const nearby = intervals(points).filter((s) => {
        const hour = new Date(s.at).getHours();
        const distance = Math.min(Math.abs(hour - target), 24 - Math.abs(hour - target));
        return distance <= 2;
      });
      if (nearby.length < 2) return null;
      const rate = weightedRate(nearby, points, (s) => s.change / s.minutes);
      if (rate === null) return null;
      return points[points.length - 1][1] + rate * horizon;
    },
  },
];

export function modelByKey(key) {
  return MODELS.find((m) => m.key === key) || null;
}

/** Haelt eine Vorhersage im Moeglichen: nie negativ, nie ueber dem Maximum. */
export function clampQuantity(value, points) {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  const maxSeen = Math.max(...points.map((p) => p[1]));
  return Math.max(0, Math.min(value, maxSeen));
}

/**
 * Vorhersage eines Modells fuer eine Reihe.
 * @param {number} minutesAhead  Zeit ab jetzt
 */
export function runModel(model, points, minutesAhead, now) {
  if (!model || points.length < 2) return null;
  // Von der letzten Messung aus rechnen, nicht von jetzt: zwischen beiden
  // liegt bei einer fremden Quelle oft schon eine Stunde.
  const elapsed = Math.max(0, (now - reference(points)) / MINUTE);
  const horizon = elapsed + Math.max(0, minutesAhead);
  const raw = model.predict(points, horizon, now, minutesAhead);
  return clampQuantity(raw, points);
}
