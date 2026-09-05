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
 *   Right trigger   override the acceleration ramp for a burst of full power
 *   Y / triangle    toggle field centric
 *   B / circle      reset the IMU heading to the current pose
 *   Back            reset the robot to its starting position
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

    if (gamepad1.justPressed('y')) this.driver.toggleFieldCentric();
    if (gamepad1.justPressed('b')) robot.imu.resetYaw(robot.body.rotation.radians);
    if (gamepad1.justPressed('back')) this.sim?.resetRobot();

    const command = this.driver.process(
      gamepad1,
      robot.imu.heading,
      robot.body.angularVelocity,
      dt,
    );

    // Right trigger bypasses the acceleration ramp. Useful for a deliberate
    // burst, and a good way to feel exactly how much the ramp was protecting
    // you from breaking the wheels loose.
    let { forward, strafe, turn } = command;
    if (gamepad1.right_trigger > 0.5) {
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
