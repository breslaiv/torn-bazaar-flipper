// Bewertung des Bestands.
//
// Die offenen Positionen zeigten bisher nur, was die Ware gekostet hat. Die
// interessantere Frage ist, was sie jetzt wert ist - und ob sich Verkaufen
// lohnt. Beides steht im oeffentlichen weav3r-Katalog, ein Request ohne Key.
//
// Zwei Preise, die nicht dasselbe sind, und deshalb hier auch nicht vermischt
// werden:
//
//   Marktwert   Torns market_price. Was das Item "wert" ist, nicht was jemand
//               dafuer zahlt. Fuer eine Bestandsbewertung der richtige Massstab.
//   Ankauf      Der Preis des besten Kaeufers mit oeffentlicher Pricelist. Was
//               du jetzt tatsaechlich bekaemst - meist deutlich darunter.
//
// Ohne Preis wird nicht geschaetzt: eine Position ohne Kurs bleibt unbewertet
// und wird als solche gezaehlt, statt den Bestand stillschweigend kleiner
// aussehen zu lassen.

export const PRICE_CACHE_KEY = 'tbf.prices.v1';

// Der Katalog aendert sich langsam, und die API cacht selbst 30-180 s. Zehn
// Minuten sparen beim Blaettern jeden zweiten Request, ohne dass die Zahlen
// spuerbar altern.
export const PRICE_TTL_MS = 10 * 60 * 1000;

/** Wieviele Kaeufer-Abfragen ein Bestandscheck hoechstens kostet. */
export const MAX_BUYER_LOOKUPS = 12;

/**
 * Bewertet die offenen Lots.
 *
 * @param {Array<{event: object, remaining: number, cost: number}>} lots
 * @param {Map<number, {marketPrice: number}>} prices
 * @param {Map<number, number>} buyers  optionale Ankaufspreise je Item
 */
export function valueLots(lots, prices, buyers = new Map()) {
  return lots.map((lot) => {
    const id = lot.event.itemId;
    const market = Number(prices.get(id)?.marketPrice) || 0;
    const buyer = Number(buyers.get(id)) || 0;

    const value = market > 0 ? lot.remaining * market : null;
    const buyerValue = buyer > 0 ? lot.remaining * buyer : null;

    return {
      ...lot,
      marketPrice: market > 0 ? market : null,
      buyerPrice: buyer > 0 ? buyer : null,
      value,
      buyerValue,
      // Gegen den Einstand gerechnet, nicht gegen den Marktpreis: der Gewinn
      // entsteht beim Kauf, nicht beim Kurs.
      unrealised: value === null ? null : value - lot.cost,
      unrealisedPct: value === null || lot.cost <= 0 ? null : ((value - lot.cost) / lot.cost) * 100,
      buyerUnrealised: buyerValue === null ? null : buyerValue - lot.cost,
    };
  });
}

/** Kennzahlen ueber bewertete Lots. Unbewertetes wird gezaehlt, nicht geraten. */
export function summariseValuation(valued) {
  const priced = valued.filter((v) => v.value !== null);
  const unpriced = valued.length - priced.length;

  const cost = priced.reduce((s, v) => s + v.cost, 0);
  const value = priced.reduce((s, v) => s + v.value, 0);
  const withBuyer = valued.filter((v) => v.buyerValue !== null);

  return {
    cost,
    value,
    unrealised: value - cost,
    unrealisedPct: cost > 0 ? ((value - cost) / cost) * 100 : null,
    buyerValue: withBuyer.length ? withBuyer.reduce((s, v) => s + v.buyerValue, 0) : null,
    buyerCost: withBuyer.length ? withBuyer.reduce((s, v) => s + v.cost, 0) : null,
    priced: priced.length,
    unpriced,
  };
}

/** Item-Ids, fuer die sich eine Kaeufer-Abfrage lohnt: teuerster Bestand zuerst. */
export function buyerLookupOrder(valued, limit = MAX_BUYER_LOOKUPS) {
  const byItem = new Map();
  for (const v of valued) {
    const acc = byItem.get(v.event.itemId) || 0;
    byItem.set(v.event.itemId, acc + (v.value ?? v.cost));
  }
  return [...byItem.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, Math.max(0, limit))
    .map(([itemId]) => itemId);
}

// ---------- Zwischenspeicher ----------

export function readPriceCache(now = Date.now()) {
  let raw;
  try {
    raw = JSON.parse(localStorage.getItem(PRICE_CACHE_KEY) || 'null');
  } catch {
    return null;
  }
  if (!raw || !Number.isFinite(raw.at) || !Array.isArray(raw.items)) return null;
  if (now - raw.at > PRICE_TTL_MS) return null;

  const prices = new Map();
  for (const [id, marketPrice, itemName] of raw.items) {
    if (Number.isFinite(id) && Number.isFinite(marketPrice)) {
      prices.set(id, { marketPrice, itemName });
    }
  }
  return { at: raw.at, prices };
}

export function writePriceCache(items, now = Date.now()) {
  const payload = {
    at: now,
    // Als Tripel statt als Objekte: der Katalog hat ein paar tausend Zeilen,
    // und Schluesselnamen je Zeile waeren die Haelfte des Speicherplatzes.
    items: items
      .filter((i) => Number.isFinite(i.itemId) && Number(i.marketPrice) > 0)
      .map((i) => [i.itemId, Number(i.marketPrice), i.itemName]),
  };
  try {
    localStorage.setItem(PRICE_CACHE_KEY, JSON.stringify(payload));
  } catch {
    // Voller Speicher ist kein Grund, die Bewertung zu verweigern.
  }
  return payload;
}

/** {itemId: {marketPrice, itemName}} aus einer Katalogantwort. */
export function priceMap(items) {
  const map = new Map();
  for (const i of items) {
    if (Number.isFinite(i.itemId) && Number(i.marketPrice) > 0) {
      map.set(i.itemId, { marketPrice: Number(i.marketPrice), itemName: i.itemName });
    }
  }
  return map;
}
