// Adapter fuer die weav3r.dev-API.
//
// Das konkrete Response-Schema ist hier bewusst NICHT fest verdrahtet.
// Die Doku (https://weav3r.dev/api-docs.html) ist die Quelle der Wahrheit,
// und die Endpoint-URL kommt aus den Einstellungen. Der Normalisierer unten
// erkennt die ueblichen Formen selbst; diagnose.html zeigt, was er gefunden hat.

const PRICE_KEYS = ['price', 'cost', 'item_price', 'itemPrice', 'unit_price', 'unitPrice'];
const ITEM_ID_KEYS = ['item_id', 'itemId', 'itemID', 'itemid'];
const QTY_KEYS = ['quantity', 'amount', 'qty', 'available', 'count'];
const PLAYER_KEYS = ['player_id', 'playerId', 'user_id', 'userId', 'userID', 'owner_id', 'ownerId', 'seller_id'];
const NAME_KEYS = ['item_name', 'itemName', 'name', 'title'];

function pick(obj, keys) {
  for (const k of keys) {
    if (obj[k] !== undefined && obj[k] !== null) return obj[k];
  }
  return undefined;
}

function num(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'string') {
    const n = Number(value.replace(/[^0-9.-]/g, ''));
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

// Sammelt alle Arrays aus Objekten, die nach Listings aussehen, samt Pfad.
// numericAncestor merkt sich einen numerischen Schluessel auf dem Weg
// dorthin - bei der Form {"206": [ ... ]} ist das die Item-ID.
function collectListingArrays(node, path = '$', numericAncestor = null, out = [], depth = 0) {
  if (depth > 6 || node === null || typeof node !== 'object') return out;

  if (Array.isArray(node)) {
    const objects = node.filter((e) => e && typeof e === 'object' && !Array.isArray(e));
    if (objects.length && objects.some((e) => pick(e, PRICE_KEYS) !== undefined)) {
      out.push({ path, rows: objects, itemIdFromPath: numericAncestor });
    }
    // Verschachtelte Arrays trotzdem weiterverfolgen.
    node.forEach((e, i) => collectListingArrays(e, `${path}[${i}]`, numericAncestor, out, depth + 1));
    return out;
  }

  for (const [key, value] of Object.entries(node)) {
    const ancestor = /^\d+$/.test(key) ? Number(key) : numericAncestor;
    collectListingArrays(value, `${path}.${key}`, ancestor, out, depth + 1);
  }
  return out;
}

/**
 * Bringt eine beliebige weav3r-Response auf eine einheitliche Listing-Form.
 * @returns {{listings: Array, diagnostics: object}}
 */
export function normalizeBazaar(raw) {
  const found = collectListingArrays(raw);
  const listings = [];
  const seenPaths = [];

  for (const group of found) {
    seenPaths.push({ path: group.path, rows: group.rows.length });
    for (const row of group.rows) {
      const price = num(pick(row, PRICE_KEYS));
      if (price === undefined || price <= 0) continue;

      const itemId = num(pick(row, ITEM_ID_KEYS)) ?? group.itemIdFromPath;
      if (itemId === undefined || itemId === null) continue;

      listings.push({
        itemId: Number(itemId),
        itemName: pick(row, NAME_KEYS) || null,
        price,
        quantity: num(pick(row, QTY_KEYS)) ?? 1,
        playerId: num(pick(row, PLAYER_KEYS)) ?? null,
        raw: row,
      });
    }
  }

  return {
    listings,
    diagnostics: {
      arraysFound: seenPaths,
      listingsParsed: listings.length,
      sampleRow: listings.length ? listings[0].raw : null,
    },
  };
}

function applyAuth(url, headers, settings) {
  const mode = settings.weav3rAuthMode || 'none';
  const key = (settings.weav3rKey || '').trim();
  if (!key || mode === 'none') return;

  if (mode === 'bearer') {
    headers.Authorization = `Bearer ${key}`;
  } else if (mode.startsWith('header:')) {
    headers[mode.slice('header:'.length)] = key;
  } else if (mode.startsWith('query:')) {
    url.searchParams.set(mode.slice('query:'.length), key);
  }
}

/**
 * Ruft den konfigurierten weav3r-Endpoint auf und liefert die Rohantwort.
 * Wirft mit sprechender Meldung, wenn CORS blockt - das ist der wahrscheinlichste
 * Fehlerfall beim Hosten auf github.io.
 */
export async function fetchBazaarRaw(settings, itemId = null) {
  const template = (settings.weav3rUrl || '').trim();
  if (!template) throw new Error('Kein weav3r-Endpoint konfiguriert (siehe Einstellungen).');

  const resolved = itemId === null
    ? template.replace('{ITEM_ID}', '')
    : template.replace('{ITEM_ID}', String(itemId));

  let url;
  try {
    url = new URL(resolved);
  } catch {
    throw new Error(`Ungueltige weav3r-URL: ${resolved}`);
  }

  const headers = { Accept: 'application/json' };
  applyAuth(url, headers, settings);

  let res;
  try {
    res = await fetch(url, { headers });
  } catch (err) {
    throw new Error(
      `Netzwerk-/CORS-Fehler beim Aufruf von ${url.origin}. ` +
      `Wenn weav3r keinen Access-Control-Allow-Origin-Header fuer diese Seite sendet, ` +
      `kann der Browser die Antwort nicht lesen. Details: ${err.message}`
    );
  }

  if (!res.ok) throw new Error(`weav3r antwortete mit HTTP ${res.status}`);

  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Antwort war kein JSON. Erste 200 Zeichen: ${text.slice(0, 200)}`);
  }
}

export async function fetchBazaarListings(settings, itemId = null) {
  const raw = await fetchBazaarRaw(settings, itemId);
  return normalizeBazaar(raw);
}

export function urlNeedsItemId(url) {
  return (url || '').includes('{ITEM_ID}');
}
