// Der Nachschub-Zyklus eines Auslandsshops.
//
// Der Mechanismus im Spiel: erreicht ein Item 0, laeuft ein Timer los, und
// nach dessen Ablauf wird nachgelegt. Die Dauer ist je Item verschieden, aber
// fuer dasselbe Item fest. Der Zyklus haengt also am Ausverkauf, nicht an der
// Uhr - eine Annahme fester Abstaende (wie sie das erste Modell traf) geht
// daran systematisch vorbei.
//
// Daraus folgt, was zu schaetzen ist:
//
//   Timer       Zeit vom Ausverkauf bis zum Nachschub. Fest je Item.
//   Menge       Wieviel dabei ins Regal kommt. Naeherung: das Maximum, das je
//               gesehen wurde.
//   Abverkauf   Wie schnell es wieder leer wird - bestimmt, wann der naechste
//               Timer startet.
//
// Der Kniff bei fremden Daten: den genauen Moment des Ausverkaufs sieht
// niemand. Man sieht nur "um 12:00 waren noch 40 da" und "um 12:30 war es
// leer". Der Ausverkauf liegt also *irgendwo* dazwischen. Genauso beim
// Nachschub. Jeder Zyklus liefert damit kein Datum, sondern ein Intervall -
// und aus mehreren Intervallen wird der Timer eng, ohne dass je ein einzelner
// Zeitpunkt bekannt waere. Das ist der Unterschied zwischen "ungefaehr eine
// Stunde" und "zwischen 47 und 53 Minuten".

const MINUTE = 60 * 1000;

/**
 * Findet die Nachschub-Zyklen einer Messreihe.
 *
 * @returns {Array<{selloutFrom:number|null, selloutTo:number,
 *                  restockFrom:number|null, restockTo:number|null,
 *                  amount:number|null, open:boolean}>}
 */
export function findCycles(series = []) {
  const points = [...series].sort((a, b) => a[0] - b[0]);
  const cycles = [];

  let i = 0;
  while (i < points.length) {
    if (points[i][1] !== 0) { i += 1; continue; }

    // Anfang und Ende einer Null-Strecke.
    const start = i;
    let end = i;
    while (end + 1 < points.length && points[end + 1][1] === 0) end += 1;

    const before = start > 0 ? points[start - 1] : null;
    const after = end + 1 < points.length ? points[end + 1] : null;

    cycles.push({
      // Ausverkauf: nach der letzten Messung mit Ware, spaetestens bei der
      // ersten Null.
      selloutFrom: before ? before[0] : null,
      selloutTo: points[start][0],
      // Nachschub: nach der letzten Null, spaetestens bei der naechsten
      // Messung mit Ware.
      restockFrom: after ? points[end][0] : null,
      restockTo: after ? after[0] : null,
      amount: after ? after[1] : null,
      // Noch keine Ware gesehen: der Zyklus laeuft gerade.
      open: !after,
    });
    i = end + 1;
  }

  return cycles;
}

/**
 * Schaetzt den Timer aus den Zyklen - als Intervall, nicht als Zahl.
 *
 * Jeder abgeschlossene Zyklus grenzt den Timer von zwei Seiten ein. Ueberlappen
 * sich die Grenzen aller Zyklen, ist der Schnitt die Antwort: enger als jede
 * einzelne Beobachtung. Widersprechen sie sich - weil die Daten rauschen oder
 * der Timer doch schwankt -, wird der Median der Mittelwerte genommen und die
 * Spanne offen ausgewiesen.
 *
 * @returns {{minutes:number, low:number, high:number, cycles:number,
 *            method:'schnitt'|'median'}|null}
 */
export function estimateTimer(cycles) {
  const usable = cycles.filter((c) => (
    !c.open && c.selloutFrom !== null && c.restockFrom !== null
  ));
  if (!usable.length) return null;

  const bounds = usable.map((c) => ({
    // Kuerzestmoeglich: spaetester Ausverkauf bis fruehester Nachschub.
    low: Math.max(0, (c.restockFrom - c.selloutTo) / MINUTE),
    // Laengstmoeglich: fruehester Ausverkauf bis spaetester Nachschub.
    high: (c.restockTo - c.selloutFrom) / MINUTE,
  }));

  const low = Math.max(...bounds.map((b) => b.low));
  const high = Math.min(...bounds.map((b) => b.high));

  if (low <= high) {
    return {
      minutes: (low + high) / 2,
      low,
      high,
      cycles: usable.length,
      method: 'schnitt',
    };
  }

  // Kein gemeinsamer Schnitt: die Beobachtungen widersprechen sich.
  const mids = bounds.map((b) => (b.low + b.high) / 2).sort((a, b) => a - b);
  const mid = mids[Math.floor(mids.length / 2)];
  return {
    minutes: mid,
    low: Math.min(...bounds.map((b) => b.low)),
    high: Math.max(...bounds.map((b) => b.high)),
    cycles: usable.length,
    method: 'median',
  };
}

