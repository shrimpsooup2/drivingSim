import { Vec2 } from '../../math/Vec2.js';
import { INCH } from '../../math/MathUtil.js';
import { Ball } from '../../physics/Ball.js';
import { BallWorld } from '../../physics/BallWorld.js';
import { Obstacle } from '../Obstacle.js';
import { Hive } from './Hive.js';
import { Flower } from './Flower.js';
import { buildZones, gardenStagingPositions } from './zones.js';
import {
  BLUE_START_UP,
  CELL_START_NECTAR,
  FLOWER_ALONG_WALL,
  FLOWER_AXIS_OFFSET,
  FLOWER_BACKSTOP_TOP,
  FIELD_INNER_HALF,
  FLOWER_START_POLLEN,
  FLOWER_RING_DEPTH,
  FLOWER_RING_WIDTH,
  FLOWER_SUPPORT_TOP,
  FRAME_FOOT_HALF_DEPTH,
  FRAME_FOOT_HEIGHT,
  FRAME_FOOT_INNER,
  FRAME_FOOT_OUTER,
  FRAME_STRUT_BASE,
  FRAME_STRUT_TOP,
  GARDEN_START_POLLEN,
  HIVE_PIVOT_HEIGHT,
  HIVE_PIVOT_X,
  NECTAR_MASS,
  ELEMENT_RESTITUTION,
  NECTAR_PER_ALLIANCE,
  NECTAR_RADIUS,
  POINTS,
  POLLEN_COUNT,
  POLLEN_MASS,
  POLLEN_RADIUS,
  PRELOAD_POLLEN,
  RED_START_UP,
  ROBOT_SIZE_LIMIT,
  SETTLE_SPEED,
  TILE_RESTITUTION,
} from './constants.js';

/**
 * Width of one A-frame strut where a ROBOT can reach it. Measured across the
 * 1 in extrusion plus its gussets.
 */
const STRUT_WIDTH = 2 * INCH;

/**
 * The BIOBUZZ FIELD: the HIVE structure, four FLOWERS, the taped zones, and all
 * 56 SCORING ELEMENTS.
 *
 * This wraps the generic `Field` rather than replacing it. The perimeter,
 * collision solver and obstacle machinery already work, so the game is added as
 * obstacles plus a `BallWorld`, and everything that drove the simulator before
 * -- drivetrain, drills, AI opponents -- keeps working unchanged.
 *
 * ## Two things collide that drivers always forget
 *
 * The HIVE structure stands in the middle of the FIELD and its frame is 49.46 in
 * wide by 38.95 in deep at the tiles (Section 9.6.1). That is nearly two tiles
 * of immovable steel across the centre, and crossing the FIELD means going
 * around it. The FLOWERS stick out of all four walls. Both are registered as
 * solid obstacles, because a driving simulator that lets you drive through the
 * field structure teaches the wrong routes.
 *
 * @see docs/BIOBUZZ.md for the provenance of every inferred dimension.
 */
