import test from 'node:test';
import assert from 'node:assert/strict';

function fakeStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
  };
}
globalThis.localStorage = fakeStorage();

const { loadSettings, saveSettings, hasSavedSettings, clearSettings } = await import('../js/storage.js');
const { DEFAULTS } = await import('../js/config.js');

const reset = () => { globalThis.localStorage = fakeStorage(); };

test('Vorgaben gelten, solange nichts gespeichert ist', () => {
  reset();
  assert.equal(hasSavedSettings(), false);
  assert.equal(loadSettings().travelCapacity, DEFAULTS.travelCapacity);
});

test('teilweises Speichern loescht den Rest nicht', () => {
  // Das Scanner-Formular kennt nur seine eigenen Felder. Wurde sein Ergebnis
  // direkt gespeichert, fielen Ledger-Zeitraum, Kapazitaet und gemessene
  // Reisezeiten still auf die Vorgabe zurueck.
  reset();
  saveSettings({ ...DEFAULTS, travelCapacity: 19, ledgerPeriod: '7d', travelTimes: { mex: 18 } });
  saveSettings({ minProfitAbs: 50000, maxCandidates: 20 });

  const after = loadSettings();
  assert.equal(after.travelCapacity, 19, 'nicht genannte Schluessel bleiben stehen');
  assert.equal(after.ledgerPeriod, '7d');
  assert.deepEqual(after.travelTimes, { mex: 18 });
  assert.equal(after.minProfitAbs, 50000, 'genannte werden geschrieben');
});

test('nur bekannte Schluessel landen im Speicher', () => {
  reset();
  const clean = saveSettings({ ...DEFAULTS, boesartig: '<script>' });
  assert.equal(clean.boesartig, undefined);
  assert.equal(loadSettings().boesartig, undefined);
});

test('kaputter Speicherinhalt faellt auf die Vorgaben zurueck', () => {
  reset();
  globalThis.localStorage.setItem('tbf.settings.v2', 'kein json');
  assert.equal(loadSettings().scanMode, DEFAULTS.scanMode);
});

test('zuruecksetzen entfernt auch die Keys', () => {
  reset();
  saveSettings({ ...DEFAULTS, tornKey: 'geheim', weav3rKey: 'auch geheim' });
  clearSettings();
  assert.equal(hasSavedSettings(), false);
  assert.equal(loadSettings().tornKey, '');
});
