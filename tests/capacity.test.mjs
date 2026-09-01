import test from 'node:test';
import assert from 'node:assert/strict';
import { capacityFromPerks, flyMethodKey, BASE_CAPACITY } from '../js/capacity.js';
import { AIRSTRIPS } from '../js/travel.js';

test('Torns vier Flugarten sind alle abgebildet', () => {
  // Die Aufzaehlung stammt aus der Spec: Private | Business | Airstrip |
  // Standard. "Private" fehlte, bis der Abgleich es zeigte.
  for (const method of ['Private', 'Business', 'Airstrip', 'Standard']) {
    const key = flyMethodKey(method);
    assert.ok(key, `${method} nicht abgebildet`);
    assert.ok(AIRSTRIPS.some((a) => a.key === key), `${key} fehlt in der Auswahl`);
  }
});

test('unbekannte oder fehlende Flugart ergibt keine falsche Zuordnung', () => {
  // "Null if the player has never flown before" - dann bleibt die Auswahl
  // stehen, statt auf Standard zu springen.
  assert.equal(flyMethodKey(null), null);
  assert.equal(flyMethodKey('Rakete'), null);
  assert.equal(flyMethodKey(''), null);
});

test('Kapazitäts-Perks werden aus dem Fließtext gelesen', () => {
  const perks = {
    job: ['+ 2 travel items', 'Nichts mit Reisen zu tun'],
    faction: ['+ 10 travel items'],
    book: ['Increases maximum travel items by 4'],
    education: ['+ 5% merits'],
    merit: [],
  };
  const cap = capacityFromPerks(perks);

  assert.equal(cap.base, BASE_CAPACITY);
  assert.equal(cap.bonus, 16);
  assert.equal(cap.total, 21);
  assert.equal(cap.matched.length, 3);
  assert.deepEqual(cap.matched.map((m) => m.source).sort(), ['book', 'faction', 'job']);
});

test('was erkannt wurde, ist nachvollziehbar', () => {
  // Eine Kapazität, die man nicht überprüfen kann, wäre schlimmer als eine
  // selbst eingetragene.
  const cap = capacityFromPerks({ job: ['+ 2 travel items'] });
  assert.equal(cap.matched[0].text, '+ 2 travel items');
  assert.equal(cap.matched[0].value, 2);
});

test('ohne Perks bleibt die Grundkapazität', () => {
  for (const input of [null, undefined, {}, { job: null }, { job: [] }]) {
    const cap = capacityFromPerks(input);
    assert.equal(cap.total, BASE_CAPACITY, JSON.stringify(input));
    assert.equal(cap.matched.length, 0);
  }
});

test('Perks ohne Zahl oder ohne Reisebezug zählen nicht', () => {
  const cap = capacityFromPerks({
    job: ['travel items increased'],
    faction: ['+ 3 nerve'],
    property: ['Travel time reduced by 30%'],
  });
  assert.equal(cap.bonus, 0, 'Reisezeit ist keine Kapazität');
});
