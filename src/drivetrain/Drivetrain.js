import { Vec2 } from '../math/Vec2.js';
import { clamp } from '../math/MathUtil.js';
import { LoadModel } from '../physics/LoadDistribution.js';
import { compileFriction } from '../physics/friction.js';
import { buildLayout } from './layouts.js';
import {
  buildInverseKinematics,
  desaturate,
  forwardKinematics,
  inverseKinematics,
  maxChassisSpeeds,
} from './kinematics.js';
import { DcMotor } from '../hardware/DcMotor.js';
import { DriveMotor } from '../hardware/DriveMotor.js';
import { MotorController } from '../hardware/MotorController.js';
import { Encoder } from '../hardware/Encoder.js';

/**
 * A complete drivetrain: wheels, motors, load model and kinematics.
 *
 * Responsibilities are split by rate, matching the real robot:
 *
 *  - `updateControl` runs at the control-loop rate (the op-mode's loop, tens of
 *    Hz). It samples encoders and runs the motor controllers.
 *  - `applyForces` runs at the physics substep rate (hundreds to thousands of
 *    Hz). It evaluates motor torque at the instantaneous wheel speed, computes
 *    contact forces and applies them to the chassis.
 *
 * Running both at the same rate is the usual shortcut, and it makes a simulated
 * robot feel unrealistically crisp, because a real op-mode only gets to change
 * motor commands 20-50 times a second.
 */
export class Drivetrain {
  /**
   * @param {import('../config/schema.js').SimConfig} config
   */
  constructor(config) {
    this.config = config;
    /** @type {import('../physics/Wheel.js').Wheel[]} */
    this.wheels = [];
    /** @type {DriveMotor[]} */
    this.motors = [];
    this.loadModel = new LoadModel();
    this.friction = compileFriction(config.surface);
    this._wheelPositions = /** @type {Vec2[]} */ ([]);
    this._commandedPowers = /** @type {number[]} */ ([]);
    this._wheelSpeeds = new Float64Array(0);
    this._forceScratch = new Vec2();

    /** Aggregate telemetry, refreshed every control cycle. */
    this.telemetry = {
      totalCurrent: 0,
      measuredTwist: { vx: 0, vy: 0, omega: 0 },
      maxSpeeds: { forward: 0, strafe: 0, turn: 0 },
      slipping: false,
      peakGripUsage: 0,
    };

    this.rebuild(config);
  }

  /** Rebuild wheels and motors from config. Safe to call while running. */
  rebuild(config) {
    this.config = config;
    const d = config.drivetrain;
    const m = config.motor;

    const motorSpec = {
      name: m.name,
      freeSpeedRpm: m.freeSpeedRpm,
      stallTorque: m.stallTorque,
      stallCurrent: m.stallCurrent,
      freeCurrent: m.freeCurrent,
      nominalVoltage: config.battery.nominalVoltage,
      ticksPerRev: m.ticksPerRev,
      rotorInertia: m.rotorInertia,
    };
    const totalRatio = m.gearRatio * m.externalRatio;
    const prototype = new DcMotor(motorSpec);
    const reflected = prototype.rotorInertia * totalRatio * totalRatio;
    // A solid wheel is roughly a uniform disc; a mecanum wheel carries most of
    // its mass in the rollers at the rim, so it is closer to a hoop.
    const discFactor = d.type === 'mecanum' ? 0.7 : 0.5;
    const wheelInertia = discFactor * d.wheelMass * d.wheelRadius * d.wheelRadius;

    this.wheels = buildLayout(d.type, {
      wheelbase: d.wheelbase,
      trackWidth: d.trackWidth,
      wheelRadius: d.wheelRadius,
      rollerAngle: d.rollerAngle,
      rotationalInertia: wheelInertia + reflected,
      rollingResistance: config.surface.rollingResistance,
      rollerDrag: config.surface.rollerDrag,
    });

    this.motors = this.wheels.map(
      (w) =>
        new DriveMotor({
          name: w.name,
          motor: new DcMotor(motorSpec),
          gearRatio: m.gearRatio,
          externalRatio: m.externalRatio,
          efficiency: m.efficiency,
          staticFrictionTorque: m.staticFrictionTorque,
          viscousFriction: m.viscousFriction,
          controller: new MotorController({
            mode: config.control.runMode,
            zeroPowerBehavior: config.control.zeroPowerBehavior,
            currentLimit: config.control.currentLimit,
            kP: config.control.kP,
            kI: config.control.kI,
            kD: config.control.kD,
            kF: config.control.kF,
          }),
          encoder: new Encoder({
            ticksPerRev: m.ticksPerRev,
            gearRatio: totalRatio,
            velocityFilterHz: config.control.encoderFilterHz,
            quantise: config.control.quantiseEncoders,
          }),
        }),
    );

    this._wheelPositions = this.wheels.map((w) => w.position);
    this.rows = buildInverseKinematics(this.wheels);
    this._commandedPowers = this.wheels.map(() => 0);
    this._wheelSpeeds = new Float64Array(this.wheels.length);

    this.loadModel.cgHeight = config.chassis.cgHeight;
    this.loadModel.cgOffset = new Vec2(config.chassis.cgOffsetX, config.chassis.cgOffsetY);
    this.loadModel.transferFactor = config.chassis.weightTransferFactor;
    this.friction = compileFriction(config.surface);

    this._normalisation = this._computeNormalisation();
    return this;
  }

