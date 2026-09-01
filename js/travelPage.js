// Verdrahtung der Flugseite.

import { loadSettings, saveSettings } from './storage.js?v=17';
import { fetchMarketplace } from './weav3r.js?v=17';
import {
  fetchTravelStocks, parseTravelExport, travelUrl, YataError, YATA_URL,
} from './yata.js?v=17';
import {
  COUNTRIES, AIRSTRIPS, countryName, oneWayMinutes, planTrips, planCountry,
} from './travel.js?v=17';
import {
  loadStock, saveStock, recordSnapshot, seriesFor, predict, estimate,
  chanceAtLeast, backtest, restockInfo, mergeStock,
} from './travelStock.js?v=17';
import { inStockWindows, windowRate, recentRestocks, hourProfile } from './restock.js?v=17';
import { capacityFromPerks, flyMethodKey, BASE_CAPACITY } from './capacity.js?v=17';
import { fetchTravel, fetchPerks, TornApiError } from './torn.js?v=17';
import { priceMap, readPriceCache, writePriceCache } from './valuation.js?v=17';
import { renderTable } from './table.js?v=17';
import { fmtMoney, fmtPct, setStatus, escapeHtml, showVersion } from './ui.js?v=17';
import { restorePanels } from './panels.js?v=17';

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

const clock = new Intl.DateTimeFormat('de-DE', { hour: '2-digit', minute: '2-digit' });
const fmtClock = (ts) => clock.format(new Date(ts));

/** "in 42 min" oder "vor 8 min" - naeher am Denken als eine Uhrzeit allein. */
function relative(ts, now = Date.now()) {
  const minutes = Math.round((ts - now) / 60000);
  // "in 0 min" stand vorher an jeder frischen Messung: mit einem Sammler, der
  // durchlaeuft, ist gerade gemessen der Normalfall und nicht die Ausnahme.
  if (minutes === 0) return 'gerade eben';
  if (minutes > 0) return `in ${fmtMinutes(minutes)}`;
  return `vor ${fmtMinutes(-minutes)}`;
}

/**
 * Wann losfliegen, um zum Nachschub zu landen?
 *
 * Das ist beim Item-Running die eigentliche Entscheidung: nicht wieviel jetzt
 * dasteht, sondern wann man starten muss, damit man ankommt, wenn das Regal
 * gerade wieder voll ist.
 */
