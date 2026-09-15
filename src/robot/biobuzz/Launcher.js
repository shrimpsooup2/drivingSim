import { Subsystem } from '../Subsystem.js';
import { DcMotor } from '../../hardware/DcMotor.js';
import { PIDF } from '../../math/PIDF.js';
import { MOTOR_PRESETS } from '../../config/presets/motors.js';
import { INCH, clamp } from '../../math/MathUtil.js';
import { POLLEN_MASS, POLLEN_RADIUS } from '../../field/biobuzz/constants.js';
import {
  freeFlightSolution,
  integrateArc,
  sampleArc,
  solveSpeedForTarget,
} from '../../physics/ballistics.js';

/** Gravity, for the ballistics helper. */
const G = 9.80665;

/**
 * A flywheel LAUNCHER for putting POLLEN and NECTAR into a CELL.
 *
 * ## Why the flywheel is modelled properly
 *
 * The thing that actually limits a shooter is not top speed, it is **recovery**.
 * Every ball that goes through takes angular momentum out of the wheel, the
 * exit velocity of the next shot drops with it, and the motor needs time to
 * put it back. A driver who fires as fast as the intake can feed will throw
 * the second and third shots short. Learning to wait for the wheel is most of
 * the skill in a shooter, so the simulator has to make you wait.
 *
 * The transfer is modelled as angular momentum going into the ball:
 *
 *     J*w0 = J*w1 + m*v*R        and       v = k*w1*R
 *
 * which solves to `w1 = J*w0 / (J + k*m*R^2)`. With a typical 4 in wheel and
 * 8.3e-4 kg*m^2 of inertia that is about a 6% drop for a POLLEN and 11% for a
 * NECTAR -- so NECTAR costs nearly twice the recovery time, which is worth
 * knowing when the last 60 seconds open up and you have five of them to enter.
 *
 * `k` is the fraction of surface speed the ball leaves at. A single flywheel
 * against a fixed backplate spends part of the contact spinning the ball up,
 * so a real one lands near 0.5; a two-wheel shooter gets closer to 1.
 */
