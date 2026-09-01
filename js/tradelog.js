// Trades aus dem Log rekonstruieren.
//
// Ein Trade verteilt sich auf mehrere Log-Eintraege, die ueber
// parsed_trade_id zusammengehoeren. Einzeln ist keiner davon buchbar:
// "Trade completed" nennt weder Ware noch Betrag, "Trade items add" nennt
// keinen Preis. Erst zusammen ergeben sie einen Vorgang.
//
// Beispiel eines echten Verkaufs (Trade 13118955):
//
//   Trade initiate outgoing     "Brass Imgot @ $17,732"
//   Trade items add             ich lege 12x Item 1252 ein
//   Trade money add other user  er legt 212784 ein
//   Trade completed             Abschluss
//   Trade money incoming        ich bekomme 212784
//
//   12 x 17732 = 212784. Wer Ware einlegt und Geld bekommt, hat verkauft.
//
// Die Rollen kommen aus Torns eigenen Titeln. Das Suffix "other user"
// unterscheidet die Gegenseite von der eigenen - daran haengt die Richtung,
// und deshalb sind die Muster verankert: "trade items add" darf nicht auch
// auf "trade items add other user" passen.

import { makeEvent, isValidEvent } from './ledger.js?v=17';

/**
 * Wie ein Trade geendet hat. "offen" heisst nur: im gelesenen Ausschnitt des
 * Logs steht kein Ende - nicht, dass er noch laeuft.
 */
export const STATUS_LABELS = {
  open: 'offen',
  completed: 'abgeschlossen',
  expired: 'abgelaufen',
  cancelled: 'abgebrochen',
  declined: 'abgelehnt',
};

const ROLES = [
  ['completed', /^trade completed$/i],
  // Der Anfang traegt den Text, den man beim Anlegen eingetippt hat - oft die
  // einzige Auskunft darueber, was man ueberhaupt angeboten hat.
  ['initiateMine', /^trade initiate outgoing$/i],
  ['initiateTheirs', /^trade initiate incoming$/i],
  // Die vier Arten, auf die ein Trade endet, ohne dass etwas passiert. Danach
  // liegt die Ware wieder im eigenen Inventar - und ohne diese Eintraege weiss
  // niemand mehr, warum.
  ['cancelMine', /^trade cancel outgoing$/i],
  ['cancelTheirs', /^trade cancel incoming$/i],
  ['declineMine', /^trade decline outgoing$/i],
  ['declineTheirs', /^trade decline incoming$/i],
  ['expired', /^trade expire$/i],
  ['accepted', /^trade accepted$/i],
  ['itemsTheirs', /^trade items add other user$/i],
  ['itemsMine', /^trade items add$/i],
  ['itemsRemoveTheirs', /^trade items remove other user$/i],
  ['itemsRemoveMine', /^trade items remove$/i],
  ['moneyIn', /^trade money incoming$/i],
  ['moneyOut', /^trade money outgoing$/i],
  ['moneyTheirs', /^trade money add other user$/i],
  ['moneyRemoveTheirs', /^trade money remove other user$/i],
  ['moneyMine', /^trade money add$/i],
  ['moneyRemoveMine', /^trade money remove$/i],
];

/** Rolle eines Log-Eintrags innerhalb eines Trades, oder null. */
export function tradeRole(title) {
  const hit = ROLES.find(([, re]) => re.test(String(title || '').trim()));
  return hit ? hit[0] : null;
}

/** Gehoert der Eintrag ueberhaupt in die Trade-Rekonstruktion? */
export function isTradeEntry(entry) {
  return /trade/i.test(entry.category || '') || /^trade\b/i.test(entry.title || '');
}

function num(v) {
  const n = typeof v === 'string' ? Number(v.replace(/[^0-9.-]/g, '')) : v;
  return Number.isFinite(n) ? n : undefined;
}

/** Items eines Eintrags zu {itemId: menge} zusammenfassen. */
function addItems(into, entry, sign) {
  const items = Array.isArray(entry.data?.items) ? entry.data.items : [];
  for (const item of items) {
    const id = num(item?.id ?? item?.item_id);
    const qty = num(item?.qty ?? item?.quantity) ?? 1;
    if (id === undefined || qty <= 0) continue;
    into.set(id, (into.get(id) || 0) + sign * qty);
  }
}

function totalMoney(entries) {
  return entries.reduce((sum, e) => sum + (num(e.data?.money ?? e.data?.total) || 0), 0);
}

/** Gruppiert Log-Eintraege nach der Trade-Id. */
export function groupByTrade(entries) {
  const groups = new Map();
  for (const entry of entries) {
    if (!isTradeEntry(entry)) continue;
    const id = num(entry.data?.parsed_trade_id ?? entry.data?.trade_id);
    if (id === undefined) continue;
    const role = tradeRole(entry.title);
    if (!role) continue;
    if (!groups.has(id)) groups.set(id, { tradeId: id, byRole: new Map(), entries: [] });
    const group = groups.get(id);
    group.entries.push(entry);
    if (!group.byRole.has(role)) group.byRole.set(role, []);
    group.byRole.get(role).push(entry);
  }
  return [...groups.values()];
}

