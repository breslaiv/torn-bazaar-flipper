import test from 'node:test';
import assert from 'node:assert/strict';
import {
  COUNTRIES, countryCode, countryName, travelFactor, oneWayMinutes,
  rateItem, planCountry, planTrips, departure, messeFlug, FLIGHT_MIN_MINUTES,
} from '../js/travel.js';

const base = { travelCapacity: 5, budget: 0, marketFeePct: 0, travelAirstrip: 'standard' };
const item = (over = {}) => ({ itemId: 260, itemName: 'Dahlia', cost: 400, quantity: 100, ...over });

test('Laendernamen kommen in mehreren Schreibweisen an', () => {
  // YATA benennt Laender je nach Route anders; ein Land, das nur am
  // Schluessel scheitert, waere ein stiller Verlust.
  assert.equal(countryCode('mex'), 'mex');
  assert.equal(countryCode('Mexico'), 'mex');
  assert.equal(countryCode('United Kingdom'), 'uni');
  assert.equal(countryCode('south africa'), 'sou');
  assert.equal(countryCode('southafrica'), 'sou');
  assert.equal(countryCode('Mars'), null);
  assert.equal(countryName('jap'), 'Japan');
});

test('der Flieger kuerzt die Reisezeit, die gemessene Zeit schlaegt alles', () => {
  assert.equal(oneWayMinutes('mex', base), 26);
  assert.equal(oneWayMinutes('mex', { ...base, travelAirstrip: 'airstrip' }), 26 * 0.7);
  assert.equal(travelFactor('business'), 0.3);

  // Eine gemessene Zeit enthaelt bereits alles an Perks - sie darf nicht
  // noch einmal mit dem Faktor multipliziert werden.
  assert.equal(oneWayMinutes('mex', { ...base, travelAirstrip: 'business', travelTimes: { mex: 18 } }), 18);
  assert.equal(oneWayMinutes('nirgendwo', base), null);
});

test('drei Grenzen, und die kleinste gewinnt', () => {
  // Koffer, Regal, Geldbeutel - eine Menge, die an einer davon scheitert,
  // waere eine Zahl, die man nicht kaufen kann.
  assert.equal(rateItem(item(), 1000, { ...base, travelCapacity: 5 }).units, 5);
  assert.equal(rateItem(item({ quantity: 2 }), 1000, base).units, 2);
  assert.equal(rateItem(item(), 1000, { ...base, budget: 1200 }).units, 3);

  assert.equal(rateItem(item({ quantity: 2 }), 1000, base).limitedBy, 'Vorrat');
  assert.equal(rateItem(item(), 1000, { ...base, budget: 1200 }).limitedBy, 'Budget');
  assert.equal(rateItem(item(), 1000, base).limitedBy, 'Kapazität');
});

test('der Ertrag rechnet mit dem Netto nach Gebuehr', () => {
  const r = rateItem(item(), 1000, { ...base, marketFeePct: 10 });
  assert.equal(r.netPrice, 900);
  assert.equal(r.profitPerUnit, 500);
  assert.equal(r.tripProfit, 2500, '5 Stueck');
  assert.equal(r.spend, 2000);
});

test('ohne Marktpreis wird kein Ertrag behauptet', () => {
  const r = rateItem(item(), 0, base);
  assert.equal(r.profitPerUnit, null);
  assert.equal(r.tripProfit, null);
});

test('pro Minute, nicht pro Flug - sonst fliegt man zu weit', () => {
  // Suedafrika bringt pro Flug mehr, dauert aber elfmal so lang wie Mexiko.
  const prices = new Map([[1, { marketPrice: 1000 }], [2, { marketPrice: 12000 }]]);
  const stocks = new Map([
    ['mex', [{ itemId: 1, itemName: 'Nah', cost: 100, quantity: 100 }]],
    ['sou', [{ itemId: 2, itemName: 'Fern', cost: 5000, quantity: 100 }]],
  ]);

  const trips = planTrips(stocks, prices, base);
  // Mexiko: 4500 in 52 min = 87/min. Suedafrika: 35000 in 594 min = 59/min.
  assert.equal(trips[0].code, 'mex');
  assert.ok(trips[0].profitPerMinute > trips[1].profitPerMinute);
  assert.ok(trips[1].tripProfit > trips[0].tripProfit, 'pro Flug ist Suedafrika trotzdem groesser');
});

test('ein Land ohne lohnende Ware faellt aus der Planung', () => {
  const prices = new Map([[1, { marketPrice: 100 }]]);
  const plan = planCountry('mex', [{ itemId: 1, itemName: 'Teuer', cost: 500, quantity: 10 }], prices, base);
  assert.equal(plan.items.length, 0);
  assert.equal(plan.best, null);
  assert.equal(plan.profitPerMinute, null);
});

test('jedes Land der Tabelle hat eine Zeit', () => {
  for (const c of COUNTRIES) {
    assert.ok(oneWayMinutes(c.code, base) > 0, c.name);
  }
});

test('geplant wird mit der Menge bei Landung, nicht mit der von jetzt', () => {
  // Der Fall aus dem Browsertest: ein leeres Regal, dessen Timer laeuft. Nach
  // dem Stand von jetzt faellt es aus der Planung - dabei ist es genau das
  // Ziel, auf das man wartet.
  const leerJetztVollSpaeter = item({ quantity: 0, expectedQuantity: 100 });
  const r = rateItem(leerJetztVollSpaeter, 1000, base);
  assert.equal(r.units, 5, 'die Kapazitaet bindet, nicht das leere Regal');
  assert.ok(r.tripProfit > 0);

  // Und andersherum: was jetzt voll ist, aber bis zur Landung leergekauft
  // wird, darf keinen Ertrag versprechen.
  const vollJetztLeerSpaeter = rateItem(item({ quantity: 100, expectedQuantity: 0 }), 1000, base);
  assert.equal(vollJetztLeerSpaeter.units, 0);
  assert.equal(vollJetztLeerSpaeter.limitedBy, 'nichts');
});

