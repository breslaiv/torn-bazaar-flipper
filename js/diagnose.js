import { loadSettings, saveSettings } from './storage.js?v=14';
import {
  fetchHealth, fetchMarketplace, fetchItemListings, fetchItemTraders, fetchDollarItems,
  probe, TRAVEL_CANDIDATES,
} from './weav3r.js?v=14';
import { fetchKeyInfo } from './torn.js?v=14';
import { fetchTravelStocks, travelUrl } from './yata.js?v=14';
import { probeUrl, PROMETHEUS_BASE, PROMETHEUS_CANDIDATES } from './probe.js?v=14';
import { countryName } from './travel.js?v=14';
import { setStatus, fmtMoney, showVersion } from './ui.js?v=14';

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

/**
 * Der wichtigste Check dieser Seite, weil sein Ausgang nicht vorhersagbar
 * war: YATA ist eine fremde Seite, und ob sie Browser-Zugriffe von hier
 * erlaubt, entscheidet allein deren Server.
 */
async function testYata() {
  reset();
  emit(`Origin dieser Seite : ${location.origin}`);
  emit(`Ziel                : ${travelUrl({ yataUrl: loadSettings().yataUrl })}`);
  emit();
  setStatus('Frage yata.yt…');

  const ok = await check('GET yata.yt/api/v1/travel/export/', async () => {
    const { countries, updated, unknown } = await fetchTravelStocks({ settings: loadSettings() });
    const lines = [`${countries.size} Länder mit Vorräten`];
    for (const [code, items] of countries) {
      const stamp = updated.get(code);
      const withStock = items.filter((i) => Number.isFinite(i.quantity)).length;
      lines.push(`      ${countryName(code).padEnd(16)} ${String(items.length).padStart(3)} Items, `
        + `${withStock} mit Mengenangabe`
        + (stamp ? `, Stand ${new Date(stamp).toLocaleTimeString('de-DE')}` : ', ohne Zeitstempel'));
    }
    if (unknown.length) lines.push(`      nicht zugeordnet: ${unknown.join(', ')}`);
    return lines.join('\n');
  });

  emit();
  if (ok) {
    emit('YATA lässt sich vom Browser aus lesen — der Flugplaner bekommt seine Vorräte.');
  } else {
    emit('Kommt hier ein Netzwerkfehler und zeigt dieselbe URL in einem normalen Tab');
    emit('trotzdem JSON, dann fehlt der CORS-Header für diese Origin. YATA entscheidet');
    emit('das, nicht diese App. Der Flugplaner rechnet dann mit von Hand erfassten');
    emit('Vorräten weiter — Preise und Zeiten bleiben davon unberührt.');
  }
  setStatus(ok ? 'YATA erreichbar.' : 'YATA nicht erreichbar — Details im Bericht.', ok ? 'ok' : 'error');
}

/**
 * Sucht bei weav3r nach einer Route fuer Auslandsvorraete.
 *
 * Die Website zeigt sie an, die uns vorliegende Spec kennt keine. Statt zu
 * raten, fragen wir eine Handvoll naheliegender Pfade ab und zeigen roh, was
 * zurueckkommt - Status, oberste Schluessel, Anfang der Antwort. Daraus
 * laesst sich ablesen, ob eine davon passt.
 */