export class BiobuzzField {
  /**
   * @param {{
   *   field: import('../Field.js').Field,
   *   ballRate?: number,
   *   hiveHoldMass?: number,
   *   returnDelay?: number,
   * }} opts
   */
  constructor(opts) {
    this.field = opts.field;

    /**
     * How long FIELD STAFF take to put a departed element back, in seconds.
     *
     * Section 10.8.2: "POLLEN that exits the FIELD will be reintroduced into
     * the FIELD at the earliest safe opportunity by FIELD STAFF in the nearest
     * convenient location. NECTAR that exits the FIELD will be returned to that
     * ALLIANCE'S DRIVE TEAM for reintroduction." So it comes back either way,
     * and not instantly -- the delay is the whole point of modelling it. A
     * flywheel robot that overshoots the CELL loses that POLLEN from the cycle
     * for several seconds, which is a real cost and the reason to aim properly.
     *
     * Six seconds is a plausible "earliest safe opportunity": long enough that
     * you notice, short enough that a MATCH does not run out of elements.
     */
    this.returnDelay = opts.returnDelay ?? 6;
    /** Seconds of MATCH time this FIELD has been stepped. */
    this.clock = 0;
    /** @type {{ball: Ball, dueAt: number}[]} */
    this._returns = [];
    /** Elements that left the FIELD, waiting for the REFEREE to read them. */
    this._departed = [];

    /**
     * Red's HIVE sits on the red half of the crossbar, blue's on the blue half,
     * each on its own bearing at its own centre. Section 10.3.1 stages each
     * HIVE with one CELL down, opposite ways round, and the CAD says which:
     * red's audience-side CELL is up and blue's rear-side CELL is up.
     */
    this.hives = {
      red: new Hive({
        alliance: 'red',
        pivotX: -HIVE_PIVOT_X,
        startUp: RED_START_UP,
        holdMass: opts.hiveHoldMass,
      }),
      blue: new Hive({
        alliance: 'blue',
        pivotX: HIVE_PIVOT_X,
        startUp: BLUE_START_UP,
        holdMass: opts.hiveHoldMass,
      }),
    };

    /**
     * Four FLOWERS, **one per wall** -- measured from the CAD, not the two per
     * ALLIANCE side this file assumed from the manual's text alone. Each sits
     * 68.04 in from centre along its wall's normal and 23.39 in off that wall's
     * centre line, laid out with 180 degree rotational symmetry.
     *
     * That layout is what makes the Section 10.3.1 mnemonic work: each HIVE's
     * *down* CELL faces the wall whose FLOWER is on that HIVE's own half of the
     * FIELD.
     */
    const a = FLOWER_AXIS_OFFSET;
    const b = FLOWER_ALONG_WALL;
    this.flowers = [
      new Flower({ id: 'flowerAudience', x: b, y: -a, facing: Math.PI / 2 }),
      new Flower({ id: 'flowerRear', x: -b, y: a, facing: -Math.PI / 2 }),
      new Flower({ id: 'flowerRedWall', x: -a, y: -b, facing: 0 }),
      new Flower({ id: 'flowerBlueWall', x: a, y: b, facing: Math.PI }),
    ];

    this.zones = buildZones();

    /** @type {Ball[]} */
    this.pollen = [];
    /** @type {{red: Ball[], blue: Ball[]}} */
    this.nectar = { red: [], blue: [] };
    for (let i = 0; i < POLLEN_COUNT; i++) {
      this.pollen.push(
        new Ball({
          id: `pollen${i}`,
          kind: 'pollen',
          alliance: 'neutral',
          radius: POLLEN_RADIUS,
          mass: POLLEN_MASS,
          restitution: ELEMENT_RESTITUTION,
        }),
      );
    }
    for (const alliance of ['red', 'blue']) {
      for (let i = 0; i < NECTAR_PER_ALLIANCE; i++) {
        this.nectar[alliance].push(
          new Ball({
            id: `nectar-${alliance}${i}`,
            kind: 'nectar',
            alliance,
            radius: NECTAR_RADIUS,
            mass: NECTAR_MASS,
            restitution: ELEMENT_RESTITUTION,
          }),
        );
      }
    }

    this.ballWorld = new BallWorld({
      fieldSize: this.field.size,
      wallHeight: this.field.wallHeight,
      restitution: TILE_RESTITUTION,
      settleSpeed: SETTLE_SPEED,
    });
    for (const ball of this.allBalls) this.ballWorld.add(ball);

    // FLOWERS get first refusal on a descending ball, then the HIVE CELLS. The
    // two never compete: a FLOWER opening is 21.5 in up and a CELL opening is
    // around 49 in, so a ball is never in both capture volumes.
    for (const flower of this.flowers) {
      this.ballWorld.addInteractor((ball) => flower.interactBall(ball));
    }
    for (const hive of [this.hives.red, this.hives.blue]) {
      // Walls only. A CELL is a structure elements bounce around inside and
      // rest in, and nothing more -- it takes nothing out of the world's
      // hands, so there is no container step to register. It does need to see
      // the elements, though, because working out what is inside it is now a
      // question about geometry rather than about ownership.
      hive.balls = this.ballWorld.balls;
      this.ballWorld.addCollider((ball) => hive.collideBall(ball));
    }

    /**
     * NECTAR a human may still hand in. G427 releases one per TIP and all
     * remaining with 60 s left.
     */
    this.nectarUnlocked = { red: 0, blue: 0 };
    this.nectarEntered = { red: 0, blue: 0 };

    /** @type {Obstacle[]} */
    this.obstacles = [];
    this._buildObstacles();
    this.setup();
  }

