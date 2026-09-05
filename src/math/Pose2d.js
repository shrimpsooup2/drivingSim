import { Rotation2d } from './Rotation2d.js';
import { Vec2 } from './Vec2.js';

/** Position + heading on the field. */
export class Pose2d {
  /**
   * @param {Vec2} [translation] metres, field frame
   * @param {Rotation2d} [rotation]
   */
  constructor(translation = new Vec2(), rotation = new Rotation2d()) {
    this.translation = translation;
    this.rotation = rotation;
  }

  static fromXYTheta(x, y, theta) {
    return new Pose2d(new Vec2(x, y), Rotation2d.fromRadians(theta));
  }

  get x() {
    return this.translation.x;
  }

  get y() {
    return this.translation.y;
  }

  get heading() {
    return this.rotation.radians;
  }

  clone() {
    return new Pose2d(this.translation.clone(), this.rotation.clone());
  }

  /** Transform a point given in this pose's frame into the parent frame. */
  transformPoint(local) {
    return Vec2.add(this.translation, this.rotation.apply(local));
  }

  /** Transform a point from the parent frame into this pose's frame. */
  inverseTransformPoint(world) {
    return this.rotation.unapply(Vec2.sub(world, this.translation));
  }

  toString() {
    return `Pose2d(x=${this.x.toFixed(3)}, y=${this.y.toFixed(3)}, deg=${this.rotation.degrees.toFixed(1)})`;
  }
}

/** A planar velocity: linear (m/s) plus angular (rad/s). */
export class Twist2d {
  constructor(vx = 0, vy = 0, omega = 0) {
    this.vx = vx;
    this.vy = vy;
    this.omega = omega;
  }

  clone() {
    return new Twist2d(this.vx, this.vy, this.omega);
  }

  get linear() {
    return new Vec2(this.vx, this.vy);
  }

  get speed() {
    return Math.hypot(this.vx, this.vy);
  }
}
