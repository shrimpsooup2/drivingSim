/**
 * Room codes, shared by the browser that shows one and the relay that checks it.
 *
 * In `src/` rather than in `tools/relay.js` because both sides need it and the
 * relay's own module reaches for `node:crypto` -- so importing it from a panel
 * would drag a Node built-in into the browser. A four-character string is not
 * worth two implementations that can disagree about what a valid code is.
 *
 * @module
 */

/**
 * The alphabet a code is drawn from.
 *
 * No vowels, so a code can never spell anything; and no `I`, `O`, `0` or `1`,
 * because the entire job of a room code is that somebody reads it off one
 * screen and types it on another, and those four are the characters that get
 * mistaken for each other when they do.
 */
export const CODE_ALPHABET = 'BCDFGHJKLMNPQRSTVWXYZ23456789';

/** Codes are short, case-insensitive, and stripped of anything decorative. */
export function normaliseCode(value) {
  if (typeof value !== 'string') return null;
  const code = value.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (code.length < 3 || code.length > 12) return null;
  return code;
}

/** A fresh code. Four characters is about 700,000 rooms, on one Wi-Fi network. */
export function freshCode(random = Math.random) {
  let out = '';
  for (let i = 0; i < 4; i++) out += CODE_ALPHABET[Math.floor(random() * CODE_ALPHABET.length)];
  return out;
}
