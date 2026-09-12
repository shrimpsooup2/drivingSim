import { INCH } from '../../math/MathUtil.js';

/**
 * BIOBUZZ field dimensions.
 *
 * ## Provenance matters here
 *
 * Two kinds of number live in this file and they are **not** equally
 * trustworthy:
 *
 *  - `MANUAL` values are stated outright in the BIOBUZZ Competition Manual V1
 *    with the section they come from. Treat these as correct.
 *  - `INFERRED` values are *not* in the manual text. The manual gives them only
 *    in figures, and the figures were not part of the uploaded HTML. They are
 *    reasoned from the stated dimensions and from the manual's own hints -- the
 *    strongest being "the CELL which 'points at' a FLOWER should be the one
 *    tilted down" (Section 10.3.1), which aligns each FLOWER with a HIVE.
 *
 * Every inferred value is exposed as a parameter, so when the official CAD or
 * the Field Setup Guide is to hand, correcting them is an edit here and
 * nothing else. Anything that depends on an inferred number is marked in the
 * code that uses it.
 *
 * ## Coordinates
 *
 * Origin at the field centre. **+x** runs from the red ALLIANCE AREA toward
 * the blue one; **+y** runs from the audience wall toward the rear wall;
 * headings are counter-clockwise. This matches the rest of the simulator and
 * the FTC convention, and it puts red in FIELD columns A-C and blue in D-F as
 * G304 requires.
 *
 * @module
 */

// ---------------------------------------------------------------- MANUAL

/** Section 9.2: 144 in inside the perimeter, 36 tiles of 24 in. */
export const FIELD_SIZE = 144 * INCH;
export const HALF_FIELD = FIELD_SIZE / 2;
export const TILE_SIZE = 24 * INCH;

/** Section 9.8: POLLEN are ~2.8 in yellow balls; 40 of them. */
export const POLLEN_DIAMETER = 2.8 * INCH;
export const POLLEN_COUNT = 40;

/** Section 9.8: NECTAR are ~3.6 in balls; 8 red and 8 blue. */
export const NECTAR_DIAMETER = 3.6 * INCH;
export const NECTAR_PER_ALLIANCE = 8;

/**
 * Ball masses are **not published**. These are estimates for Gopher ResisDent
 * polyethylene balls of the stated diameters, and they only matter for how
 * far a robot shoves a pile and how a launcher behaves, not for scoring.
 */
export const POLLEN_MASS = 0.045;
export const NECTAR_MASS = 0.085;

/** Section 9.6.1: frame is 49.46 in wide, 38.95 in deep, pivots 43.95 in up. */
export const FRAME_WIDTH = 49.46 * INCH;
export const FRAME_DEPTH = 38.95 * INCH;
export const HIVE_PIVOT_HEIGHT = 43.95 * INCH;

/** Section 9.6.2: the two CELLS of a HIVE sit ~18.8 in apart. */
export const CELL_SPACING = 18.8 * INCH;

/** Section 9.6.2: CELL opening is ~20 in wide, 14 in tall, 12 in deep. */
export const CELL_OPENING_WIDTH = 20 * INCH;
export const CELL_OPENING_HEIGHT = 14 * INCH;
export const CELL_DEPTH = 12 * INCH;

/** Section 9.7: FLOWER top opening ~4 in across, ~21.5 in above the tiles. */
export const FLOWER_OPENING_DIAMETER = 4 * INCH;
export const FLOWER_OPENING_HEIGHT = 21.5 * INCH;
/** Section 9.7: backstop above the opening, 1.25 in tall. */
export const FLOWER_BACKSTOP_HEIGHT = 1.25 * INCH;
/** Section 9.7: retrieval opening at the bottom, ~3.55 in tall, 3.57 in deep. */
export const FLOWER_RETRIEVAL_HEIGHT = 3.55 * INCH;
export const FLOWER_RETRIEVAL_DEPTH = 3.57 * INCH;
/** Section 9.7: lower ring 0.4 in tall with a 2.79 in hole for one POLLEN. */
export const FLOWER_LOWER_RING_HEIGHT = 0.4 * INCH;
export const FLOWER_LOWER_RING_HOLE = 2.79 * INCH;

/** Section 9.3: LOADING ZONE is ~23 in by 11 in, in a corner. */
export const LOADING_ZONE_WIDTH = 23 * INCH;
export const LOADING_ZONE_DEPTH = 11 * INCH;

/** Section 9.3: GARDEN is a ~23 in by 2 in strip in a corner. */
export const GARDEN_LENGTH = 23 * INCH;
export const GARDEN_WIDTH = 2 * INCH;

/** Section 9.3: ALLIANCE AREA is ~97 in by 54 in, outside the FIELD. */
export const ALLIANCE_AREA_WIDTH = 97 * INCH;
export const ALLIANCE_AREA_DEPTH = 54 * INCH;

