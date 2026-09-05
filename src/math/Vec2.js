/**
 * 2D vector.
 *
 * The physics runs entirely in the ground plane, so every force, velocity and
 * position in the simulator is a Vec2. Instances are mutable and the class
 * offers in-place variants (`addMut`, `scaleMut`, ...) for the hot per-wheel
 * loop, which runs a few hundred times per second per wheel.
 */
export class Vec2 {
  /**
   * @param {number} [x]
   * @param {number} [y]
   */
  constructor(x = 0, y = 0) {
    this.x = x;
    this.y = y;
  }

  static zero() {
    return new Vec2(0, 0);
  }

  /** Unit vector at `angle` radians from +x, scaled by `length`. */
  static fromAngle(angle, length = 1) {
    return new Vec2(Math.cos(angle) * length, Math.sin(angle) * length);
  }

  static add(a, b) {
    return new Vec2(a.x + b.x, a.y + b.y);
  }

  static sub(a, b) {
    return new Vec2(a.x - b.x, a.y - b.y);
  }

  static scale(a, s) {
    return new Vec2(a.x * s, a.y * s);
  }

  static dot(a, b) {
    return a.x * b.x + a.y * b.y;
  }

  /** Scalar cross product (z component of a x b). */
  static cross(a, b) {
    return a.x * b.y - a.y * b.x;
  }

  static distance(a, b) {
    return Math.hypot(a.x - b.x, a.y - b.y);
  }

  clone() {
    return new Vec2(this.x, this.y);
  }

  set(x, y) {
    this.x = x;
    this.y = y;
    return this;
  }

  copyFrom(v) {
    this.x = v.x;
    this.y = v.y;
    return this;
  }

  addMut(v) {
    this.x += v.x;
    this.y += v.y;
    return this;
  }

  /** this += v * s */
  addScaledMut(v, s) {
    this.x += v.x * s;
    this.y += v.y * s;
    return this;
  }

  subMut(v) {
    this.x -= v.x;
    this.y -= v.y;
    return this;
  }

  scaleMut(s) {
    this.x *= s;
    this.y *= s;
    return this;
  }

  dot(v) {
    return this.x * v.x + this.y * v.y;
  }

  cross(v) {
    return this.x * v.y - this.y * v.x;
  }

  length() {
    return Math.hypot(this.x, this.y);
  }

  lengthSquared() {
    return this.x * this.x + this.y * this.y;
  }

  angle() {
    return Math.atan2(this.y, this.x);
  }

  /** Unit vector in the same direction; returns (0,0) for a zero vector. */
  normalized() {
    const len = this.length();
    return len > 1e-12 ? new Vec2(this.x / len, this.y / len) : new Vec2(0, 0);
  }

  /** Rotate 90 degrees counter-clockwise: (x, y) -> (-y, x). */
  perp() {
    return new Vec2(-this.y, this.x);
  }

  /** Rotate by `angle` radians counter-clockwise. */
  rotated(angle) {
    const c = Math.cos(angle);
    const s = Math.sin(angle);
    return new Vec2(this.x * c - this.y * s, this.x * s + this.y * c);
  }

  /** Rotate by a precomputed (cos, sin) pair. Cheaper inside per-wheel loops. */
  rotatedBy(cos, sin) {
    return new Vec2(this.x * cos - this.y * sin, this.x * sin + this.y * cos);
  }

  /** Inverse of `rotatedBy`: rotate by -angle. */
  unrotatedBy(cos, sin) {
    return new Vec2(this.x * cos + this.y * sin, -this.x * sin + this.y * cos);
  }

  /** Scale so the length is at most `max`. */
  clampedLength(max) {
    const len = this.length();
    if (len <= max || len < 1e-12) return this.clone();
    return new Vec2((this.x / len) * max, (this.y / len) * max);
  }

  isFinite() {
    return Number.isFinite(this.x) && Number.isFinite(this.y);
  }

  toString() {
    return `(${this.x.toFixed(4)}, ${this.y.toFixed(4)})`;
  }
}
