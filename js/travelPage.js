// Verdrahtung der Flugseite.

import { loadSettings, saveSettings } from './storage.js?v=10';
import { fetchMarketplace } from './weav3r.js?v=10';
import {
  fetchTravelStocks, parseTravelExport, travelUrl, YataError, YATA_URL,
} from './yata.js?v=10';
import {
  COUNTRIES, AIRSTRIPS, countryName, oneWayMinutes, planTrips, planCountry,
} from './travel.js?v=10';
import {
  loadStock, saveStock, recordSnapshot, seriesFor, predict, estimate,
  chanceAtLeast, backtest,
} from './travelStock.js?v=10';
import { priceMap, readPriceCache, writePriceCache } from './valuation.js?v=10';
import { renderTable } from './table.js?v=10';
import { fmtMoney, fmtPct, setStatus, escapeHtml, showVersion } from './ui.js?v=10';

let prices = new Map();
let stocks = new Map();      // code -> [{itemId, itemName, cost, quantity}]
let updated = new Map();     // code -> Zeitstempel der YATA-Daten
let observations = {};       // Messreihen je Land und Item

const fmtUnits = new Intl.NumberFormat('de-DE');
const fmtMinutes = (m) => (m === null || m === undefined
  ? '—'
  : (m < 60 ? `${Math.round(m)} min` : `${Math.floor(m / 60)}:${String(Math.round(m % 60)).padStart(2, '0')} h`));

function settings() {
  return loadSettings();
}

// ---------- Vorhersage ----------

/** Vorrat bei Landung, mit Bereich und Chance auf die eigene Kapazitaet. */
function arrival(code, item, minutes) {
  const series = seriesFor(observations, code, item.itemId);
  const p = predict(series, minutes ?? 0);
  const needed = Math.max(1, Number(settings().travelCapacity) || 1);
  return {
    ...p,
    needed,
    chance: chanceAtLeast(series, Math.min(needed, item.quantity ?? needed), minutes ?? 0),
    now: item.quantity,
  };
}

function confidenceTag(p) {
  if (p.confidence === 'unbekannt') return '<span class="tag">zu wenig Daten</span>';
  return `<span class="tag${p.confidence === 'grob' ? ' warn' : ''}">${escapeHtml(p.confidence)}</span>`;
}

/** "12–38" statt einer Zahl, die Genauigkeit vortaeuscht. */
function rangeText(p) {
  if (p.quantity === null) return '<span class="muted">?</span>';
  return p.low === p.high
    ? escapeHtml(fmtUnits.format(p.quantity))
    : `${escapeHtml(fmtUnits.format(p.low))}–${escapeHtml(fmtUnits.format(p.high))}`;
}

/**
 * Die eigentliche Auskunft: reicht es fuer die eigene Kapazitaet? Unter 50%
 * ist das eine Warnung wert - drei Stunden Flug fuer ein leeres Regal.
 */
function chanceTag(p) {
  if (p.chance === null || p.chance === undefined) return '';
  const pct = Math.round(p.chance * 100);
  return `<span class="tag${pct < 50 ? ' warn' : ''}">${pct}% für ${fmtUnits.format(p.needed)}</span>`;
}

// ---------- Tabellen ----------

const TRIP_COLUMNS = [
  { key: 'country', label: 'Ziel', align: 'left', cell: (t) => ({ text: t.name }) },
  { key: 'time', label: 'Rundflug', cell: (t) => ({ text: fmtMinutes(t.roundTripMinutes) }) },
  {
    key: 'item',
    label: 'Bestes Item',
    align: 'left',
    cell: (t) => ({ text: t.best ? t.best.itemName : '—' }),
  },
  { key: 'cost', label: 'Kauf dort', cell: (t) => ({ text: t.best ? fmtMoney(t.best.cost) : '—' }) },
  {
    key: 'unit',
    label: 'Profit/Stück',
    cell: (t) => (t.best
      ? { text: `${fmtMoney(t.best.profitPerUnit)} (${fmtPct(t.best.profitPct)})`, cls: 'pos' }
      : { text: '—' }),
  },
  {
    key: 'trip',
    label: 'Pro Flug',
    cell: (t) => (t.best
      ? {
        html: `${escapeHtml(fmtMoney(t.tripProfit))}<span class="tag">${t.best.units}× `
          + `${escapeHtml(t.best.limitedBy)}</span>`,
        cls: 'strong pos',
      }
      : { text: '—' }),
  },
  {
    key: 'perMinute',
    label: 'Pro Minute',
    cell: (t) => ({
      text: t.profitPerMinute === null ? '—' : fmtMoney(t.profitPerMinute),
      cls: 'strong',
    }),
  },
  {
    key: 'stock',
    label: 'Bei Landung',
    cell: (t) => {
      if (!t.best) return { text: '—' };
      const p = arrival(t.code, t.best, t.oneWayMinutes);
      const now = Number.isFinite(t.best.quantity) ? `${fmtUnits.format(t.best.quantity)} jetzt` : 'Vorrat unbekannt';
      return {
        html: rangeText(p) + chanceTag(p) + confidenceTag(p)
          + `<span class="tag">${escapeHtml(now)}</span>`,
      };
    },
  },
];

