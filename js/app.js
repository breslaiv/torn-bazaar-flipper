import { DEFAULTS } from './config.js';
import { loadSettings, saveSettings, clearSettings, hasSavedSettings } from './storage.js';
import { runFlipScan, runDollarScan, verifyWithTorn } from './scan.js';
import { renderRows, renderHead, setStatus, installSorting, fmtMoney } from './ui.js';

const NUMERIC_FIELDS = new Set([
  'sellFactor', 'marketFeePct', 'prescreenPct', 'maxCandidates', 'listingsPerItem',
  'tradersPerItem', 'tradedWithinHours', 'minProfitAbs', 'minProfitPct',
  'maxBuyPrice', 'budget', 'autoRefreshSec',
]);
const BOOLEAN_FIELDS = new Set(['requireNonNegativeRating']);

let currentRows = [];
let controller = null;
let refreshTimer = null;

function formToSettings() {
  const settings = {};
  for (const key of Object.keys(DEFAULTS)) {
    const el = document.getElementById(key);
    if (!el) continue;
    if (BOOLEAN_FIELDS.has(key)) settings[key] = el.checked;
    else if (NUMERIC_FIELDS.has(key)) settings[key] = Number(el.value);
    else settings[key] = el.value;
  }
  return settings;
}

function settingsToForm(settings) {
  for (const [key, value] of Object.entries(settings)) {
    const el = document.getElementById(key);
    if (!el) continue;
    if (BOOLEAN_FIELDS.has(key)) el.checked = Boolean(value);
    else el.value = value;
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

function summarise(rows, stats, settings) {
  if (!rows.length) {
    const why = settings.scanMode === 'flip' && stats.withoutBuyer
      ? ` ${stats.withoutBuyer} der ${stats.candidates} Kandidaten hatten keinen aktiven Käufer.`
      : '';
    return `Keine Treffer über den Filtern. ${stats.candidates} Kandidaten geprüft.${why}`;
  }
  const total = rows.reduce((sum, r) => sum + r.totalProfit, 0);
  return `${rows.length} Treffer aus ${stats.candidates} Kandidaten. `
    + `Summe über alle Zeilen: ${fmtMoney(total)}.`;
}

async function runScan() {
  if (controller) return;
  const settings = saveSettings(formToSettings());

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
    const { rows, stats } = await scan(settings, { onProgress, signal: controller.signal });

    currentRows = rows;
    renderRows(currentRows);

    if (settings.tornKey && rows.length) {
      currentRows = await verifyWithTorn(rows, settings, { onProgress, signal: controller.signal });
      renderRows(currentRows);
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

function init() {
  settingsToForm(loadSettings());
  syncModeVisibility();
  renderHead();

  // Beim ersten Besuch aufgeklappt, danach zu: auf dem Handy sind das
  // sonst 15 Felder zwischen Seitenanfang und Trefferliste.
  document.getElementById('settingsPanel').open = !hasSavedSettings();

  document.getElementById('scanMode').addEventListener('change', syncModeVisibility);

  document.getElementById('saveBtn').addEventListener('click', () => {
    saveSettings(formToSettings());
    scheduleAutoRefresh();
    setStatus('Einstellungen gespeichert.', 'ok');
  });

  document.getElementById('resetBtn').addEventListener('click', () => {
    if (!confirm('Alle Einstellungen inklusive gespeicherter Keys zurücksetzen?')) return;
    clearSettings();
    settingsToForm(DEFAULTS);
    syncModeVisibility();
    setStatus('Zurückgesetzt.', 'ok');
  });

  document.getElementById('scanBtn').addEventListener('click', runScan);
  document.getElementById('stopBtn').addEventListener('click', () => {
    controller?.abort();
    setStatus('Breche ab…');
  });

  installSorting(() => currentRows, (sorted) => {
    currentRows = sorted;
    renderRows(sorted);
  });

  scheduleAutoRefresh();
}

init();
