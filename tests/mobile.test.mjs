// Mobile Details scheitern still: ein fehlendes viewport-fit laesst Inhalt
// unter der Dynamic Island verschwinden, ein Icon mit falschem Pfad wird
// kommentarlos durch einen Screenshot ersetzt. Deshalb hier festgenagelt.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';

const PAGES = ['./index.html', './diagnose.html'];
const html = Object.fromEntries(PAGES.map((p) => [p, readFileSync(p, 'utf8')]));
const css = readFileSync('./css/app.css', 'utf8');

test('beide Seiten reichen bis unter die Dynamic Island', () => {
  for (const page of PAGES) {
    const viewport = html[page].match(/<meta name="viewport" content="([^"]+)"/);
    assert.ok(viewport, `${page}: kein viewport-Meta`);
    assert.match(viewport[1], /width=device-width/, `${page}`);
    assert.match(viewport[1], /viewport-fit=cover/, `${page}: ohne viewport-fit keine safe-area-insets`);
  }
});

test('die Safe-Area wird auch tatsaechlich ausgewertet', () => {
  assert.match(css, /env\(safe-area-inset-left\)/);
  assert.match(css, /env\(safe-area-inset-right\)/);
  assert.match(css, /env\(safe-area-inset-bottom\)/);
});

test('Eingabefelder sind auf dem Handy mindestens 16px gross', () => {
  // Darunter zoomt Safari beim Fokussieren in die Seite hinein und die
  // Bedienung wird unbrauchbar.
  const mobile = css.split('@media (max-width: 720px)')[1];
  assert.ok(mobile, 'kein Mobile-Breakpoint gefunden');
  const inputRule = mobile.match(/input, select, button, textarea \{([^}]+)\}/);
  assert.ok(inputRule, 'keine gemeinsame Regel fuer Eingabefelder');
  assert.match(inputRule[1], /font-size:\s*16px/);
  assert.match(inputRule[1], /min-height:\s*44px/, 'Apples Mindestgroesse fuer Tippziele');
});

test('die Tabelle wird auf dem Handy zu Karten', () => {
  const mobile = css.split('@media (max-width: 720px)')[1];
  assert.match(mobile, /#results thead \{ display: none; \}/);
  assert.match(mobile, /#results td::before \{\s*content: attr\(data-label\)/);
  // Verschachteltes Scrollen ist auf iOS unangenehm - die Seite scrollt selbst.
  assert.match(mobile, /\.table-wrap \{ max-height: none; overflow: visible; \}/);
});

test('die Karte ist zweispaltig statt zehn Zeilen untereinander', () => {
  const mobile = css.split('@media (max-width: 720px)')[1];
  const tr = mobile.match(/#results tr \{([^}]+)\}/);
  assert.ok(tr, 'keine Regel fuer die Kartenzeile');
  assert.match(tr[1], /display:\s*grid/);
  assert.match(tr[1], /grid-template-columns:\s*1fr 1fr/);
  // Der Itemname bleibt Ueberschrift ueber die volle Breite.
  assert.match(mobile, /#results td:first-child \{[^}]*grid-column: 1 \/ -1/);
  // Netto wiederholt den Ankauf, solange nichts abgezogen wird.
  assert.match(mobile, /#results td\.redundant \{ display: none; \}/);
});

test('der Gegencheck-Link ist ein brauchbares Tippziel', () => {
  // Um den blossen Itemnamen gelegt waere er rund 70x20px gross.
  const mobile = css.split('@media (max-width: 720px)')[1];
  const rule = mobile.match(/#results td:first-child \.item-link \{([^}]+)\}/);
  assert.ok(rule, 'keine Mobile-Regel fuer den Item-Link');
  assert.match(rule[1], /display:\s*flex/);
  assert.match(rule[1], /min-height:\s*36px/);
});

test('der Statustext haelt die Aktionsleiste einzeilig, ausser bei Fehlern', () => {
  const mobile = css.split('@media (max-width: 720px)')[1];
  assert.match(mobile, /\.actionbar #status \{[^}]*text-overflow: ellipsis/);
  assert.match(mobile, /\.actionbar #status\.error \{[^}]*white-space: normal/);
});

test('ohne sichtbare Kopfzeile gibt es ein Sortierfeld', () => {
  assert.match(html['./index.html'], /id="sortSelect"/);
  assert.match(html['./index.html'], /id="sortDir"/);
  const mobile = css.split('@media (max-width: 720px)')[1];
  assert.match(mobile, /\.sortbar \{ display: flex; \}/);
});

test('Home-Screen-Icons und Manifest existieren und sind verlinkt', () => {
  const page = html['./index.html'];
  const refs = ['icon.svg', 'icon-180.png', 'manifest.webmanifest'];
  for (const ref of refs) {
    assert.ok(page.includes(ref), `index.html verlinkt ${ref} nicht`);
    assert.ok(existsSync(`./${ref}`), `${ref} fehlt im Repo`);
  }
  // iOS akzeptiert fuer apple-touch-icon kein SVG.
  assert.match(page, /rel="apple-touch-icon" href="icon-180\.png"/);
});

test('das Manifest ist gueltiges JSON und zeigt auf vorhandene Dateien', () => {
  const manifest = JSON.parse(readFileSync('./manifest.webmanifest', 'utf8'));
  assert.equal(manifest.display, 'standalone');
  assert.ok(manifest.name && manifest.short_name);
  for (const icon of manifest.icons) {
    assert.ok(existsSync(`./${icon.src.replace(/^\.\//, '')}`), `Icon fehlt: ${icon.src}`);
  }
});

test('die CSP erlaubt das Manifest', () => {
  // Mit default-src 'none' wuerde der Browser es sonst blockieren und die
  // Installation auf dem Home-Screen scheitert ohne Fehlermeldung.
  for (const page of PAGES) {
    const csp = html[page].match(/Content-Security-Policy" content="([^"]+)"/)[1];
    assert.match(csp, /manifest-src 'self'/, `${page}`);
  }
});

test('die Einstellungen sind nicht dauerhaft aufgeklappt', () => {
  // Sonst stehen auf dem Handy 15 Felder zwischen Seitenanfang und Treffern.
  assert.doesNotMatch(html['./index.html'], /<details[^>]*\sopen[\s>]/);
});
