import { Vec2 } from '../../math/Vec2.js';
import { INCH } from '../../math/MathUtil.js';
import {
  CELL_MEASURED_WIDTH,
  CELL_NEAR_REACH,
  CELL_FAR_REACH,
  CELL_REST_HEIGHT,
  CELL_REST_OFFSET,
  HIVE_PIVOT_HEIGHT,
  HIVE_TILT,
  INFERRED,
  NECTAR_MASS,
} from './constants.js';

const G = 9.80665;

/**
 * Where an element rests inside a CELL, in the HIVE's own frame: along the arm
 * from the pivot, and perpendicular to it.
 *
 * Solved from the one thing the CAD measures directly -- the three NECTAR
 * staged in the upward CELL, 9.4 in from the pivot and 50.2 in up, with the arm
 * at 30 degrees. Rotating that back into the body frame puts them 11.27 in
 * along the arm and 0.71 in above its axis, which is where a ball sitting on
 * the floor of a basket bolted to a 1 in tube should be.
 */
const REST_ALONG =
  CELL_REST_OFFSET * Math.cos(HIVE_TILT) +
  (CELL_REST_HEIGHT - HIVE_PIVOT_HEIGHT) * Math.sin(HIVE_TILT);
const REST_ACROSS =
  -CELL_REST_OFFSET * Math.sin(HIVE_TILT) +
  (CELL_REST_HEIGHT - HIVE_PIVOT_HEIGHT) * Math.cos(HIVE_TILT);

/**
 * One ALLIANCE's HIVE: a bi-stable see-saw with a CELL at each end, tipping
 * under its own rotational dynamics.
 *
 * Section 9.6.2: "Each HIVE is a bi-stable structure made up of two CELLS and a
 * connecting assembly that rotates on a pivot... has two stable positions: each
 * one with one CELL facing upwards."
 *
 * ## Where the bi-stability comes from
 *
 * A see-saw with two identical ends has no gravity torque at all if its centre
 * of gravity sits on the pivot -- it would be neutral at every angle, not
 * bi-stable. Bi-stability needs the CG **above** the pivot: then level is an
 * *unstable* equilibrium and the arm runs to whichever stop it is nearest and
 * stays there. That is the over-centre latch the manual is describing, and it
 * is the whole mechanism, so this class integrates it rather than comparing a
 * mass against a threshold.
 *
 * With the arm at angle `t` from level, CG a distance `h` above the pivot, and
 * an element of mass `m` sitting at `(u, v)` in the body frame:
 *
 *     structure torque = +M*g*h*sin(t)          (holds the arm on its stop)
 *     element torque   = -m*g*(u*cos t - v*sin t)
 *
 * so weight in the *raised* CELL fights the latch, and the HIVE goes over when
 * the elements win. Three consequences fall out that a threshold cannot give:
 *
 *  - **Where a ball lands matters.** The lever arm is `u`, so an element that
 *    settles deeper into the CELL tips the HIVE more easily than one resting
 *    near the lip. Accurate shooting is worth something beyond just landing it.
 *  - **The rotation takes real time**, set by inertia and by the soft-close
 *    dampers the CAD fits to each pivot, and elements can be launched into a
 *    CELL that is already on its way over.
 *  - **Elements fall out because the CELL rotates past horizontal**, carrying
 *    the arm's speed with them, rather than being teleported out by a script.
 *
 * ## The one number that is not measured
 *
 * The structure's mass and CG height are not published and a STEP file carries
 * no density, so `M*h` cannot be measured. It is parameterised instead by
 * `holdMass`: the weight of elements, resting at the measured point in the
 * raised CELL, that the latch will just hold. That is directly interpretable
 * and it is pinned at one end by the manual -- three NECTAR are staged in the
 * upward CELL of every HIVE (Section 10.3.1) and must not tip it.
 */
