import { wrapAngle } from '../math/MathUtil.js';
import { LowPassFilter } from '../math/filters.js';

/**
 * Heading sensor, standing in for the BNO055 / BHI260 in a Control Hub.
 *
 * Field-centric driving lives or dies on this sensor, so the failure modes are
 * modelled rather than assumed away:
 *
 *  - **Drift.** A slow bias accumulates. Over a two and a half minute match a
 *    few tenths of a degree per second is enough that "forward" on the stick no
 *    longer points down the field, which is the single most common complaint
 *    about field-centric drive.
 *  - **Noise** on the reported angle.
 *  - **Latency**, because the hub reads the IMU over I2C and the value the
 *    op-mode sees is already a few milliseconds old.
 *
 * All three default to small but non-zero. Set them to zero for a perfect IMU
 * when you want to isolate a different problem.
 */
export class Imu {
  /**
   * @param {{
   *   driftRateDegPerSec?: number,
   *   noiseDeg?: number,
   *   latencySeconds?: number,
   *   filterHz?: number,
   *   enabled?: boolean,
   * }} [opts]
   */
  constructor(opts = {}) {
    this.driftRateDegPerSec = opts.driftRateDegPerSec ?? 0.05;
    this.noiseDeg = opts.noiseDeg ?? 0.05;
    this.latencySeconds = opts.latencySeconds ?? 0.005;
    this.filterHz = opts.filterHz ?? 60;
    this.enabled = opts.enabled ?? true;

    this.filter = new LowPassFilter(this.filterHz);
    /** @type {{t:number, heading:number}[]} */
    this._history = [];
    this.reset();
  }

  reset(trueHeading = 0) {
    this.bias = 0;
    this.time = 0;
    this.heading = trueHeading;
    this.angularVelocity = 0;
    this._history.length = 0;
    this._offset = 0;
    this.filter.reset(trueHeading);
    return this;
  }

  /**
   * The "reset yaw" call every field-centric op-mode makes before a match.
   *
   * Clears the latency buffer and the filter as well as setting the offset:
   * a real IMU reset flushes its pipeline too, and leaving stale pre-reset
   * samples in the delay line would make the heading jump back for a few
   * milliseconds afterwards.
   *
   * @param {number} trueHeading current true heading, radians
   */
  resetYaw(trueHeading) {
    this._offset = this._rawHeading(trueHeading);
    this._history.length = 0;
    this.filter.reset(0);
    this.heading = 0;
    return this;
  }

  _rawHeading(trueHeading) {
    return trueHeading + this.bias;
  }

  /**
   * @param {number} trueHeading radians, from the physics body
   * @param {number} trueAngularVelocity rad/s
   * @param {number} dt seconds
   * @returns {number} reported heading, radians
   */
  update(trueHeading, trueAngularVelocity, dt) {
    if (!this.enabled) {
      this.heading = trueHeading;
      this.angularVelocity = trueAngularVelocity;
      return this.heading;
    }

    this.time += dt;
    this.bias += (this.driftRateDegPerSec * Math.PI) / 180 * dt;

    let raw = this._rawHeading(trueHeading) - this._offset;
    if (this.noiseDeg > 0) {
      raw += (((Math.random() * 2 - 1) * this.noiseDeg) * Math.PI) / 180;
    }

    this._history.push({ t: this.time, heading: raw });
    // Report the newest sample that is already at least `latencySeconds` old,
    // and discard everything older than it. With zero latency this is the
    // sample just pushed, so a "perfect" IMU really is instantaneous.
    const cutoff = this.time - this.latencySeconds;
    let delayed = this._history[0].heading;
    for (let i = this._history.length - 1; i >= 0; i--) {
      if (this._history[i].t <= cutoff) {
        delayed = this._history[i].heading;
        if (i > 0) this._history.splice(0, i);
        break;
      }
    }

    this.heading = wrapAngle(this.filter.update(delayed, dt));
    this.angularVelocity = trueAngularVelocity;
    return this.heading;
  }
}
