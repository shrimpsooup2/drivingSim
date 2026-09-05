import { blendedCurve, clamp, deadband, wrapAngle } from '../math/MathUtil.js';
import { SlewRateLimiter } from '../math/filters.js';
import { HOLONOMIC_SCHEMES, SCHEMES } from './driveSchemes.js';

/**
 * Everything between the raw stick and the drivetrain command.
 *
 * This is where most of a robot's "feel" is decided, and it is by far the
 * cheapest thing to experiment with -- no rebuild, no new parts. In order:
 *
 *   1. **Deadband**, rescaled so there is no jump at the edge of the band.
 *   2. **Response curve**, blended between linear and an odd power curve. A
 *      curve gives fine control near centre while keeping full power available.
 *   3. **Axis scaling**, including a precision multiplier on the trigger.
 *   4. **Field-centric rotation**, if enabled, using the IMU heading -- which
 *      means it inherits the IMU's drift, exactly as on the real robot.
 *   5. **Slew rate limiting**, separately for acceleration, deceleration and
 *      turning. This is the honest fix for a robot that spins its wheels when
 *      the driver slams the stick.
 *   6. **Heading hold**, an optional PD loop that keeps the robot pointed where
 *      it was when the driver stopped commanding a turn.
 */
export class DriverProcessor {
  /** @param {import('../config/schema.js').SimConfig} config */
  constructor(config) {
    this.config = config;
    this.forwardLimiter = new SlewRateLimiter(config.driver.slewRate, config.driver.slewRateDown);
    this.strafeLimiter = new SlewRateLimiter(config.driver.slewRate, config.driver.slewRateDown);
    this.turnLimiter = new SlewRateLimiter(config.driver.turnSlewRate, config.driver.turnSlewRate);

    /** Heading the hold loop is targeting, radians. */
    this.lockedHeading = 0;
    this.headingLockActive = false;
    /** Runtime toggle, independent of the configured default. */
    this.fieldCentricOverride = /** @type {boolean|null} */ (null);

    /** Last computed command, for the HUD. */
    this.output = { forward: 0, strafe: 0, turn: 0 };
    /** Command before ramping, so the HUD can show how much the ramp is doing. */
    this.rawOutput = { forward: 0, strafe: 0, turn: 0 };
    this.precisionActive = false;
  }

  applySettings(config) {
    this.config = config;
    this.forwardLimiter.setRates(config.driver.slewRate, config.driver.slewRateDown);
    this.strafeLimiter.setRates(config.driver.slewRate, config.driver.slewRateDown);
    this.turnLimiter.setRates(config.driver.turnSlewRate, config.driver.turnSlewRate);
    return this;
  }

  reset(heading = 0) {
    this.forwardLimiter.reset(0);
    this.strafeLimiter.reset(0);
    this.turnLimiter.reset(0);
    this.lockedHeading = heading;
    this.headingLockActive = false;
    this.output = { forward: 0, strafe: 0, turn: 0 };
    return this;
  }

  get fieldCentric() {
    if (this.fieldCentricOverride !== null) return this.fieldCentricOverride;
    return this.config.driver.scheme === 'fieldCentric';
  }

  set fieldCentric(value) {
    this.fieldCentricOverride = value;
  }

  toggleFieldCentric() {
    this.fieldCentricOverride = !this.fieldCentric;
    return this.fieldCentricOverride;
  }

  /**
   * @param {import('../input/FtcGamepad.js').FtcGamepad} gamepad
   * @param {number} imuHeading radians, as reported by the IMU (not ground truth)
   * @param {number} angularVelocity rad/s
   * @param {number} dt control period, seconds
   */
  process(gamepad, imuHeading, angularVelocity, dt) {
    const d = this.config.driver;
    const scheme = SCHEMES[d.scheme] ?? SCHEMES.robotCentric;
    const raw = scheme(gamepad);

    const shape = (v) => blendedCurve(deadband(v, d.deadband), d.exponent, d.curveBlend);

    let forward = shape(raw.forward) * (d.invertDrive ? -1 : 1);
    let strafe = HOLONOMIC_SCHEMES.has(d.scheme) ? shape(raw.strafe) : 0;
    let turn = shape(raw.turn) * (d.invertTurn ? -1 : 1);

    // Precision mode on the left trigger: analogue, so partial pressure gives
    // partial slowdown rather than an on/off switch.
    const precision = clamp(gamepad.left_trigger, 0, 1);
    this.precisionActive = precision > 0.05;
    const precisionScale = 1 - precision * (1 - d.slowModeFactor);

    forward *= d.driveScale * precisionScale;
    strafe *= d.strafeScale * precisionScale;
    turn *= d.turnScale * precisionScale;

    this.rawOutput = { forward, strafe, turn };

    // Field centric: rotate the translation command from the field frame into
    // the robot frame. Uses the IMU heading, so IMU drift shows up here as
    // "forward" slowly ceasing to mean forward -- the real failure mode.
    if (this.fieldCentric && HOLONOMIC_SCHEMES.has(d.scheme)) {
      const c = Math.cos(-imuHeading);
      const s = Math.sin(-imuHeading);
      const fx = forward * c - strafe * s;
      const fy = forward * s + strafe * c;
      forward = fx;
      strafe = fy;
    }

    // Heading hold. Engages once the driver releases the turn stick and the
    // robot has nearly stopped rotating, so it never fights an intentional turn.
    if (d.headingLockEnabled) {
      const commandingTurn = Math.abs(turn) > 0.02;
      if (commandingTurn) {
        this.headingLockActive = false;
        this.lockedHeading = imuHeading;
      } else if (!this.headingLockActive && Math.abs(angularVelocity) < 0.35) {
        this.headingLockActive = true;
        this.lockedHeading = imuHeading;
      }
      if (this.headingLockActive) {
        const error = wrapAngle(this.lockedHeading - imuHeading);
        turn = clamp(d.headingLockP * error - d.headingLockD * angularVelocity, -1, 1) * d.turnScale;
      }
    } else {
      this.headingLockActive = false;
    }

    this.output = {
      forward: this.forwardLimiter.update(forward, dt),
      strafe: this.strafeLimiter.update(strafe, dt),
      turn: this.turnLimiter.update(turn, dt),
    };
    return this.output;
  }
}