export class Launcher extends Subsystem {
  /**
   * @param {{
   *   name?: string,
   *   motor?: DcMotor,
   *   motorCount?: number,
   *   gearRatio?: number,
   *   wheelRadius?: number,
   *   inertia?: number,
   *   transferEfficiency?: number,
   *   hoodAngle?: number,
   *   minHoodAngle?: number,
   *   maxHoodAngle?: number,
   *   exitHeight?: number,
   *   exitOffset?: number,
   *   targetRpm?: number,
   *   maxRpm?: number,
   *   readyTolerance?: number,
   *   feedInterval?: number,
   *   drag?: number,
   *   hoodScatter?: number,
   *   rpmScatter?: number,
   *   random?: () => number,
   *   kind?: string,
   * }} [opts]
   */
  constructor(opts = {}) {
    super({ name: opts.name ?? 'launcher' });

    /**
     * Which launch system this is, for the UI. A single flywheel runs a ball
     * against a fixed backplate and spends part of the contact spinning it up,
     * so only about half the surface speed reaches it; a pair of counter-
     * rotating wheels grips it from both sides and gets most of the way. That
     * is the `transferEfficiency` difference, and it is the whole reason a
     * two-wheel shooter needs less RPM for the same range.
     */
    this.kind = opts.kind ?? 'flywheel';

    this.motor = opts.motor ?? new DcMotor(MOTOR_PRESETS.gobilda5203);
    /** Two motors on one shaft is the usual answer to recovery time. */
    this.motorCount = opts.motorCount ?? 1;
    /** Above 1 the wheel spins faster than the motor. */
    this.gearRatio = opts.gearRatio ?? 1;
    this.wheelRadius = opts.wheelRadius ?? 2 * INCH;
    /** Flywheel inertia about its own axis, kg*m^2. */
    this.inertia = opts.inertia ?? 8.3e-4;
    /** Fraction of surface speed a ball leaves at. */
    this.transferEfficiency = opts.transferEfficiency ?? 0.5;
    /**
     * Viscous drag on the wheel, N*m per rad/s.
     *
     * Bearings, windage and hysteresis in the compliant tread, lumped
     * together. Calibrated against current draw, which is the number a team
     * can actually read off their Driver Station: 8e-5 puts a single bare 5202
     * at about 1.5 A holding 2400 rpm, which is what a real flywheel idles at.
     * It used to be 2.5e-5, which drew 0.13 A -- an essentially frictionless
     * wheel, and the reason recovery between shots cost nothing.
     */
    this.drag = opts.drag ?? 8e-5;

    this.minHoodAngle = opts.minHoodAngle ?? (20 * Math.PI) / 180;
    this.maxHoodAngle = opts.maxHoodAngle ?? (70 * Math.PI) / 180;
    this.hoodAngle = clamp(
      opts.hoodAngle ?? (45 * Math.PI) / 180,
      this.minHoodAngle,
      this.maxHoodAngle,
    );

    /** Where a ball leaves the robot, relative to its centre. */
    this.exitHeight = opts.exitHeight ?? 10 * INCH;
    this.exitOffset = opts.exitOffset ?? 6 * INCH;

    this.maxRpm = opts.maxRpm ?? 4000;
    this.targetRpm = opts.targetRpm ?? 2400;
    /** How close to target the wheel must be before a shot is allowed. */
    this.readyTolerance = opts.readyTolerance ?? 0.97;
    /** Minimum time between shots, set by the feeder rather than the wheel. */
    this.feedInterval = opts.feedInterval ?? 0.35;

    /**
     * Shot-to-shot repeatability, as the spread on the hood angle (radians) and
     * on the effective wheel speed (fraction).
     *
     * Zero by default, so the player's shooter does exactly what it is told and
     * a missed shot is theirs. It is the one number that separates a rough
     * build from a good one more than anything else, so the AI robots carry a
     * real value here -- an opponent that never misses because its hardware is
     * perfect is not an opponent you learn anything from.
     */
    this.hoodScatter = opts.hoodScatter ?? 0;
    this.rpmScatter = opts.rpmScatter ?? 0;
    /** Injectable so a seeded test gets the same spread every run. */
    this.random = opts.random ?? Math.random;

    this.controller = new PIDF();
    this.retune();

    /** Wheel speed, rad/s. */
    this.omega = 0;
    this.spinning = false;
    this.current = 0;
    this.shots = 0;
    /** Exit speed of the most recent shot, m/s. Useful telemetry. */
    this.lastExitSpeed = 0;
    this._feedTimer = 0;
    this._fireRequested = false;

    /** Set by the app: where launched balls go. */
    this.ballWorld = null;
    /** Set by the app: the intake that feeds this. */
    this.intake = null;
  }

  /**
   * Everything the motor has to accelerate, referred to the wheel's own axis.
   *
   * The rotors count. Reflected through the ratio they scale as `1/ratio^2`,
   * so on a direct drive a pair of 5202 rotors adds 1.4e-5 against a wheel's
   * 8.3e-4 -- under two percent, and worth including because it is free and
   * because a geared-*down* shooter reverses the comparison entirely.
   */
  get effectiveInertia() {
    const rotor = (this.motor.rotorInertia ?? 0) * this.motorCount;
    return this.inertia + rotor / (this.gearRatio * this.gearRatio);
  }

  /** Free speed of the wheel itself at a given bus voltage, rad/s. */
  freeWheelSpeed(busVoltage = 12) {
    return this.motor.freeSpeedAt(busVoltage) * this.gearRatio;
  }

