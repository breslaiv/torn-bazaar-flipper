import { DEFAULTS } from './config.js?v=11';
import { loadSettings, saveSettings, clearSettings, hasSavedSettings } from './storage.js?v=11';
import { runFlipScan, runDollarScan, verifyWithTorn } from './scan.js?v=11';
import {
  renderRows, renderHead, setStatus, installSorting, fmtMoneyShort, showVersion,
} from './ui.js?v=11';
import { statsMap, STATS_URL } from './normal.js?v=11';

const NUMERIC_FIELDS = new Set([
  'sellFactor', 'marketFeePct', 'prescreenPct', 'maxCandidates', 'listingsPerItem',
  'tradersPerItem', 'tradedWithinHours', 'minBuyerRating', 'minProfitAbs',
  'minProfitPct', 'maxBuyPrice', 'budget', 'autoRefreshSec',
  'maxListingAgeHours', 'concurrency',
]);

let currentRows = [];
let normalStats = new Map();
let sorter = null;
let renderOpts = {};
let controller = null;
let refreshTimer = null;

function formToSettings() {
  const settings = {};
  for (const key of Object.keys(DEFAULTS)) {
    const el = document.getElementById(key);
    if (!el) continue;
    settings[key] = NUMERIC_FIELDS.has(key) ? Number(el.value) : el.value;
  }
  return settings;
}

function refreshRenderOpts(settings = loadSettings()) {
  renderOpts = { itemUrlTemplate: settings.w3bItemUrl };
}

function settingsToForm(settings) {
  for (const [key, value] of Object.entries(settings)) {
    const el = document.getElementById(key);
    if (el) el.value = value;
  }
}

function setBusy(busy) {
  document.getElementById('scanBtn').disabled = busy;
  document.getElementById('stopBtn').disabled = !busy;
  const bar = document.getElementById('progress');
  bar.hidden = !busy;
  if (!busy) bar.firstElementChild.style.width = '0%';
}

function setProgress(pct) {
  const bar = document.getElementById('progress');
  bar.firstElementChild.style.width = `${Math.max(0, Math.min(100, pct))}%`;
}

function dropReasons(stats, settings) {
  const parts = [];
  if (settings.scanMode === 'flip') {
    if (stats.withoutBuyer) parts.push(`${stats.withoutBuyer} ohne aktiven Käufer`);
    if (stats.buyerBelowRating) {
      parts.push(`${stats.buyerBelowRating} nur unter Bewertung ${settings.minBuyerRating}`);
    }
  }
  if (stats.filteredOut) {
    // Ein zu strenger Frische- oder Preisfilter saehe sonst aus wie ein
    // leerer Markt.
    parts.push(`${stats.filteredOut} profitabel, aber über Alter oder Preisgrenze`);
  }
  return parts.length ? ` Davon ${parts.join(', ')}.` : '';
}

function summarise(rows, stats, settings) {
  const why = dropReasons(stats, settings);
  if (!rows.length) {
    return `Keine Treffer über den Filtern. ${stats.candidates} Kandidaten geprüft.${why}`;
  }

  const buyable = rows.filter((r) => r.units > 0);
  const total = buyable.reduce((sum, r) => sum + r.totalProfit, 0);
  const spend = buyable.reduce((sum, r) => sum + r.spend, 0);
  const overBudget = rows.length - buyable.length;
  const rest = overBudget ? ` ${overBudget} weitere passen nicht ins Budget.` : '';

  // Zahl zuerst: die Leiste ist auf dem Handy eine Zeile hoch und schneidet
  // hinten ab. Der Einsatz gehoert direkt daneben - ein Profit von 4 Mio.
  // heisst wenig, wenn 30 Mio. dafuer bereitliegen muessen.
  return `Profit ${fmtMoneyShort(total)} bei ${fmtMoneyShort(spend)} Einsatz. `
    + `${rows.length} Treffer aus ${stats.candidates} Kandidaten.${rest}${why}`;
}

