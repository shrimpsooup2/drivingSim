/**
 * Per-wheel normal load, including weight transfer.
 *
 * Why this matters: friction is proportional to normal force, so a wheel that
 * unloads under acceleration loses grip and spins. On a light, tall FTC robot
 * this is not a subtle effect. A 15 kg robot with a 20 cm centre of gravity and
 * a 35 cm wheelbase transfers roughly 30% of the front axle load to the rear
 * under hard acceleration, which is exactly why robots pop wheelies and why
 * front wheels lose bite the instant the driver slams forward.
 *
 * @module
 */

import { Vec2 } from '../math/Vec2.js';

const GRAVITY = 9.80665;

/**
 * Solve a symmetric 3x3 system by Gauss-Jordan with partial pivoting.
 * Small and self-contained; the matrix is A*A^T from the load equations.
 * @param {number[][]} m 3x3, modified in place
 * @param {number[]} b length 3, modified in place
 * @returns {number[]|null} solution, or null if singular
 */
function solve3(m, b) {
  for (let col = 0; col < 3; col++) {
    let pivot = col;
    for (let r = col + 1; r < 3; r++) {
      if (Math.abs(m[r][col]) > Math.abs(m[pivot][col])) pivot = r;
    }
    if (Math.abs(m[pivot][col]) < 1e-12) return null;
    if (pivot !== col) {
      [m[col], m[pivot]] = [m[pivot], m[col]];
      [b[col], b[pivot]] = [b[pivot], b[col]];
    }
    const d = m[col][col];
    for (let c = col; c < 3; c++) m[col][c] /= d;
    b[col] /= d;
    for (let r = 0; r < 3; r++) {
      if (r === col) continue;
      const f = m[r][col];
      if (f === 0) continue;
      for (let c = col; c < 3; c++) m[r][c] -= f * m[col][c];
      b[r] -= f * b[col];
    }
  }
  return b;
}

/**
 * Distribute a vertical load across wheel contact points.
 *
 * Any chassis with more than three wheels is statically indeterminate: the
 * equilibrium equations (one vertical, two moment) do not pin down the
 * individual loads without knowing the frame and tyre stiffnesses. The
 * minimum-norm (pseudo-inverse) solution is the standard resolution and, for
 * the rectangular layouts FTC robots actually use, it reproduces the textbook
 * answer exactly -- a CG sitting `e` ahead of centre on wheelbase `L` puts
 * `1/2 + e/L` of the weight on the front axle.
 *
 * @param {Vec2[]} contactPoints wheel contacts in body frame, relative to the
 *   *effective* centre of gravity (i.e. already shifted for weight transfer)
 * @param {number} totalLoad newtons
 * @param {Float64Array} out length must equal contactPoints.length
 * @returns {Float64Array} per-wheel normal force, newtons, never negative
 */
export function distributeLoad(contactPoints, totalLoad, out) {
  const n = contactPoints.length;
  if (n === 0) return out;
  if (n === 1) {
    out[0] = totalLoad;
    return out;
  }

  // A is 3 x n with rows [1...], [x...], [y...]; solve for the minimum-norm
  // N satisfying A N = (totalLoad, 0, 0).
  let sx = 0;
  let sy = 0;
  let sxx = 0;
  let syy = 0;
  let sxy = 0;
  for (let i = 0; i < n; i++) {
    const p = contactPoints[i];
    sx += p.x;
    sy += p.y;
    sxx += p.x * p.x;
    syy += p.y * p.y;
    sxy += p.x * p.y;
  }

  // Tikhonov term keeps degenerate layouts (all wheels collinear, or a
  // single-axle test rig) solvable instead of producing NaN. Scaled to the
  // matrix so it stays negligible for a normal chassis whatever its size.
  const eps = 1e-12 * (n + sxx + syy) + Number.MIN_VALUE;
  const m = [
    [n + eps, sx, sy],
    [sx, sxx + eps, sxy],
    [sy, sxy, syy + eps],
  ];
  const rhs = [totalLoad, 0, 0];
  const sol = solve3(m, rhs);

  if (!sol) {
    out.fill(totalLoad / n);
    return out;
  }
  const [u, vx, vy] = sol;

  let sum = 0;
  let clamped = false;
  for (let i = 0; i < n; i++) {
    const p = contactPoints[i];
    const load = u + vx * p.x + vy * p.y;
    // A negative load means that corner has lifted; a wheel cannot pull down.
    out[i] = load > 0 ? load : 0;
    if (load <= 0) clamped = true;
    sum += out[i];
  }

  // Once a wheel lifts, moment balance can no longer be satisfied by the
  // remaining contacts alone -- physically the robot has started to tip.
  // Rescale so total vertical force is still correct; the pitching motion
  // itself is out of scope for a 3-DOF planar model.
  if (clamped && sum > 1e-9) {
    const k = totalLoad / sum;
    for (let i = 0; i < n; i++) out[i] *= k;
  }

  return out;
}