  /**
   * Duty cycle that would hold the wheel at `omega` in steady state.
   *
   * Solved from the motor curve against the wheel's own drag rather than taken
   * as `omega / freeSpeed`, which ignores drag and lands about 10 percent low.
   * That matters: a feedforward that is 10 percent short leaves the integrator
   * to make up the difference, and an integrator doing the bulk of the work is
   * exactly what makes a shooter take five seconds to spin up and then
   * overshoot.
   */
  dutyForSteadySpeed(omega, busVoltage = 12) {
    const { kV, kT, resistance } = this.motor;
    const drive = this.gearRatio * this.motorCount;
    // kT/R * (V - omega/(ratio*kV)) * ratio * count = drag * omega
    const volts =
      omega / (this.gearRatio * kV) + (this.drag * omega * resistance) / (kT * drive);
    return volts / busVoltage;
  }

  /**
   * Recompute the velocity loop from the current mechanism. Call after changing
   * the motor, gearing, wheel or drag.
   */
  retune() {
    // Feedforward carries the steady state; the loop only trims the remainder,
    // and only once it is close (iZone), so it cannot wind up during spin-up.
    const kF = this.dutyForSteadySpeed(1, 12);
    this.controller.setGains({
      kF,
      kP: 1 / 60,
      kI: 1 / 30,
      kD: 0,
      iZone: 60,
      maxIntegral: 15,
      outputMin: 0,
      outputMax: 1,
    });
    return this;
  }

  get rpm() {
    return (this.omega * 60) / (2 * Math.PI);
  }

  /** Surface speed of the wheel, m/s. */
  get surfaceSpeed() {
    return this.omega * this.wheelRadius;
  }

  /**
   * Speed an infinitely light ball would leave at: the wheel surface speed
   * times the transfer efficiency, with nothing taken back out of the wheel.
   */
  get idealExitSpeed() {
    return this.transferEfficiency * this.surfaceSpeed;
  }

  /**
   * How much of the wheel's speed survives putting a ball of `mass` through it.
   *
   * The ball carries angular momentum away as it goes, so it leaves at the
   * *post*-transfer surface speed, not the speed the wheel was doing when it
   * arrived. Ignoring this is a quiet way to shoot short: a POLLEN comes out
   * about 6 percent slow and range goes as the square of speed, so the shot
   * lands 13 percent short -- about six inches at CELL range.
   */
  droopFactor(mass) {
    const R = this.wheelRadius;
    const J = this.effectiveInertia;
    return J / (J + this.transferEfficiency * mass * R * R);
  }

  /** Exit speed a ball of `mass` would actually leave at right now, m/s. */
  exitSpeedFor(mass = POLLEN_MASS) {
    return this.idealExitSpeed * this.droopFactor(mass);
  }

  /** Exit speed for a POLLEN, the common case. */
  get exitSpeed() {
    return this.exitSpeedFor(POLLEN_MASS);
  }

  /** A flywheel has to be brought up to speed before it will do anything. */
  get needsSpinUp() {
    return true;
  }

  /** True when the wheel is close enough to target to shoot. */
  get ready() {
    return this.spinning && this.rpm >= this.targetRpm * this.readyTolerance;
  }

  /** Fraction of the way back to target, for a HUD bar. */
  get recovery() {
    if (this.targetRpm <= 0) return 1;
    return clamp(this.rpm / this.targetRpm, 0, 1);
  }

  /**
   * @param {number} dt
   * @param {import('../../input/FtcGamepad.js').FtcGamepad} gamepad
   */
  updateControl(dt, gamepad) {
    if (!gamepad) return;
    if (gamepad.pressed?.y) this.spinning = !this.spinning;
    if (gamepad.right_trigger > 0.5) this._fireRequested = true;

    // The hood and the target are both on the d-pad, because on a real robot
    // they are the two things a driver trims between shots.
    if (gamepad.dpad_up) this.setHoodAngle(this.hoodAngle + 0.5 * dt);
    if (gamepad.dpad_down) this.setHoodAngle(this.hoodAngle - 0.5 * dt);
    if (gamepad.dpad_right) this.setTargetRpm(this.targetRpm + 600 * dt);
    if (gamepad.dpad_left) this.setTargetRpm(this.targetRpm - 600 * dt);
  }

