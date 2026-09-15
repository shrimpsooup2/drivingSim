import { Subsystem } from '../Subsystem.js';
import { DcMotor } from '../../hardware/DcMotor.js';
import { MOTOR_PRESETS } from '../../config/presets/motors.js';
import { INCH, clamp } from '../../math/MathUtil.js';
import { POLLEN_MASS, POLLEN_RADIUS } from '../../field/biobuzz/constants.js';
import { heightAtRange, integrateArc, sampleArc } from '../../physics/ballistics.js';

/** Gravity, for the ballistics. */
const G = 9.80665;

/**
 * A stored-energy launcher: a catapult, a lobber, or a linear puncher.
 *
 * ## Why this is a different mechanism and not a flywheel with new numbers
 *
 * A flywheel is a *speed* source. It spins to a surface speed and every ball
 * leaves at some fraction of it, so range is set by RPM and a heavier element
 * costs a few percent through the droop. The skill it demands is patience:
 * wait for the wheel.
 *
 * A catapult is an *energy* source. The elastic stores a fixed number of
 * joules and hands them to whatever is in the cup, so
 *
 *     v = sqrt(2 * eta * E / m)
 *
 * and the mass is under a square root rather than off in a droop term. A
 * POLLEN is 45 g and a NECTAR 85 g, so the same throw that puts a POLLEN out
 * at 6 m/s puts a NECTAR out at 4.4 -- a quarter less speed and nearly half
 * the range. A catapult team re-aims between element types; a flywheel team
 * barely notices. That is a genuinely different thing to learn, which is the
 * point of having both.
 *
 * It also has no recovery problem and no spin-up. What it has instead is a
 * reset: the motor has to wind the elastic back, and until it has, there is no
 * shot at all. So the rhythm is fixed rather than negotiable -- you cannot
 * choose to fire a little early and throw short, you simply cannot fire.
 *
 * And range is set by the release angle alone, because the energy is fixed.
 * That gives it a hard maximum range, and inside that range two angles reach
 * the same spot -- a flat one and a lofted one -- of which only the lofted one
 * arrives descending, which is what a CELL requires.
 *
 * A `puncher` is the same mechanism with less energy, a lower fixed angle and
 * a quick reset: repeatable, fast, and only good from close in.
 */
export class Thrower extends Subsystem {
  /**
   * @param {{
   *   name?: string,
   *   kind?: 'catapult'|'puncher',
   *   energy?: number,
   *   efficiency?: number,
   *   releaseAngle?: number,
   *   minAngle?: number,
   *   maxAngle?: number,
   *   resetSeconds?: number,
   *   batch?: number,
   *   exitHeight?: number,
   *   exitOffset?: number,
   *   angleScatter?: number,
   *   energyScatter?: number,
   *   motor?: DcMotor,
   *   motorCount?: number,
   *   random?: () => number,
   * }} [opts]
   */
  constructor(opts = {}) {
    super({ name: opts.name ?? 'thrower' });

    /** Which flavour, for the UI. Changes nothing in the physics. */
    this.kind = opts.kind ?? 'catapult';
    /** Energy stored in the elastic when drawn, joules. */
    this.energy = opts.energy ?? 1.1;
    /** Fraction of it that reaches the element rather than the arm. */
    this.efficiency = opts.efficiency ?? 0.72;

    this.minAngle = opts.minAngle ?? (30 * Math.PI) / 180;
    this.maxAngle = opts.maxAngle ?? (72 * Math.PI) / 180;
    this.releaseAngle = clamp(
      opts.releaseAngle ?? (55 * Math.PI) / 180,
      this.minAngle,
      this.maxAngle,
    );

    /** How long the motor takes to wind it back after a throw. */
    this.resetSeconds = opts.resetSeconds ?? 1.3;
    /** How many elements go in one throw. */
    this.batch = Math.max(1, opts.batch ?? 1);

    /** Where an element leaves the ROBOT, relative to its centre. */
    this.exitHeight = opts.exitHeight ?? 12 * INCH;
    this.exitOffset = opts.exitOffset ?? 7 * INCH;

    /** Throw-to-throw repeatability. */
    this.angleScatter = opts.angleScatter ?? 0;
    this.energyScatter = opts.energyScatter ?? 0;
    this.random = opts.random ?? Math.random;

    this.motor = opts.motor ?? new DcMotor(MOTOR_PRESETS.gobilda5203);
    this.motorCount = opts.motorCount ?? 1;

    /** Seconds of winding still to do. Zero means loaded. */
    this.resetRemaining = 0;
    this.current = 0;
    this.shots = 0;
    this.lastExitSpeed = 0;
    this._fireRequested = false;

    /** Set by the app: where launched balls go. */
    this.ballWorld = null;
    /** Set by the app: the intake that feeds this. */
    this.intake = null;
  }

