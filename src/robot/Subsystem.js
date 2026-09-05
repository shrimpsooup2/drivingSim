/**
 * Base class for robot mechanisms beyond the drivetrain.
 *
 * The season's game is not known yet, so no mechanisms ship with the simulator.
 * This is the seam they plug into. A subsystem gets the same two-rate treatment
 * the drivetrain does -- `updateControl` at the op-mode loop rate,
 * `applyForces` at the physics rate -- so an arm that shifts the centre of
 * gravity or a flywheel that draws current is modelled correctly rather than
 * bolted on.
 *
 * See docs/EXTENDING.md for a complete worked example.
 */
export class Subsystem {
  /**
   * @param {{name?:string}} [opts]
   */
  constructor(opts = {}) {
    this.name = opts.name ?? 'subsystem';
    this.robot = /** @type {import('./Robot.js').Robot|null} */ (null);
    this.enabled = true;
  }

  /** Called once when the subsystem is attached to a robot. */
  init() {}

  /**
   * Op-mode rate update: read the gamepad, run controllers, set targets.
   * @param {number} _dt seconds
   * @param {import('../input/FtcGamepad.js').FtcGamepad} _gamepad
   */
  updateControl(_dt, _gamepad) {}

  /**
   * Physics rate update. Apply forces or torques to `this.robot.body`, and
   * report current draw so the battery sags correctly.
   * @param {number} _dt seconds
   * @param {number} _busVoltage volts
   * @returns {number} current drawn this substep, amps
   */
  applyForces(_dt, _busVoltage) {
    return 0;
  }

  /**
   * Extra mass this subsystem contributes, and where it sits. The robot folds
   * this into its total mass and centre of gravity, so an extended arm really
   * does make the robot tippy.
   * @returns {{mass:number, x:number, y:number, z:number}|null}
   */
  massContribution() {
    return null;
  }

  /** Key/value pairs to show in the telemetry HUD. */
  telemetry() {
    return /** @type {Record<string, string|number>} */ ({});
  }

  reset() {}
}