/** Wieviel bei einem Nachschub ins Regal kommt. Naeherung: das je gesehene Maximum. */
export function estimateCapacity(series = [], cycles = []) {
  const seen = series.map((p) => p[1]);
  const afterRestock = cycles.map((c) => c.amount).filter((a) => Number.isFinite(a) && a > 0);
  const candidates = [...seen, ...afterRestock].filter((q) => Number.isFinite(q));
  return candidates.length ? Math.max(...candidates) : null;
}

/**
 * Rechnet den Zyklus vorwaerts.
 *
 * Kein Blindflug ueber Formeln, sondern der Mechanismus selbst: Ware wird
 * weniger, bis sie null ist; dann laeuft der Timer; dann ist das Regal wieder
 * voll. Was dabei an Nachschuben anfaellt, wird mitgegeben - denn genau das
 * ist die Auskunft, auf die es ankommt: nicht "wieviel", sondern "wann
 * wieder".
 *
 * @returns {{quantity:number, restocks:Array<number>, selloutAt:number|null}}
 */
export function simulate({
  quantity, from, drainPerMinute, timerMinutes, capacity, lastSelloutAt = null,
}, until) {
  const restocks = [];
  let q = Math.max(0, quantity);
  let t = from;
  let selloutAt = q === 0 ? lastSelloutAt : null;
  let firstSellout = null;

  // Ohne Timer laesst sich ein leeres Regal nicht weiterrechnen.
  const timer = Number.isFinite(timerMinutes) && timerMinutes > 0 ? timerMinutes : null;
  const drain = Number.isFinite(drainPerMinute) && drainPerMinute > 0 ? drainPerMinute : 0;
  const max = Number.isFinite(capacity) && capacity > 0 ? capacity : null;

  // Schutz vor einer Endlosschleife bei sehr kurzem Timer und langem Flug.
  for (let guard = 0; guard < 500 && t < until; guard += 1) {
    if (q > 0) {
      if (drain <= 0) { t = until; break; }
      const emptyAt = t + (q / drain) * MINUTE;
      if (emptyAt >= until) {
        q = Math.max(0, q - drain * ((until - t) / MINUTE));
        t = until;
        break;
      }
      t = emptyAt;
      q = 0;
      selloutAt = t;
      if (firstSellout === null) firstSellout = t;
    } else {
      if (timer === null || selloutAt === null || max === null) { t = until; break; }
      const restockAt = selloutAt + timer * MINUTE;
      if (restockAt >= until) { t = until; break; }
      t = restockAt;
      q = max;
      restocks.push(t);
      selloutAt = null;
    }
  }

  return { quantity: Math.round(q), restocks, selloutAt: firstSellout };
}

/**
 * Wann kommt der naechste Nachschub?
 *
 * Zwei Faelle: das Regal ist leer - dann laeuft der Timer bereits, und der
 * Zeitpunkt steht fest. Oder es ist noch Ware da - dann muss erst der
 * Ausverkauf geschaetzt werden, und die Unsicherheit des Abverkaufs kommt zu
 * der des Timers hinzu.
 *
 * @returns {{at:number, from:number, to:number, waiting:boolean}|null}
 */
export function nextRestock({
  quantity, at, drainPerMinute, timer, lastSelloutAt,
}, now = Date.now()) {
  if (!timer) return null;

  if (quantity === 0) {
    if (!lastSelloutAt) return null;
    return {
      at: lastSelloutAt + timer.minutes * MINUTE,
      from: lastSelloutAt + timer.low * MINUTE,
      to: lastSelloutAt + timer.high * MINUTE,
      waiting: true,
    };
  }

  const drain = Number.isFinite(drainPerMinute) && drainPerMinute > 0 ? drainPerMinute : 0;
  if (drain <= 0) return null;

  // Vom Stand der letzten Messung aus leerlaufen lassen, nicht von jetzt.
  const emptyAt = at + (quantity / drain) * MINUTE;
  return {
    at: Math.max(now, emptyAt) + timer.minutes * MINUTE,
    from: Math.max(now, emptyAt) + timer.low * MINUTE,
    to: Math.max(now, emptyAt) + timer.high * MINUTE,
    waiting: false,
  };
}