async function findTravelRoutes() {
  const settings = loadSettings();
  reset();
  emit('Sucht bei weav3r nach einer Route für Auslandsvorräte.');
  emit(`Basis: ${settings.weav3rKey ? 'mit Key' : 'ohne Key'}, ${TRAVEL_CANDIDATES.length} Pfade.`);
  emit();
  setStatus('Suche Routen…');

  // Gegenprobe zuerst: eine Route, von der wir wissen, dass sie antwortet.
  // Ohne sie laesst sich "Pfad gibt es nicht" nicht von "Host nicht
  // erreichbar" unterscheiden - beides meldet der Browser gleich.
  const control = await probe('/health', settings);
  emit(control.error
    ? `  ${'/health (Kontrolle)'.padEnd(22)} Fehler: ${control.error}`
    : `  ${'/health (Kontrolle)'.padEnd(22)} ${String(control.status).padStart(3)}  ✓ erreichbar`);
  emit();

  const treffer = [];
  for (const path of TRAVEL_CANDIDATES) {
    const r = await probe(path, settings);
    if (r.error) {
      emit(`  ${r.path.padEnd(22)} Fehler: ${r.error}`);
      continue;
    }
    emit(`  ${r.path.padEnd(22)} ${String(r.status).padStart(3)}${r.ok ? '  ✓' : ''}`);
    if (r.ok) {
      treffer.push(r);
      if (r.keys.length) emit(`     Schlüssel: ${r.keys.join(', ')}`);
    }
  }

  emit();
  if (!treffer.length) {
    if (!control.error) {
      // Der aussagekraeftige Fall: der Host antwortet, diese Pfade nicht.
      emit('weav3r ist erreichbar (siehe Kontrolle), aber keiner der geratenen Pfade');
      emit('liefert eine lesbare Antwort. Das spricht dafür, dass es sie nicht gibt:');
      emit('eine 404-Antwort ohne CORS-Header sieht im Browser wie ein Netzwerkfehler');
      emit('aus, weil fetch nicht einmal ihren Status lesen darf.');
    } else {
      emit('Auch die Kontrolle scheitert — dann liegt es nicht an den Pfaden,');
      emit('sondern am Zugriff auf weav3r insgesamt (Adblocker, Netz, Ausfall).');
    }
    emit();
    emit('Zwei Wege weiter:');
    emit('1. Workflow „Quellen abklopfen" in GitHub Actions — der sieht echte');
    emit('   Statuscodes, weil CORS dort nicht gilt.');
    emit('2. Die Seite mit den Auslandsvorräten im Desktop-Browser öffnen,');
    emit('   Entwicklertools → Netzwerk → Filter XHR, neu laden — dort steht die');
    emit('   Adresse, die die Seite selbst aufruft.');
    setStatus('Keine Route gefunden — Bericht kopieren und schicken.', 'error');
    return;
  }

  for (const r of treffer) {
    emit(`--- Antwort von ${r.path} ---`);
    emit(r.sample);
    emit();
  }
  setStatus(`${treffer.length} mögliche Route(n) — Bericht kopieren und schicken.`, 'ok');
}

/**
 * Klopft Prometheus ab - die zweite Sammelstelle fuer Auslandsvorraete neben
 * YATA. Dass es sie gibt, ist belegt; unter welcher Adresse sie Daten
 * herausgibt, nicht. Also fragen wir nach, statt zu raten.
 */
async function findPrometheus() {
  reset();
  emit(`Klopft ${PROMETHEUS_BASE} ab — ${PROMETHEUS_CANDIDATES.length} Pfade.`);
  emit('Prometheus sammelt Auslandsvorräte wie YATA und dient TornTools als Ausweichquelle.');
  emit();
  setStatus('Frage Prometheus…');

  const treffer = [];
  for (const path of PROMETHEUS_CANDIDATES) {
    const r = await probeUrl(`${PROMETHEUS_BASE}${path}`);
    if (r.error) {
      emit(`  ${path.padEnd(24)} Fehler: ${r.error}`);
      continue;
    }
    emit(`  ${path.padEnd(24)} ${String(r.status).padStart(3)}${r.ok ? '  ✓' : ''}`);
    if (r.ok) {
      treffer.push(r);
      if (r.keys.length) emit(`     Schlüssel: ${r.keys.join(', ')}`);
    }
  }

  emit();
  for (const r of treffer) {
    emit(`--- Antwort von ${r.path} ---`);
    emit(r.sample);
    emit();
  }

  if (!treffer.length) {
    emit('Kein Pfad antwortet. Wichtig zu wissen, was das beweist — und was nicht:');
    emit();
    emit('Ohne CORS-Freigabe darf der Browser nicht einmal den Status einer fremden');
    emit('Antwort lesen. Ein 404 sieht hier deshalb genauso aus wie eine Blockade.');
    emit('Belegt ist also nur: von dieser Seite aus ist Prometheus nicht lesbar.');
    emit('Ob es die Pfade gibt, sagt dieser Bericht nicht.');
    emit();
    emit('Der Sammler läuft aber serverseitig in GitHub Actions, und dort gilt CORS');
    emit('nicht. Der Workflow „Quellen abklopfen" fragt dieselben Pfade von dort ab');
    emit('und zeigt die echten Statuscodes — findet er eine Route, kann der Sammler');
    emit('sie nutzen, auch wenn diese Seite selbst nie an sie herankäme.');
  }
  setStatus(treffer.length
    ? `${treffer.length} mögliche Route(n) — Bericht kopieren und schicken.`
    : 'Nichts gefunden — Bericht kopieren und schicken.', treffer.length ? 'ok' : 'error');
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
  document.getElementById('testYata').addEventListener('click', testYata);
  document.getElementById('findTravel').addEventListener('click', findTravelRoutes);
  document.getElementById('findPrometheus').addEventListener('click', findPrometheus);
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
