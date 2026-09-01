// Flugplanung: Laender, Reisezeiten und die Rechnung dahinter.
//
// Der Ertrag eines Fluges haengt an drei Zahlen: was ein Item im Ausland
// kostet, was es zuhause bringt, und wie lange der Flug dauert. Die ersten
// beiden liefern YATA und weav3r; die dritte steht in keiner API, weil sie
// von Flugzeug und Perks des Spielers abhaengt.
//
// Deshalb hier eine Tabelle mit den Standardzeiten - nachpruefbar im Spiel -
// und ein Faktor fuer schnellere Flieger. Wer es genau haben will, traegt
// seine gemessene Zeit je Land ein; die schlaegt die Tabelle.

/** Einwegzeiten ohne Perks, in Minuten. */
export const COUNTRIES = [
  { code: 'mex', name: 'Mexiko', minutes: 26 },
  { code: 'cay', name: 'Cayman Islands', minutes: 35 },
  { code: 'can', name: 'Kanada', minutes: 41 },
  { code: 'haw', name: 'Hawaii', minutes: 134 },
  { code: 'uni', name: 'England', minutes: 159 },
  { code: 'arg', name: 'Argentinien', minutes: 167 },
  { code: 'swi', name: 'Schweiz', minutes: 175 },
  { code: 'jap', name: 'Japan', minutes: 225 },
  { code: 'chi', name: 'China', minutes: 242 },
  { code: 'uae', name: 'VAE', minutes: 271 },
  { code: 'sou', name: 'Südafrika', minutes: 297 },
];

/**
 * Schreibweisen, unter denen Laender in fremden Daten auftauchen. YATA
 * benennt sie je nach Route unterschiedlich, und ein Land, das nur wegen
 * seines Schluessels nicht gefunden wird, waere ein aergerlicher Verlust.
 */
const ALIASES = {
  mex: ['mex', 'mexico', 'mexiko'],
  cay: ['cay', 'cayman', 'cayman islands', 'caymanislands'],
  can: ['can', 'canada', 'kanada'],
  haw: ['haw', 'hawaii'],
  uni: ['uni', 'uk', 'united kingdom', 'unitedkingdom', 'england', 'britain'],
  arg: ['arg', 'argentina', 'argentinien'],
  swi: ['swi', 'switzerland', 'schweiz'],
  jap: ['jap', 'japan'],
  chi: ['chi', 'china'],
  uae: ['uae', 'united arab emirates', 'unitedarabemirates', 'dubai'],
  sou: ['sou', 'south africa', 'southafrica', 'südafrika', 'sudafrika'],
};

export function countryCode(key) {
  const wanted = String(key || '').trim().toLowerCase().replace(/[_-]+/g, ' ');
  for (const [code, names] of Object.entries(ALIASES)) {
    if (names.includes(wanted) || names.includes(wanted.replace(/\s+/g, ''))) return code;
  }
  return null;
}

export function countryName(code) {
  return COUNTRIES.find((c) => c.code === code)?.name || code;
}

/**
 * Flugzeuge kuerzen die Reisezeit um einen festen Anteil. Die Werte stehen
 * im Spiel und lassen sich mit einer gemessenen Zeit ueberschreiben.
 */
/**
 * Die vier Flugarten, wie Torn sie in /user/travel benennt.
 *
 * Die Faktoren stammen aus der Community, nicht aus einer Dokumentation -
 * deshalb schlaegt eine gemessene Zeit sie immer, und die Seite sagt dazu,
 * dass es Schaetzungen sind. "Private" fehlte hier, bis der Abgleich mit
 * Torns eigener Aufzaehlung es zeigte.
 */
export const AIRSTRIPS = [
  { key: 'standard', label: 'Standard', factor: 1 },
  { key: 'airstrip', label: 'Airstrip', factor: 0.7 },
  { key: 'private', label: 'Privatjet', factor: 0.7 },
  { key: 'business', label: 'Business Class', factor: 0.3 },
];

export function travelFactor(key) {
  return AIRSTRIPS.find((a) => a.key === key)?.factor ?? 1;
}

/**
 * Einwegzeit fuer ein Land.
 * @param {object} settings  travelAirstrip und optional travelTimes[code]
 */
