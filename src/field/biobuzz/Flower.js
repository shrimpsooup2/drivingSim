import { INCH } from '../../math/MathUtil.js';
import {
  FLOWER_BACKSTOP_TOP,
  FLOWER_RETRIEVAL_GAP,
  FLOWER_SCORING_BOTTOM,
  FLOWER_SCORING_TOP,
  FLOWER_TUBE_RADIUS,
  POINTS,
  POLLEN_RADIUS,
} from './constants.js';

/**
 * A FLOWER: a vertical tube on the perimeter wall holding a single-file stack
 * of SCORING ELEMENTS.
 *
 * Section 9.7: "The FLOWER is a structure on the FIELD in which POLLEN and
 * NECTAR can be placed into the top, and POLLEN can be removed from the
 * bottom."
 *
 * ## Why the stack is ordered
 *
 * Two scoring rules read the stack by position, so the order has to be real
 * rather than a count (Section 10.5.2):
 *
 *  - **FLOWER Owner** -- "The ALLIANCE that has the top-most NECTAR of its
 *    color that meets the criteria for scoring in a FLOWER owns that FLOWER and
 *    will earn points for every POLLEN and NECTAR that meet the scoring
 *    criteria for that FLOWER, regardless of which ALLIANCE placed the POLLEN
 *    and/or NECTAR in the FLOWER."
 *  - **Bottom NECTAR Bonus** -- "The ALLIANCE that has the bottom-most NECTAR
 *    of its color that meets the criteria for scoring in a FLOWER earns
 *    points."
 *
 * So the lowest scoring NECTAR wins 5 points and the highest wins the whole
 * tube at 2 per element. Going in early buys the bonus and going in last buys
 * ownership, off the same stack -- which is the endgame race the manual
 * describes in Section 8.
 *
 * ## Only POLLEN comes out
 *
 * G418 lets a ROBOT "only enter POLLEN and NECTAR into the top of a FLOWER,
 * and only remove POLLEN from the bottom." The geometry enforces it: the
 * retrieval opening is 3.55 in tall (Section 9.7) and NECTAR is 3.6 in across
 * (Section 9.8), so NECTAR physically cannot leave the bottom. A NECTAR low in
 * the tube plugs it, and everything above is stuck there for the rest of the
 * MATCH.
 *
 * ## Measured, not guessed
 *
 * The scoring volume is 4.25 in to 21.25 in above the TILES. That is not a
 * derivation -- it is the span of the four HIPS pipes in the field CAD, which
 * run from the middle ring to the top ring and so *are* the volume.
 *
 * It lands exactly where the game wants it. The CAD stages four POLLEN in every
 * FLOWER at 1.40, 4.29, 7.18 and 10.07 in. The bottom one tops out at 2.80 in,
 * under the 4.25 in floor, so it does not score and it is the one a ROBOT pulls
 * from the retrieval opening; the three above it all score. Collecting from a
 * FLOWER therefore costs the owner nothing until the stack drops.
 *
 */
export class Flower {
  /**
   * @param {{
   *   id: string,
   *   x: number,
   *   y: number,
   *   facing: number,
   *   tubeRadius?: number,
   *   scoringTop?: number,
   *   scoringBottom?: number,
   * }} opts `facing` is the heading pointing from the wall into the FIELD, so
   *   a ROBOT shoots along `facing + PI` and the backstop is behind the tube.
   */
  constructor(opts) {
    this.id = opts.id;
    this.x = opts.x;
    this.y = opts.y;
    this.facing = opts.facing;

    /**
     * Clear radius inside the tube: the circle inscribed between the four HIPS
     * pipes, 2.0 in, which is where the manual's "approximately 4 in" opening
     * comes from.
     */
    this.tubeRadius = opts.tubeRadius ?? FLOWER_TUBE_RADIUS;
    /** Top and bottom of the scoring volume, spanned by the pipes. */
    this.openingHeight = opts.scoringTop ?? FLOWER_SCORING_TOP;
    this.middleRingHeight = opts.scoringBottom ?? FLOWER_SCORING_BOTTOM;

    /**
     * Bottom-to-top. Index 0 rests on the TILE inside the lower ring and is
     * the one a ROBOT can pull out.
     * @type {import('../../physics/Ball.js').Ball[]}
     */
    this.stack = [];

    /**
     * How far past the opening rim a descending ball still gets caught. The
     * backstop (1.25 in tall, Section 9.7) sits on the wall side to "help guide
     * POLLEN and NECTAR into the FLOWER", so an overshot from the FIELD side
     * comes off it and drops in, while an undershot just falls to the floor.
     * That asymmetry is the whole point of the backstop and it is worth
     * simulating -- aim long.
     */
    this.captureMargin = opts.captureMargin ?? 0.75 * INCH;
    this.backstopMargin = opts.backstopMargin ?? 1.75 * INCH;
  }

