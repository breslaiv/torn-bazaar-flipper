// Die Seite, die zeigt, wie weit die Sammlung ist.
//
// Warum es sie gibt: die wichtigste Zahl dieses Projekts ist nicht der
// Bestand eines Items, sondern wie viele Nachfuell-Zyklen dafuer vorliegen.
// Messpunkte taeuschen - ein Regal, das stundenlang voll dasteht, liefert
// hunderte davon und verraet nichts ueber seinen Timer. Ohne diese Seite
// musste man `collect-local.mjs --stats` auf der Maschine aufrufen, um zu
// wissen, ob ein Item schon etwas taugt.
//
// Gerechnet wird mit denselben Funktionen wie auf der Flug-Seite -
// findCycles(), estimateTimer(), backtest(). Eine zweite Rechnung waere eine
// zweite Wahrheit, und dann zeigte das Dashboard etwas anderes an als die
// Seite, die entscheidet.
//
// Die Zahlen kommen aus zwei Quellen, beide gleiche Herkunft:
//   data/travel-stock.json   die Messreihen (lokal aus SQLite, sonst Datei)
//   /health                  Kennzahlen des lokalen Servers, fehlt auf Pages

import { showVersion } from './ui.js?v=19';
import { findCycles, estimateTimer } from './restock.js?v=19';
import { backtest, MIN_CHECKS } from './travelStock.js?v=19';
import { countryName } from './travel.js?v=19';

const el = (id) => document.getElementById(id);
const MINUTE = 60000;

/** Zustand der Seite: einmal gerechnet, dann nur noch sortiert. */
let reihen = [];

const setStatus = (text, kind = '') => {
  const s = el('status');
  s.textContent = text;
  s.className = kind;
};

// ---------- Holen ----------