const ITEM_COLUMNS = [
  { key: 'item', label: 'Item', align: 'left', cell: (r) => ({ text: r.itemName }) },
  { key: 'cost', label: 'Kauf dort', cell: (r) => ({ text: fmtMoney(r.cost) }) },
  { key: 'market', label: 'Markt zuhause', cell: (r) => ({ text: r.marketPrice ? fmtMoney(r.marketPrice) : '—' }) },
  {
    key: 'unit',
    label: 'Profit/Stück',
    cell: (r) => ({
      text: r.profitPerUnit === null ? '—' : fmtMoney(r.profitPerUnit),
      cls: r.profitPerUnit >= 0 ? 'pos' : 'neg',
    }),
  },
  { key: 'trip', label: 'Pro Flug', cell: (r) => ({ text: fmtMoney(r.tripProfit), cls: 'strong' }) },
  {
    key: 'stock',
    label: 'Vorrat',
    cell: (r) => ({ text: Number.isFinite(r.quantity) ? fmtUnits.format(r.quantity) : '—' }),
  },
];

const STAT_COLUMNS = [
  { key: 'what', label: 'Item', align: 'left', cell: (r) => ({ text: `${countryName(r.code)} · ${r.itemName}` }) },
  { key: 'samples', label: 'Messungen', cell: (r) => ({ text: fmtUnits.format(r.e.samples) }) },
  {
    key: 'drain',
    label: 'Abverkauf',
    cell: (r) => ({ text: r.e.drainPerMinute ? `${r.e.drainPerMinute.toFixed(1)}/min` : '—' }),
  },
  {
    key: 'restock',
    label: 'Nachschub',
    cell: (r) => ({
      text: r.e.restockAmount
        ? `${fmtUnits.format(Math.round(r.e.restockAmount))} alle ${r.e.restockIntervalMinutes
          ? `${Math.round(r.e.restockIntervalMinutes)} min` : '?'}`
        : '—',
    }),
  },
  {
    key: 'error',
    // Die Zahl, an der sich das Modell messen lassen muss: um wieviel lagen
    // seine eigenen Vorhersagen daneben, gegen die spaeter gemessene Menge?
    label: 'Fehler',
    cell: (r) => (r.a.checks
      ? {
        text: `±${fmtUnits.format(Math.round(r.a.medianAbsError))} (${r.a.checks}×)`,
        cls: r.a.medianAbsError > Math.max(5, r.e.latest * 0.25) ? 'warn-text' : '',
      }
      : { text: 'noch ungeprüft' }),
  },
  {
    key: 'coverage',
    // Wie oft der angegebene Bereich den spaeter gemessenen Wert enthielt.
    // Unter der Haelfte heisst: die Vorhersage ist eine Richtung, kein Wert.
    label: 'Bereich traf',
    cell: (r) => (r.a.coverage === null ? { text: '—' } : { text: fmtPct(r.a.coverage * 100) }),
  },
];

// ---------- Aufbau ----------

function tile(label, value, sub = '', cls = '') {
  return `<div class="tile">
    <div class="label">${escapeHtml(label)}</div>
    <div class="value ${cls}">${value}</div>
    ${sub ? `<div class="sub">${escapeHtml(sub)}</div>` : ''}
  </div>`;
}

