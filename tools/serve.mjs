#!/usr/bin/env node
// Der lokale Webserver.
//
// Liefert dieselben Seiten aus, die auf GitHub Pages liegen - nur kommt
// data/travel-stock.json nicht aus einer Datei, sondern aus der Datenbank, die
// der Sammler nebenan fuellt. Damit laeuft die Flug-Seite lokal, ohne dass im
// Browser eine Zeile anders sein muesste: sie fragt dieselbe Adresse ab und
// bekommt dieselbe Form zurueck, nur dichter und aktueller.
//
// Bindet standardmaessig nur an 127.0.0.1. Wer vom Telefon darauf will, legt
// Tailscale darueber - dann ist der Dienst fuer die eigenen Geraete da und
// nicht fuer jeden im WLAN. --host 0.0.0.0 gibt es, aber es ist bewusst nicht
// die Vorgabe.
//
// Aufruf:  node tools/serve.mjs [--port 8080] [--host 127.0.0.1]
//                               [--db data/local/stock.db] [--root .]

import { createServer as createHttpServer } from 'node:http';
import { createReadStream, statSync } from 'node:fs';
import { resolve, sep, extname, join } from 'node:path';
import { gzipSync } from 'node:zlib';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.ndjson': 'application/x-ndjson; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
};

export function contentTypeFor(path) {
  return TYPES[extname(path).toLowerCase()] || 'application/octet-stream';
}

/**
 * Uebersetzt einen URL-Pfad in einen Dateipfad - oder in null.
 *
 * Der ganze Zweck dieser Funktion ist die letzte Zeile: alles, was nach dem
 * Aufloesen nicht mehr unterhalb der Wurzel liegt, wird abgelehnt. "../"
 * bleibt sonst ein Leseschluessel fuer die ganze Platte, und %2e%2e sieht im
 * Log harmlos aus.
 */
export function resolveSafe(root, urlPath) {
  let decoded;
  try {
    decoded = decodeURIComponent(urlPath.split('?')[0]);
  } catch {
    return null;                       // kaputte Prozentkodierung
  }
  if (decoded.includes('\0')) return null;

  const base = resolve(root);
  const clean = decoded === '/' ? '/index.html' : decoded;
  const full = resolve(base, `.${clean.startsWith('/') ? clean : `/${clean}`}`);

  if (full !== base && !full.startsWith(base + sep)) return null;
  return full;
}

/** Versionierte Dateien duerfen fuer immer im Cache liegen - die URL aendert sich mit. */
export function cacheHeaderFor(url) {
  return /[?&]v=/.test(url) ? 'public, max-age=31536000, immutable' : 'no-cache';
}

// Unterhalb eines Netzpakets bringt Packen nichts und kostet nur Rechenzeit.
const GZIP_AB = 1400;

/**
 * Antwortet mit JSON, gepackt wenn der Client es kann.
 *
 * Die Messreihen sind lange Ziffernfolgen und lassen sich dadurch etwa auf ein
 * Fuenftel druecken (gemessen: 387 kB roh, 70 kB gepackt). Das ist der Grund,
 * warum der Server ueberhaupt mehr Historie ausliefern darf, ohne dass der
 * Aufruf vom Telefon ueber Tailscale zaeh wird.
 *
 * gzipSync blockiert kurz, und das ist hier richtig so: ein einzelner Nutzer
 * auf der eigenen Maschine, ein paar Millisekunden je Abruf. Ein Stream waere
 * mehr Bewegteile fuer nichts.
 */
const json = (res, status, body, req = null) => {
  const roh = Buffer.from(JSON.stringify(body));
  const kopf = {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-cache',
    // Ohne Vary koennte ein Zwischenspeicher die gepackte Fassung an einen
    // Client geben, der sie nicht auspacken kann.
    Vary: 'Accept-Encoding',
  };

  const kannGzip = /\bgzip\b/.test(req?.headers?.['accept-encoding'] || '');
  const nutzlast = kannGzip && roh.length >= GZIP_AB ? gzipSync(roh) : roh;
  if (nutzlast !== roh) kopf['Content-Encoding'] = 'gzip';

  kopf['Content-Length'] = nutzlast.length;
  res.writeHead(status, kopf);
  res.end(nutzlast);
};

/** Der einzige Pfad, der etwas entgegennimmt. */
export const BEOBACHTUNG_PFAD = '/api/beobachtung';

/** Groesser als das kann eine Beobachtung nicht sein - alles andere ist Unfug. */
const MAX_KOERPER = 4096;

/**
 * Liest einen JSON-Koerper, oder wirft.
 *
 * Die Groessengrenze ist kein Feinschliff: ohne sie haelt ein einziger
 * Aufruf den Speicher des Servers auf, solange jemand sendet.
 */
function leseJson(req) {
  return new Promise((resolve, reject) => {
    let laenge = 0;
    const teile = [];
    req.on('data', (stueck) => {
      laenge += stueck.length;
      if (laenge > MAX_KOERPER) {
        reject(new Error('Koerper zu gross'));
        req.destroy();
        return;
      }
      teile.push(stueck);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(teile).toString('utf8') || 'null'));
      } catch {
        reject(new Error('kein gueltiges JSON'));
      }
    });
    req.on('error', reject);
  });
}

/**
 * @param {object} opts
 *   root         Verzeichnis, aus dem ausgeliefert wird
 *   stock        () => Nutzlast fuer data/travel-stock.json, oder null
 *   health       () => Objekt fuer /health
 *   beobachtung  (wert) => Ergebnis, oder null - nimmt eigene Messungen entgegen
 */
