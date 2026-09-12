import { INCH } from '../../math/MathUtil.js';

/**
 * BIOBUZZ field dimensions.
 *
 * ## Provenance
 *
 * Every number here is either quoted from the BIOBUZZ Competition Manual V1
 * with its section, or measured from the official field CAD. Both are marked.
 * The CAD is the Onshape STEP AP242 export of `am-5850 BIOBUZZ` the team
 * uploaded; where the two disagree the CAD wins, because the manual rounds
 * (NECTAR is "3.6 in" in the text and 3.62 in the model).
 *
 * The CAD settled four things this file had guessed wrong before it arrived,
 * all of which change how the game is played:
 *
 *  - there is **one FLOWER per wall**, not two per ALLIANCE side;
 *  - the HIVE rests at **30 degrees**, not 35;
 *  - red starts with its **audience-side** CELL up, not the rear one;
 *  - the LOADING ZONE is **not in a corner** -- it is against the middle of
 *    each ALLIANCE wall.
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

// ------------------------------------------------------------------- CAD

/**
 * Everything below is measured from the official field CAD -- an Onshape
 * STEP AP242 export of `am-5850 BIOBUZZ`, exported 2026-09-09, with 832 part
 * occurrences. These are not estimates.
 *
 * The CAD is Y-up with the TILE surface at y = 0. The mapping into simulator
 * coordinates is `simX = cadX`, `simY = -cadZ`, `simZ = cadY`, fixed by two
 * facts in the model: the red NECTAR staging tray sits outside the `cadX = -72`
 * wall, and the CELL named "Red Cell (Audience)" is the one on `cadZ > 0`.
 * Together those put red on the audience's left exactly as Section 9.5
 * requires.
 */

/** Inside face of the perimeter wall, and its height. */
export const FIELD_INNER_HALF = 71.61 * INCH;
export const WALL_HEIGHT = 11.3 * INCH;
/** The TILE field is slightly smaller than the perimeter it sits inside. */
export const TILE_FIELD_HALF = 70.72 * INCH;
export const TILE_THICKNESS = 0.59 * INCH;

/** Measured ball radii. The manual rounds NECTAR to 3.6 in; CAD says 3.62. */
export const POLLEN_RADIUS = 1.4 * INCH;
export const NECTAR_RADIUS = 1.81 * INCH;

// -- HIVE ------------------------------------------------------------------

/** Pivot bearings sit at the centre of each HIVE, on the A-frame top bar. */
export const HIVE_PIVOT_X = 12.7 * INCH;
/** A-frame footprint: legs at +-24.3 in across, +-19.07 in fore and aft. */
export const FRAME_HALF_WIDTH = 24.3 * INCH;
export const FRAME_HALF_DEPTH = 19.07 * INCH;

/**
 * The HIVE's resting tilt, read off the four Goal Rib origins of one HIVE:
 * they lie on a straight line whose slope is 0.577 to four figures, in three
 * independent segments. That is 30.0 degrees, not the 35 this file guessed
 * before the CAD arrived.
 */
export const HIVE_TILT_DEGREES = 30;
export const HIVE_TILT = (HIVE_TILT_DEGREES * Math.PI) / 180;

/**
 * Where a SCORING ELEMENT comes to rest in the upward-facing CELL, measured
 * from the three NECTAR the CAD stages there: 9.4 in horizontally from the
 * pivot on the up side, 50.2 in above the TILES. This is the point a LAUNCHER
 * has to put a ball on, so it is the number that matters most for shooting.
 */
export const CELL_REST_OFFSET = 9.4 * INCH;
export const CELL_REST_HEIGHT = 50.2 * INCH;
/** The downward CELL mirrors it through the pivot. */
export const CELL_DOWN_HEIGHT = 2 * HIVE_PIVOT_HEIGHT - CELL_REST_HEIGHT;

/**
 * Which CELL each ALLIANCE starts with facing up. Red's audience-side CELL is
 * up and blue's rear-side CELL is up, so the FIELD has its usual 180 degree
 * rotational symmetry -- and each HIVE's *down* CELL then points at the FLOWER
 * on its own half of the FIELD, which is the mnemonic in Section 10.3.1.
 */
export const RED_START_UP = 'fore';
export const BLUE_START_UP = 'aft';

// -- FLOWER ----------------------------------------------------------------

/**
 * One FLOWER per wall, not two per side. Each sits 68.04 in from the field
 * centre along the wall normal and 23.39 in off that wall's centre line, laid
 * out with 180 degree rotational symmetry.
 */
export const FLOWER_AXIS_OFFSET = 68.04 * INCH;
export const FLOWER_ALONG_WALL = 23.39 * INCH;

