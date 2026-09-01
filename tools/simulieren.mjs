#!/usr/bin/env node
// Erzeugt Messreihen mit bekanntem Innenleben.
//
// WOFUER DAS DA IST - und wofuer nicht:
//
//   Ja, zum Pruefen.       Bei simulierten Daten kennt man den wahren Timer.
//                          Damit laesst sich zeigen, dass estimateTimer() ihn
//                          wiederfindet und nicht bloss etwas Plausibles
//                          ausgibt. Das geht mit echten Daten grundsaetzlich
//                          nicht - dort ist der wahre Wert unbekannt.
//
//   Ja, zum Dimensionieren. Wieviele Zyklen braucht ein Verfahren, bis es
//                          etwas taugt? Diese Frage richtet sich an das
//                          Verfahren, nicht an Torn - sie laesst sich also an
//                          erfundenen Daten beantworten, ohne wochenlang zu
//                          warten.
//
//   NEIN, zum Trainieren eines ausgelieferten Modells. Ein Simulator enthaelt
//   nur, was wir hineinschreiben. Ein darauf trainiertes Modell lernt unsere
//   Annahmen und gibt sie mit der Autoritaet einer Messung zurueck - genau die
//   "plausible Zahl ohne Grundlage", die dieses Projekt vermeidet. Es koennte
//   bestenfalls nachmachen, was js/travelModels.js bereits rechnet.
//
//   NEIN, als Datenquelle. Was hier entsteht, gehoert niemals in
//   data/local/stock.db. Die Datenbank ist eine Sammlung von Beobachtungen.
//
// Die Kennwerte stammen aus den Messungen vom 2026-09-01 an der lokalen
// Datenbank; wo etwas nicht gemessen war, steht es als Annahme daneben.
//
// Aufruf:  node tools/simulieren.mjs --pruefe
//          node tools/simulieren.mjs --reihen 200 --stunden 48 --out datei.json

const MIN = 60000;

/**
 * Kennwerte, gemessen soweit moeglich.
 *
 * Der Takt der Quelle ist der wichtigste: YATA rechnet einmal je Minute neu
 * (kleinster beobachteter Abstand exakt 60 s, Median 69 s). Ohne diese
 * Koernung waere die simulierte Welt genauer beobachtbar als die echte, und
 * jede daran gemessene Aussage waere zu optimistisch.
 */
export const KENNWERTE = {
  quelleSekunden: 60,          // gemessen: kleinster Abstand exakt 60 s
  quelleJitterSekunden: 15,    // gemessen: Median 69 s, p95 116 s
  timerMinuten: [11, 20],      // gemessen an den schnellen Items
  // Nicht gemessen - die langsamen Items hatten zu wenige Zyklen. Bewusst
  // breit, damit nichts an einer erfundenen Enge haengt.
  timerMinutenLangsam: [45, 600],
  kapazitaet: [20, 8000],      // gemessen: von Einzelstuecken bis Dahlia
  anteilSchnell: 0.15,         // gemessen: 13 von 227 Reihen mit >= 10 Zyklen
};