export class Hive {
  /**
   * @param {{
   *   alliance: 'red'|'blue',
   *   pivotX: number,
   *   tilt?: number,
   *   holdMass?: number,
   *   structureMass?: number,
   *   openingAngle?: number,
   *   damping?: number,
   *   startUp?: 'fore'|'aft',
   * }} opts
   */
  constructor(opts) {
    this.alliance = opts.alliance;
    this.pivotX = opts.pivotX;
    /** Angle of each stop, from level. CAD: 30 degrees. */
    this.tilt = opts.tilt ?? HIVE_TILT;

    /**
     * Element mass in the raised CELL that the latch will just hold.
     *
     * Three NECTAR is 0.255 kg and must hold, so this has to be above that;
     * one more element has to take it over, so it cannot be far above. 0.28 kg
     * leaves 10 percent of margin on the staged load and tips on the next
     * POLLEN, and means about seven POLLEN from empty.
     */
    this.holdMass = opts.holdMass ?? 0.28;
    /**
     * Mass of the moving structure, used only for its rotational inertia --
     * two sheet-metal baskets and a tube, so a few kilograms.
     */
    this.structureMass = opts.structureMass ?? 2.7;
    /**
     * How far the CELL opening is tilted outward from the arm's perpendicular.
     * At the up stop this leaves the opening 30 degrees from vertical, facing
     * out into the FIELD, and at the down stop it has rotated past horizontal
     * so the CELL empties itself. It is the one shape the part bounding boxes
     * cannot pin down.
     */
    this.openingAngle = opts.openingAngle ?? (60 * Math.PI) / 180;
    /**
     * Damping at the pivot, from the four Blumotion 970A soft-close dampers the
     * CAD fits to it.
     *
     * A soft-close damper is not a constant dashpot -- it engages over the last
     * part of the travel and is nearly free before that, which is the point of
     * one. Modelling it as constant viscous damping instead makes the tip crawl
     * through the middle of its stroke, where the over-centre torque passes
     * through zero and there is little to push it: near three seconds rather
     * than under one.
     */
    this.damping = opts.damping ?? 0.05;
    this.dampingAtStop = opts.dampingAtStop ?? 1.1;
    /** Fraction of the travel at which the dampers start to bite. */
    this.dampingEngage = opts.dampingEngage ?? 0.55;

    /** Which CELL is up, committed at the stops. 'fore' is -y, 'aft' is +y. */
    this.up = opts.startUp ?? 'fore';
    /** Arm angle from level. Positive means the aft CELL is raised. */
    this.angle = this.up === 'aft' ? this.tilt : -this.tilt;
    this.angularVelocity = 0;

    /** @type {import('../../physics/Ball.js').Ball[]} */
    this.foreBalls = [];
    /** @type {import('../../physics/Ball.js').Ball[]} */
    this.aftBalls = [];

    this.tips = 0;
    /** Tips completed before TELEOP began, scored as AUTO per Section 10.5.B. */
    this.autoTips = 0;
    /** Balls thrown clear, for the caller to re-add to the world. */
    this.spilled = [];
  }

  /**
   * The latch's holding moment, `M*h`, derived from `holdMass`.
   *
   * At the stop, holding requires `M*h*sin(tilt) >= m*(u*cos tilt - v*sin tilt)`,
   * so this is that equality solved for `M*h` at `m = holdMass`.
   */
  get holdingMoment() {
    const lever = REST_ALONG * Math.cos(this.tilt) - REST_ACROSS * Math.sin(this.tilt);
    return (this.holdMass * lever) / Math.sin(this.tilt);
  }

  /**
   * Damping at the current angle. Free through the middle of the stroke, rising
   * into the stops the way a soft-close damper does.
   */
  get dampingNow() {
    const travel = Math.abs(this.angle) / this.tilt;
    if (travel <= this.dampingEngage) return this.damping;
    const into = (travel - this.dampingEngage) / (1 - this.dampingEngage);
    return this.damping + (this.dampingAtStop - this.damping) * into * into;
  }

  /** Rotational inertia of the structure alone, about the pivot. */
  get structureInertia() {
    // Two baskets, most of the mass out near the CELLS.
    const radius = (CELL_NEAR_REACH + CELL_FAR_REACH) / 2;
    return this.structureMass * radius * radius;
  }

  /** Balls currently in the upward-facing CELL. */
  get upBalls() {
    return this.up === 'fore' ? this.foreBalls : this.aftBalls;
  }

  /** Balls in the downward-facing CELL. Should always be empty once settled. */
  get downBalls() {
    return this.up === 'fore' ? this.aftBalls : this.foreBalls;
  }

  get containedMass() {
    let total = 0;
    for (const ball of this.foreBalls) total += ball.mass;
    for (const ball of this.aftBalls) total += ball.mass;
    return total;
  }

  /** Signed tilt of the arm. Kept for the renderer. */
  get currentTilt() {
    return this.angle;
  }

  /** True while the arm is away from a stop, or moving. */
  get tipping() {
    return Math.abs(Math.abs(this.angle) - this.tilt) > 1e-4 || Math.abs(this.angularVelocity) > 1e-3;
  }

  /** How far through a tip the arm is, 0 to 1, for the renderer. */
  get tipProgress() {
    return Math.min(1, Math.max(0, (this.tilt - this.angle * Math.sign(this.angle || 1)) / (2 * this.tilt)));
  }

  /**
   * Sign of a side in the body frame: 'aft' is the +along end.
   * @param {'fore'|'aft'} side
   */
  _sideSign(side) {
    return side === 'aft' ? 1 : -1;
  }

