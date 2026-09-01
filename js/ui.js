import { APP_VERSION } from './config.js?v=17';
import { fmtAge } from './freshness.js?v=17';

const money = new Intl.NumberFormat('en-US');

export function fmtMoney(n) {
  if (!Number.isFinite(n)) return '—';
  return `${n < 0 ? '-' : ''}$${money.format(Math.round(Math.abs(n)))}`;
}

/**
 * Kurzform fuer die Statusleiste. Die ist auf dem Handy bewusst eine Zeile
 * hoch und schneidet den Rest ab - "$7.17M" passt, "$7,174,400" draengt die
 * Haelfte des Satzes aus dem Bild.
 */
export function fmtMoneyShort(n) {
  if (!Number.isFinite(n)) return '—';
  const abs = Math.abs(n);
  const sign = n < 0 ? '-' : '';
  const cut = (value, unit) => `${sign}$${Number(value.toFixed(value < 10 ? 2 : 1))}${unit}`;
  if (abs >= 1e9) return cut(abs / 1e9, 'B');
  if (abs >= 1e6) return cut(abs / 1e6, 'M');
  if (abs >= 10000) return `${sign}$${Math.round(abs / 1000)}k`;
  return fmtMoney(n);
}

export function fmtPct(n) {
  return Number.isFinite(n) ? `${n.toFixed(1)}%` : '—';
}

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

/**
 * Einzige Quelle fuer Spaltenkopf, Zell-Label und Sortier-Auswahl.
 * Auf dem Handy wird die Kopfzeile ausgeblendet und jede Zelle traegt ihr
 * Label per data-label - Tabelle und Karte teilen sich dasselbe Markup.
 */
export const COLUMNS = [
  { key: 'itemName', label: 'Item', type: 'item' },
  { key: 'sellerName', label: 'Bazaar', type: 'seller' },
  { key: 'buy', label: 'Kaufpreis', type: 'money' },
  { key: 'buyerName', label: 'Käufer', type: 'buyer' },
  { key: 'reference', label: 'Ankauf', type: 'money' },
  { key: 'sellNet', label: 'Netto', type: 'money' },
  { key: 'profitPerUnit', label: 'Profit/Stück', type: 'money', profit: true, strong: true },
  { key: 'profitPct', label: 'Marge', type: 'pct', profit: true },
  { key: 'normalDiscount', label: 'ggü. üblich', type: 'normal' },
  { key: 'units', label: 'Menge', type: 'units' },
  { key: 'listingAgeHours', label: 'Alter', type: 'age' },
  { key: 'totalProfit', label: 'Gesamt', type: 'money', profit: true, strong: true },
];

const TEXT_COLUMNS = new Set(['itemName', 'sellerName', 'buyerName']);

// Nur echte Web-Adressen. Ein Muster wie javascript:… kaeme zwar aus dem
// eigenen localStorage, hat in einem href aber trotzdem nichts zu suchen.
const HTTP_URL = /^https?:\/\//i;

/** Gegencheck-Adresse fuer ein Item, oder null wenn kein brauchbares Muster gesetzt ist. */
export function itemUrl(template, itemId) {
  if (!template || !HTTP_URL.test(template.trim())) return null;
  if (!Number.isFinite(Number(itemId))) return null;
  return template.trim().replace('{ITEM_ID}', encodeURIComponent(itemId));
}

function tags(row) {
  const out = [];
  if (row.sponsored) out.push('<span class="tag">gesponsert</span>');
  if (row.overBudget) out.push('<span class="tag">über Budget</span>');
  if (row.suspicious) out.push('<span class="tag warn">prüfen</span>');
  if (Number.isFinite(row.itemMarketLow)) {
    out.push(`<span class="tag">IM ${fmtMoney(row.itemMarketLow)}</span>`);
  }
  return out.join('');
}

function personCell(id, name, href) {
  if (!id) return '—';
  return `<a href="${href}${id}" target="_blank" rel="noopener">${escapeHtml(name || id)}</a>`;
}

