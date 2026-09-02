import { loadSettings, saveSettings } from './storage.js?v=20';
import {
  makeEvent, matchFifo, summarise, profitByItem,
  PERIODS, periodRange, filterByRange,
} from './ledger.js?v=20';
import {
  loadEvents, saveEvents, addEvents, removeEvent, updateEvent, clearLedger,
  exportJson, parseImport, markExported, lastExport,
} from './ledgerStore.js?v=20';
import {
  fetchLog, fetchLogTypes, fetchLogCategories, deriveLogTypes, deriveCategories,
  inspect, TornLogError,
} from './tornlog.js?v=20';
import { reconstructTrades, offersFromLog, STATUS_LABELS } from './tradelog.js?v=20';
import { loadOffers, mergeOffers, setNote, removeOffer } from './offersStore.js?v=20';
import { fetchMarketplace, fetchItemTraders } from './weav3r.js?v=20';
import {
  valueLots, summariseValuation, buyerLookupOrder, priceMap,
  readPriceCache, writePriceCache, MAX_BUYER_LOOKUPS,
} from './valuation.js?v=20';
import { renderTable } from './table.js?v=20';
import { fmtMoney, fmtPct, setStatus, escapeHtml, showVersion } from './ui.js?v=20';
import { APP_VERSION } from './config.js?v=20';
import { restorePanels } from './panels.js?v=20';

let events = [];
let offers = [];
let pendingImport = [];
// Preise und Ankaufspreise leben nur fuer diese Sitzung im Speicher; der
// Katalog selbst liegt zwischengespeichert im localStorage.
let prices = new Map();
let buyerPrices = new Map();
let editingId = null;

const dateFmt = new Intl.DateTimeFormat('de-DE', { day: '2-digit', month: '2-digit', year: '2-digit' });
const fmtDate = (ts) => dateFmt.format(new Date(ts));
const fmtUnits = new Intl.NumberFormat('de-DE');

// ---------- Kennzahlen ----------

function tile(label, value, sub = '', cls = '') {
  return `<div class="tile">
    <div class="label">${escapeHtml(label)}</div>
    <div class="value ${cls}">${value}</div>
    ${sub ? `<div class="sub">${escapeHtml(sub)}</div>` : ''}
  </div>`;
}

function renderTiles(summary, range) {
  const period = periodSubtitle(range);
  const profitCls = summary.realizedProfit >= 0 ? 'pos' : 'neg';

  const parts = [
    tile('Realisierter Profit', fmtMoney(summary.realizedProfit), period, profitCls),
    tile('Marge', summary.margin === null ? '—' : fmtPct(summary.margin),
      `aus ${fmtUnits.format(summary.salesCount)} ${summary.salesCount === 1 ? 'Verkauf' : 'Verkäufen'}`),
    tile('Umsatz', fmtMoney(summary.proceeds), `Einstand ${fmtMoney(summary.realizedCost)}`),
    // Bewusst ohne Zeitraum-Untertitel: der Bestand ignoriert die Auswahl.
    tile('Gebundenes Kapital', fmtMoney(summary.openCost),
      `${fmtUnits.format(summary.openUnits)} Stück offen, gesamt`),
  ];

  if (summary.valuation && summary.valuation.priced > 0) {
    const v = summary.valuation;
    const sub = v.unpriced
      ? `${fmtMoney(v.value)} Marktwert, ${v.unpriced} ohne Kurs`
      : `${fmtMoney(v.value)} Marktwert`;
    parts.push(tile('Unrealisiert', fmtMoney(v.unrealised), sub,
      v.unrealised >= 0 ? 'pos' : 'neg'));
  }

  if (summary.uncoveredUnits > 0) {
    // Sonst sieht der Profit hoeher aus als er ist, ohne dass jemand merkt warum.
    parts.push(tile('Ohne Einstand', `${fmtUnits.format(summary.uncoveredUnits)}`,
      'verkauft ohne erfassten Kauf', 'warn-text'));
  }

  document.getElementById('tiles').innerHTML = parts.join('');
}

// ---------- Tabellen ----------

const editButton = (id) => `<button class="link-btn" data-edit="${escapeHtml(id)}">ändern</button>`;
const deleteButton = (id) => `<button class="link-btn" data-del="${escapeHtml(id)}">löschen</button>`;

const OPEN_COLUMNS = [
  { key: 'item', label: 'Item', align: 'left', cell: (r) => ({ text: r.event.itemName }) },
  { key: 'date', label: 'Gekauft', cell: (r) => ({ text: fmtDate(r.event.ts) }) },
  { key: 'qty', label: 'Menge', cell: (r) => ({ text: fmtUnits.format(r.remaining) }) },
  { key: 'unit', label: 'Einstand/Stück', cell: (r) => ({ text: fmtMoney(r.event.unitPrice) }) },
  { key: 'cost', label: 'Kapital', cell: (r) => ({ text: fmtMoney(r.cost), cls: 'strong' }) },
  {
    key: 'value',
    label: 'Wert jetzt',
    cell: (r) => ({
      // Ohne Kurs wird nicht geschaetzt - ein Fragezeichen ist ehrlicher als
      // eine Zahl, die der Einstand ist.
      html: r.value === null || r.value === undefined
        ? '<span class="muted">?</span>'
        : escapeHtml(fmtMoney(r.value))
          + (r.buyerValue ? `<span class="tag">Ankauf ${fmtMoney(r.buyerValue)}</span>` : ''),
    }),
  },
  {
    key: 'unrealised',
    label: 'Unrealisiert',
    cell: (r) => (r.unrealised === null || r.unrealised === undefined
      ? { text: '—' }
      : {
        text: `${fmtMoney(r.unrealised)}${r.unrealisedPct === null ? '' : ` (${fmtPct(r.unrealisedPct)})`}`,
        cls: `strong ${r.unrealised >= 0 ? 'pos' : 'neg'}`,
      }),
  },
  {
    key: 'actions',
    label: '',
    cell: (r) => ({ html: `${editButton(r.event.id)}${deleteButton(r.event.id)}` }),
  },
];

