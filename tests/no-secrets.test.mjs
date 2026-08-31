// Das Repository ist oeffentlich, weil GitHub Pages das im Free-Tier verlangt.
// Ein versehentlich committeter Key steht damit fuer immer in der Git-Historie -
// auch nach einem spaeteren Loeschen. Diese Pruefung laeuft bei jedem Push mit.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULTS } from '../js/config.js';

const PAGES = ['./index.html', './diagnose.html', './ledger.html'];
const SKIP_DIRS = new Set(['.git', 'node_modules']);
const TEXT_EXT = /\.(js|mjs|cjs|json|html|css|md|yml|yaml|txt)$/;

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (TEXT_EXT.test(entry)) out.push(full);
  }
  return out;
}

const files = walk('.').map((path) => ({ path, text: readFileSync(path, 'utf8') }));

test('es gibt ueberhaupt Dateien zu pruefen', () => {
  assert.ok(files.length > 5, `nur ${files.length} Dateien gefunden - laeuft der Test im Repo-Root?`);
});

test('die Voreinstellungen enthalten keinen Key', () => {
  assert.equal(DEFAULTS.tornKey, '', 'config.js: tornKey muss leer ausgeliefert werden');
  assert.equal(DEFAULTS.weav3rKey, '', 'config.js: weav3rKey muss leer ausgeliefert werden');
});

test('kein Key ist an eine Key-Variable hartcodiert', () => {
  // Torn-Keys sind 16 alphanumerische Zeichen. Gesucht wird die Zuweisung an
  // einen key-artigen Namen, nicht jede 16-Zeichen-Folge - sonst schlaegt der
  // Test bei jedem Hash und jedem Base64-Schnipsel an.
  const pattern = /(?:torn_?key|weav3r_?key|api_?key|apikey)["'\s]*[:=]\s*["'`]([A-Za-z0-9]{16})["'`]/gi;
  const hits = [];
  for (const { path, text } of files) {
    for (const m of text.matchAll(pattern)) {
      hits.push(`${path}: ${m[0].slice(0, 40)}…`);
    }
  }
  assert.deepEqual(hits, [], `Hartcodierter Key gefunden:\n${hits.join('\n')}`);
});

test('keine URL enthaelt einen fertigen Key', () => {
  const pattern = /(?:torn\.com|weav3r\.dev)[^\s"'`]*[?&](?:api)?key=([A-Za-z0-9]{16})/gi;
  const hits = [];
  for (const { path, text } of files) {
    for (const m of text.matchAll(pattern)) hits.push(`${path}: ${m[0].slice(0, 60)}…`);
  }
  assert.deepEqual(hits, [], `Key in einer URL gefunden:\n${hits.join('\n')}`);
});

test('keine Umgebungs- oder Zugangsdatei ist eingecheckt', () => {
  const forbidden = files
    .map((f) => f.path)
    .filter((p) => /(^|\/)(\.env|\.env\.|secrets?\.|credentials?\.)/i.test(p));
  assert.deepEqual(forbidden, [], `Zugangsdatei im Repo: ${forbidden.join(', ')}`);
});

test('die Seiten erlauben Verbindungen nur zu Torn und weav3r', () => {
  // Ohne diese Einschraenkung koennte eingeschleuster Code den Key an einen
  // beliebigen Host schicken. connect-src ist die Grenze, die das verhindert.
  for (const page of PAGES) {
    const html = readFileSync(page, 'utf8');
    const csp = html.match(/http-equiv="Content-Security-Policy"\s+content="([^"]+)"/);
    assert.ok(csp, `${page}: keine Content-Security-Policy gesetzt`);

    const connect = csp[1].match(/connect-src([^;"]*)/);
    assert.ok(connect, `${page}: connect-src fehlt`);
    const hosts = connect[1].trim().split(/\s+/).filter(Boolean).sort();
    assert.deepEqual(hosts, ['https://api.torn.com', 'https://weav3r.dev'], `${page}: unerwartete Ziel-Hosts`);

    assert.match(csp[1], /default-src 'none'/, `${page}: default-src muss 'none' sein`);
    assert.match(csp[1], /script-src 'self'/, `${page}: script-src muss auf 'self' begrenzt sein`);
    assert.doesNotMatch(csp[1], /unsafe-inline|unsafe-eval/, `${page}: CSP darf kein unsafe-* erlauben`);
  }
});

test('die Seiten enthalten keine Inline-Scripts oder Inline-Styles', () => {
  // Beides waere unter der CSP wirkungslos und wuerde still kaputtgehen.
  for (const page of PAGES) {
    const html = readFileSync(page, 'utf8');
    assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)/i, `${page}: Inline-<script> gefunden`);
    assert.doesNotMatch(html, /\sstyle="/i, `${page}: Inline-style-Attribut gefunden`);
    assert.doesNotMatch(html, /<style[\s>]/i, `${page}: Inline-<style>-Block gefunden`);
  }
});
