import { Vec2 } from '../../math/Vec2.js';
import {
  CELL_DEPTH,
  CELL_OPENING_HEIGHT,
  CELL_OPENING_WIDTH,
  CELL_REST_HEIGHT,
  CELL_REST_OFFSET,
  HIVE_PIVOT_HEIGHT,
  INFERRED,
  NECTAR_MASS,
} from './constants.js';

/**
 * Distance from the pivot to where SCORING ELEMENTS come to rest in a CELL,
 * and the angle of that line above horizontal. Both follow from the two
 * numbers the field CAD gives directly: 9.4 in out and 50.2 in up.
 *
 * This is a little steeper than the 30 degrees the HIVE structure itself rests
 * at, because elements sit on the CELL floor rather than on the arm's centre
 * line. It is the ball's position that a LAUNCHER has to hit, so it is the one
 * modelled here.
 */
const ARM_RADIUS = Math.hypot(CELL_REST_OFFSET, CELL_REST_HEIGHT - HIVE_PIVOT_HEIGHT);
const ARM_ANGLE = Math.atan2(CELL_REST_HEIGHT - HIVE_PIVOT_HEIGHT, CELL_REST_OFFSET);

/**
 * One ALLIANCE's HIVE: a bi-stable see-saw with a CELL at each end.
 *
 * Section 9.6.2: "Each HIVE is a bi-stable structure made up of two CELLS and a
 * connecting assembly that rotates on a pivot... has two stable positions: each
 * one with one CELL facing upwards."
 *
 * The core scoring loop of BIOBUZZ runs through this object. Fill the
 * upward-facing CELL until it tips (20 points, Table 10-2), the contents spill
 * as that CELL rotates to face down, and the opposite CELL arrives empty and
 * upward-facing ready to be filled again. Whatever is left in the upward CELL
 * when everything comes to rest scores 2 each.
 *
 * The **tip threshold is not published**. The manual only says the HIVE "will
 * hold its position until enough POLLEN or NECTAR are LAUNCHED into the
 * upwards-facing CELL". It is modelled here as a mass, which is what a physical
 * bi-stable balance actually responds to, and calibrated against the one hard
 * constraint the manual does give: three NECTAR are staged in the upward CELL
 * at the start of every MATCH (Section 10.3.1) and the HIVE must not tip.
 */
export class Hive {
  /**
   * @param {{
   *   alliance: 'red'|'blue',
   *   pivotX: number,
   *   tilt?: number,
   *   tipMassThreshold?: number,
   *   tipDuration?: number,
   *   startUp?: 'fore'|'aft',
   * }} opts
   */
  constructor(opts) {
    this.alliance = opts.alliance;
    this.pivotX = opts.pivotX;
    this.tilt = opts.tilt ?? ARM_ANGLE;
    /**
     * Contained mass that tips the HIVE. Three NECTAR is 0.255 kg and must
     * hold, so anything at or below that would tip at setup and break the game.
     */
    this.tipMassThreshold = opts.tipMassThreshold ?? NECTAR_MASS * 3 + 0.045;
    /** How long the rotation takes, for the animation and for spilling. */
    this.tipDuration = opts.tipDuration ?? 0.6;

    /**
     * Which CELL is currently up. 'fore' is the audience side (-y), 'aft' the
     * rear (+y). Section 10.3.1 stages each HIVE with one CELL down -- "the
     * CELL which points at a FLOWER should be the one tilted down".
     */
    this.up = opts.startUp ?? 'fore';

    /** @type {import('../../physics/Ball.js').Ball[]} */
    this.foreBalls = [];
    /** @type {import('../../physics/Ball.js').Ball[]} */
    this.aftBalls = [];

    this.tips = 0;
    /** Tips completed before TELEOP began, scored as AUTO per Section 10.5.B. */
    this.autoTips = 0;
    /** 0 while stable, ramping to 1 during a tip. */
    this.tipProgress = 0;
    this.tipping = false;
    /** Balls thrown clear by the last tip, for the caller to re-add to the world. */
    this.spilled = [];
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
    return this.upBalls.reduce((total, ball) => total + ball.mass, 0);
  }

  /**
   * Signed tilt of the arm, accounting for an in-progress rotation so the
   * renderer can animate it.
   */
  get currentTilt() {
    const target = this.up === 'fore' ? -this.tilt : this.tilt;
    if (!this.tipping) return target;
    // Rotating away from the previous state toward the new one.
    const from = -target;
    return from + (target - from) * easeInOut(this.tipProgress);
  }

  /**
   * Centre of a CELL's opening, in field coordinates.
   * @param {'fore'|'aft'} side
   * @returns {{x:number, y:number, z:number}}
   */
  cellOpening(side) {
    const tilt = this.currentTilt;
    // The two CELLS are opposite ends of one arm through the pivot: 'fore' at
    // -y, 'aft' at +y. A positive tilt means the aft CELL is the raised one.
    const sign = side === 'fore' ? -1 : 1;
    return {
      x: this.pivotX,
      y: sign * ARM_RADIUS * Math.cos(tilt),
      z: HIVE_PIVOT_HEIGHT + sign * ARM_RADIUS * Math.sin(tilt),
    };
  }

