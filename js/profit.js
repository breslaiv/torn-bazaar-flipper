// Profit-Rechnung: Bazaar-Kauf gegen einen realen Ankaufspreis.

import { ageHours, tooOld } from './freshness.js?v=11';

/** Netto-Erloes pro Stueck nach Sicherheitsabschlag und Gebuehr. */
export function netProceeds(reference, settings) {
  return reference * (settings.sellFactor / 100) * (1 - settings.marketFeePct / 100);
}

/**
 * Waehlt aus dem Katalog die Items aus, fuer die sich ein Detail-Request lohnt.
 * Jeder Kandidat kostet zwei weitere Requests, also wird hier hart gesiebt.
 *
 * Gemessen wird an derselben Rechnung wie spaeter die Zeile, nur mit dem
 * Marktpreis als Platzhalter fuer den Ankaufspreis: erwarteter Profit je
 * Stueck und erwartete Marge. Wer diese Schwellen schon gegen den Marktpreis
 * reisst, kann sie gegen einen realen Kaeufer erst recht nicht halten -
 * Kaeufer zahlen unter Markt, nicht darueber. Der Platzhalter schaetzt also
 * zu guenstig, und das ist die richtige Richtung: lieber ein Kandidat zu
 * viel als ein echter Flip, der nie geprueft wird.
 *
 * Sortiert wird nach diesem erwarteten Profit statt nach der nackten
 * Preisspanne. Nach Spanne gewinnen sonst teure Items mit ein paar Prozent
 * Rabatt, und billige Items mit 40% Marge fallen aus den Kandidaten heraus,
 * obwohl genau sie die Filter bestehen wuerden.
 */
export function prescreen(items, settings) {
  const threshold = settings.prescreenPct / 100;
  const maxBuy = Number(settings.maxBuyPrice) || 0;
  const minAbs = Number(settings.minProfitAbs) || 0;
  const minPct = Number(settings.minProfitPct) || 0;

  return items
    .filter((i) => (
      i.totalBazaars > 0
      && i.marketPrice > 0
      && i.lowestPrice > 0
      && i.lowestPrice <= i.marketPrice * threshold
      && (maxBuy === 0 || i.lowestPrice <= maxBuy)
    ))
    .map((i) => {
      const expectedProfit = netProceeds(i.marketPrice, settings) - i.lowestPrice;
      return {
        ...i,
        gap: i.marketPrice - i.lowestPrice,
        expectedProfit,
        expectedPct: (expectedProfit / i.lowestPrice) * 100,
      };
    })
    .filter((i) => i.expectedProfit >= minAbs && i.expectedPct >= minPct)
    .sort((a, b) => b.expectedProfit - a.expectedProfit)
    .slice(0, Math.max(0, settings.maxCandidates));
}

/** Mindestbewertung als Zahl, robust gegen ein leeres oder unsinniges Feld. */
export function minRating(settings) {
  const n = Number(settings.minBuyerRating);
  return Number.isFinite(n) ? n : 0;
}

/** Bester Kaeufer aus der Traderliste, oder null. */
export function pickBuyer(traders, settings) {
  const min = minRating(settings);
  const eligible = traders.filter((t) => t.ratingScore >= min);
  if (!eligible.length) return null;
  return eligible.reduce((best, t) => (t.price > best.price ? t : best), eligible[0]);
}

function finishRow(row, settings) {
  const { buy, reference, quantity } = row;
  const sellNet = netProceeds(reference, settings);
  const profitPerUnit = sellNet - buy;
  const profitPct = buy > 0 ? (profitPerUnit / buy) * 100 : 0;

  // Was eine einzelne Zeile hergibt, wenn nur sie gekauft wird. Ueber alle
  // Zeilen hinweg teilt allocateBudget() das Budget danach noch einmal auf.
  const budget = Number(settings.budget) || 0;
  const affordable = budget > 0 ? Math.floor(budget / buy) : Infinity;
  const units = Math.max(0, Math.min(quantity, Number.isFinite(affordable) ? affordable : quantity));

  return {
    ...row,
    sellNet,
    profitPerUnit,
    profitPct,
    units,
    // Der Einsatz gehoert neben den Profit: eine Zeile mit 400k Gewinn ist
    // wertlos, wenn dafuer 12 Mio. auf dem Tisch liegen muessen.
    spend: units * buy,
    totalProfit: profitPerUnit * units,
  };
}