  /** Rotate a body-frame (along, across) pair into world (y, z) offsets. */
  _toWorld(along, across) {
    const c = Math.cos(this.angle);
    const s = Math.sin(this.angle);
    return { y: along * c - across * s, z: along * s + across * c };
  }

  /**
   * Centre of a CELL's opening, in field coordinates: the point an element
   * comes to rest on.
   *
   * The two CELLS are mirror images across the pivot rather than 180 degree
   * rotations of each other -- both open upward when their own end is raised --
   * so the perpendicular offset keeps its sign and only the along-arm term
   * flips.
   *
   * @param {'fore'|'aft'} side
   * @returns {{x:number, y:number, z:number}}
   */
  cellOpening(side) {
    const offset = this._toWorld(this._sideSign(side) * REST_ALONG, REST_ACROSS);
    return { x: this.pivotX, y: offset.y, z: HIVE_PIVOT_HEIGHT + offset.z };
  }

  /** Opening of whichever CELL currently faces up: the thing to shoot at. */
  get target() {
    return this.cellOpening(this.up);
  }

  /**
   * Upward component of a CELL's opening normal, 1 when it faces straight up
   * and negative once it has rolled past horizontal and cannot hold anything.
   * @param {'fore'|'aft'} side
   */
  openingUpwardness(side) {
    const sign = this._sideSign(side);
    // Body-frame normal (sign*sin(phi), cos(phi)); its world vertical component.
    return (
      sign * Math.sin(this.openingAngle) * Math.sin(this.angle) +
      Math.cos(this.openingAngle) * Math.cos(this.angle)
    );
  }

  /**
   * Net torque about the pivot, N*m. Positive drives the aft CELL upward.
   * Exposed because it is the whole mechanism and worth being able to read.
   */
  get netTorque() {
    let torque = this.holdingMoment * G * Math.sin(this.angle);
    const c = Math.cos(this.angle);
    const s = Math.sin(this.angle);
    for (const side of ['fore', 'aft']) {
      const sign = this._sideSign(side);
      const along = sign * REST_ALONG;
      const balls = side === 'fore' ? this.foreBalls : this.aftBalls;
      for (const ball of balls) {
        torque -= ball.mass * G * (along * c - REST_ACROSS * s);
      }
    }
    return torque;
  }

  /**
   * Put a ball straight into the upward-facing CELL, bypassing the capture
   * test. Section 10.3.1 stages three NECTAR there before the MATCH.
   * @param {import('../../physics/Ball.js').Ball} ball
   */
  stage(ball) {
    this.upBalls.push(ball);
    ball.attachTo('cell', this);
    this._restackCell();
    return ball;
  }

  /**
   * Try to capture a free ball into the upward-facing CELL.
   *
   * The capture volume is the CELL's mouth, inflated slightly, and the ball
   * must be falling -- a ball rising through the plane is on its way out. A
   * CELL that has rolled too far to hold anything refuses outright.
   *
   * @param {import('../../physics/Ball.js').Ball} ball
   */
  interactBall(ball) {
    const side = this.up;
    if (this.openingUpwardness(side) < 0.35) return false;
    if (ball.vz > 0.4) return false;

    const opening = this.cellOpening(side);
    const margin = INFERRED.cellCaptureMargin;
    if (Math.abs(ball.x - opening.x) > CELL_MEASURED_WIDTH / 2 + margin) return false;

    // Measure along and across the arm rather than in world axes, so the
    // volume follows the CELL as it rotates.
    const dy = ball.y - opening.y;
    const dz = ball.z - opening.z;
    const c = Math.cos(this.angle);
    const s = Math.sin(this.angle);
    const along = dy * c + dz * s;
    const across = -dy * s + dz * c;
    const depth = (CELL_FAR_REACH - CELL_NEAR_REACH) / 2 + margin;
    if (Math.abs(along) > depth) return false;
    if (across < -margin || across > depth * 2) return false;

    this.upBalls.push(ball);
    ball.attachTo('cell', this);
    this._restackCell();
    return true;
  }

  /**
   * Drop a ball, because something else has taken it. Called by the ball, so a
   * CELL never keeps restacking an element that has gone elsewhere.
   * @param {import('../../physics/Ball.js').Ball} ball
   */
  detachBall(ball) {
    for (const list of [this.foreBalls, this.aftBalls, this.spilled]) {
      const i = list.indexOf(ball);
      if (i >= 0) list.splice(i, 1);
    }
  }