  /** Every SCORING ELEMENT, in one list. */
  get allBalls() {
    return [...this.pollen, ...this.nectar.red, ...this.nectar.blue];
  }

  /**
   * The solid structures, added to the wrapped `Field` so the existing
   * collision pass picks them up with no changes.
   *
   * The frame triangles are modelled as full-depth boxes. That is exactly right
   * at bumper height, where the triangle's base is widest, and a little
   * conservative higher up where the sides slope in -- a very low robot could
   * nose an inch or two further under the slope than this allows.
   */
  _buildObstacles() {
    // --- The A-frame, as the two things a ROBOT can actually hit.
    //
    // A single full-depth box is wrong in both directions: it walls off the
    // middle of the field, which a robot really can drive through, and it
    // misses that the struts lean inward over a robot's own height. So the
    // frame goes in as its foot bar plus the reachable part of each strut.
    for (const sign of [-1, 1]) {
      // The foot bar: 2 in thick, the full 38.94 in depth, 2.15 in tall. This
      // is what a bumper meets, and it is continuous, so it does stop you.
      this.obstacles.push(
        new Obstacle({
          id: `hiveFoot${sign < 0 ? 'Red' : 'Blue'}`,
          position: new Vec2((sign * (FRAME_FOOT_OUTER + FRAME_FOOT_INNER)) / 2, 0),
          size: new Vec2(FRAME_FOOT_OUTER - FRAME_FOOT_INNER, FRAME_FOOT_HALF_DEPTH * 2),
          height: FRAME_FOOT_HEIGHT,
          color: [0.35, 0.36, 0.4, 1],
          visible: false,
        }),
      );

      // Each strut runs from its base corner up and inward to the pivot. Only
      // the part below the ROBOT height limit can ever be touched, so the
      // collider is that segment's shadow on the tiles and no more -- past it
      // the strut is overhead and a robot passes underneath.
      for (const side of [-1, 1]) {
        const reach = Math.min(1, ROBOT_SIZE_LIMIT / (FRAME_STRUT_TOP.z - FRAME_STRUT_BASE.z));
        const ax = sign * FRAME_STRUT_BASE.x;
        const ay = side * FRAME_STRUT_BASE.y;
        const bx = ax + (sign * FRAME_STRUT_TOP.x - ax) * reach;
        const by = ay + (FRAME_STRUT_TOP.y - ay) * reach;
        const dx = bx - ax;
        const dy = by - ay;
        this.obstacles.push(
          new Obstacle({
            id: `hiveStrut${sign < 0 ? 'Red' : 'Blue'}${side < 0 ? 'Fore' : 'Aft'}`,
            position: new Vec2((ax + bx) / 2, (ay + by) / 2),
            size: new Vec2(Math.hypot(dx, dy), STRUT_WIDTH),
            heading: Math.atan2(dy, dx),
            height: ROBOT_SIZE_LIMIT,
            color: [0.44, 0.46, 0.5, 1],
            visible: false,
          }),
        );
      }
    }

    // --- FLOWERS. The ring plates are the widest part and set the footprint;
    // the supports between the lower and middle rings sit inside that, so one
    // oriented box per flower is the whole obstacle.
    for (const flower of this.flowers) {
      const alongWall = Math.abs(Math.cos(flower.facing)) < 0.5;
      this.obstacles.push(
        new Obstacle({
          id: `${flower.id}Tube`,
          position: new Vec2(flower.x, flower.y),
          size: alongWall
            ? new Vec2(FLOWER_RING_WIDTH, FLOWER_RING_DEPTH)
            : new Vec2(FLOWER_RING_DEPTH, FLOWER_RING_WIDTH),
          height: FLOWER_BACKSTOP_TOP,
          color: [0.2, 0.6, 0.3, 1],
          visible: false,
        }),
      );
    }

    for (const obstacle of this.obstacles) this.field.addElement(obstacle);
  }