  /**
   * Peak inverse-kinematics coefficients, used to turn -1..1 driver commands
   * into wheel powers. This is what makes the same drive code work for mecanum,
   * X-drive and tank without special cases.
   */
  _computeNormalisation() {
    let a = 0;
    let b = 0;
    let c = 0;
    for (const r of this.rows) {
      a = Math.max(a, Math.abs(r.a));
      b = Math.max(b, Math.abs(r.b));
      c = Math.max(c, Math.abs(r.c));
    }
    return { a: a || 1, b, c: c || 1 };
  }

  /** Apply live config changes that do not require a full rebuild. */
  applySettings(config) {
    this.config = config;
    this.friction = compileFriction(config.surface);
    this.loadModel.cgHeight = config.chassis.cgHeight;
    this.loadModel.cgOffset.set(config.chassis.cgOffsetX, config.chassis.cgOffsetY);
    this.loadModel.transferFactor = config.chassis.weightTransferFactor;
    for (const w of this.wheels) {
      w.rollingResistance = config.surface.rollingResistance;
      w.rollerDrag = config.surface.rollerDrag;
    }
    for (const dm of this.motors) {
      dm.efficiency = config.motor.efficiency;
      dm.staticFrictionTorque = config.motor.staticFrictionTorque;
      dm.viscousFriction = config.motor.viscousFriction;
      dm.controller.setMode(config.control.runMode);
      dm.controller.zeroPowerBehavior = config.control.zeroPowerBehavior;
      dm.controller.currentLimit = config.control.currentLimit;
      dm.controller.gains.kP = config.control.kP;
      dm.controller.gains.kI = config.control.kI;
      dm.controller.gains.kD = config.control.kD;
      dm.controller.gains.kF = config.control.kF;
      dm.controller.syncGains();
      dm.encoder.velocityFilterHz = config.control.encoderFilterHz;
      dm.encoder.filter.cutoffHz = config.control.encoderFilterHz;
      dm.encoder.quantise = config.control.quantiseEncoders;
    }
    return this;
  }

  reset() {
    for (const w of this.wheels) w.reset();
    for (const m of this.motors) m.reset();
    for (let i = 0; i < this._commandedPowers.length; i++) this._commandedPowers[i] = 0;
    return this;
  }

  get wheelCount() {
    return this.wheels.length;
  }

  /**
   * Can this drivetrain command sideways motion?
   *
   * Read from the kinematics rather than from the layout name, so a custom
   * layout added later answers correctly without being listed anywhere.
   */
  get canStrafe() {
    return this._normalisation.b > 1e-6;
  }

  /**
   * Command the drivetrain with normalised chassis motion, the way an FTC
   * op-mode does. Each argument is -1..1.
   *
   * @param {number} forward  +1 is full speed ahead
   * @param {number} strafe   +1 is full speed to the robot's left
   * @param {number} turn     +1 is full counter-clockwise rotation
   */
  driveNormalized(forward, strafe, turn) {
    const norm = this._normalisation;
    const powers = this._commandedPowers;
    for (let i = 0; i < this.rows.length; i++) {
      const r = this.rows[i];
      // A drivetrain that cannot strafe simply drops the strafe term rather
      // than dividing by zero.
      const strafeTerm = norm.b > 1e-9 ? (r.b / norm.b) * strafe : 0;
      powers[i] = (r.a / norm.a) * forward + strafeTerm + (r.c / norm.c) * turn;
    }
    // Scale rather than clip: clipping each wheel independently changes the
    // direction the robot actually travels.
    desaturate(powers, 1);
    for (let i = 0; i < this.motors.length; i++) this.motors[i].controller.setPower(powers[i]);
    return powers;
  }