function render() {
  const s = settings();
  const trips = planTrips(stocks, prices, s);
  const withProfit = trips.filter((t) => t.profitPerMinute !== null && t.profitPerMinute > 0);

  const best = withProfit[0] || null;
  const parts = [
    tile('Bestes Ziel', best ? escapeHtml(best.name) : '—',
      best ? `${fmtMoney(best.profitPerMinute)} pro Minute` : 'keine Vorräte geladen'),
    tile('Pro Flug', best ? fmtMoney(best.tripProfit) : '—',
      best ? `${best.best.units}× ${best.best.itemName}` : '', 'pos'),
    tile('Rundflug', best ? fmtMinutes(best.roundTripMinutes) : '—',
      best ? `einfach ${fmtMinutes(best.oneWayMinutes)}` : ''),
    tile('Einsatz', best ? fmtMoney(best.best.spend) : '—',
      best ? `begrenzt durch ${best.best.limitedBy}` : ''),
  ];
  document.getElementById('tiles').innerHTML = parts.join('');

  renderTable('tripTable', TRIP_COLUMNS, withProfit, {
    empty: stocks.size
      ? 'Kein Ziel mit Gewinn — Preise geladen, aber nichts lohnt sich gerade.'
      : 'Noch keine Vorräte. „Vorräte laden" holt sie von YATA, oder trag unten ein, was du siehst.',
  });
  document.getElementById('tripCount').textContent = String(withProfit.length);

  renderDetail();
  renderStats();
}

function renderDetail() {
  const code = document.getElementById('countrySelect').value;
  const items = stocks.get(code) || [];
  const plan = planCountry(code, items, prices, settings());
  renderTable('itemTable', ITEM_COLUMNS, plan.items, { empty: 'Für dieses Land nichts erfasst.' });
}

function renderStats() {
  const rows = [];
  for (const key of Object.keys(observations)) {
    const [code, id] = key.split(':');
    const e = estimate(observations[key]);
    if (e.samples < 2) continue;
    const itemId = Number(id);
    const name = (stocks.get(code) || []).find((i) => i.itemId === itemId)?.itemName
      || prices.get(itemId)?.itemName
      || `Item ${itemId}`;
    rows.push({ code, itemId, itemName: name, e, a: backtest(observations[key]) });
  }
  rows.sort((a, b) => b.e.samples - a.e.samples);
  renderTable('statsTable', STAT_COLUMNS, rows, {
    empty: 'Noch keine Reihe mit mehr als einer Messung.',
  });
  // Die Selbstkontrolle über alle Reihen: eine Zahl, an der man sieht, ob man
  // der Vorhersage überhaupt trauen darf.
  const geprueft = rows.filter((r) => r.a.checks);
  const checks = geprueft.reduce((s, r) => s + r.a.checks, 0);
  const fehler = geprueft.length
    ? geprueft.reduce((s, r) => s + r.a.medianAbsError, 0) / geprueft.length
    : null;

  document.getElementById('statsHint').textContent = rows.length
    ? 'Aus diesen Reihen entsteht die Vorhersage. Die Spalte „Fehler" prüft sie gegen sich '
      + 'selbst: aus dem Anfang der Reihe vorhersagen, mit dem nächsten echten Wert vergleichen.'
      + (checks
        ? ` Bisher ${checks} Kontrollen, im Schnitt ${Math.round(fehler)} Stück daneben.`
        : ' Ab der dritten Messung je Reihe beginnt das.')
    : 'Jedes Laden der Vorräte und jede Eingabe von Hand legt hier eine Messung ab.';
}

// ---------- Daten ----------

async function loadPrices() {
  const cached = readPriceCache();
  if (cached) {
    prices = cached.prices;
    return;
  }
  try {
    const { items } = await fetchMarketplace(settings());
    prices = priceMap(items);
    writePriceCache(items);
  } catch (err) {
    console.warn('Marktpreise nicht geladen:', err.message);
  }
}

function fillItemList() {
  const list = document.getElementById('itemList');
  const seen = new Map();
  for (const items of stocks.values()) {
    for (const i of items) seen.set(i.itemId, i.itemName);
  }
  list.innerHTML = [...seen.values()].map((n) => `<option value="${escapeHtml(n)}"></option>`).join('');
}

/**
 * Uebernimmt einen gelesenen Export - egal ob er ueber das Netz kam oder aus
 * der Zwischenablage. Beides fuehrt durch denselben Parser, damit ein
 * eingefuegter Stand exakt so gerechnet wird wie ein abgerufener.
 */
function applyExport({ countries, updated: stamps, unknown }, quelle) {
  stocks = countries;
  updated = stamps;

  // Jede Uebernahme ist zugleich eine Messung - so entsteht die Reihe, aus
  // der spaeter die Vorhersage kommt, ohne dass jemand etwas eintippen muss.
  for (const [code, items] of countries) {
    observations = recordSnapshot(observations, code, items, stamps.get(code) || Date.now());
  }
  saveStock(observations);

  fillItemList();
  render();

  const newest = [...updated.values()].sort((a, b) => b - a)[0];
  document.getElementById('sourceMsg').textContent = `${countries.size} Länder ${quelle}`
    + (newest ? `, Stand ${new Date(newest).toLocaleTimeString('de-DE')}` : '')
    + (unknown.length ? `, nicht zugeordnet: ${unknown.join(', ')}` : '');
}

