/**
 * Small numeric helpers shared across the simulator.
 *
 * Everything in the simulator is SI internally: metres, kilograms, seconds,
 * radians, newtons, volts, amps. Conversion to the units FTC teams actually
 * think in (inches, feet per second, degrees) happens at the UI boundary only.
 * @module
 */

export const TAU = Math.PI * 2;
export const DEG = Math.PI / 180;
export const INCH = 0.0254;

/** Clamp `v` into [lo, hi]. */
export function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Linear interpolation. `t` is not clamped. */
export function lerp(a, b, t) {
  return a + (b - a) * t;
}

/** Map `v` from [inLo, inHi] onto [outLo, outHi] without clamping. */
export function mapRange(v, inLo, inHi, outLo, outHi) {
  if (inHi === inLo) return outLo;
  return outLo + ((v - inLo) / (inHi - inLo)) * (outHi - outLo);
}

/** Wrap an angle to (-pi, pi]. */
export function wrapAngle(a) {
  let x = (a + Math.PI) % TAU;
  if (x <= 0) x += TAU;
  return x - Math.PI;
}

/** Shortest signed angular distance from `from` to `to`, in (-pi, pi]. */
export function angleDelta(from, to) {
  return wrapAngle(to - from);
}

/** Sign that returns 0 only for exactly 0 (Math.sign semantics, explicit for clarity). */
export function sign(v) {
  return v > 0 ? 1 : v < 0 ? -1 : 0;
}

/**
 * Smooth, odd, saturating curve used by the friction models.
 * Approaches +/-1 asymptotically with unit slope at the origin.
 */
export function softSign(x) {
  return Math.tanh(x);
}

/** True when `v` is a finite number. Used to keep NaN out of the physics state. */
export function isFiniteNumber(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

/**
 * Apply a deadband, then rescale the remaining range back to full scale so the
 * output is continuous at the deadband edge. This is what you want on a
 * gamepad stick: a hard `if (|x| < db) return 0` leaves a jump at the edge.
 */
export function deadband(value, band) {
  if (band <= 0) return value;
  const a = Math.abs(value);
  if (a <= band) return 0;
  return sign(value) * ((a - band) / (1 - band));
}

/**
 * Odd power response curve: keeps the sign, raises magnitude to `exponent`.
 * exponent 1 = linear, 2 = "squared inputs", 3 = "cubed inputs".
 */
export function powerCurve(value, exponent) {
  if (exponent === 1) return value;
  return sign(value) * Math.pow(Math.abs(value), exponent);
}

/**
 * Blend between a linear and a power response.
 * `blend` 0 = pure linear, 1 = pure `exponent` curve.
 */
export function blendedCurve(value, exponent, blend) {
  if (blend <= 0) return value;
  const curved = powerCurve(value, exponent);
  return lerp(value, curved, clamp(blend, 0, 1));
}

/** Round to a fixed number of decimals (display only, never in the physics path). */
export function round(v, decimals = 3) {
  const f = 10 ** decimals;
  return Math.round(v * f) / f;
}

/** Convert revolutions per minute to radians per second. */
export function rpmToRadPerSec(rpm) {
  return (rpm * TAU) / 60;
}

/** Convert radians per second to revolutions per minute. */
export function radPerSecToRpm(w) {
  return (w * 60) / TAU;
}
