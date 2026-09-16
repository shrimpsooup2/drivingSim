import { BiobuzzGame } from './BiobuzzGame.js';
import { ChallengeRunner } from '../challenges/ChallengeRunner.js';
import { Opponent } from '../ai/Opponent.js';
import { resolveDynamicPair } from '../physics/collision.js';
import { Robot } from '../robot/Robot.js';
import { Field } from '../field/Field.js';
import { TeleOpDrive } from '../teleop/TeleOpDrive.js';
import { AutoRunner } from '../teleop/AutoRunner.js';
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

    /**
     * A pasted AUTO routine, which takes the ROBOT for the AUTO period.
     *
     * Always present and empty until something is compiled into it, because
     * the alternative -- swapping the whole op-mode over at the start of AUTO
     * and back at the transition -- loses the teleop op-mode's state twice a
     * MATCH for no reason. Two op-modes, and the MATCH phase decides which one
     * has the ROBOT.
     */
    this.autoRunner = new AutoRunner();
    this.autoRunner.robot = this.robot;
    this.autoRunner.sim = this;
    this.autoRunner.init();

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

    /**
     * The BIOBUZZ game, when it is switched on. Null means a bare field, which
     * is what the drills and free driving use.
     * @type {BiobuzzGame|null}
     */
    this.game = null;

    /** @type {Opponent[]} AI robots sharing the field. */
    this.opponents = [];
    /**
     * Randomness source handed to opponents. Tests seed it so an AI drill is
     * reproducible; left null it falls through to Math.random.
     * @type {(() => number)|null}
     */
    this.random = null;

    /**
     * A `NetHost`, a `NetClient`, or null for a machine driving on its own.
     *
     * A host simulates as usual and additionally drives whichever robots have
     * a human on them. A client does not simulate at all -- `step` skips the
     * physics and the mirror is written from snapshots instead -- because
     * running physics that is about to be overwritten is both wasted work and
     * a source of visible fighting between the two.
     * @type {any}
     */
    this.net = null;

    this._bindConfig();
    this.resetRobot();

  }

  _bindConfig() {
    this.configStore.on('rebuild', () => {
      this.config = this.configStore.values;
      this.robot.applySettings(this.config, true);
      for (const opponent of this.opponents) opponent.applyBaseConfig(this.config);
      this.field.applySettings(this.config);
      if (this.opMode instanceof TeleOpDrive) this.opMode.applySettings(this.config);
      this._applyGameSettings();
      this.events.emit('rebuilt');
    });
    this.configStore.on('change', (path) => {
      this.config = this.configStore.values;
      this.robot.applySettings(this.config, false);
      // Opponents share the world, so a change to tile grip or battery must
      // reach them too -- without rebuilding, which would discard their state.
      for (const opponent of this.opponents) opponent.applyBaseConfig(this.config, false);
      this.field.applySettings(this.config);
      if (this.opMode instanceof TeleOpDrive) this.opMode.applySettings(this.config);
      if (path === 'control.inputLatencyMs') {
        this.input.setLatency(this.config.control.inputLatencyMs / 1000);
      }
      this._applyGameSettings();
    });
    this.configStore.on('bulk', () => {
      this.config = this.configStore.values;
      this.input.setLatency(this.config.control.inputLatencyMs / 1000);
      this._applyGameSettings();
    });
  }

  /**
   * Push match settings into a running game.
   *
   * See `_applyGameSettings` for which changes rebuild and which apply live.
   */
  _applyGameSettings() {
    const game = this.game;
    if (!game) return null;
    // Two changes the game cannot absorb in place: which ALLIANCE is yours
    // (wired into every participant and into the MATCH's entries) and who else
    // is on the FIELD (three robots have to be built or taken away). Both
    // rebuild, restarting the MATCH. Everything else applies live.
    if (game.needsRebuild(this.config)) {
      this.disableGame();
      return this.enableGame().start();
    }
    game.applySettings(this.config);
    return game;
  }

  /**
   * Switch BIOBUZZ on. Returns the game so callers can start a MATCH.
   *
   * The drills need a bare field -- their courses place their own obstacles and
   * opponents -- so `ChallengeRunner` turns the game off when a drill is
   * selected and back on when it is cleared.
   * @param {{alliance?: 'red'|'blue'}} [opts]
   */
  enableGame(opts = {}) {
    if (this.game) return this.game;
    // A drill owns the obstacles and opponents it placed, so drop it -- but
    // only if one is running. `challenges.clear()` also clears opponents, and
    // opponents the user added by hand are theirs to keep.
    if (this.challenges.active) this.challenges.clear();
    this.game = new BiobuzzGame(this, opts);
    this.events.emit('gameEnabled', this.game);
    return this.game;
  }

  /** Switch it back off, leaving a bare field behind. */
  disableGame() {
    if (!this.game) return null;
    this.game.dispose();
    this.game = null;
    this.events.emit('gameDisabled');
    return null;
  }

  /** Swap in a different op-mode: an autonomous routine, a test, a drill. */
  /**
   * Whether a pasted AUTO routine is driving right now.
   *
   * Only during the AUTO period of a BIOBUZZ MATCH: outside one there is no
   * AUTO to run, and the driver should have the ROBOT.
   */
  get runningAuto() {
    return Boolean(this.autoRunner?.armed) && Boolean(this.game?.match?.inAuto);
  }

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

  /**
   * Put an AI opponent on the field.
   * @param {Omit<ConstructorParameters<typeof Opponent>[0], 'baseConfig'>} spec
   */
  addOpponent(spec) {
    const opponent = new Opponent({ ...spec, baseConfig: this.config, random: this.random ?? undefined });
    this.opponents.push(opponent);
    this.events.emit('opponentsChanged', this.opponents);
    return opponent;
  }

  /**
   * Drop the opponents matching `predicate`, leaving the rest.
   *
   * The game needs this rather than `clearOpponents`: it created three robots
   * of its own and has to take exactly those back off, because opponents the
   * user added by hand or a drill placed are not its to remove.
   * @param {(opponent: Opponent) => boolean} predicate
   */
  removeOpponents(predicate) {
    const kept = this.opponents.filter((o) => !predicate(o));
    if (kept.length === this.opponents.length) return this.opponents;
    this.opponents.length = 0;
    this.opponents.push(...kept);
    this.events.emit('opponentsChanged', this.opponents);
    return this.opponents;
  }

  clearOpponents() {
    this.opponents.length = 0;
    this.events.emit('opponentsChanged', this.opponents);
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
    for (const opponent of this.opponents) opponent.reset();
    this.opMode.reset();
    this.opMode.init();
    // The routine starts over too, but stays compiled: resetting the ROBOT to
    // run the same auto again is the single most common thing anybody will do
    // with this, and having to press Compile each time would be absurd.
    this.autoRunner.reset();
    this.autoRunner.init();
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

    if (this.net?.role === 'client') {
      // A joiner draws the host's FIELD. It still polls its own gamepad at the
      // op-mode rate and sends it, and it still runs the local clocks the HUD
      // reads, but nothing here integrates anything: the snapshot is the truth.
      this._mirrorFrame(frameSeconds);
      this.stepCostMs = now() - t0;
      return;
    }

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
      if (this.opponents.length > 0) this._stepOpponents(h);

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
    // The game runs on the time the physics actually covered, not the frame
    // time, so the MATCH clock cannot drift away from the world when the
    // browser stutters or a substep budget is hit.
    this.game?.update(advanced);
    this.net?.update(advanced);
    this.field.update(advanced);
    this.robot.updateStats(advanced);
    this.challenges.update(advanced);
    this._updateTrail(advanced);
    this.stepCostMs = now() - t0;
  }

  /**
   * One frame as a joiner: poll, send, and draw the host's world.
   *
   * The control period is kept because the input rate should not depend on the
   * frame rate -- a 144 Hz machine must not flood the host, and a 30 Hz one
   * must not starve it.
   * @param {number} frameSeconds
   */
  _mirrorFrame(frameSeconds) {
    const dt = Math.min(frameSeconds, this.config.sim.maxFrameSeconds);
    const controlPeriod = 1 / clamp(this.config.control.loopRateHz, 1, 1000);
    this._controlAccumulator += dt;
    while (this._controlAccumulator >= controlPeriod) {
      const gamepad = this.input.update(controlPeriod);
      this.net.sendInput(gamepad);
      this._controlAccumulator -= controlPeriod;
    }
    this.net.update(dt);
    this.time += dt;
    this.substepsLastFrame = 0;
    this._updateTrail(dt);
  }

  _runControlCycle(dt) {
    const gamepad = this.input.update(dt);
    // During AUTO a compiled routine has the ROBOT, and the sticks do nothing
    // -- which is both G401 ("DRIVE TEAM members may not directly or
    // indirectly interact with a ROBOT ... until the end of AUTO") and the
    // whole point of having pasted an auto in. The gamepad is still *read*, so
    // its edge detection stays warm for TELEOP.
    if (this.runningAuto) {
      this.autoRunner.loop(dt, gamepad, gamepad);
      // No gamepad to the subsystems: the routine sets their commands itself,
      // and a null gamepad leaves them where it put them.
      this.robot.updateControl(dt, null);
    } else {
      this.opMode.loop(dt, gamepad, gamepad);
      this.robot.updateControl(dt, gamepad);
    }

    if (this.opponents.length === 0) return;
    // Opponents are told what the player is doing and, if a drill is running,
    // where the player is trying to get to. Knowing the objective is what lets
    // a defender deny the route rather than merely chase.
    const objective = this.challenges.active?.current;
    const target = objective
      ? (objective.gate ? objective.gate.center : objective.zone.center)
      : null;
    const world = {
      position: this.robot.body.position,
      velocity: this.robot.body.velocity,
      heading: this.robot.body.rotation.radians,
      target,
      fieldHalfSize: this.field.halfSize,
      // With BIOBUZZ running an opponent plays the game rather than the
      // player: it collects, it scores, it tips. Without it the same robot
      // falls back to the drill behaviour it was created with.
      game: this.game,
    };
    const host = this.net?.role === 'host' ? this.net : null;
    host?.ageSeats(dt);
    for (const opponent of this.opponents) {
      // A robot with a human on it is driven exactly the way the player's is
      // -- see `NetHost.driveSeat`. Without a live seat it is the AI's again,
      // which is also what happens the moment a joiner's input dries up.
      const seat = host?.seatFor(opponent);
      if (seat) host.driveSeat(seat, dt);
      else opponent.updateControl(dt, world);
    }
  }

  /**
   * Advance every opponent and resolve robot-on-robot contact.
   *
   * Opponents run the same physics as the player, so they accelerate, break
   * traction and get shoved for real. A scripted mover that slides along a path
   * would be unbeatable in the wrong way -- you could not out-drive it, only
   * wait for it.
   * @param {number} h substep, seconds
   */
  _stepOpponents(h) {
    const contactOptions = {
      restitution: this.config.field.wallRestitution,
      friction: this.config.field.wallFriction,
    };

    for (const opponent of this.opponents) {
      opponent.stepPhysics(h);
      this.field.collideBody(opponent.robot.body, opponent.halfLength, opponent.halfWidth);
    }

    // Player against each opponent.
    this.robotContact = false;
    for (const opponent of this.opponents) {
      const contact = resolveDynamicPair(
        this.robot.body,
        this.robot.halfLength,
        this.robot.halfWidth,
        opponent.robot.body,
        opponent.halfLength,
        opponent.halfWidth,
        contactOptions,
      );
      if (contact) this.robotContact = true;
    }

    // And each pair of opponents, so they cannot occupy the same space.
    for (let i = 0; i < this.opponents.length; i++) {
      for (let j = i + 1; j < this.opponents.length; j++) {
        const a = this.opponents[i];
        const b = this.opponents[j];
        resolveDynamicPair(
          a.robot.body, a.halfLength, a.halfWidth,
          b.robot.body, b.halfLength, b.halfWidth,
          contactOptions,
        );
      }
    }
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
