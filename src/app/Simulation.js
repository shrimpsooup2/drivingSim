import { ChallengeRunner } from '../challenges/ChallengeRunner.js';
import { Robot } from '../robot/Robot.js';
import { Field } from '../field/Field.js';
import { TeleOpDrive } from '../teleop/TeleOpDrive.js';
import { InputManager } from '../input/InputManager.js';
import { EventBus } from '../util/events.js';
import { Vec2 } from '../math/Vec2.js';
import { clamp } from '../math/MathUtil.js';

/**
 * Owns the simulated world and drives it forward in time.
 *
 * Three rates run at once, deliberately decoupled because they are decoupled on
 * a real robot:
 *
 *  - **Render rate** -- whatever the browser gives us, typically 60 Hz.
 *  - **Op-mode rate** (default 50 Hz) -- how often driver input is read and
 *    motor commands change. A real robot cannot react faster than this.
 *  - **Physics rate** (default 2000 Hz) -- wheel contact is stiff enough that
 *    it needs sub-millisecond steps to stay stable.
 *
 * Collapsing these into one rate is the usual shortcut and it makes a simulated
 * robot feel unrealistically crisp.
 */
export class Simulation {
  /**
   * @param {import('../config/Config.js').Config} config
   * @param {{input?: InputManager}} [opts]
   */
  constructor(config, opts = {}) {
    this.configStore = config;
    this.config = config.values;
    this.events = new EventBus();

    this.field = new Field(this.config);
    this.robot = new Robot(this.config);
    this.input = opts.input ?? new InputManager({ latencySeconds: this.config.control.inputLatencyMs / 1000 });

    /** @type {import('../teleop/OpMode.js').OpMode} */
    this.opMode = new TeleOpDrive({ config: this.config });
    this.opMode.robot = this.robot;
    this.opMode.sim = this;
    this.opMode.init();

    /** Simulated seconds since the last reset. */
    this.time = 0;
    /** Wall-clock seconds spent inside `step`, for the performance readout. */
    this.stepCostMs = 0;
    this.substepsLastFrame = 0;
    this.paused = false;

    this._physicsAccumulator = 0;
    this._controlAccumulator = 0;
    this.startPose = { x: 0, y: 0, heading: 0 };

    /** Recent positions for the path trail, as [x, y, t] triples. */
    this.trail = /** @type {number[][]} */ ([]);

    /** Driving drills. Null active challenge means free driving. */
    this.challenges = new ChallengeRunner(this);

    this._bindConfig();
    this.resetRobot();
  }

  _bindConfig() {
    this.configStore.on('rebuild', () => {
      this.config = this.configStore.values;
      this.robot.applySettings(this.config, true);
      this.field.applySettings(this.config);
      if (this.opMode instanceof TeleOpDrive) this.opMode.applySettings(this.config);
      this.events.emit('rebuilt');
    });
    this.configStore.on('change', (path) => {
      this.config = this.configStore.values;
      this.robot.applySettings(this.config, false);
      this.field.applySettings(this.config);
      if (this.opMode instanceof TeleOpDrive) this.opMode.applySettings(this.config);
      if (path === 'control.inputLatencyMs') {
        this.input.setLatency(this.config.control.inputLatencyMs / 1000);
      }
    });
    this.configStore.on('bulk', () => {
      this.config = this.configStore.values;
      this.input.setLatency(this.config.control.inputLatencyMs / 1000);
    });
  }

  /** Swap in a different op-mode: an autonomous routine, a test, a drill. */
  setOpMode(opMode) {
    this.opMode?.stop();
    this.opMode = opMode;
    opMode.robot = this.robot;
    opMode.sim = this;
    opMode.reset();
    opMode.init();
    this.events.emit('opModeChanged', opMode);
    return opMode;
  }

  /** Set where `resetRobot` puts the robot. */
  setStartPose(x, y, heading) {
    this.startPose = { x, y, heading };
    return this;
  }

  resetRobot() {
    const p = this.startPose;
    // A drill's clock is meaningless once the robot has been teleported, so it
    // restarts with the robot rather than continuing to run.
    this.challenges?.active?.reset();
    this.robot.reset(p.x, p.y, p.heading);
    this.opMode.reset();
    this.opMode.init();
    this.input.reset();
    this.field.reset();
    this.time = 0;
    this._physicsAccumulator = 0;
    this._controlAccumulator = 0;
    this.trail.length = 0;
    this.events.emit('reset');
    return this;
  }