  setHoodAngle(radians) {
    this.hoodAngle = clamp(radians, this.minHoodAngle, this.maxHoodAngle);
    return this.hoodAngle;
  }

  setTargetRpm(rpm) {
    this.targetRpm = clamp(rpm, 0, this.maxRpm);
    return this.targetRpm;
  }

  /** Ask for a shot. It fires when the wheel is ready and the feeder is free. */
  fire() {
    this._fireRequested = true;
  }

  /**
   * Spin the wheel and fire if asked.
   * @param {number} dt
   * @param {number} busVoltage
   */
  applyForces(dt, busVoltage) {
    const target = this.spinning ? (this.targetRpm * 2 * Math.PI) / 60 : 0;
    let duty = 0;
    if (this.spinning) {
      // The controller clamps and unwinds its own integral, so no clamp here.
      duty = this.controller.calculate(target, this.omega, dt);
    } else {
      this.controller.reset();
    }

    // The motor sees the wheel through the ratio: it spins slower by 1/ratio
    // and its torque is multiplied by the ratio on the way back.
    const motorOmega = this.omega / this.gearRatio;
    const result = this.motor.evaluate(busVoltage * duty, motorOmega);
    const torque = result.torque * this.gearRatio * this.motorCount;
    this.current = Math.abs(duty * result.current) * this.motorCount;

    // Semi-implicit, so a stiff drag term cannot make the wheel ring.
    const J = this.effectiveInertia;
    this.omega = (this.omega + (dt * torque) / J) / (1 + (dt * this.drag) / J);
    if (this.omega < 0) this.omega = 0;

    this._feedTimer = Math.max(0, this._feedTimer - dt);
    if (this._fireRequested) {
      this._fireRequested = false;
      this._tryShoot();
    }
    return this.current;
  }

  /**
   * Fire, whatever the wheel is doing.
   *
   * Deliberately *not* gated on `ready`. A real robot has no idea whether its
   * flywheel is up to speed -- it fires when the trigger is pulled and the
   * ball goes wherever the wheel's current surface speed sends it. Refusing
   * the shot made the whole recovery model invisible: you could not throw one
   * short, so there was nothing to learn from the bar, and "wait for the
   * wheel" was enforced rather than taught.
   *
   * The two things still in the way are mechanical, not rules: the feeder
   * cannot cycle faster than `feedInterval`, and there has to be something in
   * the magazine.
   */
  _tryShoot() {
    if (this._feedTimer > 0 || !this.robot) return null;
    const ball = this.intake?.take();
    if (!ball) return null;
    return this.launch(ball);
  }

  /**
   * Put a ball through the wheel. Takes the angular momentum out of the wheel,
   * so the next shot is slower until the motor catches up.
   * @param {import('../../physics/Ball.js').Ball} ball
   */
  launch(ball) {
    const { x, y, cos, sin, vx, vy } = this.pose;
    const k = this.transferEfficiency;
    const R = this.wheelRadius;

    const J = this.effectiveInertia;
    const after = (J * this.omega) / (J + k * ball.mass * R * R);
    // The wheel loses exactly the angular momentum the ball carries away; the
    // scatter is on what comes *out*, not on the mechanism's book-keeping, so
    // a sloppy shooter still conserves momentum.
    this.omega = after;
    const speed = k * after * R * (1 + this.rpmScatter * this._jitter());
    const angle = clamp(
      this.hoodAngle + this.hoodScatter * this._jitter(),
      this.minHoodAngle,
      this.maxHoodAngle,
    );
    this.lastExitSpeed = speed;
    this.lastHoodAngle = angle;
    this.shots += 1;
    this._feedTimer = this.feedInterval;

    const horizontal = speed * Math.cos(angle);
    const vertical = speed * Math.sin(angle);

    ball.release(
      // A shot taken on the move inherits the robot's velocity, which is what
      // makes shooting while driving hard and shooting while stopped easy.
      vx + cos * horizontal,
      vy + sin * horizontal,
      vertical,
    );
    ball.setPosition(
      x + cos * this.exitOffset,
      y + sin * this.exitOffset,
      this.exitHeight,
    );
    if (this.ballWorld) this.ballWorld.settled = false;
    return ball;
  }