function cellContent(col, row, opts) {
  switch (col.type) {
    case 'item': {
      const name = escapeHtml(row.itemName);
      const href = itemUrl(opts.itemUrlTemplate, row.itemId);
      // Der Itemname ist selbst der Link: kostet keine Zeile und ist auf dem
      // Handy ein grosszuegiges Tippziel.
      const head = href
        ? `<a class="item-link" href="${escapeHtml(href)}" target="_blank" rel="noopener">`
          + `${name}<span class="ext" aria-hidden="true">&#8599;</span></a>`
        : name;
      return `${head}${tags(row)}`;
    }
    case 'seller':
      return personCell(row.sellerId, row.sellerName, 'https://www.torn.com/bazaar.php?userId=');
    case 'buyer': {
      if (!row.buyerId) return '—';
      const link = personCell(row.buyerId, row.buyerName, 'https://www.torn.com/trade.php#step=start&userID=');
      if (row.buyerRating === null) return link;
      const cls = row.buyerRating >= 0 ? 'ok' : 'warn';
      const sign = row.buyerRating >= 0 ? '+' : '';
      // Wie lange der Kaeufer nichts getan hat: ein Trade an jemanden, der
      // seit Tagen offline ist, bleibt liegen.
      const idle = Number.isFinite(row.buyerIdleHours)
        ? `<span class="tag${row.buyerIdleHours > 24 ? ' warn' : ''}">${escapeHtml(fmtAge(row.buyerIdleHours))}</span>`
        : '';
      return `${link}<span class="tag ${cls}">${sign}${row.buyerRating}</span>${idle}`;
    }
    case 'money':
      return fmtMoney(row[col.key]);
    case 'pct':
      return fmtPct(row[col.key]);
    case 'count':
      return money.format(row[col.key]);
    case 'units': {
      // Der Einsatz gehoert an die Menge: erst beides zusammen sagt, ob die
      // Zeile ueberhaupt bezahlbar ist.
      const units = money.format(row.units);
      return Number.isFinite(row.spend) && row.units > 0
        ? `${units}<span class="tag">${fmtMoney(row.spend)}</span>`
        : units;
    }
    case 'normal': {
      // Ohne Historie bleibt es beim bisherigen Massstab - dann steht hier
      // nichts, statt eine Zahl vorzutaeuschen.
      const n = row.normal;
      if (!n) return '<span class="muted">–</span>';
      const sign = n.discount >= 0 ? '−' : '+';
      const text = `${sign}${Math.abs(n.discount).toFixed(0)}%`;
      return `<span class="${n.discount >= 0 ? 'pos' : 'neg'}">${text}</span>`
        + (n.unusual ? '<span class="tag ok">selten billig</span>' : '');
    }
    case 'age': {
      const hours = row.listingAgeHours;
      if (!Number.isFinite(hours)) return '<span class="muted">?</span>';
      // Ab drei Tagen ist ein Listing oft schon verkauft und nur noch im
      // Crawl vorhanden.
      const cls = hours > 72 ? ' warn' : '';
      return `<span class="age${cls}">${escapeHtml(fmtAge(hours))}</span>`;
    }
    default:
      return escapeHtml(row[col.key] ?? '');
  }
}

/** Reine Funktion, damit sich das Markup ohne DOM testen laesst. */
export function rowsToHtml(rows, opts = {}) {
  if (!rows.length) {
    return `<tr><td colspan="${COLUMNS.length}" class="left empty"><span class="val">Keine Treffer.</span></td></tr>`;
  }
  return rows.map((row) => {
    const cells = COLUMNS.map((col) => {
      const classes = [];
      if (TEXT_COLUMNS.has(col.key)) classes.push('left');
      else classes.push('num');
      if (col.strong) classes.push('strong');
      if (col.profit) classes.push(row.profitPerUnit >= 0 ? 'pos' : 'neg');
      if (col.key === 'sellNet' && row.sellNet === row.reference) classes.push('redundant');
      return `<td class="${classes.join(' ')}" data-label="${col.label}">`
        + `<span class="val">${cellContent(col, row, opts)}</span></td>`;
    }).join('');
    return `<tr>${cells}</tr>`;
  }).join('');
}

export function headToHtml() {
  return `<tr>${COLUMNS.map((col) => {
    const cls = TEXT_COLUMNS.has(col.key) ? 'left' : '';
    return `<th class="${cls}" data-sort="${col.key}">${col.label}</th>`;
  }).join('')}</tr>`;
}