/**
 * Verteilt das Budget ueber alle Treffer statt jeder Zeile dasselbe Geld
 * zuzugestehen.
 *
 * Vorher rechnete jede Zeile fuer sich mit dem vollen Budget, und die Summe
 * oben addierte lauter Gewinne, die dasselbe Geld doppelt ausgaben - eine
 * Zahl, die nie erreichbar war. Zugeteilt wird nach Profit je eingesetztem
 * Dollar: bei knappem Geld zaehlt die Rendite des Einsatzes, nicht der
 * absolute Gewinn einer teuren Zeile.
 */
export function allocateBudget(rows, budget) {
  const total = Number(budget) || 0;
  if (total <= 0) return rows;

  const order = [...rows].sort((a, b) => (
    (b.profitPerUnit / b.buy) - (a.profitPerUnit / a.buy) || b.profitPerUnit - a.profitPerUnit
  ));

  let left = total;
  const allocation = new Map();
  for (const row of order) {
    const affordable = row.buy > 0 ? Math.floor(left / row.buy) : 0;
    const units = Math.max(0, Math.min(row.quantity, affordable));
    allocation.set(row, units);
    left -= units * row.buy;
  }

  return rows.map((row) => {
    const units = allocation.get(row) ?? 0;
    return {
      ...row,
      units,
      spend: units * row.buy,
      totalProfit: row.profitPerUnit * units,
      // Sonst sieht eine Zeile mit Menge 0 nach einem Rechenfehler aus.
      overBudget: units === 0,
    };
  });
}

/**
 * Baut die Zeilen fuer ein Item: jedes Bazaar-Listing gegen den besten Kaeufer.
 * Ohne Kaeufer gibt es im Trader-Modus keinen Exit - dann entstehen keine Zeilen.
 */
export function buildFlipRows({ itemId, itemName, marketPrice, listings, traders }, settings) {
  const buyer = pickBuyer(traders, settings);
  if (settings.referenceMode === 'trader' && !buyer) return [];

  const useTrader = settings.referenceMode === 'trader';
  const reference = useTrader ? buyer.price : marketPrice;
  if (!(reference > 0)) return [];

  const now = Date.now();
  return listings.map((l) => finishRow({
    itemId,
    itemName,
    buy: l.price,
    quantity: l.quantity,
    // Wann weav3r das Listing zuletzt gesehen hat, und wann der Kaeufer
    // zuletzt aktiv war - beides entscheidet, ob der Weg sich lohnt.
    listingAgeHours: ageHours(l.contentUpdated, now),
    buyerIdleHours: buyer ? ageHours(buyer.lastAction, now) : null,
    sellerId: l.playerId,
    sellerName: l.playerName,
    sponsored: l.sponsored,
    marketPrice,
    reference,
    referenceLabel: useTrader ? 'Käufer' : 'Marktpreis',
    buyerId: buyer ? buyer.playerId : null,
    buyerName: buyer ? buyer.playerName : null,
    buyerRating: buyer ? buyer.ratingScore : null,
    // Ein Bazaar-Preis unter 15% des Marktwerts ist fast immer ein Artefakt:
    // veraltetes Listing oder ein Item, dessen Marktpreis nicht stimmt.
    suspicious: marketPrice > 0 && l.price / marketPrice < 0.15,
  }, settings));
}

/** $1-Listings: Kaufpreis ist per Definition 1, Referenz ist der Marktpreis. */
export function buildDollarRows(items, settings) {
  return items
    .filter((i) => i.marketPrice > 0)
    .map((i) => finishRow({
      itemId: i.itemId,
      itemName: i.itemName,
      buy: 1,
      quantity: i.quantity,
      listingAgeHours: ageHours(i.lastUpdated),
      buyerIdleHours: null,
      sellerId: i.playerId,
      sellerName: i.playerName,
      sponsored: false,
      marketPrice: i.marketPrice,
      reference: i.marketPrice,
      referenceLabel: 'Marktpreis',
      buyerId: null,
      buyerName: null,
      buyerRating: null,
      suspicious: false,
    }, settings));
}

export function passesFilters(row, settings) {
  if (row.profitPerUnit < Number(settings.minProfitAbs)) return false;
  if (row.profitPct < Number(settings.minProfitPct)) return false;
  const maxBuy = Number(settings.maxBuyPrice) || 0;
  if (maxBuy > 0 && row.buy > maxBuy) return false;
  if (tooOld(row.listingAgeHours, settings.maxListingAgeHours)) return false;
  return true;
}

export function sortByTotalProfit(rows) {
  return [...rows].sort((a, b) => b.totalProfit - a.totalProfit || b.profitPerUnit - a.profitPerUnit);
}