  /**
   * Exit speed needed to drop a ball onto a target, ignoring air resistance.
   *
   * Used by the AI and by the HUD's aiming hint. Returns null when the shot is
   * impossible at the current hood angle -- too flat to clear the height, or
   * the target is behind the apex.
   *
   * @param {number} range horizontal distance, m
   * @param {number} rise target height above the exit point, m
   * @param {number} [angle] hood angle, radians
   */
  speedForTarget(range, rise, angle = this.hoodAngle, mass = POLLEN_MASS) {
    const solution = solveSpeedForTarget({
      range,
      rise,
      angle,
      mass,
      radius: this.elementRadius(mass),
      maxSpeed: this.exitSpeedAt(this.maxRpm, mass),
    });
    return solution ? solution.speed : null;
  }

  /**
   * Radius of an element of this mass, for the drag model.
   *
   * Derived from the mass rather than passed in, because every caller already
   * knows the mass and nobody wants to thread a radius through the aiming
   * maths as well. The two elements are far enough apart (45 g at 1.4 in,
   * 85 g at 1.81 in) that picking by mass is unambiguous.
   */
  elementRadius(mass = POLLEN_MASS) {
    return mass > (POLLEN_MASS + 0.085) / 2 ? 1.81 * INCH : POLLEN_RADIUS;
  }

  /** Exit speed a given wheel RPM would produce for an element of `mass`. */
  exitSpeedAt(rpm, mass = POLLEN_MASS) {
    const omega = (rpm * 2 * Math.PI) / 60;
    return this.transferEfficiency * omega * this.wheelRadius * this.droopFactor(mass);
  }

  /**
   * Flywheel RPM to spin up to so that a ball of `mass` leaves at `speed`.
   *
   * Divided by the droop factor, because the wheel has to be running fast
   * enough *before* the shot that it is still doing the required speed after
   * the ball has taken its share.
   */
  rpmForExitSpeed(speed, mass = POLLEN_MASS) {
    const omega = speed / (this.transferEfficiency * this.wheelRadius * this.droopFactor(mass));
    return (omega * 60) / (2 * Math.PI);
  }

  /**
   * What to dial in to hit a target from where the robot is standing.
   *
   * `descending` is the part that matters. A CELL faces upward, so a ball has
   * to *drop* into it -- the HIVE refuses anything still climbing through the
   * opening, the same way a real basket would bounce it back out. Whether the
   * ball is falling when it arrives depends only on the hood angle and the
   * shape of the shot:
   *
   *     tan(hood) > 2 * rise / range
   *
   * because the apex has to come before the target. The CELL sits 50.2 in up,
   * so from close in that is a steep number -- from 1.3 m you need better than
   * 57 degrees. Shooting flat from point blank cannot score no matter how the
   * RPM is trimmed, which is worth finding out here rather than in a match.
   *
   * @param {{x:number,y:number,z:number}} target
   * @param {number} [angle] hood angle to evaluate; defaults to the current one
   * @param {number} [mass] mass of the element to be shot; POLLEN by default
   * @param {{x:number,y:number}|null} [origin] evaluate from somewhere other
   *   than where the ROBOT is standing. The AI needs this to choose a place to
   *   stand: "would a shot work from over there" cannot be answered by moving
   *   there and finding out.
   * @returns {{range:number, rise:number, speed:number, rpm:number,
   *            angle:number, descending:boolean, apexRange:number}|null}
   */
  solutionFor(target, angle = this.hoodAngle, mass = POLLEN_MASS, origin = null) {
    if (!origin && !this.robot) return null;
    const { x, y } = origin ?? this.pose;
    const range = Math.max(
      0.01,
      Math.hypot(target.x - x, target.y - y) - this.exitOffset,
    );
    const rise = target.z - this.exitHeight;
    const solved = solveSpeedForTarget({
      range,
      rise,
      angle,
      mass,
      radius: this.elementRadius(mass),
      maxSpeed: this.exitSpeedAt(this.maxRpm, mass),
    });
    if (!solved) return null;

    return {
      range,
      rise,
      speed: solved.speed,
      rpm: this.rpmForExitSpeed(solved.speed, mass),
      angle,
      descending: solved.descending,
      apexRange: solved.apexRange,
    };
  }