function applyPasted() {
  const msg = document.getElementById('pasteMsg');
  const text = document.getElementById('pasteJson').value.trim();
  if (!text) {
    msg.textContent = 'Nichts eingefügt.';
    return;
  }

  let data;
  try {
    data = JSON.parse(text);
  } catch (err) {
    msg.textContent = `Kein gültiges JSON: ${err.message}`;
    return;
  }

  const parsed = parseTravelExport(data);
  if (!parsed.countries.size) {
    // Die Schluessel zu nennen ist hier das Wertvollste: daran laesst sich
    // ablesen, welche Form die Antwort wirklich hat.
    msg.textContent = 'Kein Land erkannt.'
      + (parsed.unknown.length ? ` Gefundene Schlüssel: ${parsed.unknown.slice(0, 8).join(', ')}` : '');
    return;
  }

  applyExport(parsed, 'aus der Zwischenablage');
  document.getElementById('pasteJson').value = '';
  msg.textContent = `${parsed.countries.size} Länder übernommen.`;
  setStatus('Vorräte aus der Zwischenablage übernommen.', 'ok');
}

async function refresh() {
  const btn = document.getElementById('refreshBtn');
  const msg = document.getElementById('sourceMsg');
  btn.disabled = true;
  setStatus('Lade Marktpreise und Vorräte…');

  try {
    await loadPrices();
    applyExport(await fetchTravelStocks({ settings: settings() }), 'von yata.yt');
    setStatus('Vorräte geladen.', 'ok');
  } catch (err) {
    // Der wahrscheinlichste Fall, und deshalb kein Abbruch: Preise und Zeiten
    // stehen, von Hand erfasste Vorraete auch. Nur die fremde Quelle fehlt.
    msg.textContent = err instanceof YataError ? err.message : String(err.message || err);
    // Der Weg ueber die Zwischenablage steht genau dafuer bereit - also
    // aufklappen statt nur davon zu schreiben.
    document.getElementById('sourcePanel').open = true;
    render();
    setStatus('Vorräte nicht geladen — Quelle prüfen oder Antwort einfügen.', 'error');
  } finally {
    btn.disabled = false;
  }
}

// ---------- Von Hand ----------

function resolveItem(text) {
  const wanted = String(text || '').trim().toLowerCase();
  if (!wanted) return null;
  if (/^\d+$/.test(wanted)) {
    const id = Number(wanted);
    return { itemId: id, itemName: prices.get(id)?.itemName || `Item ${id}` };
  }
  for (const items of stocks.values()) {
    const hit = items.find((i) => String(i.itemName).toLowerCase() === wanted);
    if (hit) return { itemId: hit.itemId, itemName: hit.itemName };
  }
  for (const [itemId, p] of prices) {
    if (String(p.itemName || '').toLowerCase() === wanted) return { itemId, itemName: p.itemName };
  }
  return null;
}

function addManualStock() {
  const msg = document.getElementById('manualMsg');
  const code = document.getElementById('mCountry').value;
  const hit = resolveItem(document.getElementById('mItem').value);
  const quantity = Number(document.getElementById('mQuantity').value);
  const cost = Number(document.getElementById('mCost').value);

  if (!hit) {
    msg.textContent = 'Item nicht erkannt — Name aus der Liste oder Item-ID.';
    return;
  }
  if (!Number.isFinite(quantity) || quantity < 0) {
    msg.textContent = 'Vorrat als Zahl eintragen, 0 ist erlaubt.';
    return;
  }

  const existing = stocks.get(code) || [];
  const item = {
    itemId: hit.itemId,
    itemName: hit.itemName,
    quantity,
    cost: cost > 0 ? cost : existing.find((i) => i.itemId === hit.itemId)?.cost || 0,
  };
  if (!item.cost) {
    msg.textContent = 'Preis im Shop fehlt — einmal eintragen, danach merkt die App ihn.';
    return;
  }

  stocks.set(code, [...existing.filter((i) => i.itemId !== hit.itemId), item]);
  observations = saveStock(recordSnapshot(observations, code, [item]));

  fillItemList();
  render();
  msg.textContent = `${item.itemName} in ${countryName(code)}: ${fmtUnits.format(quantity)} Stück notiert.`;
}

