import { DEFAULTS, STORAGE_KEY, ITEM_CACHE_KEY } from './config.js';

export function loadSettings() {
  let stored = {};
  try {
    stored = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
  } catch {
    stored = {};
  }
  return { ...DEFAULTS, ...stored };
}

export function saveSettings(settings) {
  const clean = {};
  for (const key of Object.keys(DEFAULTS)) {
    if (settings[key] !== undefined) clean[key] = settings[key];
  }
  localStorage.setItem(STORAGE_KEY, JSON.stringify(clean));
  return clean;
}

export function loadItemCache(maxAgeMinutes) {
  try {
    const cached = JSON.parse(localStorage.getItem(ITEM_CACHE_KEY) || 'null');
    if (!cached || !cached.fetchedAt || !cached.items) return null;
    const ageMin = (Date.now() - cached.fetchedAt) / 60000;
    if (ageMin > maxAgeMinutes) return null;
    return cached;
  } catch {
    return null;
  }
}

export function saveItemCache(items) {
  const payload = { fetchedAt: Date.now(), items };
  try {
    localStorage.setItem(ITEM_CACHE_KEY, JSON.stringify(payload));
  } catch {
    // Item-Liste kann die Quota sprengen; dann laeuft die App eben ohne Cache.
  }
  return payload;
}

export function clearItemCache() {
  localStorage.removeItem(ITEM_CACHE_KEY);
}
