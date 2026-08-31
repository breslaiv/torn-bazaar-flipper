// Profit-Rechnung: Bazaar-Kauf gegen Verkaufsreferenz.

/**
 * @param {object} listing  normalisiertes Bazaar-Listing
 * @param {object} item     Torn-Item-Stammdaten (kann fehlen)
 * @param {object} settings
 * @param {number|null} verifiedLow  live geprueftes Itemmarket-Tief, falls vorhanden
 */
export function evaluate(listing, item, settings, verifiedLow = null) {
  const marketValue = item?.marketValue ?? 0;

  let reference = marketValue;
  let referenceSource = 'market_value';
  if (settings.priceSource === 'itemmarket' && verifiedLow) {
    reference = verifiedLow;
    referenceSource = 'itemmarket';
  } else if (verifiedLow) {
    // Auch im market_value-Modus gewinnt ein live geprueftes Tief, sobald es
    // vorliegt: es ist der Preis, zu dem real jemand kauft.
    reference = verifiedLow;
    referenceSource = 'itemmarket (verifiziert)';
  }

  const buy = listing.price;
  const gross = reference * (settings.sellFactor / 100);
  const net = gross * (1 - settings.marketFeePct / 100);
  const profitPerUnit = net - buy;
  const profitPct = buy > 0 ? (profitPerUnit / buy) * 100 : 0;

  const budget = Number(settings.budget) || 0;
  const affordable = budget > 0 ? Math.floor(budget / buy) : Infinity;
  const units = Math.max(0, Math.min(listing.quantity, affordable));
  const totalProfit = profitPerUnit * units;

  // Ein Bazaar-Preis unter 15% des Marktwerts ist fast immer ein Artefakt:
  // veraltetes Listing, falsch geparstes Feld oder ein Item, dessen
  // market_value nicht stimmt. Nicht wegfiltern, aber markieren.
  const suspicious = reference > 0 && buy / reference < 0.15;

  return {
    ...listing,
    itemName: item?.name || listing.itemName || `Item ${listing.itemId}`,
    itemType: item?.type || '',
    marketValue,
    reference,
    referenceSource,
    verified: verifiedLow !== null,
    buy,
    sellNet: net,
    profitPerUnit,
    profitPct,
    units: Number.isFinite(units) ? units : listing.quantity,
    totalProfit: Number.isFinite(totalProfit) ? totalProfit : profitPerUnit * listing.quantity,
    suspicious,
  };
}

export function passesFilters(row, settings) {
  if (row.profitPerUnit < Number(settings.minProfitAbs)) return false;
  if (row.profitPct < Number(settings.minProfitPct)) return false;
  const maxBuy = Number(settings.maxBuyPrice) || 0;
  if (maxBuy > 0 && row.buy > maxBuy) return false;
  return true;
}

export function buildRows(listings, itemsById, settings, verifiedLows = new Map()) {
  const rows = [];
  for (const listing of listings) {
    const item = itemsById.get(listing.itemId);
    const row = evaluate(listing, item, settings, verifiedLows.get(listing.itemId) ?? null);
    if (passesFilters(row, settings)) rows.push(row);
  }
  rows.sort((a, b) => b.totalProfit - a.totalProfit || b.profitPerUnit - a.profitPerUnit);
  return rows;
}

/** Item-IDs der besten N Treffer - nur die werden live gegengeprueft. */
export function topItemIdsForVerification(rows, n) {
  const ids = [];
  const seen = new Set();
  for (const row of rows) {
    if (seen.has(row.itemId)) continue;
    seen.add(row.itemId);
    ids.push(row.itemId);
    if (ids.length >= n) break;
  }
  return ids;
}
