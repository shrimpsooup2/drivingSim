/**
 * A compiled Java op-mode, and the scheduler that runs it.
 *
 * ## Running a thread without a thread
 *
 * On a Control Hub the op-mode has its own thread. It runs, and every time it
 * talks to a hub it waits a couple of milliseconds while the rest of the robot
 * carries on. That waiting is the whole reason the world and the op-mode stay in
 * step, and it is why loop times are what they are.
 *
 * So that is the scheduler here. The compiled code yields at every loop, and at
 * each of those points this asks one question: *has the op-mode done anything
 * that takes time since the last one?* Hub transactions count, because the
 * `HardwareBus` charges them; reading the clock counts, because on a real robot
 * time passes whether you look at it or not. If either has happened, control
 * goes back to the simulator and the world advances. If neither has -- the
 * op-mode is doing arithmetic -- it keeps going, because arithmetic is
 * instantaneous on a real robot too.
 *
 * What falls out of that is the right thing without anybody arranging it: a
 * `while (opModeIsActive())` loop that writes four motor powers runs once per
 * cycle and the cycle is 17.5 ms long; the same loop reading its encoders one
 * at a time instead of in a bulk read runs slower; and a `for` loop summing an
 * array does not cost a frame.
 *
 * ## Which op-mode
 *
 * A repository has many. The one to run is chosen the way a Driver Station
 * chooses: from the `@Autonomous` and `@TeleOp` annotations, with `@Disabled`
 * hidden. An `@Autonomous` runs during AUTO and a `@TeleOp` during TELEOP, so
 * a team's own teleop code can drive the robot instead of the built-in one.
 *
 * @module
 */
import { createRuntime } from '../ftc/runtime.js';
import { compileJava } from './compile.js';

/**
 * How many times a scheduling point may be resumed in one cycle before the
 * scheduler gives up and lets the world move anyway.
 *
 * Only reached by a loop that neither touches hardware nor looks at the clock,
 * which on a real robot would be an infinite loop that pegs a core. Better to
 * keep going slowly and say so than to freeze the tab.
 */
const MAX_RESUMPTIONS = 4000;

export class JavaProgram {
  /**
   * @param {{
   *   compiled: import('./compile.js').CompiledJava,
   *   sources: Array<{name: string, source: string}>,
   * }} opts
   */
  constructor(opts) {
    this.compiled = opts.compiled;
    this.sources = opts.sources;
    /** Op-modes worth showing, in the order a Driver Station would list them. */
    this.opModes = [...this.compiled.opModes]
      .filter((o) => !o.disabled)
      .sort((a, b) => a.group.localeCompare(b.group) || a.name.localeCompare(b.name));
    /** Compiler warnings. Hardware ones are merged in by the getter below. */
    this.compileWarnings = [...this.compiled.warnings];
    /** @type {string|null} */
    this.selected = this.opModes[0]?.className ?? null;
    this.reset();
  }

  /**
   * Compile sources, or throw a `JavaSyntaxError` naming the file and line.
   * @param {Array<{name: string, source: string}>} sources
   */
  static from(sources) {
    return new JavaProgram({ compiled: compileJava(sources), sources });
  }

  /** The descriptor of the op-mode that would run. */
  get descriptor() {
    return this.opModes.find((o) => o.className === this.selected) ?? null;
  }

  /** Which match period this op-mode owns. */
  get period() {
    return this.descriptor?.kind === 'teleop' ? 'teleop' : 'auto';
  }

  select(className) {
    if (this.opModes.some((o) => o.className === className)) {
      this.selected = className;
      this.reset();
    }
    return this;
  }

  reset() {
    /** @type {any} */
    this.instance = null;
    /** @type {Generator|null} */
    this.iterator = null;
    this.runtime = null;
    /** 'idle' | 'init' | 'running' | 'done' | 'error' */
    this.state = 'idle';
    this.error = null;
    /** @type {{kind: 'sleep', left: number}|{kind: 'start'}|null} */
    this.waiting = null;
    /** For an iterative OpMode: which hook comes next. */
    this.stage = 'init';
    this.resumptions = 0;
    this.spinWarned = false;
    return this;
  }

