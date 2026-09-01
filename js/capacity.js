// Kapazitaet und Flugart aus Torn lesen, statt sie einstellen zu lassen.
//
// Beides steht in der API und beides braucht nur einen Minimal-Key - die
// niedrigste Stufe, die Torn kennt:
//
//   /user/travel  method: Private | Business | Airstrip | Standard
//   /user/perks   Listen von Beschreibungen je Quelle (job, faction, book, …)
//
// Die Perks kommen als freier Text, nicht als Zahlen. Es gibt keinen
// dokumentierten Katalog, also wird gesucht statt angenommen: jede Zeile, die
// von Reisegepaeck spricht und eine Zahl nennt, zaehlt. Was dabei erkannt
// wurde, zeigt die Seite an - eine Kapazitaet, die man nicht nachvollziehen
// kann, waere schlimmer als eine, die man selbst eintraegt.

/** Grundkapazitaet ohne jeden Bonus. */
export const BASE_CAPACITY = 5;

// "+ 5 travel items", "Increases maximum travel items by 5", "5x travel items"
const TRAVEL_PERK = /(?:\+\s*)?(\d+)\s*(?:x\s*)?(?:maximum\s+|extra\s+|additional\s+)?travel\s+item/i;
const TRAVEL_PERK_SUFFIX = /travel\s+item[a-z ]*?by\s+(\d+)/i;

/**
 * Summiert die Kapazitaets-Boni aus den Perk-Listen.
 *
 * @param {object} perks  { job: string[], faction: string[], … }
 * @returns {{base:number, bonus:number, total:number, matched:Array<{source:string,text:string,value:number}>}}
 */
export function capacityFromPerks(perks) {
  const matched = [];
  if (perks && typeof perks === 'object') {
    for (const [source, list] of Object.entries(perks)) {
      if (!Array.isArray(list)) continue;
      for (const raw of list) {
        const text = String(raw || '');
        if (!/travel/i.test(text)) continue;
        const hit = TRAVEL_PERK.exec(text) || TRAVEL_PERK_SUFFIX.exec(text);
        const value = hit ? Number(hit[1]) : NaN;
        if (Number.isFinite(value) && value > 0) matched.push({ source, text, value });
      }
    }
  }

  const bonus = matched.reduce((sum, m) => sum + m.value, 0);
  return { base: BASE_CAPACITY, bonus, total: BASE_CAPACITY + bonus, matched };
}

/** Torns Bezeichnung der Flugart auf unsere Liste abbilden. */
export function flyMethodKey(method) {
  const key = String(method || '').trim().toLowerCase();
  return ['standard', 'airstrip', 'private', 'business'].includes(key) ? key : null;
}
