import { clamp } from '../math/MathUtil.js';

/**
 * 12 V FTC battery with internal resistance.
 *
 * Bus voltage sag is not a detail: with 8 motors pulling hard, a tired pack can
 * drop from 13.5 V to under 10 V, and since both free speed and stall torque
 * scale with voltage the robot gets slower and weaker at exactly the moment the
 * driver needs it. Teams who practise only on a fresh battery are surprised in
 * the last match of the day, which is precisely the thing this simulator can
 * let them rehearse.
 */
export class Battery {
  /**
   * @param {{
   *   nominalVoltage?: number,
   *   openCircuitVoltage?: number,
   *   internalResistance?: number,
   *   capacityAmpHours?: number,
   *   baseLoadAmps?: number,
   *   enabled?: boolean,
   * }} [opts]
   */
  constructor(opts = {}) {
    this.nominalVoltage = opts.nominalVoltage ?? 12;
    /** Resting voltage of a full pack. A fresh FTC pack sits a little over 13 V. */
    this.openCircuitVoltage = opts.openCircuitVoltage ?? 13.0;
    /** Ohms. NiMH FTC packs are typically 0.02-0.05 depending on age. */
    this.internalResistance = opts.internalResistance ?? 0.03;
    this.capacityAmpHours = opts.capacityAmpHours ?? 3.0;
    /** Control Hub, servos, sensors and the phone/DS all draw before the motors do. */
    this.baseLoadAmps = opts.baseLoadAmps ?? 1.2;
    /** When false, the bus is held at openCircuitVoltage: a useful A/B test. */
    this.enabled = opts.enabled ?? true;

    this.reset();
  }

  reset() {
    this.stateOfCharge = 1;
    this.busVoltage = this.openCircuitVoltage;
    this.current = 0;
    this.chargeUsedAmpHours = 0;
    this.peakCurrent = 0;
    this.minVoltage = this.openCircuitVoltage;
    return this;
  }

  /**
   * Resting voltage as the pack drains. NiMH holds a fairly flat plateau then
   * falls off a cliff, which this piecewise curve approximates.
   */
  restingVoltage() {
    const soc = clamp(this.stateOfCharge, 0, 1);
    if (soc > 0.2) {
      // Flat plateau: full pack down to about 85% of open-circuit voltage.
      return this.openCircuitVoltage * (0.88 + 0.12 * ((soc - 0.2) / 0.8));
    }
    // The knee: voltage collapses over the last 20%.
    return this.openCircuitVoltage * (0.7 + 0.18 * (soc / 0.2));
  }

  /**
   * Update the bus from the total motor current draw.
   * @param {number} motorCurrent amps, sum over all motors (may be negative when regenerating)
   * @param {number} dt seconds
   * @returns {number} bus voltage
   */
  update(motorCurrent, dt) {
    const total = motorCurrent + this.baseLoadAmps;
    this.current = total;
    if (total > this.peakCurrent) this.peakCurrent = total;

    if (!this.enabled) {
      this.busVoltage = this.openCircuitVoltage;
      return this.busVoltage;
    }

    const resting = this.restingVoltage();
    // A pack cannot be driven below zero, and regeneration is clamped so a
    // hard stop cannot push the bus above its resting voltage by much.
    this.busVoltage = clamp(resting - total * this.internalResistance, 0.5, resting + 0.5);
    if (this.busVoltage < this.minVoltage) this.minVoltage = this.busVoltage;

    if (dt > 0 && this.capacityAmpHours > 0) {
      const usedAh = (Math.max(0, total) * dt) / 3600;
      this.chargeUsedAmpHours += usedAh;
      this.stateOfCharge = clamp(1 - this.chargeUsedAmpHours / this.capacityAmpHours, 0, 1);
    }
    return this.busVoltage;
  }

  /** Set the pack's starting charge, e.g. to rehearse a late-day match. */
  setStateOfCharge(soc) {
    this.stateOfCharge = clamp(soc, 0, 1);
    this.chargeUsedAmpHours = (1 - this.stateOfCharge) * this.capacityAmpHours;
    this.busVoltage = this.restingVoltage();
    return this;
  }
}
