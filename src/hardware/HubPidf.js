/**
 * The velocity loop that actually runs on a REV hub.
 *
 * ## Why this is not the same as our own PIDF
 *
 * `math/PIDF.js` is a good general controller working in normalised units, so
 * its gains mean the same thing whatever the gearing. That is a nice property
 * and it is not the property a team needs: a team's F, P and I are numbers they
 * tuned in the FTC SDK, in the SDK's units, and those numbers have to mean the
 * same thing here or there is nothing to port.
 *
 * So this is the hub's own arithmetic, ported from the JVM simulator's
 * `PidfController`:
 *
 *  - **Units are ticks per second**, and the output is the hub's 16-bit duty
 *    range, -32767..32767. That is what makes `F = 32767 / maxTicksPerSecond`
 *    the correct feedforward -- the guidance every team is given, and it only
 *    parses in these units.
 *  - **I and D are scaled by a 20 Hz loop rate.** The hub closes this loop
 *    internally at its own rate, not at your op-mode's, so the per-iteration
 *    coefficients behave as if the loop ran at 20 Hz however fast the
 *    simulation is stepping. Without this the usual
 *    "F = 32767/maxTps, P = 0.1F, I = 0.01F" starting point behaves completely
 *    differently at 50 Hz than at 200, and the advice stops being advice.
 *  - **The integral resets on a zero crossing.** Error built up while spinning
 *    up must not carry past the setpoint, or every flywheel overshoots.
 *  - **Anti-windup**: no integrating while saturated in the direction of the
 *    error, and the I term alone is capped at a quarter of full scale.
 *
 * @module
 */

/** The hub's duty range. A 16-bit signed value with the sign bit spent. */
export const HUB_FULL_SCALE = 32767;

/**
 * The rate the hub's internal loop is taken to run at.
 *
 * 20 Hz is what makes the standard coefficient guidance behave the way it does
 * on a real hub: a fast approach with a few percent of overshoot.
 */
export const HUB_LOOP_HZ = 20;

export class HubPidf {
  /**
   * @param {{p?: number, i?: number, d?: number, f?: number, loopHz?: number}} [gains]
   */
  constructor(gains = {}) {
    this.set(gains);
    this.reset();
  }

  set(gains = {}) {
    this.p = gains.p ?? this.p ?? 0;
    this.i = gains.i ?? this.i ?? 0;
    this.d = gains.d ?? this.d ?? 0;
    this.f = gains.f ?? this.f ?? 0;
    /** Overridable so a test can pin the scaling rather than infer it. */
    this.loopHz = gains.loopHz ?? this.loopHz ?? HUB_LOOP_HZ;
    return this;
  }

  reset() {
    this.integral = 0;
    this.lastError = 0;
    this.hasLast = false;
    /** The unclamped 16-bit output, for seeing how hard it is saturating. */
    this.raw = 0;
    this.error = 0;
    return this;
  }

  /**
   * One iteration.
   *
   * @param {number} target ticks per second
   * @param {number} measured ticks per second
   * @param {number} dt seconds
   * @returns {number} duty, -1..1
   */
  update(target, measured, dt) {
    const error = target - measured;
    this.error = error;
    const deriv = this.hasLast && dt > 0 ? (error - this.lastError) / (dt * this.loopHz) : 0;

    // Zero crossing: the error accumulated on the way up is not a reason to
    // keep pushing once you are past the setpoint.
    if (
      this.hasLast &&
      Math.sign(error) !== Math.sign(this.lastError) &&
      error !== 0 &&
      this.lastError !== 0
    ) {
      this.integral = 0;
    }
    this.lastError = error;
    this.hasLast = true;

    const unsaturated = this.f * target + this.p * error + this.i * this.integral + this.d * deriv;
    const saturated =
      Math.abs(unsaturated) >= HUB_FULL_SCALE && Math.sign(unsaturated) === Math.sign(error);
    if (!saturated && this.i !== 0) {
      this.integral += error * dt * this.loopHz;
      // The I term on its own never asks for more than a quarter of full scale.
      const limit = (0.25 * HUB_FULL_SCALE) / Math.abs(this.i);
      this.integral = Math.max(-limit, Math.min(limit, this.integral));
    }

    this.raw = this.f * target + this.p * error + this.i * this.integral + this.d * deriv;
    return Math.max(-1, Math.min(1, this.raw / HUB_FULL_SCALE));
  }
}

/**
 * The SDK's own default coefficients for a motor, given its top speed.
 *
 * `F = 32767 / maxTicksPerSecond` is full duty at full speed -- the correct
 * feedforward for an ideal motor, expressed in the hub's units. `P = 0.1F` and
 * `I = 0.01F` are the starting points every FTC tuning guide gives, and they are
 * starting points: a flywheel usually wants less I and a drivetrain usually
 * wants more P.
 *
 * @param {number} maxTicksPerSecond free speed at the rated voltage
 */
export function hubDefaultGains(maxTicksPerSecond) {
  const f = maxTicksPerSecond > 0 ? HUB_FULL_SCALE / maxTicksPerSecond : 0;
  return { f, p: 0.1 * f, i: 0.01 * f, d: 0 };
}