  /** Nothing to spin up, so the HUD should not ask anyone to. */
  get needsSpinUp() {
    return false;
  }

  /**
   * A thrower is either loaded or winding; there is no partial state to run in.
   * Kept so it can stand in for a `Launcher` everywhere.
   */
  get spinning() {
    return true;
  }

  set spinning(_value) {
    // Deliberately ignored: an elastic is not a wheel you leave running.
  }

  /** True when the elastic is wound and there is something to throw. */
  get ready() {
    return this.resetRemaining <= 0;
  }

  /** Fraction of the way back to loaded, for a HUD bar. */
  get recovery() {
    if (this.resetSeconds <= 0) return 1;
    return clamp(1 - this.resetRemaining / this.resetSeconds, 0, 1);
  }

  /**
   * Energy actually available right now: the full draw when loaded, less while
   * the motor is still winding it back.
   */
  get drawnEnergy() {
    return this.energy * this.recovery;
  }

  /** Exit speed for an element of `mass`, m/s. */
  exitSpeedFor(mass = POLLEN_MASS, energy = this.energy) {
    return Math.sqrt((2 * this.efficiency * energy) / Math.max(1e-6, mass));
  }

  get exitSpeed() {
    return this.exitSpeedFor(POLLEN_MASS);
  }

  /** Same name as the flywheel's, so shared code can read either. */
  get hoodAngle() {
    return this.releaseAngle;
  }

  setHoodAngle(radians) {
    this.releaseAngle = clamp(radians, this.minAngle, this.maxAngle);
    return this.releaseAngle;
  }

  /**
   * There is no speed to dial in, so the flywheel's RPM controls do nothing.
   * Reported as 0 rather than omitted, so a HUD built for a flywheel still
   * renders instead of showing NaN.
   */
  get rpm() {
    return 0;
  }

  get targetRpm() {
    return 0;
  }

  setTargetRpm() {
    return 0;
  }

  /**
   * @param {number} dt
   * @param {import('../../input/FtcGamepad.js').FtcGamepad} gamepad
   */
  updateControl(dt, gamepad) {
    if (!gamepad) return;
    if (gamepad.right_trigger > 0.5) this._fireRequested = true;
    // Only the angle matters, so both d-pad axes trim it -- coarse on
    // up/down, fine on left/right, which is how you actually dial a catapult.
    if (gamepad.dpad_up) this.setHoodAngle(this.releaseAngle + 0.5 * dt);
    if (gamepad.dpad_down) this.setHoodAngle(this.releaseAngle - 0.5 * dt);
    if (gamepad.dpad_right) this.setHoodAngle(this.releaseAngle + 0.12 * dt);
    if (gamepad.dpad_left) this.setHoodAngle(this.releaseAngle - 0.12 * dt);
  }

  fire() {
    this._fireRequested = true;
  }

  /**
   * Wind the elastic and throw if asked.
   * @param {number} dt
   * @param {number} busVoltage
   */
  applyForces(dt, busVoltage) {
    if (this.resetRemaining > 0) {
      this.resetRemaining = Math.max(0, this.resetRemaining - dt);
      // Winding is the only time it draws anything, and it draws hard: the
      // motor is working against the elastic the whole way back.
      // `stallCurrent` is the spec figure at nominal volts; the bus is usually
      // under that, and winding is a partial load rather than a stall.
      const stall = this.motor.stallCurrent * (busVoltage / this.motor.nominalVoltage);
      this.current = stall * 0.35 * this.motorCount;
    } else {
      this.current = 0;
    }

    if (this._fireRequested) {
      this._fireRequested = false;
      this._tryThrow();
    }
    return this.current;
  }

  /**
   * Throw, with whatever is wound.
   *
   * Not gated on `ready` either, and for the same reason as the flywheel: the
   * release is a latch, and pulling it mid-wind lets go of a partly drawn
   * elastic. That is the honest behaviour and it is more instructive than a
   * refusal -- an early release dribbles the element out at
   * `sqrt(draw)` of the speed, which for a quarter-wound catapult is half
   * range, and you can see exactly where it landed.
   */
  _tryThrow() {
    if (!this.robot) return null;
    const thrown = [];
    for (let i = 0; i < this.batch; i++) {
      const ball = this.intake?.take();
      if (!ball) break;
      thrown.push(ball);
    }
    if (thrown.length === 0) return null;
    return this.launch(thrown);
  }