  /**
   * Find a hood angle that actually scores: the ball arrives descending and the
   * flywheel can reach the speed it needs.
   *
   * This is the tuning table a team works out on a practice field, done
   * numerically. It sweeps from the shallowest hood upward and takes the first
   * workable angle, because a flatter shot is less sensitive to range error --
   * the same reason a driver would rather shoot flat if the geometry allows it.
   *
   * @param {{x:number,y:number,z:number}} target
   * @returns {ReturnType<Launcher['solutionFor']>|null} null when the shot
   *   cannot be made from here at all.
   */
  aimFor(target, mass = POLLEN_MASS, origin = null) {
    // Two passes, because the real solve is a bisection over a drag
    // integration and sixty of them per call is not affordable -- the AI runs
    // this several times a second for every ROBOT on the FIELD.
    //
    // First a drag-free sweep, which is closed form and effectively free, to
    // find the shallowest angle that could work at all. Then the real solve at
    // that angle and a few steeper ones, because drag needs more speed than
    // the free flight and the shallow end is where that runs out of RPM.
    const steps = 60;
    const span = this.maxHoodAngle - this.minHoodAngle;
    let guess = -1;
    for (let i = 0; i <= steps; i++) {
      const angle = this.minHoodAngle + (span * i) / steps;
      const free = this.freeSolutionFor(target, angle, mass, origin);
      if (free && free.descending && free.rpm <= this.maxRpm) {
        guess = i;
        break;
      }
    }
    if (guess < 0) return null;

    for (let i = guess; i <= Math.min(steps, guess + 12); i += 3) {
      const angle = this.minHoodAngle + (span * i) / steps;
      const solution = this.solutionFor(target, angle, mass, origin);
      if (solution && solution.descending && solution.rpm <= this.maxRpm) return solution;
    }
    return null;
  }

  /**
   * The drag-free version of `solutionFor`: same shape, no integration.
   *
   * For screening only -- choosing somewhere to stand means testing hundreds
   * of candidate positions, and paying for a drag integration on each costs
   * thousands of times more than deciding which one to drive to. It is
   * optimistic by about a tenth in speed, which is the safe direction for a
   * screen: it never rules out a shot that is actually possible.
   */
  freeSolutionFor(target, angle = this.hoodAngle, mass = POLLEN_MASS, origin = null) {
    if (!origin && !this.robot) return null;
    const { x, y } = origin ?? this.pose;
    const range = Math.max(
      0.01,
      Math.hypot(target.x - x, target.y - y) - this.exitOffset,
    );
    const rise = target.z - this.exitHeight;
    const free = freeFlightSolution(range, rise, angle);
    if (!free) return null;
    return {
      range,
      rise,
      speed: free.speed,
      rpm: this.rpmForExitSpeed(free.speed, mass),
      angle,
      descending: free.descending,
      apexRange: free.apexRange,
    };
  }

  /**
   * Whether a shot at `target` is worth walking to a spot for, drag-free.
   *
   * The screen the AI's position search uses. `aimFor` then does the real
   * solve, once, at the spot it chose.
   */
  couldReach(target, mass = POLLEN_MASS, origin = null) {
    const steps = 20;
    const span = this.maxHoodAngle - this.minHoodAngle;
    for (let i = 0; i <= steps; i++) {
      const free = this.freeSolutionFor(
        target,
        this.minHoodAngle + (span * i) / steps,
        mass,
        origin,
      );
      if (free && free.descending && free.rpm <= this.maxRpm) return true;
    }
    return false;
  }

