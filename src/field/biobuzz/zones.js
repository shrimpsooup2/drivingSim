import { INCH } from '../../math/MathUtil.js';
import {
  GARDEN_LENGTH,
  GARDEN_WIDTH,
  HALF_FIELD,
  INFERRED,
  LOADING_ZONE_DEPTH,
  LOADING_ZONE_WIDTH,
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
 * The four taped zones, two per ALLIANCE.
 *
 * ## Placement is inferred
 *
 * The manual gives the sizes but puts the positions only in figures. Three
 * statements in the text pin them down between them (Section 9.3 and 10.3.1):
 *
 *  - the LOADING ZONE is "bounded by red or blue tape and the adjoining FIELD
 *    perimeters" -- two walls, so a corner -- and "belongs to the ALLIANCE with
 *    the adjacent ALLIANCE AREA", which puts it against the wall the DRIVE TEAM
 *    stands behind. The 23 in runs along that wall, within reach of a human
 *    handing NECTAR over it, and the 11 in reaches into the FIELD.
 *  - GARDENS sit "in opposite corners of the FIELD".
 *  - GARDEN POLLEN is "placed in a line starting in the corner closest to the
 *    ALLIANCE AREA and contacting the audience or rear perimeter wall", so the
 *    23 in strip runs along an audience or rear wall, 2 in deep.
 *
 * All three hold together under the 180 degree rotational symmetry every FTC
 * field has: each ALLIANCE gets a LOADING ZONE in one of its two corners and a
 * GARDEN in the other, and the two GARDENS end up diagonally opposite. Which of
 * the two corners takes which is `INFERRED.redLoadingZoneCorner`.
 *
 * @returns {{
 *   redLoading: GameZone, blueLoading: GameZone,
 *   redGarden: GameZone, blueGarden: GameZone,
 *   all: GameZone[],
 * }}
 */
export function buildZones() {
  // Red's ALLIANCE AREA is on -x ("the red ALLIANCE AREA is located on the
  // left from the primary audience viewing direction", Section 9.5).
  const loadingSignY = INFERRED.redLoadingZoneCorner === 'audience' ? -1 : 1;

  /** LOADING ZONE: against the ALLIANCE AREA wall, in one end corner. */
  const loading = (id, alliance, signX, signY) => {
    const xInner = signX * (HALF_FIELD - LOADING_ZONE_DEPTH);
    const yInner = signY * (HALF_FIELD - LOADING_ZONE_WIDTH);
    return new GameZone({
      id,
      label: `${alliance} LOADING ZONE`,
      alliance,
      minX: Math.min(signX * HALF_FIELD, xInner),
      maxX: Math.max(signX * HALF_FIELD, xInner),
      minY: Math.min(signY * HALF_FIELD, yInner),
      maxY: Math.max(signY * HALF_FIELD, yInner),
    });
  };

  /** GARDEN: a strip along an audience or rear wall, in the other corner. */
  const garden = (id, alliance, signX, signY) => {
    const xInner = signX * (HALF_FIELD - GARDEN_LENGTH);
    const yInner = signY * (HALF_FIELD - GARDEN_WIDTH);
    return new GameZone({
      id,
      label: `${alliance} GARDEN`,
      alliance,
      minX: Math.min(signX * HALF_FIELD, xInner),
      maxX: Math.max(signX * HALF_FIELD, xInner),
      minY: Math.min(signY * HALF_FIELD, yInner),
      maxY: Math.max(signY * HALF_FIELD, yInner),
    });
  };

  const redLoading = loading('redLoading', 'red', -1, loadingSignY);
  const blueLoading = loading('blueLoading', 'blue', 1, -loadingSignY);
  const redGarden = garden('redGarden', 'red', -1, -loadingSignY);
  const blueGarden = garden('blueGarden', 'blue', 1, loadingSignY);

  return {
    redLoading,
    blueLoading,
    redGarden,
    blueGarden,
    all: [redLoading, blueLoading, redGarden, blueGarden],
  };
}

/**
 * Where the setup POLLEN sit in a GARDEN: "placed in a line starting in the
 * corner closest to the ALLIANCE AREA and contacting the audience or rear
 * perimeter wall" (Section 10.3.1). The strip is only 2 in deep and POLLEN are
 * 2.8 in across, so they sit on the strip's centre line, overhanging it.
 *
 * @param {GameZone} zone
 * @param {number} count
 * @param {number} radius
 * @returns {{x: number, y: number}[]}
 */
export function gardenStagingPositions(zone, count, radius) {
  const y = zone.centerY;
  // The corner closest to the ALLIANCE AREA is the outer end in x.
  const fromNegX = zone.minX < 0;
  const start = fromNegX ? zone.minX + radius : zone.maxX - radius;
  const step = (fromNegX ? 1 : -1) * (2 * radius + 0.1 * INCH);
  const out = [];
  for (let i = 0; i < count; i++) out.push({ x: start + i * step, y });
  return out;
}