function departure(restock, oneWayMinutes, now = Date.now()) {
  if (!restock || !Number.isFinite(oneWayMinutes)) return null;
  const minutes = (restock.at - now) / 60000 - oneWayMinutes;
  return { minutes, at: now + minutes * 60000, late: minutes < 0 };
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
    key: 'restock',
    label: 'Nächster Nachschub',
    cell: (t) => {
      if (!t.best) return { text: '—' };
      const p = arrival(t.code, t.best, t.oneWayMinutes);
      if (!p.restock) {
        // Ohne beobachteten Zyklus gibt es keinen Timer - und ohne Timer
        // waere jede Zeitangabe erfunden.
        return {
          html: '<span class="muted">unbekannt</span>'
            + (p.cycles ? '' : '<span class="tag">noch kein Ausverkauf gesehen</span>'),
        };
      }
      const spanne = Math.round((p.restock.to - p.restock.from) / 120000);
      return {
        html: `${escapeHtml(fmtClock(p.restock.at))}`
          + `<span class="tag">${escapeHtml(relative(p.restock.at))}</span>`
          + (spanne > 0 ? `<span class="tag">±${spanne} min</span>` : '')
          + (p.restock.waiting ? '<span class="tag ok">Timer läuft</span>' : ''),
      };
    },
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
    cell: (r) => ({
      html: (Number.isFinite(r.quantity) ? escapeHtml(fmtUnits.format(r.quantity)) : '—')
        + (Number.isFinite(r.expectedQuantity)
          ? `<span class="tag">${escapeHtml(fmtUnits.format(r.expectedQuantity))} bei Landung</span>`
          : ''),
    }),
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
    key: 'timer',
    label: 'Timer',
    // Die Zahl, um die es geht: wie lange es vom Ausverkauf bis zum Nachschub
    // dauert - und wie genau das inzwischen bekannt ist.
    cell: (r) => (r.timer
      ? {
        text: `${Math.round(r.timer.low)}–${Math.round(r.timer.high)} min`,
        cls: r.timer.method === 'median' ? 'warn-text' : '',
      }
      : { text: r.cycles ? 'Zyklus läuft noch' : 'kein Ausverkauf gesehen' }),
  },
  {
    key: 'cycles',
    label: 'Zyklen',
    cell: (r) => ({ text: r.timer ? fmtUnits.format(r.timer.cycles) : '0' }),
  },
  {
    key: 'model',
    // Nachvollziehbar statt Blackbox: welches Modell diese Reihe gerade
    // erklaert, und ob es ueberhaupt schon gemessen wurde.
    label: 'Modell',
    align: 'left',
    cell: (r) => ({ text: r.a.model ? r.a.model.label : 'noch keins geprüft' }),
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

/**
 * Setzt in jedes Item die bei der Landung erwartete Menge.
 *
 * Ohne diesen Schritt plant die Seite mit dem Stand von jetzt - und wirft
 * damit genau das Ziel weg, auf das man wartet: das leere Regal, dessen
 * Timer laeuft.
 */
function withForecast(s) {
  const out = new Map();
  for (const [code, items] of stocks) {
    const minutes = oneWayMinutes(code, s);
    out.set(code, items.map((item) => {
      const p = predict(seriesFor(observations, code, item.itemId), minutes ?? 0);
      return { ...item, expectedQuantity: p.quantity };
    }));
  }
  return out;
}

function render() {
  const s = settings();
  const forecast = withForecast(s);
  const trips = planTrips(forecast, prices, s);
  const withProfit = trips.filter((t) => t.profitPerMinute !== null && t.profitPerMinute > 0);

  const best = withProfit[0] || null;
  const parts = [
    tile('Bestes Ziel', best ? escapeHtml(best.name) : '—',
      best ? `${fmtMoney(best.profitPerMinute)} pro Minute` : 'keine Vorräte geladen'),
    tile('Pro Flug', best ? fmtMoney(best.tripProfit) : '—',
      best ? `${best.best.units}× ${best.best.itemName}` : '', 'pos'),
    (() => {
      // Die Kachel, die eine Handlung nennt: wann losfliegen, um zum
      // Nachschub anzukommen.
      const p = best ? arrival(best.code, best.best, best.oneWayMinutes) : null;
      const ab = p ? departure(p.restock, best.oneWayMinutes) : null;
      if (!ab) {
        return tile('Rundflug', best ? fmtMinutes(best.roundTripMinutes) : '—',
          best ? `einfach ${fmtMinutes(best.oneWayMinutes)}` : '');
      }
      return ab.late
        ? tile('Abflug', 'jetzt', `Nachschub ${relative(p.restock.at)} — du landest danach`)
        : tile('Abflug', relative(ab.at), `landet zum Nachschub um ${fmtClock(p.restock.at)}`);
    })(),
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
  fillItemSelect();
  if (document.getElementById('itemPanel').open) renderItemPanel();
}

function renderDetail() {
  const s = settings();
  const code = document.getElementById('countrySelect').value;
  const items = withForecast(s).get(code) || [];
  const plan = planCountry(code, items, prices, s);
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
    const info = restockInfo(observations[key]);
    rows.push({ code, itemId, itemName: name, e, a: backtest(observations[key]), ...info });
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
    ? 'Der Timer läuft ab dem Ausverkauf, ist je Item verschieden und wird aus den Zyklen '
      + 'eingegrenzt: jede Null-Strecke sagt „frühestens so lang, spätestens so lang", und '
      + 'mehrere Zyklen zusammen verengen das. Daneben treten vier Modelle für die Menge an; '
      + 'die Spalte „Fehler" ist das Maß dafür.'
      + (checks
        ? ` Bisher ${checks} Kontrollen, im Schnitt ${Math.round(fehler)} Stück daneben.`
        : ` Ab ${'vier'} Kontrollen je Reihe darf ein Modell den Standard ablösen.`)
    : 'Jedes Laden der Vorräte und jede Eingabe von Hand legt hier eine Messung ab.';
}

// ---------- Aus Torn übernehmen ----------

/**
 * Holt Flugart und Kapazitaet aus Torn, statt sie einstellen zu lassen.
 *
 * Beides braucht nur einen Minimal-Key. Angezeigt wird, was erkannt wurde -
 * eine Kapazitaet, die man nicht nachvollziehen kann, waere schlimmer als
 * eine, die man selbst eintraegt.
 */
async function takeFromTorn() {
  const btn = document.getElementById('fromTornBtn');
  const msg = document.getElementById('tornStateMsg');
  const s = settings();

  if (!s.tornKey) {
    msg.textContent = 'Kein Torn-Key hinterlegt — im Scanner unter Einstellungen eintragen. '
      + 'Für diese Abfrage genügt ein Minimal-Key.';
    return;
  }

  btn.disabled = true;
  msg.textContent = 'Frage Torn…';
  try {
    const [travel, perks] = await Promise.all([fetchTravel(s.tornKey), fetchPerks(s.tornKey)]);
    const method = flyMethodKey(travel?.method);
    const cap = capacityFromPerks(perks);

    const next = { ...settings(), travelCapacity: cap.total };
    if (method) next.travelAirstrip = method;
    saveSettings(next);

    document.getElementById('travelCapacity').value = String(cap.total);
    if (method) document.getElementById('travelAirstrip').value = method;
    renderTimeGrid();
    render();

    const teile = [
      `Kapazität ${cap.total} (${BASE_CAPACITY} Grundlage${cap.bonus ? ` + ${cap.bonus} aus Perks` : ''})`,
    ];
    teile.push(method
      ? `Flugart ${travel.method}`
      : `Flugart unbekannt (${travel?.method ?? 'noch nie geflogen'}) — Auswahl bleibt`);
    if (cap.matched.length) {
      teile.push(`erkannt: ${cap.matched.map((m) => `${m.text} [${m.source}]`).join('; ')}`);
    } else {
      teile.push('keine Reise-Perks erkannt — falls du welche hast, sag mir den Wortlaut');
    }
    msg.textContent = teile.join(' · ');
  } catch (err) {
    msg.textContent = err instanceof TornApiError
      ? `Torn-Fehler ${err.code}: ${err.message}`
      : String(err.message || err);
  } finally {
    btn.disabled = false;
  }
}

// ---------- Einzelnes Item ----------

const RESTOCK_COLUMNS = [
  { key: 'at', label: 'Nachschub', align: 'left', cell: (r) => ({ text: `${fmtClock(r.at)} · ${relative(r.at)}` }) },
  { key: 'outage', label: 'Leer', cell: (r) => ({ text: fmtMinutes(r.outageMinutes) }) },
  { key: 'amount', label: 'Menge', cell: (r) => ({ text: Number.isFinite(r.amount) ? fmtUnits.format(r.amount) : '—' }) },
  {
    key: 'sicher',
    label: 'Genauigkeit',
    // Die Luecke zwischen letzter Null und erster Messung mit Ware: so genau
    // ist der Zeitpunkt bekannt, mehr gibt die Messdichte nicht her.
    cell: (r) => ({ text: `±${Math.round(r.uncertaintyMinutes / 2)} min` }),
  },
];

const HOUR_COLUMNS = [
  { key: 'hour', label: 'Stunde', align: 'left', cell: (r) => ({ text: `${String(r.hour).padStart(2, '0')}:00` }) },
  { key: 'rate', label: 'Abverkauf', cell: (r) => ({ text: `${r.rate.toFixed(1)}/min` }) },
  { key: 'samples', label: 'Messungen', cell: (r) => ({ text: fmtUnits.format(r.samples) }) },
];

function currentItemKey() {
  return document.getElementById('itemSelect').value || '';
}

function fillItemSelect() {
  const select = document.getElementById('itemSelect');
  const before = select.value;
  const options = Object.keys(observations)
    .map((key) => {
      const [code, id] = key.split(':');
      const itemId = Number(id);
      const name = (stocks.get(code) || []).find((i) => i.itemId === itemId)?.itemName
        || prices.get(itemId)?.itemName
        || `Item ${itemId}`;
      return { key, label: `${countryName(code)} · ${name}`, count: (observations[key] || []).length };
    })
    .sort((a, b) => b.count - a.count);

  select.innerHTML = options
    .map((o) => `<option value="${escapeHtml(o.key)}">${escapeHtml(o.label)} (${o.count})</option>`)
    .join('');
  if (before && options.some((o) => o.key === before)) select.value = before;
}

/**
 * Zeichnet den Vorratsverlauf. Leere Strecken werden schattiert - dort laeuft
 * der Timer, und genau die Luecken sind die interessanten Stellen.
 */
function drawChart(series) {
  const canvas = document.getElementById('itemChart');
  const ratio = window.devicePixelRatio || 1;
  const width = canvas.clientWidth || 320;
  const height = 140;
  canvas.width = width * ratio;
  canvas.height = height * ratio;

  const ctx = canvas.getContext('2d');
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  ctx.clearRect(0, 0, width, height);

  const points = [...series].sort((a, b) => a[0] - b[0]);
  const style = getComputedStyle(document.documentElement);
  const line = style.getPropertyValue('--accent').trim() || '#4da3ff';
  const muted = style.getPropertyValue('--muted').trim() || '#949cab';

  if (points.length < 2) {
    ctx.fillStyle = muted;
    ctx.font = '12px system-ui, sans-serif';
    ctx.fillText('Noch zu wenige Messungen für einen Verlauf.', 10, height / 2);
    return;
  }

  const pad = { left: 6, right: 6, top: 10, bottom: 16 };
  const t0 = points[0][0];
  const t1 = points[points.length - 1][0];
  const maxQ = Math.max(...points.map((p) => p[1]), 1);
  const x = (ts) => pad.left + ((ts - t0) / Math.max(1, t1 - t0)) * (width - pad.left - pad.right);
  const y = (q) => height - pad.bottom - (q / maxQ) * (height - pad.top - pad.bottom);

  // Leerphasen zuerst, damit die Linie darueber liegt.
  ctx.fillStyle = 'rgba(148, 156, 171, .22)';
  for (let i = 1; i < points.length; i++) {
    if (points[i - 1][1] === 0 || points[i][1] === 0) {
      const from = x(points[i - 1][0]);
      ctx.fillRect(from, pad.top, Math.max(1, x(points[i][0]) - from), height - pad.top - pad.bottom);
    }
  }

  ctx.strokeStyle = line;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  points.forEach((p, i) => (i ? ctx.lineTo(x(p[0]), y(p[1])) : ctx.moveTo(x(p[0]), y(p[1]))));
  ctx.stroke();

  ctx.fillStyle = muted;
  ctx.font = '10px ui-monospace, monospace';
  ctx.fillText(fmtClock(t0), pad.left, height - 4);
  const endLabel = fmtClock(t1);
  ctx.fillText(endLabel, width - pad.right - ctx.measureText(endLabel).width, height - 4);
  ctx.fillText(`max ${fmtUnits.format(maxQ)}`, pad.left, pad.top + 2);
}

function renderItemPanel() {
  const key = currentItemKey();
  const series = observations[key] || [];
  const samples = Number(document.getElementById('sampleSelect').value) || 5;

  drawChart(series);

  const rate = windowRate(series, samples);
  const windows = inStockWindows(series);
  document.getElementById('chartLegend').textContent = series.length
    ? `${series.length} Messungen · ${windows.length} In-Stock-Fenster · `
      + (rate
        ? `Abverkauf ${rate.rate.toFixed(2)}/min über ${rate.windows} Fenster`
        : 'noch kein vollständiges Fenster')
      + ' · schattiert = leer'
    : 'Noch keine Messungen für dieses Item.';

  renderTable('restockTable', RESTOCK_COLUMNS, recentRestocks(series, 5), {
    empty: 'Noch kein Nachschub beobachtet.',
  });
  renderTable('hourTable', HOUR_COLUMNS, hourProfile(series).filter((h) => h.rate !== null && h.samples >= 2), {
    empty: 'Noch zu wenige Messungen je Tageszeit.',
  });
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

/**
 * Liest die von GitHub Actions gesammelte Historie.
 *
 * Damit hat die Vorhersage schon Messreihen, bevor der Nutzer das erste Mal
 * selbst nachgesehen hat - und sie waechst weiter, waehrend niemand die Seite
 * offen hat. Die Datei liegt neben der Seite, also same-origin: kein CORS,
 * keine zusaetzliche Domain in der Sicherheitsregel.
 */
async function loadCollected() {
  const msg = document.getElementById('collectedMsg');
  try {
    const res = await fetch(`data/travel-stock.json?t=${Math.floor(Date.now() / 60000)}`, {
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const remote = data?.series && typeof data.series === 'object' ? data.series : {};

    const before = Object.values(observations).reduce((s, x) => s + x.length, 0);
    observations = saveStock(mergeStock(observations, remote));
    const after = Object.values(observations).reduce((s, x) => s + x.length, 0);

    render();
    msg.textContent = data.collectedAt
      ? `${Object.keys(remote).length} gesammelte Reihen, zuletzt ${relative(data.collectedAt)}`
        + `${after > before ? `, ${after - before} neue Messpunkte` : ''}.`
      : 'Noch nichts gesammelt — der Sammler läuft nach Plan in GitHub Actions.';
  } catch (err) {
    // Kein Grund für eine Fehlermeldung: die Seite funktioniert ohne die
    // Sammlung, sie lernt nur langsamer.
    msg.textContent = `Gesammelte Historie nicht verfügbar (${err.message}).`;
  }
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
  document.getElementById('fromTornBtn').addEventListener('click', takeFromTorn);
  document.getElementById('itemSelect').addEventListener('change', renderItemPanel);
  document.getElementById('sampleSelect').addEventListener('change', renderItemPanel);
  document.getElementById('itemPanel').addEventListener('toggle', renderItemPanel);
  window.addEventListener('resize', () => {
    if (document.getElementById('itemPanel').open) renderItemPanel();
  });

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
  loadCollected();
  render();

  // Zuletzt: die Kaesten so aufklappen, wie man die Seite verlassen hat.
  // Sechs Aufklapper untereinander sind sonst bei jedem Besuch dieselbe
  // Klickstrecke. Erst hier, damit ein wiederhergestellter Kasten auf
  // gefuellte Auswahllisten trifft und nicht auf leere.
  restorePanels({ page: 'travel' });
}

init();