/**
 * The scoring volume, "between the top ring and the middle ring" (Section
 * 10.5.2). The four HIPS pipes span exactly 4.25 in to 21.25 in, which is the
 * volume itself rather than a derived guess.
 */
export const FLOWER_SCORING_BOTTOM = 4.25 * INCH;
export const FLOWER_SCORING_TOP = 21.25 * INCH;

/** Ring plates: lower sits on the TILE, middle and top carry the pipes. */
export const FLOWER_LOWER_RING_TOP = 0.7 * INCH;
export const FLOWER_MIDDLE_RING_TOP = 5.29 * INCH;
export const FLOWER_TOP_RING_TOP = 21.4 * INCH;
/** The backstop plate, on the wall side of the tube. */
export const FLOWER_BACKSTOP_TOP = 22.65 * INCH;

/**
 * Clear radius inside the tube. The four pipes stand on a square at +-1.725 in
 * on each axis, 0.44 in in radius, leaving a 2.0 in inscribed radius -- which
 * is where the manual's "approximately 4 in. diameter" opening comes from.
 */
export const FLOWER_TUBE_RADIUS = 2.0 * INCH;
export const FLOWER_PIPE_OFFSET = 1.725 * INCH;
export const FLOWER_PIPE_RADIUS = 0.44 * INCH;

/**
 * Heights of the four POLLEN the CAD stages in every FLOWER: 1.40, 4.29, 7.18
 * and 10.07 in. The bottom one sits on the TILE with its top at 2.80 in, below
 * the 4.25 in floor of the scoring volume -- so it does not score, and it is
 * the one a ROBOT pulls out of the retrieval opening. The three above it do
 * score. That is the FLOWER's whole design in one column.
 */
export const FLOWER_STAGED_HEIGHTS = [1.4, 4.29, 7.18, 10.07].map((v) => v * INCH);

// -- ZONES -----------------------------------------------------------------

/**
 * LOADING ZONES are **not** in a corner. Each is a 22.69 in by 11 in rectangle
 * against the middle-ish of its own ALLIANCE wall, taped on three sides with
 * the wall closing the fourth: red spans y 23.91 to 46.60 against the red wall,
 * blue is its 180 degree mirror. Measured from the six gaffer tape pieces.
 */
export const RED_LOADING_ZONE = {
  minX: -FIELD_INNER_HALF,
  maxX: -59.1 * INCH,
  minY: 23.91 * INCH,
  maxY: 46.6 * INCH,
};

/**
 * GARDENS are a 22.69 in by 2 in strip in diagonally opposite corners: red
 * against the audience wall on the red side, blue against the rear wall on the
 * blue side.
 */
export const RED_GARDEN = {
  minX: -70.1 * INCH,
  maxX: -47.41 * INCH,
  minY: -70.1 * INCH,
  maxY: -68.1 * INCH,
};

/** Staged GARDEN POLLEN, from the corner inward, 2.89 in apart. */
export const RED_GARDEN_POLLEN = [-69.27, -66.38, -63.49, -60.6].map((v) => ({
  x: v * INCH,
  y: -69.27 * INCH,
}));

/** ALLIANCE AREA, outside the perimeter: 54 in deep by 96.82 in wide. */
export const RED_ALLIANCE_AREA = {
  minX: -125.65 * INCH,
  maxX: -71.65 * INCH,
  minY: -48.41 * INCH,
  maxY: 48.41 * INCH,
};

// -------------------------------------------------------------- INFERRED

/**
 * What the CAD still does not settle. Everything that used to live here has
 * been measured; only simulation-side choices remain.
 */
export const INFERRED = {
  /**
   * How much of the CELL opening a ball must be inside to count as captured.
   * The manual defines scoring by what remains in the CELL at rest, not by a
   * capture volume, so this is a simulation detail.
   */
  cellCaptureMargin: 1.5 * INCH,
};

/**
 * Rotate a red-side point 180 degrees to get its blue counterpart. The whole
 * FIELD is laid out this way and the CAD confirms it piece by piece.
 */
export function mirrorToBlue(zone) {
  return {
    minX: -zone.maxX,
    maxX: -zone.minX,
    minY: -zone.maxY,
    maxY: -zone.minY,
  };
}

/** Height of the centre of an upward-facing CELL opening. */
export function upCellHeight() {
  return CELL_REST_HEIGHT;
}

/** Horizontal offset of the up CELL from its HIVE pivot, along the fore-aft axis. */
export function cellHorizontalOffset() {
  return CELL_REST_OFFSET;
}
