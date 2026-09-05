/**
 * Tyre/contact friction models.
 *
 * All models express friction as a *function of slip velocity* (the relative
 * sliding speed between the contact patch and the ground) rather than as a hard
 * Coulomb switch. That choice matters:
 *
 *  - A hard `F = mu * N * sign(slip)` model chatters at low speed. A robot
 *    sitting still with brakes applied oscillates between +mu*N and -mu*N every
 *    substep, which shows up as the robot buzzing on the field.
 *  - Real tread on FTC foam tiles builds force progressively over a small slip
 *    range before saturating. That progressive region is what makes a robot
 *    feel like it "digs in" rather than switching between glued and sliding.
 *
 * The shape functions return a dimensionless factor; the caller multiplies by
 * mu * N.
 *
 * @module
 */

import { clamp } from '../math/MathUtil.js';

/** @typedef {'linear'|'tanh'|'pacejka'} FrictionModelName */

/**
 * User-facing friction settings. These are the values exposed in the parameter
 * panel; the awkward Magic Formula coefficients are derived from them.
 *
 * @typedef {object} FrictionSettings
 * @property {FrictionModelName} model
 * @property {number} muLongitudinal peak friction coefficient along the rolling direction
 * @property {number} muLateral      peak friction coefficient across the wheel
 * @property {number} slipAtPeakGrip slip speed (m/s) at which grip peaks
 * @property {number} peakSlipRatio  above walking pace, peak slip scales with speed by this ratio
 * @property {number} kineticRatio   sliding grip as a fraction of peak grip (pacejka only)
 * @property {number} curvature      Magic Formula E; shapes the approach to the peak
 */

/**
 * @typedef {FrictionSettings & {_B:number, _C:number, _key:string}} CompiledFriction
 */

/** Sensible starting point: rubber tread on FTC foam tiles. */
export function defaultFrictionSettings() {
  return /** @type {FrictionSettings} */ ({
    model: 'pacejka',
    muLongitudinal: 1.05,
    muLateral: 1.0,
    slipAtPeakGrip: 0.15,
    peakSlipRatio: 0.12,
    kineticRatio: 0.8,
    curvature: 0.95,
  });
}

/** Saturating linear ramp. Cheapest, and the most numerically forgiving. */
export function shapeLinear(x) {
  const a = Math.abs(x);
  return a >= 1 ? 1 : a;
}

/** Smooth saturation with no static/kinetic distinction. Very stable. */
export function shapeTanh(x) {
  return Math.tanh(Math.abs(x));
}

/**
 * Pacejka "Magic Formula" (simplified: no camber or load sensitivity).
 *
 *   y = sin(C * atan(B*x - E*(B*x - atan(B*x))))
 *
 * With C > 1 the curve peaks above the value it settles at, reproducing the
 * static-then-kinetic drop: once a wheel breaks loose it grips noticeably less
 * until it hooks back up. That is what a driver feels as spinning out, and it
 * is the main reason mashing the stick from a stop is slower than easing into it.
 */
export function shapePacejka(x, B, C, E) {
  const Bx = B * Math.abs(x);
  const inner = Bx - E * (Bx - Math.atan(Bx));
  return Math.sin(C * Math.atan(inner));
}

/**
 * Derive the Magic Formula's B and C from the interpretable settings, so that
 * the curve peaks at exactly `slipAtPeakGrip` with a sliding plateau of
 * `kineticRatio` times the peak.
 *
 * C comes from the large-slip asymptote sin(C*pi/2) = kineticRatio.
 * B is then solved so the peak (where C*atan(inner) = pi/2) falls at x = 1.
 *
 * Bisection converges in well under 60 iterations and the result is cached, so
 * this never runs in the physics loop.
 *
 * @param {FrictionSettings} s
 * @returns {CompiledFriction}
 */
export function compileFriction(s) {
  const key = `${s.model}|${s.kineticRatio}|${s.curvature}`;
  const cached = compileFriction._cache.get(key);
  if (cached) return { ...s, _B: cached.B, _C: cached.C, _key: key };

  // kineticRatio == 1 makes B diverge (no peak at all), so hold it just below.
  const ratio = clamp(s.kineticRatio, 0.05, 0.995);
  const C = (Math.PI - Math.asin(ratio)) / (Math.PI / 2);
  const innerAtPeak = Math.tan(Math.PI / (2 * C));
  const E = clamp(s.curvature, -5, 0.999);

  let lo = 1e-6;
  let hi = 1e4;
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    const v = mid - E * (mid - Math.atan(mid));
    if (v < innerAtPeak) lo = mid;
    else hi = mid;
  }
  const B = (lo + hi) / 2;

  compileFriction._cache.set(key, { B, C });
  return { ...s, _B: B, _C: C, _key: key };
}
/** @type {Map<string,{B:number,C:number}>} */
compileFriction._cache = new Map();

/**
 * Evaluate the selected shape function at a normalised slip.
 * @param {number} normalisedSlip
 * @param {CompiledFriction} f
 */
