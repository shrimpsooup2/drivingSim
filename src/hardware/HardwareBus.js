/**
 * What it costs to talk to the Control Hub -- and therefore what your loop
 * time actually is.
 *
 * ## The thing this exists to stop teaching wrongly
 *
 * The simulator used to run the op-mode at a rate you typed into a box.
 * `control.loopRateHz = 50` and that was that: the robot got to change its
 * motor commands fifty times a second no matter what the code did. On a real
 * robot nothing works like that. Every conversation with a hub is a round trip
 * over USB and RS-485 -- a bulk read of one hub is about 2 ms, a write (a motor
 * power, a servo position, a run mode) about 2.5 ms, a one-off read about 2 ms,
 * and anything on the I2C bus about 2.5 ms. Add them up and *that* is your loop
 * time. It is why bulk caching exists, why `telemetry.update()` is expensive,
 * and why the honest answer to "why is my loop 40 ms?" is almost always "count
 * your hardware calls".
 *
 * So the loop rate is earned here rather than configured. Code that reads four
 * encoders one at a time pays for four hub reads and runs visibly slower than
 * code that takes one bulk read -- which is the lesson, and it is invisible in
 * a simulator with a fixed tick.
 *
 * Taken from the `HardwareBus` in a teammate's JVM simulator, which charges the
 * same four costs to the thread running the op-mode. It can do that because its
 * robot code is real SDK code on a real thread and can simply be made to wait.
 * Nothing here can block -- a browser frame has to return -- so instead the
 * charges are counted up over a cycle and the total *becomes* the next cycle's
 * period. Same arithmetic, no thread.
 *
 * ## Where the charges are taken
 *
 * At the boundary where robot code meets hardware, which in this simulator is
 * the op-mode and the `robot` object an AUTO routine is handed -- not inside
 * `Encoder` or `MotorController`. The simulator reads its own devices
 * constantly (the renderer, the HUD, the referee, the AI) and none of that
 * would happen on a real robot, so charging at the device would charge for
 * drawing a frame. `bus.own()` is the escape hatch for the few places that
 * have to reach through the boundary.
 *
 * ## Bulk caching, exactly as the SDK does it
 *
 * `LynxModule.BulkCachingMode`:
 *
 *  - **OFF** -- every encoder or current reading is its own hub read.
 *  - **AUTO** -- readings come from a cached bulk packet, and the cache is
 *    invalidated the moment you read the *same* thing twice. One bulk read
 *    therefore covers one reading of each distinct sensor, and a loop that
 *    reads the same encoder in two places quietly pays for two bulk reads.
 *  - **MANUAL** -- the cache never expires until you call `clearBulkCache()`,
 *    which is the fastest and the easiest to get wrong: forget the call and
 *    every reading in the match is the one from the first loop.
 *
 * @module
 */

/**
 * Time for one hub transaction, in milliseconds.
 *
 * These are the same figures the JVM simulator uses. They are round numbers
 * from measurement rather than anything REV publishes, so treat them as the
 * right order of magnitude and adjust them in the settings panel if you have
 * timed your own robot.
 */
export const HUB_TRANSACTION_MS = Object.freeze({
  bulkRead: 2.0,
  write: 2.5,
  read: 2.0,
  i2c: 2.5,
});

/** @typedef {'OFF'|'AUTO'|'MANUAL'} BulkCachingMode */
/** @typedef {'write'|'read'|'bulkRead'|'i2c'} TransactionKind */

export class HardwareBus {
  /**
   * @param {{
   *   enabled?: boolean,
   *   bulkReadMs?: number,
   *   writeMs?: number,
   *   readMs?: number,
   *   i2cMs?: number,
   *   cachingMode?: BulkCachingMode,
   * }} [opts]
   */
  constructor(opts = {}) {
    /** Off means transactions are still counted but cost nothing. */
    this.enabled = opts.enabled ?? true;
    this.bulkReadMs = opts.bulkReadMs ?? HUB_TRANSACTION_MS.bulkRead;
    this.writeMs = opts.writeMs ?? HUB_TRANSACTION_MS.write;
    this.readMs = opts.readMs ?? HUB_TRANSACTION_MS.read;
    this.i2cMs = opts.i2cMs ?? HUB_TRANSACTION_MS.i2c;
    /** @type {BulkCachingMode} */
    this.cachingMode = opts.cachingMode ?? 'AUTO';

    /**
     * True while the simulator is reading its own devices. Nothing is charged
     * or counted, because none of those reads exist on a real robot.
     */
    this.exempt = false;

    this.reset();
  }

  reset() {
    /** Transactions since the last reset, by kind. */
    this.counts = { write: 0, read: 0, bulkRead: 0, i2c: 0 };
    /** ... and during the cycle in progress. */
    this.cycleCounts = { write: 0, read: 0, bulkRead: 0, i2c: 0 };
    /** What the last completed cycle counted, which is what a readout wants. */
    this.lastCounts = { write: 0, read: 0, bulkRead: 0, i2c: 0 };

    /** Seconds charged during the cycle in progress. */
    this.seconds = 0;
    /** Seconds the last completed cycle spent waiting on the hubs. */
    this.lastSeconds = 0;
    /** Seconds charged since the last reset. */
    this.totalSeconds = 0;

    /** What has been read out of the current bulk packet. */
    this._cached = new Set();
    this._cacheValid = false;
    return this;
  }