/** Section 10.4: 30 s AUTO, 8 s transition, 2:00 TELEOP. */
export const AUTO_SECONDS = 30;
export const TRANSITION_SECONDS = 8;
export const TELEOP_SECONDS = 120;
/** Section 10.5.2 / G410: FLOWER scoring opens with 60 s left in TELEOP. */
export const FLOWER_UNLOCK_REMAINING = 60;

/** Section 12.1: STARTING CONFIGURATION fits an 18 in cube. */
export const ROBOT_SIZE_LIMIT = 18 * INCH;

/** Section 10.3.1: 4 POLLEN pre-loaded per ROBOT. */
export const PRELOAD_POLLEN = 4;
/** Section 10.3.1: 4 POLLEN in each FLOWER at the start. */
export const FLOWER_START_POLLEN = 4;
/** Section 10.3.1: 4 POLLEN in each GARDEN at the start. */
export const GARDEN_START_POLLEN = 4;
/** Section 10.3.1: 3 NECTAR staged in each upward-facing CELL. */
export const CELL_START_NECTAR = 3;
/** Section 10.3.1: 5 NECTAR staged in each ALLIANCE AREA, released per TIP. */
export const ALLIANCE_AREA_NECTAR = 5;

/** Section 10.5.5, Table 10-2. */
export const POINTS = {
  leaveAuto: 3,
  parkAuto: 5,
  parkTeleop: 5,
  hiveTipAuto: 20,
  hiveTipTeleop: 20,
  elementInCell: 2,
  bottomNectarBonus: 5,
  elementInOwnedFlower: 2,
  elementInGarden: 1,
  win: 3,
  tie: 1,
};

/** Section 10.5.5, Table 10-3, "All Other Events" column. */
export const RP_THRESHOLDS = {
  swarmPoints: 16,
  pollinator1Tips: 4,
  pollinator2Tips: 7,
};

// -------------------------------------------------------------- INFERRED

/**
 * Everything below is reasoned, not quoted. See the module note.
 */
export const INFERRED = {
  /**
   * Where the two HIVE pivots sit along the crossbar. The frame is 49.46 in
   * wide (MANUAL) with a triangle at each end, so the pivots are spaced evenly
   * along it at roughly a quarter and three quarters.
   */
  hivePivotX: FRAME_WIDTH / 4,

  /**
   * How far a HIVE arm tilts from horizontal in each stable state. Not stated
   * anywhere. This sets how high the up-facing CELL opening ends up, which is
   * the single most important number for a shooter, so it is the first thing
   * to correct against CAD.
   */
  hiveTiltDegrees: 35,

  /**
   * FLOWER positions. Four FLOWERS attach to the perimeter wall (MANUAL), and
   * Section 10.3.1 says the down-tilted CELL "points at" a FLOWER. Each HIVE's
   * CELLS lie fore and aft of its pivot, so each FLOWER is placed on the
   * audience or rear wall in line with a HIVE.
   */
  flowerAlignedWithHive: true,

  /**
   * Which corner each zone occupies. The manual says the LOADING ZONE is
   * bounded by "the adjoining FIELD perimeters" (a corner) next to its
   * ALLIANCE AREA, that GARDENS are in "opposite corners", and that GARDEN
   * POLLEN is placed "in the corner closest to the ALLIANCE AREA and
   * contacting the audience or rear perimeter wall". This layout satisfies all
   * three with the 180 degree rotational symmetry FTC fields use: each
   * alliance gets a LOADING ZONE in one end corner and a GARDEN in the other.
   */
  redLoadingZoneCorner: 'audience',
  redGardenCorner: 'rear',

  /**
   * How much of the CELL opening a ball must be inside to count as captured.
   * The manual defines scoring by what remains in the CELL at rest, not by a
   * capture volume, so this is a simulation detail.
   */
  cellCaptureMargin: 1.5 * INCH,
};

/** Tilt in radians, from the inferred degrees. */
export const HIVE_TILT = (INFERRED.hiveTiltDegrees * Math.PI) / 180;

/**
 * Height of the centre of an upward-facing CELL opening.
 * Depends on the inferred tilt.
 */
export function upCellHeight(tiltRadians = HIVE_TILT) {
  return HIVE_PIVOT_HEIGHT + (CELL_SPACING / 2) * Math.sin(tiltRadians);
}

/**
 * Horizontal offset of a CELL from its HIVE pivot, along the fore-aft axis.
 * Depends on the inferred tilt.
 */
export function cellHorizontalOffset(tiltRadians = HIVE_TILT) {
  return (CELL_SPACING / 2) * Math.cos(tiltRadians);
}
