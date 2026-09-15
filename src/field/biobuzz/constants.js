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

/**
 * Section 9.6.2 gives the CELL opening as ~20 in wide, 14 in tall and 12 in
 * deep. Those live in the CAD block below alongside the figure's own heights,
 * which is where the 14 in gets cross-checked against 65.6 - 53.5.
 */

/**
 * Section 9.7 describes the FLOWER as a ~4 in opening ~21.5 in above the tiles,
 * a 1.25 in backstop, a retrieval opening ~3.55 in tall and 3.57 in deep, and a
 * 0.4 in lower ring with a 2.79 in hole.
 *
 * Every one of those is measured directly in the CAD block below, so they are
 * not duplicated here -- two names for one dimension is how they drift apart.
 * Where the CAD is tighter it is quoted in its own comment: the clear tube
 * radius is 1.91 in rather than "about 2", and the retrieval gap 3.19 in rather
 * than 3.55.
 */

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

/**
 * Figure 9-9 dimensions the HIVE directly, and these supersede anything derived
 * from part bounding boxes.
 *
 *  - HIVE centre to centre: 25.5 in, so each pivot is 12.75 in off the middle.
 *  - Bottom of the HIVE above the tiles: 25.5 in -- well clear of an 18 in
 *    ROBOT, so you drive underneath it.
 *  - Bottom of the HIVE *opening*: 53.5 in. Top of it: 65.6 in.
 */
export const HIVE_PIVOT_X = 12.75 * INCH;
export const HIVE_BOTTOM_HEIGHT = 25.5 * INCH;
export const CELL_OPENING_BOTTOM = 53.5 * INCH;
export const CELL_OPENING_TOP = 65.6 * INCH;

/**
 * The HIVE's resting tilt, 30 degrees, confirmed four separate ways:
 *
 *  - Figure 9-9 dimensions it as 30 degrees outright;
 *  - the four Goal Rib origins of one HIVE lie on a line of slope 0.577;
 *  - the 1 in square arm tube spans 15.01 in by 9.25 in, which solves to a
 *    16.76 in axis at 30.00 degrees from both equations independently;
 *  - the opening's 12.1 in vertical span is 14*cos(30) to three figures.
 */
export const HIVE_TILT_DEGREES = 30;
export const HIVE_TILT = (HIVE_TILT_DEGREES * Math.PI) / 180;

/** The arm tube from the pivot out to the CELL, 16.76 in along its axis. */
export const HIVE_ARM_LENGTH = 16.76 * INCH;

/**
 * The CELL opening: 20 in wide by 14 in tall by 12 in deep (Section 9.6.2),
 * and a **pentagon**, not a rectangle -- Figure 9-11 gives a 20 in base, sides
 * to a shoulder at 7.61 in, then a taper to an apex at 14 in.
 *
 * Its plane is **perpendicular to the arm**, which is what the figure's two
 * heights prove: 65.6 - 53.5 = 12.1 in of vertical span, and 14*cos(30) =
 * 12.12. So the opening faces straight out along the arm, 30 degrees above
 * horizontal, and the aperture a shot has to cross is that pentagon.
 */
export const CELL_OPENING_WIDTH = 20 * INCH;
export const CELL_OPENING_HEIGHT = (CELL_OPENING_TOP - CELL_OPENING_BOTTOM) / Math.cos(HIVE_TILT);
export const CELL_SHOULDER_HEIGHT = 7.61 * INCH;
export const CELL_DEPTH = 12 * INCH;

/**
 * Where elements come to rest inside the CELL, measured from the three NECTAR
 * the CAD stages there: 9.4 in horizontally from the pivot, 50.2 in up. Section
 * 10.3.1 says they sit "contacting the back wall of the CELL and in a line
 * against the side closest to the ALLIANCE AREA", which is also why the CAD has
 * them off-centre across the CELL.
 *
 * This is **not** what a LAUNCHER aims at -- it is 12 in back along the arm and
 * below the opening, on the sloping floor. Aiming here instead of at the
 * opening puts the ball into the outside of the CELL wall.
 */
export const CELL_REST_OFFSET = 9.4 * INCH;
export const CELL_REST_HEIGHT = 50.2 * INCH;

/**
 * The A-frame. Each side is a triangle whose base sits on the tiles and whose
 * apex leans inward to carry a pivot, joined across the top by a crossbar
 * (Figure 9-8: 49.46 in wide, 38.95 in deep, pivots 43.95 in up).
 *
 * The foot bar is what a bumper meets: 2.00 in thick, the full 38.94 in depth,
 * and only 2.15 in tall. Above it the struts lean inward, so there is nothing
 * in the middle of the frame below the CELLS.
 */
export const FRAME_HALF_WIDTH = 24.3 * INCH;
export const FRAME_HALF_DEPTH = 19.07 * INCH;
export const FRAME_FOOT_OUTER = 24.75 * INCH;
export const FRAME_FOOT_INNER = 22.75 * INCH;
export const FRAME_FOOT_HALF_DEPTH = 19.47 * INCH;
export const FRAME_FOOT_HEIGHT = 2.15 * INCH;
/** One strut, from its base corner to its top end beside the pivot. */
export const FRAME_STRUT_BASE = { x: 24.28 * INCH, y: 19.07 * INCH, z: 0.22 * INCH };
export const FRAME_STRUT_TOP = { x: 12.24 * INCH, y: 0, z: 41.4 * INCH };

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
 * 10.5.2). The four HDPE pipes span exactly this, so it is the volume itself
 * rather than a derived guess.
 */