export function frictionShape(normalisedSlip, f) {
  switch (f.model) {
    case 'linear':
      return shapeLinear(normalisedSlip);
    case 'pacejka':
      return shapePacejka(normalisedSlip, f._B, f._C, f.curvature);
    case 'tanh':
    default:
      return shapeTanh(normalisedSlip);
  }
}

/**
 * Slip speed that counts as "normalised slip = 1" at a given rolling speed.
 *
 * A pure slip-velocity model is stable at zero speed but over-predicts grip
 * loss at speed, because real tyres care about slip *ratio* (slip relative to
 * rolling speed), not absolute slip. Taking the larger of a fixed floor and a
 * speed-proportional term gives slip-velocity behaviour near standstill and
 * slip-ratio behaviour once moving, with no singularity at v = 0.
 *
 * @param {CompiledFriction} f
 * @param {number} rollingSpeed m/s, magnitude of the faster of contact or wheel speed
 */
export function effectiveSlipReference(f, rollingSpeed) {
  const floor = f.slipAtPeakGrip > 1e-6 ? f.slipAtPeakGrip : 1e-6;
  return Math.max(floor, f.peakSlipRatio * Math.abs(rollingSpeed));
}

/**
 * Combined-slip friction force for a contact patch.
 *
 * Longitudinal and lateral slip are combined into one normalised magnitude
 * before the shape function is applied, then the force is distributed along an
 * ellipse with semi-axes `muLongitudinal * N` and `muLateral * N`. This is the
 * standard friction-ellipse construction, and it gives the physically important
 * coupling for free: a wheel already using all its grip to accelerate has none
 * left to resist a sideways push. That is why a robot washes out if you
 * accelerate and turn hard at the same time.
 *
 * @param {number} slipLong    slip velocity along the rolling direction (m/s)
 * @param {number} slipLat     slip velocity across the wheel (m/s)
 * @param {number} normalForce newtons, already including load transfer
 * @param {CompiledFriction} f
 * @param {number} rollingSpeed m/s, for the slip-ratio scaling
 * @param {{x:number,y:number}} [out]
 * @returns {{x:number,y:number}} force in the wheel frame (x longitudinal, y lateral)
 */
export function combinedSlipForce(slipLong, slipLat, normalForce, f, rollingSpeed, out = { x: 0, y: 0 }) {
  out.x = 0;
  out.y = 0;
  if (!(normalForce > 0)) return out;

  const ref = effectiveSlipReference(f, rollingSpeed);
  const nx = slipLong / ref;
  const ny = slipLat / ref;
  const mag = Math.hypot(nx, ny);
  if (mag < 1e-9) return out;

  const shape = frictionShape(mag, f);
  const ux = nx / mag;
  const uy = ny / mag;

  out.x = -shape * f.muLongitudinal * normalForce * ux;
  out.y = -shape * f.muLateral * normalForce * uy;
  return out;
}

/**
 * Single-axis version, used by roller wheels whose contact can only transmit
 * force along the roller axis.
 *
 * @param {number} slip slip velocity along the constrained axis (m/s)
 * @param {number} normalForce newtons
 * @param {number} mu peak friction coefficient
 * @param {CompiledFriction} f
 * @param {number} rollingSpeed m/s
 * @returns {number} signed force opposing the slip
 */
export function axialSlipForce(slip, normalForce, mu, f, rollingSpeed) {
  if (!(normalForce > 0)) return 0;
  const ref = effectiveSlipReference(f, rollingSpeed);
  const x = slip / ref;
  if (Math.abs(x) < 1e-9) return 0;
  return -Math.sign(x) * frictionShape(Math.abs(x), f) * mu * normalForce;
}

/**
 * Local slope of the axial friction curve, i.e. contact stiffness in N per m/s.
 *
 * The wheel-spin update uses this to take a semi-implicit step. Contact
 * stiffness is by far the stiffest term in the whole simulation (thousands of
 * N per m/s against a wheel inertia of a few thousandths of a kg*m^2), so an
 * explicit step would need an impractically small dt. Folding the slope into
 * the update makes the wheel mode unconditionally stable.
 *
 * Returned as a non-negative magnitude. Past the friction peak the true slope
 * goes negative -- that is the physically real "it broke loose" instability and
 * must not be damped away, so it is clamped to zero and the step stays
 * explicit there, where the force is nearly constant anyway.
 *
 * @param {number} slip m/s
 * @param {number} normalForce N
 * @param {number} mu
 * @param {CompiledFriction} f
 * @param {number} rollingSpeed m/s
 * @returns {number} stiffness >= 0
 */
export function axialStiffness(slip, normalForce, mu, f, rollingSpeed) {
  if (!(normalForce > 0)) return 0;
  const ref = effectiveSlipReference(f, rollingSpeed);
  const h = 0.05 * ref;
  const a = axialSlipForce(slip + h, normalForce, mu, f, rollingSpeed);
  const b = axialSlipForce(slip - h, normalForce, mu, f, rollingSpeed);
  // Force opposes slip, so d(force)/d(slip) is negative in the rising region.
  const slope = (a - b) / (2 * h);
  return slope < 0 ? -slope : 0;
}
