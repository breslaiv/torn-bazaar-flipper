// Der Normalbereich eines Items.
//
// "20% unter Marktpreis" heisst beim einen Item Schnaeppchen und beim anderen
// Normalzustand. Der Marktpreis ist ausserdem selbst ein nachlaufender Wert -
// er entsteht aus vergangenen Verkaeufen. Der ehrlichere Massstab ist, was
// dieses Item in den letzten Tagen tatsaechlich gekostet hat.
//
// Die Kennzahlen kommen aus data/price-stats.json, das ein Workflow stuendlich
// neu rechnet. Fehlt die Datei oder ist ein Item nicht darin, faellt alles auf
// den bisherigen Vergleich zurueck - der Scanner funktioniert ohne sie
// weiter, nur ungenauer.

export const STATS_URL = 'data/price-stats.json';

/** Kennzahlen je Item, oder eine leere Karte. */
export function statsMap(data) {
  const raw = data?.stats && typeof data.stats === 'object' ? data.stats : {};
  const map = new Map();
  for (const [id, s] of Object.entries(raw)) {
    const itemId = Number(id);
    if (!Number.isFinite(itemId) || !Number.isFinite(s?.lowMedian) || s.lowMedian <= 0) continue;
    map.set(itemId, {
      n: Number(s.n) || 0,
      lowMedian: s.lowMedian,
      lowP10: Number.isFinite(s.lowP10) ? s.lowP10 : s.lowMedian,
      lowMin: Number.isFinite(s.lowMin) ? s.lowMin : s.lowMedian,
      marketMedian: Number.isFinite(s.marketMedian) ? s.marketMedian : null,
    });
  }
  return map;
}

/**
 * Wie steht ein Preis zum Normalbereich seines Items?
 *
 * @returns {{ratio:number, discount:number, unusual:boolean, n:number}|null}
 *   ratio    Preis geteilt durch den ueblichen Tiefstpreis
 *   discount Abschlag in Prozent, positiv wenn billiger als ueblich
 *   unusual  unter dem unteren Zehntel - billig auch fuer dieses Item
 */
export function compareToNormal(price, stat) {
  if (!stat || !(price > 0)) return null;
  const ratio = price / stat.lowMedian;
  return {
    ratio,
    discount: (1 - ratio) * 100,
    unusual: price <= stat.lowP10,
    lowMedian: stat.lowMedian,
    n: stat.n,
  };
}

/**
 * Haengt den Vergleich an jede Zeile.
 *
 * Bewusst kein Filter: ob eine Zeile trotzdem interessant ist, entscheidet
 * der Nutzer. Sichtbar machen genuegt.
 */
export function withNormal(rows, stats) {
  return rows.map((row) => {
    const normal = compareToNormal(row.buy, stats.get(row.itemId));
    return normal ? { ...row, normal } : row;
  });
}
