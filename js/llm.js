// Anbindung an ein lokales Sprachmodell über die Ollama-Schnittstelle.
//
// Die Regel, unter der das hier überhaupt existiert: **das Modell steht nie
// zwischen den Daten und einer Zahl.** Timer-Schätzung, FIFO, Rucksack,
// konforme Bänder und die Modellwahl bleiben deterministisch und getestet. Ein
// Modell, das "ich schätze mal 45 Minuten" sagt, klingt genau wie eines, das
// rechnet — und den Unterschied merkt man erst, wenn der Flug leer ankommt.
//
// Was bleibt, sind die Textkanten: Freitext aus dem Torn-Log deuten, den ein
// handgeschriebener Ausdruck nicht trifft. Dafür ist ein Modell gebaut.
//
// Die Absicherung dazu steht weiter unten und ist der eigentliche Kern dieser
// Datei: onlyKnownNumbers(). Jede Ziffernfolge in einer Antwort muss in den
// übergebenen Fakten vorkommen. Damit kann das Modell schlecht formulieren,
// aber es kann keinen Preis erfinden.
//
// Kein npm-Paket: Ollama spricht schlichtes JSON über HTTP, das kann fetch.
//
// Läuft vorerst nur unter Node. Der Browser käme an 127.0.0.1:11434 nicht
// vorbei, weil die CSP `connect-src` namentlich auflistet — der saubere Weg
// wäre später ein Durchreichen über tools/serve.mjs, also same-origin, statt
// einen weiteren Host in die Liste zu schreiben.

export const OLLAMA_BASE = 'http://127.0.0.1:11434';

export class LlmError extends Error {}

/**
 * Ist überhaupt ein Modell da?
 *
 * Bewusst kein Werfen: der Aufrufer soll ohne Modell weiterlaufen können. Ein
 * fehlendes Sprachmodell ist kein Fehler, sondern der Normalfall auf jeder
 * Maschine außer dieser einen.
 */
export async function available(base = OLLAMA_BASE, { signal } = {}) {
  try {
    const res = await fetch(`${base}/api/tags`, { headers: { Accept: 'application/json' }, signal });
    if (!res.ok) return { ok: false, reason: `HTTP ${res.status}`, models: [] };
    const data = await res.json();
    const models = (Array.isArray(data.models) ? data.models : []).map((m) => ({
      name: m.name,
      size: Number(m.size) || 0,
      family: m.details?.family ?? null,
      parameters: m.details?.parameter_size ?? null,
      quantization: m.details?.quantization_level ?? null,
    }));
    return { ok: true, models };
  } catch (err) {
    return { ok: false, reason: err.message, models: [] };
  }
}

/**
 * Eine Frage, eine Antwort.
 *
 * @returns {{text:string, tokens:number, seconds:number, tokensPerSecond:number|null}}
 *   Die Geschwindigkeit kommt aus der Antwort selbst, nicht aus unserer Uhr —
 *   so misst sie das Modell und nicht die Netzwerklatenz.
 */