// ---------- Reisezeiten ----------

function renderTimeGrid() {
  const s = settings();
  document.getElementById('timeGrid').innerHTML = COUNTRIES.map((c) => `
    <label class="field">${escapeHtml(c.name)}
      <input type="number" id="time-${c.code}" min="1" max="600" step="1" inputmode="numeric"
        placeholder="${Math.round(oneWayMinutes(c.code, { ...s, travelTimes: {} }))}"
        value="${s.travelTimes?.[c.code] ?? ''}">
      <span class="hint">Standard ${c.minutes} min, einfach</span>
    </label>`).join('');
}

function saveTimes() {
  const travelTimes = {};
  for (const c of COUNTRIES) {
    const value = Number(document.getElementById(`time-${c.code}`).value);
    if (Number.isFinite(value) && value > 0) travelTimes[c.code] = value;
  }
  saveSettings({ ...settings(), travelTimes });
  render();
  document.getElementById('timeMsg').textContent = Object.keys(travelTimes).length
    ? `${Object.keys(travelTimes).length} eigene Zeiten gespeichert.`
    : 'Keine eigenen Zeiten — es gilt die Tabelle.';
}

function init() {
  showVersion();
  const s = settings();

  document.getElementById('travelCapacity').value = s.travelCapacity;
  document.getElementById('travelAirstrip').innerHTML = AIRSTRIPS
    .map((a) => `<option value="${a.key}">${escapeHtml(a.label)}</option>`).join('');
  document.getElementById('travelAirstrip').value = s.travelAirstrip;

  const countryOptions = COUNTRIES
    .map((c) => `<option value="${c.code}">${escapeHtml(c.name)}</option>`).join('');
  document.getElementById('countrySelect').innerHTML = countryOptions;
  document.getElementById('mCountry').innerHTML = countryOptions;

  observations = loadStock();
  renderTimeGrid();

  document.getElementById('travelCapacity').addEventListener('change', () => {
    saveSettings({ ...settings(), travelCapacity: Number(document.getElementById('travelCapacity').value) || 1 });
    render();
  });
  document.getElementById('travelAirstrip').addEventListener('change', () => {
    saveSettings({ ...settings(), travelAirstrip: document.getElementById('travelAirstrip').value });
    renderTimeGrid();
    render();
  });
  document.getElementById('refreshBtn').addEventListener('click', refresh);

  document.getElementById('yataUrl').value = s.yataUrl || YATA_URL;
  document.getElementById('saveSourceBtn').addEventListener('click', () => {
    const eingabe = document.getElementById('yataUrl').value.trim() || YATA_URL;
    const saveMsg = document.getElementById('sourceSaveMsg');
    let url;
    try {
      // Vor dem Speichern pruefen: eine Adresse, die die CSP ohnehin blockt,
      // waere spaeter nur ein rätselhafter Netzwerkfehler.
      url = String(travelUrl({ yataUrl: eingabe }));
    } catch (err) {
      saveMsg.textContent = err.message;
      return;
    }
    saveSettings({ ...settings(), yataUrl: url });
    document.getElementById('yataUrl').value = url;
    saveMsg.textContent = url === eingabe
      ? 'Adresse gespeichert.'
      : 'Gespeichert, ohne Parameter — sonst am Zwischenspeicher von YATA vorbei.';
  });
  document.getElementById('openSourceBtn').addEventListener('click', () => {
    window.open(String(travelUrl({ yataUrl: settings().yataUrl })), '_blank', 'noopener');
  });
  document.getElementById('applyPasteBtn').addEventListener('click', applyPasted);
  document.getElementById('countrySelect').addEventListener('change', renderDetail);
  document.getElementById('addStockBtn').addEventListener('click', addManualStock);
  document.getElementById('saveTimesBtn').addEventListener('click', saveTimes);
  document.getElementById('resetTimesBtn').addEventListener('click', () => {
    saveSettings({ ...settings(), travelTimes: {} });
    renderTimeGrid();
    render();
    document.getElementById('timeMsg').textContent = 'Zurück auf die Tabelle.';
  });
  document.getElementById('clearStockBtn').addEventListener('click', () => {
    if (!confirm('Alle Beobachtungen löschen? Die Vorhersage fängt dann von vorn an.')) return;
    observations = saveStock({});
    render();
    setStatus('Beobachtungen gelöscht.', 'ok');
  });

  loadPrices().then(() => {
    fillItemList();
    render();
  });
  render();
}

init();