export function oneWayMinutes(code, settings = {}) {
  // Eine gemessene Zeit schlaegt jede Tabelle: sie enthaelt bereits alles,
  // was an Perks und Flugzeug dranhaengt.
  const measured = Number(settings.travelTimes?.[code]);
  if (Number.isFinite(measured) && measured > 0) return measured;

  const base = COUNTRIES.find((c) => c.code === code)?.minutes;
  if (!Number.isFinite(base)) return null;
  return base * travelFactor(settings.travelAirstrip);
}

/**
 * Bewertet ein Auslands-Item fuer einen Flug.
 *
 * @param {{itemId:number,itemName:string,cost:number,quantity:number}} item  aus dem Auslandsshop
 * @param {number|null} marketPrice  Marktwert zuhause
 * @param {{capacity:number,budget:number,marketFeePct:number}} settings
 */
export function rateItem(item, marketPrice, settings = {}) {
  const capacity = Math.max(1, Number(settings.travelCapacity) || 1);
  const budget = Number(settings.budget) || 0;
  const fee = Number(settings.marketFeePct) || 0;

  const net = marketPrice > 0 ? marketPrice * (1 - fee / 100) : null;
  const profitPerUnit = net === null ? null : net - item.cost;

  // Massgeblich ist, was bei der Landung dasteht - nicht, was jetzt dasteht.
  // Sonst faellt ausgerechnet das interessanteste Ziel heraus: ein leeres
  // Regal, dessen Timer laeuft und das voll ist, wenn man ankommt.
  const available = Number.isFinite(item.expectedQuantity) ? item.expectedQuantity : item.quantity;

  // Drei Grenzen, und die kleinste gewinnt: Platz im Koffer, Ware im Regal,
  // Geld auf der Hand. Alles andere waere eine Zahl, die man nicht kaufen kann.
  const affordable = budget > 0 && item.cost > 0 ? Math.floor(budget / item.cost) : Infinity;
  const units = Math.max(0, Math.min(capacity, available ?? capacity, affordable));

  return {
    ...item,
    marketPrice: marketPrice > 0 ? marketPrice : null,
    netPrice: net,
    profitPerUnit,
    profitPct: profitPerUnit === null || item.cost <= 0 ? null : (profitPerUnit / item.cost) * 100,
    units,
    spend: units * item.cost,
    tripProfit: profitPerUnit === null ? null : profitPerUnit * units,
    expectedQuantity: Number.isFinite(item.expectedQuantity) ? item.expectedQuantity : null,
    limitedBy: units === 0 ? 'nichts' : (
      units === available ? 'Vorrat' : (units === affordable ? 'Budget' : 'Kapazität')
    ),
  };
}

/**
 * Bestes Item je Land, bewertet nach Profit pro Minute Rundflug.
 *
 * Pro Minute, nicht pro Flug: ein Flug nach Suedafrika bringt mehr als einer
 * nach Mexiko, dauert aber zehnmal so lang. Wer die Zeit nicht mitrechnet,
 * fliegt systematisch zu weit.
 */
export function planCountry(code, items, prices, settings = {}) {
  const minutes = oneWayMinutes(code, settings);
  const roundTrip = minutes === null ? null : minutes * 2;

  const rated = items
    .map((item) => rateItem(item, Number(prices.get(item.itemId)?.marketPrice) || 0, settings))
    .filter((r) => r.tripProfit !== null && r.tripProfit > 0)
    .sort((a, b) => b.tripProfit - a.tripProfit);

  const best = rated[0] || null;
  return {
    code,
    name: countryName(code),
    oneWayMinutes: minutes,
    roundTripMinutes: roundTrip,
    items: rated,
    best,
    tripProfit: best ? best.tripProfit : 0,
    profitPerMinute: best && roundTrip > 0 ? best.tripProfit / roundTrip : null,
  };
}

/** Alle Laender, bester Ertrag pro Minute zuerst. */
export function planTrips(stocksByCountry, prices, settings = {}) {
  return [...stocksByCountry.entries()]
    .map(([code, items]) => planCountry(code, items, prices, settings))
    .sort((a, b) => (b.profitPerMinute ?? -1) - (a.profitPerMinute ?? -1));
}
