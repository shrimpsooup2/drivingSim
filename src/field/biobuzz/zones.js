import { INCH } from '../../math/MathUtil.js';
import {
  POLLEN_RADIUS,
  RED_ALLIANCE_AREA,
  RED_GARDEN,
  RED_GARDEN_POLLEN,
  RED_LOADING_ZONE,
  mirrorToBlue,
} from './constants.js';

/**
 * A wall-aligned rectangular region of the FIELD floor, extending infinitely
 * upward (Section 9.3: every BIOBUZZ zone is an "infinitely tall volume").
 *
 * Both scoring tests the game needs are "at least partially in": a SCORING
 * ELEMENT in the GARDEN (Section 10.5.3) and a ROBOT in the LOADING ZONE for
 * PARK (Section 10.5.4). So this exposes overlap tests for a sphere and for an
 * oriented box rather than just a point-inside test.
 */
export class GameZone {
  /**
   * @param {{
   *   id: string,
   *   label: string,
   *   alliance?: 'red'|'blue'|'neutral',
   *   minX: number, maxX: number, minY: number, maxY: number,
   * }} opts
   */
  constructor(opts) {
    this.id = opts.id;
    this.label = opts.label;
    this.alliance = opts.alliance ?? 'neutral';
    this.minX = opts.minX;
    this.maxX = opts.maxX;
    this.minY = opts.minY;
    this.maxY = opts.maxY;
  }

  get centerX() {
    return (this.minX + this.maxX) / 2;
  }

  get centerY() {
    return (this.minY + this.maxY) / 2;
  }

  get width() {
    return this.maxX - this.minX;
  }

  get depth() {
    return this.maxY - this.minY;
  }

  containsPoint(x, y) {
    return x >= this.minX && x <= this.maxX && y >= this.minY && y <= this.maxY;
  }

  /** True when any part of a ball of `radius` is inside. */
  overlapsCircle(x, y, radius) {
    const dx = Math.max(this.minX - x, 0, x - this.maxX);
    const dy = Math.max(this.minY - y, 0, y - this.maxY);
    return dx * dx + dy * dy <= radius * radius;
  }

  /**
   * True when any part of a robot footprint is inside. The zones are
   * axis-aligned, so it is enough to project the rotated half-extents onto x
   * and y and compare the resulting AABB -- for an axis-aligned box against an
   * oriented box, the axis-aligned box's own two axes are the only separating
   * axes that can be missed by a rotated-corner test, and the OBB's axes are
   * covered by its support along x and y.
   */
  overlapsBox(x, y, heading, halfLength, halfWidth) {
    const c = Math.abs(Math.cos(heading));
    const s = Math.abs(Math.sin(heading));
    const ex = halfLength * c + halfWidth * s;
    const ey = halfLength * s + halfWidth * c;
    return (
      x + ex >= this.minX &&
      x - ex <= this.maxX &&
      y + ey >= this.minY &&
      y - ey <= this.maxY
    );
  }
}

/**
 * The taped zones, measured from the sixteen gaffer tape pieces in the field
 * CAD rather than guessed from the manual's prose.
 *
 * Two of those measurements contradict what the text alone suggested, and both
 * matter to a driver:
 *
 *  - the **LOADING ZONE is not in a corner**. "Bounded by red or blue tape and
 *    the adjoining FIELD perimeters" (Section 9.3) reads like a corner, but the
 *    tape is three sides of a rectangle against the middle of each ALLIANCE
 *    wall -- red spans y 23.91 to 46.60 in, offset toward the rear. PARKING
 *    means getting to the middle of your own wall, not diving into a corner.
 *  - the **GARDENS sit diagonally opposite** as the manual says, but red's is
 *    against the *audience* wall on the red side.
 *
 * The whole layout is 180 degree rotationally symmetric, so blue is red
 * mirrored through the origin and only red's numbers are stored.
 *
 * @returns {{
 *   redLoading: GameZone, blueLoading: GameZone,
 *   redGarden: GameZone, blueGarden: GameZone,
 *   redAllianceArea: GameZone, blueAllianceArea: GameZone,
 *   all: GameZone[], scoring: GameZone[],
 * }}
 */
export function buildZones() {
  const make = (id, label, alliance, rect) => new GameZone({ id, label, alliance, ...rect });

  const redLoading = make('redLoading', 'red LOADING ZONE', 'red', RED_LOADING_ZONE);
  const blueLoading = make('blueLoading', 'blue LOADING ZONE', 'blue', mirrorToBlue(RED_LOADING_ZONE));
  const redGarden = make('redGarden', 'red GARDEN', 'red', RED_GARDEN);
  const blueGarden = make('blueGarden', 'blue GARDEN', 'blue', mirrorToBlue(RED_GARDEN));
  const redAllianceArea = make('redAllianceArea', 'red ALLIANCE AREA', 'red', RED_ALLIANCE_AREA);
  const blueAllianceArea = make('blueAllianceArea', 'blue ALLIANCE AREA', 'blue', mirrorToBlue(RED_ALLIANCE_AREA));

  return {
    redLoading,
    blueLoading,
    redGarden,
    blueGarden,
    redAllianceArea,
    blueAllianceArea,
    all: [redLoading, blueLoading, redGarden, blueGarden],
    scoring: [redGarden, blueGarden],
  };
}

/**
 * Where the setup POLLEN sit in a GARDEN. The CAD stages four of them along
 * the wall 2.89 in apart, starting hard in the corner closest to the ALLIANCE
 * AREA, exactly as Section 10.3.1 describes.
 *
 * @param {GameZone} zone
 * @returns {{x: number, y: number}[]}
 */
export function gardenStagingPositions(zone) {
  const red = zone.centerX < 0;
  return RED_GARDEN_POLLEN.map((p) => (red ? { ...p } : { x: -p.x, y: -p.y }));
}

/** Radius of a staged GARDEN POLLEN, for callers placing them. */
export const GARDEN_POLLEN_RADIUS = POLLEN_RADIUS;
