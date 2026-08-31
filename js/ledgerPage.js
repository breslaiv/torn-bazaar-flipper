import { loadSettings, saveSettings } from './storage.js?v=5';
import {
  makeEvent, matchFifo, summarise, filterByPeriod, profitByItem,
} from './ledger.js?v=5';
import {
  loadEvents, saveEvents, addEvents, removeEvent, clearLedger,
  exportJson, parseImport, markExported, lastExport,
} from './ledgerStore.js?v=5';
import {
  fetchLog, fetchLogTypes, fetchLogCategories, deriveLogTypes, deriveCategories,
  inspect, TornLogError,
} from './tornlog.js?v=5';
import { reconstructTrades } from './tradelog.js?v=5';
import { fetchMarketplace } from './weav3r.js?v=5';
import { renderTable } from './table.js?v=5';
import { fmtMoney, fmtPct, setStatus, escapeHtml, showVersion } from './ui.js?v=5';
import { APP_VERSION } from './config.js?v=5';

let events = [];
let pendingImport = [];

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

function renderTiles(summary, days) {
  const period = days ? `letzte ${days} Tage` : 'gesamter Zeitraum';
  const profitCls = summary.realizedProfit >= 0 ? 'pos' : 'neg';

  const parts = [
    tile('Realisierter Profit', fmtMoney(summary.realizedProfit), period, profitCls),
    tile('Marge', summary.margin === null ? '—' : fmtPct(summary.margin),
      `aus ${fmtUnits.format(summary.salesCount)} Verkäufen`),
    tile('Umsatz', fmtMoney(summary.proceeds), `Einstand ${fmtMoney(summary.realizedCost)}`),
    tile('Gebundenes Kapital', fmtMoney(summary.openCost),
      `${fmtUnits.format(summary.openUnits)} Stück offen`),
  ];

  if (summary.uncoveredUnits > 0) {
    // Sonst sieht der Profit hoeher aus als er ist, ohne dass jemand merkt warum.
    parts.push(tile('Ohne Einstand', `${fmtUnits.format(summary.uncoveredUnits)}`,
      'verkauft ohne erfassten Kauf', 'warn-text'));
  }

  document.getElementById('tiles').innerHTML = parts.join('');
}

// ---------- Tabellen ----------

