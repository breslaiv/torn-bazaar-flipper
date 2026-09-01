#!/usr/bin/env node
// Klopft Vorratsquellen serverseitig ab.
//
// Der Browser kann das nur eingeschraenkt: fehlt einer fremden Antwort die
// CORS-Freigabe, darf fetch nicht einmal ihren Status lesen. Ein 404 ohne
// Freigabe und eine echte Blockade sehen dort identisch aus - beides meldet
// sich als "Load failed". Genau das ist beim Abklopfen von prombot.co.uk
// passiert: zwoelfmal derselbe Fehler, ohne Auskunft darueber, ob es die
// Pfade ueberhaupt gibt.
//
// In GitHub Actions gibt es diese Beschraenkung nicht - CORS ist eine Regel
// des Browsers, nicht des Netzes. Hier steht deshalb der echte Status, der
// Inhaltstyp und der Anfang der Antwort. Und falls eine Route existiert,
// koennte der Sammler sie serverseitig nutzen, auch wenn die Seite selbst nie
// an sie herankaeme.
//
// Aufruf:  node tools/probe-travel.mjs

import { PROMETHEUS_BASE, PROMETHEUS_CANDIDATES } from '../js/probe.js';
import { TRAVEL_CANDIDATES } from '../js/weav3r.js';
import { WEAV3R_BASE, TORN_API_BASE } from '../js/config.js';

const TIMEOUT_MS = 12000;

const TARGETS = [
  { name: 'Prometheus', base: PROMETHEUS_BASE, paths: PROMETHEUS_CANDIDATES },
  { name: 'weav3r', base: WEAV3R_BASE, paths: TRAVEL_CANDIDATES },
  // Als Gegenprobe eine Route, von der wir wissen, dass sie antwortet: sonst
  // laesst sich ein Netzproblem nicht von einem leeren Ergebnis unterscheiden.
  { name: 'Gegenprobe', base: WEAV3R_BASE, paths: ['/health'] },
];

async function probe(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { Accept: 'application/json', 'User-Agent': 'torn-bazaar-flipper/quellensuche' },
      signal: controller.signal,
      redirect: 'follow',
    });
    const text = (await res.text()).slice(0, 4000);
    return {
      status: res.status,
      ok: res.ok,
      type: (res.headers.get('content-type') || '').split(';')[0] || '—',
      // Wenn der Header hier steht, koennte auch der Browser lesen.
      cors: res.headers.get('access-control-allow-origin') || null,
      length: text.length,
      sample: text.replace(/\s+/g, ' ').slice(0, 200),
    };
  } catch (err) {
    return { status: 0, ok: false, error: err.name === 'AbortError' ? 'Zeitüberschreitung' : err.message };
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  const found = [];

  for (const target of TARGETS) {
    console.log(`\n=== ${target.name} (${target.base}) ===`);
    for (const path of target.paths) {
      const url = `${target.base}${path}`;
      const r = await probe(url);

      if (r.error) {
        console.log(`  ${path.padEnd(24)} —    ${r.error}`);
        continue;
      }
      const cors = r.cors ? `CORS ${r.cors}` : 'ohne CORS-Freigabe';
      console.log(`  ${path.padEnd(24)} ${String(r.status).padStart(3)}  ${r.type.padEnd(18)} ${cors}`);
      if (r.ok && /json/i.test(r.type)) {
        found.push({ target: target.name, url, ...r });
        console.log(`      ${r.sample}`);
      }
    }
  }

  console.log('\n=== Ergebnis ===');
  if (!found.length) {
    console.log('Keine der geratenen Routen liefert JSON.');
    console.log('Ein 404 hier bedeutet: den Pfad gibt es wirklich nicht — anders als im');
    console.log('Browser, wo dieselbe Antwort ohne CORS-Freigabe wie ein Netzfehler aussieht.');
    return;
  }
  for (const f of found) {
    console.log(`${f.target}: ${f.url}`);
    console.log(`  ${f.cors ? 'auch aus dem Browser lesbar' : 'nur serverseitig lesbar (keine CORS-Freigabe)'}`);
  }
}

main().catch((err) => {
  console.error(`Abklopfen fehlgeschlagen: ${err.message}`);
  process.exit(1);
});