/** Kleiner, aussaebarer Zufall - damit ein Lauf wiederholbar ist. */
export function zufall(saat = 1) {
  let s = saat >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

const zwischen = (r, [a, b]) => a + r() * (b - a);

/**
 * Eine Reihe mit bekanntem Timer.
 *
 * Das Regal leert sich mit wechselndem Tempo, steht bei null, und nach genau
 * `timer` Minuten ist es wieder voll. Beobachtet wird es nur im Takt der
 * Quelle - und gespeichert nur, wenn sich etwas geaendert hat, so wie es der
 * Sammler tut. Beides zusammen macht den Unterschied zwischen dem, was
 * passiert, und dem, was man davon sieht.
 *
 * @returns {{punkte: Array, timer: number, kapazitaet: number}}
 */
export function simuliereReihe({ r, stunden = 24, schnell = true, aufzeichnen }) {
  const timer = zwischen(r, schnell ? KENNWERTE.timerMinuten : KENNWERTE.timerMinutenLangsam);
  const kapazitaet = Math.round(zwischen(r, KENNWERTE.kapazitaet));
  // Tempo so, dass ein volles Regal im Mittel in einem Timer-Zeitraum leerlaeuft
  // - sonst entstehen entweder keine Zyklen oder nur Zyklen.
  const grundTempo = kapazitaet / (timer * zwischen(r, [0.6, 2.5]));

  const ende = stunden * 60 * MIN;
  const start = Date.now() - ende;
  let jetzt = 0;
  let menge = kapazitaet;
  let leerSeit = null;

  // Aufgezeichnet wird mit derselben Funktion, die der Sammler benutzt.
  // Das ist kein Zierrat: recordSnapshot() speichert eine unveraenderte Menge
  // nach fuenf Minuten trotzdem, und genau daran haengt, ob ein leeres Regal
  // sichtbar bleibt. Eine eigene Aufzeichnungsregel hier haette den Simulator
  // von der Wirklichkeit entfernt - und die erste Fassung tat es auch: sie
  // hielt nur Aenderungen fest, ein leeres Regal ergab einen einzigen Punkt,
  // und estimateTimer() sah dadurch scheinbar 125 Minuten zu kurz.
  let store = {};

  while (jetzt < ende) {
    const schritt = (KENNWERTE.quelleSekunden + r() * KENNWERTE.quelleJitterSekunden) * 1000;
    jetzt += schritt;

    if (leerSeit === null) {
      // Abverkauf schwankt - mal steht die Ware, mal ist sie in Minuten weg.
      const tempo = grundTempo * zwischen(r, [0.2, 2.2]);
      menge = Math.max(0, menge - tempo * (schritt / MIN));
      if (menge <= 0) { menge = 0; leerSeit = jetzt; }
    } else if (jetzt - leerSeit >= timer * MIN) {
      menge = kapazitaet;
      leerSeit = null;
    }

    store = aufzeichnen(store, 'sim', [{ itemId: 1, quantity: Math.round(menge) }], start + jetzt);
  }

  return { punkte: store['sim:1'] ?? [], timer, kapazitaet };
}

/** Ein ganzer Datensatz in der Form, die stockPayload() liefert. */
export async function simuliereDatensatz({ reihen = 200, stunden = 24, saat = 1 } = {}) {
  const { recordSnapshot } = await import('../js/travelStock.js');
  const r = zufall(saat);
  const series = {};
  const wahrheit = {};
  const laender = ['mex', 'cay', 'can', 'haw', 'uni', 'arg', 'swi', 'jap', 'chi', 'uae', 'sou'];

  for (let i = 0; i < reihen; i++) {
    const schnell = r() < KENNWERTE.anteilSchnell;
    const { punkte, timer, kapazitaet } = simuliereReihe({
      r, stunden, schnell, aufzeichnen: recordSnapshot,
    });
    const key = `${laender[i % laender.length]}:${1000 + i}`;
    series[key] = punkte;
    wahrheit[key] = { timer, kapazitaet, schnell };
  }
  return { series, wahrheit };
}

// ---------- Selbstpruefung ----------

/**
 * Findet estimateTimer() den wahren Timer wieder?
 *
 * Das ist die Frage, die sich an echten Daten nicht stellen laesst. Erwartet
 * wird nicht Genauigkeit, sondern **Unverzerrtheit**: der wahre Wert muss in
 * der ausgegebenen Einklammerung liegen. Liegt er systematisch daneben,
 * stimmt etwas an der Schaetzung und nicht an den Daten.
 */
export async function pruefe({ reihen = 120, stunden = 48, saat = 7 } = {}) {
  const { estimateTimer, findCycles } = await import('../js/restock.js');
  const { series, wahrheit } = await simuliereDatensatz({ reihen, stunden, saat });

  const treffer = [];
  for (const [key, punkte] of Object.entries(series)) {
    const zyklen = findCycles(punkte);
    const geschaetzt = estimateTimer(zyklen);
    const abgeschlossen = zyklen.filter((z) => !z.open).length;
    if (!geschaetzt || abgeschlossen < 2) continue;

    const wahr = wahrheit[key].timer;
    treffer.push({
      key,
      wahr,
      low: geschaetzt.low,
      high: geschaetzt.high,
      drin: wahr >= geschaetzt.low && wahr <= geschaetzt.high,
      breite: geschaetzt.high - geschaetzt.low,
      zyklen: abgeschlossen,
      fehler: geschaetzt.minutes - wahr,
    });
  }

  return treffer;
}

// ---------- Aufruf ----------

function parseArgs(argv = []) {
  const wert = (name, vorgabe) => {
    const i = argv.indexOf(name);
    return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : vorgabe;
  };
  return {
    reihen: Number(wert('--reihen', 200)) || 200,
    stunden: Number(wert('--stunden', 24)) || 24,
    saat: Number(wert('--saat', 1)) || 1,
    out: wert('--out', null),
    pruefen: argv.includes('--pruefe'),
  };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  if (opts.pruefen) {
    const treffer = await pruefe({ stunden: opts.stunden, saat: opts.saat });
    const drin = treffer.filter((t) => t.drin).length;
    const median = (x) => [...x].sort((a, b) => a - b)[Math.floor(x.length / 2)];

    console.log(`${treffer.length} Reihen mit Timer-Schaetzung`);
    console.log(`Wahrer Wert in der Einklammerung: ${drin} = ${(drin / treffer.length * 100).toFixed(0)} %`);
    console.log(`Breite der Einklammerung: Median ${median(treffer.map((t) => t.breite)).toFixed(1)} min`);
    console.log(`Fehler der Mitte: Median ${median(treffer.map((t) => t.fehler)).toFixed(2)} min`);
    console.log('');
    console.log('Ein Wert nahe 100 % heisst: die Schaetzung ist ehrlich - sie behauptet');
    console.log('nicht mehr Genauigkeit, als sie hat. Ein Fehler der Mitte nahe null');
    console.log('heisst: sie zieht nicht systematisch in eine Richtung.');
    return;
  }

  const { series, wahrheit } = await simuliereDatensatz(opts);
  const punkte = Object.values(series).reduce((s, v) => s + v.length, 0);
  const nutzlast = { simuliert: true, collectedAt: Date.now(), series, wahrheit };

  if (opts.out) {
    const { writeFileSync } = await import('node:fs');
    writeFileSync(opts.out, `${JSON.stringify(nutzlast)}\n`);
    console.log(`${opts.reihen} Reihen, ${punkte} Messpunkte, ${opts.stunden} h -> ${opts.out}`);
  } else {
    console.log(`${opts.reihen} Reihen, ${punkte} Messpunkte ueber ${opts.stunden} h`);
    console.log('Mit --out <datei> schreiben. Nicht in data/local/ - das sind Beobachtungen.');
  }
}

if (process.argv[1] && process.argv[1].endsWith('simulieren.mjs')) {
  main().catch((err) => {
    console.error(`Fehlgeschlagen: ${err.message}`);
    process.exit(1);
  });
}