  /**
   * Stage the FIELD per Section 10.3.1: 4 POLLEN in each FLOWER, 4 in each
   * GARDEN, 4 pre-loaded per ROBOT, 3 NECTAR in each upward CELL, and 5 NECTAR
   * per ALLIANCE waiting in the ALLIANCE AREA.
   *
   * @returns {{preload: Ball[][]}} the four sets of pre-load POLLEN, one per
   *   ROBOT, left off the FIELD for the caller to attach or drop.
   */
  setup() {
    for (const flower of this.flowers) flower.clear();
    this.hives.red.reset(RED_START_UP);
    this.hives.blue.reset(BLUE_START_UP);
    for (const ball of this.allBalls) {
      ball.release();
      ball.outOfBounds = false;
      ball.leftFieldAt = null;
      ball.lastTouch = null;
      ball.fromTip = null;
      ball.caughtFromTip = null;
      ball.resetOrientation();
      ball.setPosition(0, 0, -1);
    }
    this._returns.length = 0;
    this._departed.length = 0;
    this.clock = 0;
    this.ballWorld.settled = false;

    const pool = this.pollen.slice();
    const take = () => pool.shift();

    for (const flower of this.flowers) {
      for (let i = 0; i < FLOWER_START_POLLEN; i++) flower.add(take());
    }

    for (const zone of [this.zones.redGarden, this.zones.blueGarden]) {
      const spots = gardenStagingPositions(zone).slice(0, GARDEN_START_POLLEN);
      for (const spot of spots) {
        const ball = take();
        ball.setPosition(spot.x, spot.y, ball.radius);
        ball.stop();
      }
    }

    /** Four ROBOTS, 4 POLLEN each (Section 10.3.1.A.iv). */
    const preload = [];
    for (let r = 0; r < 4; r++) {
      const group = [];
      for (let i = 0; i < PRELOAD_POLLEN; i++) {
        const ball = take();
        ball.attachTo('preload', null);
        group.push(ball);
      }
      preload.push(group);
    }

    for (const alliance of ['red', 'blue']) {
      const hive = this.hives[alliance];
      const supply = this.nectar[alliance];
      for (let i = 0; i < CELL_START_NECTAR; i++) hive.stage(supply[i]);
      // The other 5 wait with the DRIVE TEAM until a TIP unlocks them.
      for (let i = CELL_START_NECTAR; i < supply.length; i++) {
        supply[i].attachTo('allianceArea', alliance);
      }
      this.nectarUnlocked[alliance] = 0;
      this.nectarEntered[alliance] = 0;
    }

    this._preload = preload;
    return { preload };
  }

  /**
   * Put a group of elements on the TILES in the middle of a LOADING ZONE,
   * against the perimeter wall.
   *
   * Section 10.3.1's handling for a ROBOT that is not there: its pre-load goes
   * "in approximately the center of the LOADING ZONE against the perimeter
   * wall". Spread along the wall rather than stacked, so they do not start the
   * MATCH resolving an overlap.
   *
   * @param {Ball[]} group
   * @param {'red'|'blue'} alliance
   */
  placeInLoadingZone(group, alliance) {
    const zone = alliance === 'red' ? this.zones.redLoading : this.zones.blueLoading;
    const inward = zone.centerX < 0 ? 1 : -1;
    group.forEach((ball, i) => {
      const spread = (i - (group.length - 1) / 2) * ball.radius * 2.3;
      ball.release();
      ball.setPosition(
        zone.centerX + inward * (ball.radius + 0.01),
        zone.centerY + spread,
        ball.radius,
      );
      ball.stop();
    });
    this.ballWorld.settled = false;
    return group;
  }