export const FLOWER_SCORING_BOTTOM = 4.25 * INCH;
export const FLOWER_SCORING_TOP = 21.25 * INCH;

/**
 * The four pipes: axes on a square at +-1.725 in, 1.05 in outside diameter.
 *
 * These are what actually hold an element, so the tube's clear radius follows
 * from them rather than from the manual's "approximately 4 in" opening:
 *
 *   clear radius = 1.725*sqrt(2) - 0.525 = 1.9146 in
 *
 * A NECTAR is 1.81 in in radius, so it has 0.10 in to spare -- which is why
 * NECTAR barely goes in and why a stack of it sits almost dead straight.
 */
export const FLOWER_PIPE_OFFSET = 1.725 * INCH;
export const FLOWER_PIPE_RADIUS = 0.525 * INCH;
export const FLOWER_PIPE_INNER_RADIUS = 0.425 * INCH;
export const FLOWER_TUBE_RADIUS = FLOWER_PIPE_OFFSET * Math.SQRT2 - FLOWER_PIPE_RADIUS;

/**
 * Clear gap between two adjacent pipes, 2.40 in. An element smaller than this
 * could squeeze out of the side of the tube; POLLEN at 2.8 in cannot, which is
 * what keeps the column captive.
 */
export const FLOWER_PIPE_GAP = FLOWER_PIPE_OFFSET * 2 - FLOWER_PIPE_RADIUS * 2;

/** Ring plates. Rectangular sheet, not discs: roughly 5.9 in by 5.0 in. */
export const FLOWER_RING_WIDTH = 5.88 * INCH;
export const FLOWER_RING_DEPTH = 5.07 * INCH;
export const FLOWER_LOWER_RING_TOP = 0.7 * INCH;
export const FLOWER_MIDDLE_RING_BOTTOM = 3.89 * INCH;
export const FLOWER_MIDDLE_RING_TOP = 5.29 * INCH;
export const FLOWER_TOP_RING_BOTTOM = 20.22 * INCH;
export const FLOWER_TOP_RING_TOP = 21.4 * INCH;

/**
 * The retrieval opening, 3.55 in, dimensioned in Figure 9-12.
 *
 * Taking it from the ring bounding boxes instead gives 3.19 in, because the
 * lower ring's box picks up the under-field bracket bolted through it -- the
 * figure also calls the ring 0.43 in thick, against the 0.70 in top the box
 * reports. Where a figure dimensions something directly, it wins.
 *
 * Either way this is what enforces G418 on its own: POLLEN is 2.80 in and goes
 * through, NECTAR is 3.62 in and cannot come out at all.
 */
export const FLOWER_RETRIEVAL_GAP = 3.55 * INCH;
export const FLOWER_RETRIEVAL_DEPTH = 3.57 * INCH;
export const FLOWER_LOWER_RING_THICKNESS = 0.43 * INCH;

/**
 * The top ring's own hole is 4.0 in across and the lower ring's 2.79 in
 * (Figure 9-12) -- the latter being why a 2.8 in POLLEN nests in it. The four
 * pipes intrude very slightly inside the top ring's hole, so the tightest
 * constraint on a ball remains the 1.9146 in the pipes leave.
 */
export const FLOWER_TOP_RING_HOLE = 4.0 * INCH;
export const FLOWER_LOWER_RING_HOLE = 2.79 * INCH;

/**
 * The two square supports between the lower and middle rings. Section 9.7:
 * "the middle and lower rings are connected on the perimeter wall side with
 * square extrusion" -- so the retrieval opening is blocked on the wall side and
 * open on the other three, which is why a ROBOT collects from the field side.
 */
export const FLOWER_SUPPORT_SIZE = 1.35 * INCH;
export const FLOWER_SUPPORT_WALL_OFFSET = 1.83 * INCH;
export const FLOWER_SUPPORT_SPACING = 1.25 * INCH;
export const FLOWER_SUPPORT_TOP = 4.1 * INCH;

/**
 * The backstop plate above the opening: 5.38 in square, 22.24 to 22.65 in up,
 * offset 0.76 in toward the wall. Its top is 1.25 in above the top ring, which
 * is the "1.25 in tall" the manual quotes.
 */
export const FLOWER_BACKSTOP_BOTTOM = 22.24 * INCH;
export const FLOWER_BACKSTOP_TOP = 22.65 * INCH;
export const FLOWER_BACKSTOP_SIZE = 5.38 * INCH;
export const FLOWER_BACKSTOP_WALL_OFFSET = 0.76 * INCH;
export const FLOWER_BACKSTOP_HEIGHT = FLOWER_BACKSTOP_TOP - FLOWER_TOP_RING_TOP;

/**
 * Heights of the four POLLEN the CAD stages in every FLOWER. The bottom one
 * tops out at 2.80 in, below the 4.25 in floor of the scoring volume -- so it
 * does not score, and it is the one a ROBOT pulls out of the retrieval
 * opening. The three above it do score.
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
