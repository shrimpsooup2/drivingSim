import { Vec2 } from '../math/Vec2.js';
import { RigidBody2d } from '../physics/RigidBody2d.js';
import { Drivetrain } from '../drivetrain/Drivetrain.js';
import { Battery } from '../hardware/Battery.js';
import { HardwareBus } from '../hardware/HardwareBus.js';
import { Imu } from '../hardware/Imu.js';
import { Odometry } from '../hardware/Odometry.js';
import { Camera } from '../hardware/Camera.js';

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
    /**
     * The hubs, and what talking to them costs.
     *
     * Created before the drivetrain because every motor controller holds a
     * reference to it: a `setPower` is a hub write and has to be charged for
     * wherever it comes from.
     */
    this.bus = new HardwareBus().applySettings(config.control?.hub);
    this.drivetrain = new Drivetrain(config, { bus: this.bus });
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
    /**
     * Odometry pods and the board that integrates them.
     *
     * Stepped every substep and sampled every control cycle, whether or not
     * anybody reads it -- which is how the HUD can tell you how far the pose has
     * drifted from the truth without the op-mode having asked for it.
     */
    this.odometry = new Odometry(config.odometry);
    /**
     * A webcam looking for AprilTags.
     *
     * Advanced from `Simulation`, not from here: it needs the FIELD's tags as
     * well as the robot's pose, and the robot does not know about the FIELD.
     */
    this.camera = new Camera(config.camera);

    /** @type {import('./Subsystem.js').Subsystem[]} */
    this.subsystems = [];

    /**
     * Bumped whenever the robot is picked up and put somewhere.
     *
     * Anything that integrates a pose over time -- odometry, the path trail --
     * has to be able to tell "the robot drove there" from "the robot was
     * dragged there", because integrating a teleport produces a metre of
     * imaginary travel in one substep. Ported from the JVM simulator's
     * `Chassis.teleportEpoch`, which exists for exactly this.
     */
    this.teleportEpoch = 0;

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
    this.bus.applySettings(config.control?.hub);
    if (rebuild) this.drivetrain.rebuild(config);
    else this.drivetrain.applySettings(config);

    this.battery.openCircuitVoltage = config.battery.openCircuitVoltage;
    this.battery.internalResistance = config.battery.internalResistance;
    this.battery.capacityAmpHours = config.battery.capacityAmpHours;
    this.battery.baseLoadAmps = config.battery.baseLoadAmps;
    this.battery.enabled = config.battery.enabled;
    this.battery.nominalVoltage = config.battery.nominalVoltage;

    this.odometry.applySettings(config.odometry);
    this.camera.applySettings(config.camera);

    this.imu.enabled = config.imu.enabled;
    this.imu.driftRateDegPerSec = config.imu.driftRateDegPerSec;
    this.imu.noiseDeg = config.imu.noiseDeg;
    this.imu.latencySeconds = config.imu.latencySeconds;

    this.updateMassProperties();
    return this;
  }

  // ------------------------------------------------- reading it as robot code
  //
  // Everything an op-mode or an AUTO routine reads off the robot goes through
  // one of these, so the hub transaction is charged in one obvious place. The
  // simulator's own reads -- the renderer, the HUD, the referee, the AI --
  // touch `imu`, `battery` and `encoder` directly and pay nothing, because
  // none of those reads happen on a real robot.

  /** The IMU, over I2C, as `imu.getRobotYawPitchRollAngles()` is. */
  readHeading() {
    this.bus.i2c();
    return this.imu.heading;
  }

  /** `imu.resetYaw()`, which is a write to the sensor. */
  resetHeading() {
    this.bus.i2c();
    this.imu.resetYaw(this.body.rotation.radians);
    return this;
  }

  /** Bus voltage, as `voltageSensor.getVoltage()` is: one hub read. */
  readVoltage() {
    this.bus.read();
    return this.battery.busVoltage;
  }

  /**
   * The pose the odometry board reports, as `getPosX/getPosY/getHeading` do.
   *
   * One I2C transaction, whichever of the three you asked for -- the board
   * hands back the whole pose in one read, which is the same reason the IMU's
   * heading and rate come together.
   */
  readOdometry() {
    this.bus.i2c();
    return this.odometry.pose;
  }

  /**
   * An encoder, out of the bulk packet if one is warm.
   * @param {import('../hardware/DriveMotor.js').DriveMotor} motor
   * @param {'position'|'velocity'} what
   */
  readEncoder(motor, what = 'position') {
    this.bus.cachedRead(`${motor.name}.${what}`);
    if (!motor.encoder) return 0;
    return what === 'velocity' ? motor.encoder.velocityTicksPerSec : motor.encoder.ticks;
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
    // After the IMU, because a two-pod setup takes its heading from it and a
    // cycle-old heading is a cycle of rotation booked in the wrong direction.
    this.odometry.sample(this.imu.heading);
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

    // Pods roll on the *new* velocity, every substep: the omega x r term needs
    // the instantaneous yaw rate rather than a control-cycle average, which is
    // the whole reason a pod at an offset reads what it reads.
    this.odometry.step(this.body.bodyVelocity, this.body.angularVelocity, dt);

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
    this.teleportEpoch++;
    this.bus.reset();
    this.drivetrain.reset();
    this.battery.reset();
    this.battery.setStateOfCharge(this.config.battery.startingStateOfCharge);
    this.imu.reset(heading);
    // Odometry starts knowing where it is, because a team squares the robot up
    // on a known tile and calls `setPosition` before the match. Drift from
    // there is the interesting part.
    this.odometry.reset({ x, y, heading }, this.imu.heading);
    this.camera.reset();
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