  /** Opening of whichever CELL currently faces up: the thing to shoot at. */
  get target() {
    return this.cellOpening(this.up);
  }

  /**
   * Try to capture a free ball into the upward-facing CELL.
   *
   * The capture volume is the CELL opening, inflated slightly, and the ball
   * must be falling -- a ball rising through the plane is on its way out, not
   * in. Returns true if the CELL took it.
   *
   * @param {import('../../physics/Ball.js').Ball} ball
   */
  interactBall(ball) {
    if (this.tipping) return false;
    const opening = this.target;
    const margin = INFERRED.cellCaptureMargin;

    const withinWidth = Math.abs(ball.x - opening.x) <= CELL_OPENING_WIDTH / 2 + margin;
    const withinDepth = Math.abs(ball.y - opening.y) <= CELL_DEPTH / 2 + margin;
    // A band around the opening plane, deep enough that a fast ball cannot
    // pass straight through between steps.
    const withinHeight =
      ball.z <= opening.z + CELL_OPENING_HEIGHT / 2 &&
      ball.z >= opening.z - CELL_OPENING_HEIGHT;

    if (!withinWidth || !withinDepth || !withinHeight) return false;
    if (ball.vz > 0.4) return false; // still climbing; it has not gone in

    this.upBalls.push(ball);
    ball.attachTo('cell', this);
    this._restackCell();
    return true;
  }

  /**
   * Put a ball straight into the upward-facing CELL, bypassing the capture
   * test. Section 10.3.1 stages three NECTAR there before the MATCH, and
   * nothing LAUNCHES them.
   * @param {import('../../physics/Ball.js').Ball} ball
   */
  stage(ball) {
    this.upBalls.push(ball);
    ball.attachTo('cell', this);
    this._restackCell();
    return ball;
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

  /** Lay the contained balls out inside the CELL so they render sensibly. */
  _restackCell() {
    const opening = this.target;
    const balls = this.upBalls;
    const perRow = Math.max(1, Math.floor(CELL_OPENING_WIDTH / (3.6 * 0.0254)));
    balls.forEach((ball, i) => {
      const row = Math.floor(i / perRow);
      const column = i % perRow;
      const spread = CELL_OPENING_WIDTH / (perRow + 1);
      ball.setPosition(
        opening.x - CELL_OPENING_WIDTH / 2 + spread * (column + 1),
        opening.y + (row % 2 === 0 ? -0.03 : 0.03),
        opening.z + (row === 0 ? 0 : -row * ball.radius * 1.6),
      );
      ball.stop();
    });
  }

  /**
   * Advance the HIVE: check the tip condition, run the rotation, spill.
   * @param {number} dt seconds
   * @param {boolean} inAuto whether the MATCH is still in AUTO
   */
  update(dt, inAuto) {
    if (this.tipping) {
      this.tipProgress += dt / this.tipDuration;
      if (this.tipProgress >= 1) {
        this._completeTip(inAuto);
      }
      return;
    }

    if (this.containedMass >= this.tipMassThreshold) {
      this.tipping = true;
      this.tipProgress = 0;
    } else {
      this._restackCell();
    }
  }

  _completeTip(inAuto) {
    // Snapshot first: `release` tells this CELL to drop each ball, which
    // splices the live array out from under the loop and would leave half the
    // contents behind.
    const spilling = this.upBalls.slice();
    // The CELL that was up is now down, so its contents fall out. This is the
    // mechanism that makes the loop repeatable: the newly-upward CELL arrives
    // empty every time.
    const opening = this.cellOpening(this.up);
    for (const ball of spilling) {
      ball.release(
        (Math.random() * 2 - 1) * 0.6,
        (Math.random() * 2 - 1) * 0.6,
        -0.2,
      );
      ball.setPosition(
        opening.x + (Math.random() * 2 - 1) * 0.15,
        opening.y + (Math.random() * 2 - 1) * 0.15,
        Math.max(ball.radius, opening.z - 0.3),
      );
      this.spilled.push(ball);
    }
    this.upBalls.length = 0;

    this.up = this.up === 'fore' ? 'aft' : 'fore';
    this.tipping = false;
    this.tipProgress = 0;
    this.tips++;
    if (inAuto) this.autoTips++;
  }

  /** Collect and clear the balls thrown out by the last tip. */
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
    this.tips = 0;
    this.autoTips = 0;
    this.tipping = false;
    this.tipProgress = 0;
    this.spilled.length = 0;
  }

  /** Plan-view position, for the renderer and for AI targeting. */
  get position() {
    return new Vec2(this.pivotX, 0);
  }
}

function easeInOut(t) {
  const x = Math.min(1, Math.max(0, t));
  return x < 0.5 ? 2 * x * x : 1 - 2 * (1 - x) * (1 - x);
}