const SALE_COLUMNS = [
  { key: 'item', label: 'Item', align: 'left', cell: (s) => ({ text: s.sale.itemName }) },
  { key: 'date', label: 'Verkauft', cell: (s) => ({ text: fmtDate(s.sale.ts) }) },
  {
    key: 'qty',
    label: 'Menge',
    cell: (s) => ({
      text: s.uncoveredQuantity
        ? `${fmtUnits.format(s.coveredQuantity)} (+${fmtUnits.format(s.uncoveredQuantity)} ohne Einstand)`
        : fmtUnits.format(s.coveredQuantity),
    }),
  },
  { key: 'cost', label: 'Einstand', cell: (s) => ({ text: fmtMoney(s.cost) }) },
  { key: 'proceeds', label: 'Erlös', cell: (s) => ({ text: fmtMoney(s.proceeds) }) },
  {
    key: 'profit',
    label: 'Profit',
    cell: (s) => ({ text: fmtMoney(s.profit), cls: `strong ${s.profit >= 0 ? 'pos' : 'neg'}` }),
  },
  {
    key: 'margin',
    label: 'Marge',
    cell: (s) => ({
      text: s.margin === null ? '—' : fmtPct(s.margin),
      cls: s.profit >= 0 ? 'pos' : 'neg',
    }),
  },
  {
    key: 'actions',
    label: '',
    cell: (s) => ({ html: `${editButton(s.sale.id)}${deleteButton(s.sale.id)}` }),
  },
];

const ITEM_COLUMNS = [
  { key: 'item', label: 'Item', align: 'left', cell: (r) => ({ text: r.itemName }) },
  { key: 'trades', label: 'Verkäufe', cell: (r) => ({ text: fmtUnits.format(r.trades) }) },
  { key: 'units', label: 'Stück', cell: (r) => ({ text: fmtUnits.format(r.units) }) },
  {
    key: 'profit',
    label: 'Profit',
    cell: (r) => ({ text: fmtMoney(r.profit), cls: `strong ${r.profit >= 0 ? 'pos' : 'neg'}` }),
  },
];

// ---------- Angebote ----------

const TRADE_URL = 'https://www.torn.com/trade.php#step=view&ID=';
const PROFILE_URL = 'https://www.torn.com/profiles.php?XID=';

function offerItems(offer) {
  const side = offer.myItems.length ? offer.myItems : offer.theirItems;
  if (!side.length) return offer.money > 0 ? 'nur Geld' : '—';
  return side.map((i) => `${fmtUnits.format(i.quantity)}× ${i.itemName}`).join(', ');
}

/** Was der Trade fuer dich bedeutet - aus der Richtung heraus benannt. */
function offerDirection(offer) {
  return { sell: 'Verkauf', buy: 'Kauf', swap: 'Tausch' }[offer.direction] || '—';
}

function statusText(offer) {
  const label = STATUS_LABELS[offer.status] || offer.status;
  if (offer.status === 'cancelled' || offer.status === 'declined') {
    return offer.statusBy === 'me' ? `${label} (von dir)` : `${label} (von ihm)`;
  }
  return label;
}

const OFFER_COLUMNS = [
  {
    key: 'what',
    label: 'Angebot',
    align: 'left',
    cell: (o) => ({
      html: `<a class="item-link" href="${TRADE_URL}${encodeURIComponent(o.tradeId)}" target="_blank" rel="noopener">`
        + `${escapeHtml(offerItems(o))}<span class="ext" aria-hidden="true">&#8599;</span></a>`
        // Der Text aus dem Angebot ist oft das Einzige, was den Preis nennt.
        + (o.description ? `<span class="tag">${escapeHtml(o.description)}</span>` : ''),
    }),
  },
  {
    key: 'who',
    label: 'Mit',
    align: 'left',
    cell: (o) => ({
      html: o.counterpartyId
        ? `<a href="${PROFILE_URL}${encodeURIComponent(o.counterpartyId)}" target="_blank" rel="noopener">`
          + `${escapeHtml(String(o.counterpartyId))}</a>`
        : '—',
    }),
  },
  { key: 'kind', label: 'Art', cell: (o) => ({ text: offerDirection(o) }) },
  { key: 'date', label: 'Angelegt', cell: (o) => ({ text: fmtDate(o.openedAt) }) },
  {
    key: 'price',
    label: 'Preis/Stück',
    cell: (o) => ({
      // Ohne hinterlegtes Geld bleibt nur der Preis aus dem Angebotstext, und
      // der ist frei eingetippt - deshalb als Schaetzung gekennzeichnet.
      html: Number.isFinite(o.unitPrice) && o.unitPrice > 0
        ? escapeHtml(fmtMoney(o.unitPrice)) + (o.money > 0 ? '' : '<span class="tag">laut Text</span>')
        : '—',
    }),
  },
  {
    key: 'status',
    label: 'Status',
    cell: (o) => ({
      text: statusText(o),
      cls: o.status === 'completed' ? 'pos' : (o.status === 'open' ? '' : 'warn-text'),
    }),
  },
  {
    key: 'note',
    label: 'Notiz',
    align: 'left',
    cell: (o) => ({
      html: `<button class="link-btn" data-note="${escapeHtml(String(o.tradeId))}">`
        + `${o.note ? escapeHtml(o.note) : 'Notiz…'}</button>`,
    }),
  },
  {
    key: 'del',
    label: '',
    cell: (o) => ({ html: `<button class="link-btn" data-drop="${escapeHtml(String(o.tradeId))}">löschen</button>` }),
  },
];