  /**
   * Run `fn` as the simulator rather than as robot code.
   *
   * Re-entrant, because the renderer reaching into a subsystem that reaches
   * into a motor must not un-exempt itself half way down.
   * @template T
   * @param {() => T} fn
   * @returns {T}
   */
  own(fn) {
    if (this.exempt) return fn();
    this.exempt = true;
    try {
      return fn();
    } finally {
      this.exempt = false;
    }
  }

  // ----------------------------------------------------------- transactions

  /**
   * A write: a motor power, a servo position, a run mode, an LED.
   *
   * `count` is there because one call from an op-mode can be several
   * transactions -- setting four motor powers is four.
   * @param {number} [count]
   */
  write(count = 1) {
    return this._charge('write', this.writeMs, count);
  }

  /** A read that no bulk packet covers: voltage, a digital input, a servo. */
  read(count = 1) {
    return this._charge('read', this.readMs, count);
  }

  /** Anything on the I2C bus: the built-in IMU, a colour sensor, a Pinpoint. */
  i2c(count = 1) {
    return this._charge('i2c', this.i2cMs, count);
  }

  /** A whole hub's worth of encoders, currents and digital inputs at once. */
  bulkRead() {
    this._cached.clear();
    this._cacheValid = true;
    return this._charge('bulkRead', this.bulkReadMs, 1);
  }

  /**
   * A reading a bulk packet can satisfy: an encoder position or velocity, a
   * motor current, a digital input.
   *
   * `key` identifies what is being read -- `'leftFront.position'` and
   * `'leftFront.velocity'` are two different registers in the same packet, so
   * they are two different keys and one bulk read covers both.
   * @param {string} key
   */
  cachedRead(key) {
    if (this.exempt) return 0;
    if (this.cachingMode === 'OFF') return this.read();
    // AUTO expires the cache when you ask for something you have already had
    // out of it. That is what makes one bulk read cover one pass over the
    // sensors, and what makes reading the same encoder twice cost double.
    const stale = this.cachingMode === 'AUTO' && this._cached.has(key);
    if (!this._cacheValid || stale) this.bulkRead();
    this._cached.add(key);
    return 0;
  }

  /**
   * `LynxModule.clearBulkCache()`. Only means anything in MANUAL mode, where
   * it is the one thing standing between you and reading the same stale packet
   * for the whole match.
   */
  clearBulkCache() {
    if (this.exempt) return this;
    this._cached.clear();
    this._cacheValid = false;
    return this;
  }

  /** Whether the next cached read will come out of the packet already fetched. */
  get cacheWarm() {
    return this._cacheValid;
  }

  /**
   * @param {TransactionKind} kind
   * @param {number} millis
   * @param {number} count
   * @returns {number} seconds charged
   */
  _charge(kind, millis, count) {
    if (this.exempt || !(count > 0)) return 0;
    this.counts[kind] += count;
    this.cycleCounts[kind] += count;
    if (!this.enabled || !(millis > 0)) return 0;
    const seconds = (millis / 1000) * count;
    this.seconds += seconds;
    this.totalSeconds += seconds;
    return seconds;
  }

  // ------------------------------------------------------------------ cycles

  /** Start an op-mode cycle. The charge clock goes back to zero. */
  beginCycle() {
    this.seconds = 0;
    this.cycleCounts = { write: 0, read: 0, bulkRead: 0, i2c: 0 };
    return this;
  }

  /**
   * End it, and report what the hubs cost.
   * @returns {number} seconds
   */
  endCycle() {
    this.lastSeconds = this.seconds;
    this.lastCounts = { ...this.cycleCounts };
    return this.lastSeconds;
  }

  /** Total transactions the last completed cycle made. */
  get lastTransactions() {
    const c = this.lastCounts;
    return c.write + c.read + c.bulkRead + c.i2c;
  }

  /** Apply a changed `control.hub` config block. */
  applySettings(hub) {
    if (!hub) return this;
    this.enabled = hub.latency !== false;
    this.bulkReadMs = hub.bulkReadMs ?? this.bulkReadMs;
    this.writeMs = hub.writeMs ?? this.writeMs;
    this.readMs = hub.readMs ?? this.readMs;
    this.i2cMs = hub.i2cMs ?? this.i2cMs;
    if (hub.cachingMode) this.cachingMode = hub.cachingMode;
    return this;
  }

  /** For the inspector and the HUD. */
  status() {
    return {
      enabled: this.enabled,
      cachingMode: this.cachingMode,
      cacheWarm: this._cacheValid,
      lastMs: this.lastSeconds * 1000,
      totalMs: this.totalSeconds * 1000,
      counts: { ...this.counts },
      lastCounts: { ...this.lastCounts },
      transactions: this.lastTransactions,
    };
  }
}

/**
 * A bus that charges nothing, for the robots nobody is writing code for.
 *
 * The three AI robots run at the simulator's own rate -- they are not op-modes
 * and there is no loop time to model for them -- so counting their
 * transactions would only put numbers in an inspector that mean nothing.
 */
export function idleBus() {
  const bus = new HardwareBus({ enabled: false });
  bus.exempt = true;
  return bus;
}
