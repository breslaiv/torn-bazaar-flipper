const money = new Intl.NumberFormat('en-US');

export function fmtMoney(n) {
  if (!Number.isFinite(n)) return '—';
  return `${n < 0 ? '-' : ''}$${money.format(Math.round(Math.abs(n)))}`;
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
  { key: 'units', label: 'Menge', type: 'count' },
  { key: 'totalProfit', label: 'Gesamt', type: 'money', profit: true, strong: true },
];

const TEXT_COLUMNS = new Set(['itemName', 'sellerName', 'buyerName']);

function tags(row) {
  const out = [];
  if (row.sponsored) out.push('<span class="tag">gesponsert</span>');
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

function cellContent(col, row) {
  switch (col.type) {
    case 'item':
      return `${escapeHtml(row.itemName)}${tags(row)}`;
    case 'seller':
      return personCell(row.sellerId, row.sellerName, 'https://www.torn.com/bazaar.php?userId=');
    case 'buyer': {
      if (!row.buyerId) return '—';
      const link = personCell(row.buyerId, row.buyerName, 'https://www.torn.com/trade.php#step=start&userID=');
      if (row.buyerRating === null) return link;
      const cls = row.buyerRating >= 0 ? 'ok' : 'warn';
      const sign = row.buyerRating >= 0 ? '+' : '';
      return `${link}<span class="tag ${cls}">${sign}${row.buyerRating}</span>`;
    }
    case 'money':
      return fmtMoney(row[col.key]);
    case 'pct':
      return fmtPct(row[col.key]);
    case 'count':
      return money.format(row[col.key]);
    default:
      return escapeHtml(row[col.key] ?? '');
  }
}

/** Reine Funktion, damit sich das Markup ohne DOM testen laesst. */
export function rowsToHtml(rows) {
  if (!rows.length) {
    return `<tr><td colspan="${COLUMNS.length}" class="left empty">Keine Treffer.</td></tr>`;
  }
  return rows.map((row) => {
    const cells = COLUMNS.map((col) => {
      const classes = [];
      if (TEXT_COLUMNS.has(col.key)) classes.push('left');
      else classes.push('num');
      if (col.strong) classes.push('strong');
      if (col.profit) classes.push(row.profitPerUnit >= 0 ? 'pos' : 'neg');
      return `<td class="${classes.join(' ')}" data-label="${col.label}"><span class="val">${cellContent(col, row)}</span></td>`;
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
export function sortRows(rows, key, asc) {
  return [...rows].sort((a, b) => {
    const x = a[key];
    const y = b[key];
    if (typeof x === 'string' || typeof y === 'string') {
      return asc
        ? String(x ?? '').localeCompare(String(y ?? ''))
        : String(y ?? '').localeCompare(String(x ?? ''));
    }
    return asc ? (x ?? 0) - (y ?? 0) : (y ?? 0) - (x ?? 0);
  });
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

export function renderRows(rows) {
  const count = document.getElementById('rowCount');
  if (count) count.textContent = String(rows.length);
  const tbody = document.querySelector('#results tbody');
  if (tbody) tbody.innerHTML = rowsToHtml(rows);
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
}
