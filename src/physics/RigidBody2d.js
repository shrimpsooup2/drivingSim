import { Vec2 } from '../math/Vec2.js';
import { Rotation2d } from '../math/Rotation2d.js';
import { Pose2d, Twist2d } from '../math/Pose2d.js';

/**
 * A rigid body with three planar degrees of freedom: x, y and heading.
 *
 * An FTC robot on a flat field is very well described by three DOF. Pitch and
 * roll matter only through their effect on wheel load, which is handled
 * separately (see LoadDistribution.js) rather than by simulating suspension
 * that a rigid FTC chassis does not have.
 *
 * Position and linear velocity are stored in the field (world) frame; forces
 * are accumulated in the world frame too. Wheels compute in the body frame and
 * convert on the way in.
 */
export class RigidBody2d {
  /**
   * @param {{mass?:number, momentOfInertia?:number}} [opts]
   */
  constructor(opts = {}) {
    /** kilograms */
    this.mass = opts.mass ?? 15;
    /** kg*m^2 about the centre of mass, vertical axis */
    this.momentOfInertia = opts.momentOfInertia ?? 0.35;

    this.position = new Vec2();
    this.rotation = new Rotation2d();
    this.velocity = new Vec2();
    this.angularVelocity = 0;

    /** Accumulated world-frame force for the current substep. */
    this.force = new Vec2();
    /** Accumulated torque about the centre of mass (N*m, +ccw). */
    this.torque = 0;

    /** Last integrated acceleration, world frame. Used by load transfer. */
    this.acceleration = new Vec2();
    this.angularAcceleration = 0;
  }

  get pose() {
    return new Pose2d(this.position.clone(), this.rotation.clone());
  }

  /** Body-frame linear velocity (x forward, y left). */
  get bodyVelocity() {
    return this.rotation.unapply(this.velocity);
  }

  /** Body-frame acceleration of the centre of mass, excluding gravity. */
  get bodyAcceleration() {
    return this.rotation.unapply(this.acceleration);
  }

  /** Field-frame twist. */
  get twist() {
    return new Twist2d(this.velocity.x, this.velocity.y, this.angularVelocity);
  }

  get speed() {
    return this.velocity.length();
  }

  clearAccumulators() {
    this.force.set(0, 0);
    this.torque = 0;
  }

  /**
   * Apply a force expressed in the body frame, at a point given in the body
   * frame. This is the natural call for a wheel.
   * @param {Vec2} forceBody
   * @param {Vec2} pointBody offset from the centre of mass
   */
  applyForceAtBodyPoint(forceBody, pointBody) {
    this.force.addMut(this.rotation.apply(forceBody));
    // Torque is frame-independent for a planar body, so compute it in body frame.
    this.torque += pointBody.cross(forceBody);
  }

  /** Apply a world-frame force at the centre of mass. */
  applyForce(forceWorld) {
    this.force.addMut(forceWorld);
  }

  /** Apply a world-frame force at a world-frame point. */
  applyForceAtPoint(forceWorld, pointWorld) {
    this.force.addMut(forceWorld);
    this.torque += Vec2.sub(pointWorld, this.position).cross(forceWorld);
  }

  applyTorque(torque) {
    this.torque += torque;
  }

  /**
   * Instantaneous velocity of a body-fixed point, expressed in the body frame.
   * v_point = v_body + omega x r
   * @param {Vec2} pointBody offset from the centre of mass, body frame
   */
  bodyPointVelocity(pointBody) {
    const v = this.bodyVelocity;
    // omega x r for a planar body is omega * perp(r)
    return new Vec2(v.x - this.angularVelocity * pointBody.y, v.y + this.angularVelocity * pointBody.x);
  }

  /** World-frame velocity of a body-fixed point. */
  worldPointVelocity(pointBody) {
    return this.rotation.apply(this.bodyPointVelocity(pointBody));
  }

  /**
   * Semi-implicit (symplectic) Euler integration: velocity first, then position
   * from the *new* velocity. More stable than explicit Euler for the stiff
   * spring-like contact forces the wheels produce, and it does not artificially
   * add energy the way explicit Euler does.
   * @param {number} dt seconds
   */
  integrate(dt) {
    const ax = this.force.x / this.mass;
    const ay = this.force.y / this.mass;
    const alpha = this.torque / this.momentOfInertia;

    this.acceleration.set(ax, ay);
    this.angularAcceleration = alpha;

    this.velocity.x += ax * dt;
    this.velocity.y += ay * dt;
    this.angularVelocity += alpha * dt;

    this.position.x += this.velocity.x * dt;
    this.position.y += this.velocity.y * dt;

    const dTheta = this.angularVelocity * dt;
    // Compose rather than add-then-trig: cheaper and avoids angle wrapping.
    const c = Math.cos(dTheta);
    const s = Math.sin(dTheta);
    const nc = this.rotation.cos * c - this.rotation.sin * s;
    const ns = this.rotation.cos * s + this.rotation.sin * c;
    this.rotation.cos = nc;
    this.rotation.sin = ns;
    this.rotation.normalize();
  }

  /** Place the body at a pose and zero its motion. */
  reset(x = 0, y = 0, heading = 0) {
    this.position.set(x, y);
    this.rotation.setRadians(heading);
    this.velocity.set(0, 0);
    this.angularVelocity = 0;
    this.force.set(0, 0);
    this.torque = 0;
    this.acceleration.set(0, 0);
    this.angularAcceleration = 0;
    return this;
  }

  /**
   * Moment of inertia of a uniform rectangular slab about its vertical centre
   * axis. A good first estimate for an FTC chassis; the real value is usually
   * 10-30% higher because mass sits at the perimeter (motors, plates, battery).
   * @param {number} mass kg
   * @param {number} length m (along x)
   * @param {number} width m (along y)
   */
  static slabInertia(mass, length, width) {
    return (mass * (length * length + width * width)) / 12;
  }

  /** Guard against a NaN escaping into the render loop and freezing the view. */
  isFinite() {
    return (
      this.position.isFinite() &&
      this.velocity.isFinite() &&
      Number.isFinite(this.angularVelocity) &&
      Number.isFinite(this.rotation.cos) &&
      Number.isFinite(this.rotation.sin)
    );
  }
}
