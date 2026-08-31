// Ledger-Kern: reine Rechnung ohne DOM und ohne Netzwerk.
//
// Gespeichert werden Ereignisse (Kauf oder Verkauf), keine fertigen Trades.
// Nur so lassen sich die Faelle abbilden, die beim Flippen normal sind: ein
// Kauf wird in mehreren Portionen verkauft, ein Verkauf bedient sich aus
// mehreren Kaeufen, und zwischendurch liegt Ware im Bestand.
//
// Zugeordnet wird nach FIFO: der aelteste Kauf deckt den naechsten Verkauf.
// Das entspricht der Reihenfolge, in der man Ware tatsaechlich losschlaegt,
// und ist nachvollziehbar, wenn man eine Zeile im Nachhinein pruefen will.

/** @typedef {'buy'|'sell'} EventKind */

export function makeEvent({
  id, ts, kind, itemId, itemName, quantity, unitPrice,
  counterpartyId = null, counterpartyName = null, source = 'manual', ref = null, note = '',
}) {
  return {
    id: id || `${kind}-${ts}-${itemId}-${Math.random().toString(36).slice(2, 8)}`,
    ts: Number(ts),
    kind,
    itemId: Number(itemId),
    itemName: itemName || `Item ${itemId}`,
    quantity: Number(quantity),
    unitPrice: Number(unitPrice),
    counterpartyId: counterpartyId == null ? null : Number(counterpartyId),
    counterpartyName: counterpartyName || null,
    source,
    ref,
    note,
  };
}

export function isValidEvent(e) {
  return Boolean(e)
    && (e.kind === 'buy' || e.kind === 'sell')
    && Number.isFinite(e.ts)
    && Number.isFinite(e.itemId)
    && Number.isFinite(e.quantity) && e.quantity > 0
    && Number.isFinite(e.unitPrice) && e.unitPrice >= 0;
}

/** Doppelte Importe abfangen: gleiche Quelle plus gleiche Referenz = derselbe Vorgang. */
export function dedupe(events) {
  const seen = new Set();
  const out = [];
  for (const e of events) {
    const key = e.ref ? `${e.source}:${e.ref}` : `id:${e.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(e);
  }
  return out;
}

function groupByItem(events) {
  const map = new Map();
  for (const e of events) {
    if (!map.has(e.itemId)) map.set(e.itemId, []);
    map.get(e.itemId).push(e);
  }
  return map;
}

/**
 * Ordnet Verkaeufe den Kaeufen zu und rechnet den realisierten Profit aus.
 *
 * @returns {{sales: Array, openLots: Array}}
 *   sales    - je Verkauf: Einstandskosten, Erloes, Profit, ungedeckte Menge
 *   openLots - Kaeufe mit Restmenge, also der aktuelle Bestand
 */
export function matchFifo(events) {
  const sales = [];
  const openLots = [];

  for (const [, itemEvents] of groupByItem(events)) {
    const chronological = [...itemEvents].sort((a, b) => a.ts - b.ts);
    const lots = chronological
      .filter((e) => e.kind === 'buy')
      .map((e) => ({ event: e, remaining: e.quantity }));

    for (const sale of chronological.filter((e) => e.kind === 'sell')) {
      let need = sale.quantity;
      let cost = 0;
      const consumed = [];

      for (const lot of lots) {
        if (need <= 0) break;
        if (lot.remaining <= 0) continue;
        // Nur Kaeufe, die vor dem Verkauf lagen, koennen ihn decken.
        if (lot.event.ts > sale.ts) break;

        const take = Math.min(need, lot.remaining);
        cost += take * lot.event.unitPrice;
        lot.remaining -= take;
        need -= take;
        consumed.push({ buyId: lot.event.id, quantity: take, unitPrice: lot.event.unitPrice });
      }

      // Was hier uebrig bleibt, wurde ausserhalb des Ledgers gekauft. Fuer diese
      // Menge gibt es keinen Einstand, also faellt sie aus der Profitrechnung
      // heraus statt sie als reinen Gewinn auszuweisen.
      const coveredQuantity = sale.quantity - need;
      const proceeds = coveredQuantity * sale.unitPrice;

      sales.push({
        sale,
        consumed,
        coveredQuantity,
        uncoveredQuantity: need,
        cost,
        proceeds,
        profit: proceeds - cost,
        margin: cost > 0 ? ((proceeds - cost) / cost) * 100 : null,
      });
    }

    for (const lot of lots) {
      if (lot.remaining > 0) {
        openLots.push({
          event: lot.event,
          remaining: lot.remaining,
          cost: lot.remaining * lot.event.unitPrice,
        });
      }
    }
  }

  sales.sort((a, b) => b.sale.ts - a.sale.ts);
  openLots.sort((a, b) => a.event.ts - b.event.ts);
  return { sales, openLots };
}

/** Kennzahlen ueber eine bereits zugeordnete Menge. */
export function summarise({ sales, openLots }) {
  const realizedProfit = sales.reduce((s, x) => s + x.profit, 0);
  const realizedCost = sales.reduce((s, x) => s + x.cost, 0);
  const proceeds = sales.reduce((s, x) => s + x.proceeds, 0);
  const uncovered = sales.reduce((s, x) => s + x.uncoveredQuantity, 0);
  const openCost = openLots.reduce((s, x) => s + x.cost, 0);
  const openUnits = openLots.reduce((s, x) => s + x.remaining, 0);

  return {
    realizedProfit,
    realizedCost,
    proceeds,
    salesCount: sales.length,
    margin: realizedCost > 0 ? (realizedProfit / realizedCost) * 100 : null,
    openCost,
    openUnits,
    openCount: openLots.length,
    uncoveredUnits: uncovered,
  };
}

export function filterByPeriod(events, days, now = Date.now()) {
  if (!days) return events;
  const cutoff = now - days * 86400000;
  return events.filter((e) => e.ts >= cutoff);
}

/** Realisierter Profit gruppiert nach Item, bester zuerst. */
export function profitByItem(sales) {
  const map = new Map();
  for (const s of sales) {
    const key = s.sale.itemId;
    const acc = map.get(key) || { itemId: key, itemName: s.sale.itemName, profit: 0, units: 0, trades: 0 };
    acc.profit += s.profit;
    acc.units += s.coveredQuantity;
    acc.trades += 1;
    map.set(key, acc);
  }
  return [...map.values()].sort((a, b) => b.profit - a.profit);
}
