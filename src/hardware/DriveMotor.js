import { DcMotor } from './DcMotor.js';
import { Encoder } from './Encoder.js';
import { MotorController } from './MotorController.js';

/**
 * A complete drive port: motor + gearbox + encoder + controller.
 *
 * Turns a commanded power into a torque at the wheel, and reports the current
 * it drew so the battery can sag accordingly.
 */
export class DriveMotor {
  /**
   * @param {{
   *   name?: string,
   *   motor: DcMotor,
   *   gearRatio?: number,
   *   externalRatio?: number,
   *   efficiency?: number,
   *   staticFrictionTorque?: number,
   *   viscousFriction?: number,
   *   controller?: MotorController,
   *   encoder?: Encoder,
   *   reversed?: boolean,
   * }} cfg
   */
  constructor(cfg) {
    this.name = cfg.name ?? 'motor';
    this.motor = cfg.motor;
    /** Planetary gearbox reduction, e.g. 19.2 for a 312 RPM Yellow Jacket. */
    this.gearRatio = cfg.gearRatio ?? 19.2;
    /** Any extra chain, belt or gear reduction between gearbox and wheel. */
    this.externalRatio = cfg.externalRatio ?? 1;
    /**
     * Mechanical efficiency of the whole train. A multi-stage planetary plus a
     * chain run is realistically 0.70-0.85; treating it as 1.0 is the single
     * most common reason a simulated robot out-accelerates the real one.
     */
    this.efficiency = cfg.efficiency ?? 0.8;
    /** Breakaway torque at the wheel, N*m. What you feel pushing a dead robot. */
    this.staticFrictionTorque = cfg.staticFrictionTorque ?? 0.05;
    /** Viscous drag, N*m per rad/s at the wheel. */
    this.viscousFriction = cfg.viscousFriction ?? 0.004;

    /**
     * Which way round the motor is bolted on: +1 or -1.
     *
     * A real drivetrain has one side mirrored, so positive power turns those
     * wheels backwards -- which is why every team's code contains
     * `setDirection(REVERSE)` on one side. This simulator's own kinematics
     * works in wheel terms and divides this back out, so both are right at
     * once: the built-in teleop drives straight, and a team's op-mode drives
     * straight *because* it reverses the mirrored side, exactly as on the
     * robot. Ported from the JVM simulator's `MotorState.physicalSign`.
     */
    this.mountSign = cfg.mountSign ?? 1;

    this.controller = cfg.controller ?? new MotorController();
    this.encoder =
      cfg.encoder ??
      new Encoder({ ticksPerRev: this.motor.ticksPerRev, gearRatio: this.totalRatio });
    if (cfg.reversed !== undefined) this.controller.reversed = cfg.reversed;

    // --- telemetry ---
    /** Current through the motor windings, signed by rotation direction. */
    this.current = 0;
    /** Current drawn from the 12 V bus. See computeWheelTorque for why these differ. */
    this.busCurrent = 0;
    this.appliedVoltage = 0;
    this.wheelTorque = 0;
    this.motorSpeed = 0;
    this.duty = 0;
  }

  get totalRatio() {
    return this.gearRatio * this.externalRatio;
  }

  /** Rotor inertia reflected to the wheel shaft: scales with the square of the ratio. */
  get reflectedInertia() {
    const r = this.totalRatio;
    return this.motor.rotorInertia * r * r;
  }

  /** Free speed of the wheel shaft at a given bus voltage, rad/s. */
  freeOutputSpeed(busVoltage) {
    return this.motor.freeSpeedAt(busVoltage) / this.totalRatio;
  }

  /** Stall torque at the wheel shaft, N*m, including efficiency. */
  stallOutputTorque(busVoltage) {
    return this.motor.stallTorqueAt(busVoltage) * this.totalRatio * this.efficiency;
  }

  reset() {
    this.controller.reset();
    this.encoder.reset();
    this.current = 0;
    this.busCurrent = 0;
    this.appliedVoltage = 0;
    this.wheelTorque = 0;
    this.motorSpeed = 0;
    this.duty = 0;
    return this;
  }

  /** Free speed of the wheel shaft at the motor's rated voltage, rad/s. */
  get nominalOutputSpeed() {
    return this.motor.freeSpeed / this.totalRatio;
  }

  /** Run the controller. Call at the control-loop rate, not the physics rate. */
  updateController(busVoltage, dt) {
    // The hub loop works in ticks per second, and the encoder is the only thing
    // that knows how many ticks a revolution is.
    this.controller.ticksPerOutputRev = this.encoder?.ticksPerOutputRev ?? 0;
    this.duty = this.controller.update(
      this.encoder.velocityRadPerSec,
      this.encoder.positionRadians,
      this.nominalOutputSpeed,
      this.freeOutputSpeed(busVoltage),
      dt,
    );
    return this.duty;
  }

  /**
   * Torque delivered to the wheel at the current wheel speed. Call every
   * physics substep, since torque depends on the instantaneous speed.
   *
   * @param {number} wheelOmega wheel shaft speed, rad/s
   * @param {number} busVoltage volts
   * @returns {number} torque at the wheel, N*m
   */
  computeWheelTorque(wheelOmega, busVoltage) {
    const ratio = this.totalRatio;
    // The motor's own shaft, which on a mirrored port turns the other way from
    // the wheel. Everything from here to `geared` is in the motor's terms.
    const mount = this.mountSign;
    const motorOmega = wheelOmega * ratio * mount;
    this.motorSpeed = motorOmega;

    const commandedVoltage = this.duty * busVoltage;
    const result = this.motor.evaluate(
      commandedVoltage,
      motorOmega,
      this.controller.currentLimit,
      this.controller.open,
    );

    this.current = result.current;
    this.appliedVoltage = result.voltage;

    // Current drawn from the battery is not the same as current through the
    // windings. The H-bridge acts as a buck converter, so bus power equals
    // motor power: V_bus * I_bus = (duty * V_bus) * I_motor, hence
    // I_bus = duty * I_motor. Three consequences fall out of this, all correct:
    //   - a motor driven in reverse (duty and current both negative) still
    //     *draws* positive current from the pack;
    //   - at low duty a stalled motor pulls far less from the pack than its
    //     winding current suggests;
    //   - braking regeneration shows up as negative bus current.
    // Summing raw winding current instead makes a strafing mecanum robot appear
    // to draw nothing at all, because the two wheel pairs cancel.
    this.busCurrent = this.duty * result.current;

    // Gearbox losses reduce the magnitude of whatever torque is being
    // transmitted, in either direction of power flow. Back into wheel terms on
    // the way out, which is where the mount sign leaves the calculation.
    const geared = result.torque * ratio * this.efficiency * mount;

    // Drivetrain friction always opposes motion. tanh gives a smooth breakaway
    // instead of a discontinuity at zero speed.
    const friction =
      -Math.tanh(wheelOmega / 0.3) * this.staticFrictionTorque - this.viscousFriction * wheelOmega;

    this.wheelTorque = geared + friction;
    return this.wheelTorque;
  }

  /**
   * Update the encoder from the true wheel angle.
   *
   * Through the mount sign, because the encoder is on the motor: a mirrored
   * port counts *down* while the robot drives forward, which is exactly why a
   * team's code has to reverse that side and why its encoder readings look
   * negative until it does.
   */
  updateSensors(wheelAngle, dt) {
    this.encoder.gearRatio = this.totalRatio;
    this.encoder.update(wheelAngle * this.mountSign, dt);
  }
}
