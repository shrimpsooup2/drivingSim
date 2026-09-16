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
   *   dragCoefficient?: number,
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

    /**
     * Drag coefficient.
     *
     * These are *wiffle balls*, and that matters more than it looks. A smooth
     * sphere in this Reynolds range sits near 0.5; the perforations push a
     * wiffle ball up towards 0.6, and it is very light for its size -- a 45 g
     * POLLEN is 71 mm across. At 7 m/s the drag on one is 0.070 N against a
     * weight of 0.44 N, so it decelerates at 1.6 m/s^2, a sixth of gravity.
     * Ignoring that overstates the range of a shot by about a fifth.
     *
     * A NECTAR is heavier for its frontal area, so it is less affected -- but
     * only by about a tenth, since what matters is `r^2 / m` and 1.81 in at
     * 85 g is not far off 1.4 in at 45 g. A small consistent bias between the
     * two element types rather than a large one.
     */
    this.dragCoefficient = opts.dragCoefficient ?? 0.6;

    this.x = opts.x ?? 0;
    this.y = opts.y ?? 0;
    this.z = opts.z ?? this.radius;
    /**
     * Ceiling on this ball's speed for the current physics step, set by
     * `BallWorld.step` and raised by each contact to what that contact could
     * have imparted. Undefined outside a step; see
     * `BallWorld._boundContactSpeed` for why it exists.
     * @type {number|undefined}
     */
    this.contactSpeedBound = undefined;
    this.vx = 0;
    this.vy = 0;
    this.vz = 0;

    /**
     * Angular velocity, rad/s.
     *
     * Modelled because it is what makes a landing look right. A ball that
     * arrives with horizontal speed and no spin has to *scrub* against the
     * tiles until its contact point stops sliding, and that transition -- skid,
     * then roll -- is most of what "it bounced and rolled away" looks like.
     * Without it a ball landed and slid, and a pile pushed apart along clean
     * lines of centres instead of scattering.
     */
    this.wx = 0;
    this.wy = 0;
    this.wz = 0;

    /**
     * What currently owns this ball, or null when it is loose on the field.
     * @type {{kind: string, ref: any}|null}
     */
    this.container = null;
    /** True once the ball has left the FIELD (through a gap or over a wall). */
    this.outOfBounds = false;
    /** Set while the ball is resting on the tiles, for rolling resistance. */
    this.onFloor = false;

    /**
     * The last ROBOT to touch this element, and how.
     *
     * Provenance, not physics -- G405 turns entirely on it. "A ROBOT may not
     * *deliberately* eject a SCORING ELEMENT from the FIELD", and the rule then
     * exempts elements that leave "during scoring attempts or as the result of
     * ROBOT-to-ROBOT interactions". So the same POLLEN sailing over the same
     * wall is a 20-point foul or nothing at all depending on which of three
     * things put it there, and the only place that can be known is where the
     * contact happened.
     *
     * `kind` is `'launch'` for a shot, `'eject'` for an intake spitting it out,
     * `'carry'` for one let go of, and `'contact'` for a plain collision.
     * `contested` marks a contact made while that ROBOT was itself touching an
     * opponent, which is the ROBOT-to-ROBOT exemption.
     *
     * @type {{id: string, alliance: string, kind: string, contested: boolean,
     *         t: number}|null}
     */
    this.lastTouch = null;
    /**
     * Set while this element is falling out of a TIPPING HIVE and has touched
     * nothing but a ROBOT since (G409). Cleared by the first contact with
     * anything else -- the TILES, a wall, the frame, another element.
     * @type {{alliance: string, t: number}|null}
     */
    this.fromTip = null;
    /**
     * A G409 catch waiting to be reported: a ROBOT touched this element while
     * `fromTip` was still set. The REFEREE takes it and clears it.
     * @type {{id: string, alliance: string}|null}
     */
    this.caughtFromTip = null;
    /** FIELD clock when this element left the FIELD, or null. @type {number|null} */
    this.leftFieldAt = null;
  }

  /**
   * Record a ROBOT touching this element.
   *
   * Also resolves G409 here rather than in the caller: a ROBOT contact while
   * `fromTip` is set *is* the catch, and this is the one place that sees both.
   *
   * @param {string} kind `'launch'`, `'eject'`, `'carry'` or `'contact'`
   * @param {{id?: string, alliance?: string, contested?: boolean}|null} source
   * @param {number} [t] field clock, for staleness
   */
  touch(kind, source, t = 0) {
    if (!source?.id) return this;
    this.lastTouch = {
      id: source.id,
      alliance: source.alliance ?? 'neutral',
      kind,
      contested: Boolean(source.contested),
      t,
    };
    if (this.fromTip && !this.caughtFromTip) {
      this.caughtFromTip = { id: source.id, alliance: source.alliance ?? 'neutral' };
    }
    return this;
  }

  /**
   * Note that this element has touched something that is not a ROBOT, which is
   * what ends the G409 window.
   */
  touchedStructure() {
    this.fromTip = null;
    return this;
  }

  get free() {
    return this.container === null;
  }

  get speed() {
    return Math.hypot(this.vx, this.vy, this.vz);
  }

  /** Frontal area, for drag. */
  get area() {
    return Math.PI * this.radius * this.radius;
  }

  /**
   * Moment of inertia about a diameter: a hollow-ish plastic sphere.
   *
   * A solid sphere is `0.4 m r^2` and a thin shell `2/3 m r^2`. A wiffle ball
   * is a shell with holes in it, so it sits near the shell value -- 0.6 here,
   * which matters because it sets how quickly a skidding ball spins up into a
   * roll.
   */
  get spinInertia() {
    return 0.6 * this.mass * this.radius * this.radius;
  }

  /** How fast it is spinning, rad/s. */
  get spinRate() {
    return Math.hypot(this.wx, this.wy, this.wz);
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
    this.wx = 0;
    this.wy = 0;
    this.wz = 0;
    return this;
  }

  setSpin(wx, wy, wz) {
    this.wx = wx;
    this.wy = wy;
    this.wz = wz;
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
  release(vx = 0, vy = 0, vz = 0, spin = null) {
    this._leaveContainer();
    this.container = null;
    this.vx = vx;
    this.vy = vy;
    this.vz = vz;
    // A launched element leaves a flywheel spinning hard; anything simply let
    // go leaves with none.
    this.wx = spin?.wx ?? 0;
    this.wy = spin?.wy ?? 0;
    this.wz = spin?.wz ?? 0;
    this.onFloor = false;
    return this;
  }

  isFinite() {
    return (
      Number.isFinite(this.wx) &&
      Number.isFinite(this.wy) &&
      Number.isFinite(this.wz) &&
      Number.isFinite(this.x) && Number.isFinite(this.y) && Number.isFinite(this.z) &&
      Number.isFinite(this.vx) && Number.isFinite(this.vy) && Number.isFinite(this.vz)
    );
  }
}