  /** Ceiling of the scoring volume: the top ring (Section 10.5.2). */
  get scoringTop() {
    return this.openingHeight;
  }

  /** Floor of the scoring volume: the middle ring. INFERRED, see the class note. */
  get scoringBottom() {
    return this.middleRingHeight;
  }

  /** Height of the top of the backstop, for rendering and for shot planning. */
  get backstopTop() {
    return FLOWER_BACKSTOP_TOP;
  }

  /** Diameter of the clear opening, for callers that want it. */
  get tubeDiameter() {
    return this.tubeRadius * 2;
  }

  /**
   * Resting height of the ball at stack index `i`, given the radii below it.
   *
   * A column of balls in a tube wider than the balls does not stack straight:
   * each ball rolls to one side and the next to the other, so consecutive
   * centres are offset horizontally and the column packs tighter than the sum
   * of the diameters. With 2.8 in POLLEN in a 4 in tube the pitch is 2.53 in
   * rather than 2.8 in, which fits one more POLLEN in the tube than a naive
   * column would. 3.6 in NECTAR barely fits and stacks almost straight.
   *
   * The CAD lays its staged POLLEN out at a flat 2.89 in, which is *wider* than
   * a POLLEN -- those balls are not touching, so that is a nominal drawing
   * layout rather than a settled stack. The real pitch is somewhere between
   * 2.53 and 2.80 depending on how each ball happens to fall. It makes no
   * difference to scoring: either way the bottom ball stays under the 4.25 in
   * floor and everything above it scores.
   */
  _restack() {
    let z = 0;
    for (let i = 0; i < this.stack.length; i++) {
      const ball = this.stack[i];
      if (i === 0) {
        // Rests on the TILE. The 2.79 in hole in the lower ring locates a
        // POLLEN laterally but is only 0.4 in deep, so nothing sinks into it.
        z = ball.radius;
      } else {
        const below = this.stack[i - 1];
        const reach = below.radius + ball.radius;
        // Widest the two centres can be apart across the tube.
        const lateral = Math.max(
          0,
          Math.min(reach, 2 * this.tubeRadius - below.radius - ball.radius),
        );
        z += Math.sqrt(Math.max(0, reach * reach - lateral * lateral));
      }
      ball.setPosition(this.x, this.y, z);
      ball.stop();
    }
  }

  /**
   * Height the next ball of `radius` would come to rest at, or `null` if it
   * would sit above the opening -- the tube is full for a ball that size and
   * the shot bounces away.
   */
  restHeightFor(radius) {
    if (this.stack.length === 0) return radius;
    const below = this.stack[this.stack.length - 1];
    const reach = below.radius + radius;
    const lateral = Math.max(
      0,
      Math.min(reach, 2 * this.tubeRadius - below.radius - radius),
    );
    const z = below.z + Math.sqrt(Math.max(0, reach * reach - lateral * lateral));
    return z > this.openingHeight ? null : z;
  }

  /**
   * True when not even a POLLEN, the smaller element, will fit under the top
   * opening. A FLOWER can be full for NECTAR while still taking POLLEN.
   */
  get full() {
    return this.restHeightFor(POLLEN_RADIUS) === null;
  }

  /**
   * Drop a ball onto the top of the stack, bypassing the capture test. Used for
   * MATCH setup and by a ROBOT's placement mechanism.
   * @returns {boolean} false when the tube is full and the ball was not taken.
   */
  add(ball) {
    if (this.restHeightFor(ball.radius) === null) return false;
    this.stack.push(ball);
    ball.attachTo('flower', this);
    this._restack();
    return true;
  }