  /** Command absolute chassis speeds in m/s and rad/s. */
  driveVelocity(vx, vy, omega, busVoltage) {
    if (this.motors.length === 0) return this._wheelSpeeds;
    const speeds = inverseKinematics(this.rows, vx, vy, omega, this._wheelSpeeds);
    const maxSurface = this.motors[0].freeOutputSpeed(busVoltage) * this.config.drivetrain.wheelRadius;
    desaturate(speeds, maxSurface);
    for (let i = 0; i < this.motors.length; i++) {
      this.motors[i].controller.setVelocity(speeds[i] / this.config.drivetrain.wheelRadius);
    }
    return speeds;
  }

  /** Directly set per-wheel power, for tests and future custom op-modes. */
  setWheelPowers(powers) {
    for (let i = 0; i < this.motors.length; i++) {
      this._commandedPowers[i] = powers[i] ?? 0;
      this.motors[i].controller.setPower(this._commandedPowers[i]);
    }
  }

  get commandedPowers() {
    return this._commandedPowers;
  }

  /**
   * Control-rate update: sample encoders, run motor controllers, refresh
   * odometry telemetry.
   * @param {number} dt control period, seconds
   * @param {number} busVoltage volts
   */
  updateControl(dt, busVoltage) {
    for (let i = 0; i < this.motors.length; i++) {
      const dm = this.motors[i];
      dm.updateSensors(this.wheels[i].angle, dt);
      dm.updateController(busVoltage, dt);
    }

    // Odometry from the drive encoders, exactly as a real robot would compute
    // it -- including the error that slip introduces.
    for (let i = 0; i < this.wheels.length; i++) {
      this._wheelSpeeds[i] = this.motors[i].encoder.velocityRadPerSec * this.wheels[i].radius;
    }
    const twist = forwardKinematics(this.rows, this._wheelSpeeds);
    this.telemetry.measuredTwist = { vx: twist.vx, vy: twist.vy, omega: twist.omega };
    this.telemetry.maxSpeeds = maxChassisSpeeds(
      this.rows,
      (this.motors[0]?.freeOutputSpeed(busVoltage) ?? 0) * this.config.drivetrain.wheelRadius,
    );
    return this;
  }

  /**
   * Physics-rate update: compute wheel loads and contact forces, apply them to
   * the chassis, and advance each wheel's spin.
   *
   * @param {import('../physics/RigidBody2d.js').RigidBody2d} body
   * @param {number} dt substep, seconds
   * @param {number} busVoltage volts
   * @returns {number} total motor current drawn this substep, amps
   */
  applyForces(body, dt, busVoltage) {
    const loads = this.loadModel.update(this._wheelPositions, body.mass, body.bodyAcceleration);
    const effectiveMass = body.mass / Math.max(1, this.wheels.length);

    let totalCurrent = 0;
    let peakGrip = 0;
    let slipping = false;

    for (let i = 0; i < this.wheels.length; i++) {
      const wheel = this.wheels[i];
      const motor = this.motors[i];

      // Motor torque depends on the instantaneous wheel speed, so it is
      // re-evaluated every substep even though the duty cycle only changes at
      // the control rate.
      const torque = motor.computeWheelTorque(wheel.angularVelocity, busVoltage);
      totalCurrent += motor.busCurrent;

      const contactVelocity = body.bodyPointVelocity(wheel.position);
      const force = wheel.step(contactVelocity, loads[i], torque, this.friction, dt, effectiveMass);
      body.applyForceAtBodyPoint(force, wheel.position);

      if (wheel.gripUsage > peakGrip) peakGrip = wheel.gripUsage;
      if (wheel.slipSpeed > this.config.surface.slipAtPeakGrip) slipping = true;
    }

    this.telemetry.totalCurrent = totalCurrent;
    this.telemetry.peakGripUsage = peakGrip;
    this.telemetry.slipping = slipping;
    return totalCurrent;
  }

  /** Sum of the per-wheel normal loads, for the HUD. */
  get wheelLoads() {
    return this.loadModel._loads;
  }

  /** Highest theoretical straight-line speed at a given bus voltage, m/s. */
  theoreticalTopSpeed(busVoltage) {
    const surface = (this.motors[0]?.freeOutputSpeed(busVoltage) ?? 0) * this.config.drivetrain.wheelRadius;
    return maxChassisSpeeds(this.rows, surface).forward;
  }

  /** Clamp helper used by future subsystem code sharing this drivetrain. */
  static clampPower(p) {
    return clamp(p, -1, 1);
  }
}
