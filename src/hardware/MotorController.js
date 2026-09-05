import { clamp } from '../math/MathUtil.js';
import { PIDF } from '../math/PIDF.js';

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
 * Gains are expressed against *normalised* velocity (fraction of free speed)
 * so they stay meaningful when the gear ratio changes: kF = 1 means "full duty
 * at full speed", which is the correct feedforward for an ideal motor.
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
   * }} [opts]
   */
  constructor(opts = {}) {
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
    return this;
  }

  /** FTC `setPower`. In RUN_USING_ENCODER this becomes a fraction of free speed. */
  setPower(power) {
    this.power = clamp(power, -1, 1);
    this.usingDirectVelocity = false;
    return this;
  }

  /** FTC `setVelocity`, in rad/s at the output shaft. */
  setVelocity(radPerSec) {
    this.targetVelocity = radPerSec;
    this.usingDirectVelocity = true;
    return this;
  }

  setMode(mode) {
    if (mode !== this.mode) {
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
}
