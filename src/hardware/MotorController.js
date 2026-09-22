import { clamp } from '../math/MathUtil.js';
import { PIDF } from '../math/PIDF.js';
import { HubPidf, hubDefaultGains } from './HubPidf.js';

/** @typedef {'RUN_WITHOUT_ENCODER'|'RUN_USING_ENCODER'|'RUN_TO_POSITION'} RunMode */
/** @typedef {'BRAKE'|'FLOAT'} ZeroPowerBehavior */

/**
 * The motor controller side of a Control Hub port, following the FTC SDK's
 * DcMotorEx semantics.
 *
 * The run mode matters more to how a robot feels than most teams expect:
 *
 *  - **RUN_WITHOUT_ENCODER** applies the stick value straight through as a duty
 *    cycle. Speed then depends on battery voltage and load, so the robot is
 *    quicker on a fresh pack and noticeably slower when pushed. Most teams
 *    drive this way without realising it, since it is the default.
 *  - **RUN_USING_ENCODER** closes a velocity loop per motor. The robot holds
 *    the commanded speed regardless of voltage or load, which feels more
 *    consistent and tracks straighter, at the cost of some responsiveness and
 *    of hiding a dragging wheel from the driver.
 *
 * ## Two velocity loops
 *
 * `velocityLoop: 'hub'` runs the hub's own arithmetic -- ticks per second in,
 * 16-bit duty out, I and D scaled by a 20 Hz internal rate -- so the F, P and I
 * a team tuned in the SDK mean the same thing here. See `HubPidf`. That is the
 * default, because numbers you cannot port are not much use.
 *
 * `velocityLoop: 'normalised'` runs `math/PIDF.js` against velocity as a
 * fraction of free speed, where kF = 1 means "full duty at full speed". Its
 * gains stay meaningful when the gearing changes, which makes it the better one
 * for experimenting with the *shape* of a loop rather than with a robot's
 * actual numbers.
 */
export class MotorController {
  /**
   * @param {{
   *   mode?: RunMode,
   *   zeroPowerBehavior?: ZeroPowerBehavior,
   *   reversed?: boolean,
   *   currentLimit?: number,
   *   kP?: number, kI?: number, kD?: number, kF?: number,
   *   positionP?: number,
   *   maxDuty?: number,
   *   bus?: import('./HardwareBus.js').HardwareBus|null,
   *   velocityLoop?: 'hub'|'normalised',
   *   hubGains?: {p?: number, i?: number, d?: number, f?: number}|null,
   * }} [opts]
   */
  constructor(opts = {}) {
    /**
     * The hubs. Commands are charged to it, because every one of them is a
     * transaction over RS-485 and that is what sets your loop time.
     * @type {import('./HardwareBus.js').HardwareBus|null}
     */
    this.bus = opts.bus ?? null;
    this.mode = opts.mode ?? 'RUN_WITHOUT_ENCODER';
    this.zeroPowerBehavior = opts.zeroPowerBehavior ?? 'BRAKE';
    this.reversed = opts.reversed ?? false;
    /** Amps per motor. The REV hub's per-port limit is 20 A. */
    this.currentLimit = opts.currentLimit ?? 20;
    this.maxDuty = opts.maxDuty ?? 1;

    this.gains = {
      kP: opts.kP ?? 1.5,
      kI: opts.kI ?? 2.0,
      kD: opts.kD ?? 0.0,
      kF: opts.kF ?? 1.0,
    };
    this.positionP = opts.positionP ?? 5.0;

    this.pid = new PIDF({
      kP: this.gains.kP,
      kI: this.gains.kI,
      kD: this.gains.kD,
      kF: this.gains.kF,
      outputMin: -1,
      outputMax: 1,
      maxIntegral: 1,
      derivativeFilterHz: 30,
    });

    /** @type {'hub'|'normalised'} */
    this.velocityLoop = opts.velocityLoop ?? 'hub';
    /**
     * Coefficients in the hub's units, or null to use the SDK's own defaults
     * derived from the motor's top speed. See `hubDefaultGains`.
     * @type {{p?: number, i?: number, d?: number, f?: number}|null}
     */
    this.hubGains = opts.hubGains ?? null;
    this.hubPid = new HubPidf();
    /**
     * Counts per revolution of the output shaft, so the hub loop can work in
     * ticks per second. Written by `DriveMotor` on every cycle, because the
     * encoder is the thing that knows it and a controller on its own does not.
     */
    this.ticksPerOutputRev = 0;

    /** Commanded power, -1..1, as the op-mode set it. */
    this.power = 0;
    /** Target output-shaft speed, rad/s, when a velocity is commanded directly. */
    this.targetVelocity = 0;
    this.usingDirectVelocity = false;
    /** Target position in radians for RUN_TO_POSITION. */
    this.targetPosition = 0;

    /** Last duty cycle actually applied, -1..1. */
    this.duty = 0;
    /** True when the controller is coasting (open circuit). */
    this.open = false;
  }

  syncGains() {
    this.pid.setGains({
      kP: this.gains.kP,
      kI: this.gains.kI,
      kD: this.gains.kD,
      kF: this.gains.kF,
      outputMin: -1,
      outputMax: 1,
      maxIntegral: 1,
      derivativeFilterHz: 30,
    });
    return this;
  }

  reset() {
    this.power = 0;
    this.targetVelocity = 0;
    this.usingDirectVelocity = false;
    this.duty = 0;
    this.open = false;
    this.pid.reset();
    this.hubPid.reset();
    return this;
  }