  /** The pre-load POLLEN groups from the last `setup()`. */
  get preloadGroups() {
    return this._preload ?? [];
  }

  // --------------------------------------------------------- human player

  /**
   * Release NECTAR to the DRIVE TEAM. Section 10.1: "Each time a HIVE is
   * TIPPED, an ALLIANCE is allowed to enter one of five NECTAR initially staged
   * in the ALLIANCE AREA. With 60 seconds left in the MATCH, ALLIANCES can
   * enter all remaining NECTAR."
   * @param {'red'|'blue'} alliance
   * @param {number|'all'} count
   */
  unlockNectar(alliance, count) {
    const staged = this.nectar[alliance].filter(
      (b) => b.container?.kind === 'allianceArea',
    ).length;
    const room = staged - this.nectarUnlocked[alliance];
    const want = count === 'all' ? room : count;
    this.nectarUnlocked[alliance] += Math.max(0, Math.min(room, want));
    return this.nectarUnlocked[alliance];
  }

  /** How many NECTAR a human may legally hand in right now. */
  nectarAvailable(alliance) {
    return this.nectarUnlocked[alliance];
  }

  /**
   * A human introduces one NECTAR. G427: it enters through the LOADING ZONE.
   * @param {'red'|'blue'} alliance
   * @returns {Ball|null} null when nothing is unlocked.
   */
  introduceNectar(alliance) {
    if (this.nectarUnlocked[alliance] <= 0) return null;
    const ball = this.nectar[alliance].find(
      (b) => b.container?.kind === 'allianceArea',
    );
    if (!ball) return null;

    const zone =
      alliance === 'red' ? this.zones.redLoading : this.zones.blueLoading;
    // Rolled in against the perimeter, roughly in the middle of the zone.
    const inward = zone.centerX < 0 ? 1 : -1;
    ball.release();
    ball.setPosition(
      zone.centerX + inward * (zone.width / 4),
      zone.centerY,
      ball.radius,
    );
    this.nectarUnlocked[alliance] -= 1;
    this.nectarEntered[alliance] += 1;
    this.ballWorld.settled = false;
    return ball;
  }

  // -------------------------------------------------------------- stepping

  /**
   * @param {number} dt seconds
   * @param {{inAuto?: boolean, bodies?: {body: any, halfLength: number, halfWidth: number, height: number}[]}} [opts]
   */
  update(dt, opts = {}) {
    const inAuto = opts.inAuto ?? false;

    if (opts.bodies) {
      this.ballWorld.clearBodies();
      for (const b of opts.bodies) {
        // `b.meta` is who the body belongs to, and it is what makes provenance
        // work: without it the ball world moves elements around without ever
        // recording which ROBOT did it, and G405 has nothing to attribute.
        this.ballWorld.addBody(b.body, b.halfLength, b.halfWidth, b.height, b.meta);
      }
    }

    let tips = { red: 0, blue: 0 };
    for (const alliance of ['red', 'blue']) {
      const hive = this.hives[alliance];
      const before = hive.tips;
      hive.update(dt, inAuto);
      tips[alliance] = hive.tips - before;
      const spilled = hive.takeSpilled();
      if (spilled.length) this.ballWorld.settled = false;
    }

    this.ballWorld.step(dt);
    this.clock += dt;
    this._noteDepartures();
    this._runReturns();
    return tips;
  }

  // ------------------------------------------------- Section 10.8.2 logistics