const OPEN_COLUMNS = [
  { key: 'item', label: 'Item', align: 'left', cell: (r) => ({ text: r.event.itemName }) },
  { key: 'date', label: 'Gekauft', cell: (r) => ({ text: fmtDate(r.event.ts) }) },
  { key: 'qty', label: 'Menge', cell: (r) => ({ text: fmtUnits.format(r.remaining) }) },
  { key: 'unit', label: 'Einstand/Stück', cell: (r) => ({ text: fmtMoney(r.event.unitPrice) }) },
  { key: 'cost', label: 'Kapital', cell: (r) => ({ text: fmtMoney(r.cost), cls: 'strong' }) },
  {
    key: 'del',
    label: '',
    cell: (r) => ({ html: `<button class="link-btn" data-del="${escapeHtml(r.event.id)}">löschen</button>` }),
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

// ---------- Aufbau ----------

function currentPeriod() {
  return Number(document.getElementById('periodSelect').value) || 0;
}

function render() {
  const days = currentPeriod();
  // Offene Positionen richten sich nicht nach dem Zeitraum: ein Kauf von vor
  // 90 Tagen bindet immer noch Kapital.
  const all = matchFifo(events);
  const scoped = matchFifo(filterByPeriod(events, days));

  const summary = { ...summarise(scoped), openCost: 0, openUnits: 0, openCount: 0 };
  const openSummary = summarise(all);
  summary.openCost = openSummary.openCost;
  summary.openUnits = openSummary.openUnits;
  summary.openCount = openSummary.openCount;

  renderTiles(summary, days);
  renderTable('openTable', OPEN_COLUMNS, all.openLots, { empty: 'Kein offener Bestand.' });
  renderTable('salesTable', SALE_COLUMNS, scoped.sales, {
    // Nur Kaeufe erfasst und nichts verkauft heisst nicht, dass der Ledger
    // kaputt ist - beim Flippen laufen die Verkaeufe ueber Trades, und die
    // kann der Import noch nicht zuordnen. Ohne diesen Hinweis sieht die
    // Seite nach Fehler aus.
    empty: all.openLots.length
      ? 'Keine Verkäufe erfasst, aber Bestand vorhanden. Verkäufe über Trades kann der Import '
        + 'noch nicht zuordnen — bis dahin unten von Hand erfassen.'
      : 'Keine Verkäufe im Zeitraum.',
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
  render();
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

async function importFromLog() {
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

    const lines = [];
    // Steht bewusst als erste Zeile: ohne sie laesst sich ein Bericht nicht
    // dem Code zuordnen, der ihn erzeugt hat.
    lines.push(`Build ${APP_VERSION} — ${new Date().toLocaleString('de-DE')}`);
    lines.push(`${entries.length} Log-Einträge gelesen, ${pendingImport.length} Vorgänge erkannt `
      + `(${result.events.length} direkt, ${trades.events.length} aus ${trades.groups} Trades).`);
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
    document.getElementById('applyImportBtn').disabled = result.events.length === 0;
    setStatus(
      result.events.length
        ? `${result.events.length} Vorgänge gefunden — prüfen und übernehmen.`
        : 'Nichts erkannt. Der Bericht zeigt, welche Kategorien dein Log enthält.',
      result.events.length ? 'ok' : 'error',
    );
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

function applyImport() {
  const { added, duplicates, invalid } = addEvents(pendingImport);
  pendingImport = [];
  document.getElementById('applyImportBtn').disabled = true;
  reload();
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

function addManual() {
  const dateValue = document.getElementById('mDate').value;
  const event = makeEvent({
    ts: dateValue ? new Date(`${dateValue}T12:00:00`).getTime() : Date.now(),
    kind: document.getElementById('mKind').value,
    itemId: Number(document.getElementById('mItemId').value),
    itemName: document.getElementById('mItemName').value.trim() || undefined,
    quantity: Number(document.getElementById('mQuantity').value),
    unitPrice: Number(document.getElementById('mUnitPrice').value),
    source: 'manual',
  });

  const { added, invalid } = addEvents([event]);
  const msg = document.getElementById('manualMsg');
  if (added) {
    msg.textContent = 'Angelegt.';
    document.getElementById('mItemId').value = '';
    document.getElementById('mUnitPrice').value = '';
    reload();
  } else {
    msg.textContent = invalid
      ? 'Item-ID, Menge und Preis müssen gesetzt sein.'
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
  document.getElementById('periodSelect').addEventListener('change', render);
  document.getElementById('saveKeyBtn').addEventListener('click', saveKey);
  document.getElementById('clearKeyBtn').addEventListener('click', () => {
    document.getElementById('ledgerTornKey').value = '';
    saveKey();
  });
  document.getElementById('importLogBtn').addEventListener('click', importFromLog);
  document.getElementById('applyImportBtn').addEventListener('click', applyImport);
  document.getElementById('addManualBtn').addEventListener('click', addManual);
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

  // Loeschen einzelner Kaeufe laeuft ueber Delegation, weil die Tabelle
  // bei jeder Aenderung neu gebaut wird.
  document.getElementById('openTable').addEventListener('click', (ev) => {
    const id = ev.target?.dataset?.del;
    if (!id) return;
    events = removeEvent(id);
    render();
    setStatus('Position gelöscht.', 'ok');
  });

  renderKeyState();
  reload();

  // Bei leerem Ledger fuehren sonst vier Null-Kacheln und zwei leere Tabellen,
  // bevor man ueberhaupt zum Einrichten kommt.
  document.getElementById('importPanel').open = events.length === 0;
}

init();
