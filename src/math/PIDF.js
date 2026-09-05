import { clamp } from './MathUtil.js';

/**
 * PIDF controller with the guards that matter on a real robot:
 * integral clamping, integral reset on setpoint reversal, derivative
 * low-pass filtering, and output clamping.
 *
 * Used for the motor controller's velocity loop (the FTC SDK's
 * RUN_USING_ENCODER mode) and available for future subsystem controllers.
 */
export class PIDF {
  /**
   * @param {{kP?:number, kI?:number, kD?:number, kF?:number,
   *          iZone?:number, maxIntegral?:number,
   *          outputMin?:number, outputMax?:number,
   *          derivativeFilterHz?:number}} [gains]
   */
  constructor(gains = {}) {
    this.setGains(gains);
    this.reset();
  }

  setGains(g) {
    this.kP = g.kP ?? 0;
    this.kI = g.kI ?? 0;
    this.kD = g.kD ?? 0;
    /** Feedforward gain, applied to the setpoint directly. */
    this.kF = g.kF ?? 0;
    /** Only integrate when |error| is below this (0 = always integrate). */
    this.iZone = g.iZone ?? 0;
    this.maxIntegral = g.maxIntegral ?? Infinity;
    this.outputMin = g.outputMin ?? -Infinity;
    this.outputMax = g.outputMax ?? Infinity;
    /** Cutoff for the derivative low-pass; 0 disables filtering. */
    this.derivativeFilterHz = g.derivativeFilterHz ?? 0;
    return this;
  }

  reset() {
    this.integral = 0;
    this.lastError = 0;
    this.lastMeasurement = 0;
    this.filteredDerivative = 0;
    this.hasRun = false;
    this.lastOutput = 0;
    this.error = 0;
  }

  /**
   * @param {number} setpoint
   * @param {number} measurement
   * @param {number} dt seconds
   * @returns {number} clamped output
   */
  calculate(setpoint, measurement, dt) {
    if (dt <= 0) return this.lastOutput;
    const error = setpoint - measurement;
    this.error = error;

    // Derivative on measurement rather than on error: a step change in the
    // setpoint (driver slams the stick) would otherwise produce a derivative
    // spike proportional to the step size.
    let rawDerivative = 0;
    if (this.hasRun) rawDerivative = -(measurement - this.lastMeasurement) / dt;

    if (this.derivativeFilterHz > 0 && this.hasRun) {
      const alpha = 1 - Math.exp((-2 * Math.PI * this.derivativeFilterHz) * dt);
      this.filteredDerivative += alpha * (rawDerivative - this.filteredDerivative);
    } else {
      this.filteredDerivative = rawDerivative;
    }

    const inZone = this.iZone <= 0 || Math.abs(error) <= this.iZone;
    if (inZone) {
      this.integral = clamp(this.integral + error * dt, -this.maxIntegral, this.maxIntegral);
    } else {
      this.integral = 0;
    }

    const raw =
      this.kF * setpoint + this.kP * error + this.kI * this.integral + this.kD * this.filteredDerivative;
    const out = clamp(raw, this.outputMin, this.outputMax);

    // Anti-windup: if the output is saturated and the integral is pushing it
    // further into saturation, back the integral out.
    if (out !== raw && this.kI !== 0) {
      const excess = (raw - out) / this.kI;
      this.integral -= excess;
      this.integral = clamp(this.integral, -this.maxIntegral, this.maxIntegral);
    }

    this.lastError = error;
    this.lastMeasurement = measurement;
    this.hasRun = true;
    this.lastOutput = out;
    return out;
  }
}