  /**
   * Notice elements that have just left the FIELD and queue their return.
   *
   * The ball world stops stepping an element the moment it clears the wall, so
   * one that has gone is frozen where it went -- which is exactly where FIELD
   * STAFF would find it, and therefore where "the nearest convenient location"
   * is measured from.
   */
  _noteDepartures() {
    for (const ball of this.ballWorld.balls) {
      if (!ball.outOfBounds || ball.leftFieldAt !== null) continue;
      ball.leftFieldAt = this.clock;
      this._departed.push(ball);
      this._returns.push({ ball, dueAt: this.clock + this.returnDelay });
    }
  }

  /**
   * Elements that left the FIELD since this was last called.
   *
   * Drained rather than accumulated, because the only consumer is the REFEREE
   * deciding whether each one was a G405 ejection, and it wants each departure
   * once.
   */
  takeDepartures() {
    const out = this._departed;
    this._departed = [];
    return out;
  }

  /** How many elements are off the FIELD waiting to come back. */
  get pendingReturns() {
    return this._returns.length;
  }

  /**
   * Put back everything whose delay has elapsed.
   *
   * The two element types go back by different routes, because Section 10.8.2
   * says so: POLLEN is FIELD STAFF's to roll back in, and NECTAR goes to the
   * DRIVE TEAM, who then have to enter it through the LOADING ZONE like any
   * other NECTAR. That difference is worth having -- a NECTAR you put over the
   * wall is out of play until somebody walks it round and rolls it in, and it
   * comes back on your side rather than where it left.
   */
  _runReturns() {
    if (this._returns.length === 0) return;
    const still = [];
    for (const entry of this._returns) {
      if (this.clock < entry.dueAt) {
        still.push(entry);
        continue;
      }
      this.returnElement(entry.ball);
    }
    this._returns = still;
  }

  /**
   * Bring one departed element back, by whichever route its type takes.
   * @param {Ball} ball
   */
  returnElement(ball) {
    ball.outOfBounds = false;
    ball.leftFieldAt = null;
    ball.lastTouch = null;
    ball.fromTip = null;
    ball.caughtFromTip = null;

    if (ball.kind === 'nectar' && (ball.alliance === 'red' || ball.alliance === 'blue')) {
      // Back to the DRIVE TEAM, and available to hand in again. It was already
      // counted against the release schedule when it first went in, so
      // returning it does not let an ALLIANCE enter more NECTAR than it has.
      ball.attachTo('allianceArea', ball.alliance);
      ball.setPosition(0, 0, -1);
      this.unlockNectar(ball.alliance, 1);
      return ball;
    }

    const spot = this._nearestClearSpot(ball);
    ball.release();
    ball.setPosition(spot.x, spot.y, ball.radius);
    ball.stop();
    this.ballWorld.settled = false;
    return ball;
  }

  /**
   * The nearest place inside the perimeter a FIELD STAFF member could put an
   * element down: clear of the structures, and not on top of another element.
   *
   * Rings outward from where it left rather than searching the whole FIELD,
   * because "nearest convenient location" is the rule's own wording and
   * dropping it back where it went over is what actually happens.
   *
   * @param {Ball} ball
   */
  _nearestClearSpot(ball) {
    const limit = FIELD_INNER_HALF - ball.radius - 0.02;
    const startX = Math.max(-limit, Math.min(limit, ball.x));
    const startY = Math.max(-limit, Math.min(limit, ball.y));
    const step = ball.radius * 2.2;

    for (let ring = 0; ring < 8; ring++) {
      const count = ring === 0 ? 1 : ring * 8;
      for (let i = 0; i < count; i++) {
        const angle = (i / count) * Math.PI * 2;
        const x = Math.max(-limit, Math.min(limit, startX + Math.cos(angle) * step * ring));
        const y = Math.max(-limit, Math.min(limit, startY + Math.sin(angle) * step * ring));
        if (this._spotIsClear(x, y, ball)) return { x, y };
      }
    }
    // Nowhere clear nearby, which means a heap: put it back anyway and let the
    // overlap resolution shuffle the pile, which is what a hand does too.
    return { x: startX, y: startY };
  }

