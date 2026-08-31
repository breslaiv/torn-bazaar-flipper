import { DEFAULTS } from './config.js';
import { loadSettings, saveSettings, loadItemCache, saveItemCache, clearItemCache } from './storage.js';
import { fetchItems, fetchItemMarketLow, TornApiError } from './torn.js';
import { fetchBazaarListings, urlNeedsItemId } from './weav3r.js';
import { buildRows, topItemIdsForVerification } from './profit.js';
import { renderRows, setStatus, installSorting } from './ui.js';

const NUMERIC_FIELDS = new Set([
  'sellFactor', 'marketFeePct', 'verifyTopN', 'minProfitAbs', 'minProfitPct',
  'maxBuyPrice', 'budget', 'autoRefreshSec', 'itemCacheMinutes', 'perItemScanLimit',
]);

let currentRows = [];
let running = false;
let cancelled = false;
let refreshTimer = null;

// ---------- Einstellungen <-> Formular ----------

function formToSettings() {
  const settings = {};
  for (const key of Object.keys(DEFAULTS)) {
    const el = document.getElementById(key);
    if (!el) continue;
    settings[key] = NUMERIC_FIELDS.has(key) ? Number(el.value) : el.value;
  }
  return settings;
}

function settingsToForm(settings) {
  for (const [key, value] of Object.entries(settings)) {
    const el = document.getElementById(key);
    if (el) el.value = value;
  }
}

// ---------- Item-Stammdaten ----------

async function getItems(settings) {
  const cached = loadItemCache(settings.itemCacheMinutes);
  if (cached) return new Map(cached.items.map((i) => [i.id, i]));

  setStatus('Lade Item-Stammdaten von Torn…');
  const byId = await fetchItems(settings.tornKey);
  saveItemCache([...byId.values()]);
  return byId;
}

// ---------- Bazaar-Daten ----------

function itemIdsForPerItemScan(settings, itemsById) {
  const explicit = (settings.itemFilterIds || '')
    .split(/[,\s]+/)
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n) && n > 0);
  if (explicit.length) return explicit.slice(0, settings.perItemScanLimit);

  return [...itemsById.values()]
    .filter((i) => i.marketValue > 0)
    .sort((a, b) => b.marketValue - a.marketValue)
    .slice(0, settings.perItemScanLimit)
    .map((i) => i.id);
}

async function collectListings(settings, itemsById) {
  if (!urlNeedsItemId(settings.weav3rUrl)) {
    setStatus('Frage weav3r-Sammelendpoint ab…');
    const { listings, diagnostics } = await fetchBazaarListings(settings);
    if (!listings.length) {
      throw new Error(
        'weav3r antwortete, aber es liessen sich keine Listings herauslesen. ' +
        `Gefundene Arrays: ${JSON.stringify(diagnostics.arraysFound)}. ` +
        'Schau in die API-Diagnose und schick mir die Rohantwort.'
      );
    }
    return listings;
  }

  const ids = itemIdsForPerItemScan(settings, itemsById);
  const all = [];
  for (let i = 0; i < ids.length; i++) {
    if (cancelled) break;
    setStatus(`Frage weav3r ab: Item ${i + 1}/${ids.length}…`);
    try {
      const { listings } = await fetchBazaarListings(settings, ids[i]);
      for (const l of listings) {
        // Im Pro-Item-Modus kennt die Antwort die Item-ID evtl. nicht selbst.
        all.push({ ...l, itemId: l.itemId || ids[i] });
      }
    } catch (err) {
      // Ein einzelnes fehlgeschlagenes Item soll den Scan nicht killen.
      console.warn(`Item ${ids[i]} übersprungen:`, err.message);
    }
  }
  return all;
}

// ---------- Live-Verifikation ----------

