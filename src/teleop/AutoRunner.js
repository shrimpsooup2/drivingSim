import { OpMode } from './OpMode.js';
import { buildAutoApi } from './autoApi.js';
import { HardwareBus } from '../hardware/HardwareBus.js';
import { JavaProgram } from '../java/JavaProgram.js';
import { JavaSyntaxError, looksLikeJava } from '../java/compile.js';

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
 * ## Two languages
 *
 * Paste JavaScript and it runs as described below. Paste **Java** -- a real
 * `LinearOpMode` out of your team's repository, annotations and all -- and it
 * is compiled to JavaScript and run against a shim of the FTC SDK. Which one
 * you handed over is detected from the source, so there is nothing to select.
 * See `java/compile.js` and `docs/JAVA.md`.
 *
 * A Java program can hold many op-modes, which is what a repository looks like,
 * so the runner keeps the list and which one is chosen -- the same job a Driver
 * Station's op-mode menu does.
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
    /** @type {'js'|'java'} */
    this.language = 'js';
    /**
     * A compiled Java program, when that is what was handed over.
     * @type {JavaProgram|null}
     */
    this.program = null;
    /** Every file compiled, so a repository's helper classes are included. */
    this.files = /** @type {Array<{name: string, source: string}>} */ ([]);
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
    if (this.error) return false;
    if (this.language === 'java') return Boolean(this.program?.descriptor);
    return Boolean(this._entry);
  }

  /**
   * Which match period this code owns.
   *
   * JavaScript routines are autos. A Java `@TeleOp` runs during TELEOP instead,
   * so a team's own driver code can have the robot rather than the built-in
   * teleop -- which is the other half of "run my repository".
   */
  get period() {
    return this.language === 'java' ? this.program?.period ?? 'auto' : 'auto';
  }

  /** The op-modes found in the compiled files, for the chooser. */
  get opModes() {
    return this.program?.opModes ?? [];
  }

  /** Which one is selected. */
  get selected() {
    return this.program?.selected ?? null;
  }

  /** Choose one, and run its init sequence. */
  select(className) {
    if (!this.program) return this;
    this.program.select(className);
    this._initJava();
    return this;
  }

  /** What `hardwareMap.get` found, for the panel. */
  get resolutions() {
    return this.program?.resolutions ?? [];
  }

  /** Anything the compiler or the hardware map wants to say. */
  get warnings() {
    return this.program?.warnings ?? [];
  }

  /** @returns {AutoStatus} */
  status() {
    return {
      state: this._state(),
      error: this.error ?? this.program?.error ?? null,
      runtime: this.runtime,
      log: this.log.slice(-40),
      telemetry: { ...this.telemetry },
      language: this.language,
      opModes: this.opModes,
      selected: this.selected,
      resolutions: this.resolutions,
      warnings: this.warnings,
      files: this.files.map((f) => f.name),
    };
  }

  _state() {
    if (this.error) return 'error';
    if (this.language === 'java') {
      if (!this.program) return 'empty';
      if (this.program.state === 'error') return 'error';
      if (this.program.state === 'done') return 'done';
      if (this.program.state === 'running') return 'running';
      return this.program.descriptor ? 'compiled' : 'empty';
    }
    if (!this._entry) return 'empty';
    if (this.finished) return 'done';
    return this._started ? 'running' : 'compiled';
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
  compile(source, name = 'Pasted.java') {
    const text = source ?? '';
    if (looksLikeJava(text)) return this.compileFiles([{ name, source: text }]);
    this.source = text;
    this.files = [];
    this.language = 'js';
    this.program = null;
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

  /**
   * Compile one or more Java files together.
   *
   * Together, because a repository's op-mode references the team's own helper
   * classes and each file on its own would not compile. The op-modes found
   * across all of them become the chooser's list.
   *
   * @param {Array<{name: string, source: string}>} files
   * @returns {string|null} the error, or null
   */
  compileFiles(files) {
    this.files = files.filter((f) => f.source?.trim());
    this.source = this.files.length === 1 ? this.files[0].source : '';
    this.language = 'java';
    this.error = null;
    this._entry = null;
    this.program = null;
    this.reset();
    if (this.files.length === 0) return null;

    try {
      this.program = JavaProgram.from(this.files);
    } catch (err) {
      this.error =
        err instanceof JavaSyntaxError ? err.message : `${err.name}: ${err.message}`;
      return this.error;
    }
    if (this.program.opModes.length === 0) {
      this.error =
        'No op-mode here: a class has to extend LinearOpMode or OpMode, and ' +
        'be annotated @Autonomous or @TeleOp.';
      return this.error;
    }
    this._initJava();
    return this.program.state === 'error' ? this.program.error : null;
  }

  /**
   * Build the runtime and run the selected op-mode's init sequence.
   *
   * Needs a robot, so it is a no-op until the runner has one -- which is the
   * case when a routine is compiled from storage before the simulation exists.
   */
  _initJava() {
    if (!this.program || !this.robot) return this;
    // What the SDK does when an op-mode starts. Directions and run modes
    // belong to the op-mode, not to the robot, so whatever the last one left
    // behind goes before this one looks at the hardware.
    this.robot.resetDeviceConfiguration();
    this.program.initialise({
      robot: this.robot,
      sim: this.sim,
      telemetry: this.telemetry,
      log: (message) => this._log(message),
      warn: (message) => this._log(`warning: ${message}`),
      clock: () => this.sim?.time ?? 0,
      runtime: () => this.runtime,
      resetRuntime: () => {
        this.runtime = 0;
      },
      requestStop: () => {
        this.program.state = 'done';
      },
      phase: () => this._phase(),
      gamepads: () => ({
        gamepad1: this._gamepad1 ?? EMPTY_PAD,
        gamepad2: this._gamepad2 ?? EMPTY_PAD,
      }),
    });
    return this;
  }

  /**
   * Whether the op-mode's period is running, and whether it is ending.
   *
   * `started` is what `waitForStart()` waits for and what releases the motors,
   * so it is the match period the op-mode owns -- AUTO for an `@Autonomous`,
   * TELEOP for a `@TeleOp`.
   */
  _phase() {
    const match = this.sim?.game?.match;
    if (!match) return { started: true, stopping: false };
    const mine = this.period === 'teleop' ? match.driverControl : match.inAuto;
    return { started: mine, stopping: !mine && match.phase !== 'setup' && !this._beforeMine(match) };
  }

  /** True while the match has not reached this op-mode's period yet. */
  _beforeMine(match) {
    if (this.period === 'auto') return match.phase === 'setup';
    return match.phase === 'setup' || match.phase === 'auto' || match.phase === 'transition';
  }

  /** Throw the compiled routine away. */
  clear() {
    this.robot?.resetDeviceConfiguration();
    this.source = '';
    this.files = [];
    this.language = 'js';
    this.program = null;
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
    // The API closes over the telemetry object and the log array, and
    // `super.reset()` has just replaced the first of them -- so an API built
    // before this point writes into an object nothing reads any more. It looks
    // exactly like a routine whose `telemetry.addData` calls do nothing, which
    // is what it was: a routine compiled *after* the game was switched on kept
    // a stale API, because the only thing that used to force a rebuild was the
    // game changing.
    this._api = null;
    this.program?.reset();
    return this;
  }

  init() {
    if (this.language === 'java') {
      this._initJava();
      return;
    }
    this._apiGame = this.sim?.game ?? null;
    this._api = buildAutoApi({
      robot: this.robot,
      game: this.sim?.game ?? null,
      telemetry: this.telemetry,
      log: (message) => this._log(message),
      runtime: () => this.runtime,
      loopSeconds: () => this.sim?.controlPeriod ?? 0,
      drawing: this.sim?.drawing,
    });
  }

  /**
   * Advance the routine by one op-mode cycle.
   *
   * @param {number} dt seconds
   */
  loop(dt, gamepad1, gamepad2) {
    this._gamepad1 = gamepad1;
    this._gamepad2 = gamepad2;
    if (this.language === 'java') {
      this._loopJava(dt);
      return;
    }
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

  /**
   * One cycle of a Java op-mode.
   *
   * The wall-clock budget is kept: a compiled loop is still somebody's code and
   * can still be written so that it never returns.
   */
  _loopJava(dt) {
    if (!this.program || this.error) return;
    if (!this.program.instance) this._initJava();
    if (!this.program.instance) return;
    this.runtime += dt;
    const started = now();
    this.program.step(dt, this._phase());
    if (this.program.state === 'error') {
      this.error = this.program.error;
      this.robot?.drivetrain?.driveNormalized(0, 0, 0);
      this._log(`stopped: ${this.error}`);
      return;
    }
    const spent = now() - started;
    if (spent > this.stepBudgetMs) {
      this.error = `One cycle took ${spent.toFixed(0)} ms. Is there a loop with no yield in it?`;
      this._log(`stopped: ${this.error}`);
      this.robot?.drivetrain?.driveNormalized(0, 0, 0);
    }
  }

  _log(message) {
    this.log.push(String(message));
    if (this.log.length > 200) this.log.shift();
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
      readOdometry: () => ({ x: 0, y: 0, heading: 0 }),
      odometry: { enabled: false, pose: { x: 0, y: 0, heading: 0 }, reset() {} },
      camera: { enabled: false, detections: [], bestPose: () => null },
    };
    stub.bus.exempt = true;
    return {
      robot: /** @type {any} */ (stub),
      game: null,
      telemetry: {},
      log: (message) => this.log.push(message),
      runtime: () => 0,
      loopSeconds: () => 0,
      // No drawing at compile time: the module body runs then, and a stray
      // top-level `robot.draw.point(...)` must not leave a mark on the field of
      // a match that is already staged.
      drawing: undefined,
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

/** A gamepad with nothing pressed, for a cycle that has not been handed one. */
const EMPTY_PAD = Object.freeze({
  left_stick_x: 0, left_stick_y: 0, right_stick_x: 0, right_stick_y: 0,
  left_trigger: 0, right_trigger: 0,
  a: false, b: false, x: false, y: false,
  left_bumper: false, right_bumper: false,
  dpad_up: false, dpad_down: false, dpad_left: false, dpad_right: false,
  back: false, start: false, guide: false,
});

function now() {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}
