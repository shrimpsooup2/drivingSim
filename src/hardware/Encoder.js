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
   *   overflow16Bit?: boolean,
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
    /**
     * Report velocity as the hub does: a signed 16-bit value in ticks per
     * second, so anything past 32767 wraps round.
     *
     * A famous way to lose an afternoon. Position is 32-bit and fine, but
     * velocity is not, and a bare motor with an 8192-count through-bore encoder
     * goes past the limit at about 240 rpm -- so the reported speed suddenly
     * reads large and negative, a velocity loop slams full reverse, and nothing
     * about the code looks wrong. It only bites fast shafts with fine encoders,
     * which is exactly what a flywheel is.
     */
    this.overflow16Bit = opts.overflow16Bit ?? true;

    /**
     * An injected fault, for finding out what your code does when the hardware
     * lets you down.
     *
     *  - `'none'`
     *  - `'dead'` -- reports zero, for ever. What an unplugged encoder cable
     *    does, and it is silent: a position-based AUTO decides it has not moved
     *    and drives until something stops it.
     *  - `'stuck'` -- holds whatever it was reading when the fault started. A
     *    slipping magnet or a shaft that has come loose in its hub.
     *
     * Worth being able to try, because these are the two failures that lose
     * matches and neither of them looks like a code problem.
     * @type {'none'|'dead'|'stuck'}
     */
    this.fault = 'none';
    /** A constant added to what it reports: a miscounted reset, a bad splice. */
    this.offsetTicks = 0;

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
    if (this.fault === 'dead') ticks = 0;
    else if (this.fault === 'stuck') ticks = this.lastTicks;
    else ticks += this.offsetTicks;
    this.ticks = ticks;

    if (dt > 0) {
      const raw = wrap16(this.overflow16Bit, (this.ticks - this.lastTicks) / dt);
      // Filtered after wrapping, because the hub wraps the number it measures
      // and anything downstream only ever sees the wrapped one.
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

/**
 * A ticks-per-second reading as a signed 16-bit field.
 *
 * Wrapped rather than clamped: the hub sends the low 16 bits and the Driver
 * Station reads them as signed, so 33000 comes back as -32536 and not as 32767.
 * Clamping would look like a sensor limit; wrapping looks like the sign flip it
 * actually is, which is the whole reason this is a trap.
 */
function wrap16(enabled, ticksPerSec) {
  if (!enabled) return ticksPerSec;
  const rounded = Math.round(ticksPerSec);
  if (rounded >= -32768 && rounded <= 32767) return ticksPerSec;
  return ((((rounded + 32768) % 65536) + 65536) % 65536) - 32768;
}
