#!/usr/bin/env node
// Taugt das lokale Modell für die eine Aufgabe, die wir ihm zugestehen?
//
// Die Aufgabe ist eng: eine Zeile aus dem Torn-Log deuten, an der der
// handgeschriebene Ausdruck scheitert. priceFromDescription() sucht "@ $1,234"
// und sonst nichts — jede andere Formulierung ergibt null. Genau dort soll das
// Modell einspringen, und nur dort.
//
// Dieses Skript beantwortet drei Fragen mit Zahlen statt mit Zutrauen:
//
//   1. Ist Ollama erreichbar und welche Modelle liegen bereit?
//   2. Wie schnell antwortet das Modell auf dieser Maschine wirklich?
//   3. Wie oft trifft es die Fälle, an denen die Regex scheitert — und wie
//      oft widerspricht es ihr dort, wo sie funktioniert?
//
// Punkt 3 ist der entscheidende. Ein Modell, das die klaren Fälle anders
// beantwortet als die Regex, ist unbrauchbar, egal wie gut es bei den
// schweren aussieht.
//
// Aufruf:  node tools/llm-check.mjs [--model qwen2.5:3b] [--base http://127.0.0.1:11434]

import { available, chat, extractJson, validateTradeFields, onlyKnownNumbers, OLLAMA_BASE } from '../js/llm.js';
import { priceFromDescription } from '../js/tradelog.js';

// Die ersten sechs trifft die Regex, die letzten sechs nicht. Erwartung ist
// jeweils das, was ein Mensch beim Lesen sagen wuerde.
const CASES = [
  { text: 'You bought 4x Xanax from Duke @ $830,000', kind: 'buy', quantity: 4, unitPrice: 830000 },
  { text: 'You sold 1x Erotic DVD to Player [123] @ $4,200,000', kind: 'sell', quantity: 1, unitPrice: 4200000 },
  { text: 'You bought 10x Bottle of Beer @ $1,150', kind: 'buy', quantity: 10, unitPrice: 1150 },
  { text: 'You sold 25x Drug Pack @ $95,000', kind: 'sell', quantity: 25, unitPrice: 95000 },
  { text: 'You bought 2x Feathery Hotel Coupon @ $12,750,000', kind: 'buy', quantity: 2, unitPrice: 12750000 },
  { text: 'You sold 100x Empty Blood Bag @ $9,900', kind: 'sell', quantity: 100, unitPrice: 9900 },

  // Ab hier gibt priceFromDescription() null zurueck.
  { text: 'You bought 4x Xanax for $3,320,000 in total', kind: 'buy', quantity: 4, unitPrice: 3320000 },
  { text: 'Duke sold you 3 Xanax, 830000 each', kind: 'buy', quantity: 3, unitPrice: 830000 },
  { text: 'Sold 7 Drug Packs to Player, price per unit 95000', kind: 'sell', quantity: 7, unitPrice: 95000 },
  { text: 'Purchased two Xanax at 830,000 apiece', kind: 'buy', quantity: 2, unitPrice: 830000 },
  { text: 'You received $4,200,000 from Player for 1 Erotic DVD', kind: 'sell', quantity: 1, unitPrice: 4200000 },
  { text: 'Trade completed: gave 5x Bottle of Beer, got 5750 total', kind: 'sell', quantity: 5, unitPrice: 5750 },
];

const SYSTEM = `Du liest Zeilen aus dem Handelslog des Spiels Torn und gibst sie als JSON zurück.

Felder, genau diese vier:
  kind      "buy" wenn der Spieler gekauft/erhalten hat, "sell" wenn er verkauft/abgegeben hat
  quantity  Stückzahl als ganze Zahl
  unitPrice Preis pro Stück als ganze Zahl, ohne Währungszeichen und ohne Trennzeichen
  itemName  Name des Items

Regeln:
- Gib NUR JSON zurück, keinen erklärenden Text.
- Schreibe ausschließlich Zahlen, die wörtlich in der Zeile stehen. Rechne nichts aus.
- Steht nur ein Gesamtpreis da, setze unitPrice auf diesen Gesamtwert und lass die
  Division bleiben — die macht der Code.
- Ist etwas nicht erkennbar, setze das Feld auf null.`;

function parseArgs(argv = []) {
  const value = (name, fallback) => {
    const i = argv.indexOf(name);
    return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback;
  };
  return {
    model: value('--model', null),
    base: value('--base', OLLAMA_BASE),
  };
}