function visibleOffers() {
  const mode = document.getElementById('offerFilter').value;
  if (mode === 'open') return offers.filter((o) => o.status === 'open');
  if (mode === 'unfinished') return offers.filter((o) => o.status !== 'completed');
  return offers;
}

function renderOffers() {
  const rows = [...visibleOffers()].sort((a, b) => b.openedAt - a.openedAt);
  renderTable('offerTable', OFFER_COLUMNS, rows, {
    empty: offers.length
      ? 'Nichts in dieser Auswahl — probier „alle".'
      : 'Noch nichts importiert. Der Import unten liest die Angebote aus dem Torn-Log.',
  });
  document.getElementById('offerCount').textContent = String(offers.filter((o) => o.status === 'open').length);

  const hint = document.getElementById('offerHint');
  const open = offers.filter((o) => o.status === 'open').length;
  hint.textContent = open
    ? `„Offen" heißt: im gelesenen Ausschnitt des Logs steht kein Ende. Ein Trade, dessen `
      + `Abschluss älter ist als der Import, bleibt hier stehen — dann hilft ein größerer Ausschnitt.`
    : '';
}

// ---------- Aufbau ----------

function fillPeriods(selected) {
  const select = document.getElementById('periodSelect');
  select.innerHTML = PERIODS
    .map((p) => `<option value="${p.key}">${escapeHtml(p.label)}</option>`)
    .join('');
  select.value = PERIODS.some((p) => p.key === selected) ? selected : 'all';
}

function currentPeriod() {
  return document.getElementById('periodSelect').value || 'all';
}

/** "Heute · 31.08.26" oder "7 Tage · 25.08.–31.08.26" - was gezaehlt wurde. */
function periodSubtitle({ from, to, label }) {
  if (from === null) return 'gesamter Zeitraum';
  // to ist ausschliesslich; angezeigt wird der letzte enthaltene Tag.
  const last = to === null ? Date.now() : to - 1;
  const first = fmtDate(from);
  const lastDay = fmtDate(last);
  if (first === lastDay) return `${label} · ${first}`;
  // "25.08.–31.08.26" statt "25.08.26–31.08.26": das Jahr zweimal frisst auf
  // dem Telefon eine Zeile.
  const short = first.slice(-2) === lastDay.slice(-2) ? first.slice(0, -2) : first;
  return `${label} · ${short}–${lastDay}`;
}

function render() {
  const range = periodRange(currentPeriod());

  // Zugeordnet wird immer ueber die ganze Historie und erst danach nach dem
  // Verkaufsdatum zugeschnitten. Wuerde der Zeitraum schon die Ereignisse
  // filtern, verloere ein Verkauf von heute den Einstand eines Kaufs von
  // letzter Woche - der Profit saehe dann wie null aus.
  const all = matchFifo(events);
  const scoped = {
    sales: filterByRange(all.sales, range, (s) => s.sale.ts),
    // Offene Positionen ignorieren den Zeitraum: ein alter Kauf bindet
    // weiterhin Kapital.
    openLots: [],
  };

  const summary = { ...summarise(scoped), openCost: 0, openUnits: 0, openCount: 0 };
  const openSummary = summarise(all);
  summary.openCost = openSummary.openCost;
  summary.openUnits = openSummary.openUnits;
  summary.openCount = openSummary.openCount;

  // Der Bestand wird bewertet, sobald Kurse da sind - sonst bleiben die
  // beiden Spalten leer, statt dass die Tabelle anders aussieht.
  const valued = valueLots(all.openLots, prices, buyerPrices);
  summary.valuation = summariseValuation(valued);

  renderTiles(summary, range);
  renderTable('openTable', OPEN_COLUMNS, valued, { empty: 'Kein offener Bestand.' });
  renderTable('salesTable', SALE_COLUMNS, scoped.sales, {
    // Nur Kaeufe erfasst und nichts verkauft heisst nicht, dass der Ledger
    // kaputt ist. Verkaeufe ueber Trades werden zwar zugeordnet, aber nur die
    // abgeschlossenen - offene und abgelaufene stehen unter "Angebote".
    empty: all.openLots.length
      ? 'Keine Verkäufe im Zeitraum, aber Bestand vorhanden. Abgeschlossene Trades kommen beim '
        + 'Import mit; was noch offen oder abgelaufen ist, steht unter „Angebote".'
      : `Keine Verkäufe im Zeitraum (${periodSubtitle(range)}).`,
  });
  renderTable('byItemTable', ITEM_COLUMNS, profitByItem(scoped.sales), { empty: 'Noch nichts verkauft.' });

  document.getElementById('openCount').textContent = String(all.openLots.length);
  document.getElementById('saleCount').textContent = String(scoped.sales.length);

  const hint = document.getElementById('backupHint');
  const exported = lastExport();
  const stale = events.length > 0 && (!exported || Date.now() - exported > 14 * 86400000);
  hint.hidden = !stale;
  if (stale) {
    hint.textContent = exported
      ? `Letzte Sicherung am ${fmtDate(exported)}. Der Browser kann den Ledger jederzeit verwerfen — exportier ihn wieder.`
      : `${events.length} Einträge, noch nie exportiert. Der Browser kann sie jederzeit verwerfen.`;
  }
}