export function sortOptionsToHtml() {
  return COLUMNS.map((col) => `<option value="${col.key}">${col.label}</option>`).join('');
}

/** Reine Sortierung, von Spaltenkopf und Auswahlfeld gemeinsam genutzt. */
/** Wert einer Spalte fuer die Sortierung - fuer verschachtelte auch. */
function sortValue(row, key) {
  if (key === 'normalDiscount') return row.normal ? row.normal.discount : Number.NEGATIVE_INFINITY;
  return row[key];
}

export function sortRows(rows, key, asc) {
  return [...rows].sort((a, b) => {
    const x = sortValue(a, key);
    const y = sortValue(b, key);
    if (typeof x === 'string' || typeof y === 'string') {
      return asc
        ? String(x ?? '').localeCompare(String(y ?? ''))
        : String(y ?? '').localeCompare(String(x ?? ''));
    }
    return asc ? (x ?? 0) - (y ?? 0) : (y ?? 0) - (x ?? 0);
  });
}

/**
 * Zeigt den Build im Kopf der Seite. Klingt nach Kosmetik, ist aber der
 * Unterschied zwischen "geht immer noch nicht" und "du laeufst auf Build 3".
 */
export function showVersion() {
  const el = document.getElementById('appVersion');
  if (!el) return;

  // Die HTML bestimmt, welche ?v=-URLs geladen werden; APP_VERSION kommt aus
  // einem der geladenen Module. Weichen beide ab, liegt ein Mischzustand vor:
  // der Query-Parameter bustet nur den Browser-Cache, der Server liefert unter
  // einer alten ?v=-URL trotzdem die neue Datei.
  const pageBuild = document.querySelector('meta[name="app-build"]')?.content;
  if (pageBuild && pageBuild !== APP_VERSION) {
    const link = document.createElement('a');
    link.href = `${location.pathname}?r=${Date.now()}`;
    link.textContent = `Build ${pageBuild} ≠ ${APP_VERSION} — neu laden`;
    el.replaceChildren(link);
    el.className = 'tag warn';
    return;
  }

  el.textContent = `Build ${APP_VERSION}`;
  el.className = 'tag';
}

export function setStatus(text, kind = '') {
  const el = document.getElementById('status');
  if (!el) return;
  el.textContent = text;
  el.className = kind;
}

export function renderHead() {
  const thead = document.querySelector('#results thead');
  if (thead) thead.innerHTML = headToHtml();
  const select = document.getElementById('sortSelect');
  if (select) select.innerHTML = sortOptionsToHtml();
}

export function renderRows(rows, opts = {}) {
  const count = document.getElementById('rowCount');
  if (count) count.textContent = String(rows.length);
  const tbody = document.querySelector('#results tbody');
  if (tbody) tbody.innerHTML = rowsToHtml(rows, opts);
}

/**
 * Verdrahtet Spaltenkoepfe (Desktop) und Auswahlfeld plus Richtungsknopf
 * (Handy) auf dieselbe Sortierung.
 */
export function installSorting(getRows, onSorted) {
  let key = 'totalProfit';
  let asc = false;

  const select = document.getElementById('sortSelect');
  const dirBtn = document.getElementById('sortDir');

  const apply = () => {
    if (select) select.value = key;
    if (dirBtn) {
      dirBtn.textContent = asc ? '↑' : '↓';
      dirBtn.setAttribute('aria-label', asc ? 'aufsteigend' : 'absteigend');
    }
    document.querySelectorAll('#results thead th[data-sort]').forEach((th) => {
      th.classList.toggle('sorted', th.dataset.sort === key);
    });
    onSorted(sortRows(getRows(), key, asc));
  };

  document.querySelectorAll('#results thead th[data-sort]').forEach((th) => {
    th.addEventListener('click', () => {
      if (th.dataset.sort === key) asc = !asc;
      else { key = th.dataset.sort; asc = false; }
      apply();
    });
  });

  select?.addEventListener('change', () => { key = select.value; apply(); });
  dirBtn?.addEventListener('click', () => { asc = !asc; apply(); });

  apply();

  // resort() erneut aufrufen, sobald sich die Datenbasis geaendert hat.
  return { resort: apply, state: () => ({ key, asc }) };
}
