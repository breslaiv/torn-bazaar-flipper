import { loadSettings, saveSettings } from './storage.js';
import { normalizeBazaar, urlNeedsItemId } from './weav3r.js';
import { fetchKeyInfo } from './torn.js';
import { setStatus } from './ui.js';

const reportEl = document.getElementById('report');

function write(lines) {
  reportEl.textContent = lines.join('\n');
}

function truncate(obj, max = 4000) {
  const s = JSON.stringify(obj, null, 2);
  return s.length > max ? `${s.slice(0, max)}\n... (${s.length - max} Zeichen gekuerzt)` : s;
}

function buildUrl(settings, itemId) {
  const resolved = (settings.weav3rUrl || '').replace('{ITEM_ID}', String(itemId));
  const url = new URL(resolved);
  const mode = settings.weav3rAuthMode;
  const key = (settings.weav3rKey || '').trim();
  const headers = { Accept: 'application/json' };

  if (key && mode !== 'none') {
    if (mode === 'bearer') headers.Authorization = `Bearer ${key}`;
    else if (mode.startsWith('header:')) headers[mode.slice('header:'.length)] = key;
    else if (mode.startsWith('query:')) url.searchParams.set(mode.slice('query:'.length), key);
  }
  return { url, headers };
}

async function testWeav3r() {
  const settings = saveSettings({
    ...loadSettings(),
    weav3rUrl: document.getElementById('weav3rUrl').value.trim(),
    weav3rKey: document.getElementById('weav3rKey').value.trim(),
    weav3rAuthMode: document.getElementById('weav3rAuthMode').value,
  });

  if (!settings.weav3rUrl) {
    setStatus('Bitte erst eine Endpoint-URL eintragen.', 'error');
    return;
  }

  const itemId = Number(document.getElementById('testItemId').value) || 206;
  const lines = [];
  let url;
  let headers;
  try {
    ({ url, headers } = buildUrl(settings, itemId));
  } catch (err) {
    write([`URL ist ungueltig: ${err.message}`]);
    return;
  }

  const shown = settings.weav3rKey
    ? url.toString().split(settings.weav3rKey).join('***')
    : url.toString();

  lines.push(`Origin dieser Seite : ${location.origin}`);
  lines.push(`Angefragte URL      : ${shown}`);
  lines.push(`Pro-Item-Modus      : ${urlNeedsItemId(settings.weav3rUrl) ? 'ja ({ITEM_ID} vorhanden)' : 'nein (Sammelendpoint)'}`);

  // Ein Custom-Header erzwingt einen CORS-Preflight; das ist die haeufigste
  // Ursache dafuer, dass ein sonst offener Endpoint im Browser scheitert.
  const custom = Object.keys(headers).filter((h) => h !== 'Accept');
  lines.push(`Zusatz-Header       : ${custom.length ? `${custom.join(', ')} (loest CORS-Preflight aus)` : 'keine'}`);
  lines.push('');

  setStatus('Frage weav3r ab...');
  let res;
  const started = performance.now();
  try {
    res = await fetch(url, { headers });
  } catch (err) {
    lines.push('ERGEBNIS: fetch() ist geworfen - die Antwort war fuer den Browser nicht lesbar.');
    lines.push(`Fehler: ${err.message}`);
    lines.push('');
    lines.push('Das bedeutet fast immer eines von beidem:');
    lines.push('  a) weav3r sendet keinen Access-Control-Allow-Origin-Header fuer diese Origin, oder');
    lines.push('  b) der Preflight (OPTIONS) wird abgelehnt, weil wir einen Zusatz-Header senden.');
    lines.push('');
    lines.push('Gegenprobe: wenn die URL in einem normalen Browser-Tab direkt JSON zeigt, hier aber');
    lines.push('scheitert, ist es definitiv CORS - dann brauchen wir einen Proxy oder den');
    lines.push('GitHub-Actions-Weg.');
    write(lines);
    setStatus('CORS- oder Netzwerkfehler - Details im Bericht.', 'error');
    return;
  }

  const ms = Math.round(performance.now() - started);
  lines.push(`HTTP-Status         : ${res.status} ${res.statusText} (${ms} ms)`);
  lines.push(`Response-Typ        : ${res.type}`);

  const exposed = [];
  res.headers.forEach((v, k) => exposed.push(`  ${k}: ${v}`));
  lines.push('Sichtbare Header    :');
  lines.push(exposed.length ? exposed.join('\n') : '  (keine - der Server exponiert sie nicht via CORS)');
  lines.push('');

  const text = await res.text();
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    lines.push('Antwort ist kein JSON. Erste 800 Zeichen:');
    lines.push(text.slice(0, 800));
    write(lines);
    setStatus('Antwort war kein JSON.', 'error');
    return;
  }

  const { listings, diagnostics } = normalizeBazaar(raw);
  lines.push('--- Was der Normalisierer erkannt hat ---');
  lines.push(`Listing-Arrays      : ${JSON.stringify(diagnostics.arraysFound)}`);
  lines.push(`Geparste Listings   : ${diagnostics.listingsParsed}`);
  if (listings.length) {
    const { raw: _rawRow, ...first } = listings[0];
    lines.push(`Erstes Listing      : ${JSON.stringify(first)}`);
  } else {
    lines.push('Keine Listings erkannt - die Feldnamen weichen ab. Rohantwort unten weitergeben.');
  }
  lines.push('');
  lines.push('--- Rohantwort (gekuerzt) ---');
  lines.push(truncate(raw));

  write(lines);
  setStatus(
    listings.length ? `OK - ${listings.length} Listings erkannt.` : 'Erreichbar, aber Schema unbekannt.',
    listings.length ? 'ok' : 'error',
  );
}

async function testTorn() {
  const settings = loadSettings();
  if (!settings.tornKey) {
    setStatus('Kein Torn-Key gespeichert - trag ihn im Scanner unter Einstellungen ein.', 'error');
    return;
  }
  setStatus('Pruefe Torn-Key...');
  try {
    const info = await fetchKeyInfo(settings.tornKey);
    write([
      'Torn API v2 ist vom Browser aus erreichbar (CORS ok).',
      '',
      truncate(info, 2000),
    ]);
    setStatus('Torn-Key funktioniert.', 'ok');
  } catch (err) {
    write([`Torn-Key-Test fehlgeschlagen: ${err.message}`]);
    setStatus('Torn-Key-Test fehlgeschlagen.', 'error');
  }
}

function init() {
  const settings = loadSettings();
  document.getElementById('weav3rUrl').value = settings.weav3rUrl;
  document.getElementById('weav3rKey').value = settings.weav3rKey;
  document.getElementById('weav3rAuthMode').value = settings.weav3rAuthMode;

  document.getElementById('testWeav3r').addEventListener('click', testWeav3r);
  document.getElementById('testTorn').addEventListener('click', testTorn);
  document.getElementById('copyReport').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(reportEl.textContent);
      setStatus('Bericht in der Zwischenablage.', 'ok');
    } catch {
      setStatus('Kopieren wurde vom Browser blockiert - bitte manuell markieren.', 'error');
    }
  });
}

init();