/**
 * Macht aus einer Trade-Gruppe ein Ledger-Ereignis.
 * @returns {{event: object}|{skip: string}}
 */
export function resolveTrade(group, itemNames = new Map()) {
  const role = (name) => group.byRole.get(name) || [];

  // Ohne Abschluss ist nichts passiert: abgebrochene, abgelehnte und
  // abgelaufene Trades hinterlassen dieselben Bestueckungs-Eintraege.
  if (!role('completed').length) {
    return { skip: 'Trade ohne Abschluss (abgebrochen, abgelehnt oder offen)' };
  }

  const mine = new Map();
  addItems(mine, { data: { items: [] } }, 1);
  for (const e of role('itemsMine')) addItems(mine, e, 1);
  for (const e of role('itemsRemoveMine')) addItems(mine, e, -1);

  const theirs = new Map();
  for (const e of role('itemsTheirs')) addItems(theirs, e, 1);
  for (const e of role('itemsRemoveTheirs')) addItems(theirs, e, -1);

  const clean = (m) => new Map([...m].filter(([, qty]) => qty > 0));
  const myItems = clean(mine);
  const theirItems = clean(theirs);

  // Der Abschluss-Transfer ist verlaesslicher als die Bestueckung: was
  // eingelegt und wieder entfernt wurde, taucht dort nicht mehr auf.
  const moneyIn = totalMoney(role('moneyIn')) || totalMoney(role('moneyTheirs'))
    - totalMoney(role('moneyRemoveTheirs'));
  const moneyOut = totalMoney(role('moneyOut')) || totalMoney(role('moneyMine'))
    - totalMoney(role('moneyRemoveMine'));

  if (myItems.size && theirItems.size) {
    return { skip: 'Trade mit Ware auf beiden Seiten - kein Geldwert je Seite' };
  }

  let kind;
  let items;
  let money;
  if (myItems.size && moneyIn > 0) {
    kind = 'sell'; items = myItems; money = moneyIn;
  } else if (theirItems.size && moneyOut > 0) {
    kind = 'buy'; items = theirItems; money = moneyOut;
  } else if (!myItems.size && !theirItems.size) {
    return { skip: 'Trade ohne Ware (nur Geld)' };
  } else {
    return { skip: 'Trade ohne Gegenwert in Geld' };
  }

  if (items.size > 1) {
    // Ohne Einzelpreise laesst sich die Summe nicht fair auf mehrere Items
    // aufteilen. Der Eroeffnungstext nennt zwar oft einen Stueckpreis, aber
    // freier Text ist keine verlaessliche Grundlage fuer eine Bilanz.
    return { skip: `Trade mit ${items.size} verschiedenen Items - bitte von Hand erfassen` };
  }

  const [itemId, quantity] = [...items][0];
  const counterparty = num(group.entries.find((e) => e.data?.user)?.data?.user) ?? null;
  const ts = Math.max(...role('completed').map((e) => e.ts));

  const event = makeEvent({
    ts,
    kind,
    itemId,
    itemName: itemNames.get(itemId) || `Item ${itemId}`,
    quantity,
    unitPrice: money / quantity,
    counterpartyId: counterparty,
    source: 'torn-log',
    // Stabil ueber Importe hinweg: derselbe Trade ergibt dieselbe Referenz.
    ref: `trade-${group.tradeId}`,
    note: `Trade ${group.tradeId}`,
  });

  return isValidEvent(event) ? { event } : { skip: 'unplausible Werte im Trade' };
}

/**
 * Rekonstruiert alle abgeschlossenen Trades aus einem Log-Abzug.
 * @returns {{events: Array, skipped: Array, groups: number}}
 */
export function reconstructTrades(entries, itemNames = new Map()) {
  const groups = groupByTrade(entries);
  const events = [];
  const skipped = new Map();

  for (const group of groups) {
    const result = resolveTrade(group, itemNames);
    if (result.event) {
      events.push(result.event);
    } else {
      const s = skipped.get(result.skip)
        || { reason: result.skip, count: 0, examples: [], sample: group.entries[0] };
      s.count += 1;
      if (s.examples.length < 3) s.examples.push(`Trade ${group.tradeId}`);
      skipped.set(result.skip, s);
    }
  }

  return {
    events,
    skipped: [...skipped.values()].sort((a, b) => b.count - a.count),
    groups: groups.length,
  };
}

// ---------- Angebote ----------
//
// Der Ledger interessiert sich nur fuer abgeschlossene Trades. Fuer die
// Frage "was habe ich wem angeboten" sind aber gerade die anderen wichtig:
// laeuft ein Trade ab, liegt die Ware wieder im Inventar, und ohne den Log
// weiss niemand mehr, wem sie zugedacht war und zu welchem Preis.

