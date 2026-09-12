import { Vec2 } from '../../math/Vec2.js';
import { INCH } from '../../math/MathUtil.js';
import { Ball } from '../../physics/Ball.js';
import { BallWorld } from '../../physics/BallWorld.js';
import { Obstacle } from '../Obstacle.js';
import { Hive } from './Hive.js';
import { Flower } from './Flower.js';
import { buildZones, gardenStagingPositions } from './zones.js';
import {
  ALLIANCE_AREA_NECTAR,
  CELL_START_NECTAR,
  FLOWER_BACKSTOP_HEIGHT,
  FLOWER_OPENING_DIAMETER,
  FLOWER_OPENING_HEIGHT,
  FLOWER_START_POLLEN,
  FRAME_DEPTH,
  FRAME_WIDTH,
  GARDEN_START_POLLEN,
  HALF_FIELD,
  HIVE_PIVOT_HEIGHT,
  INFERRED,
  NECTAR_DIAMETER,
  NECTAR_MASS,
  NECTAR_PER_ALLIANCE,
  POINTS,
  POLLEN_COUNT,
  POLLEN_DIAMETER,
  POLLEN_MASS,
  PRELOAD_POLLEN,
} from './constants.js';

/** Thickness of one frame triangle where a bumper meets it. INFERRED. */
const FRAME_LEG_THICKNESS = 3 * INCH;
/** How far a FLOWER's axis stands off the perimeter wall. INFERRED. */
const FLOWER_WALL_OFFSET = 2.5 * INCH;

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
   *   hiveTipMass?: number,
   * }} opts
   */
  constructor(opts) {
    this.field = opts.field;

    const pivotX = INFERRED.hivePivotX;
    /**
     * Red's HIVE sits on the red side of the crossbar. Section 10.3.1 stages
     * each HIVE with one CELL down; the two ALLIANCES are staged opposite each
     * other so the FIELD has the usual 180 degree rotational symmetry.
     */
    this.hives = {
      red: new Hive({
        alliance: 'red',
        pivotX: -pivotX,
        startUp: 'aft',
        tipMassThreshold: opts.hiveTipMass,
      }),
      blue: new Hive({
        alliance: 'blue',
        pivotX: pivotX,
        startUp: 'fore',
        tipMassThreshold: opts.hiveTipMass,
      }),
    };

    /**
     * Four FLOWERS on the perimeter wall (Section 9.7), placed in line with the
     * HIVES because Section 10.3.1 says the down-tilted CELL "points at" one.
     * INFERRED -- see the docs.
     */
    const fy = HALF_FIELD - FLOWER_WALL_OFFSET;
    this.flowers = [
      new Flower({ id: 'flowerRedFore', x: -pivotX, y: -fy, facing: Math.PI / 2 }),
      new Flower({ id: 'flowerRedAft', x: -pivotX, y: fy, facing: -Math.PI / 2 }),
      new Flower({ id: 'flowerBlueFore', x: pivotX, y: -fy, facing: Math.PI / 2 }),
      new Flower({ id: 'flowerBlueAft', x: pivotX, y: fy, facing: -Math.PI / 2 }),
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
          radius: POLLEN_DIAMETER / 2,
          mass: POLLEN_MASS,
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
            radius: NECTAR_DIAMETER / 2,
            mass: NECTAR_MASS,
          }),
        );
      }
    }

    this.ballWorld = new BallWorld({
      fieldSize: this.field.size,
      wallHeight: this.field.wallHeight,
    });
    for (const ball of this.allBalls) this.ballWorld.add(ball);

    // FLOWERS get first refusal on a descending ball, then the HIVE CELLS. The
    // two never compete: a FLOWER opening is 21.5 in up and a CELL opening is
    // around 49 in, so a ball is never in both capture volumes.
    for (const flower of this.flowers) {
      this.ballWorld.addInteractor((ball) => flower.interactBall(ball));
    }
    for (const hive of [this.hives.red, this.hives.blue]) {
      this.ballWorld.addInteractor((ball) => hive.interactBall(ball));
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
    const legX = FRAME_WIDTH / 2 - FRAME_LEG_THICKNESS / 2;
    for (const sign of [-1, 1]) {
      this.obstacles.push(
        new Obstacle({
          id: `hiveFrameLeg${sign < 0 ? 'Red' : 'Blue'}`,
          position: new Vec2(sign * legX, 0),
          size: new Vec2(FRAME_LEG_THICKNESS, FRAME_DEPTH),
          height: HIVE_PIVOT_HEIGHT,
          color: [0.35, 0.36, 0.4, 1],
        }),
      );
    }

    const tube = FLOWER_OPENING_DIAMETER + 1 * INCH;
    for (const flower of this.flowers) {
      this.obstacles.push(
        new Obstacle({
          id: `${flower.id}Tube`,
          position: new Vec2(flower.x, flower.y),
          size: new Vec2(tube, tube),
          height: FLOWER_OPENING_HEIGHT + FLOWER_BACKSTOP_HEIGHT,
          color: [0.2, 0.6, 0.3, 1],
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
    this.hives.red.reset('aft');
    this.hives.blue.reset('fore');
    for (const ball of this.allBalls) {
      ball.release();
      ball.outOfBounds = false;
      ball.setPosition(0, 0, -1);
    }
    this.ballWorld.settled = false;

    const pool = this.pollen.slice();
    const take = () => pool.shift();

    for (const flower of this.flowers) {
      for (let i = 0; i < FLOWER_START_POLLEN; i++) flower.add(take());
    }

    for (const zone of [this.zones.redGarden, this.zones.blueGarden]) {
      const spots = gardenStagingPositions(zone, GARDEN_START_POLLEN, POLLEN_DIAMETER / 2);
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
        this.ballWorld.addBody(b.body, b.halfLength, b.halfWidth, b.height);
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
    return tips;
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