test('ohne Prognose gilt weiterhin der aktuelle Vorrat', () => {
  const r = rateItem(item({ quantity: 3 }), 1000, base);
  assert.equal(r.units, 3);
  assert.equal(r.limitedBy, 'Vorrat');
  assert.equal(r.expectedQuantity, null);
});

// ---------- Abflugzeit ----------

test('die Abflugzeit ist der Nachschub minus der Flugdauer', () => {
  // Die eigentliche Handlung beim Item-Running: nicht "wieviel steht jetzt
  // da", sondern "wann muss ich los, damit ich ankomme, wenn nachgelegt ist".
  const jetzt = Date.UTC(2026, 8, 1, 20, 0, 0);
  const nachschub = { at: jetzt + 90 * 60000 };

  const ab = departure(nachschub, 30, jetzt);
  assert.equal(ab.minutes, 60, '90 Minuten bis zum Nachschub, 30 Minuten Flug');
  assert.equal(ab.at, jetzt + 60 * 60000);
  assert.equal(ab.late, false);
});

test('ist der Flug laenger als die Wartezeit, ist es zu spaet', () => {
  // Dann landet man nach dem Nachschub - und andere waren vorher da. Die
  // Anzeige sagt in dem Fall "jetzt" statt einer Uhrzeit in der
  // Vergangenheit, denn eine vergangene Uhrzeit liest sich wie ein Vorschlag.
  const jetzt = Date.UTC(2026, 8, 1, 20, 0, 0);
  const ab = departure({ at: jetzt + 20 * 60000 }, 45, jetzt);
  assert.equal(ab.late, true);
  assert.ok(ab.minutes < 0);
});

test('ohne Timer oder ohne Flugdauer gibt es keine Abflugzeit', () => {
  // Lieber keine Angabe als eine erfundene: wer sich den Abend danach
  // richtet, verliert bei einer geratenen Zahl drei Stunden.
  const jetzt = Date.now();
  assert.equal(departure(null, 30, jetzt), null);
  assert.equal(departure({ at: jetzt + 60000 }, null, jetzt), null);
  assert.equal(departure({ at: jetzt + 60000 }, NaN, jetzt), null);
});

// ---------- Flugdauer stoppen ----------

test('eine gestoppte Flugdauer wird auf Minuten gerundet', () => {
  // Zwei Knopfdruecke haben keine Nachkommastelle an Genauigkeit.
  const start = Date.UTC(2026, 8, 2, 12, 0, 0);
  const r = messeFlug({ startedAt: start, now: start + 41.4 * 60000 });
  assert.equal(r.ok, true);
  assert.equal(r.minutes, 41);
});

test('ein Fehlgriff wird nicht als Flug gespeichert', () => {
  // Die gemessene Zeit schlaegt die Tabelle. Ein Fehlwert verdirbt also jede
  // Abflugempfehlung fuer dieses Ziel, bis ihn jemand bemerkt - lieber gar
  // keine Messung.
  const start = Date.UTC(2026, 8, 2, 12, 0, 0);
  const r = messeFlug({ startedAt: start, now: start + 30000 });
  assert.equal(r.ok, false);
  assert.match(r.grund, /kein Flug/);
});

test('eine vergessene Uhr wird nicht als Flug gespeichert', () => {
  // Suedafrika dauert ohne Perks knapp fuenf Stunden. Was laenger laeuft, ist
  // eine Uhr von gestern.
  const start = Date.UTC(2026, 8, 2, 12, 0, 0);
  const r = messeFlug({ startedAt: start, now: start + 14 * 3600e3 });
  assert.equal(r.ok, false);
  assert.match(r.grund, /zu lange/);
});

test('ohne Start gibt es keine Dauer', () => {
  assert.equal(messeFlug({}).ok, false);
  assert.equal(messeFlug({ startedAt: null }).ok, false);
  const start = Date.UTC(2026, 8, 2, 12, 0, 0);
  assert.equal(messeFlug({ startedAt: start, now: start - 60000 }).ok, false);
});

test('die kuerzeste moegliche Reise passt noch durch', () => {
  // Mexiko mit Business Class: 26 min mal 0,3 sind knapp acht Minuten. Die
  // Untergrenze darf die nicht abweisen.
  const kuerzeste = 26 * travelFactor('business');
  assert.ok(kuerzeste > FLIGHT_MIN_MINUTES, `${kuerzeste} min lieferte die Untergrenze aus`);

  const start = Date.UTC(2026, 8, 2, 12, 0, 0);
  assert.equal(messeFlug({ startedAt: start, now: start + kuerzeste * 60000 }).ok, true);
});

test('eine gemessene Zeit schlaegt die Tabelle', () => {
  // Der Grund, warum das Stoppen ueberhaupt lohnt: an dieser Zahl haengt die
  // Abflugempfehlung.
  assert.notEqual(oneWayMinutes('can', {}), 38);
  assert.equal(oneWayMinutes('can', { travelTimes: { can: 38 } }), 38);
});
