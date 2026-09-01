// Die Absicherung um das Sprachmodell herum.
//
// Der Aufruf selbst ist uninteressant - HTTP und JSON. Interessant ist die
// Zeile, die verhindert, dass eine erfundene Zahl durchkommt: ein Modell, das
// einen Preis halluziniert, klingt genau wie eines, das ihn abgelesen hat.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  numbersIn, onlyKnownNumbers, extractJson, validateTradeFields, available, chat, LlmError,
} from '../js/llm.js';

// ---------- Zahlen erkennen ----------

test('Zahlen werden auf ihre Ziffern reduziert', () => {
  // Torn schreibt Tausender mit Komma, wir nicht. Ohne Normalisierung schluege
  // die Pruefung bei jeder korrekten, nur anders formatierten Antwort an.
  assert.deepEqual([...numbersIn('$1,240,000')], ['1240000']);
  assert.deepEqual([...numbersIn('1.240.000')], ['1240000']);
  assert.deepEqual([...numbersIn('4x Xanax @ $830,000')], ['4', '830000']);
});

test('fuehrende Nullen fallen zusammen', () => {
  assert.ok(numbersIn('007').has('7'));
});

test('ohne Zahlen ist die Menge leer', () => {
  assert.equal(numbersIn('kein Preis genannt').size, 0);
  assert.equal(numbersIn(null).size, 0);
  assert.equal(numbersIn(undefined).size, 0);
});

// ---------- Die eigentliche Absicherung ----------

test('eine Antwort aus bekannten Zahlen geht durch', () => {
  const fakten = 'You bought 4x Xanax from Duke @ $830,000';
  assert.equal(onlyKnownNumbers('{"quantity":4,"unitPrice":830000}', fakten).ok, true);
});

test('eine erfundene Zahl wird gefunden', () => {
  // Der Fall, um den es geht: das Modell rechnet 4 x 830.000 aus und schreibt
  // die Summe hin. Plausibel, richtig gerechnet - und trotzdem eine Zahl, die
  // in der Eingabe nicht steht. Gerechnet wird im Code.
  const fakten = 'You bought 4x Xanax from Duke @ $830,000';
  const pruefung = onlyKnownNumbers('{"quantity":4,"total":3320000}', fakten);
  assert.equal(pruefung.ok, false);
  assert.deepEqual(pruefung.unknown, ['3320000']);
});

test('andere Schreibweise derselben Zahl ist keine Erfindung', () => {
  const fakten = 'gekauft für $1,240,000';
  assert.equal(onlyKnownNumbers('Preis: 1240000', fakten).ok, true);
});

test('eine Antwort ohne Zahlen ist immer zulaessig', () => {
  assert.equal(onlyKnownNumbers('nicht erkennbar', 'egal was').ok, true);
});

// ---------- JSON aus Fliesstext ----------

test('JSON wird auch aus einem Markdown-Block geholt', () => {
  // Kleine Modelle halten sich nicht immer an "nur JSON", und das allein ist
  // kein Grund, eine sonst richtige Antwort wegzuwerfen.
  assert.deepEqual(extractJson('Hier das Ergebnis:\n```json\n{"a":1}\n```\nFertig.'), { a: 1 });
  assert.deepEqual(extractJson('{"a":1}'), { a: 1 });
});

test('kaputtes JSON gibt null statt zu werfen', () => {
  assert.equal(extractJson('{"a":'), null);
  assert.equal(extractJson('gar kein JSON'), null);
  assert.equal(extractJson(''), null);
});

test('verschachtelte Objekte bleiben ganz', () => {
  assert.deepEqual(extractJson('x {"a":{"b":2}} y'), { a: { b: 2 } });
});

// ---------- Feldpruefung ----------

const FAKT = 'You bought 4x Xanax from Duke @ $830,000';

test('eine saubere Antwort besteht', () => {
  const r = validateTradeFields({ kind: 'buy', quantity: 4, unitPrice: 830000 }, FAKT);
  assert.equal(r.ok, true);
  assert.deepEqual(r.value, { kind: 'buy', quantity: 4, unitPrice: 830000 });
});

test('eine ausgerechnete Zahl faellt durch, auch wenn sie stimmt', () => {
  // 4 x 830.000 = 3.320.000 ist richtig. Es steht nur nicht da.
  const r = validateTradeFields({ kind: 'buy', quantity: 4, unitPrice: 3320000 }, FAKT);
  assert.equal(r.ok, false);
  assert.match(r.reason, /steht nicht in der Eingabe/);
});

test('unbrauchbare Felder werden benannt, nicht verschluckt', () => {
  for (const [antwort, muster] of [
    [{ kind: 'trade', quantity: 4, unitPrice: 830000 }, /unbekannte Art/],
    [{ kind: 'buy', quantity: 0, unitPrice: 830000 }, /Menge unbrauchbar/],
    [{ kind: 'buy', quantity: 4.5, unitPrice: 830000 }, /Menge unbrauchbar/],
    [{ kind: 'buy', quantity: 4, unitPrice: -1 }, /Preis unbrauchbar/],
    // Number(null) ist 0: ohne eine ausdrueckliche Pruefung wuerde ein nicht
    // erkanntes Feld zu einem Preis von null Dollar statt zu einer Ablehnung.
    [{ kind: 'buy', quantity: 4, unitPrice: null }, /Preis unbrauchbar/],
    [{ kind: 'buy', quantity: null, unitPrice: 830000 }, /Menge unbrauchbar/],
    [{ kind: 'buy', quantity: 4, unitPrice: '' }, /Preis unbrauchbar/],
    [{ kind: 'buy', quantity: 4 }, /Preis unbrauchbar/],
    [null, /keine JSON-Antwort/],
  ]) {
    const r = validateTradeFields(antwort, FAKT);
    assert.equal(r.ok, false, JSON.stringify(antwort));
    assert.match(r.reason, muster);
  }
});

// ---------- Kein Modell da ----------

test('ein fehlendes Ollama ist kein Fehler, sondern eine Antwort', () => {
  // Auf jeder Maschine ausser der einen laeuft kein Sprachmodell. Der Rest der
  // App muss davon unberuehrt bleiben.
  return available('http://127.0.0.1:1', {}).then((state) => {
    assert.equal(state.ok, false);
    assert.deepEqual(state.models, []);
    assert.ok(state.reason);
  });
});

test('chat ohne Modellnamen wirft sofort, statt zu fragen', async () => {
  await assert.rejects(() => chat({ prompt: 'x' }), LlmError);
});

test('ein nicht erreichbares Ollama wirft LlmError, nicht irgendetwas', async () => {
  // Der Aufrufer soll den Fall unterscheiden koennen, ohne den Text zu lesen.
  await assert.rejects(
    () => chat({ base: 'http://127.0.0.1:1', model: 'egal', prompt: 'x', timeoutMs: 2000 }),
    LlmError,
  );
});
