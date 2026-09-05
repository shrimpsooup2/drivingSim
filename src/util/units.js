/**
 * Unit conversion and display formatting.
 *
 * The simulator computes in SI. FTC teams think in inches, feet per second and
 * degrees, and the goBILDA/REV catalogues are in mm and kg-cm. Conversions live
 * here so no other module has to carry a magic 0.0254.
 */

export const CONVERSIONS = {
  // length: metres <-> x
  m: 1,
  cm: 100,
  mm: 1000,
  in: 1 / 0.0254,
  ft: 1 / 0.3048,
  // speed: m/s <-> x
  'm/s': 1,
  'in/s': 1 / 0.0254,
  'ft/s': 1 / 0.3048,
  mph: 2.2369362920544,
  // angle: radians <-> x
  rad: 1,
  deg: 180 / Math.PI,
  // angular rate
  'rad/s': 1,
  'deg/s': 180 / Math.PI,
  rpm: 60 / (2 * Math.PI),
  // torque: N*m <-> x
  'N*m': 1,
  'kg*cm': 10.197162129779,
  'oz*in': 141.61193227806,
  // mass
  kg: 1,
  g: 1000,
  lb: 2.2046226218488,
  // force
  N: 1,
  lbf: 0.22480894309971,
  // Identity entries. These need no conversion, but they are listed so the
  // table is the single authority on what units exist: an unrecognised unit
  // string in the schema is then a typo to catch, not a silent pass-through.
  'kg*m^2': 1,
  'N*m/(rad/s)': 1,
  V: 1,
  A: 1,
  Ah: 1,
  ohm: 1,
  Hz: 1,
  s: 1,
  ms: 1000,
  '1/s': 1,
  '%': 100,
};

/**
 * Convert an SI value into a display unit.
 * @param {number} siValue
 * @param {keyof CONVERSIONS | string} unit
 */
export function toDisplay(siValue, unit) {
  const f = CONVERSIONS[/** @type {keyof CONVERSIONS} */ (unit)];
  return f === undefined ? siValue : siValue * f;
}

/**
 * Convert a display-unit value back to SI.
 * @param {number} displayValue
 * @param {keyof CONVERSIONS | string} unit
 */
export function fromDisplay(displayValue, unit) {
  const f = CONVERSIONS[/** @type {keyof CONVERSIONS} */ (unit)];
  return f === undefined ? displayValue : displayValue / f;
}

/** Fixed-decimal format that keeps the sign column stable in the HUD. */
export function fmt(value, decimals = 2, pad = 0) {
  if (!Number.isFinite(value)) return 'n/a';
  const s = value.toFixed(decimals);
  return pad ? s.padStart(pad, ' ') : s;
}

/** Format an SI value in a display unit with its suffix, e.g. "42.1 in/s". */
export function fmtUnit(siValue, unit, decimals = 2) {
  return `${fmt(toDisplay(siValue, unit), decimals)} ${unit}`;
}

/** Seconds -> "m:ss.t" */
export function fmtClock(seconds) {
  const s = Math.max(0, seconds);
  const m = Math.floor(s / 60);
  const rem = s - m * 60;
  return `${m}:${rem.toFixed(1).padStart(4, '0')}`;
}