  /**
   * FTC `setPower`. In RUN_USING_ENCODER this becomes a fraction of free speed.
   *
   * Charged as a hub write only when the value changes, because that is what
   * the SDK does: `LynxDcMotorController` remembers the last power it sent to
   * each port and skips the transaction when you send it again. Holding a stick
   * perfectly still is therefore free, and a loop that writes four motors every
   * cycle costs 10 ms -- which is most of a typical FTC loop time.
   */
  setPower(power) {
    const next = clamp(power, -1, 1);
    if (next !== this.power || this.usingDirectVelocity) this.bus?.write();
    this.power = next;
    this.usingDirectVelocity = false;
    return this;
  }

  /** FTC `setVelocity`, in rad/s at the output shaft. */
  setVelocity(radPerSec) {
    if (radPerSec !== this.targetVelocity || !this.usingDirectVelocity) this.bus?.write();
    this.targetVelocity = radPerSec;
    this.usingDirectVelocity = true;
    return this;
  }

  setMode(mode) {
    if (mode !== this.mode) {
      // A run-mode change is its own transaction, which is why setting the mode
      // inside the loop rather than in init costs you 2.5 ms a cycle.
      this.bus?.write();
      this.mode = mode;
      this.pid.reset();
    }
    return this;
  }

  /**
   * Resolve the commanded duty cycle for this control cycle.
   *
   * Two different maxima are needed, and conflating them is a subtle but
   * important error. The *nominal* free speed defines what `setPower(0.5)`
   * means -- half of the motor's rated speed, a fixed target that does not
   * move with the battery. The *bus* free speed is what a given duty cycle can
   * actually achieve right now, and so is what the feedforward must divide by.
   * Using the bus figure for both would make the velocity target sag with the
   * pack, which is exactly the behaviour closed-loop control exists to remove.
   *
   * @param {number} measuredVelocity output-shaft speed as the *encoder* reports it, rad/s
   * @param {number} measuredPosition output-shaft position as reported, rad
   * @param {number} nominalMaxVelocity free speed at the motor's rated voltage, rad/s
   * @param {number} busMaxVelocity free speed at the current bus voltage, rad/s
   * @param {number} dt control period, seconds
   * @returns {number} duty cycle, -1..1
   */
  update(measuredVelocity, measuredPosition, nominalMaxVelocity, busMaxVelocity, dt) {
    const dir = this.reversed ? -1 : 1;
    let duty = 0;
    this.open = false;

    if (this.mode === 'RUN_TO_POSITION') {
      const err = this.targetPosition - measuredPosition * dir;
      const targetVel = clamp(this.positionP * err, -1, 1) * Math.abs(this.power) * nominalMaxVelocity;
      duty = this._velocityLoop(targetVel, measuredVelocity * dir, nominalMaxVelocity, busMaxVelocity, dt);
    } else if (this.mode === 'RUN_USING_ENCODER') {
      const targetVel = this.usingDirectVelocity
        ? this.targetVelocity
        : this.power * nominalMaxVelocity;
      if (targetVel === 0 && this.power === 0) {
        this.pid.reset();
        duty = 0;
      } else {
        duty = this._velocityLoop(targetVel, measuredVelocity * dir, nominalMaxVelocity, busMaxVelocity, dt);
      }
    } else {
      // Open loop: the stick value is the duty cycle. This is why an open-loop
      // robot is quicker on a fresh battery -- the same duty buys more speed.
      duty = this.usingDirectVelocity
        ? clamp(busMaxVelocity > 0 ? this.targetVelocity / busMaxVelocity : 0, -1, 1)
        : this.power;
    }

    duty = clamp(duty, -this.maxDuty, this.maxDuty);

    // At exactly zero command the zero-power behaviour decides whether the
    // terminals are shorted (BRAKE, back-EMF resists motion) or open (FLOAT,
    // the robot coasts). This is the difference between a robot that stops
    // where you release the stick and one that keeps drifting.
    if (duty === 0 && this.zeroPowerBehavior === 'FLOAT') this.open = true;

    this.duty = duty * dir;
    return this.duty;
  }

  _velocityLoop(targetVel, measuredVel, nominalMaxVelocity, busMaxVelocity, dt) {
    if (nominalMaxVelocity <= 1e-6) return 0;
    if (this.velocityLoop === 'hub') {
      return this._hubLoop(targetVel, measuredVel, nominalMaxVelocity, dt);
    }
    // Normalise the loop against the nominal maximum so the gains are
    // independent of gearing and of the battery's state.
    const sp = clamp(targetVel / nominalMaxVelocity, -1, 1);
    const pv = measuredVel / nominalMaxVelocity;
    const feedback = this.pid.calculate(sp, pv, dt);

    // The PID's kF term assumed a healthy bus; correct it for the voltage
    // actually available. On a sagging pack this asks for more duty to hold
    // the same speed, which is the whole point of running closed loop.
    if (busMaxVelocity > 1e-6 && this.gains.kF !== 0) {
      const compensation = nominalMaxVelocity / busMaxVelocity - 1;
      return clamp(feedback + this.gains.kF * sp * compensation, -1, 1);
    }
    return feedback;
  }

  /**
   * The hub's loop, in ticks per second.
   *
   * No bus-voltage correction, deliberately: the hub does not do one. Its F
   * term assumes full duty gets you full speed, and on a sagging pack it does
   * not -- so the loop runs a standing error that P and I have to make up,
   * which is exactly what a real robot does at the end of a match.
   */
  _hubLoop(targetVel, measuredVel, nominalMaxVelocity, dt) {
    const perRev = this.ticksPerOutputRev;
    if (!(perRev > 0)) return 0;
    const toTicks = perRev / (2 * Math.PI);
    const maxTps = nominalMaxVelocity * toTicks;
    const gains = this.hubGains ?? hubDefaultGains(maxTps);
    this.hubPid.set(gains);
    return this.hubPid.update(targetVel * toTicks, measuredVel * toTicks, dt);
  }
}
