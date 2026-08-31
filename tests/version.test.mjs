// Ein Deploy, der den Browser nicht erreicht, ist kein Deploy. GitHub Pages
// liefert mit max-age=600 aus, iOS haelt eine Home-Screen-Seite noch laenger
// fest - zweimal wurde deshalb ein behobener Fehler erneut gemeldet.
// Der Versionsstempel an jedem Import macht jede Fassung zu einer eigenen URL.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { APP_VERSION } from '../js/config.js';

const JS = readdirSync('./js').filter((f) => f.endsWith('.js'));
const HTML = readdirSync('.').filter((f) => f.endsWith('.html'));

test('es gibt eine Version', () => {
  assert.match(APP_VERSION, /^[\w.-]+$/);
});

test('jeder relative Import traegt die aktuelle Version', () => {
  const bad = [];
  for (const file of JS) {
    const text = readFileSync(`./js/${file}`, 'utf8');
    for (const m of text.matchAll(/from\s+['"](\.{1,2}\/[^'"]+\.js)(\?v=([^'"]*))?['"]/g)) {
      if (m[3] !== APP_VERSION) bad.push(`js/${file}: ${m[1]}${m[2] || ' (ohne Stempel)'}`);
    }
  }
  assert.deepEqual(bad, [],
    `Nicht gestempelt — tools/version-assets.py laufen lassen:\n${bad.join('\n')}`);
});

test('jedes Script-Tag traegt die aktuelle Version', () => {
  const bad = [];
  for (const file of HTML) {
    const text = readFileSync(`./${file}`, 'utf8');
    for (const m of text.matchAll(/<script[^>]*\ssrc="([^"?]+\.js)(\?v=([^"]*))?"/g)) {
      if (m[3] !== APP_VERSION) bad.push(`${file}: ${m[1]}${m[2] || ' (ohne Stempel)'}`);
    }
  }
  assert.deepEqual(bad, [], `Nicht gestempelt:\n${bad.join('\n')}`);
});

test('jede Seite zeigt den Build an', () => {
  // Sonst bleibt "geht immer noch nicht" unauflösbar.
  for (const file of HTML) {
    assert.match(readFileSync(`./${file}`, 'utf8'), /id="appVersion"/, file);
  }
});

test('der Stempel-Helfer liest dieselbe Version', () => {
  const script = readFileSync('./tools/version-assets.py', 'utf8');
  assert.match(script, /APP_VERSION/);
});
