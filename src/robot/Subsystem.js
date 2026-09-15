/**
 * Base class for robot mechanisms beyond the drivetrain.
 *
 * The core ships no mechanisms; BIOBUZZ's intake and launcher are built on this
 * class and add nothing to it, which is the seam working as intended.
 *
 * A subsystem gets the same two-rate treatment
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
   * The robot's pose and velocity, flattened.
   *
   * `RigidBody2d` stores these as `position`, `rotation` and `velocity`
   * objects. Mechanisms want plain numbers and a heading's cosine and sine,
   * and reading them straight off the body is easy to get wrong -- a typo like
   * `body.x` is `undefined` rather than an error, which silently turns every
   * comparison downstream into a `NaN` that fails open. Going through here
   * keeps the mapping in one place.
   *
   * @returns {{x:number, y:number, cos:number, sin:number, vx:number, vy:number, omega:number}}
   */
  get pose() {
    const body = this.robot?.body;
    if (!body) return { x: 0, y: 0, cos: 1, sin: 0, vx: 0, vy: 0, omega: 0 };
    return {
      x: body.position.x,
      y: body.position.y,
      cos: body.rotation.cos,
      sin: body.rotation.sin,
      vx: body.velocity.x,
      vy: body.velocity.y,
      omega: body.angularVelocity,
    };
  }

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