  /**
   * Build the instance and run its init sequence.
   *
   * Separate from stepping so the hardware lookups, and the report of what
   * resolved to what, happen as soon as the op-mode is chosen -- before the
   * match starts, exactly as pressing INIT does.
   *
   * @param {object} deps see `createRuntime`
   */
  initialise(deps) {
    this.reset();
    const descriptor = this.descriptor;
    if (!descriptor) {
      this.state = 'error';
      this.error = 'No @Autonomous or @TeleOp op-mode in these files.';
      return this;
    }
    try {
      this.runtime = createRuntime(deps);
      const classes = this.compiled.factory(this.runtime);
      const Klass = classes[descriptor.className];
      if (!Klass) throw new Error(`${descriptor.className} did not compile`);
      this.instance = new Klass();
      this.state = 'init';
      if (descriptor.linear) {
        const run = this.instance.runOpMode;
        if (typeof run !== 'function') throw new Error('runOpMode is missing');
        const result = run.call(this.instance);
        // A `runOpMode` that blocks is a generator; one that does not is a
        // plain call that has already finished by the time it returns.
        this.iterator = result && typeof result.next === 'function' ? result : null;
        if (!this.iterator) this.state = 'done';
        else this._runInitSequence();
      } else {
        this._stepIterative(0, { started: false, stopping: false });
      }

    } catch (err) {
      this._fail(err);
    }
    return this;
  }

  /**
   * Run everything before `waitForStart()`.
   *
   * This is the INIT period: the hardware lookups, the run modes, the
   * "initialised" telemetry. It happens as soon as the op-mode is chosen, so
   * the panel can report what resolved to what before the match starts -- and
   * so a missing device is a message rather than a surprise on the first frame
   * of AUTO. No world time passes, and motors are held at zero until START, so
   * nothing can move.
   */
  _runInitSequence() {
    const phase = { started: false, stopping: false };
    for (let i = 0; i < MAX_RESUMPTIONS; i++) {
      const step = this.iterator.next();
      if (step.done) {
        this.state = 'done';
        return;
      }
      const value = step.value;
      if (value && typeof value === 'object') {
        if (value.waitForStart) {
          this.waiting = { kind: 'start' };
          return;
        }
        if (value.sleep !== undefined) {
          // A sleep before the match starts waits on the simulated clock like
          // any other, so it is left for the period to drain.
          this.waiting = { kind: 'sleep', left: value.sleep };
          return;
        }
      }
    }
    this.compileWarnings.push('the init sequence did not reach waitForStart(); it may be looping');
  }

  /** What `hardwareMap.get` resolved to, for the panel. */
  get resolutions() {
    return this.runtime?.hardwareMap.resolutions ?? [];
  }

  /**
   * Everything worth saying, compiler and hardware together.
   *
   * A getter rather than a list built at startup, because a `hardwareMap.get`
   * for a name nothing answers to often happens *after* `waitForStart()` -- so
   * copying the hardware warnings once, at init, missed exactly the case the
   * warning exists for.
   */
  get warnings() {
    return [...this.compileWarnings, ...(this.runtime?.hardwareMap.warnings ?? [])];
  }

  /**
   * One control cycle.
   *
   * @param {number} dt seconds of simulated time this cycle covers
   * @param {{started: boolean, stopping: boolean}} phase
   */
  step(dt, phase) {
    if (this.state === 'error' || this.state === 'done' || !this.instance) return this.state;
    this.runtime.tick(dt);
    try {
      if (this.descriptor.linear) this._stepLinear(dt, phase);
      else this._stepIterative(dt, phase);
    } catch (err) {
      if (err?.opModeStop) this.state = 'done';
      else this._fail(err);
    }
    return this.state;
  }

