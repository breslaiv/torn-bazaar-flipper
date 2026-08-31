// Kleine statistische Helfer, von Modellen und Auswertung gemeinsam genutzt.
//
// Eigenes Modul, damit travelStock.js und travelModels.js sich nicht
// gegenseitig importieren muessen: ein Zirkelbezug laeuft zwar meistens, ist
// aber eine Falle fuer den naechsten, der eine Zeile verschiebt.

const MINUTE = 60 * 1000;

/**
 * Nach dieser Zeit zaehlt eine Messung nur noch halb. Sechs Stunden decken
 * eine Tageshaelfte ab: genug, um aus mehreren Beobachtungen zu schoepfen,
 * kurz genug, dass der Abend nicht mit dem Vormittag verrechnet wird.
 */
export const HALF_LIFE_MINUTES = 360;

export function median(values) {
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