  /**
   * Point the hood and set the target RPM to hit `target`, if it can be hit.
   * @returns {boolean} whether a workable shot was found and dialled in.
   */
  aimAt(target, mass = POLLEN_MASS) {
    const solution = this.aimFor(target, mass);
    if (!solution) return false;
    this.setHoodAngle(solution.angle);
    this.setTargetRpm(solution.rpm);
    return true;
  }

  /**
   * The arc a shot would actually fly from where the ROBOT is standing.
   *
   * The ball world integrates flight under gravity alone -- a wiffle ball over
   * three metres loses little enough to drag that modelling it would be a
   * guess dressed as a number -- so the arc is an exact parabola and this
   * closed form *is* the trajectory, not an approximation of it. Which is the
   * point: a guide that disagrees with the physics teaches the wrong aim.
   *
   * Two things make it worth drawing rather than computing in your head. The
   * launch velocity includes the ROBOT's own, so the arc visibly swings when
   * you shoot on the move. And the speed is the post-droop exit speed at the
   * *current* wheel RPM, so firing before the wheel has recovered shows the
   * arc falling short instead of merely a number being low.
   *
   * @param {{
   *   mass?: number,
   *   speed?: number,
   *   angle?: number,
   *   samples?: number,
   *   floor?: number,
   *   step?: number,
   * }} [opts]
   * @returns {{
   *   points: {x:number,y:number,z:number}[],
   *   at: (t:number) => {x:number,y:number,z:number},
   *   flightTime: number, speed: number, angle: number,
   *   apex: {x:number,y:number,z:number,t:number},
   *   origin: {x:number,y:number,z:number},
   * }|null}
   */
  trajectory(opts = {}) {
    if (!this.robot) return null;
    const mass = opts.mass ?? POLLEN_MASS;
    const angle = opts.angle ?? this.hoodAngle;
    const speed = opts.speed ?? this.exitSpeedFor(mass);
    const samples = Math.max(2, opts.samples ?? 48);
    const floor = opts.floor ?? 0;

    const { x, y, cos, sin, vx, vy } = this.pose;
    // Exactly the launch state `launch()` produces, so the guide and the shot
    // cannot disagree.
    const ox = x + cos * this.exitOffset;
    const oy = y + sin * this.exitOffset;
    const oz = this.exitHeight;
    const horizontal = speed * Math.cos(angle);
    const vx0 = vx + cos * horizontal;
    const vy0 = vy + sin * horizontal;
    const vz0 = speed * Math.sin(angle);

    // Integrated, not solved: with drag there is no closed form, and this uses
    // the same gravity-then-drag-then-position sequence `BallWorld` does, at
    // the same step. So the guide is not an approximation of the shot, it is
    // the shot.
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

  /**
   * Symmetric jitter in [-1, 1], triangular rather than flat.
   *
   * Two uniforms summed: a real shooter's error clusters near nominal and
   * occasionally throws a wide one, which a flat distribution does not do.
   */
  _jitter() {
    return this.random() + this.random() - 1;
  }

  massContribution() {
    return null;
  }

  telemetry() {
    return {
      'Shooter RPM': `${Math.round(this.rpm)} / ${Math.round(this.targetRpm)}`,
      'Shooter ready': this.ready ? 'yes' : this.spinning ? 'spinning up' : 'off',
      'Hood angle': `${((this.hoodAngle * 180) / Math.PI).toFixed(1)} deg`,
      'Exit speed': `${this.exitSpeed.toFixed(2)} m/s`,
      'Shooter current': `${this.current.toFixed(1)} A`,
      Shots: this.shots,
    };
  }

  reset() {
    this.omega = 0;
    this.spinning = false;
    this.current = 0;
    this.shots = 0;
    this.lastExitSpeed = 0;
    this._feedTimer = 0;
    this._fireRequested = false;
    this.controller.reset();
  }
}