export function createServer({ root = '.', stock = null, health = null, beobachtung = null } = {}) {
  return createHttpServer((req, res) => {
    const path = (req.url || '/').split('?')[0];

    // Der Dienst beantwortete bisher ausschliesslich GET, und das war eine
    // Sicherheitseigenschaft. Aufgegeben wird sie so eng wie moeglich: genau
    // ein Pfad, genau eine Methode.
    if (req.method === 'POST' && beobachtung && path === BEOBACHTUNG_PFAD) {
      // application/json erzwingt im Browser einen Preflight, und den
      // beantwortet dieser Server nicht. Damit kann keine fremde Seite
      // ungefragt in die Messreihe schreiben, obwohl der Dienst im Tailnet
      // erreichbar ist. Die Pruefung ist also kein Formalismus.
      const typ = String(req.headers['content-type'] || '').split(';')[0].trim();
      if (typ !== 'application/json') {
        return json(res, 415, { error: 'Content-Type application/json erwartet' }, req);
      }

      return leseJson(req).then(
        (koerper) => {
          try {
            const ergebnis = beobachtung(koerper);
            return json(res, ergebnis.ok ? 200 : 400, ergebnis, req);
          } catch (err) {
            return json(res, 500, { ok: false, error: err.message }, req);
          }
        },
        (err) => json(res, 400, { ok: false, error: err.message }, req),
      );
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return json(res, 405, { error: 'nur GET' }, req);
    }

    // Aus der Datenbank statt von der Platte. Der Pfad ist derselbe, den die
    // Seite auf GitHub Pages abfragt.
    if (stock && (path === '/data/travel-stock.json' || path === '/data/travel-stock.json/')) {
      try {
        return json(res, 200, stock(), req);
      } catch (err) {
        return json(res, 500, { error: err.message }, req);
      }
    }

    if (health && path === '/health') {
      try {
        return json(res, 200, health(), req);
      } catch (err) {
        return json(res, 500, { error: err.message }, req);
      }
    }

    const file = resolveSafe(root, path);
    if (!file) return json(res, 400, { error: 'ungültiger Pfad' }, req);

    let info;
    try {
      info = statSync(file);
      if (info.isDirectory()) {
        const index = join(file, 'index.html');
        info = statSync(index);
        return send(res, index, info, req.url);
      }
    } catch {
      return json(res, 404, { error: 'nicht gefunden' }, req);
    }
    return send(res, file, info, req.url);
  });
}

function send(res, file, info, url) {
  res.writeHead(200, {
    'Content-Type': contentTypeFor(file),
    'Content-Length': info.size,
    'Cache-Control': cacheHeaderFor(url || ''),
    // Die Seiten bringen ihre eigene CSP im Markup mit; das hier sind die
    // Kopfzeilen, die ein Markup nicht setzen kann.
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
  });
  createReadStream(file).pipe(res);
}

export function parseArgs(argv = []) {
  const value = (name, fallback) => {
    const i = argv.indexOf(name);
    return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback;
  };
  return {
    port: Number(value('--port', 8080)) || 8080,
    host: value('--host', '127.0.0.1'),
    db: value('--db', 'data/local/stock.db'),
    root: value('--root', '.'),
    // Punkte je Reihe in der Auslieferung. Seit die Fassung nur noch lokal
    // laeuft, ist die Datenbank die Quelle und nicht mehr der knappe
    // localStorage des Browsers - mehr Historie heisst mehr Zyklen je Item und
    // damit bessere Timer. Bei 227 Reihen sind das gepackt rund 400 kB.
    //
    // Ein Zeitfenster ("die letzten drei Tage") waere die ehrlichere Form als
    // eine feste Anzahl, weil eine Anzahl bei dichterer Messung immer weniger
    // Zeitraum abdeckt. Solange nur alle paar Minuten ein Punkt entsteht, tut
    // die Anzahl es aber.
    limit: Number(value('--limit', 1000)) || 1000,
  };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const {
    openStore, stockPayload, storeStats, pruefeBeobachtung, saveManual, recordRun,
  } = await import('./store.mjs');
  const db = openStore(opts.db);

  const { COUNTRIES } = await import('../js/travel.js');
  const laender = new Set(COUNTRIES.map((c) => c.code));

  const server = createServer({
    root: opts.root,
    stock: () => stockPayload(db, { limit: opts.limit }),
    health: () => ({ ok: true, ...storeStats(db), pid: process.pid, uptime: process.uptime() }),
    beobachtung: (koerper) => {
      const geprueft = pruefeBeobachtung(koerper, { laender });
      if (!geprueft.ok) return { ok: false, error: geprueft.grund };

      const { added, ersetzt } = saveManual(db, geprueft.wert);
      // Damit spaeter ablesbar ist, dass hier ein Mensch gemessen hat.
      recordRun(db, { source: 'manuell', polls: 0, changes: added });
      console.log(`  Beobachtung: ${geprueft.wert.country}:${geprueft.wert.item} `
        + `= ${geprueft.wert.quantity}${ersetzt ? ` (${ersetzt} Punkt(e) ersetzt)` : ''}`);
      return { ok: true, added, ersetzt, gespeichert: geprueft.wert };
    },
  });

  server.listen(opts.port, opts.host, () => {
    console.log(`Server auf http://${opts.host}:${opts.port} — Wurzel ${resolve(opts.root)}`);
    console.log(`Datenbank ${resolve(opts.db)}`);
  });

  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
      server.close(() => { db.close(); process.exit(0); });
    });
  }
}

if (process.argv[1] && process.argv[1].endsWith('serve.mjs')) {
  main().catch((err) => {
    console.error(`Server fehlgeschlagen: ${err.message}`);
    process.exit(1);
  });
}
