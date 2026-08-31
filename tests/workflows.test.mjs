// Zwei Workflows, die beide nach GitHub Pages deployen, blockieren sich
// gegenseitig ueber die gemeinsame concurrency-Gruppe. Beim Einschalten von
// Pages schlaegt GitHub einen Jekyll-Workflow vor - genau so ist das hier
// schon einmal passiert.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';

const DIR = './.github/workflows';
const files = readdirSync(DIR).filter((f) => /\.ya?ml$/.test(f));

test('genau ein Workflow deployt nach GitHub Pages', () => {
  const deployers = files.filter((f) => readFileSync(`${DIR}/${f}`, 'utf8').includes('actions/deploy-pages'));
  assert.deepEqual(deployers, ['pages.yml'],
    `Erwartet genau pages.yml, gefunden: ${deployers.join(', ') || 'keiner'}`);
});

test('die Seite wird ohne Jekyll ausgeliefert', () => {
  // Reines HTML/CSS/ES-Modules - ein Jekyll-Build kann hier nichts
  // hinzufuegen, aber einiges kaputtmachen.
  for (const file of files) {
    assert.doesNotMatch(readFileSync(`${DIR}/${file}`, 'utf8'), /jekyll/i, `${file} baut mit Jekyll`);
  }
});
