/**
 * The odometry computer: two or three pods, and the pose it thinks they mean.
 *
 * A goBILDA Pinpoint or a SparkFun OTOS is a little board that reads the pods,
 * integrates them and hands your op-mode an (x, y, heading) over I2C. This is
 * that board. It exists separately from the pods because *the integration is
 * the interesting part*: the pods are nearly perfect and the pose is not, and
 * everything that makes the difference happens here.
 *
 * ## Why the pose drifts even with perfect pods
 *
 * Because a pose is an integral, so nothing averages out -- every error is
 * permanent and they add up:
 *
 *  - **Heading.** Rotating a displacement by a heading that is 1 degree out
 *    puts it 1.7 cm off per metre driven, and the heading comes from an IMU
 *    that drifts. This is the dominant term by a long way.
 *  - **The yaw scalar.** A Pinpoint's one calibration knob. Get it 2% wrong and
 *    four 90 degree turns leave you 7 degrees out, and then every straight line
 *    after that goes in the wrong direction.
 *  - **Pod offsets.** A pod is not at the centre of the robot, so when the
 *    robot turns the pod is carried sideways and the reading contains that
 *    motion. It has to be taken back out, using the offset you told the board.
 *    `offsetError` is the difference between that and where the pods really
 *    are, and getting it wrong turns rotation into translation: the failure that
 *    looks like a drivetrain problem and is not.
 *  - **Quantisation.** Whole ticks. Small, and it accumulates.
 *
 * All four are modelled, and `error` reports how far the pose has got from the
 * truth -- which is the readout that answers "is my auto's problem the code or
 * the odometry?"
 *
 * ## The pose update
 *
 * A pose exponential rather than a midpoint rotation. Over one cycle the robot
 * follows an arc, not a chord, and integrating the chord is a systematic
 * shortfall on every turn -- small per cycle, and it is the kind of small that
 * a lap of the field turns into centimetres. `sinTerm` and `cosTerm` below are
 * the arc.
 *
 * @module
 */
import { DeadWheel } from './DeadWheel.js';
import { wrapAngle } from '../math/MathUtil.js';

/** @typedef {'twoPod'|'threePod'} OdometryType */

export class Odometry {
  /**
   * @param {{
   *   enabled?: boolean,
   *   type?: OdometryType,
   *   forwardOffset?: number,
   *   lateralOffset?: number,
   *   trackWidth?: number,
   *   podRadius?: number,
   *   ticksPerRev?: number,
   *   yawScalar?: number,
   *   quantise?: boolean,
   * }} [opts]
   */
  constructor(opts = {}) {
    this.enabled = opts.enabled ?? true;
    /** @type {OdometryType} */
    this.type = opts.type ?? 'twoPod';
    /**
     * The knob a Pinpoint asks you to tune. 1 is calibrated; the point of
     * being able to set it is to see what a miscalibrated one does.
     */
    this.yawScalar = opts.yawScalar ?? 1;
    this.build(opts);
    this.reset();
  }

  /**
   * Rebuild the pods from their geometry.
   *
   * `lateralOffset` is how far the *forward* pod sits to the robot's left, and
   * `forwardOffset` is how far ahead the *lateral* pod sits -- which is the
   * confusing pair every Pinpoint setup gets backwards once, so they are named
   * after the pod they move rather than after the axis.
   * @param {object} opts
   */
  build(opts = {}) {
    const radius = opts.podRadius ?? this.podRadius ?? 0.024;
    const ticksPerRev = opts.ticksPerRev ?? this.ticksPerRev ?? 2000;
    const quantise = opts.quantise ?? this.quantise ?? true;
    this.podRadius = radius;
    this.ticksPerRev = ticksPerRev;
    this.quantise = quantise;
    this.lateralOffset = opts.lateralOffset ?? this.lateralOffset ?? -0.08;
    this.forwardOffset = opts.forwardOffset ?? this.forwardOffset ?? 0.06;
    /** Between the two parallel pods of a three-pod setup. */
    this.trackWidth = opts.trackWidth ?? this.trackWidth ?? 0.3;
    /**
     * How far the pods really are from where the board was told they are.
     *
     * The two offsets above are what you typed into the configuration. This is
     * the difference between that and where the pods actually ended up, which
     * is a real quantity -- you measured it off a CAD model or with a ruler, and
     * the board believes you. Getting it wrong is invisible driving straight and
     * turns rotation into translation, which is the failure that looks like a
     * drivetrain problem and is not.
     */
    this.offsetError = opts.offsetError ?? this.offsetError ?? 0;

    const common = { radius, ticksPerRev, quantise };
    /** Measures forward travel. */
    this.forward = new DeadWheel({
      ...common,
      name: 'forward',
      x: 0,
      y: this.lateralOffset + this.offsetError,
      direction: 0,
    });
    /** Measures travel to the robot's left. */
    this.lateral = new DeadWheel({
      ...common,
      name: 'lateral',
      x: this.forwardOffset + this.offsetError,
      y: 0,
      direction: Math.PI / 2,
    });
    /**
     * A second forward pod, so heading can come from the pods instead of an
     * IMU. Two parallel pods a known distance apart measure the difference in
     * travel between the left and right of the robot, which is the yaw rate --
     * no drift, but it does depend on knowing the distance.
     */
    this.forward2 =
      this.type === 'threePod'
        ? new DeadWheel({
            ...common,
            name: 'forward2',
            x: 0,
            y: this.lateralOffset + this.offsetError - this.trackWidth,
            direction: 0,
          })
        : null;
    return this;
  }