function reload() {
  events = loadEvents();
  offers = loadOffers();
  render();
  renderOffers();
}

// ---------- Kurse und Bestandsbewertung ----------

/**
 * Holt den weav3r-Katalog - aus dem Zwischenspeicher, wenn er frisch genug
 * ist. Ein Fehlschlag ist kein Grund fuer eine Fehlermeldung: ohne Kurse
 * bleiben die Wertspalten leer, der Rest der Seite funktioniert weiter.
 */
async function loadPrices({ force = false } = {}) {
  if (!force) {
    const cached = readPriceCache();
    if (cached) {
      prices = cached.prices;
      return { from: 'cache', at: cached.at };
    }
  }

  try {
    const { items } = await fetchMarketplace(loadSettings());
    prices = priceMap(items);
    writePriceCache(items);
    return { from: 'api', at: Date.now() };
  } catch (err) {
    console.warn('Kurse nicht geladen:', err.message);
    return { from: 'error', error: err.message };
  }
}

function setValuationMsg(text, cls = 'hint') {
  const el = document.getElementById('valuationMsg');
  el.textContent = text;
  el.className = cls;
}

/**
 * Fragt fuer die groessten Positionen den besten Ankaufspreis ab.
 * Kostet einen Request je Item, deshalb gedeckelt und nur auf Knopfdruck.
 */
async function checkBuyers() {
  const btn = document.getElementById('buyerCheckBtn');
  const lots = matchFifo(events).openLots;
  if (!lots.length) {
    setValuationMsg('Kein Bestand, nichts zu prüfen.');
    return;
  }

  btn.disabled = true;
  const settings = loadSettings();
  const ids = buyerLookupOrder(valueLots(lots, prices), MAX_BUYER_LOOKUPS);
  let found = 0;

  try {
    for (let i = 0; i < ids.length; i++) {
      setValuationMsg(`Frage Käufer ab… ${i + 1}/${ids.length}`);
      try {
        const { traders } = await fetchItemTraders(ids[i], settings);
        const best = traders.find((tr) => tr.price > 0);
        if (best) {
          buyerPrices.set(ids[i], best.price);
          found += 1;
        }
      } catch (err) {
        console.warn(`Käufer für ${ids[i]} nicht geladen:`, err.message);
      }
    }

    render();
    const rest = lots.length > ids.length ? `, ${lots.length - ids.length} weitere ungeprüft` : '';
    setValuationMsg(found
      ? `Beste Ankaufspreise für ${found} von ${ids.length} Positionen${rest}. `
        + 'Das ist, was du jetzt bekämst — nicht der Marktwert.'
      : 'Kein aktiver Käufer für deinen Bestand gefunden.');
  } finally {
    btn.disabled = false;
  }
}

// ---------- Itemauswahl ----------

/** Fuellt die Vorschlagsliste des Item-Feldes aus dem Katalog. */
function fillItemList() {
  const list = document.getElementById('itemList');
  if (!prices.size) return;
  // Ein paar tausend Optionen sind fuer datalist zuviel; die Auswahl richtet
  // sich nach dem, was schon im Ledger steht, plus dem teuersten Rest.
  const known = new Set(events.map((e) => e.itemId));
  const entries = [...prices.entries()]
    .map(([itemId, p]) => ({ itemId, itemName: p.itemName, marketPrice: p.marketPrice }))
    .filter((i) => i.itemName)
    .sort((a, b) => (
      (known.has(b.itemId) ? 1 : 0) - (known.has(a.itemId) ? 1 : 0)
      || b.marketPrice - a.marketPrice
    ))
    .slice(0, 400);

  list.innerHTML = entries
    .map((i) => `<option value="${escapeHtml(i.itemName)}"></option>`)
    .join('');
}

/**
 * Deutet die Eingabe im Item-Feld: Name aus dem Katalog oder nackte Id.
 * @returns {{itemId: number, itemName: string}|null}
 */
function resolveItem(input) {
  const text = String(input || '').trim();
  if (!text) return null;

  if (/^\d+$/.test(text)) {
    const id = Number(text);
    return { itemId: id, itemName: prices.get(id)?.itemName || `Item ${id}` };
  }

  const wanted = text.toLowerCase();
  for (const [itemId, p] of prices) {
    if (String(p.itemName || '').toLowerCase() === wanted) return { itemId, itemName: p.itemName };
  }
  // Auch ein Teiltreffer hilft, solange er eindeutig ist.
  const hits = [...prices.entries()].filter(([, p]) => String(p.itemName || '').toLowerCase().includes(wanted));
  if (hits.length === 1) return { itemId: hits[0][0], itemName: hits[0][1].itemName };
  return null;
}

