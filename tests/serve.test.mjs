// Der lokale Server liegt auf einer Maschine mit dem Torn-Key, dem Ledger und
// der ganzen Messhistorie. Die eine Zeile, die hier zaehlt, ist resolveSafe():
// ohne sie ist "../" ein Leseschluessel fuer die ganze Platte.

import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { connect } from 'node:net';
import { resolve } from 'node:path';
import { contentTypeFor, resolveSafe, cacheHeaderFor, createServer, parseArgs } from '../tools/serve.mjs';

const ROOT = resolve('.');

// ---------- Pfadschutz ----------

test('normale Pfade landen unter der Wurzel', () => {
  assert.equal(resolveSafe('.', '/index.html'), `${ROOT}/index.html`);
  assert.equal(resolveSafe('.', '/js/app.js'), `${ROOT}/js/app.js`);
  assert.equal(resolveSafe('.', '/'), `${ROOT}/index.html`, 'die Wurzel ist die Startseite');
});

test('die Abfrage gehoert nicht zum Pfad', () => {
  assert.equal(resolveSafe('.', '/js/app.js?v=14'), `${ROOT}/js/app.js`);
});

test('aus der Wurzel kommt niemand heraus', () => {
  for (const attempt of [
    '/../etc/passwd',
    '/../../etc/passwd',
    '/js/../../etc/passwd',
    '/%2e%2e/%2e%2e/etc/passwd',      // prozentkodiert sieht es im Log harmlos aus
    '/%2E%2E%2F%2E%2E%2Fetc/passwd',
  ]) {
    assert.equal(resolveSafe('.', attempt), null, attempt);
  }
});

test('ein Nullbyte beendet die Sache, statt den Pfad abzuschneiden', () => {
  assert.equal(resolveSafe('.', '/index.html\0.png'), null);
});

test('kaputte Prozentkodierung wird abgelehnt, nicht durchgereicht', () => {
  assert.equal(resolveSafe('.', '/%'), null);
  assert.equal(resolveSafe('.', '/%zz'), null);
});

test('ein Nachbarverzeichnis mit gleichem Praefix zaehlt nicht als innen', () => {
  // /srv/app und /srv/app-backup: ein reines startsWith ohne Trenner haelt
  // das zweite faelschlich fuer einen Unterordner des ersten.
  assert.equal(resolveSafe('/srv/app', '/../app-backup/geheim'), null);
});

// ---------- Kopfzeilen ----------

test('Inhaltstypen decken ab, was die Seiten laden', () => {
  assert.match(contentTypeFor('/index.html'), /^text\/html/);
  assert.match(contentTypeFor('/js/app.js'), /^text\/javascript/);
  assert.match(contentTypeFor('/css/app.css'), /^text\/css/);
  assert.match(contentTypeFor('/data/x.json'), /^application\/json/);
  assert.match(contentTypeFor('/manifest.webmanifest'), /^application\/manifest\+json/);
  assert.equal(contentTypeFor('/icon.svg'), 'image/svg+xml');
  // Unbekanntes darf nicht als Text geraten werden.
  assert.equal(contentTypeFor('/x.wat'), 'application/octet-stream');
});

test('nur versionierte Dateien duerfen im Cache liegen', () => {
  // Der Versionsstempel macht jede Fassung zu einer eigenen URL - ohne ihn
  // liefert der Browser sonst tagelang den alten Stand.
  assert.match(cacheHeaderFor('/js/app.js?v=14'), /immutable/);
  assert.equal(cacheHeaderFor('/index.html'), 'no-cache');
  assert.equal(cacheHeaderFor('/data/travel-stock.json'), 'no-cache');
});

// ---------- Server ----------

async function withServer(opts, fn) {
  const server = createServer({ root: '.', ...opts });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  try { await fn(base); } finally { server.close(); await once(server, 'close'); }
}

test('die Startseite kommt durch', async () => {
  await withServer({}, async (base) => {
    const res = await fetch(`${base}/`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/html/);
    assert.match(await res.text(), /Torn Bazaar Flipper/);
  });
});

test('der Vorratsbestand kommt aus der Datenbank, nicht von der Platte', async () => {
  // Genau der Pfad, den die Flug-Seite auf GitHub Pages abfragt. Deshalb
  // laeuft sie lokal, ohne dass im Browser eine Zeile anders ist.
  const payload = { collectedAt: 42, source: 'x', countries: 1, points: 1, series: { 'mex:8': [[1, 2]] } };
  await withServer({ stock: () => payload }, async (base) => {
    const res = await fetch(`${base}/data/travel-stock.json`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), payload);
  });
});

