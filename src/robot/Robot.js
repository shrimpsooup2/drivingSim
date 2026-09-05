import { Vec2 } from '../math/Vec2.js';
import { RigidBody2d } from '../physics/RigidBody2d.js';
import { Drivetrain } from '../drivetrain/Drivetrain.js';
import { Battery } from '../hardware/Battery.js';
import { Imu } from '../hardware/Imu.js';

/**
 * The robot: a chassis body, a drivetrain, the electrical system, and a list of
 * subsystems.
 *
 * Mass properties are recomputed from the chassis settings plus any subsystem
 * contributions, so adding a mechanism that carries mass high up automatically
 * raises the centre of gravity and makes the robot tip more readily -- there is
 * nothing extra to remember to update.
 */
export class Robot {
  /**
   * @param {import('../config/schema.js').SimConfig} config
   */
  constructor(config) {
    this.config = config;
    this.body = new RigidBody2d();
    this.drivetrain = new Drivetrain(config);
    this.battery = new Battery({
      nominalVoltage: config.battery.nominalVoltage,
      openCircuitVoltage: config.battery.openCircuitVoltage,
      internalResistance: config.battery.internalResistance,
      capacityAmpHours: config.battery.capacityAmpHours,
      baseLoadAmps: config.battery.baseLoadAmps,
      enabled: config.battery.enabled,
    });
    this.battery.setStateOfCharge(config.battery.startingStateOfCharge);
    this.imu = new Imu({
      driftRateDegPerSec: config.imu.driftRateDegPerSec,
      noiseDeg: config.imu.noiseDeg,
      latencySeconds: config.imu.latencySeconds,
      enabled: config.imu.enabled,
    });

    /** @type {import('./Subsystem.js').Subsystem[]} */
    this.subsystems = [];

    this.stats = {
      topSpeed: 0,
      distanceTravelled: 0,
      peakCurrent: 0,
      minVoltage: Infinity,
      collisions: 0,
      slipTime: 0,
    };

    this.updateMassProperties();
  }

  /**
   * Attach a mechanism.
   * @template {import('./Subsystem.js').Subsystem} T
   * @param {T} subsystem
   * @returns {T}
   */
  addSubsystem(subsystem) {
    subsystem.robot = this;
    subsystem.init();
    this.subsystems.push(subsystem);
    this.updateMassProperties();
    return subsystem;
  }

  /**
   * Recompute mass, rotational inertia and centre of gravity from the chassis
   * settings and every attached subsystem.
   */
  updateMassProperties() {
    const c = this.config.chassis;
    let mass = c.mass;
    let mx = c.cgOffsetX * c.mass;
    let my = c.cgOffsetY * c.mass;
    let mz = c.cgHeight * c.mass;

    for (const sub of this.subsystems) {
      const contribution = sub.massContribution?.();
      if (!contribution) continue;
      mass += contribution.mass;
      mx += contribution.x * contribution.mass;
      my += contribution.y * contribution.mass;
      mz += contribution.z * contribution.mass;
    }

    this.body.mass = mass;
    this.body.momentOfInertia = c.autoInertia
      ? RigidBody2d.slabInertia(mass, c.length, c.width) * c.inertiaFactor
      : c.momentOfInertia;

    this.cg = new Vec2(mx / mass, my / mass);
    this.cgHeight = mz / mass;

    this.drivetrain.loadModel.cgOffset.set(this.cg.x, this.cg.y);
    this.drivetrain.loadModel.cgHeight = this.cgHeight;
    return this;
  }

  /** Apply a changed config. Rebuilds the drivetrain only when asked to. */
  applySettings(config, rebuild = false) {
    this.config = config;
    if (rebuild) this.drivetrain.rebuild(config);
    else this.drivetrain.applySettings(config);

    this.battery.openCircuitVoltage = config.battery.openCircuitVoltage;
    this.battery.internalResistance = config.battery.internalResistance;
    this.battery.capacityAmpHours = config.battery.capacityAmpHours;
    this.battery.baseLoadAmps = config.battery.baseLoadAmps;
    this.battery.enabled = config.battery.enabled;
    this.battery.nominalVoltage = config.battery.nominalVoltage;

    this.imu.enabled = config.imu.enabled;
    this.imu.driftRateDegPerSec = config.imu.driftRateDegPerSec;
    this.imu.noiseDeg = config.imu.noiseDeg;
    this.imu.latencySeconds = config.imu.latencySeconds;

    this.updateMassProperties();
    return this;
  }

  get halfLength() {
    return this.config.chassis.length / 2;
  }

  get halfWidth() {
    return this.config.chassis.width / 2;
  }

  /**
   * Control-loop update. Runs at the op-mode rate, which is far slower than the
   * physics rate.
   * @param {number} dt seconds
   * @param {import('../input/FtcGamepad.js').FtcGamepad} [gamepad]
   */
  updateControl(dt, gamepad) {
    const v = this.battery.busVoltage;
    this.drivetrain.updateControl(dt, v);
    this.imu.update(this.body.rotation.radians, this.body.angularVelocity, dt);
    for (const sub of this.subsystems) {
      if (sub.enabled && gamepad) sub.updateControl(dt, gamepad);
    }
    return this;
  }

  /**
   * One physics substep.
   * @param {number} dt seconds
   */
  stepPhysics(dt) {
    const busVoltage = this.battery.busVoltage;
    this.body.clearAccumulators();

    let current = this.drivetrain.applyForces(this.body, dt, busVoltage);
    for (const sub of this.subsystems) {
      if (sub.enabled) current += sub.applyForces(dt, busVoltage);
    }

    this.battery.update(current, dt);
    this.body.integrate(dt);

    if (!this.body.isFinite()) {
      console.error('[Robot] physics diverged; resetting body state');
      this.body.reset(this.body.position.x || 0, this.body.position.y || 0, 0);
    }
    return this;
  }

  /** Accumulate session statistics. Call once per rendered frame. */
  updateStats(dt) {
    const speed = this.body.speed;
    if (speed > this.stats.topSpeed) this.stats.topSpeed = speed;
    this.stats.distanceTravelled += speed * dt;
    if (this.battery.current > this.stats.peakCurrent) this.stats.peakCurrent = this.battery.current;
    if (this.battery.busVoltage < this.stats.minVoltage) this.stats.minVoltage = this.battery.busVoltage;
    if (this.drivetrain.telemetry.slipping) this.stats.slipTime += dt;
  }

  /**
   * Place the robot and clear all motion and electrical state.
   * @param {number} x
   * @param {number} y
   * @param {number} heading radians
   */
  reset(x = 0, y = 0, heading = 0) {
    this.body.reset(x, y, heading);
    this.drivetrain.reset();
    this.battery.reset();
    this.battery.setStateOfCharge(this.config.battery.startingStateOfCharge);
    this.imu.reset(heading);
    for (const sub of this.subsystems) sub.reset();
    this.stats = {
      topSpeed: 0,
      distanceTravelled: 0,
      peakCurrent: 0,
      minVoltage: Infinity,
      collisions: 0,
      slipTime: 0,
    };
    return this;
  }
}
