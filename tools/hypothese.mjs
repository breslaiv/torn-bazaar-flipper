#!/usr/bin/env node
// Laesst das lokale Sprachmodell Vermutungen ueber den Nachschub-Mechanismus
// formulieren - und prueft sie gegen die Messung.
//
// Die Regel, unter der das hier steht: das Modell rechnet nichts. Alle Zahlen
// in diesem Werkzeug kommen aus findCycles() und aus der Datenbank; das Modell
// bekommt sie als Text zu lesen und darf sie deuten. Was es sagt, entscheidet
// nichts - entschieden wird deterministisch, hier im Code.
//
// Warum ueberhaupt ein Sprachmodell? Weil die Frage "welcher Mechanismus
// steckt hinter diesen Zyklen?" eine Deutung ist und keine Rechnung. Die
// Rechnung sagt, wie lang ein Timer war; sie sagt nicht, ob er an der Uhrzeit
// haengt oder an der Nachschubmenge. Genau dort soll das Modell Vorschlaege
// machen, die danach jemand pruefen kann.
//
// Zwei Teile, mit verschiedenem Wert:
//
//   Der Katalog     Vier Mechanismen, jeder mit einem eigenen Massstab im
//                   Code. Das Modell waehlt einen aus, der Code waehlt
//                   unabhaengig davon auch einen - und der Vergleich sagt, ob
//                   das Modell die Lage ueberhaupt richtig liest. Das ist eine
//                   Pruefung, kein Erkenntnisgewinn.
//
//   Der Freitext    Die formulierte Vermutung. Sie darf ausserhalb des
//                   Katalogs liegen, und nur dort kann etwas stehen, das wir
//                   noch nicht wussten. Sie wird nicht bewertet, sondern
//                   berichtet - fuer einen Menschen.
//
// Es gibt bewusst keinen Weg von hier in die laufende Seite. Die CSP der
// Seiten hat kein unsafe-eval, und das soll so bleiben.
//
// Aufruf:  node tools/hypothese.mjs [--db data/local/stock.db]
//                                   [--model llama3.2:3b] [--min-zyklen 10]

import { available, chat, extractJson, onlyKnownNumbers, OLLAMA_BASE } from '../js/llm.js';
import { findCycles, estimateTimer } from '../js/restock.js';
import { openStore, stockPayload } from './store.mjs';

const MINUTE = 60000;

/** Die Mechanismen, ueber die geurteilt wird. */
const KATALOG = [
  { key: 'fester-timer', text: 'Der Timer ist bei diesem Item immer ungefähr gleich lang.' },
  { key: 'feste-uhrzeit', text: 'Der Nachschub kommt zu bestimmten Uhrzeiten, unabhängig davon, wann das Regal leer wurde.' },
  { key: 'menge-abhaengig', text: 'Je größer die letzte Nachschubmenge, desto länger dauert es bis zum nächsten Nachschub.' },
  { key: 'kein-muster', text: 'Es ist kein Zusammenhang erkennbar.' },
];

const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/** Pearson, aber gutmuetig: zu wenige Punkte ergeben null statt einer Zahl. */
function korrelation(xs, ys) {
  const n = Math.min(xs.length, ys.length);
  if (n < 4) return null;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let oben = 0; let lx = 0; let ly = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - mx; const dy = ys[i] - my;
    oben += dx * dy; lx += dx * dx; ly += dy * dy;
  }
  if (!lx || !ly) return null;
  return oben / Math.sqrt(lx * ly);
}

/**
 * Beschreibt eine Reihe in Zahlen - deterministisch, ohne Modell.
 *
 * Der Timer wird je Zyklus als Mitte seiner Einklammerung genommen: genauer
 * geht es nicht, weil zwischen zwei Messungen niemand hinsieht.
 */
export function merkmale(series) {
  const zyklen = findCycles(series).filter((z) => !z.open && z.restockTo && z.selloutTo);

  const dauern = zyklen.map((z) => ((z.restockFrom + z.restockTo) / 2 - z.selloutTo) / MINUTE);
  const mengen = zyklen.map((z) => z.amount).filter((x) => Number.isFinite(x));
  const stunden = zyklen.map((z) => new Date(z.restockTo).getUTCHours());

  // Streuung relativ zur Laenge: 10 Minuten Schwankung heissen bei einem
  // Stundentimer etwas anderes als bei einem Zehnminutentimer.
  const md = median(dauern);
  const streuung = md && dauern.length > 1
    ? median(dauern.map((d) => Math.abs(d - md))) / md
    : null;

  // Ballen sich die Nachschuebe auf wenigen Stunden des Tages?
  const proStunde = new Map();
  for (const h of stunden) proStunde.set(h, (proStunde.get(h) || 0) + 1);
  const groesserBallen = stunden.length ? Math.max(...proStunde.values()) / stunden.length : null;

  // Haengt die Dauer an der Menge des vorangegangenen Nachschubs?
  const mengeVorher = mengen.slice(0, -1);
  const dauerDanach = dauern.slice(1);
  const zusammenhang = korrelation(mengeVorher, dauerDanach);

  return {
    zyklen: zyklen.length,
    dauerMedian: md,
    dauerMin: dauern.length ? Math.min(...dauern) : null,
    dauerMax: dauern.length ? Math.max(...dauern) : null,
    streuung,
    mengeMedian: median(mengen),
    mengeMin: mengen.length ? Math.min(...mengen) : null,
    mengeMax: mengen.length ? Math.max(...mengen) : null,
    stundenVerteilt: proStunde.size,
    groesserBallen,
    zusammenhang,
    timer: estimateTimer(findCycles(series)),
  };
}