async function verifyTopRows(rows, settings) {
  const n = Number(settings.verifyTopN) || 0;
  if (n <= 0) return new Map();

  const ids = topItemIdsForVerification(rows, n);
  const lows = new Map();
  for (let i = 0; i < ids.length; i++) {
    if (cancelled) break;
    setStatus(`Prüfe Item-Market-Preise: ${i + 1}/${ids.length}…`);
    try {
      const low = await fetchItemMarketLow(settings.tornKey, ids[i]);
      if (low !== null) lows.set(ids[i], low);
    } catch (err) {
      console.warn(`Item-Market-Check für ${ids[i]} fehlgeschlagen:`, err.message);
    }
  }
  return lows;
}

// ---------- Scan ----------

async function runScan() {
  if (running) return;
  const settings = saveSettings(formToSettings());

  if (!settings.tornKey) {
    setStatus('Kein Torn API-Key hinterlegt — ohne ihn gibt es keine Referenzpreise.', 'error');
    return;
  }
  if (!settings.weav3rUrl) {
    setStatus('Kein weav3r-Endpoint hinterlegt. Trag die URL aus api-docs.html in den Einstellungen ein.', 'error');
    return;
  }

  running = true;
  cancelled = false;
  document.getElementById('scanBtn').disabled = true;
  document.getElementById('stopBtn').disabled = false;

  try {
    const itemsById = await getItems(settings);
    const listings = await collectListings(settings, itemsById);
    if (cancelled) { setStatus('Abgebrochen.'); return; }

    setStatus(`${listings.length} Listings geladen, rechne…`);
    currentRows = buildRows(listings, itemsById, settings);
    renderRows(currentRows);

    const lows = await verifyTopRows(currentRows, settings);
    if (lows.size) {
      currentRows = buildRows(listings, itemsById, settings, lows);
      renderRows(currentRows);
    }

    const total = currentRows.reduce((sum, r) => sum + r.totalProfit, 0);
    setStatus(
      `${currentRows.length} Treffer aus ${listings.length} Listings. ` +
      `Theoretischer Gesamtprofit: $${Math.round(total).toLocaleString('en-US')}.`,
      'ok'
    );
    document.getElementById('lastRun').textContent = new Date().toLocaleTimeString('de-DE');
  } catch (err) {
    if (err instanceof TornApiError) {
      setStatus(err.code ? `Torn API-Fehler ${err.code}: ${err.message}` : err.message, 'error');
    } else {
      setStatus(err.message, 'error');
    }
    console.error(err);
  } finally {
    running = false;
    document.getElementById('scanBtn').disabled = false;
    document.getElementById('stopBtn').disabled = true;
  }
}

function scheduleAutoRefresh() {
  clearInterval(refreshTimer);
  const sec = Number(loadSettings().autoRefreshSec) || 0;
  if (sec > 0) refreshTimer = setInterval(runScan, sec * 1000);
}

// ---------- Bootstrap ----------

function init() {
  settingsToForm(loadSettings());

  const settings = loadSettings();
  if (!settings.tornKey || !settings.weav3rUrl) {
    document.getElementById('settingsPanel').open = true;
  }

  document.getElementById('saveBtn').addEventListener('click', () => {
    saveSettings(formToSettings());
    scheduleAutoRefresh();
    setStatus('Einstellungen gespeichert.', 'ok');
  });

  document.getElementById('clearCacheBtn').addEventListener('click', () => {
    clearItemCache();
    setStatus('Item-Cache geleert — der nächste Scan lädt die Stammdaten neu.', 'ok');
  });

  document.getElementById('resetBtn').addEventListener('click', () => {
    if (!confirm('Alle Einstellungen inklusive gespeicherter Keys zurücksetzen?')) return;
    localStorage.clear();
    settingsToForm(DEFAULTS);
    setStatus('Zurückgesetzt.', 'ok');
  });

  document.getElementById('scanBtn').addEventListener('click', runScan);
  document.getElementById('stopBtn').addEventListener('click', () => {
    cancelled = true;
    setStatus('Breche ab…');
  });

  installSorting(() => currentRows, (sorted) => {
    currentRows = sorted;
    renderRows(sorted);
  });

  renderRows([]);
  scheduleAutoRefresh();
}

init();
