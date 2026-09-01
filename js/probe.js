// Fremde Adressen abklopfen, ohne sie zu deuten.
//
// Fuer Auslandsvorraete gibt es in Torn mehrere Sammelstellen - YATA,
// Prometheus (prombot.co.uk), moeglicherweise weav3r. Welche davon eine
// Schnittstelle anbietet und unter welcher Adresse, steht nirgends
// vollstaendig geschrieben, und aus der Entwicklungsumgebung heraus laesst es
// sich nicht pruefen: dort sind fremde Hosts gesperrt.
//
// Der Browser des Nutzers erreicht sie. Also fragt die Diagnose-Seite dort
// nach und zeigt roh, was zurueckkommt - Status, oberste Schluessel, Anfang
// der Antwort. Was das bedeutet, entscheidet sich, wenn man es sieht.

/** Beschreibt eine Antwort, statt sie zu interpretieren. */
export async function probeUrl(url, { signal } = {}) {
  const path = String(url).replace(/^https?:\/\/[^/]+/, '') || '/';
  try {
    const res = await fetch(url, { headers: { Accept: 'application/json' }, signal });
    const text = (await res.text()).slice(0, 4000);

    let keys = [];
    try {
      const data = JSON.parse(text);
      if (Array.isArray(data)) keys = [`Array mit ${data.length} Einträgen`];
      else if (data && typeof data === 'object') keys = Object.keys(data).slice(0, 12);
    } catch { /* kein JSON - der Status allein ist auch eine Auskunft */ }

    return { path, url, status: res.status, ok: res.ok, keys, sample: text.slice(0, 240), error: null };
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    return { path, url, status: 0, ok: false, keys: [], sample: '', error: err.message };
  }
}

/**
 * Prometheus sammelt Auslandsvorraete wie YATA und dient TornTools als
 * Ausweichquelle. Eine oeffentliche Doku ist nicht auffindbar, also werden
 * die ueblichen Formen durchprobiert.
 */
export const PROMETHEUS_BASE = 'https://prombot.co.uk';

export const PROMETHEUS_CANDIDATES = [
  '/api/travel/export',
  '/api/travel/stocks',
  '/api/travel',
  '/api/stocks',
  '/api/stock',
  '/api/abroad',
  '/api/v1/travel/export',
  '/api/v1/travel',
  '/api/v1/stocks',
  '/travel/export',
  '/stocks.json',
  '/api',
];
