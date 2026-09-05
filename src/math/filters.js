import { clamp } from './MathUtil.js';

/**
 * First-order low-pass filter specified by cutoff frequency.
 * Used for encoder velocity smoothing and IMU noise shaping.
 */
export class LowPassFilter {
  /** @param {number} cutoffHz 0 disables filtering (pass-through). */
  constructor(cutoffHz) {
    this.cutoffHz = cutoffHz;
    this.value = 0;
    this.initialized = false;
  }

  reset(value = 0) {
    this.value = value;
    this.initialized = false;
    return this;
  }

  /**
   * @param {number} input
   * @param {number} dt seconds
   */
  update(input, dt) {
    if (this.cutoffHz <= 0 || dt <= 0) {
      this.value = input;
      this.initialized = true;
      return input;
    }
    if (!this.initialized) {
      this.value = input;
      this.initialized = true;
      return input;
    }
    const alpha = 1 - Math.exp(-2 * Math.PI * this.cutoffHz * dt);
    this.value += alpha * (input - this.value);
    return this.value;
  }
}

/**
 * Limits how fast a signal may change, in units per second.
 *
 * This is the "acceleration ramp" drivers ask for when a robot is too twitchy.
 * Separate up/down rates let you ramp on gently but still cut power instantly.
 */
export class SlewRateLimiter {
  /**
   * @param {number} riseRate units/second when the magnitude is increasing
   * @param {number} [fallRate] units/second when decreasing; defaults to riseRate
   */
  constructor(riseRate, fallRate = riseRate) {
    this.riseRate = riseRate;
    this.fallRate = fallRate;
    this.value = 0;
  }

  reset(value = 0) {
    this.value = value;
    return this;
  }

  setRates(riseRate, fallRate = riseRate) {
    this.riseRate = riseRate;
    this.fallRate = fallRate;
    return this;
  }

  /**
   * @param {number} target
   * @param {number} dt seconds
   */
  update(target, dt) {
    if (dt <= 0) return this.value;

    // "Rising" means the magnitude is growing away from zero; "falling" means
    // heading back toward it. Getting this wrong is subtle but very noticeable:
    // if releasing the stick were treated as rising, the robot would use the
    // gentle acceleration ramp to *stop*, and feel like it had no brakes.
    let rate;
    if (this.value === 0) {
      rate = this.riseRate;
    } else if (Math.sign(target) === Math.sign(this.value)) {
      rate = Math.abs(target) > Math.abs(this.value) ? this.riseRate : this.fallRate;
    } else {
      // Target is on the other side of zero (or is zero): the first part of the
      // move is deceleration, so use the fall rate until we cross over.
      rate = this.fallRate;
    }

    if (rate <= 0 || !Number.isFinite(rate)) {
      this.value = target;
      return this.value;
    }
    const maxDelta = rate * dt;
    this.value += clamp(target - this.value, -maxDelta, maxDelta);
    return this.value;
  }
}

/** Fixed-window moving average, used for smoothing displayed telemetry. */
export class MovingAverage {
  /** @param {number} size */
  constructor(size) {
    this.size = Math.max(1, Math.floor(size));
    /** @type {number[]} */
    this.samples = [];
    this.sum = 0;
    this.index = 0;
  }

  reset() {
    this.samples.length = 0;
    this.sum = 0;
    this.index = 0;
    return this;
  }

  update(value) {
    if (this.samples.length < this.size) {
      this.samples.push(value);
      this.sum += value;
    } else {
      this.sum -= this.samples[this.index];
      this.samples[this.index] = value;
      this.sum += value;
      this.index = (this.index + 1) % this.size;
    }
    return this.sum / this.samples.length;
  }

  get value() {
    return this.samples.length ? this.sum / this.samples.length : 0;
  }
}

/**
 * Delay line for a signal sampled at irregular times.
 *
 * The simulator uses this to model the real latency between a driver moving a
 * stick and the robot reacting: gamepad poll -> Driver Station -> wifi ->
 * Robot Controller -> next control loop. That round trip is tens of
 * milliseconds and is a large part of why a real robot feels different from a
 * naive simulator.
 *
 * @template T
 */
export class DelayLine {
  /** @param {number} delaySeconds */
  constructor(delaySeconds) {
    this.delaySeconds = delaySeconds;
    /** @type {{t:number, value:T}[]} */
    this.queue = [];
    this.time = 0;
  }

  reset() {
    this.queue.length = 0;
    this.time = 0;
    return this;
  }

  /**
   * Advance time, push a new sample, and return the sample that is now
   * `delaySeconds` old (or the newest available if the line is not yet full).
   * @param {T} value
   * @param {number} dt
   * @returns {T}
   */
  update(value, dt) {
    this.time += dt;
    this.queue.push({ t: this.time, value });
    if (this.delaySeconds <= 0) {
      this.queue.length = 0;
      return value;
    }
    const cutoff = this.time - this.delaySeconds;
    let out = this.queue[0].value;
    while (this.queue.length > 1 && this.queue[0].t <= cutoff) {
      out = this.queue[0].value;
      this.queue.shift();
    }
    if (this.queue[0].t <= cutoff) out = this.queue[0].value;
    return out;
  }
}