const mb = (bytes) => `${(bytes / 1e9).toFixed(1)} GB`;

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  console.log('── 1. Ist ein Modell da? ──');
  const state = await available(opts.base);
  if (!state.ok) {
    console.error(`Ollama nicht erreichbar unter ${opts.base}: ${state.reason}`);
    console.error('  systemctl status ollama');
    process.exit(1);
  }
  if (!state.models.length) {
    console.error('Ollama läuft, aber kein Modell geladen.  ollama pull qwen2.5:3b');
    process.exit(1);
  }
  for (const m of state.models) {
    console.log(`  ${m.name.padEnd(28)} ${mb(m.size).padStart(8)}  ${m.parameters || '?'} ${m.quantization || ''}`);
  }

  const model = opts.model || state.models[0].name;
  console.log(`\n── 2. ${model} auf dieser Maschine ──`);

  const warmup = await chat({
    base: opts.base, model, prompt: 'Antworte mit dem Wort: bereit', timeoutMs: 180000,
  });
  console.log(`  Aufwärmen: ${warmup.tokens} Tokens in ${warmup.seconds.toFixed(1)} s`
    + `${warmup.tokensPerSecond ? ` = ${warmup.tokensPerSecond.toFixed(1)} Tokens/s` : ''}`);

  console.log('\n── 3. Zwölf Logzeilen: Regex gegen Modell ──\n');
  console.log('  Fall                      Regex      Modell     Urteil');
  console.log('  ' + '─'.repeat(66));

  const score = { regexOk: 0, modelOk: 0, rescued: 0, broke: 0, rejected: 0 };
  const speeds = [];

  for (const [i, c] of CASES.entries()) {
    const regexPrice = priceFromDescription(c.text);
    const regexHit = regexPrice === c.unitPrice;
    if (regexHit) score.regexOk += 1;

    let modelText = '—';
    let modelHit = false;
    try {
      const answer = await chat({
        base: opts.base, model, system: SYSTEM, prompt: c.text, json: true, timeoutMs: 180000,
      });
      if (answer.tokensPerSecond) speeds.push(answer.tokensPerSecond);

      // Erst die Zahlenherkunft, dann die Felder: eine Antwort mit einer
      // erfundenen Zahl wird verworfen, auch wenn sie zufaellig stimmt.
      const guard = onlyKnownNumbers(answer.text, c.text);
      const check = validateTradeFields(extractJson(answer.text), c.text);

      if (!guard.ok) {
        score.rejected += 1;
        modelText = `verworfen (${guard.unknown.slice(0, 2).join(', ')})`;
      } else if (!check.ok) {
        modelText = `verworfen (${check.reason})`;
      } else {
        modelHit = check.value.unitPrice === c.unitPrice
          && check.value.quantity === c.quantity
          && check.value.kind === c.kind;
        modelText = `${check.value.kind} ${check.value.quantity}× ${check.value.unitPrice}`;
      }
    } catch (err) {
      modelText = `Fehler: ${err.message}`;
    }
    if (modelHit) score.modelOk += 1;
    if (!regexHit && modelHit) score.rescued += 1;
    if (regexHit && !modelHit) score.broke += 1;

    const urteil = regexHit && modelHit ? 'einig'
      : !regexHit && modelHit ? 'MODELL RETTET'
        : regexHit && !modelHit ? 'MODELL BRICHT'
          : 'beide daneben';

    console.log(`  ${String(i + 1).padStart(2)}. ${c.text.slice(0, 20).padEnd(21)}`
      + `${(regexHit ? 'ok' : '—').padEnd(10)} ${(modelHit ? 'ok' : '—').padEnd(10)} ${urteil}`);
    if (!modelHit) console.log(`      ${modelText}`);
  }

  const durchschnitt = speeds.length ? speeds.reduce((a, b) => a + b, 0) / speeds.length : null;

  console.log(`\n── Ergebnis ──`);
  console.log(`  Regex trifft   ${score.regexOk}/${CASES.length}`);
  console.log(`  Modell trifft  ${score.modelOk}/${CASES.length}`);
  console.log(`  gerettet       ${score.rescued}  (Regex scheitert, Modell nicht)`);
  console.log(`  gebrochen      ${score.broke}  (Regex hätte gereicht)`);
  console.log(`  verworfen      ${score.rejected}  (Zahl stand nicht in der Eingabe)`);
  if (durchschnitt) console.log(`  Tempo          ${durchschnitt.toFixed(1)} Tokens/s im Schnitt`);

  console.log('');
  if (score.broke > 0) {
    console.log('  Urteil: NICHT einsetzen. Ein Modell, das die klaren Fälle anders');
    console.log('  beantwortet als die Regex, ist unbrauchbar — egal wie gut es bei');
    console.log('  den schweren aussieht. Größeres Modell probieren.');
  } else if (score.rescued === 0) {
    console.log('  Urteil: bringt nichts. Das Modell schafft keinen Fall, den die Regex');
    console.log('  nicht auch schafft — dann ist der ganze Aufwand umsonst.');
  } else {
    console.log(`  Urteil: brauchbar als Auffangnetz. Regex zuerst, Modell nur für die`);
    console.log(`  ${CASES.length - score.regexOk} Zeilen, an denen sie scheitert — davon holt es ${score.rescued}.`);
  }
}

main().catch((err) => {
  console.error(`Fehlgeschlagen: ${err.message}`);
  process.exit(1);
});