export async function chat({
  base = OLLAMA_BASE, model, system = null, prompt,
  json = false, temperature = 0, signal, timeoutMs = 120000,
} = {}) {
  if (!model) throw new LlmError('kein Modell angegeben');

  const messages = [];
  if (system) messages.push({ role: 'system', content: system });
  messages.push({ role: 'user', content: prompt });

  // Ein haengender Aufruf darf einen Sammellauf nicht blockieren.
  const timer = AbortSignal.timeout(timeoutMs);
  const combined = signal ? AbortSignal.any([signal, timer]) : timer;

  let res;
  try {
    res = await fetch(`${base}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      signal: combined,
      body: JSON.stringify({
        model,
        messages,
        stream: false,
        // Temperatur 0: bei Extraktion ist Kreativitaet kein Merkmal, sondern
        // ein Fehler.
        options: { temperature },
        ...(json ? { format: 'json' } : {}),
      }),
    });
  } catch (err) {
    throw new LlmError(`Ollama nicht erreichbar: ${err.message}`);
  }

  if (!res.ok) throw new LlmError(`Ollama HTTP ${res.status}`);
  const data = await res.json();
  const seconds = Number(data.eval_duration) / 1e9;
  const tokens = Number(data.eval_count) || 0;

  return {
    text: data.message?.content ?? '',
    tokens,
    seconds: Number.isFinite(seconds) ? seconds : 0,
    tokensPerSecond: seconds > 0 ? tokens / seconds : null,
  };
}

// ---------- Die Absicherung ----------

/**
 * Alle Zahlen in einem Text, auf ihre Ziffern reduziert.
 *
 * "$1,240,000" und "1240000" sind dieselbe Zahl; Torn schreibt Tausender mit
 * Komma, wir nicht. Ohne diese Normalisierung schlaegt die Pruefung bei jeder
 * korrekten Antwort an, die anders formatiert ist als die Eingabe.
 */
export function numbersIn(text) {
  const out = new Set();
  for (const m of String(text ?? '').matchAll(/\d[\d.,]*/g)) {
    const digits = m[0].replace(/[.,]/g, '');
    // Fuehrende Nullen weg, damit "007" und "7" zusammenfallen.
    const clean = digits.replace(/^0+(?=\d)/, '');
    if (clean) out.add(clean);
  }
  return out;
}

/**
 * Steht jede Zahl der Antwort auch in den Fakten?
 *
 * Das ist die Zeile, die das Modell von jeder erfundenen Zahl trennt. Kommt
 * eine Ziffernfolge in der Antwort vor, die in der Eingabe nicht existiert,
 * wird der Text verworfen und der Aufrufer faellt auf die nackte Rechnung
 * zurueck — lieber eine Luecke als eine plausible Zahl ohne Grundlage.
 *
 * @returns {{ok:boolean, unknown:string[]}}
 */
export function onlyKnownNumbers(answer, facts) {
  const known = numbersIn(facts);
  const unknown = [...numbersIn(answer)].filter((n) => !known.has(n));
  return { ok: unknown.length === 0, unknown };
}

/**
 * Das erste JSON-Objekt aus einer Antwort, oder null.
 *
 * Auch mit format:"json" packen kleine Modelle die Antwort gern in Fliesstext
 * oder einen Markdown-Block. Das hier ist die Toleranz dafuer — und sie ist
 * folgenlos, weil danach ohnehin jedes Feld geprueft wird.
 */
export function extractJson(text) {
  const raw = String(text ?? '');
  const start = raw.indexOf('{');
  if (start === -1) return null;
  // Von hinten suchen: das letzte } gehoert zum aeussersten Objekt.
  const end = raw.lastIndexOf('}');
  if (end <= start) return null;
  try {
    return JSON.parse(raw.slice(start, end + 1));
  } catch {
    return null;
  }
}

/**
 * Prueft eine Modellantwort auf Kauf/Verkauf-Felder.
 *
 * Nur ganze Zahlen, nur positive Mengen, und der Stueckpreis muss in der
 * Eingabe vorkommen. Ein Modell, das die Zahl "richtig ausgerechnet" hat, ist
 * hier ausdruecklich unerwuenscht: gerechnet wird im Code.
 *
 * @returns {{ok:boolean, value:object|null, reason:string|null}}
 */
export function validateTradeFields(parsed, factText) {
  if (!parsed || typeof parsed !== 'object') return fail('keine JSON-Antwort');

  const kind = parsed.kind;
  if (kind !== 'buy' && kind !== 'sell') return fail(`unbekannte Art: ${kind}`);

  // Number(null) ist 0 und Number('') auch. Ein Modell, das ein Feld nicht
  // erkennt, setzt es laut Anweisung auf null - ohne diese Zeile wuerde daraus
  // ein Preis von null Dollar statt einer Ablehnung.
  if (parsed.quantity === null || parsed.quantity === undefined || parsed.quantity === '') {
    return fail(`Menge unbrauchbar: ${parsed.quantity}`);
  }
  if (parsed.unitPrice === null || parsed.unitPrice === undefined || parsed.unitPrice === '') {
    return fail(`Preis unbrauchbar: ${parsed.unitPrice}`);
  }

  const quantity = Number(parsed.quantity);
  const unitPrice = Number(parsed.unitPrice);
  if (!Number.isInteger(quantity) || quantity <= 0) return fail(`Menge unbrauchbar: ${parsed.quantity}`);
  if (!Number.isFinite(unitPrice) || unitPrice < 0) return fail(`Preis unbrauchbar: ${parsed.unitPrice}`);

  const known = numbersIn(factText);
  for (const [feld, wert] of [['Menge', quantity], ['Preis', unitPrice]]) {
    if (!known.has(String(wert))) return fail(`${feld} ${wert} steht nicht in der Eingabe`);
  }

  return { ok: true, value: { kind, quantity, unitPrice }, reason: null };
}

function fail(reason) {
  return { ok: false, value: null, reason };
}
