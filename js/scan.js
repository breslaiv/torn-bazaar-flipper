// Ablauf eines Scans. Getrennt vom UI, damit er testbar bleibt.

import { fetchMarketplace, fetchItemListings, fetchItemTraders, fetchDollarItems } from './weav3r.js?v=19';
import { fetchItemMarketLow } from './torn.js?v=19';
import {
  prescreenBreakdown, pickBuyer, buildFlipRows, buildDollarRows, rejectionReason,
  sortByTotalProfit, allocateBudget,
} from './profit.js?v=19';
import { withNormal } from './normal.js?v=19';

const noop = () => {};

/** Wie viele Kandidaten gleichzeitig geprueft werden. */
export function poolSize(settings) {
  const n = Math.floor(Number(settings?.concurrency));
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.min(n, 8);
}

/**
 * Arbeitet eine Liste mit begrenzt vielen gleichzeitigen Aufgaben ab.
 *
 * Vorher lief jeder Kandidat einzeln: 35 Kandidaten sind 70 Requests
 * nacheinander, und jeder wartet die volle Laufzeit des vorigen ab. Das
 * Rate-Limit greift weiterhin - der Limiter in weav3r.js zaehlt die Requests
 * unabhaengig davon, wer sie ausloest -, aber die Wartezeit auf Antworten
 * ueberlappt sich jetzt.
 */
async function eachLimited(items, limit, worker) {
  let next = 0;
  const run = async () => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      await worker(items[index], index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
}

/**
 * Bazaar -> privater Kaeufer.
 *
 * Kostet 1 Request fuer den Katalog plus 2 pro Kandidat. Deshalb siebt
 * prescreen() vorher auf die Items, bei denen ueberhaupt eine Spanne
 * zwischen billigstem Listing und Marktpreis besteht.
 */
export async function runFlipScan(settings, opts = {}) {
  const { onProgress = noop, signal, deps = {} } = opts;
  const api = {
    fetchMarketplace, fetchItemListings, fetchItemTraders, ...deps,
  };

  onProgress({ phase: 'catalog', text: 'Lade Marktkatalog von weav3r…' });
  const { items, generatedAt } = await api.fetchMarketplace(settings, { signal });

  const breakdown = prescreenBreakdown(items, settings);
  const candidates = breakdown.capped;
  const stats = {
    catalogSize: items.length,
    candidates: candidates.length,
    // Zwischenstaende der Vorauswahl: ohne sie sieht ein zu strenger Rabatt
    // genauso aus wie ein zu kleines Kandidatenlimit.
    listed: breakdown.listed.length,
    discounted: breakdown.discounted.length,
    affordable: breakdown.affordable.length,
    profitable: breakdown.profitable.length,
    checked: 0,
    withoutBuyer: 0,
    buyerBelowRating: 0,
    rowsBuilt: 0,
    belowProfit: 0,
    filteredOut: 0,
    generatedAt,
  };

  if (!candidates.length) {
    return { rows: [], stats };
  }

  const rows = [];
  let done = 0;

  await eachLimited(candidates, poolSize(settings), async (candidate) => {
    if (signal?.aborted) return;

    onProgress({
      phase: 'detail',
      done,
      total: candidates.length,
      text: `Prüfe ${candidate.itemName} (${done + 1}/${candidates.length})…`,
    });

    let listingsRes;
    let tradersRes;
    try {
      [listingsRes, tradersRes] = await Promise.all([
        api.fetchItemListings(candidate.itemId, settings, { signal }),
        api.fetchItemTraders(candidate.itemId, settings, { signal }),
      ]);
    } catch (err) {
      done += 1;
      if (err.name === 'AbortError') return;
      stats.failed = (stats.failed || 0) + 1;
      // Ein einzelnes Item darf den Scan nicht abbrechen.
      console.warn(`Item ${candidate.itemId} übersprungen:`, err.message);
      return;
    }
    done += 1;
    stats.checked += 1;

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

    stats.rowsBuilt += itemRows.length;
    for (const row of itemRows) {
      const reason = rejectionReason(row, settings);
      if (reason === null) rows.push(row);
      // Profitabel, aber an Alter oder Preisgrenze gescheitert: ohne diese
      // Zahl sieht ein zu strenger Frische-Filter wie ein leerer Markt aus.
      else if (reason === 'profit') stats.belowProfit += 1;
      else stats.filteredOut += 1;
    }
  });

  // Erst wenn alle Zeilen feststehen, laesst sich das Budget sinnvoll
  // verteilen - vorher weiss keine Zeile, welche besseren es noch gibt.
  const priced = withNormal(allocateBudget(rows, settings.budget), opts.normalStats || new Map());
  return { rows: sortByTotalProfit(priced), stats };
}

/** $1-Bazaare: alles, was fuer einen Dollar zu haben ist. */
export async function runDollarScan(settings, opts = {}) {
  const { onProgress = noop, signal, deps = {} } = opts;
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

  const built = buildDollarRows(collected, settings);
  const rows = [];
  let belowProfit = 0;
  let filteredOut = 0;
  for (const row of built) {
    const reason = rejectionReason(row, settings);
    if (reason === null) rows.push(row);
    else if (reason === 'profit') belowProfit += 1;
    else filteredOut += 1;
  }

  const priced = withNormal(allocateBudget(rows, settings.budget), opts.normalStats || new Map());
  return {
    rows: sortByTotalProfit(priced),
    stats: {
      catalogSize: collected.length,
      candidates: collected.length,
      listed: collected.length,
      discounted: collected.length,
      affordable: collected.length,
      profitable: collected.length,
      checked: collected.length,
      withoutBuyer: 0,
      buyerBelowRating: 0,
      rowsBuilt: built.length,
      belowProfit,
      filteredOut,
    },
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
