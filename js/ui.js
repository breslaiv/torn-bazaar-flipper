const money = new Intl.NumberFormat('en-US');

export function fmtMoney(n) {
  if (!Number.isFinite(n)) return '—';
  const sign = n < 0 ? '-' : '';
  return `${sign}$${money.format(Math.round(Math.abs(n)))}`;
}

export function fmtPct(n) {
  if (!Number.isFinite(n)) return '—';
  return `${n.toFixed(1)}%`;
}

export function setStatus(text, kind = '') {
  const el = document.getElementById('status');
  el.textContent = text;
  el.className = kind;
}

function bazaarLink(row) {
  if (!row.playerId) return '';
  const href = `https://www.torn.com/bazaar.php?userId=${row.playerId}#/`;
  return `<a href="${href}" target="_blank" rel="noopener">${row.playerId}</a>`;
}

function cell(value, cls = '') {
  return `<td class="num ${cls}">${value}</td>`;
}

export function renderRows(rows) {
  const tbody = document.querySelector('#results tbody');
  document.getElementById('rowCount').textContent = String(rows.length);

  if (!rows.length) {
    tbody.innerHTML = '<tr><td colspan="9" class="left" style="color:#949cab">Keine Treffer.</td></tr>';
    return;
  }

  tbody.innerHTML = rows.map((row) => {
    const tags = [];
    if (row.verified) tags.push('<span class="tag ok">verifiziert</span>');
    if (row.suspicious) tags.push('<span class="tag warn">prüfen</span>');
    const profitCls = row.profitPerUnit >= 0 ? 'pos' : 'neg';
    return `<tr>
      <td class="left">${escapeHtml(row.itemName)}${tags.join('')}</td>
      ${cell(fmtMoney(row.buy))}
      ${cell(fmtMoney(row.reference))}
      ${cell(fmtMoney(row.sellNet))}
      ${cell(fmtMoney(row.profitPerUnit), profitCls)}
      ${cell(fmtPct(row.profitPct), profitCls)}
      ${cell(money.format(row.quantity))}
      ${cell(fmtMoney(row.totalProfit), profitCls)}
      <td class="left">${bazaarLink(row)}</td>
    </tr>`;
  }).join('');
}

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

/** Klickbare Spaltenkoepfe; gibt eine Funktion zum Neusetzen der Daten zurueck. */
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
          return asc ? String(x).localeCompare(String(y)) : String(y).localeCompare(String(x));
        }
        return asc ? x - y : y - x;
      });
      onSorted(sorted);
    });
  });
}