test('grosse Messreihen gehen gepackt ueber die Leitung', async () => {
  // Seit die Fassung nur noch lokal laeuft, liefert der Server deutlich mehr
  // Historie aus - gemessen ein Fuenftel der Groesse, sobald gepackt wird.
  // Ohne das waere der Aufruf vom Telefon ueber Tailscale spuerbar zaeh.
  const reihe = Array.from({ length: 2000 }, (_, i) => [1700000000000 + i * 60000, i % 300]);
  const payload = { collectedAt: 42, source: 'x', countries: 1, points: reihe.length, series: { 'mex:8': reihe } };

  await withServer({ stock: () => payload }, async (base) => {
    const res = await fetch(`${base}/data/travel-stock.json`, {
      headers: { 'Accept-Encoding': 'gzip' },
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-encoding'), 'gzip');
    assert.match(res.headers.get('vary') || '', /Accept-Encoding/);
    // fetch packt selbst aus - der Inhalt muss unveraendert ankommen.
    assert.deepEqual(await res.json(), payload);
  });
});

test('wer nicht auspacken kann, bekommt die rohe Fassung', async () => {
  const reihe = Array.from({ length: 2000 }, (_, i) => [1700000000000 + i * 60000, i % 300]);
  const payload = { series: { 'mex:8': reihe } };

  await withServer({ stock: () => payload }, async (base) => {
    const res = await fetch(`${base}/data/travel-stock.json`, {
      headers: { 'Accept-Encoding': 'identity' },
    });
    assert.equal(res.headers.get('content-encoding'), null, 'ungefragt wird nicht gepackt');
    assert.deepEqual(await res.json(), payload);
  });
});

test('kurze Antworten bleiben ungepackt', async () => {
  // Unterhalb eines Netzpakets kostet Packen nur Rechenzeit.
  await withServer({ health: () => ({ ok: true }) }, async (base) => {
    const res = await fetch(`${base}/health`, { headers: { 'Accept-Encoding': 'gzip' } });
    assert.equal(res.headers.get('content-encoding'), null);
  });
});

test('ein Fehler in der Datenbank wird gemeldet, nicht verschwiegen', async () => {
  await withServer({ stock: () => { throw new Error('Datenbank gesperrt'); } }, async (base) => {
    const res = await fetch(`${base}/data/travel-stock.json`);
    assert.equal(res.status, 500);
    assert.match((await res.json()).error, /gesperrt/);
  });
});

test('/health sagt, ob ueberhaupt etwas ankommt', async () => {
  await withServer({ health: () => ({ ok: true, points: 7 }) }, async (base) => {
    assert.deepEqual(await (await fetch(`${base}/health`)).json(), { ok: true, points: 7 });
  });
});

test('was es nicht gibt, ist 404 und keine Verzeichnisliste', async () => {
  await withServer({}, async (base) => {
    assert.equal((await fetch(`${base}/gibtesnicht.html`)).status, 404);
  });
});

test('ein Ausbruchsversuch endet mit 400, nicht mit einer Datei', async () => {
  // Roh ueber den Socket, nicht ueber fetch: fetch raeumt "../" schon im
  // Client weg, und dann prueft der Test die Bibliothek statt den Server.
  await withServer({}, async (base) => {
    const port = Number(new URL(base).port);
    for (const path of ['/../../etc/passwd', '/%2e%2e/%2e%2e/etc/passwd']) {
      const answer = await rawGet(port, path);
      assert.match(answer, /^HTTP\/1\.1 (400|404)/, path);
      assert.doesNotMatch(answer, /root:/, `${path}: hat eine Datei ausgeliefert`);
    }
  });
});

/** Schickt eine Anfrage, ohne den Pfad vorher zu begradigen. */
function rawGet(port, path) {
  return new Promise((done, fail) => {
    const socket = connect(port, '127.0.0.1', () => {
      socket.write(`GET ${path} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n`);
    });
    let text = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => { text += chunk; });
    socket.on('end', () => done(text));
    socket.on('error', fail);
  });
}

test('schreibende Methoden gibt es nicht', async () => {
  // Der Server liefert aus und nimmt nichts entgegen. Alles andere waere eine
  // Angriffsflaeche fuer eine Aufgabe, die es nicht gibt.
  await withServer({}, async (base) => {
    for (const method of ['POST', 'PUT', 'DELETE']) {
      assert.equal((await fetch(`${base}/`, { method })).status, 405, method);
    }
  });
});

test('ausgeliefert wird mit nosniff', async () => {
  await withServer({}, async (base) => {
    const res = await fetch(`${base}/index.html`);
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  });
});

// ---------- Aufrufparameter ----------

test('ohne Angabe hoert der Server nur auf sich selbst', () => {
  // Die Vorgabe entscheidet, ob der Dienst im ganzen WLAN steht oder nur fuer
  // die eigenen Geraete via Tailscale. 0.0.0.0 gibt es, aber nicht von allein.
  assert.equal(parseArgs([]).host, '127.0.0.1');
  assert.equal(parseArgs([]).port, 8080);
  assert.equal(parseArgs(['--host', '0.0.0.0']).host, '0.0.0.0');
});

test('unsinnige Zahlen fallen auf die Vorgabe zurueck', () => {
  assert.equal(parseArgs(['--port', 'abc']).port, 8080);
  assert.equal(parseArgs(['--limit', '0']).limit, 1000);
});