  /** Every pod, in a fixed order. */
  get pods() {
    return this.forward2 ? [this.forward, this.lateral, this.forward2] : [this.forward, this.lateral];
  }

  /** Where it thinks the robot is. Degrees nowhere: radians, like the rest. */
  reset(pose = { x: 0, y: 0, heading: 0 }, imuHeading = pose.heading ?? 0) {
    this.pose = { x: pose.x ?? 0, y: pose.y ?? 0, heading: pose.heading ?? 0 };
    for (const pod of this.pods) pod.reset();
    for (const pod of this.pods) pod.sample();
    // Seeded rather than left null, so the first cycle's rotation is accounted
    // for. Left to discover itself on the first sample, that cycle's pod
    // readings go in with no rotation taken out of them -- a millimetre or so,
    // once, and it never comes back out of an integral.
    this._lastHeading = imuHeading;
    /** How far the last update moved the pose, robot frame. For telemetry. */
    this.delta = { x: 0, y: 0, heading: 0 };
    this.updates = 0;
    return this;
  }

  /**
   * Roll the pods. Every physics substep, because the `omega x r` term needs
   * the instantaneous yaw rate and not a cycle average.
   * @param {{x: number, y: number}} bodyVelocity robot-frame velocity, m/s
   * @param {number} omega rad/s
   * @param {number} dt seconds
   */
  step(bodyVelocity, omega, dt) {
    if (!this.enabled) return this;
    for (const pod of this.pods) pod.step(bodyVelocity, omega, dt);
    return this;
  }

  /**
   * Read the pods and advance the pose. Once per control cycle, as the board
   * does it.
   *
   * @param {number} imuHeading the heading the IMU reports, radians -- used
   *   when there is no third pod, drift and all
   * @returns {{x: number, y: number, heading: number}} the pose
   */
  sample(imuHeading) {
    if (!this.enabled) return this.pose;
    for (const pod of this.pods) pod.sample();

    // How much the heading changed since the last reading.
    let dTheta;
    if (this.forward2) {
      // Two parallel pods: the difference in their travel over the distance
      // between them. No drift, but it is only as good as that distance.
      // A pod reads `dx - dTheta * y`, so the *difference* between two parallel
      // pods is `-dTheta * (y1 - y2)`. The minus sign is the one everybody
      // loses, and losing it makes the robot's pose turn the wrong way.
      const spread = this.forward.y - this.forward2.y;
      dTheta = spread === 0 ? 0 : (this.forward2.deltaMetres - this.forward.deltaMetres) / spread;
    } else {
      if (this._lastHeading === null) this._lastHeading = imuHeading;
      dTheta = wrapAngle(imuHeading - this._lastHeading);
      this._lastHeading = imuHeading;
    }
    dTheta *= this.yawScalar;

    // Take the rotation out of what the pods measured, using the offsets we
    // were told. A pod reads the motion of its own contact patch, which is the
    // chassis's motion plus omega x r; the offsets are how it comes back out.
    const dx = this.forward.deltaMetres + dTheta * this.lateralOffset;
    const dy = this.lateral.deltaMetres - dTheta * this.forwardOffset;

    // The arc, not the chord.
    let sinTerm;
    let cosTerm;
    if (Math.abs(dTheta) > 1e-9) {
      sinTerm = Math.sin(dTheta) / dTheta;
      cosTerm = (1 - Math.cos(dTheta)) / dTheta;
    } else {
      sinTerm = 1;
      cosTerm = dTheta / 2;
    }
    const localX = dx * sinTerm - dy * cosTerm;
    const localY = dx * cosTerm + dy * sinTerm;

    const c = Math.cos(this.pose.heading);
    const s = Math.sin(this.pose.heading);
    this.pose.x += c * localX - s * localY;
    this.pose.y += s * localX + c * localY;
    this.pose.heading = wrapAngle(this.pose.heading + dTheta);

    this.delta = { x: dx, y: dy, heading: dTheta };
    this.updates++;
    return this.pose;
  }

  /**
   * How wrong it is, given where the robot really is.
   *
   * Not something a real robot can compute, which is exactly why it is worth
   * having here: "my auto ends up 20 cm short" and "my odometry is 20 cm out"
   * are different problems with different fixes, and on a real field you cannot
   * tell them apart without a tape measure.
   * @param {{x: number, y: number, heading: number}} truth
   */
  error(truth) {
    const dx = this.pose.x - truth.x;
    const dy = this.pose.y - truth.y;
    return {
      x: dx,
      y: dy,
      distance: Math.hypot(dx, dy),
      heading: wrapAngle(this.pose.heading - truth.heading),
    };
  }

  /** Apply a changed `odometry` config block. Rebuilds if the geometry moved. */
  applySettings(cfg) {
    if (!cfg) return this;
    const geometryChanged =
      cfg.type !== this.type ||
      cfg.lateralOffset !== this.lateralOffset ||
      cfg.forwardOffset !== this.forwardOffset ||
      cfg.trackWidth !== this.trackWidth ||
      cfg.podRadius !== this.podRadius ||
      cfg.ticksPerRev !== this.ticksPerRev ||
      cfg.offsetError !== this.offsetError ||
      cfg.quantise !== this.quantise;
    this.enabled = cfg.enabled !== false;
    this.yawScalar = cfg.yawScalar ?? this.yawScalar;
    if (geometryChanged) {
      this.type = cfg.type ?? this.type;
      const at = { ...this.pose };
      this.build(cfg);
      // Keep the pose: changing a pod offset should not teleport the estimate,
      // it should change how the estimate moves from here.
      this.reset(at);
    }
    return this;
  }
}
