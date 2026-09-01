// Merkt sich, welche Aufklapper offen waren.
//
// Die Seiten bestehen aus einer Reihe von <details>-Kaesten. Wer die
// Flug-Seite offen hat und den Vorratsverlauf ansieht, klappt ihn beim
// naechsten Besuch wieder auf - jedes Mal, an derselben Stelle. Auf dem Handy
// ist das jedes Mal ein Stueck Scrollen dazu.
//
// Bewusst ein eigener Speicherschluessel, nicht in den Einstellungen: das hier
// ist Bedienzustand, kein Wert, der in einen Export gehoert.

const KEY = 'tbf.panels.v1';

function read(storage) {
  try {
    const raw = storage.getItem(KEY);
    const data = raw ? JSON.parse(raw) : {};
    return data && typeof data === 'object' ? data : {};
  } catch {
    // Kaputter oder gesperrter Speicher darf die Seite nicht aufhalten - die
    // Kaesten stehen dann eben so, wie das Markup sie vorgibt.
    return {};
  }
}

function write(storage, data) {
  try {
    storage.setItem(KEY, JSON.stringify(data));
  } catch {
    // Privater Modus in Safari: Schreiben wirft. Kein Grund fuer eine Meldung.
  }
}

/** Schluessel je Seite, damit gleichnamige Kaesten sich nicht ins Gehege kommen. */
export function panelKey(page, id) {
  return `${page}:${id}`;
}

/**
 * Liest den gemerkten Zustand fuer eine Seite.
 * @returns {Map<string, boolean>} id -> offen
 */
export function loadPanelState(page, storage = globalThis.localStorage) {
  if (!storage) return new Map();
  const data = read(storage);
  const out = new Map();
  for (const [key, open] of Object.entries(data)) {
    const [p, id] = splitKey(key);
    if (p === page && id) out.set(id, Boolean(open));
  }
  return out;
}

export function setPanelState(page, id, open, storage = globalThis.localStorage) {
  if (!storage || !id) return;
  const data = read(storage);
  data[panelKey(page, id)] = Boolean(open);
  write(storage, data);
}

/**
 * Haengt sich an alle <details> mit id auf der Seite.
 *
 * @param {object} opts
 *   page      - Name der Seite, meist der Dateiname
 *   defaults  - id -> offen, falls nichts gemerkt ist. Was hier fehlt, behaelt
 *               den Zustand aus dem Markup.
 */
export function restorePanels({ page, root = document, storage = globalThis.localStorage, defaults = {} } = {}) {
  const state = loadPanelState(page, storage);
  const panels = [...root.querySelectorAll('details[id]')];

  for (const el of panels) {
    if (state.has(el.id)) el.open = state.get(el.id);
    else if (el.id in defaults) el.open = Boolean(defaults[el.id]);

    el.addEventListener('toggle', () => setPanelState(page, el.id, el.open, storage));
  }
  return panels.length;
}

function splitKey(key) {
  const at = key.indexOf(':');
  return at === -1 ? [key, ''] : [key.slice(0, at), key.slice(at + 1)];
}
