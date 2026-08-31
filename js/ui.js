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

export function setStatus(text, kind = '') {
  const el = document.getElementById('status');
  if (!el) return;
  el.textContent = text;
  el.className = kind;
}

function sellerCell(row) {
  if (!row.sellerId) return '<td class="left">—</td>';
  const label = escapeHtml(row.sellerName || row.sellerId);
  return `<td class="left"><a href="https://www.torn.com/bazaar.php?userId=${row.sellerId}" target="_blank" rel="noopener">${label}</a></td>`;
}

function buyerCell(row) {
  if (!row.buyerId) return '<td class="left">—</td>';
  const label = escapeHtml(row.buyerName || row.buyerId);
  const rating = row.buyerRating === null
    ? ''
    : `<span class="tag ${row.buyerRating >= 0 ? 'ok' : 'warn'}">${row.buyerRating >= 0 ? '+' : ''}${row.buyerRating}</span>`;
  return `<td class="left"><a href="https://www.torn.com/trade.php#step=start&userID=${row.buyerId}" target="_blank" rel="noopener">${label}</a>${rating}</td>`;
}

function num(value, cls = '') {
  return `<td class="num ${cls}">${value}</td>`;
}

export function renderRows(rows) {
  const tbody = document.querySelector('#results tbody');
  const count = document.getElementById('rowCount');
  if (count) count.textContent = String(rows.length);
  if (!tbody) return;

  if (!rows.length) {
    tbody.innerHTML = '<tr><td colspan="10" class="left empty">Keine Treffer.</td></tr>';
    return;
  }

  tbody.innerHTML = rows.map((row) => {
    const tags = [];
    if (row.sponsored) tags.push('<span class="tag">gesponsert</span>');
    if (row.suspicious) tags.push('<span class="tag warn">prüfen</span>');
    if (Number.isFinite(row.itemMarketLow)) {
      tags.push(`<span class="tag">IM ${fmtMoney(row.itemMarketLow)}</span>`);
    }
    const cls = row.profitPerUnit >= 0 ? 'pos' : 'neg';

    return `<tr>
      <td class="left">${escapeHtml(row.itemName)}${tags.join('')}</td>
      ${sellerCell(row)}
      ${num(fmtMoney(row.buy))}
      ${buyerCell(row)}
      ${num(fmtMoney(row.reference))}
      ${num(fmtMoney(row.sellNet))}
      ${num(fmtMoney(row.profitPerUnit), cls)}
      ${num(fmtPct(row.profitPct), cls)}
      ${num(money.format(row.units))}
      ${num(fmtMoney(row.totalProfit), cls)}
    </tr>`;
  }).join('');
}

/** Klickbare Spaltenkoepfe. */
export function installSorting(getRows, onSorted) {
  let sortKey = 'totalProfit';
  let asc = false;

  document.querySelectorAll('#results thead th[data-sort]').forEach((th) => {
    th.addEventListener('click', () => {
      const key = th.dataset.sort;
      if (key === sortKey) asc = !asc;
      else { sortKey = key; asc = false; }

      const sorted = [...getRows()].sort((a, b) => {
        const x = a[sortKey];
        const y = b[sortKey];
        if (typeof x === 'string' || typeof y === 'string') {
          return asc
            ? String(x ?? '').localeCompare(String(y ?? ''))
            : String(y ?? '').localeCompare(String(x ?? ''));
        }
        return asc ? (x ?? 0) - (y ?? 0) : (y ?? 0) - (x ?? 0);
      });
      onSorted(sorted);
    });
  });
}
