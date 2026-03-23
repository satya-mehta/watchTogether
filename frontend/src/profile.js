const DISPLAY_NAME_STORAGE_KEY = 'watchTogetherDisplayName';
const MAX_DISPLAY_NAME_LENGTH = 32;

const NAME_ADJECTIVES = [
  'Brave', 'Silent', 'Golden', 'Cosmic', 'Velvet', 'Curious', 'Swift', 'Lunar',
  'Calm', 'Radiant', 'Gentle', 'Mellow', 'Crimson', 'Bright', 'Dreamy', 'Noble',
];

const NAME_NOUNS = [
  'Tiger', 'Falcon', 'Comet', 'Otter', 'Voyager', 'Panther', 'Harbor', 'Fox',
  'Cedar', 'Raven', 'Camel', 'Orchid', 'Breeze', 'Echo', 'Lion', 'senor'
];

function pick(items) {
  return items[Math.floor(Math.random() * items.length)];
}

export function generateName() {
  return `${pick(NAME_ADJECTIVES)} ${pick(NAME_NOUNS)}`;
}

export function sanitizeDisplayName(value) {
  const normalized = String(value || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_DISPLAY_NAME_LENGTH);
  return normalized;
}

export function persistDisplayName(value) {
  const nextName = sanitizeDisplayName(value) || generateName();
  try {
    window.localStorage?.setItem(DISPLAY_NAME_STORAGE_KEY, nextName);
  } catch {
    // Ignore storage errors and keep using the in-memory value.
  }
  return nextName;
}

export function getOrCreateDisplayName() {
  try {
    const stored = sanitizeDisplayName(window.localStorage?.getItem(DISPLAY_NAME_STORAGE_KEY));
    if (stored) return stored;
  } catch {
    // Ignore storage read failures and generate a fresh fallback below.
  }
  return persistDisplayName(generateName());
}

export function getDisplayInitials(name) {
  const safeName = sanitizeDisplayName(name);
  if (!safeName) return 'WT';

  const words = safeName.split(' ').filter(Boolean);
  if (words.length >= 2) {
    return `${words[0][0] || ''}${words[1][0] || ''}`.toUpperCase();
  }

  return safeName.slice(0, 2).toUpperCase();
}
