import { Vec2 } from '../../math/Vec2.js';
import { INCH } from '../../math/MathUtil.js';
import { resolveSphereContact } from '../../physics/BallWorld.js';
import {
  CELL_DEPTH,
  CELL_OPENING_BOTTOM,
  CELL_OPENING_HEIGHT,
  CELL_OPENING_TOP,
  CELL_OPENING_WIDTH,
  CELL_REST_HEIGHT,
  CELL_REST_OFFSET,
  CELL_SHOULDER_HEIGHT,
  HIVE_PIVOT_HEIGHT,
  HIVE_TILT,
  INFERRED,
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
/**
 * How slow an element has to be before the CELL adopts it, m/s.
 *
 * The handover threshold between real wall physics and stable stacking. Low
 * enough that a shot visibly arrives, hits the back and drops before anything
 * takes it -- a couple of tenths of a second, not instantly.
 */
const CELL_SETTLE_SPEED = 0.6;

const REST_ALONG =
  CELL_REST_OFFSET * Math.cos(HIVE_TILT) +
  (CELL_REST_HEIGHT - HIVE_PIVOT_HEIGHT) * Math.sin(HIVE_TILT);
const REST_ACROSS =
  -CELL_REST_OFFSET * Math.sin(HIVE_TILT) +
  (CELL_REST_HEIGHT - HIVE_PIVOT_HEIGHT) * Math.cos(HIVE_TILT);

/**
 * Centre of the CELL's opening, in the same body frame.
 *
 * The opening plane is perpendicular to the arm, so it sits `CELL_DEPTH` out
 * along the arm from the back of the CELL, and its centre is half the opening's
 * height up from the floor. Three numbers from three different places agree on
 * this to three figures, which is why it is worth building rather than guessing:
 *
 *  - Figure 9-9 puts the bottom of the opening 53.5 in above the tiles and the
 *    top 65.6 in;
 *  - Section 9.6.2 gives the CELL 12 in of depth;
 *  - the CAD stages three NECTAR on the floor at 9.4 in out and 50.2 in up.
 *
 * Build the opening 12 in out along the arm from those NECTAR and lift it to
 * the middle of 53.5 and 65.6, and its lower edge lands on 53.5 and its apex on
 * 65.6 exactly.
 */
const OPENING_ALONG = REST_ALONG + CELL_DEPTH;
const OPENING_ACROSS =
  REST_ACROSS +
  ((CELL_OPENING_BOTTOM + CELL_OPENING_TOP) / 2 -
    (CELL_REST_HEIGHT + CELL_DEPTH * Math.sin(HIVE_TILT))) /
    Math.cos(HIVE_TILT);

/**
 * Half-width of the opening at height `v` above its lower edge.
 *
 * Figure 9-11: the CELL rib is a pentagon, 20 in across the base, straight up
 * to a shoulder at 7.61 in, then tapering to an apex at 14 in. A shot into the
 * top corners has less room than a rectangle would suggest.
 */
function openingHalfWidth(v) {
  if (v < 0 || v > CELL_OPENING_HEIGHT) return 0;
  if (v <= CELL_SHOULDER_HEIGHT) return CELL_OPENING_WIDTH / 2;
  const taper = (CELL_OPENING_HEIGHT - v) / (CELL_OPENING_HEIGHT - CELL_SHOULDER_HEIGHT);
  return (CELL_OPENING_WIDTH / 2) * taper;
}

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
    /**
     * LAUNCHED elements that have struck this HIVE from the other ALLIANCE,
     * for G417.D -- "impeding the TIP of an opponent's HIVE by LAUNCHING
     * NECTAR or POLLEN at it". Drained by the REFEREE.
     * @type {{alliance: string, robotId: string, ballId: string}[]}
     */
    this.launchStrikes = [];
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
    // Most of the mass is out in the two baskets, so use the distance to the
    // middle of a CELL as the radius of gyration.
    const radius = Math.hypot(REST_ALONG + CELL_DEPTH / 2, REST_ACROSS);
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
   * Centre of a CELL's opening, in field coordinates: the aperture a shot has
   * to cross, 20 in wide by 14 in tall and perpendicular to the arm.
   *
   * The two CELLS are mirror images across the pivot rather than 180 degree
   * rotations of each other -- both open outward along their own end of the arm
   * -- so the perpendicular offset keeps its sign and only the along-arm term
   * flips.
   *
   * @param {'fore'|'aft'} side
   * @returns {{x:number, y:number, z:number}}
   */
  cellOpening(side) {
    const offset = this._toWorld(this._sideSign(side) * OPENING_ALONG, OPENING_ACROSS);
    return { x: this.pivotX, y: offset.y, z: HIVE_PIVOT_HEIGHT + offset.z };
  }

  /**
   * Where elements come to rest inside a CELL: on the sloping floor, 12 in back
   * along the arm from the opening and below it.
   *
   * This is not what to shoot at. Aiming here rather than at the opening puts
   * the ball into the outside of the CELL wall, about nine inches low.
   *
   * @param {'fore'|'aft'} side
   */
  cellRest(side) {
    const offset = this._toWorld(this._sideSign(side) * REST_ALONG, REST_ACROSS);
    return { x: this.pivotX, y: offset.y, z: HIVE_PIVOT_HEIGHT + offset.z };
  }

  /** Opening of whichever CELL currently faces up: the thing to shoot at. */
  get target() {
    return this.cellOpening(this.up);
  }

  /** Outward unit normal of a CELL's opening, in field coordinates. */
  openingNormal(side) {
    const sign = this._sideSign(side);
    const c = Math.cos(this.angle);
    const s = Math.sin(this.angle);
    // Body-frame normal is straight along the arm: (sign, 0).
    return { y: sign * c, z: sign * s };
  }

  /**
   * The opening's in-plane "up": from its lower edge toward the pentagon's apex.
   *
   * This is body-frame `(0, 1)` for *both* CELLS -- across the arm, away from
   * the tiles -- so it takes no side sign. The two CELLS are mirror images
   * through the pivot, but "up" is not mirrored: both pentagons stand on their
   * 20 in base with the apex above it, whichever end of the arm is raised.
   *
   * It cannot be recovered from the normal alone. Turning the normal a quarter
   * turn gives the right answer for one CELL and the upside-down one for the
   * other, which draws that CELL mirrored through its own opening; multiplying
   * by the side sign does the same thing, just to the other CELL.
   *
   * @param {'fore'|'aft'} side
   */
  openingUp(side) {
    return { y: -Math.sin(this.angle), z: Math.cos(this.angle) };
  }

  /**
   * Upward component of a CELL's opening normal: 1 facing straight up, negative
   * once the opening has rolled past horizontal and cannot hold anything.
   *
   * The opening faces straight out along the arm, so this is simply the sine of
   * the arm angle -- +0.5 for the raised CELL at a 30 degree stop and -0.5 for
   * the lowered one, which is why a tip empties itself. It used to be a free
   * parameter; the figure's two opening heights removed it.
   * @param {'fore'|'aft'} side
   */
  openingUpwardness(side) {
    return this._sideSign(side) * Math.sin(this.angle);
  }

  /**
   * Net torque about the pivot, N*m. Positive drives the aft CELL upward.
   * Exposed because it is the whole mechanism and worth being able to read.
   */
  get netTorque() {
    let torque = this.holdingMoment * G * Math.sin(this.angle);
    // Each element's own lever arm, from where it actually is.
    //
    // This used to assume every element sat at the CELL's rest point, which
    // made the arm's balance a function of the *count* rather than of where
    // the weight was. It is the same sum -- torque about the pivot from a
    // vertical force is `-m*g*y` -- but taken from the real position, so a
    // CELL filled to the back tips sooner than one with the same number of
    // elements piled at the mouth, and a NECTAR resting further out counts for
    // more than a POLLEN resting closer in. Elements still loose inside a CELL
    // are not in this sum: they are pressing on its walls, and `_pushOff`
    // hands the arm that reaction directly.
    for (const ball of this.foreBalls) torque -= ball.mass * G * ball.y;
    for (const ball of this.aftBalls) torque -= ball.mass * G * ball.y;
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
   * Signed distance from a point to a CELL's opening plane, positive outside.
   * @param {'fore'|'aft'} side
   */
  openingDepth(side, x, y, z) {
    const opening = this.cellOpening(side);
    const normal = this.openingNormal(side);
    return (y - opening.y) * normal.y + (z - opening.z) * normal.z;
  }

  /**
   * Whether a point is inside a CELL's mouth: through the opening plane, within
   * the pentagon, and not past the back wall.
   *
   * Split out of `interactBall` so the aiming guide can ask the same question
   * the capture test asks. Two separate copies of "is this in the CELL" is how
   * a guide ends up drawing a hit on a shot the HIVE then refuses.
   *
   * @param {'fore'|'aft'} side
   * @param {{margin?: number, outward?: number}} [opts] `margin` is slack on the
   *   pentagon outline; `outward` is how far in front of the opening plane the
   *   point may still be. They are separate because a sphere counts as arriving
   *   as soon as it *touches* the plane -- so `outward` is its radius -- but its
   *   centre still has to be inside the outline, or it hits the rib instead.
   */
  openingContains(side, x, y, z, opts = {}) {
    const margin = opts.margin ?? 0;
    const outward = opts.outward ?? margin;
    const opening = this.cellOpening(side);
    const normal = this.openingNormal(side);
    const dy = y - opening.y;
    const dz = z - opening.z;

    // Distance through the opening plane, positive outside the CELL.
    const through = dy * normal.y + dz * normal.z;
    if (through < -CELL_DEPTH || through > outward) return false;

    // Height up the opening, measured in its own plane.
    const upVec = this.openingUp(side);
    const v = dy * upVec.y + dz * upVec.z + CELL_OPENING_HEIGHT / 2;
    if (v < -margin || v > CELL_OPENING_HEIGHT + margin) return false;

    // And within the pentagon at that height, which is narrower than the full
    // 20 in once you are above the shoulder.
    const halfWidth = openingHalfWidth(Math.min(Math.max(v, 0), CELL_OPENING_HEIGHT));
    return Math.abs(x - opening.x) <= halfWidth + margin;
  }

  /**
   * The CELL's walls, in world space: five pentagon edges and the back panel.
   *
   * Real geometry rather than a capture test, because a CELL that simply
   * *accepts* anything crossing its mouth snaps the ball out of the air and
   * onto a shelf, which looks like a magnet and teaches nothing. With walls, a
   * shot flies in, hits the back panel, rattles down into the low corner and
   * settles -- and one that clips the rib bounces back out rather than
   * scoring.
   *
   * The frame is (across, up, inward): across the FIELD, up the opening's own
   * face toward the pentagon's apex, and inward along the arm. Each plane is
   * stored as an inward normal and the offset of the wall along it, so the
   * signed distance of a point is `offset - n.point` and positive means inside.
   *
   * @param {'fore'|'aft'} side
   */
  cellPlanes(side) {
    const opening = this.cellOpening(side);
    const normal = this.openingNormal(side);
    const up = this.openingUp(side);
    const hw = CELL_OPENING_WIDTH / 2;
    const apex = CELL_OPENING_HEIGHT;
    const shoulder = CELL_SHOULDER_HEIGHT;
    const rise = apex - shoulder;
    const taper = Math.hypot(rise, hw);

    // In (across, v) where v runs 0 at the pentagon's base to `apex` at its
    // point. Inward normals, so a point is inside when every distance is
    // positive.
    const edges = [
      { a: 0, v: 1, offset: 0 }, // base
      { a: -1, v: 0, offset: -hw }, // right
      { a: 1, v: 0, offset: -hw }, // left
      { a: -rise / taper, v: -hw / taper, offset: -(rise * hw + hw * shoulder) / taper },
      { a: rise / taper, v: -hw / taper, offset: -(rise * hw + hw * shoulder) / taper },
    ];

    return {
      origin: opening,
      // Unit basis vectors of the CELL's own frame, in world coordinates.
      across: { x: 1, y: 0, z: 0 },
      up,
      inward: { x: 0, y: -normal.y, z: -normal.z },
      depth: CELL_DEPTH,
      baseOffset: apex / 2,
      edges,
      /**
       * The same pentagon as a vertex ring, counter-clockwise in (across, v).
       *
       * The half-planes above say which side of each wall a point is on, which
       * is all a plate-by-plate test needs. Finding the *nearest point* on the
       * rib -- which is what a contact from outside needs -- takes the corners.
       */
      outline: [
        { a: -hw, v: 0 },
        { a: hw, v: 0 },
        { a: hw, v: shoulder },
        { a: 0, v: apex },
        { a: -hw, v: shoulder },
      ],
    };
  }

  /**
   * Local coordinates of a world point in a CELL's frame.
   * @param {'fore'|'aft'} side
   */
  cellLocal(side, x, y, z, planes = this.cellPlanes(side)) {
    const dx = x - planes.origin.x;
    const dy = y - planes.origin.y;
    const dz = z - planes.origin.z;
    return {
      a: dx,
      // Measured from the pentagon's base rather than the opening's centre,
      // which is what the edge equations are written in.
      v: dy * planes.up.y + dz * planes.up.z + planes.baseOffset,
      d: dy * planes.inward.y + dz * planes.inward.z,
    };
  }

  /**
   * Bounce a free ball off this HIVE's CELLS.
   *
   * Registered with the ball world as a collider, so it runs on every free
   * ball every substep. Cheap-rejected on a bounding sphere first, because 56
   * elements times two CELLS times six planes at two thousand hertz is worth
   * not doing.
   *
   * @param {import('../../physics/Ball.js').Ball} ball
   */
  collideBall(ball) {
    for (const side of ['fore', 'aft']) {
      const planes = this.cellPlanes(side);
      // Bounding sphere around the CELL's volume, centred half a depth in.
      const cx = planes.origin.x;
      const cy = planes.origin.y + planes.inward.y * (planes.depth / 2);
      const cz = planes.origin.z + planes.inward.z * (planes.depth / 2);
      const reach = CELL_OPENING_WIDTH / 2 + planes.depth / 2 + ball.radius;
      if (
        Math.abs(ball.x - cx) > reach ||
        Math.abs(ball.y - cy) > reach ||
        Math.abs(ball.z - cz) > reach
      ) {
        continue;
      }
      this._collideCell(ball, side, planes);
    }
  }

  /**
   * Resolve a ball against one CELL, modelled as the plates it is made of.
   *
   * Six two-sided plates: the five pentagon side walls, each spanning the
   * CELL's depth, and the back panel bounded by the outline. The mouth has no
   * plate, which is what lets a shot in.
   *
   * Two-sided and *bounded* both matter, and the bounding is what the first
   * version got wrong. Treating the mouth as an infinite plane whenever the
   * ball was near the outline meant the plane of every CELL extended across
   * the whole FIELD: a shot from the far corner at the red CELL was batted out
   * of the air by the opening plane of a blue CELL a metre and a half off its
   * line. A plate only exists where the structure does.
   *
   * @param {import('../../physics/Ball.js').Ball} ball
   */
  _collideCell(ball, side, planes) {
    const local = this.cellLocal(side, ball.x, ball.y, ball.z, planes);
    const r = ball.radius;
    const depth = planes.depth;

    const distances = planes.edges.map(
      (edge) => edge.a * local.a + edge.v * local.v - edge.offset,
    );
    const insideOutline = distances.every((d) => d >= 0);

    // In the mouth. There is no plate across the opening -- that is what lets a
    // shot in -- so an element lined up on it in free air touches nothing.
    if (insideOutline && local.d < 0) return;

    // --- Outside the box: one contact, from the nearest point of the solid.
    //
    // This is the half that was wrong, and it is what left elements hanging in
    // mid-air beside the HIVE for the rest of a MATCH. Each plate used to be
    // resolved independently as a two-sided slab, pushing the ball "to
    // whichever side it is already on" -- which is right for one plate and
    // wrong at a corner. An element resting against the *outside* of the
    // bottom-back corner is within a radius of both the floor plate and the
    // back panel, and the two normals are 60 degrees apart with upward
    // components: each push shoved it into the other's slab, and the pair of
    // them held it against gravity. It never moved again.
    //
    // A pentagonal prism is convex, so from outside there is exactly one
    // contact: the direction from the closest point of the solid to the ball's
    // centre. Faces, ribs and corners all fall out of that one expression, and
    // a single contact cannot wedge.
    const clampedD = Math.min(Math.max(local.d, 0), depth);
    let nearA = local.a;
    let nearV = local.v;
    if (!insideOutline) {
      const near = nearestOnOutline(planes.outline, local.a, local.v);
      nearA = near.a;
      nearV = near.v;
    }
    const da = local.a - nearA;
    const dv = local.v - nearV;
    const dd = local.d - clampedD;
    const gap = Math.hypot(da, dv, dd);
    if (gap > 1e-9) {
      if (gap >= r) return;
      this._pushOffLocal(ball, planes, da / gap, dv / gap, dd / gap, r - gap);
      return;
    }

    // --- Centre inside the box: out through every wall it is touching.
    //
    // Both walls at once is *correct* here, because the inside of a corner
    // really is concave -- an element resting in the bottom corner of a CELL is
    // held by the floor and the side. Never out through the mouth, though: an
    // element that has arrived belongs in there.
    for (let i = 0; i < planes.edges.length; i++) {
      const penetration = r - distances[i];
      if (penetration <= 0) continue;
      const edge = planes.edges[i];
      this._pushOffLocal(ball, planes, edge.a, edge.v, 0, penetration);
    }
    const behind = depth - local.d;
    if (behind < r) this._pushOffLocal(ball, planes, 0, 0, -1, r - behind);
  }

  /**
   * Push a ball off a plate, given the normal in the CELL's own frame.
   *
   * `across` is world x and `up`/`inward` are an orthonormal pair in the y-z
   * plane, so this is a rotation and the normal stays a unit vector.
   */
  _pushOffLocal(ball, planes, na, nv, nd, penetration) {
    this._pushOff(
      ball,
      na,
      nv * planes.up.y + nd * planes.inward.y,
      nv * planes.up.z + nd * planes.inward.z,
      penetration,
    );
  }

  /**
   * Push a ball off a plate and resolve the bounce, with the plate's own
   * velocity as the arm swings.
   */
  _pushOff(ball, nx, ny, nz, penetration) {
    // The HIVE is "anything else besides that ROBOT", so touching it closes
    // G409's catch window.
    ball.touchedStructure();
    this._noteLaunchStrike(ball);
    const length = Math.hypot(nx, ny, nz) || 1;
    const ux = nx / length;
    const uy = ny / length;
    const uz = nz / length;
    ball.x += ux * penetration;
    ball.y += uy * penetration;
    ball.z += uz * penetration;

    const surface = this._surfaceVelocity(ball.x, ball.y, ball.z);
    const beforeVy = ball.vy;
    const beforeVz = ball.vz;
    resolveSphereContact(ball, ux, uy, uz, {
      // Polycarbonate on a foam-lined basket: a CELL is meant to keep what
      // lands in it, and a lively wall would throw shots back out of something
      // that in reality absorbs them.
      restitution: ball.restitution * 0.4,
      friction: 0.35,
      surfaceVx: surface.vx,
      surfaceVy: surface.vy,
      surfaceVz: surface.vz,
      minBounce: 0.25,
    });

    // --- And the arm feels it back.
    //
    // Newton's third law, and it is the whole reason a *shot* can tip a HIVE
    // rather than only the weight that accumulates in it afterwards. A POLLEN
    // arriving at 6 m/s carries 0.27 kg m/s; landed on a lever two thirds of a
    // metre out that is a real angular impulse, and firing a volley into a
    // CELL that is nearly over is how you take it over. A resting element
    // hands the same law a steady trickle of tiny impulses, which is its
    // weight -- so free elements inside a CELL need no separate bookkeeping.
    const impulseY = -ball.mass * (ball.vy - beforeVy);
    const impulseZ = -ball.mass * (ball.vz - beforeVz);
    const ry = ball.y;
    const rz = ball.z - HIVE_PIVOT_HEIGHT;
    const angularImpulse = ry * impulseZ - rz * impulseY;
    this.angularVelocity += angularImpulse / this.momentOfInertia;
  }

  /**
   * Everything the arm has to swing, about the pivot.
   *
   * The structure plus whatever is in the CELLS, each at its own distance
   * rather than at an assumed one -- the same reason `netTorque` uses real
   * positions.
   */
  get momentOfInertia() {
    let inertia = this.structureInertia;
    for (const list of [this.foreBalls, this.aftBalls]) {
      for (const ball of list) {
        const r = Math.hypot(ball.y, ball.z - HIVE_PIVOT_HEIGHT);
        inertia += ball.mass * r * r;
      }
    }
    return inertia;
  }

  /**
   * Velocity of the HIVE's structure at a world point.
   *
   * The arm turns about the pivot on the +x axis, so a point offset from it by
   * (0, oy, oz) is moving at (0, -w*oz, w*oy). It matters: a CELL coming down
   * through the middle of a tip is moving at a metre a second at its mouth, and
   * a wall that pretends to be stationary either swallows a ball it should have
   * batted away or lets one sit on it while it rotates out from underneath.
   */
  _surfaceVelocity(x, y, z) {
    const oy = y;
    const oz = z - HIVE_PIVOT_HEIGHT;
    const w = this.angularVelocity;
    return { vx: 0, vy: -w * oz, vz: w * oy };
  }

  /**
   * Adopt a ball that has come to rest inside the upward-facing CELL.
   *
   * The handover between real physics and stable stacking, and the condition
   * is the honest one: the ball has to be *in* there and no longer moving.
   * Before, anything crossing the mouth was adopted on the spot -- which
   * snapped it out of mid-air onto a shelf, so a shot that should have rattled
   * off the rib scored, and one that should have bounced out stayed in.
   *
   * Adoption still exists because a column of elements resting in a rotating
   * container is where contact solvers go to die. Once they have stopped
   * moving, the CELL positions them and the physics has nothing left to say.
   *
   * @param {import('../../physics/Ball.js').Ball} ball
   */
  interactBall(ball) {
    const side = this.up;
    // A CELL whose mouth has rolled to horizontal cannot take anything.
    if (this.openingUpwardness(side) < 0.1) return false;
    // Still moving: leave it to the walls. This is what stops the snap.
    if (ball.speed > CELL_SETTLE_SPEED) return false;

    const planes = this.cellPlanes(side);
    const local = this.cellLocal(side, ball.x, ball.y, ball.z, planes);
    if (local.d < 0 || local.d > planes.depth + ball.radius) return false;
    for (const edge of planes.edges) {
      if (edge.a * local.a + edge.v * local.v - edge.offset < -ball.radius) return false;
    }

    this._noteLaunchStrike(ball);
    this.upBalls.push(ball);
    ball.attachTo('cell', this);
    this._restackCell();
    return true;
  }

  /**
   * G417.D: note a LAUNCHED element that arrived here from the other ALLIANCE.
   *
   * "Impeding the TIP of an opponent's HIVE by LAUNCHING NECTAR or POLLEN at
   * it" -- so what matters is whose HIVE it landed on, not whether it went in.
   * A shot that rattles off the outside and one that drops cleanly into the
   * opponent's CELL are the same violation, and both routes into a HIVE call
   * this.
   *
   * Missing your *own* CELL and clipping its bottom, sides or top is example H
   * and explicitly *not* a violation, which is why the ALLIANCE test is here
   * rather than in the REFEREE.
   */
  _noteLaunchStrike(ball) {
    const touch = ball.lastTouch;
    if (!touch || touch.kind !== 'launch' || touch.alliance === this.alliance) return;
    this.launchStrikes.push({
      alliance: touch.alliance,
      robotId: touch.id,
      ballId: ball.id,
    });
    // Once per shot, not once per plate it rattles off on the way in.
    ball.lastTouch = { ...touch, kind: 'launched' };
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
      const perRow = Math.max(1, Math.floor(CELL_OPENING_WIDTH / (3.8 * INCH)));
      const spread = CELL_OPENING_WIDTH / (perRow + 1);
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
          this.pivotX - CELL_OPENING_WIDTH / 2 + spread * (column + 1),
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
    const inertia = this.momentOfInertia;

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
          this.pivotX + (Math.random() * 2 - 1) * CELL_OPENING_WIDTH * 0.3,
          offset.y,
          HIVE_PIVOT_HEIGHT + offset.z,
        );
        // A little sideways scatter, so a tipped load does not land in a
        // single stack under the hive.
        ball.release((Math.random() * 2 - 1) * 0.25, vy, vz);
        // G409: until this touches something that is not a ROBOT, a ROBOT
        // touching it is a catch. Set after `release`, which is what turns the
        // element loose and is the moment the HIVE "released" it.
        ball.fromTip = { alliance: this.alliance, t: 0 };
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

  /** Collect and clear the hostile LAUNCHED strikes on this HIVE (G417.D). */
  takeLaunchStrikes() {
    const out = this.launchStrikes;
    this.launchStrikes = [];
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
    this.launchStrikes.length = 0;
  }

  /** Plan-view position, for the renderer and for AI targeting. */
  get position() {
    return new Vec2(this.pivotX, 0);
  }
}

/**
 * Nearest point on a convex outline to a point outside it.
 *
 * Every edge as a segment, nearest point on each, closest one wins. Five edges
 * makes the loop cheaper than anything cleverer, and it gets corners right for
 * free: a point off the end of one edge projects to the shared vertex from both
 * of the edges that meet there.
 *
 * @param {{a: number, v: number}[]} outline counter-clockwise ring
 * @param {number} a
 * @param {number} v
 */
function nearestOnOutline(outline, a, v) {
  let best = outline[0];
  let bestDistance = Infinity;
  for (let i = 0; i < outline.length; i++) {
    const p = outline[i];
    const q = outline[(i + 1) % outline.length];
    const ea = q.a - p.a;
    const ev = q.v - p.v;
    const lengthSquared = ea * ea + ev * ev;
    let t = 0;
    if (lengthSquared > 1e-12) {
      t = ((a - p.a) * ea + (v - p.v) * ev) / lengthSquared;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
    }
    const ca = p.a + ea * t;
    const cv = p.v + ev * t;
    const distance = (a - ca) * (a - ca) + (v - cv) * (v - cv);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = { a: ca, v: cv };
    }
  }
  return best;
}