function showItemHint() {
  const hint = document.getElementById('mItemHint');
  const hit = resolveItem(document.getElementById('mItem').value);
  if (!hit) {
    hint.textContent = prices.size
      ? 'Name aus der Liste wählen oder Item-ID eintippen.'
      : 'Katalog noch nicht geladen — Item-ID eintippen oder oben aktualisieren.';
    return;
  }
  const market = prices.get(hit.itemId)?.marketPrice;
  hint.textContent = market
    ? `${hit.itemName} (ID ${hit.itemId}) — Marktpreis ${fmtMoney(market)}`
    : `${hit.itemName} (ID ${hit.itemId})`;
}

// ---------- Key ----------

// Derselbe Key wie in den Scanner-Einstellungen, nur hier direkt erreichbar:
// wer importieren will, soll nicht erst die Seite wechseln muessen.
function renderKeyState() {
  const stored = (loadSettings().tornKey || '').trim();
  const state = document.getElementById('keyState');
  state.textContent = stored
    ? `Hinterlegt: …${stored.slice(-4)}. Wird nur an api.torn.com gesendet.`
    : 'Noch keiner hinterlegt. Ohne Key kein Import.';
  state.className = stored ? 'hint' : 'hint warn-text';
}

function saveKey() {
  const value = document.getElementById('ledgerTornKey').value.trim();
  saveSettings({ ...loadSettings(), tornKey: value });
  document.getElementById('ledgerTornKey').value = '';
  renderKeyState();
  setStatus(value ? 'Key gespeichert.' : 'Key entfernt.', 'ok');
}

// ---------- Torn-Log ----------