  /**
   * Throw one element, or a batch of them.
   *
   * A batch shares the stored energy, so throwing three at once sends each of
   * them at `1/sqrt(3)` of the speed -- which is why a catapult that lobs a
   * handful is a short-range mechanism whatever its elastic. They also leave
   * slightly apart, because they cannot occupy the same point, and that spread
   * is the reason a batch fills a CELL or misses it wholesale.
   *
   * @param {import('../../physics/Ball.js').Ball|import('../../physics/Ball.js').Ball[]} balls
   */
  launch(balls) {
    const group = Array.isArray(balls) ? balls : [balls];
    if (group.length === 0) return null;
    const { x, y, cos, sin, vx, vy } = this.pose;

    // Only what is actually drawn. `recovery` is the fraction of the wind
    // completed, and the elastic's stored energy goes in with it, so a throw
    // taken half-wound has half the joules and comes out at 1/sqrt(2) of the
    // speed.
    const drawn = this.energy * this.recovery;
    const energy = drawn * (1 + this.energyScatter * this._jitter());
    const angle = clamp(
      this.releaseAngle + this.angleScatter * this._jitter(),
      this.minAngle,
      this.maxAngle,
    );
    const share = energy / group.length;

    let first = null;
    group.forEach((ball, i) => {
      const speed = this.exitSpeedFor(ball.mass, share);
      const horizontal = speed * Math.cos(angle);
      const vertical = speed * Math.sin(angle);
      // Fan a batch across the throw rather than stacking it on one line.
      const spread = group.length > 1 ? (i - (group.length - 1) / 2) * 0.06 : 0;
      const c = Math.cos(spread);
      const s = Math.sin(spread);
      const dirX = cos * c - sin * s;
      const dirY = cos * s + sin * c;
      ball.release(vx + dirX * horizontal, vy + dirY * horizontal, vertical);
      ball.setPosition(
        x + dirX * this.exitOffset,
        y + dirY * this.exitOffset,
        this.exitHeight,
      );
      if (i === 0) {
        this.lastExitSpeed = speed;
        first = ball;
      }
    });

    this.shots += 1;
    // Released, so the wind starts again from nothing however far it had got.
    this.resetRemaining = this.resetSeconds;
    if (this.ballWorld) this.ballWorld.settled = false;
    return first;
  }

  /**
   * The release angle that drops an element on a target, or null if it cannot
   * be reached.
   *
   * With the speed fixed there is no RPM to solve for, so this solves the angle
   * instead. For range `R` and rise `h` at speed `v`:
   *
   *     tan(t) = (v^2 +/- sqrt(v^4 - g*(g*R^2 + 2*h*v^2))) / (g*R)
   *
   * The discriminant going negative *is* the mechanism's maximum range, which
   * is the constraint a flywheel does not have. Of the two roots only the
   * larger -- the lofted one -- arrives descending, and a CELL only accepts a
   * descending element, so that is the one taken.
   *
   * @param {{x:number,y:number,z:number}} target
   * @param {number} [mass]
   * @param {{x:number,y:number}|null} [origin] evaluate from somewhere other
   *   than where the ROBOT is standing, so the AI can pick a place to stand
   * @returns {{range:number, rise:number, speed:number, angle:number, rpm:number,
   *            descending:boolean, apexRange:number}|null}
   */
  solutionFor(target, mass = POLLEN_MASS, origin = null) {
    if (!origin && !this.robot) return null;
    const { x, y } = origin ?? this.pose;
    return this._solve(target, mass, x, y);
  }

  /** Radius of an element of this mass, for the drag model. */
  elementRadius(mass = POLLEN_MASS) {
    return mass > (POLLEN_MASS + 0.085) / 2 ? 1.81 * INCH : POLLEN_RADIUS;
  }

  _solve(target, mass, x, y) {
    const range = Math.max(
      0.01,
      Math.hypot(target.x - x, target.y - y) - this.exitOffset,
    );
    const rise = target.z - this.exitHeight;
    // Per *element*, not per throw. A batch shares the stored energy, so a
    // three-ball lobber's elements leave at 1/sqrt(3) of what one would -- and
    // solving the angle from the full energy had it aiming for a range it
    // could not reach and then declining every shot on the field.
    //
    // A *full* draw, deliberately: this is what to dial in, not a running
    // commentary on a half-wound elastic. `trajectory` uses the drawn energy,
    // so the guide still shows where an early release would actually land.
    const speed = this.exitSpeedFor(mass, this.energy / this.batch);
    const radius = this.elementRadius(mass);

    // The speed is fixed, so this solves the *angle* -- and with drag in the
    // way there is no closed form for it either. A sweep from the top of the
    // elevation range downward, taking the first angle that clears the target:
    // that is the lofted root, which is the one that arrives descending, and a
    // CELL takes nothing else. Running out of angles without clearing it *is*
    // the mechanism's maximum range, which is the constraint a flywheel does
    // not have.
    const steps = 48;
    let best = null;
    for (let i = 0; i <= steps; i++) {
      const angle = this.maxAngle - ((this.maxAngle - this.minAngle) * i) / steps;
      const arc = integrateArc(
        {
          x: 0,
          y: 0,
          z: 0,
          vx: speed * Math.cos(angle),
          vy: 0,
          vz: speed * Math.sin(angle),
          mass,
          radius,
        },
        { floor: rise - 6 - radius, maxTime: 6 },
      );
      const height = heightAtRange(arc, range);
      if (height === null || height < rise) continue;
      const apexRange = Math.hypot(arc.apex.x, arc.apex.y);
      best = { angle, arc, apexRange };
      break;
    }
    if (!best) return null;

    return {
      range,
      rise,
      speed,
      angle: best.angle,
      rpm: 0,
      descending: best.apexRange < range,
      apexRange: best.apexRange,
    };
  }

