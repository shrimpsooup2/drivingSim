/**
 * Base class for anything that drives the robot, mirroring the FTC SDK shape.
 *
 * `init` runs once, `loop` runs at the configured op-mode rate with the
 * *delayed* gamepad state, and `stop` runs on teardown. Autonomous routines,
 * path followers and driver-assist experiments are all subclasses of this;
 * the simulator does not care which is running.
 *
 * Keeping the same shape as a real op-mode is deliberate: logic prototyped here
 * ports across with the gamepad reads and motor calls unchanged.
 */
export class OpMode {
  /**
   * @param {{name?:string}} [opts]
   */
  constructor(opts = {}) {
    this.name = opts.name ?? 'OpMode';
    this.robot = /** @type {import('../robot/Robot.js').Robot|null} */ (null);
    this.sim = /** @type {import('../app/Simulation.js').Simulation|null} */ (null);
    /** Seconds since the op-mode started. */
    this.runtime = 0;
    /** Free-form values shown in the telemetry panel, like FTC's telemetry. */
    this.telemetry = /** @type {Record<string, string|number>} */ ({});
  }

  /** Called once when the op-mode is selected. */
  init() {}

  /**
   * Called at the op-mode loop rate.
   * @param {number} _dt seconds
   * @param {import('../input/FtcGamepad.js').FtcGamepad} _gamepad1
   * @param {import('../input/FtcGamepad.js').FtcGamepad} _gamepad2
   */
  loop(_dt, _gamepad1, _gamepad2) {}

  /** Called when switching away from this op-mode or resetting. */
  stop() {}

  reset() {
    this.runtime = 0;
    this.telemetry = {};
  }

  /** FTC-style telemetry helper. */
  addData(key, value) {
    this.telemetry[key] = value;
  }
}