  /** Lay the contained balls out inside each CELL so they render sensibly. */
  _restackCell() {
    for (const side of ['fore', 'aft']) {
      const balls = side === 'fore' ? this.foreBalls : this.aftBalls;
      if (balls.length === 0) continue;
      const sign = this._sideSign(side);
      const perRow = Math.max(1, Math.floor(CELL_MEASURED_WIDTH / (3.8 * INCH)));
      const spread = CELL_MEASURED_WIDTH / (perRow + 1);
      balls.forEach((ball, i) => {
        const row = Math.floor(i / perRow);
        const column = i % perRow;
        // Deeper rows sit further out along the arm and a little higher, which
        // is also why a full CELL tips more readily than a nearly empty one.
        const offset = this._toWorld(
          sign * (REST_ALONG + row * ball.radius * 1.7),
          REST_ACROSS + row * ball.radius * 0.5,
        );
        ball.setPosition(
          this.pivotX - CELL_MEASURED_WIDTH / 2 + spread * (column + 1),
          offset.y,
          HIVE_PIVOT_HEIGHT + offset.z,
        );
        ball.stop();
      });
    }
  }

  /**
   * Advance the HIVE: integrate the arm, stop at the latches, and let go of
   * anything a CELL can no longer hold.
   *
   * @param {number} dt seconds
   * @param {boolean} inAuto whether the MATCH is still in AUTO
   */
  update(dt, inAuto) {
    let inertia = this.structureInertia;
    for (const side of ['fore', 'aft']) {
      const balls = side === 'fore' ? this.foreBalls : this.aftBalls;
      for (const ball of balls) {
        const r = Math.hypot(REST_ALONG, REST_ACROSS);
        inertia += ball.mass * r * r;
      }
    }

    // Semi-implicit in the damping term so a stiff damper cannot ring.
    const alpha = this.netTorque / inertia;
    this.angularVelocity =
      (this.angularVelocity + alpha * dt) / (1 + (this.dampingNow * dt) / inertia);
    this.angle += this.angularVelocity * dt;

    if (this.angle >= this.tilt) {
      this.angle = this.tilt;
      if (this.angularVelocity > 0) this.angularVelocity = 0;
    } else if (this.angle <= -this.tilt) {
      this.angle = -this.tilt;
      if (this.angularVelocity < 0) this.angularVelocity = 0;
    }

    this._releaseWhatCannotBeHeld();

    // A TIP is the arm crossing centre to the other side. Comparing against the
    // committed side rather than the previous step's sign means hovering at
    // exactly level cannot register a tip that never happened.
    const side = this.angle > 0 ? 'aft' : this.angle < 0 ? 'fore' : null;
    if (side && side !== this.up) {
      this.up = side;
      this.tips++;
      if (inAuto) this.autoTips++;
    }

    if (this.foreBalls.length || this.aftBalls.length) this._restackCell();
    return this;
  }

  /**
   * Let go of everything in a CELL that has rotated too far to hold it. The
   * balls leave with the speed that point of the arm is actually moving at, so
   * a fast tip throws them clear and a slow one just lets them roll out.
   */
  _releaseWhatCannotBeHeld() {
    for (const side of ['fore', 'aft']) {
      if (this.openingUpwardness(side) >= 0.1) continue;
      const balls = side === 'fore' ? this.foreBalls : this.aftBalls;
      if (balls.length === 0) continue;

      const sign = this._sideSign(side);
      for (const ball of balls.slice()) {
        // Velocity of the arm at the ball: omega cross r, in the y-z plane.
        const offset = this._toWorld(sign * REST_ALONG, REST_ACROSS);
        const vy = -this.angularVelocity * offset.z;
        const vz = this.angularVelocity * offset.y;
        ball.setPosition(
          this.pivotX + (Math.random() * 2 - 1) * CELL_MEASURED_WIDTH * 0.3,
          offset.y,
          HIVE_PIVOT_HEIGHT + offset.z,
        );
        // A little sideways scatter, so a tipped load does not land in a
        // single stack under the hive.
        ball.release((Math.random() * 2 - 1) * 0.25, vy, vz);
        this.spilled.push(ball);
      }
    }
  }

  /** Collect and clear the balls the HIVE has let go of. */
  takeSpilled() {
    const out = this.spilled;
    this.spilled = [];
    return out;
  }

  /**
   * Scoring at rest, per Section 10.5.1: elements left in the upward-facing
   * CELL earn 2 each for that ALLIANCE.
   */
  elementsInUpCell() {
    return this.upBalls.length;
  }

  reset(startUp = 'fore') {
    this.foreBalls.length = 0;
    this.aftBalls.length = 0;
    this.up = startUp;
    this.angle = startUp === 'aft' ? this.tilt : -this.tilt;
    this.angularVelocity = 0;
    this.tips = 0;
    this.autoTips = 0;
    this.spilled.length = 0;
  }

  /** Plan-view position, for the renderer and for AI targeting. */
  get position() {
    return new Vec2(this.pivotX, 0);
  }
}
