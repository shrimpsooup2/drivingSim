import { LowPassFilter } from '../math/filters.js';

/**
 * Quadrature encoder on a motor shaft.
 *
 * Models the two things that actually bite teams: position is quantised to
 * whole ticks, and velocity is a *difference of quantised positions*, so it is
 * far noisier than position. At 28 ticks per motor revolution through a 19.2:1
 * gearbox that is 537.6 ticks per wheel revolution, and a 20 ms sample of a
 * slow-moving wheel may contain only a handful of ticks. That quantisation
 * noise is why velocity PID on an FTC drivetrain needs filtering.
 */
export class Encoder {
  /**
   * @param {{
   *   ticksPerRev?: number,
   *   gearRatio?: number,
   *   velocityFilterHz?: number,
   *   quantise?: boolean,
   *   noiseTicks?: number,
   *   reversed?: boolean,
   * }} [opts]
   */
  constructor(opts = {}) {
    /** Counts per revolution at the motor shaft. */
    this.ticksPerRev = opts.ticksPerRev ?? 28;
    /** Reduction between motor shaft and the measured output. */
    this.gearRatio = opts.gearRatio ?? 1;
    this.velocityFilterHz = opts.velocityFilterHz ?? 20;
    this.quantise = opts.quantise ?? true;
    /** Uniform noise amplitude in ticks; models a marginal cable or connector. */
    this.noiseTicks = opts.noiseTicks ?? 0;
    this.reversed = opts.reversed ?? false;

    this.filter = new LowPassFilter(this.velocityFilterHz);
    this.reset();
  }

  reset() {
    this.ticks = 0;
    this.rawTicks = 0;
    this.velocityTicksPerSec = 0;
    this.lastTicks = 0;
    this.filter.reset(0);
    this.offsetRadians = 0;
    return this;
  }

  /** Counts per revolution of the output (wheel) shaft. */
  get ticksPerOutputRev() {
    return this.ticksPerRev * this.gearRatio;
  }

  /**
   * @param {number} outputAngleRadians accumulated rotation of the output shaft
   * @param {number} dt seconds
   */
  update(outputAngleRadians, dt) {
    const sign = this.reversed ? -1 : 1;
    const revs = (sign * (outputAngleRadians - this.offsetRadians)) / (2 * Math.PI);
    const exact = revs * this.ticksPerOutputRev;

    let ticks = exact;
    if (this.noiseTicks > 0) ticks += (Math.random() * 2 - 1) * this.noiseTicks;
    if (this.quantise) ticks = Math.trunc(ticks);

    this.rawTicks = exact;
    this.lastTicks = this.ticks;
    this.ticks = ticks;

    if (dt > 0) {
      const raw = (this.ticks - this.lastTicks) / dt;
      this.velocityTicksPerSec = this.filter.update(raw, dt);
    }
    return this.ticks;
  }

  /** Zero the encoder at the current shaft angle (STOP_AND_RESET_ENCODER). */
  zero(outputAngleRadians) {
    this.offsetRadians = outputAngleRadians;
    this.ticks = 0;
    this.lastTicks = 0;
    this.rawTicks = 0;
    this.velocityTicksPerSec = 0;
    this.filter.reset(0);
    return this;
  }

  /** Measured output-shaft speed in rad/s, reconstructed from ticks. */
  get velocityRadPerSec() {
    return (this.velocityTicksPerSec / this.ticksPerOutputRev) * 2 * Math.PI;
  }

  /** Measured output-shaft position in radians. */
  get positionRadians() {
    return (this.ticks / this.ticksPerOutputRev) * 2 * Math.PI;
  }
}