  /**
   * The angle to throw at, if the target can be reached at all. Same shape as
   * `Launcher.aimFor` so the AI and the aiming guide can use either mechanism.
   */
  aimFor(target, mass = POLLEN_MASS, origin = null) {
    const solution = this.solutionFor(target, mass, origin);
    return solution && solution.descending ? solution : null;
  }

  /**
   * Whether a throw at `target` is worth walking to a spot for, drag-free.
   *
   * The cheap screen for the AI's position search; `aimFor` does the real
   * angle sweep once, at the spot it chose. Optimistic, which is the safe
   * direction: it never rules out a throw that is actually possible.
   */
  couldReach(target, mass = POLLEN_MASS, origin = null) {
    if (!origin && !this.robot) return false;
    const { x, y } = origin ?? this.pose;
    const range = Math.max(
      0.01,
      Math.hypot(target.x - x, target.y - y) - this.exitOffset,
    );
    const rise = target.z - this.exitHeight;
    const speed = this.exitSpeedFor(mass, this.energy / this.batch);
    const v2 = speed * speed;
    const disc = v2 * v2 - G * (G * range * range + 2 * rise * v2);
    if (disc < 0) return false;
    const angle = Math.atan((v2 + Math.sqrt(disc)) / (G * range));
    return angle >= this.minAngle && angle <= this.maxAngle;
  }

  aimAt(target, mass = POLLEN_MASS) {
    const solution = this.aimFor(target, mass);
    if (!solution) return false;
    this.setHoodAngle(solution.angle);
    return true;
  }

  /**
   * The arc a throw would fly. Matches `Launcher.trajectory`, so the aiming
   * guide draws a catapult's shot the same way it draws a flywheel's.
   * @param {{mass?: number, speed?: number, angle?: number, samples?: number,
   *          floor?: number}} [opts]
   */
  trajectory(opts = {}) {
    if (!this.robot) return null;
    const mass = opts.mass ?? POLLEN_MASS;
    const angle = opts.angle ?? this.releaseAngle;
    const speed = opts.speed ?? this.exitSpeedFor(mass, this.drawnEnergy / this.batch);
    const samples = Math.max(2, opts.samples ?? 48);
    const floor = opts.floor ?? 0;

    const { x, y, cos, sin, vx, vy } = this.pose;
    const ox = x + cos * this.exitOffset;
    const oy = y + sin * this.exitOffset;
    const oz = this.exitHeight;
    const horizontal = speed * Math.cos(angle);
    const vx0 = vx + cos * horizontal;
    const vy0 = vy + sin * horizontal;
    const vz0 = speed * Math.sin(angle);

    // Same integration the ball world runs, so the guide shows the real throw
    // -- including a half-wound one, which comes out at sqrt(draw) of the
    // speed and visibly falls short.
    const radius = this.elementRadius(mass);
    const arc = integrateArc(
      { x: ox, y: oy, z: oz, vx: vx0, vy: vy0, vz: vz0, mass, radius },
      { step: opts.step ?? 1 / 480, floor, maxTime: 6 },
    );
    const at = (t) => sampleArc(arc, t);
    const points = [];
    for (let i = 0; i <= samples; i++) points.push(at((arc.flightTime * i) / samples));

    return {
      points,
      at,
      flightTime: arc.flightTime,
      speed,
      angle,
      apex: arc.apex,
      origin: { x: ox, y: oy, z: oz },
    };
  }

  _jitter() {
    return this.random() + this.random() - 1;
  }

  massContribution() {
    return null;
  }

  telemetry() {
    return {
      Thrower: this.kind,
      'Thrower state': this.ready ? 'loaded' : `winding ${(this.recovery * 100).toFixed(0)}%`,
      'Release angle': `${((this.releaseAngle * 180) / Math.PI).toFixed(1)} deg`,
      'Exit speed': `${this.exitSpeed.toFixed(2)} m/s`,
      'Thrower current': `${this.current.toFixed(1)} A`,
      Shots: this.shots,
    };
  }

  reset() {
    this.resetRemaining = 0;
    this.current = 0;
    this.shots = 0;
    this.lastExitSpeed = 0;
    this._fireRequested = false;
  }
}
