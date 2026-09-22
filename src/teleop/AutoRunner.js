import { OpMode } from './OpMode.js';
import { buildAutoApi } from './autoApi.js';
import { HardwareBus } from '../hardware/HardwareBus.js';

/**
 * Runs an AUTO routine pasted in as JavaScript.
 *
 * ## Why this exists
 *
 * Because AUTO is half the practice and none of it was practisable. The sticks
 * were live during the AUTO period, which is a G401 violation and not what
 * happens at an event: a real AUTO is code, it runs the same way every time,
 * and the thing a team actually iterates on is that code. Being able to paste
 * it in and watch it run against the real physics -- the real battery sag, the
 * real encoder quantisation, the real flywheel recovery -- is the point.
 *
 * ## Two shapes, because autos are written both ways
 *
 * The source may define either, or both:
 *
 * ```js
 * function* auto(robot) {          // sequential: `yield` waits
 *   robot.drive(0.6, 0, 0);
 *   yield 1.2;                     //   a number of seconds
 *   robot.stop();
 *   robot.shooter.spinUp(2300);
 *   yield () => robot.shooter.ready;  //   or until a condition holds
 *   robot.shooter.fire();
 *   yield;                         //   or just one cycle
 * }
 *
 * function loop(robot, dt) { ... } // a state machine, called every cycle
 * ```
 *
 * A generator is what makes a *linear* op-mode possible without real time: an
 * FTC `LinearOpMode` blocks on `sleep()`, and a simulator cannot block -- it
 * has to return so the world can advance. `yield` is the same idea with the
 * waiting handed back to the caller, so the routine reads top to bottom and
 * still steps on the simulated clock. No `async`, no promises: a promise
 * resolves on the microtask queue, which does not line up with a synchronous
 * physics step, and an auto that is one frame behind is an auto that behaves
 * differently every run.
 *
 * ## It is your code, in your browser
 *
 * Compiled with `new Function`, so it runs with the page's own privileges.
 * There is no sandbox and no attempt at one: this is a tool for running *your*
 * auto, and the honest way to say that is to say it. Paste code you wrote.
 *
 * A routine that loops forever without yielding will hang the tab, exactly as
 * it would in any other JavaScript. What this can do is notice afterwards --
 * if one resumption takes longer than `stepBudgetMs` the routine is stopped
 * with an error, so it does not happen again on every frame and you can get
 * back to the editor.
 *
 * @module
 */

/**
 * @typedef {object} AutoStatus
 * @property {'empty'|'compiled'|'running'|'done'|'error'} state
 * @property {string|null} error
 * @property {number} runtime
 * @property {string[]} log
 * @property {Record<string, string|number>} telemetry
 */

export class AutoRunner extends OpMode {
  /**
   * @param {{stepBudgetMs?: number}} [opts]
   */
  constructor(opts = {}) {
    super({ name: 'Auto: pasted code' });
    /** A single resumption taking longer than this stops the routine. */
    this.stepBudgetMs = opts.stepBudgetMs ?? 250;

    this.source = '';
    /** @type {string|null} */
    this.error = null;
    /** @type {{init: Function|null, auto: Function|null, loop: Function|null}|null} */
    this._entry = null;
    /** @type {Generator|null} */
    this._generator = null;
    /** @type {{kind: 'time', until: number}|{kind: 'until', test: Function}|null} */
    this._waiting = null;
    /** True once the routine has run to its end. */
    this.finished = false;
    /** @type {string[]} */
    this.log = [];
    this._api = null;
    this._started = false;
  }

  /**
   * Whether this runner should be given the ROBOT during the AUTO period.
   *
   * Compiled and not broken. A routine that has finished is still armed --
   * the ROBOT simply sits there, which is what a finished auto looks like.
   */
  get armed() {
    return Boolean(this._entry) && !this.error;
  }

  /** @returns {AutoStatus} */
  status() {
    return {
      state: this.error
        ? 'error'
        : !this._entry
          ? 'empty'
          : this.finished
            ? 'done'
            : this._started
              ? 'running'
              : 'compiled',
      error: this.error,
      runtime: this.runtime,
      log: this.log.slice(-40),
      telemetry: { ...this.telemetry },
    };
  }

  /**
   * Compile a routine. Returns the error message, or null on success.
   *
   * Compiling does not run anything: `init` and the first resumption wait for
   * the AUTO period to begin, so pressing Compile cannot move the ROBOT.
   *
   * @param {string} source
   * @returns {string|null}
   */
  compile(source) {
    this.source = source ?? '';
    this.error = null;
    this._entry = null;
    this.reset();

    if (!this.source.trim()) return null;
    try {
      // `typeof` on an identifier that was never declared is safe, so a routine
      // that defines only one of the three shapes compiles fine.
      const factory = new Function(
        'robot',
        'telemetry',
        `"use strict";\n${this.source}\n;return {
           init: typeof init === 'function' ? init : null,
           auto: typeof auto === 'function' ? auto : null,
           loop: typeof loop === 'function' ? loop : null,
         };`,
      );
      // Built against a throwaway API: the module body runs now, and it must
      // not be able to command the ROBOT before the MATCH starts.
      const entry = factory(buildAutoApi(this._inertDeps()), {});
      if (!entry.auto && !entry.loop) {
        this.error = 'No routine found: define function* auto(robot) or function loop(robot, dt).';
        return this.error;
      }
      this._entry = entry;
      return null;
    } catch (err) {
      this.error = `${err.name}: ${err.message}`;
      return this.error;
    }
  }

