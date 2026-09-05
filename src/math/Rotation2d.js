import { TAU, wrapAngle } from './MathUtil.js';
import { Vec2 } from './Vec2.js';

/**
 * A planar rotation stored as a (cos, sin) pair.
 *
 * Storing the pair rather than the raw angle means the per-substep body <-> world
 * frame conversions never call Math.cos/Math.sin, and composing rotations never
 * needs angle wrapping.
 */
export class Rotation2d {
  /**
   * @param {number} cos
   * @param {number} sin
   */
  constructor(cos = 1, sin = 0) {
    this.cos = cos;
    this.sin = sin;
  }

  static fromRadians(rad) {
    return new Rotation2d(Math.cos(rad), Math.sin(rad));
  }

  static fromDegrees(deg) {
    return Rotation2d.fromRadians((deg * Math.PI) / 180);
  }

  /** Direction of a vector, or identity for a zero vector. */
  static fromVector(v) {
    const len = Math.hypot(v.x, v.y);
    return len > 1e-12 ? new Rotation2d(v.x / len, v.y / len) : new Rotation2d(1, 0);
  }

  get radians() {
    return Math.atan2(this.sin, this.cos);
  }

  get degrees() {
    return (this.radians * 180) / Math.PI;
  }

  clone() {
    return new Rotation2d(this.cos, this.sin);
  }

  setRadians(rad) {
    this.cos = Math.cos(rad);
    this.sin = Math.sin(rad);
    return this;
  }

  /** this * other (compose rotations). */
  rotateBy(other) {
    return new Rotation2d(
      this.cos * other.cos - this.sin * other.sin,
      this.cos * other.sin + this.sin * other.cos,
    );
  }

  inverse() {
    return new Rotation2d(this.cos, -this.sin);
  }

  /** Rotate a vector from body frame into world frame. */
  apply(v) {
    return new Vec2(v.x * this.cos - v.y * this.sin, v.x * this.sin + v.y * this.cos);
  }

  /** Rotate a vector from world frame into body frame. */
  unapply(v) {
    return new Vec2(v.x * this.cos + v.y * this.sin, -v.x * this.sin + v.y * this.cos);
  }

  toVector() {
    return new Vec2(this.cos, this.sin);
  }

  /** Shortest signed angle from this rotation to `other`, in (-pi, pi]. */
  distanceTo(other) {
    return wrapAngle(other.radians - this.radians);
  }

  /** Renormalise after accumulating many incremental rotations. */
  normalize() {
    const n = Math.hypot(this.cos, this.sin);
    if (n > 1e-12) {
      this.cos /= n;
      this.sin /= n;
    } else {
      this.cos = 1;
      this.sin = 0;
    }
    return this;
  }

  static get TAU() {
    return TAU;
  }
}
