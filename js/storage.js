import { DEFAULTS, STORAGE_KEY } from './config.js?v=17';

export function loadSettings() {
  let stored = {};
  try {
    stored = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
  } catch {
    stored = {};
  }
  return { ...DEFAULTS, ...stored };
}

/**
 * Schreibt Einstellungen, ohne die nicht genannten zu verlieren.
 *
 * Das Formular des Scanners kennt nur seine eigenen Felder. Wurde sein
 * Ergebnis direkt gespeichert, fielen alle uebrigen Schluessel heraus und
 * standen beim naechsten Laden wieder auf der Vorgabe - der gemerkte
 * Ledger-Zeitraum, die gemessenen Reisezeiten, die Kapazitaet. Deshalb wird
 * ueber den gespeicherten Stand gelegt statt ihn zu ersetzen.
 */
export function saveSettings(settings) {
  const clean = { ...loadSettings() };
  for (const key of Object.keys(DEFAULTS)) {
    if (settings[key] !== undefined) clean[key] = settings[key];
  }
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(clean));
  } catch {
    // Privater Modus o.ae. - die Einstellungen gelten dann nur fuer diese Sitzung.
  }
  return clean;
}

/** Unterscheidet den ersten Besuch von einer bereits eingerichteten Instanz. */
export function hasSavedSettings() {
  try {
    return localStorage.getItem(STORAGE_KEY) !== null;
  } catch {
    return false;
  }
}

export function clearSettings() {
  localStorage.removeItem(STORAGE_KEY);
}