/**
 * Das Urteil des Codes - der Massstab, an dem das Modell gemessen wird.
 *
 * Die Schwellen sind bewusst grob und stehen hier, statt verteilt im Text:
 * wer sie fuer falsch haelt, findet sie an einer Stelle.
 */
export function urteil(m) {
  if (m.zyklen < 4) return { key: 'kein-muster', warum: 'zu wenige abgeschlossene Zyklen' };
  if (m.streuung !== null && m.streuung < 0.15) {
    return { key: 'fester-timer', warum: `Streuung ${(m.streuung * 100).toFixed(0)} % um den Median` };
  }
  if (m.groesserBallen !== null && m.groesserBallen > 0.5 && m.stundenVerteilt <= 3) {
    return { key: 'feste-uhrzeit', warum: `${(m.groesserBallen * 100).toFixed(0)} % der Nachschübe in einer Stunde` };
  }
  if (m.zusammenhang !== null && Math.abs(m.zusammenhang) > 0.6) {
    return { key: 'menge-abhaengig', warum: `Korrelation ${m.zusammenhang.toFixed(2)}` };
  }
  return { key: 'kein-muster', warum: 'keine Schwelle erreicht' };
}

/** Die Reihe in Worten - das ist alles, was das Modell zu sehen bekommt. */
export function beschreibung(key, m) {
  const z = (x, n = 0) => (x === null || x === undefined ? 'unbekannt' : x.toFixed(n));
  return [
    `Item ${key}.`,
    `${m.zyklen} vollständige Nachschub-Zyklen beobachtet.`,
    `Zeit vom leeren Regal bis zum Nachschub: im Mittel ${z(m.dauerMedian)} Minuten,`
      + ` kürzeste ${z(m.dauerMin)}, längste ${z(m.dauerMax)}.`,
    `Nachgelegte Menge: im Mittel ${z(m.mengeMedian)} Stück, kleinste ${z(m.mengeMin)}, größte ${z(m.mengeMax)}.`,
    `Die Nachschübe verteilen sich auf ${z(m.stundenVerteilt)} verschiedene Stunden des Tages.`,
  ].join(' ');
}

const SYSTEM = `Du siehst Messwerte zu einem Item in einem Spiel. Wenn das Regal leer ist,
dauert es eine Weile, bis nachgelegt wird. Die Frage ist, wovon diese Dauer abhängt.

Wähle genau eine Erklärung aus dieser Liste:
${KATALOG.map((k) => `  ${k.key}: ${k.text}`).join('\n')}

Antworte NUR mit JSON in dieser Form:
{"mechanismus": "<einer der Schlüssel>", "vermutung": "<ein Satz in eigenen Worten>"}

Regeln:
- Schreibe ausschließlich Zahlen, die wörtlich im Text stehen. Rechne nichts aus.
- Prüfe zuerst, ob kürzeste und längste Dauer nahe beieinander liegen. Liegen sie
  nahe beieinander, ist die Dauer gleichbleibend.
- Wähle "kein-muster" nur, wenn keine der drei anderen Erklärungen passt.`;