/** Preis-Hinweis aus dem Angebotstext, z.B. "Brass Ingot @ $17,732". */
export function priceFromDescription(text) {
  const m = /@\s*\$?\s*([\d.,]+)/.exec(String(text || ''));
  if (!m) return null;
  // Torn schreibt Tausender mit Komma. Ein Punkt kaeme nur als Dezimaltrenner
  // vor, und Stueckpreise sind ganzzahlig - also faellt beides weg.
  const n = Number(m[1].replace(/[.,]/g, ''));
  return Number.isFinite(n) && n > 0 ? n : null;
}

function itemList(map, itemNames) {
  return [...map]
    .filter(([, qty]) => qty > 0)
    .map(([itemId, quantity]) => ({
      itemId,
      quantity,
      itemName: itemNames.get(itemId) || `Item ${itemId}`,
    }));
}

function statusOf(role) {
  if (role('completed').length) return { status: 'completed', by: null };
  if (role('expired').length) return { status: 'expired', by: null };
  if (role('cancelMine').length) return { status: 'cancelled', by: 'me' };
  if (role('cancelTheirs').length) return { status: 'cancelled', by: 'them' };
  if (role('declineMine').length) return { status: 'declined', by: 'me' };
  if (role('declineTheirs').length) return { status: 'declined', by: 'them' };
  return { status: 'open', by: null };
}

/**
 * Beschreibt einen Trade so, wie man ihn sich merken wuerde: wer, was, wieviel,
 * wie ausgegangen. Anders als resolveTrade() faellt hier nichts weg - auch ein
 * abgelaufener Trade ohne Geld ist eine Auskunft.
 */
export function describeTrade(group, itemNames = new Map()) {
  const role = (name) => group.byRole.get(name) || [];
  const { status, by } = statusOf(role);

  const mine = new Map();
  for (const e of role('itemsMine')) addItems(mine, e, 1);
  for (const e of role('itemsRemoveMine')) addItems(mine, e, -1);

  const theirs = new Map();
  for (const e of role('itemsTheirs')) addItems(theirs, e, 1);
  for (const e of role('itemsRemoveTheirs')) addItems(theirs, e, -1);

  const myItems = itemList(mine, itemNames);
  const theirItems = itemList(theirs, itemNames);

  const myMoney = totalMoney(role('moneyMine')) - totalMoney(role('moneyRemoveMine'));
  const theirMoney = totalMoney(role('moneyTheirs')) - totalMoney(role('moneyRemoveTheirs'));

  let direction = 'unknown';
  if (myItems.length && theirItems.length) direction = 'swap';
  else if (myItems.length) direction = 'sell';
  else if (theirItems.length) direction = 'buy';

  const initiate = role('initiateMine')[0] || role('initiateTheirs')[0] || null;
  const description = String(initiate?.data?.description || '').trim();
  const opener = role('initiateMine').length ? 'me' : (role('initiateTheirs').length ? 'them' : null);

  const ends = [
    ...role('completed'), ...role('expired'), ...role('cancelMine'), ...role('cancelTheirs'),
    ...role('declineMine'), ...role('declineTheirs'),
  ];
  const counterparty = num(group.entries.find((e) => e.data?.user)?.data?.user) ?? null;
  const stamps = group.entries.map((e) => e.ts).filter(Number.isFinite);

  const quantity = myItems.concat(theirItems).reduce((s, i) => s + i.quantity, 0);
  const money = Math.max(myMoney, theirMoney);
  const askedUnitPrice = priceFromDescription(description);

  return {
    tradeId: group.tradeId,
    ref: `trade-${group.tradeId}`,
    status,
    statusBy: by,
    openedAt: initiate ? initiate.ts : Math.min(...stamps),
    endedAt: ends.length ? Math.max(...ends.map((e) => e.ts)) : null,
    lastSeen: Math.max(...stamps),
    counterpartyId: counterparty,
    openedBy: opener,
    direction,
    myItems,
    theirItems,
    myMoney,
    theirMoney,
    quantity,
    money,
    // Nur ein Hinweis: der Text ist frei eingetippt und keine Abrechnung.
    askedUnitPrice,
    // Was die Gegenseite hinterlegt hat, ist belastbarer als der Text - sonst
    // bleibt der Stueckpreis aus dem Angebot.
    unitPrice: quantity > 0 && money > 0 ? money / quantity : askedUnitPrice,
    description,
    note: '',
  };
}

/** Alle Trades eines Log-Abzugs als Angebote, neueste zuerst. */
export function offersFromLog(entries, itemNames = new Map()) {
  return groupByTrade(entries)
    .map((group) => describeTrade(group, itemNames))
    .sort((a, b) => b.lastSeen - a.lastSeen);
}