async function ladeReihen() {
  const res = await fetch(`data/travel-stock.json?t=${Math.floor(Date.now() / 60000)}`, {
    headers: { Accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  return {
    series: data?.series && typeof data.series === 'object' ? data.series : {},
    collectedAt: data?.collectedAt ?? null,
  };
}

/**
 * Kennzahlen des lokalen Servers.
 *
 * Auf GitHub Pages gibt es diese Route nicht. Das ist kein Fehler, sondern
 * der Normalfall dort - deshalb null statt einer Ausnahme.
 */
async function ladeHealth() {
  try {
    const res = await fetch('health', { headers: { Accept: 'application/json' } });
    if (!res.ok) return null;
    const d = await res.json();
    return d && d.ok ? d : null;
  } catch {
    return null;
  }
}

// ---------- Rechnen ----------

/**
 * Alles, was diese Seite je Reihe wissen muss.
 *
 * backtest() ist der teure Teil und laeuft deshalb nur, wo es ueberhaupt
 * etwas zu bewerten gibt. Eine Reihe ohne abgeschlossenen Zyklus kann kein
 * Modell pruefen - dort waere das Ergebnis kein Urteil, sondern Rauschen.
 */
function auswerten(key, punkte) {
  const [code, id] = key.split(':');
  const zyklen = findCycles(punkte).filter((z) => !z.open);
  const timer = zyklen.length ? estimateTimer(findCycles(punkte)) : null;

  let modell = null;
  let checks = 0;
  if (zyklen.length >= 1) {
    const a = backtest(punkte);
    checks = a.checks || 0;
    if (a.model && checks >= MIN_CHECKS) modell = a.model.key;
  }

  return {
    key,
    code,
    itemId: Number(id),
    punkte: punkte.length,
    zyklen: zyklen.length,
    timer,
    // Enger Timer heisst brauchbare Vorhersage. Ohne Einklammerung gibt es
    // keine Genauigkeit, und dann steht hier nichts statt einer Null.
    spanne: timer && Number.isFinite(timer.low) && Number.isFinite(timer.high)
      ? timer.high - timer.low
      : null,
    modell,
    checks,
  };
}

// ---------- Anzeigen ----------

const zahl = (n) => (n === null || n === undefined ? '—' : n.toLocaleString('de-DE'));

function kachel(label, wert, sub = '') {
  const d = document.createElement('div');
  d.className = 'tile';
  const l = document.createElement('div');
  l.className = 'label';
  l.textContent = label;
  const v = document.createElement('div');
  v.className = 'value';
  v.textContent = wert;
  d.append(l, v);
  if (sub) {
    const s = document.createElement('div');
    s.className = 'sub';
    s.textContent = sub;
    d.append(s);
  }
  return d;
}

/**
 * Breite eines Balkens in Prozent.
 *
 * Der Mindestwert ist der Punkt: ein vorhandener, aber winziger Wert rundet
 * sonst auf 0 % und sieht aus wie gar nichts. "Eine Reihe von 227 hat zwanzig
 * Zyklen" ist aber etwas anderes als "keine" - und der Unterschied ist genau
 * der, auf den es beim Sammeln ankommt.
 */
export function balkenBreite(wert, maximum) {
  if (!(wert > 0)) return 0;
  if (!(maximum > 0)) return 0;
  return Math.max(2, Math.round((wert / maximum) * 100));
}

/**
 * Eine Balkenzeile.
 *
 * Die Breite kommt ueber die CSSOM, nicht als style-Attribut: die CSP der
 * Seite erlaubt kein Inline-Style, und das soll sie auch nicht.
 */
function balken(ziel, label, wert, maximum, text) {
  const row = document.createElement('div');
  row.className = 'bar-row';
  if (!wert) row.classList.add('is-empty');

  const l = document.createElement('div');
  l.className = 'bar-label';
  l.textContent = label;

  const track = document.createElement('div');
  track.className = 'bar-track';
  const fill = document.createElement('span');
  fill.style.width = `${balkenBreite(wert, maximum)}%`;
  track.append(fill);

  const v = document.createElement('div');
  v.className = 'bar-value';
  v.textContent = text;

  row.append(l, track, v);
  ziel.append(row);
}

function zeigeKacheln(health, collectedAt) {
  const ziel = el('tiles');
  ziel.replaceChildren();

  const zyklen = reihen.reduce((s, r) => s + r.zyklen, 0);
  const reif = reihen.filter((r) => r.zyklen >= 4).length;
  const mitTimer = reihen.filter((r) => r.spanne !== null).length;
  const punkte = health?.points ?? reihen.reduce((s, r) => s + r.punkte, 0);

  const stunden = health && health.first && health.last
    ? (health.last - health.first) / 3600000
    : null;

  ziel.append(
    kachel('Messpunkte', zahl(punkte), stunden ? `über ${stunden.toFixed(1)} h` : ''),
    kachel('Reihen', zahl(reihen.length), `${zahl(mitTimer)} mit eingegrenztem Timer`),
    kachel('Nachfüll-Zyklen', zahl(zyklen), 'die eigentliche Währung'),
    kachel('Reihen ab 4 Zyklen', zahl(reif),
      reihen.length ? `${Math.round((reif / reihen.length) * 100)} % — je mehr, desto enger der Timer` : ''),
    kachel('Zuletzt gesammelt', collectedAt ? alter(collectedAt) : '—',
      health ? 'lokaler Sammler' : 'aus der Datei'),
  );
}

function alter(ts) {
  const min = (Date.now() - ts) / MINUTE;
  if (min < 1) return 'gerade eben';
  if (min < 90) return `vor ${Math.round(min)} min`;
  return `vor ${(min / 60).toFixed(1)} h`;
}

function zeigeReife() {
  const ziel = el('reife');
  ziel.replaceChildren();
  const gesamt = reihen.length || 1;
  for (const grenze of [1, 3, 4, 10, 20]) {
    const n = reihen.filter((r) => r.zyklen >= grenze).length;
    balken(ziel, `ab ${grenze} Zyklen`, n, gesamt, `${n} von ${reihen.length} · ${Math.round((n / gesamt) * 100)} %`);
  }
}

function zeigeModelle() {
  const ziel = el('modelle');
  ziel.replaceChildren();
  const zaehler = new Map();
  for (const r of reihen) {
    const k = r.modell ?? 'zu wenig geprüft';
    zaehler.set(k, (zaehler.get(k) || 0) + 1);
  }
  const sortiert = [...zaehler.entries()].sort((a, b) => b[1] - a[1]);
  const max = sortiert.length ? sortiert[0][1] : 1;
  for (const [name, n] of sortiert) balken(ziel, name, n, max, `${n} Reihen`);
}

function zeigeLaender() {
  const ziel = el('laender');
  ziel.replaceChildren();
  const proLand = new Map();
  for (const r of reihen) {
    const e = proLand.get(r.code) || { zyklen: 0, reihen: 0 };
    e.zyklen += r.zyklen;
    e.reihen += 1;
    proLand.set(r.code, e);
  }
  const sortiert = [...proLand.entries()].sort((a, b) => b[1].zyklen - a[1].zyklen);
  const max = sortiert.length ? sortiert[0][1].zyklen : 1;
  for (const [code, e] of sortiert) {
    balken(ziel, countryName(code), e.zyklen, max, `${e.zyklen} · ${e.reihen} Reihen`);
  }
}

function zelle(text, label, klasse = '') {
  const td = document.createElement('td');
  td.textContent = text;
  td.dataset.label = label;
  if (klasse) td.className = klasse;
  return td;
}

function zeigeTabelle() {
  const body = el('reihenBody');
  body.replaceChildren();

  const wie = el('sortSelect').value;
  const sortiert = [...reihen].sort((a, b) => {
    if (wie === 'points') return b.punkte - a.punkte;
    if (wie === 'timer') {
      // Ohne Einklammerung ganz nach hinten: "keine Angabe" ist kein guter Wert.
      if (a.spanne === null) return 1;
      if (b.spanne === null) return -1;
      return a.spanne - b.spanne;
    }
    return b.zyklen - a.zyklen;
  });

  for (const r of sortiert) {
    const tr = document.createElement('tr');
    tr.append(
      zelle(`${countryName(r.code)} · ${r.itemId}`, 'Item'),
      zelle(zahl(r.punkte), 'Punkte'),
      zelle(zahl(r.zyklen), 'Zyklen'),
      zelle(
        r.spanne === null
          ? 'zu wenig Daten'
          : `${r.timer.low.toFixed(0)}–${r.timer.high.toFixed(0)} min`,
        'Timer',
        r.spanne === null ? 'muted' : '',
      ),
      zelle(r.modell ?? 'zu wenig geprüft', 'Modell', r.modell ? '' : 'muted'),
    );
    body.append(tr);
  }
}

// ---------- Ablauf ----------

async function laden() {
  const btn = el('reload');
  btn.disabled = true;
  setStatus('Lade Messreihen…');

  try {
    const [{ series, collectedAt }, health] = await Promise.all([ladeReihen(), ladeHealth()]);
    const schluessel = Object.keys(series);

    if (!schluessel.length) {
      setStatus('Noch nichts gesammelt.', 'error');
      reihen = [];
    } else {
      setStatus(`Werte ${schluessel.length} Reihen aus…`);
      // Kurz Luft lassen, damit die Statuszeile vor der Rechnung erscheint -
      // sonst steht die Seite bei 227 Reihen ohne Erklaerung still.
      await new Promise((r) => setTimeout(r, 0));
      reihen = schluessel.map((k) => auswerten(k, series[k]));
      setStatus(`${reihen.length} Reihen ausgewertet.`, 'ok');
    }

    zeigeKacheln(health, collectedAt);
    zeigeReife();
    zeigeModelle();
    zeigeLaender();
    zeigeTabelle();
  } catch (err) {
    setStatus(`Messreihen nicht verfügbar (${err.message}).`, 'error');
  } finally {
    btn.disabled = false;
  }
}

// Nur im Browser starten. Ohne diese Bedingung faehrt die Datei beim blossen
// Import hoch und greift auf ein DOM zu, das im Test nicht existiert - dann
// waere die Rechnung dieser Seite nur ueber einen vorgetaeuschten Browser
// pruefbar, und geprueft wuerde am Ende die Taeuschung.
if (typeof document !== 'undefined') {
  showVersion();
  el('reload').addEventListener('click', laden);
  el('sortSelect').addEventListener('change', zeigeTabelle);
  laden();
}
