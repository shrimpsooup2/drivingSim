/**
 * An odometry pod: a free-spinning wheel measuring travel in one direction.
 *
 * ## Why a team bolts these on
 *
 * A drive wheel's encoder measures the *wheel*, and a drive wheel spends its
 * life slipping -- it scrubs on every acceleration, a mecanum's rollers scrub
 * all the time, and a pushing match is nothing but slip. So wheel odometry
 * lies, and it lies worst exactly when you most need it. A pod carries no load
 * and drives nothing, so it rolls, and what it measures is how far the floor
 * went past that point on the robot.
 *
 * Ported from the JVM simulator's `DeadWheel`, including the part that is easy
 * to get wrong: the pod is not at the centre of the robot, so when the robot
 * turns the pod is also being carried sideways, and the velocity at the pod's
 * contact patch is
 *
 * ```
 * v_contact = v_robot + omega x r
 *           = (v.x - omega * r.y,  v.y + omega * r.x)
 * ```
 *
 * Project that on the direction the pod rolls and integrate. Dropping the
 * `omega x r` term is the classic mistake, and it is invisible driving in
 * straight lines and ruinous the moment the robot turns.
 *
 * ## What it still gets wrong
 *
 * Ticks are whole numbers, so there is quantisation; and because the pose is an
 * integral, quantisation and every calibration error accumulate rather than
 * averaging out. Those are the things an odometry pod is actually limited by,
 * and they are why a pose that is perfect on a simulator's first metre is 5 cm
 * out after a lap of the field.
 *
 * @module
 */

export class DeadWheel {
  /**
   * @param {{
   *   name?: string,
   *   x?: number, y?: number,
   *   direction?: number,
   *   radius?: number,
   *   ticksPerRev?: number,
   *   reversed?: boolean,
   *   quantise?: boolean,
   * }} [opts]
   */
  constructor(opts = {}) {
    this.name = opts.name ?? 'pod';
    /** Where the pod touches the floor, in the robot frame: +x forward, +y left. */
    this.x = opts.x ?? 0;
    this.y = opts.y ?? 0;
    /**
     * Which way it rolls, radians in the robot frame. 0 measures forward
     * travel; PI/2 measures travel to the robot's left.
     */
    this.direction = opts.direction ?? 0;
    /** goBILDA's 48 mm pod wheel is 24 mm radius. */
    this.radius = opts.radius ?? 0.024;
    /** 2000 for a goBILDA swingarm pod; 8192 for a REV through-bore. */
    this.ticksPerRev = opts.ticksPerRev ?? 2000;
    this.reversed = opts.reversed ?? false;
    this.quantise = opts.quantise ?? true;
    /**
     * An injected fault. A pod is a free-spinning wheel on a spring arm, and
     * the way it fails is that the arm lifts or the wheel jams -- either way it
     * stops counting while the other pod carries on, and the pose walks sideways
     * across the field for no reason the code can see.
     * @type {'none'|'dead'|'stuck'}
     */
    this.fault = 'none';

    this.reset();
  }

  reset() {
    /** Accumulated pod rotation, radians. The one piece of state. */
    this.angle = 0;
    /** Whole ticks last reported, and the change since the one before. */
    this.ticks = 0;
    this.deltaTicks = 0;
    return this;
  }

  /** +1, or -1 for a pod mounted the other way up. */
  get sign() {
    return this.reversed ? -1 : 1;
  }

  /**
   * Roll the pod for one substep.
   *
   * @param {{x: number, y: number}} bodyVelocity chassis velocity in the robot
   *   frame, m/s
   * @param {number} omega yaw rate, rad/s
   * @param {number} dt seconds
   * @returns {number} how far the pod rolled this substep, metres
   */
  step(bodyVelocity, omega, dt) {
    // The contact patch is carried sideways by the robot's rotation.
    const cx = bodyVelocity.x - omega * this.y;
    const cy = bodyVelocity.y + omega * this.x;
    const along = cx * Math.cos(this.direction) + cy * Math.sin(this.direction);
    const travel = along * dt;
    this.angle += travel / this.radius;
    return travel;
  }

  /** Sample it, as a hub read does: whole ticks, and the delta since last time. */
  sample() {
    if (this.fault !== 'none') {
      // Both faults report no movement. `dead` reads zero as well, which is
      // what a disconnected pod does; `stuck` keeps its last count.
      this.deltaTicks = 0;
      if (this.fault === 'dead') this.ticks = 0;
      return this.ticks;
    }
    const exact = (this.sign * this.angle * this.ticksPerRev) / (2 * Math.PI);
    const ticks = this.quantise ? Math.round(exact) : exact;
    this.deltaTicks = ticks - this.ticks;
    this.ticks = ticks;
    return ticks;
  }

  /** Ticks without the rounding, for working out how much the rounding costs. */
  get ticksExact() {
    return (this.sign * this.angle * this.ticksPerRev) / (2 * Math.PI);
  }

  /** Distance the last `sample` reported, in metres. */
  get deltaMetres() {
    return (this.deltaTicks / this.ticksPerRev) * 2 * Math.PI * this.radius;
  }

  /** Total travel as reported, in metres. */
  get metres() {
    return (this.ticks / this.ticksPerRev) * 2 * Math.PI * this.radius;
  }

  /** Total travel with no rounding, in metres. */
  get metresExact() {
    return this.sign * this.angle * this.radius;
  }
}