  /**
   * Advance the simulation by one rendered frame.
   * @param {number} frameSeconds wall-clock time since the last frame
   */
  step(frameSeconds) {
    if (this.paused) {
      // Still poll input while paused so the controller view stays live.
      this.input.update(1 / 60);
      return;
    }
    const t0 = now();
    const cfg = this.config;

    // Cap the frame so a stall in the browser cannot teleport the robot.
    const scaled = Math.min(frameSeconds, cfg.sim.maxFrameSeconds) * cfg.sim.timeScale;
    this._physicsAccumulator += scaled;

    const h = 1 / clamp(cfg.sim.substepHz, 50, 20000);
    const controlPeriod = 1 / clamp(cfg.control.loopRateHz, 1, 1000);
    // Bound the work one frame may do, so a slow machine degrades into slow
    // motion rather than freezing.
    const maxSubsteps = Math.ceil(cfg.sim.maxFrameSeconds / h) + 2;

    let substeps = 0;
    while (this._physicsAccumulator >= h && substeps < maxSubsteps) {
      this._controlAccumulator += h;
      if (this._controlAccumulator >= controlPeriod) {
        this._runControlCycle(controlPeriod);
        this._controlAccumulator -= controlPeriod;
        // Never let control cycles pile up into a burst.
        if (this._controlAccumulator > controlPeriod) this._controlAccumulator = 0;
      }

      this.robot.stepPhysics(h);
      this.field.collide(this.robot.body, this.robot.halfLength, this.robot.halfWidth);

      this._physicsAccumulator -= h;
      this.time += h;
      substeps++;
    }

    // Drop any backlog we could not work through, rather than accumulating debt.
    if (substeps >= maxSubsteps) this._physicsAccumulator = 0;

    // How much simulated time actually elapsed. Using the requested frame time
    // instead would let a drill's clock drift away from the physics whenever
    // the browser stutters or a substep budget is hit.
    const advanced = substeps * h;

    this.substepsLastFrame = substeps;
    this.field.update(advanced);
    this.robot.updateStats(advanced);
    this.challenges.update(advanced);
    this._updateTrail(advanced);
    this.stepCostMs = now() - t0;
  }

  _runControlCycle(dt) {
    const gamepad = this.input.update(dt);
    this.opMode.loop(dt, gamepad, gamepad);
    this.robot.updateControl(dt, gamepad);
  }

  _updateTrail(dt) {
    if (!this.config.view.showTrail) {
      if (this.trail.length) this.trail.length = 0;
      return;
    }
    const p = this.robot.body.position;
    const last = this.trail[this.trail.length - 1];
    if (!last || Math.hypot(p.x - last[0], p.y - last[1]) > 0.01) {
      this.trail.push([p.x, p.y, this.time]);
    }
    const cutoff = this.time - this.config.view.trailSeconds;
    let drop = 0;
    while (drop < this.trail.length && this.trail[drop][2] < cutoff) drop++;
    if (drop > 0) this.trail.splice(0, drop);
  }

  /** Snapshot for the HUD and the graphs. */
  telemetry() {
    const robot = this.robot;
    const body = robot.body;
    const dt = robot.drivetrain;
    const bodyVel = body.bodyVelocity;
    return {
      time: this.time,
      pose: { x: body.position.x, y: body.position.y, heading: body.rotation.radians },
      speed: body.speed,
      bodyVelocity: { x: bodyVel.x, y: bodyVel.y },
      angularVelocity: body.angularVelocity,
      acceleration: body.acceleration.length(),
      busVoltage: robot.battery.busVoltage,
      current: robot.battery.current,
      stateOfCharge: robot.battery.stateOfCharge,
      imuHeading: robot.imu.heading,
      headingError: robot.imu.heading - body.rotation.radians,
      peakGripUsage: dt.telemetry.peakGripUsage,
      slipping: dt.telemetry.slipping,
      measuredTwist: dt.telemetry.measuredTwist,
      maxSpeeds: dt.telemetry.maxSpeeds,
      substeps: this.substepsLastFrame,
      stepCostMs: this.stepCostMs,
      stats: robot.stats,
    };
  }

  /** Position of the robot's centre, as a Vec2. Convenience for the renderer. */
  get robotPosition() {
    return new Vec2(this.robot.body.position.x, this.robot.body.position.y);
  }
}

function now() {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}