async function importFromLog({ quiet = false } = {}) {
  const settings = loadSettings();
  if (!settings.tornKey) {
    setStatus('Kein Torn-Key hinterlegt — trag ihn im Feld darüber ein und speichere.', 'error');
    document.getElementById('ledgerTornKey').focus();
    return;
  }

  const report = document.getElementById('importReport');
  const btn = document.getElementById('importLogBtn');
  btn.disabled = true;
  setStatus('Lese Torn-Log…');

  try {
    // Der Log nennt nur Item-IDs. Die Namen kommen aus dem oeffentlichen
    // weav3r-Katalog - ein Request, kein Key. Scheitert er, heissen die
    // Zeilen eben "Item 206"; das ist kein Grund, den Import abzubrechen.
    let itemNames = new Map();
    try {
      const { items } = await fetchMarketplace(settings);
      itemNames = new Map(items.map((i) => [i.itemId, i.itemName]));
    } catch (err) {
      console.warn('Itemnamen nicht geladen:', err.message);
    }

    // Torn nennt seine Log-Typen selbst. Erst die Liste holen (Public reicht),
    // daraus die Kauf- und Verkaufstypen ableiten, dann serverseitig danach
    // filtern - das erspart es, irrelevante Kategorien durchzublaettern.
    setStatus('Lade Torns Log-Typen…');
    const { byId, matched } = deriveLogTypes(await fetchLogTypes(settings.tornKey));
    const cats = deriveCategories(await fetchLogCategories(settings.tornKey));

    setStatus('Lese Torn-Log…');
    const maxEntries = Number(document.getElementById('logMax').value) || 300;
    const { entries, usedFilter, fellBack } = await fetchLog(settings.tornKey, {
      maxEntries, categoryIds: cats.map((c) => c.id),
    });
    const result = inspect(entries, itemNames, byId);
    // Trades entstehen aus mehreren Log-Eintraegen und werden getrennt
    // zusammengesetzt; einzeln ist keiner davon buchbar.
    const trades = reconstructTrades(entries, itemNames);
    pendingImport = [...result.events, ...trades.events];
    backfillNames(itemNames);

    // Angebote landen sofort im Speicher, nicht erst beim Uebernehmen: sie
    // sind keine Buchung, sondern ein Gedaechtnisstuetze - und je frueher sie
    // dasteht, desto eher hilft sie.
    const seen = offersFromLog(entries, itemNames);
    const merged = mergeOffers(seen);
    offers = merged.offers;
    renderOffers();

    const lines = [];
    // Steht bewusst als erste Zeile: ohne sie laesst sich ein Bericht nicht
    // dem Code zuordnen, der ihn erzeugt hat.
    lines.push(`Build ${APP_VERSION} — ${new Date().toLocaleString('de-DE')}`);
    lines.push(`${entries.length} Log-Einträge gelesen, ${pendingImport.length} Vorgänge erkannt `
      + `(${result.events.length} direkt, ${trades.events.length} aus ${trades.groups} Trades).`);
    lines.push(`${seen.length} Angebote gesehen: ${merged.added} neu, ${merged.updated} mit neuem Status.`);
    const catNames = cats.map((c) => `${c.title} (${c.id})`).join(', ');
    lines.push(usedFilter
      ? `Kategorien gelesen: ${catNames || '—'}`
      : (fellBack
        ? `Kategorien ${catNames} lieferten nichts — ungefiltert nachgelesen.`
        : 'Ungefiltert gelesen: keine Kategorie passte.'));
    lines.push('');
    lines.push('--- Zugeordnete Log-Typen (von Torn benannt) ---');
    if (matched.length) {
      const label = { buy: 'Kauf        ', sell: 'Verkauf     ', trade: 'Richtung offen' };
      for (const m of matched) {
        lines.push(`  ${String(m.id).padStart(6)}  ${label[m.kind] || m.kind}  ${m.title}`);
      }
    } else {
      lines.push('  keiner — deshalb wurde ungefiltert gelesen. Die Kategorien unten zeigen,');
      lines.push('  wie Torn die Einträge nennt; danach lassen sich die Regeln ergänzen.');
    }
    lines.push('');

    const skipped = [...result.skipped, ...trades.skipped]
      .filter((s) => !/Teil eines Trades/.test(s.reason))
      .sort((a, b) => b.count - a.count);
    if (skipped.length) {
      lines.push('--- Nicht übernommen ---');
      for (const s of skipped) {
        lines.push(`${String(s.count).padStart(4)} x  ${s.reason}`);
        for (const ex of s.examples) lines.push(`         z.B. ${ex}`);
      }
      lines.push('');
    }

    lines.push('--- Kategorien im Log ---');
    for (const c of result.categories.slice(0, 25)) {
      // Typ erkannt, Daten gelesen - zwei getrennte Haken.
      const mark = c.imported
        ? '[übernommen]'
        : (/^Trades? \//.test(c.key) ? '[Trade-Teil]' : (c.classified ? '[Typ ok]    ' : '[unbekannt] '));
      lines.push(`${String(c.count).padStart(4)} x  ${mark} ${c.key}`);
    }

    // Ein Rohbeispiel je Grund reichte nicht: 80 uebersprungene Eintraege aus
    // fuenfzehn verschiedenen Titeln teilten sich eins, und die Form der
    // uebrigen blieb unsichtbar. Deshalb je Titel eins.
    const unresolved = result.categories
      .filter((c) => !c.imported && !/^Trades? \//.test(c.key))
      .slice(0, 8);
    for (const c of unresolved) {
      lines.push('');
      lines.push(`--- Rohbeispiel: ${c.key} (${c.count}x) ---`);
      lines.push(JSON.stringify(c.sample, null, 2).slice(0, 600));
    }
    const restlich = result.categories.filter((c) => !c.imported && !/^Trades? \//.test(c.key)).length;
    if (restlich > unresolved.length) {
      lines.push('');
      lines.push(`(weitere ${restlich - unresolved.length} Titel ohne Beispiel)`);
    }

    report.hidden = false;
    report.textContent = lines.join('\n');
    // Der Knopf haengt an allem, was buchbar ist - nicht nur an den direkten
    // Eintraegen. Wer nur ueber Trades handelt, konnte sonst nichts uebernehmen.
    document.getElementById('applyImportBtn').disabled = pendingImport.length === 0;
    const teile = [];
    if (pendingImport.length) teile.push(`${pendingImport.length} Vorgänge zum Übernehmen`);
    if (merged.added) teile.push(`${merged.added} neue Angebote`);
    if (merged.updated) teile.push(`${merged.updated} Angebote mit neuem Status`);
    if (!quiet) {
      setStatus(
        teile.length
          ? `${teile.join(', ')}.`
          : 'Nichts erkannt. Der Bericht zeigt, welche Kategorien dein Log enthält.',
        teile.length ? 'ok' : 'error',
      );
    }
  } catch (err) {
    report.hidden = false;
    report.textContent = err instanceof TornLogError
      ? `Torn-Fehler ${err.code}: ${err.message}`
      : String(err.message || err);
    setStatus('Import fehlgeschlagen — Details im Bericht.', 'error');
  } finally {
    btn.disabled = false;
  }
}

/**
 * Ein Knopf fuer den ganzen Weg: Kurse, Log lesen, uebernehmen.
 *
 * Der ausfuehrliche Bericht entsteht dabei weiterhin - er steht im Panel
 * darunter, falls etwas fehlt. Hier oben steht nur das Ergebnis.
 */
async function syncNow({ silent = false } = {}) {
  const btn = document.getElementById('syncBtn');
  const msg = document.getElementById('syncMsg');
  const settings = loadSettings();

  btn.disabled = true;
  try {
    const priceState = await loadPrices();
    fillItemList();

    if (!settings.tornKey) {
      // Ohne Key laesst sich der Log nicht lesen - bewerten geht trotzdem.
      render();
      msg.textContent = priceState.from === 'error'
        ? 'Kein Torn-Key hinterlegt, und die Kurse waren nicht erreichbar.'
        : 'Kurse aktualisiert. Für den Log-Import fehlt der Torn-Key — siehe Import-Panel.';
      if (!silent) document.getElementById('importPanel').open = true;
      return;
    }

    msg.textContent = 'Lese Torn-Log…';
    await importFromLog({ quiet: true });

    const before = events.length;
    if (pendingImport.length) applyImport({ quiet: true });
    const added = events.length - before;

    render();
    const stamp = new Date().toLocaleTimeString('de-DE');
    msg.textContent = `${stamp}: ${added} neue Vorgänge, ${offers.length} Angebote bekannt.`
      + (priceState.from === 'error' ? ' Kurse waren nicht erreichbar.' : '');
  } catch (err) {
    msg.textContent = `Aktualisieren fehlgeschlagen: ${err.message}`;
  } finally {
    btn.disabled = false;
  }
}

function applyImport({ quiet = false } = {}) {
  const { added, duplicates, invalid } = addEvents(pendingImport);
  pendingImport = [];
  document.getElementById('applyImportBtn').disabled = true;
  reload();
  if (quiet) return;
  setStatus(
    `${added} übernommen, ${duplicates} bereits vorhanden${invalid ? `, ${invalid} unbrauchbar` : ''}.`,
    'ok',
  );
}

/**
 * Traegt Namen bei bereits gespeicherten Eintraegen nach, die noch als
 * "Item 206" drin stehen - etwa aus einem Import, bei dem der Katalog nicht
 * erreichbar war.
 */
function backfillNames(itemNames) {
  if (!itemNames.size) return 0;
  let changed = 0;
  const updated = loadEvents().map((e) => {
    const name = itemNames.get(e.itemId);
    if (name && /^Item \d+$/.test(e.itemName)) {
      changed += 1;
      return { ...e, itemName: name };
    }
    return e;
  });
  if (changed) {
    saveEvents(updated);
    events = updated;
  }
  return changed;
}

// ---------- Manuell, Sicherung ----------

/** Datum eines Ereignisses im Format des date-Feldes. */
function dateInputValue(ts) {
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function manualForm() {
  return {
    kind: document.getElementById('mKind'),
    item: document.getElementById('mItem'),
    quantity: document.getElementById('mQuantity'),
    unitPrice: document.getElementById('mUnitPrice'),
    date: document.getElementById('mDate'),
    submit: document.getElementById('addManualBtn'),
    cancel: document.getElementById('cancelEditBtn'),
    msg: document.getElementById('manualMsg'),
    summary: document.getElementById('manualSummary'),
  };
}

/** Zurueck aus dem Bearbeiten-Modus ins Anlegen. */
function stopEditing() {
  const f = manualForm();
  editingId = null;
  f.submit.textContent = 'Eintrag anlegen';
  f.cancel.hidden = true;
  f.summary.textContent = 'Eintrag von Hand erfassen';
  f.item.value = '';
  f.unitPrice.value = '';
  f.quantity.value = '1';
  f.msg.textContent = '';
  showItemHint();
}

/**
 * Laedt einen vorhandenen Eintrag ins Formular.
 *
 * Ein Zahlendreher im Preis war bisher nur ueber Loeschen und Neuanlegen zu
 * beheben - und dabei verliert ein importierter Vorgang seine Referenz und
 * kommt beim naechsten Import erneut herein.
 */
function startEditing(id) {
  const event = events.find((e) => e.id === id);
  if (!event) return;

  const f = manualForm();
  editingId = id;
  f.kind.value = event.kind;
  f.item.value = event.itemName && !/^Item \d+$/.test(event.itemName)
    ? event.itemName
    : String(event.itemId);
  f.quantity.value = String(event.quantity);
  f.unitPrice.value = String(event.unitPrice);
  f.date.value = dateInputValue(event.ts);

  f.submit.textContent = 'Änderung speichern';
  f.cancel.hidden = false;
  f.summary.textContent = `Eintrag ändern: ${event.itemName}`;
  f.msg.textContent = event.source === 'torn-log'
    ? 'Aus dem Torn-Log importiert — deine Änderung bleibt beim nächsten Import erhalten.'
    : '';

  document.getElementById('manualPanel').open = true;
  document.getElementById('manualPanel').scrollIntoView({ block: 'center' });
  showItemHint();
}

function readManualForm() {
  const f = manualForm();
  const hit = resolveItem(f.item.value);
  if (!hit) return { error: 'Item nicht erkannt — Name aus der Liste wählen oder Item-ID eintippen.' };

  const dateValue = f.date.value;
  return {
    fields: {
      ts: dateValue ? new Date(`${dateValue}T12:00:00`).getTime() : Date.now(),
      kind: f.kind.value,
      itemId: hit.itemId,
      itemName: hit.itemName,
      quantity: Number(f.quantity.value),
      unitPrice: Number(f.unitPrice.value),
    },
  };
}

function submitManual() {
  const f = manualForm();
  const { fields, error } = readManualForm();
  if (error) {
    f.msg.textContent = error;
    return;
  }

  if (editingId) {
    const { changed } = updateEvent(editingId, fields);
    if (!changed) {
      f.msg.textContent = 'Menge und Preis müssen gesetzt sein.';
      return;
    }
    stopEditing();
    reload();
    setStatus('Eintrag geändert.', 'ok');
    return;
  }

  const { added, invalid } = addEvents([makeEvent({ ...fields, source: 'manual' })]);
  if (added) {
    f.item.value = '';
    f.unitPrice.value = '';
    f.msg.textContent = 'Angelegt.';
    showItemHint();
    reload();
  } else {
    f.msg.textContent = invalid
      ? 'Menge und Preis müssen gesetzt sein.'
      : 'Eintrag existiert bereits.';
  }
}

function download(filename, text) {
  const blob = new Blob([text], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function exportLedger() {
  const json = exportJson(events);
  const stamp = new Date().toISOString().slice(0, 10);
  download(`ledger-${stamp}.json`, json);
  markExported();
  render();
  setStatus(`${events.length} Einträge exportiert.`, 'ok');
}

function applyPastedJson() {
  const msg = document.getElementById('backupMsg');
  try {
    const incoming = parseImport(document.getElementById('importText').value);
    const { added, duplicates } = addEvents(incoming);
    document.getElementById('importText').value = '';
    reload();
    msg.textContent = `${added} übernommen, ${duplicates} bereits vorhanden.`;
  } catch (err) {
    msg.textContent = err.message;
  }
}

function init() {
  showVersion();
  fillPeriods(loadSettings().ledgerPeriod);
  document.getElementById('periodSelect').addEventListener('change', () => {
    // Merken, sonst steht nach jedem Neuladen wieder "Gesamt" da.
    saveSettings({ ...loadSettings(), ledgerPeriod: currentPeriod() });
    render();
  });
  document.getElementById('saveKeyBtn').addEventListener('click', saveKey);
  document.getElementById('clearKeyBtn').addEventListener('click', () => {
    document.getElementById('ledgerTornKey').value = '';
    saveKey();
  });
  document.getElementById('importLogBtn').addEventListener('click', () => importFromLog());
  document.getElementById('applyImportBtn').addEventListener('click', () => applyImport());
  document.getElementById('syncBtn').addEventListener('click', () => syncNow());
  document.getElementById('buyerCheckBtn').addEventListener('click', checkBuyers);
  document.getElementById('addManualBtn').addEventListener('click', submitManual);
  document.getElementById('cancelEditBtn').addEventListener('click', stopEditing);
  document.getElementById('mItem').addEventListener('input', showItemHint);
  document.getElementById('mItem').addEventListener('change', showItemHint);

  const auto = document.getElementById('ledgerAutoImport');
  auto.checked = Boolean(loadSettings().ledgerAutoImport);
  auto.addEventListener('change', () => {
    saveSettings({ ...loadSettings(), ledgerAutoImport: auto.checked });
    setStatus(auto.checked
      ? 'Wird beim Öffnen der Seite automatisch aktualisiert.'
      : 'Automatisches Aktualisieren aus.', 'ok');
  });
  document.getElementById('exportBtn').addEventListener('click', exportLedger);
  document.getElementById('applyTextBtn').addEventListener('click', applyPastedJson);
  document.getElementById('importFileBtn').addEventListener('click', () => {
    document.getElementById('importText').focus();
  });

  document.getElementById('clearBtn').addEventListener('click', () => {
    if (!confirm(`${events.length} Einträge unwiderruflich löschen? Vorher exportieren?`)) return;
    clearLedger();
    reload();
    setStatus('Ledger geleert.', 'ok');
  });

  // Aendern und Loeschen laufen ueber Delegation, weil die Tabellen bei jeder
  // Aenderung neu gebaut werden.
  const rowActions = (ev) => {
    const editId = ev.target?.dataset?.edit;
    if (editId) {
      startEditing(editId);
      return;
    }
    const delId = ev.target?.dataset?.del;
    if (!delId) return;
    const event = events.find((e) => e.id === delId);
    if (event && !confirm(`${event.kind === 'buy' ? 'Kauf' : 'Verkauf'} von `
      + `${event.quantity}× ${event.itemName} löschen?`)) return;
    if (editingId === delId) stopEditing();
    events = removeEvent(delId);
    render();
    setStatus('Eintrag gelöscht.', 'ok');
  };
  document.getElementById('openTable').addEventListener('click', rowActions);
  document.getElementById('salesTable').addEventListener('click', rowActions);

  document.getElementById('offerFilter').addEventListener('change', renderOffers);

  // Notiz und Loeschen laufen ueber Delegation, weil die Tabelle bei jeder
  // Aenderung neu gebaut wird.
  document.getElementById('offerTable').addEventListener('click', (ev) => {
    const noteId = ev.target?.dataset?.note;
    if (noteId) {
      const current = offers.find((o) => String(o.tradeId) === noteId);
      const text = prompt('Notiz zu diesem Angebot:', current?.note || '');
      if (text === null) return;
      offers = setNote(noteId, text);
      renderOffers();
      return;
    }
    const dropId = ev.target?.dataset?.drop;
    if (dropId) {
      offers = removeOffer(dropId);
      renderOffers();
      setStatus('Angebot entfernt.', 'ok');
    }
  });

  renderKeyState();
  reload();

  // Bei leerem Ledger fuehren sonst vier Null-Kacheln und zwei leere Tabellen,
  // bevor man ueberhaupt zum Einrichten kommt. Danach zaehlt, wie der Nutzer
  // die Kaesten zuletzt stehen liess.
  restorePanels({ page: 'ledger', defaults: { importPanel: events.length === 0 } });

  // Kurse aus dem Zwischenspeicher kosten nichts und fuellen sofort die
  // Wertspalten. Nur wenn nichts Frisches dasteht, geht ein Request raus -
  // und auch das nur, wenn ueberhaupt Bestand da ist oder von Hand erfasst
  // werden koennte.
  const settings = loadSettings();
  if (settings.ledgerAutoImport && settings.tornKey) {
    syncNow({ silent: true });
  } else {
    loadPrices().then(() => {
      fillItemList();
      showItemHint();
      render();
    });
  }
}

init();