  /** A `LinearOpMode`: one generator, driven until it needs the world. */
  _stepLinear(dt, phase) {
    const bus = this.runtime.hardwareMap.bus;
    let resumptions = 0;

    for (;;) {
      if (this.waiting) {
        if (this.waiting.kind === 'sleep') {
          this.waiting.left -= dt;
          if (this.waiting.left > 0) return;
        } else if (this.waiting.kind === 'start') {
          if (!phase.started && !phase.stopping) return;
        }
        this.waiting = null;
      }

      const mark = bus.seconds + this.runtime.progress();
      const step = this.iterator.next();
      if (step.done) {
        this.state = 'done';
        return;
      }
      const value = step.value;
      if (value && typeof value === 'object') {
        if (value.sleep !== undefined) {
          this.waiting = { kind: 'sleep', left: value.sleep };
          return;
        }
        if (value.waitForStart) {
          this.waiting = { kind: 'start' };
          return;
        }
      }
      if (this.state === 'init' && phase.started) this.state = 'running';

      // A scheduling point. Give the world a turn if the op-mode has spent any
      // time -- on the hubs or on the clock -- since the last one.
      if (bus.seconds + this.runtime.progress() > mark) return;
      if (++resumptions >= MAX_RESUMPTIONS) {
        if (!this.spinWarned) {
          this.spinWarned = true;
          this.compileWarnings.push(
            'a loop is running without touching the hardware or the clock, so the ' +
              'simulator cannot tell how long it takes; it is being advanced anyway',
          );
        }
        return;
      }
    }
  }

  /** An iterative `OpMode`: init, init_loop, start, loop, stop. */
  _stepIterative(dt, phase) {
    const instance = this.instance;
    if (this.stage === 'init') {
      this._drive(instance.init());
      this.stage = 'init_loop';
      return;
    }
    if (this.stage === 'init_loop') {
      if (!phase.started) {
        this._drive(instance.init_loop());
        this.runtime.telemetry.update();
        return;
      }
      this._drive(instance.start());
      this.stage = 'loop';
      this.state = 'running';
      return;
    }
    if (this.stage === 'loop') {
      if (phase.stopping) {
        this._drive(instance.stop());
        this.stage = 'stopped';
        this.state = 'done';
        return;
      }
      this._drive(instance.loop());
      // The SDK transmits an iterative op-mode's telemetry after every `loop()`
      // without being asked, which is why so much teleop code has `addData`
      // and no `update()`. Without this, that code shows nothing.
      this.runtime.telemetry.update();
    }
  }

  /**
   * Run an iterative hook to completion inside this cycle.
   *
   * `loop()` is meant to return promptly, and the SDK will tell you off if it
   * does not -- so if the compiler made it a generator (because it contains a
   * loop), it is drained here rather than spread across frames. That keeps the
   * iterative contract: one `loop()` per cycle.
   */
  _drive(result) {
    if (!result || typeof result.next !== 'function') return;
    for (let i = 0; i < MAX_RESUMPTIONS; i++) {
      const step = result.next();
      if (step.done) return;
      const value = step.value;
      if (value && typeof value === 'object' && value.sleep !== undefined) {
        // A `sleep` inside an iterative loop() is a mistake the SDK punishes
        // with a stuck-detection restart. Here it just costs the rest of the
        // cycle, and the warning says why.
        if (!this.spinWarned) {
          this.spinWarned = true;
          this.compileWarnings.push('sleep() inside an iterative OpMode.loop() blocks the robot; use a timer instead');
        }
        return;
      }
    }
  }

  _fail(err) {
    this.state = 'error';
    const where = err?.line ? ` (line ${err.line})` : '';
    this.error = `${err?.javaClass ?? err?.name ?? 'Error'}: ${err?.message ?? err}${where}`;
  }
}
