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

/**
 * @param {object} opts
 *   root      Verzeichnis, aus dem ausgeliefert wird
 *   stock     () => Nutzlast fuer data/travel-stock.json, oder null
 *   health    () => Objekt fuer /health
 */
export function createServer({ root = '.', stock = null, health = null } = {}) {
  return createHttpServer((req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return json(res, 405, { error: 'nur GET' }, req);
    }

    const path = (req.url || '/').split('?')[0];

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
  const { openStore, stockPayload, storeStats } = await import('./store.mjs');
  const db = openStore(opts.db);

  const server = createServer({
    root: opts.root,
    stock: () => stockPayload(db, { limit: opts.limit }),
    health: () => ({ ok: true, ...storeStats(db), pid: process.pid, uptime: process.uptime() }),
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