/**
 * Full load model for a chassis: static distribution plus weight transfer from
 * the current acceleration.
 *
 * Weight transfer is applied by *shifting the effective centre of gravity*
 * rather than by adding per-axle correction terms. Taking moments about the
 * CG, the inertial force m*a acting at the contact plane (a distance h below
 * the CG) is exactly equivalent to moving the CG by -h*a/g. This handles
 * longitudinal, lateral and combined transfer in one step and works for any
 * wheel layout, not just a rectangle.
 */
export class LoadModel {
  /**
   * @param {{cgHeight?:number, cgOffset?:Vec2, transferFactor?:number}} [opts]
   */
  constructor(opts = {}) {
    /** metres above the contact plane */
    this.cgHeight = opts.cgHeight ?? 0.12;
    /** CG position in body frame relative to the chassis origin */
    this.cgOffset = opts.cgOffset ?? new Vec2(0, 0);
    /**
     * Scales the transfer term. 1 is the rigid-body answer. Lower values
     * approximate a chassis that flexes or wheels that deflect, which spreads
     * the transfer out in time; useful for matching a real robot's feel.
     */
    this.transferFactor = opts.transferFactor ?? 1;

    /** @type {Vec2[]} scratch, reused each substep */
    this._relative = [];
    /** @type {Float64Array} */
    this._loads = new Float64Array(0);
    /** Effective CG used on the last update, body frame. Exposed for the HUD. */
    this.effectiveCg = new Vec2();
  }

  /**
   * @param {Vec2[]} wheelPositions body frame, relative to the chassis origin
   * @param {number} mass kg
   * @param {Vec2} bodyAcceleration body-frame acceleration of the CG, m/s^2
   * @returns {Float64Array} per-wheel normal force in newtons
   */
  update(wheelPositions, mass, bodyAcceleration) {
    const n = wheelPositions.length;
    if (this._loads.length !== n) {
      this._loads = new Float64Array(n);
      this._relative = wheelPositions.map(() => new Vec2());
    }

    const weight = mass * GRAVITY;
    const k = (this.cgHeight * this.transferFactor) / GRAVITY;
    this.effectiveCg.set(
      this.cgOffset.x - k * bodyAcceleration.x,
      this.cgOffset.y - k * bodyAcceleration.y,
    );

    for (let i = 0; i < n; i++) {
      this._relative[i].set(
        wheelPositions[i].x - this.effectiveCg.x,
        wheelPositions[i].y - this.effectiveCg.y,
      );
    }

    return distributeLoad(this._relative, weight, this._loads);
  }

  /**
   * Fraction of the total load carried by the most heavily loaded wheel.
   * 1/n means perfectly even; approaching 1 means the robot is on the verge of
   * tipping. Surfaced in the HUD as a tip-risk indicator.
   * @param {Float64Array} loads
   */
  static loadImbalance(loads) {
    let total = 0;
    let max = 0;
    for (let i = 0; i < loads.length; i++) {
      total += loads[i];
      if (loads[i] > max) max = loads[i];
    }
    return total > 1e-9 ? max / total : 0;
  }
}

export { GRAVITY };