  /**
   * Capture a loose ball that is dropping into the top opening.
   *
   * Registered as a `BallWorld` interactor, so it gets first refusal on every
   * ball each step and returns true once it has claimed one.
   */
  interactBall(ball) {
    if (!ball.free) return false;
    if (ball.vz > 0.4) return false; // still on the way up

    // Below the rim already, or far above it: not entering the opening.
    if (ball.z < this.openingHeight - ball.radius) return false;
    if (ball.z > this.backstopTop + ball.radius * 2) return false;

    const dx = ball.x - this.x;
    const dy = ball.y - this.y;
    // Distance into the FIELD from the tube axis; negative means wall side,
    // where the backstop is.
    const into = dx * Math.cos(this.facing) + dy * Math.sin(this.facing);
    const across = -dx * Math.sin(this.facing) + dy * Math.cos(this.facing);
    // A ball only clears the rim if its centre is within (tube radius - ball
    // radius) of the axis, so the window is much tighter than the 4 in opening
    // suggests -- 0.6 in for POLLEN, 0.2 in for NECTAR. The margins widen that
    // to cover a ball that clips the rim and rattles in, and the backstop
    // widens it further on the wall side only.
    const clearance = Math.max(0, this.tubeRadius - ball.radius);
    const alongLimit =
      clearance + (into < 0 ? this.backstopMargin : this.captureMargin);
    const acrossLimit = clearance + this.captureMargin;
    // Elliptical capture footprint, stretched toward the wall by the backstop.
    const u = into / alongLimit;
    const v = across / acrossLimit;
    if (u * u + v * v > 1) return false;

    if (this.restHeightFor(ball.radius) === null) return false;
    // Landing in a FLOWER is contact with something that is not a ROBOT, so it
    // closes G409's catch window the same way the TILES do.
    ball.touchedStructure();
    this.stack.push(ball);
    ball.attachTo('flower', this);
    this._restack();
    return true;
  }

  /**
   * Pull the bottom element out through the retrieval opening.
   *
   * G418 permits POLLEN only, and the 3.55 in opening physically blocks 3.6 in
   * NECTAR, so a NECTAR at the bottom returns null and plugs the FLOWER.
   * @returns {import('../../physics/Ball.js').Ball|null}
   */
  removeBottom() {
    const ball = this.stack[0];
    if (!ball) return null;
    if (ball.radius * 2 > FLOWER_RETRIEVAL_GAP) return null;
    this.stack.shift();
    ball.release();
    this._restack();
    return ball;
  }

  /** Balls at least partially inside the scoring volume (Section 10.5.2). */
  scoringElements() {
    return this.stack.filter(
      (b) => b.z + b.radius > this.scoringBottom && b.z - b.radius < this.scoringTop,
    );
  }

  /**
   * The ALLIANCE owning the FLOWER: whoever's NECTAR is top-most among the
   * scoring elements, or null when neither alliance has NECTAR in the volume.
   * @returns {'red'|'blue'|null}
   */
  owner() {
    const scoring = this.scoringElements();
    for (let i = scoring.length - 1; i >= 0; i--) {
      if (scoring[i].kind === 'nectar') return scoring[i].alliance;
    }
    return null;
  }

  /**
   * The ALLIANCE holding the bottom-most scoring NECTAR, which earns the 5
   * point Bottom NECTAR Bonus.
   * @returns {'red'|'blue'|null}
   */
  bottomNectarAlliance() {
    const scoring = this.scoringElements();
    for (const ball of scoring) {
      if (ball.kind === 'nectar') return ball.alliance;
    }
    return null;
  }

  /**
   * Points this FLOWER awards each ALLIANCE at the end of the MATCH.
   *
   * Ownership pays 2 for *every* scoring element regardless of who placed it,
   * so a tube a ROBOT spent the MATCH filling can be taken whole by one late
   * NECTAR from the other alliance.
   * @returns {{red: number, blue: number}}
   */
  score() {
    const out = { red: 0, blue: 0 };
    const owner = this.owner();
    if (owner) out[owner] += this.scoringElements().length * POINTS.elementInOwnedFlower;
    const bottom = this.bottomNectarAlliance();
    if (bottom) out[bottom] += POINTS.bottomNectarBonus;
    return out;
  }

  /**
   * Drop a ball, because something else has taken it, and let the rest of the
   * column settle into the gap.
   * @param {import('../../physics/Ball.js').Ball} ball
   */
  detachBall(ball) {
    const i = this.stack.indexOf(ball);
    if (i < 0) return;
    this.stack.splice(i, 1);
    this._restack();
  }

  /** Everything in the tube, released. Used when resetting a MATCH. */
  clear() {
    const taken = this.stack.slice();
    this.stack.length = 0;
    for (const ball of taken) ball.release();
    return taken;
  }
}