function parseArgs(argv = []) {
  const value = (name, fallback) => {
    const i = argv.indexOf(name);
    return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback;
  };
  return {
    db: value('--db', 'data/local/stock.db'),
    model: value('--model', null),
    base: value('--base', OLLAMA_BASE),
    minZyklen: Number(value('--min-zyklen', 10)) || 10,
  };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  const zustand = await available(opts.base);
  if (!zustand.ok || !zustand.models.length) {
    console.error(`Kein Modell erreichbar unter ${opts.base}: ${zustand.reason || 'keins geladen'}`);
    process.exit(1);
  }
  const model = opts.model || zustand.models[0].name;

  const db = openStore(opts.db);
  const nutzlast = stockPayload(db, { limit: 1000 });

  // Nur Reihen, bei denen ueberhaupt etwas zu deuten ist. Ein Modell nach
  // einem Muster in zwei Zyklen zu fragen, erzeugt eine Antwort und keine
  // Erkenntnis.
  const kandidaten = Object.entries(nutzlast.series)
    .map(([key, series]) => ({ key, m: merkmale(series) }))
    .filter((k) => k.m.zyklen >= opts.minZyklen)
    .sort((a, b) => b.m.zyklen - a.m.zyklen);

  console.log(`Modell: ${model}`);
  console.log(`Reihen mit mindestens ${opts.minZyklen} Zyklen: ${kandidaten.length} von ${Object.keys(nutzlast.series).length}\n`);

  if (!kandidaten.length) {
    console.log('Zu wenige Zyklen. Der Sammler muss laenger laufen - das ist die Antwort,');
    console.log('nicht ein Ergebnis aus zu duennen Daten.');
    db.close();
    return;
  }

  const bilanz = { einig: 0, uneinig: 0, verworfen: 0 };
  const tempo = [];

  for (const { key, m } of kandidaten) {
    const text = beschreibung(key, m);
    const codeUrteil = urteil(m);

    let modellKey = null;
    let vermutung = '';
    let notiz = '';
    try {
      const antwort = await chat({
        base: opts.base, model, system: SYSTEM, prompt: text, json: true, timeoutMs: 180000,
      });
      if (antwort.tokensPerSecond) tempo.push(antwort.tokensPerSecond);

      // Dieselbe Absicherung wie ueberall: keine Zahl, die nicht in der
      // Eingabe stand. Eine erfundene Zahl in der Vermutung macht den ganzen
      // Satz wertlos, auch wenn der Mechanismus stimmt.
      const wache = onlyKnownNumbers(antwort.text, text);
      const parsed = extractJson(antwort.text);

      // Unterstrich statt Bindestrich ist eine Schreibweise, kein anderer
      // Mechanismus - daran soll ein Urteil nicht scheitern.
      const gewaehlt = String(parsed?.mechanismus ?? '').trim().toLowerCase().replace(/_/g, '-');

      if (!wache.ok) {
        notiz = `verworfen — erfundene Zahl (${wache.unknown.slice(0, 2).join(', ')})`;
        bilanz.verworfen += 1;
      } else if (!KATALOG.some((k) => k.key === gewaehlt)) {
        notiz = `verworfen — unbekannter Mechanismus (${parsed?.mechanismus ?? 'kein JSON'})`;
        bilanz.verworfen += 1;
      } else {
        modellKey = gewaehlt;
        vermutung = String(parsed.vermutung ?? '').slice(0, 200);
        if (modellKey === codeUrteil.key) bilanz.einig += 1; else bilanz.uneinig += 1;
      }
    } catch (err) {
      notiz = `Fehler: ${err.message}`;
      bilanz.verworfen += 1;
    }

    const timer = Number.isFinite(m.timer?.low) && Number.isFinite(m.timer?.high)
      ? `${m.timer.low.toFixed(0)}–${m.timer.high.toFixed(0)} min`
      : 'nicht eingrenzbar';

    console.log(`── ${key}  (${m.zyklen} Zyklen, Timer ${timer})`);
    console.log(`   Code:   ${codeUrteil.key.padEnd(16)} ${codeUrteil.warum}`);
    console.log(`   Modell: ${(modellKey ?? '—').padEnd(16)} ${notiz || (modellKey === codeUrteil.key ? 'einig' : 'WIDERSPRUCH')}`);
    if (vermutung) console.log(`   „${vermutung}"`);
    console.log('');
  }

  console.log('── Ergebnis ──');
  console.log(`  einig      ${bilanz.einig}`);
  console.log(`  uneinig    ${bilanz.uneinig}`);
  console.log(`  verworfen  ${bilanz.verworfen}`);
  if (tempo.length) {
    console.log(`  Tempo      ${(tempo.reduce((a, b) => a + b, 0) / tempo.length).toFixed(1)} Tokens/s`);
  }
  console.log('');
  console.log('  Der Vergleich prüft, ob das Modell die Datenlage richtig liest — mehr nicht.');
  console.log('  Der eigentliche Ertrag stünde in den Vermutungen, und den beurteilt ein Mensch.');
  console.log('  Übernommen wird nichts: es gibt keinen Weg von hier in die laufende Seite.');

  db.close();
}

// Nur beim direkten Aufruf laufen: sonst spraeche ein Test, der bloss
// merkmale() importiert, ungefragt mit Ollama.
if (process.argv[1] && process.argv[1].endsWith('hypothese.mjs')) {
  main().catch((err) => {
    console.error(`Fehlgeschlagen: ${err.message}`);
    process.exit(1);
  });
}
