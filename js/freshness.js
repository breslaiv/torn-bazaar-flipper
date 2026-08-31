// Alter von Listings und Kaeufern.
//
// weav3r liefert zu jedem Listing content_updated und zu jedem Kaeufer
// last_trade und last_action - bisher wurden die Felder geholt und
// weggeworfen. Sie sind die einzige Auskunft darueber, ob die Ware ueberhaupt
// noch im Bazaar liegt: die Daten stammen aus einem Crawl, und ein Listing,
// das seit Tagen nicht mehr gesehen wurde, ist oft laengst verkauft.
//
// In welchem Format die Zeitstempel kommen, sagt die Spec nicht eindeutig -
// je nach Route sind ISO-Strings und Unix-Sekunden ueblich. Deshalb wird
// geraten statt angenommen, und im Zweifel gilt das Alter als unbekannt.
// Unbekannt ist hier ausdruecklich kein "sehr alt": ein Fehlgriff beim Format
// wuerde sonst stillschweigend jede Zeile aussortieren.

const SECOND = 1000;
const HOUR = 3600 * SECOND;

// Grenzen fuer die Plausibilitaet: vor 2010 gab es Torn zwar schon, aber
// keine weav3r-Daten, und ein Zeitstempel in der Zukunft ist ein Formatfehler.
const EARLIEST = Date.UTC(2010, 0, 1);

/** Zeitstempel in Millisekunden, oder null wenn nicht deutbar. */
export function toMillis(value, now = Date.now()) {
  if (value === null || value === undefined || value === '') return null;

  let ms = null;
  if (typeof value === 'number' && Number.isFinite(value)) {
    // Sekunden und Millisekunden lassen sich an der Groessenordnung
    // unterscheiden: eine Sekundenangabe von heute hat zehn Stellen.
    ms = value > 1e11 ? value : value * SECOND;
  } else if (typeof value === 'string') {
    const trimmed = value.trim();
    if (/^\d+$/.test(trimmed)) return toMillis(Number(trimmed), now);
    const parsed = Date.parse(trimmed);
    if (Number.isFinite(parsed)) ms = parsed;
  }

  if (ms === null || !Number.isFinite(ms)) return null;
  // Etwas Spielraum nach vorn: Serveruhr und Browseruhr laufen nie gleich.
  if (ms < EARLIEST || ms > now + 6 * HOUR) return null;
  return ms;
}

/** Alter in Stunden, oder null wenn der Zeitstempel nicht zu deuten war. */
export function ageHours(value, now = Date.now()) {
  const ms = toMillis(value, now);
  if (ms === null) return null;
  return Math.max(0, (now - ms) / HOUR);
}

/** Kurz und ohne Nachkommastellen, damit es in eine Tabellenzelle passt. */
export function fmtAge(hours) {
  if (!Number.isFinite(hours)) return '—';
  if (hours < 1) return '<1 h';
  if (hours < 48) return `${Math.round(hours)} h`;
  return `${Math.round(hours / 24)} d`;
}

/**
 * Aelter als erlaubt? Ein unbekanntes Alter faellt nie durch - siehe oben.
 * @param {number|null} hours
 * @param {number} maxHours 0 = kein Limit
 */
export function tooOld(hours, maxHours) {
  const max = Number(maxHours) || 0;
  if (max <= 0) return false;
  return Number.isFinite(hours) && hours > max;
}