  /** Throw the compiled routine away. */
  clear() {
    this.source = '';
    this._entry = null;
    this.error = null;
    this.reset();
    return this;
  }

  reset() {
    super.reset();
    this._generator = null;
    this._waiting = null;
    this.finished = false;
    this._started = false;
    this.log = [];
    return this;
  }

  init() {
    this._apiGame = this.sim?.game ?? null;
    this._api = buildAutoApi({
      robot: this.robot,
      game: this.sim?.game ?? null,
      telemetry: this.telemetry,
      log: (message) => {
        this.log.push(message);
        if (this.log.length > 200) this.log.shift();
      },
      runtime: () => this.runtime,
      loopSeconds: () => this.sim?.controlPeriod ?? 0,
    });
  }

  /**
   * Advance the routine by one op-mode cycle.
   *
   * @param {number} dt seconds
   */
  loop(dt) {
    if (!this._entry || this.error || this.finished) return;
    // The game may have been switched on since this was compiled, so the API is
    // rebuilt lazily rather than captured at compile time.
    if (!this._api || this._apiGame !== (this.sim?.game ?? null)) this.init();

    this.runtime += dt;
    const started = performance.now();
    try {
      if (!this._started) {
        this._started = true;
        this._entry.init?.(this._api);
        if (this._entry.auto) this._generator = this._entry.auto(this._api);
      }
      if (this._generator) this._advance(dt);
      this._entry.loop?.(this._api, dt);
    } catch (err) {
      this._fail(`${err.name}: ${err.message}`);
      return;
    }
    const spent = performance.now() - started;
    if (spent > this.stepBudgetMs) {
      this._fail(
        `One cycle took ${spent.toFixed(0)} ms. Is there a loop with no yield in it?`,
      );
    }
  }

  /**
   * Resume the generator at most once per cycle.
   *
   * Once, because every form of yield ends in a wait: a bare `yield` and
   * `yield 0` both wait a cycle, a number waits that long, a predicate waits
   * until it holds. One resumption per cycle is also what makes a routine
   * repeatable -- how much of it runs is set by the op-mode rate and nothing
   * else.
   *
   * The overshoot on a timed wait is carried into the next one. A cycle is 20
   * ms and a wait rarely lands on a cycle boundary, so without this a routine
   * of ten `yield 0.4`s is up to 200 ms long by the end -- which on a chassis
   * doing 1.5 m/s is a third of a metre of drift, and the whole point of an
   * AUTO is that it goes to the same place every time.
   */
  _advance(dt) {
    let carry = 0;
    if (this._waiting) {
      if (this._waiting.kind === 'time') {
        this._waiting.until -= dt;
        if (this._waiting.until > 0) return;
        carry = -this._waiting.until;
      } else if (!this._waiting.test(this._api)) {
        return;
      }
      this._waiting = null;
    }

    const step = this._generator.next();
    if (step.done) {
      this.finished = true;
      this._api.stop();
      return;
    }
    this._waiting = interpretYield(step.value);
    if (this._waiting?.kind === 'time') this._waiting.until -= carry;
  }

  _fail(message) {
    this.error = message;
    this.log.push(`stopped: ${message}`);
    this.robot?.drivetrain?.driveNormalized(0, 0, 0);
    try {
      this._api?.stop();
    } catch {
      // The API itself is what threw; there is nothing safe left to call.
    }
  }

  stop() {
    this.robot?.drivetrain?.driveNormalized(0, 0, 0);
  }

  /**
   * An API with no ROBOT behind it, for the moment of compiling.
   *
   * The module body of a pasted routine runs at compile time -- that is how
   * `function* auto` gets defined -- so anything at the top level runs then
   * too. Handing it a stub means a stray `robot.drive(1, 0, 0)` outside a
   * function cannot make the ROBOT twitch while it is staged for a MATCH.
   */
  _inertDeps() {
    const stub = {
      drivetrain: { driveNormalized() {}, motors: [] },
      subsystems: [],
      imu: { heading: 0, reset() {} },
      battery: { busVoltage: 12 },
      body: { position: { x: 0, y: 0 }, rotation: { radians: 0 }, speed: 0 },
      // A bus that charges nothing, because the module body is not a cycle.
      bus: new HardwareBus({ enabled: false }),
      readHeading: () => 0,
      resetHeading() {},
      readVoltage: () => 12,
      readEncoder: () => 0,
    };
    stub.bus.exempt = true;
    return {
      robot: /** @type {any} */ (stub),
      game: null,
      telemetry: {},
      log: (message) => this.log.push(message),
      runtime: () => 0,
      loopSeconds: () => 0,
    };
  }
}

/**
 * Turn a yielded value into a wait.
 *
 * `null` means one cycle. A number is seconds. A function is a predicate
 * checked every cycle until it holds -- which is how a routine waits for the
 * flywheel, or for the intake to have something in it, rather than guessing at
 * a duration.
 *
 * @param {unknown} value
 */
function interpretYield(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value > 0 ? { kind: 'time', until: value } : null;
  }
  if (typeof value === 'function') return { kind: 'until', test: value };
  return null;
}