async function runScan() {
  if (controller) return;
  const settings = saveSettings(formToSettings());
  refreshRenderOpts(settings);

  controller = new AbortController();
  setBusy(true);

  const onProgress = ({ text, phase, done, total }) => {
    setStatus(text);
    // Grobe Gewichtung: Katalog vorne, Detailabfragen die lange Mitte,
    // Gegenprobe der Rest.
    let pct = 5;
    if (phase === 'detail' && total) pct = 8 + (done / total) * 84;
    else if (phase === 'dollar') pct = 50;
    else if (phase === 'verify') pct = 95;
    setProgress(pct);
  };

  try {
    const scan = settings.scanMode === 'dollar' ? runDollarScan : runFlipScan;
    const { rows, stats } = await scan(settings, {
      onProgress, signal: controller.signal, normalStats,
    });

    currentRows = rows;
    sorter.resort();

    if (settings.tornKey && rows.length) {
      currentRows = await verifyWithTorn(currentRows, settings, { onProgress, signal: controller.signal });
      sorter.resort();
    }

    setStatus(summarise(currentRows, stats, settings), currentRows.length ? 'ok' : '');
    document.getElementById('lastRun').textContent = new Date().toLocaleTimeString('de-DE');
  } catch (err) {
    if (err.name === 'AbortError') setStatus('Abgebrochen.');
    else {
      setStatus(err.message, 'error');
      console.error(err);
    }
  } finally {
    controller = null;
    setBusy(false);
  }
}

function scheduleAutoRefresh() {
  clearInterval(refreshTimer);
  const sec = Number(loadSettings().autoRefreshSec) || 0;
  if (sec > 0) refreshTimer = setInterval(runScan, sec * 1000);
}

// Im $1-Modus gibt es keine Kaeufer-Abfrage; die zugehoerigen Felder wuerden
// nur verwirren.
function syncModeVisibility() {
  const dollar = document.getElementById('scanMode').value === 'dollar';
  document.querySelectorAll('[data-flip-only]').forEach((el) => {
    el.style.display = dollar ? 'none' : '';
  });
}

/**
 * Holt den gesammelten Normalbereich. Same-origin, klein, und ohne ihn
 * laeuft der Scanner wie bisher - die Spalte bleibt dann leer.
 */
async function loadNormalStats() {
  try {
    const res = await fetch(`${STATS_URL}?t=${Math.floor(Date.now() / 3600000)}`, {
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) return;
    const data = await res.json();
    normalStats = statsMap(data);
    const el = document.getElementById('normalState');
    if (el && normalStats.size) {
      el.textContent = `Normalbereich für ${normalStats.size} Items `
        + `aus ${data.runs} Messungen der letzten ${data.windowDays} Tage.`;
    }
  } catch (err) {
    // Kein Grund, den Nutzer zu behelligen - die Spalte bleibt leer und der
    // Rest laeuft. Aber protokolliert wird es: ein stilles catch hat hier
    // schon einmal einen Tippfehler verschluckt, und die Spalte sah aus wie
    // "noch keine Daten" statt wie ein Fehler.
    console.warn('Normalbereich nicht geladen:', err.message);
  }
}

function init() {
  showVersion();
  settingsToForm(loadSettings());
  refreshRenderOpts();
  syncModeVisibility();
  renderHead();

  // Beim ersten Besuch aufgeklappt, danach zu: auf dem Handy sind das
  // sonst 15 Felder zwischen Seitenanfang und Trefferliste.
  document.getElementById('settingsPanel').open = !hasSavedSettings();

  document.getElementById('scanMode').addEventListener('change', syncModeVisibility);

  document.getElementById('saveBtn').addEventListener('click', () => {
    refreshRenderOpts(saveSettings(formToSettings()));
    sorter.resort();
    scheduleAutoRefresh();
    setStatus('Einstellungen gespeichert.', 'ok');
  });

  document.getElementById('resetBtn').addEventListener('click', () => {
    if (!confirm('Alle Einstellungen inklusive gespeicherter Keys zurücksetzen?')) return;
    clearSettings();
    settingsToForm(DEFAULTS);
    refreshRenderOpts(DEFAULTS);
    syncModeVisibility();
    setStatus('Zurückgesetzt.', 'ok');
  });

  document.getElementById('scanBtn').addEventListener('click', runScan);
  document.getElementById('stopBtn').addEventListener('click', () => {
    controller?.abort();
    setStatus('Breche ab…');
  });

  sorter = installSorting(() => currentRows, (sorted) => {
    currentRows = sorted;
    renderRows(sorted, renderOpts);
  });

  scheduleAutoRefresh();
  loadNormalStats();
}

init();
