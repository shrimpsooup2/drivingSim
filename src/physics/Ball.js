/**
 * A SCORING ELEMENT: a POLLEN or NECTAR ball.
 *
 * State is stored as flat scalars rather than vector objects. There are 56 of
 * them stepping a few hundred times a second, and the flat form keeps the inner
 * loop allocation-free.
 *
 * A ball is either **free** (obeying gravity and collisions in BallWorld) or
 * **contained** by something that has taken ownership of it -- a robot's
 * intake, a HIVE CELL, or a FLOWER. A contained ball is skipped by the free
 * physics entirely and positioned by whatever holds it, which is both cheaper
 * and the only way to get stable stacking inside a FLOWER tube.
 */

/** @typedef {'pollen'|'nectar'} BallKind */
/** @typedef {'red'|'blue'|'neutral'} Alliance */

export class Ball {
  /**
   * @param {{
   *   id: string,
   *   kind: BallKind,
   *   alliance?: Alliance,
   *   radius: number,
   *   mass: number,
   *   x?: number, y?: number, z?: number,
   *   restitution?: number,
   *   rollingResistance?: number,
   * }} opts
   */
  constructor(opts) {
    this.id = opts.id;
    this.kind = opts.kind;
    /** POLLEN is neutral; NECTAR belongs to an ALLIANCE. */
    this.alliance = opts.alliance ?? 'neutral';
    this.radius = opts.radius;
    this.mass = opts.mass;
    this.restitution = opts.restitution ?? 0.45;
    /** Fraction of weight lost to rolling on foam tiles, per unit speed. */
    this.rollingResistance = opts.rollingResistance ?? 0.06;

    this.x = opts.x ?? 0;
    this.y = opts.y ?? 0;
    this.z = opts.z ?? this.radius;
    this.vx = 0;
    this.vy = 0;
    this.vz = 0;

    /**
     * What currently owns this ball, or null when it is loose on the field.
     * @type {{kind: string, ref: any}|null}
     */
    this.container = null;
    /** True once the ball has left the FIELD (through a gap or over a wall). */
    this.outOfBounds = false;
    /** Set while the ball is resting on the tiles, for rolling resistance. */
    this.onFloor = false;
  }

  get free() {
    return this.container === null;
  }

  get speed() {
    return Math.hypot(this.vx, this.vy, this.vz);
  }

  /** Horizontal speed only; used to decide when a ball has settled. */
  get groundSpeed() {
    return Math.hypot(this.vx, this.vy);
  }

  setPosition(x, y, z) {
    this.x = x;
    this.y = y;
    this.z = z;
    return this;
  }

  setVelocity(vx, vy, vz) {
    this.vx = vx;
    this.vy = vy;
    this.vz = vz;
    return this;
  }

  stop() {
    this.vx = 0;
    this.vy = 0;
    this.vz = 0;
    return this;
  }

  /** Hand the ball to a container, which becomes responsible for its position. */
  /**
   * Hand this ball to a container -- an intake, a CELL, a FLOWER.
   *
   * The previous container is told to let go first. Without that a ball ends up
   * in two containers at once and both keep writing its position every step,
   * so whichever runs last wins and the other silently loses its contents.
   *
   * @param {string} kind
   * @param {{detachBall?: (ball: Ball) => void}|null} ref
   */
  attachTo(kind, ref) {
    this._leaveContainer(ref);
    this.container = { kind, ref };
    this.stop();
    this.onFloor = false;
    return this;
  }

  /** Tell the current container to drop this ball, unless it is `keeping` it. */
  _leaveContainer(keeping = null) {
    const previous = this.container?.ref;
    if (previous && previous !== keeping && typeof previous.detachBall === 'function') {
      previous.detachBall(this);
    }
  }

  /**
   * Turn this ball loose with a velocity, letting its container know.
   * @param {number} [vx]
   * @param {number} [vy]
   * @param {number} [vz]
   */
  release(vx = 0, vy = 0, vz = 0) {
    this._leaveContainer();
    this.container = null;
    this.vx = vx;
    this.vy = vy;
    this.vz = vz;
    this.onFloor = false;
    return this;
  }

  isFinite() {
    return (
      Number.isFinite(this.x) && Number.isFinite(this.y) && Number.isFinite(this.z) &&
      Number.isFinite(this.vx) && Number.isFinite(this.vy) && Number.isFinite(this.vz)
    );
  }
}
