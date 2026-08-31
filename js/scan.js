// Ablauf eines Scans. Getrennt vom UI, damit er testbar bleibt.

import { fetchMarketplace, fetchItemListings, fetchItemTraders, fetchDollarItems } from './weav3r.js?v=1';
import { fetchItemMarketLow } from './torn.js?v=1';
import { prescreen, pickBuyer, buildFlipRows, buildDollarRows, passesFilters, sortByTotalProfit } from './profit.js?v=1';

const noop = () => {};

/**
 * Bazaar -> privater Kaeufer.
 *
 * Kostet 1 Request fuer den Katalog plus 2 pro Kandidat. Deshalb siebt
 * prescreen() vorher auf die Items, bei denen ueberhaupt eine Spanne
 * zwischen billigstem Listing und Marktpreis besteht.
 */
export async function runFlipScan(settings, { onProgress = noop, signal, deps = {} } = {}) {
  const api = {
    fetchMarketplace, fetchItemListings, fetchItemTraders, ...deps,
  };

  onProgress({ phase: 'catalog', text: 'Lade Marktkatalog von weav3r…' });
  const { items, generatedAt } = await api.fetchMarketplace(settings, { signal });

  const candidates = prescreen(items, settings);
  const stats = {
    catalogSize: items.length,
    candidates: candidates.length,
    withoutBuyer: 0,
    buyerBelowRating: 0,
    generatedAt,
  };

  if (!candidates.length) {
    return { rows: [], stats };
  }

  const rows = [];
  for (let i = 0; i < candidates.length; i++) {
    if (signal?.aborted) break;
    const candidate = candidates[i];

    onProgress({
      phase: 'detail',
      done: i,
      total: candidates.length,
      text: `Prüfe ${candidate.itemName} (${i + 1}/${candidates.length})…`,
    });

    let listingsRes;
    let tradersRes;
    try {
      [listingsRes, tradersRes] = await Promise.all([
        api.fetchItemListings(candidate.itemId, settings, { signal }),
        api.fetchItemTraders(candidate.itemId, settings, { signal }),
      ]);
    } catch (err) {
      if (err.name === 'AbortError') break;
      // Ein einzelnes Item darf den Scan nicht abbrechen.
      console.warn(`Item ${candidate.itemId} übersprungen:`, err.message);
      continue;
    }

    // Getrennt zaehlen: "gibt keinen Kaeufer" und "alle unter der
    // Mindestbewertung" sind verschiedene Gruende, und nur der zweite laesst
    // sich ueber die Einstellungen aendern.
    if (!tradersRes.traders.length) stats.withoutBuyer += 1;
    else if (!pickBuyer(tradersRes.traders, settings)) stats.buyerBelowRating += 1;

    const itemRows = buildFlipRows({
      itemId: candidate.itemId,
      itemName: listingsRes.itemName || candidate.itemName,
      marketPrice: listingsRes.marketPrice || candidate.marketPrice,
      listings: listingsRes.listings,
      traders: tradersRes.traders,
    }, settings);

    for (const row of itemRows) {
      if (passesFilters(row, settings)) rows.push(row);
    }
  }

  return { rows: sortByTotalProfit(rows), stats };
}

/** $1-Bazaare: alles, was fuer einen Dollar zu haben ist. */
export async function runDollarScan(settings, { onProgress = noop, signal, deps = {} } = {}) {
  const api = { fetchDollarItems, ...deps };
  const pages = Math.max(1, Math.ceil(settings.maxCandidates / 100));
  const collected = [];

  for (let page = 1; page <= pages; page++) {
    if (signal?.aborted) break;
    onProgress({ phase: 'dollar', text: `Lade $1-Bazaare, Seite ${page}/${pages}…` });
    const items = await api.fetchDollarItems(settings, { page, limit: 100, signal });
    collected.push(...items);
    if (items.length < 100) break;
  }

  const rows = buildDollarRows(collected, settings).filter((r) => passesFilters(r, settings));
  return {
    rows: sortByTotalProfit(rows),
    stats: { catalogSize: collected.length, candidates: collected.length, withoutBuyer: 0, buyerBelowRating: 0 },
  };
}

/**
 * Optionale Gegenprobe: echter Item-Market-Tiefstpreis fuer die besten Treffer.
 * Setzt einen Torn-Key voraus und rechnet die betroffenen Zeilen neu.
 */
export async function verifyWithTorn(rows, settings, { onProgress = noop, signal, deps = {} } = {}) {
  const api = { fetchItemMarketLow, ...deps };
  if (!settings.tornKey) return rows;

  const ids = [];
  const seen = new Set();
  for (const row of rows) {
    if (seen.has(row.itemId)) continue;
    seen.add(row.itemId);
    ids.push(row.itemId);
    if (ids.length >= 15) break;
  }

  const lows = new Map();
  for (let i = 0; i < ids.length; i++) {
    if (signal?.aborted) break;
    onProgress({ phase: 'verify', text: `Item-Market-Gegenprobe ${i + 1}/${ids.length}…` });
    try {
      const low = await api.fetchItemMarketLow(settings.tornKey, ids[i], { signal });
      if (low !== null) lows.set(ids[i], low);
    } catch (err) {
      if (err.name === 'AbortError') break;
      console.warn(`Gegenprobe für ${ids[i]} fehlgeschlagen:`, err.message);
    }
  }

  return rows.map((row) => (
    lows.has(row.itemId) ? { ...row, itemMarketLow: lows.get(row.itemId) } : row
  ));
}