  /** @param {Ball} ball */
  _spotIsClear(x, y, ball) {
    for (const other of this.ballWorld.balls) {
      if (other === ball || !other.free || other.outOfBounds) continue;
      if (other.z - other.radius > ball.radius * 2) continue;
      const room = other.radius + ball.radius;
      if (Math.hypot(other.x - x, other.y - y) < room) return false;
    }
    for (const obstacle of this.obstacles) {
      const dx = x - obstacle.position.x;
      const dy = y - obstacle.position.y;
      const cos = Math.cos(obstacle.heading);
      const sin = Math.sin(obstacle.heading);
      const along = Math.abs(dx * cos + dy * sin) - obstacle.size.x / 2;
      const across = Math.abs(-dx * sin + dy * cos) - obstacle.size.y / 2;
      if (along < ball.radius && across < ball.radius) return false;
    }
    return true;
  }

  // --------------------------------------------------------------- scoring

  /** Elements at least partially in a GARDEN (Section 10.5.3). */
  gardenCounts() {
    const out = { red: 0, blue: 0 };
    for (const zone of [this.zones.redGarden, this.zones.blueGarden]) {
      for (const ball of this.ballWorld.balls) {
        if (!ball.free) continue;
        // GARDENS are alliance specific and score for the colour of the
        // GARDEN "regardless of which ALLIANCE placed the POLLEN or NECTAR".
        if (zone.overlapsCircle(ball.x, ball.y, ball.radius)) {
          out[/** @type {'red'|'blue'} */ (zone.alliance)] += 1;
        }
      }
    }
    return out;
  }

  /**
   * Everything the FIELD itself contributes, with the breakdown a driver needs
   * to see. LEAVE, PARK and the RANKING POINTS depend on ROBOT state and are
   * added by the MATCH.
   */
  fieldScore() {
    const out = {
      red: { cell: 0, flower: 0, bottomNectar: 0, garden: 0, tips: 0, total: 0 },
      blue: { cell: 0, flower: 0, bottomNectar: 0, garden: 0, tips: 0, total: 0 },
    };

    for (const alliance of ['red', 'blue']) {
      const hive = this.hives[alliance];
      out[alliance].tips = hive.tips;
      out[alliance].cell = hive.elementsInUpCell() * POINTS.elementInCell;
    }

    for (const flower of this.flowers) {
      const owner = flower.owner();
      if (owner) {
        out[owner].flower +=
          flower.scoringElements().length * POINTS.elementInOwnedFlower;
      }
      const bottom = flower.bottomNectarAlliance();
      if (bottom) out[bottom].bottomNectar += POINTS.bottomNectarBonus;
    }

    const gardens = this.gardenCounts();
    for (const alliance of ['red', 'blue']) {
      out[alliance].garden = gardens[alliance] * POINTS.elementInGarden;
      out[alliance].total =
        out[alliance].cell +
        out[alliance].flower +
        out[alliance].bottomNectar +
        out[alliance].garden;
    }
    return out;
  }

  /** Where a shooter should aim: the up CELL of its own HIVE. */
  hiveTarget(alliance) {
    return this.hives[alliance].target;
  }

  /** The FLOWER nearest a point, for AI and for HUD hints. */
  nearestFlower(x, y) {
    let best = null;
    let bestD = Infinity;
    for (const flower of this.flowers) {
      const d = Math.hypot(flower.x - x, flower.y - y);
      if (d < bestD) {
        bestD = d;
        best = flower;
      }
    }
    return best;
  }

  /** Remove the game from the wrapped field, leaving it as it was. */
  dispose() {
    for (const obstacle of this.obstacles) this.field.removeElement(obstacle.id);
    this.obstacles.length = 0;
  }
}
