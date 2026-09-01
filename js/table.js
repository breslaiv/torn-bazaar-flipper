// Kleiner Tabellenbauer fuer die Ledger-Seite.
//
// Erzeugt dasselbe Markup wie der Scanner - data-label an jeder Zelle - damit
// die Kartenansicht auf dem Handy ohne Zusatzarbeit greift.

import { escapeHtml } from './ui.js?v=13';

/**
 * @param {Array<{key:string,label:string,align?:string,cell:(row)=>({text?:string,html?:string})}>} columns
 * @param {Array<object>} rows
 */
export function tableHtml(columns, rows, { empty = 'Nichts erfasst.' } = {}) {
  const head = `<tr>${columns.map((c) => (
    `<th class="${c.align === 'left' ? 'left' : ''}">${escapeHtml(c.label)}</th>`
  )).join('')}</tr>`;

  if (!rows.length) {
    return {
      head,
      body: `<tr><td colspan="${columns.length}" class="left empty"><span class="val">${escapeHtml(empty)}</span></td></tr>`,
    };
  }

  const body = rows.map((row) => {
    const cells = columns.map((col) => {
      const out = col.cell(row) || {};
      // html nur dort, wo eine Zelle wirklich Markup braucht (Links, Marker).
      // Alles andere laeuft durch escapeHtml.
      const content = out.html !== undefined ? out.html : escapeHtml(out.text ?? '');
      const classes = [col.align === 'left' ? 'left' : 'num'];
      if (out.cls) classes.push(out.cls);
      return `<td class="${classes.join(' ')}" data-label="${escapeHtml(col.label)}">`
        + `<span class="val">${content}</span></td>`;
    }).join('');
    return `<tr>${cells}</tr>`;
  }).join('');

  return { head, body };
}

export function renderTable(tableId, columns, rows, opts) {
  const table = document.getElementById(tableId);
  if (!table) return;
  const { head, body } = tableHtml(columns, rows, opts);
  table.querySelector('thead').innerHTML = head;
  table.querySelector('tbody').innerHTML = body;
}
