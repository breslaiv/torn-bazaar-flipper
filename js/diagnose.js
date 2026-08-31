import { loadSettings, saveSettings } from './storage.js?v=2';
import { fetchHealth, fetchMarketplace, fetchItemListings, fetchItemTraders, fetchDollarItems } from './weav3r.js?v=2';
import { fetchKeyInfo } from './torn.js?v=2';
import { setStatus, fmtMoney, showVersion } from './ui.js?v=2';

const reportEl = document.getElementById('report');
const lines = [];

function emit(line = '') {
  lines.push(line);
  reportEl.textContent = lines.join('\n');
}

function reset() {
  lines.length = 0;
  reportEl.textContent = '';
}

/** Fuehrt einen Check aus und protokolliert Dauer und Ergebnis einheitlich. */
async function check(label, fn) {
  const started = performance.now();
  try {
    const summary = await fn();
    emit(`OK    ${label}  (${Math.round(performance.now() - started)} ms)`);
    if (summary) emit(`      ${summary}`);
    return true;
  } catch (err) {
    emit(`FEHLT ${label}`);
    emit(`      ${err.message}`);
    return false;
  }
}

async function runAll() {
  const settings = saveSettings({
    ...loadSettings(),
    weav3rKey: document.getElementById('weav3rKey').value.trim(),
  });
  const itemId = Number(document.getElementById('testItemId').value) || 206;

  reset();
  emit(`Origin dieser Seite : ${location.origin}`);
  emit(`Test-Item           : ${itemId}`);
  emit(`weav3r-Key gesetzt  : ${settings.weav3rKey ? 'ja' : 'nein (für diese Routen nicht nötig)'}`);
  emit();

  setStatus('Teste Routen…');

  const reachable = await check('GET /health', async () => {
    const h = await fetchHealth(settings);
    return `status=${h.status}`;
  });

  if (!reachable) {
    emit();
    emit('Schon /health ist nicht durchgekommen. Wenn dieselbe URL in einem normalen');
    emit('Browser-Tab JSON anzeigt, hier aber scheitert, fehlt der CORS-Header für');
    emit('diese Origin — dann brauchen wir einen Proxy oder den GitHub-Actions-Weg.');
    emit('Ein Adblocker, der weav3r.dev blockt, sieht genauso aus.');
    setStatus('weav3r nicht erreichbar — Details im Bericht.', 'error');
    return;
  }

  await check('GET /marketplace', async () => {
    const { items, generatedAt } = await fetchMarketplace(settings);
    const withBazaar = items.filter((i) => i.lowestPrice > 0).length;
    const sample = items.find((i) => i.itemId === itemId) || items[0];
    return `${items.length} Items, davon ${withBazaar} mit Bazaar-Listing`
      + `${generatedAt ? `, generiert ${new Date(generatedAt * 1000).toLocaleTimeString('de-DE')}` : ''}`
      + (sample ? `\n      Beispiel: ${sample.itemName} — Markt ${fmtMoney(sample.marketPrice)}, billigstes ${fmtMoney(sample.lowestPrice)}` : '');
  });

  await check(`GET /marketplace/${itemId}`, async () => {
    const res = await fetchItemListings(itemId, settings);
    if (!res.listings.length) return `${res.itemName}: keine Listings`;
    const l = res.listings[0];
    return `${res.itemName}: ${res.listings.length} Listings, billigstes ${fmtMoney(l.price)} `
      + `x${l.quantity} von ${l.playerName ?? l.playerId}`;
  });

  await check(`GET /marketplace/${itemId}/traders`, async () => {
    const res = await fetchItemTraders(itemId, settings);
    if (!res.traders.length) return 'keine aktiven Käufer für dieses Item';
    const t = res.traders[0];
    return `${res.traders.length} Käufer, bester ${fmtMoney(t.price)} von ${t.playerName} `
      + `(+${t.upvotes}/-${t.downvotes})`;
  });

  await check('GET /dollar-bazaars/items', async () => {
    const items = await fetchDollarItems(settings, { page: 1, limit: 10 });
    if (!items.length) return 'gerade keine $1-Items gelistet';
    const best = items.reduce((a, b) => (b.marketPrice > a.marketPrice ? b : a), items[0]);
    return `${items.length} Items, wertvollstes ${best.itemName} zu ${fmtMoney(best.marketPrice)}`;
  });

  emit();
  emit('Alle Routen durch. Wenn oben nur OK steht, läuft die App direkt auf GitHub Pages —');
  emit('ohne Proxy und ohne Backend.');
  setStatus('Fertig.', 'ok');
}

async function testTorn() {
  const settings = loadSettings();
  reset();
  if (!settings.tornKey) {
    emit('Kein Torn-Key gespeichert. Er ist optional und schaltet nur die');
    emit('Item-Market-Gegenprobe frei — trag ihn im Scanner unter Einstellungen ein.');
    setStatus('Kein Torn-Key hinterlegt.', '');
    return;
  }
  setStatus('Prüfe Torn-Key…');
  await check('GET api.torn.com/v2/key/info', async () => {
    const info = await fetchKeyInfo(settings.tornKey);
    const access = info?.info?.access?.type ?? info?.access?.type ?? 'unbekannt';
    return `Zugriffslevel: ${access}`;
  });
  setStatus('Fertig.', 'ok');
}

function init() {
  showVersion();
  document.getElementById('weav3rKey').value = loadSettings().weav3rKey;
  document.getElementById('runAll').addEventListener('click', runAll);
  document.getElementById('testTorn').addEventListener('click', testTorn);
  document.getElementById('copyReport').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(reportEl.textContent);
      setStatus('Bericht in der Zwischenablage.', 'ok');
    } catch {
      setStatus('Kopieren wurde vom Browser blockiert — bitte manuell markieren.', 'error');
    }
  });
}

init();