// ---------- Kennzahlen wie im Torn Travel Planner ----------
//
// Damit zwei Werkzeuge nebeneinander nicht widerspruechlich aussehen, wird
// hier genau dessen Definition uebernommen: die Abverkaufsrate gilt je
// In-Stock-Fenster - vom Nachschub bis zur letzten Messung vor der Null (oder
// bis jetzt, solange noch Ware da ist) - und wird ueber die letzten N Fenster
// gemittelt.
//
// Das ist bewusst etwas anderes als die Schaetzung, mit der die App
// vorhersagt: die gewichtet nach Alter und nimmt den Median. Beide Zahlen
// haben ihren Zweck, und sie stehen deshalb nebeneinander statt vermischt.

/**
 * Zerlegt eine Reihe in Fenster, in denen Ware da war.
 *
 * @returns {Array<{from:number,to:number,startQty:number,endQty:number,
 *                  minutes:number,sold:number,rate:number,complete:boolean}>}
 */
export function inStockWindows(series = []) {
  const points = [...series].sort((a, b) => a[0] - b[0]);
  const windows = [];
  let start = null;

  for (let i = 0; i < points.length; i++) {
    const [ts, qty] = points[i];
    const prev = i > 0 ? points[i - 1][1] : null;

    // Ein Fenster beginnt beim Nachschub - oder mit der Reihe selbst, wenn
    // sie schon mit Ware anfaengt.
    if (qty > 0 && (start === null) && (prev === null || prev === 0)) {
      start = { ts, qty };
      continue;
    }

    if (start !== null && qty === 0) {
      // Gemessen wird bis zur letzten Messung *mit* Ware, nicht bis zur Null:
      // wann genau zwischen beiden ausverkauft wurde, weiss niemand.
      const last = points[i - 1];
      windows.push(makeWindow(start, last, true));
      start = null;
    }
  }

  if (start !== null) {
    const last = points[points.length - 1];
    if (last[0] > start.ts) windows.push(makeWindow(start, last, false));
  }
  return windows;
}

function makeWindow(start, last, complete) {
  const minutes = (last[0] - start.ts) / MINUTE;
  const sold = start.qty - last[1];
  return {
    from: start.ts,
    to: last[0],
    startQty: start.qty,
    endQty: last[1],
    minutes,
    sold,
    rate: minutes > 0 ? sold / minutes : 0,
    complete,
  };
}

/**
 * Mittlere Abverkaufsrate ueber die letzten `samples` Fenster.
 *
 * @returns {{rate:number, windows:number, requested:number}|null}
 */
export function windowRate(series = [], samples = 5) {
  const windows = inStockWindows(series).filter((w) => w.minutes > 0 && w.sold > 0);
  if (!windows.length) return null;
  const used = windows.slice(-Math.max(1, samples));
  return {
    rate: used.reduce((sum, w) => sum + w.rate, 0) / used.length,
    windows: used.length,
    requested: samples,
  };
}

/**
 * Die letzten Nachschub-Ereignisse mit ihrer Ausfalldauer.
 *
 * Die Dauer ist die Zeit, in der das Regal leer stand - zwischen der ersten
 * Null und der ersten Messung mit Ware. Sie ist damit etwas laenger als der
 * eigentliche Timer, weil der Ausverkauf schon vor der ersten Null lag.
 */
export function recentRestocks(series = [], count = 5) {
  return findCycles(series)
    .filter((c) => !c.open && c.restockTo !== null)
    .map((c) => ({
      at: c.restockTo,
      outageMinutes: (c.restockTo - c.selloutTo) / MINUTE,
      amount: c.amount,
      // Wie genau der Zeitpunkt bekannt ist: die Luecke zwischen letzter Null
      // und erster Messung mit Ware.
      uncertaintyMinutes: (c.restockTo - c.restockFrom) / MINUTE,
    }))
    .slice(-count)
    .reverse();
}

/**
 * Abverkauf nach Tageszeit, in Stunden-Eimern.
 *
 * Jeder fallende Abschnitt zaehlt fuer die Stunde, in der er endet. Damit
 * zeigt sich, wann ein Regal schnell leergeht - abends anders als nachts.
 */
export function hourProfile(series = []) {
  const points = [...series].sort((a, b) => a[0] - b[0]);
  const buckets = Array.from({ length: 24 }, () => ({ sold: 0, minutes: 0, samples: 0 }));

  for (let i = 1; i < points.length; i++) {
    const [t0, q0] = points[i - 1];
    const [t1, q1] = points[i];
    const minutes = (t1 - t0) / MINUTE;
    if (minutes <= 0 || q1 >= q0) continue;

    const hour = new Date(t1).getHours();
    buckets[hour].sold += q0 - q1;
    buckets[hour].minutes += minutes;
    buckets[hour].samples += 1;
  }

  return buckets.map((b, hour) => ({
    hour,
    samples: b.samples,
    rate: b.minutes > 0 ? b.sold / b.minutes : null,
  }));
}
