import { OpMode } from './OpMode.js';
import { DriverProcessor } from './DriverProcessor.js';
import { radPerSecToRpm } from '../math/MathUtil.js';

/**
 * The default driver-control op-mode.
 *
 * Reads the gamepad, shapes it through DriverProcessor, and commands the
 * drivetrain. Bindings match what most FTC teams use, so muscle memory built
 * here transfers:
 *
 *   Left stick      drive and strafe
 *   Right stick X   rotate
 *   Left trigger    precision mode (analogue)
 *   X / square      toggle field centric
 *   A / cross       reset the IMU heading to the current pose
 *   B / circle      override the acceleration ramp for a burst of full power
 *   Back            reset the robot to its starting position
 *
 * The driver aids deliberately keep off Y, the bumpers and the right trigger.
 * Those are the game's: Y spins the flywheel, the bumpers run the intake and
 * the right trigger fires. Sharing the right trigger between "fire" and
 * "burst" meant every shot also broke the wheels loose, and sharing Y meant
 * field centric toggled twice per press and appeared dead.
 */
export class TeleOpDrive extends OpMode {
  /**
   * @param {{config: import('../config/schema.js').SimConfig}} opts
   */
  constructor(opts) {
    super({ name: 'TeleOp: Driver Control' });
    this.config = opts.config;
    this.driver = new DriverProcessor(opts.config);
  }

  applySettings(config) {
    this.config = config;
    this.driver.applySettings(config);
    return this;
  }

  init() {
    this.driver.reset(this.robot?.imu.heading ?? 0);
  }

  reset() {
    super.reset();
    this.driver.reset(this.robot?.imu.heading ?? 0);
  }

  /**
   * @param {number} dt
   * @param {import('../input/FtcGamepad.js').FtcGamepad} gamepad1
   */
  loop(dt, gamepad1) {
    const robot = this.robot;
    if (!robot) return;
    this.runtime += dt;

    if (gamepad1.justPressed('x')) this.driver.toggleFieldCentric();
    if (gamepad1.justPressed('a')) robot.resetHeading();
    if (gamepad1.justPressed('back')) this.sim?.resetRobot();

    // One I2C reading, charged, and it covers the rate as well as the angle --
    // a real IMU read hands back both in the same transaction. This is most of
    // why a field-centric loop is slower than a robot-centric one.
    const heading = robot.readHeading();
    const command = this.driver.process(
      gamepad1,
      heading,
      robot.body.angularVelocity,
      dt,
    );

    // B bypasses the acceleration ramp. Useful for a deliberate burst, and a
    // good way to feel exactly how much the ramp was protecting you from
    // breaking the wheels loose. It used to be the right trigger, which is the
    // fire button -- so every shot came with a wheelspin.
    let { forward, strafe, turn } = command;
    if (gamepad1.b) {
      const raw = this.driver.rawOutput;
      forward = raw.forward;
      strafe = raw.strafe;
      turn = raw.turn;
    }

    robot.drivetrain.driveNormalized(forward, strafe, turn);

    this.addData('Field centric', this.driver.fieldCentric ? 'ON' : 'off');
    this.addData('Precision', this.driver.precisionActive ? 'ON' : 'off');
    this.addData('Heading hold', this.driver.headingLockActive ? 'ON' : 'off');
    this.addData('Motor RPM', Math.round(radPerSecToRpm(robot.drivetrain.wheels[0].angularVelocity)));
  }
}
