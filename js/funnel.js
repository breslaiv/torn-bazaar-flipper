// Wo die Items geblieben sind.
//
// Eine leere Trefferliste ist keine Auskunft. Sie kann heissen: der Markt gibt
// nichts her, der Rabatt-Regler steht zu streng, das Kandidatenlimit schneidet
// zu frueh ab, oder der Mindestprofit ist zu hoch. Das sind vier verschiedene
// Handlungen, und ohne die Zwischenstaende sehen sie alle gleich aus.
//
// Reine Rechnung ohne DOM: die Stufen sind dieselbe Reihenfolge, in der
// scan.js tatsaechlich siebt, nur zaehlbar gemacht.

/**
 * @param {object} stats   aus runFlipScan/runDollarScan
 * @param {Array}  rows    die fertigen Zeilen, nach Budgetverteilung
 * @param {object} settings
 * @returns {Array<{key,label,kept,lost,why,control}>}
 *   kept    - was diese Stufe uebrig laesst
 *   lost    - was sie wegnimmt
 *   why     - warum, im Klartext
 *   control - welcher Regler das steuert, oder null, wenn es keiner ist
 *   section - 'items' zaehlt Items, 'offers' zaehlt einzelne Listings. Die
 *             Zahl steigt beim Uebergang, weil ein Item mehrere Angebote hat -
 *             ohne die Trennung sieht ein Trichter aus, der nach oben geht.
 */
export function funnelStages(stats, rows = [], settings = {}) {
  const dollar = settings.scanMode === 'dollar';
  const s = withDefaults(stats);
  const stages = [];

  let section = 'items';
  const push = (key, label, kept, prev, why, control = null) => {
    stages.push({ key, label, kept, lost: Math.max(0, prev - kept), why, control, section });
  };

  if (dollar) {
    stages.push({
      key: 'catalog', label: '$1-Listings', kept: s.catalogSize, lost: 0, why: '', control: null, section,
    });
  } else {
    stages.push({
      key: 'catalog', label: 'Katalog', kept: s.catalogSize, lost: 0, why: '', control: null, section,
    });
    push('listed', 'Mit Bazaar und Preis', s.listed, s.catalogSize,
      'kein Bazaar-Listing oder kein Marktpreis hinterlegt');
    push('discounted', 'Unter Rabattschwelle', s.discounted, s.listed,
      `teurer als ${num(settings.prescreenPct)} % vom Marktpreis`, 'Kandidat ab Rabatt');

    // Nur zeigen, wenn die Preisgrenze ueberhaupt gesetzt ist - sonst steht da
    // eine Stufe, die nie etwas tut.
    if (Number(settings.maxBuyPrice) > 0) {
      push('affordable', 'Unter Preisgrenze', s.affordable, s.discounted,
        `teurer als ${money(settings.maxBuyPrice)}`, 'Max. Kaufpreis');
    }

    push('profitable', 'Erwarteter Profit reicht', s.profitable, s.affordable,
      `unter ${money(settings.minProfitAbs)} oder ${num(settings.minProfitPct)} % erwartet`,
      'Min. Profit / Min. Marge');
    push('candidates', 'Kandidaten geprüft', s.candidates, s.profitable,
      `Limit von ${num(settings.maxCandidates)} Kandidaten`, 'Max. Kandidaten');

    // Abgebrochene Abfragen duerfen nicht stillschweigend als geprueft
    // durchgehen: sonst sieht ein Rate-Limit oder ein Netzaussetzer aus wie
    // ein Markt, der einfach nichts hergibt.
    if (s.failed > 0) {
      push('checked', 'Abfrage geglückt', s.checked, s.candidates,
        `${s.failed} Abfragen fehlgeschlagen — Netz oder Rate-Limit, nicht der Markt`);
    }

    // Zwei getrennte Gruende, von denen nur der zweite einstellbar ist.
    const buyerLost = s.withoutBuyer + s.buyerBelowRating;
    const buyerWhy = [
      s.withoutBuyer ? `${s.withoutBuyer} ohne aktiven Abnehmer` : '',
      s.buyerBelowRating ? `${s.buyerBelowRating} nur unter Bewertung ${num(settings.minBuyerRating)}` : '',
    ].filter(Boolean).join(', ');
    push('buyer', 'Mit Käufer', Math.max(0, s.checked - buyerLost), s.checked,
      buyerWhy || 'ohne aktiven Abnehmer',
      s.buyerBelowRating ? 'Mindestbewertung Käufer' : null);
  }

  section = 'offers';
  stages.push({
    key: 'rows', label: 'Angebote gefunden', kept: s.rowsBuilt, lost: 0, why: '', control: null, section,
  });

  push('profit', 'Über den Profitfiltern', s.rowsBuilt - s.belowProfit, s.rowsBuilt,
    `unter ${money(settings.minProfitAbs)} pro Stück oder ${num(settings.minProfitPct)} % Marge`,
    'Min. Profit / Min. Marge');
  push('limits', 'Über Alter und Preisgrenze', s.rowsBuilt - s.belowProfit - s.filteredOut,
    s.rowsBuilt - s.belowProfit,
    'zu altes Listing oder über der Preisgrenze', 'Listing-Alter / Max. Kaufpreis');

  // Budget kommt aus den Zeilen selbst, nicht aus stats: allocateBudget()
  // verteilt erst, wenn alle Zeilen feststehen.
  const affordableRows = rows.filter((r) => r.units > 0).length;
  if (Number(settings.budget) > 0) {
    push('budget', 'Im Budget', affordableRows, rows.length,
      `Budget von ${money(settings.budget)} aufgebraucht`, 'Budget');
  }

  return stages;
}

/**
 * Die Stufe, an der am meisten verlorengeht - und die man deshalb zuerst
 * anfassen sollte. Nur Stufen mit einem Regler kommen infrage: dass der Markt
 * keine Bazaare hergibt, ist kein Regler.
 */
export function biggestDrop(stages) {
  const adjustable = stages.filter((s) => s.control && s.lost > 0);
  if (!adjustable.length) return null;
  return adjustable.reduce((worst, s) => (s.lost > worst.lost ? s : worst));
}

function withDefaults(stats = {}) {
  const n = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  return {
    catalogSize: n(stats.catalogSize),
    listed: n(stats.listed ?? stats.catalogSize),
    discounted: n(stats.discounted ?? stats.candidates),
    affordable: n(stats.affordable ?? stats.candidates),
    profitable: n(stats.profitable ?? stats.candidates),
    candidates: n(stats.candidates),
    checked: n(stats.checked ?? stats.candidates),
    failed: n(stats.failed),
    withoutBuyer: n(stats.withoutBuyer),
    buyerBelowRating: n(stats.buyerBelowRating),
    rowsBuilt: n(stats.rowsBuilt),
    belowProfit: n(stats.belowProfit),
    filteredOut: n(stats.filteredOut),
  };
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n.toLocaleString('de-DE') : '?';
}

function money(v) {
  const n = Number(v);
  return Number.isFinite(n) ? `$${n.toLocaleString('de-DE')}` : '?';
}
