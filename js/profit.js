// Profit-Rechnung: Bazaar-Kauf gegen einen realen Ankaufspreis.

/** Netto-Erloes pro Stueck nach Sicherheitsabschlag und Gebuehr. */
export function netProceeds(reference, settings) {
  return reference * (settings.sellFactor / 100) * (1 - settings.marketFeePct / 100);
}

/**
 * Waehlt aus dem Katalog die Items aus, fuer die sich ein Detail-Request lohnt.
 * Jeder Kandidat kostet zwei weitere Requests, also wird hier hart gesiebt.
 */
export function prescreen(items, settings) {
  const threshold = settings.prescreenPct / 100;
  const maxBuy = Number(settings.maxBuyPrice) || 0;

  return items
    .filter((i) => (
      i.totalBazaars > 0
      && i.marketPrice > 0
      && i.lowestPrice > 0
      && i.lowestPrice <= i.marketPrice * threshold
      && (maxBuy === 0 || i.lowestPrice <= maxBuy)
    ))
    .map((i) => ({ ...i, gap: i.marketPrice - i.lowestPrice }))
    .sort((a, b) => b.gap - a.gap)
    .slice(0, Math.max(0, settings.maxCandidates));
}

/** Bester Kaeufer aus der Traderliste, oder null. */
export function pickBuyer(traders, settings) {
  const eligible = settings.requireNonNegativeRating
    ? traders.filter((t) => t.ratingScore >= 0)
    : traders;
  if (!eligible.length) return null;
  return eligible.reduce((best, t) => (t.price > best.price ? t : best), eligible[0]);
}

function finishRow(row, settings) {
  const { buy, reference, quantity } = row;
  const sellNet = netProceeds(reference, settings);
  const profitPerUnit = sellNet - buy;
  const profitPct = buy > 0 ? (profitPerUnit / buy) * 100 : 0;

  const budget = Number(settings.budget) || 0;
  const affordable = budget > 0 ? Math.floor(budget / buy) : Infinity;
  const units = Math.max(0, Math.min(quantity, affordable));

  return {
    ...row,
    sellNet,
    profitPerUnit,
    profitPct,
    units: Number.isFinite(units) ? units : quantity,
    totalProfit: profitPerUnit * (Number.isFinite(units) ? units : quantity),
  };
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

  return listings.map((l) => finishRow({
    itemId,
    itemName,
    buy: l.price,
    quantity: l.quantity,
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
  return true;
}

export function sortByTotalProfit(rows) {
  return [...rows].sort((a, b) => b.totalProfit - a.totalProfit || b.profitPerUnit - a.profitPerUnit);
}
