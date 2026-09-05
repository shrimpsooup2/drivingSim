import { clamp, rpmToRadPerSec } from '../math/MathUtil.js';

/**
 * Brushed DC motor, modelled from its four catalogue numbers.
 *
 * The standard linear model is accurate for the small brushed motors FTC uses:
 *
 *   current = (V - omega / kV) / R      torque = kT * current
 *
 * with the constants derived from the published free speed, stall torque,
 * stall current and free current. Everything a driver feels about motor
 * behaviour falls out of this: torque falls off linearly with speed, current
 * spikes when the robot is pushed against a wall, and the whole curve scales
 * with bus voltage so a tired battery makes the robot slower *and* weaker.
 */
export class DcMotor {
  /**
   * @param {{
   *   name?: string,
   *   freeSpeedRpm: number,
   *   stallTorque: number,
   *   stallCurrent: number,
   *   freeCurrent: number,
   *   nominalVoltage?: number,
   *   ticksPerRev?: number,
   *   rotorInertia?: number,
   * }} spec
   */
  constructor(spec) {
    this.name = spec.name ?? 'motor';
    this.nominalVoltage = spec.nominalVoltage ?? 12;
    this.freeSpeed = rpmToRadPerSec(spec.freeSpeedRpm);
    this.stallTorque = spec.stallTorque;
    this.stallCurrent = spec.stallCurrent;
    this.freeCurrent = spec.freeCurrent;
    /** Encoder counts per revolution of the *motor shaft*, in quadrature. */
    this.ticksPerRev = spec.ticksPerRev ?? 28;
    /** Rotor inertia, kg*m^2. Reflected through the gearbox it dominates wheel inertia. */
    this.rotorInertia = spec.rotorInertia ?? 7e-6;

    this.recomputeConstants();
  }

  recomputeConstants() {
    /** Winding resistance, ohms. */
    this.resistance = this.nominalVoltage / this.stallCurrent;
    /** Torque constant, N*m per amp. */
    this.kT = this.stallTorque / this.stallCurrent;
    /**
     * Speed constant, rad/s per volt of back-EMF. Derived from free speed with
     * the no-load current's IR drop removed, so the free-speed point is exact.
     */
    const backEmfAtFree = this.nominalVoltage - this.resistance * this.freeCurrent;
    this.kV = backEmfAtFree > 1e-6 ? this.freeSpeed / backEmfAtFree : this.freeSpeed;
    return this;
  }

  /**
   * Current drawn at a given terminal voltage and shaft speed.
   * Negative current means the motor is regenerating (being back-driven).
   * @param {number} voltage volts across the terminals
   * @param {number} omega motor shaft speed, rad/s
   */
  currentAt(voltage, omega) {
    return (voltage - omega / this.kV) / this.resistance;
  }

  /**
   * Terminal voltage that produces a given current at a given speed.
   * Used to implement current limiting.
   */
  voltageForCurrent(current, omega) {
    return current * this.resistance + omega / this.kV;
  }

  /**
   * Torque and current at the motor shaft.
   *
   * @param {number} voltage volts (already scaled by duty cycle and bus voltage)
   * @param {number} omega motor shaft speed, rad/s
   * @param {number} [currentLimit] amps; Infinity disables limiting
   * @param {boolean} [open] true models an open circuit (coast / FLOAT at zero power)
   * @returns {{torque:number, current:number, voltage:number}}
   */
  evaluate(voltage, omega, currentLimit = Infinity, open = false) {
    if (open) return { torque: 0, current: 0, voltage: 0 };

    let v = voltage;
    if (Number.isFinite(currentLimit) && currentLimit > 0) {
      // Clamp the terminal voltage into the window that keeps |I| <= limit.
      // This is what a hub's current limiter does: it backs off the duty cycle
      // rather than clipping torque directly.
      const backEmf = omega / this.kV;
      const lo = backEmf - currentLimit * this.resistance;
      const hi = backEmf + currentLimit * this.resistance;
      v = clamp(v, lo, hi);
    }

    const current = (v - omega / this.kV) / this.resistance;
    return { torque: this.kT * current, current, voltage: v };
  }

  /** Free speed at an arbitrary bus voltage, rad/s. */
  freeSpeedAt(voltage) {
    return this.freeSpeed * (voltage / this.nominalVoltage);
  }

  /** Stall torque at an arbitrary bus voltage, N*m. */
  stallTorqueAt(voltage) {
    return this.stallTorque * (voltage / this.nominalVoltage);
  }

  clone() {
    return new DcMotor({
      name: this.name,
      freeSpeedRpm: (this.freeSpeed * 60) / (2 * Math.PI),
      stallTorque: this.stallTorque,
      stallCurrent: this.stallCurrent,
      freeCurrent: this.freeCurrent,
      nominalVoltage: this.nominalVoltage,
      ticksPerRev: this.ticksPerRev,
      rotorInertia: this.rotorInertia,
    });
  }
}
