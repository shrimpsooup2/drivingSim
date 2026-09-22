/**
 * The three ways an FTC team writes down where their robot is.
 *
 * ## Why this exists
 *
 * Because an AUTO is a list of coordinates, and a coordinate only means
 * something inside a frame. A team's routine says "drive to (12, -63) facing
 * 90" and those numbers are inches and degrees in whatever frame their path
 * library uses -- so a simulator that only speaks metres from the field centre
 * makes them translate every number by hand, which is both tedious and a source
 * of the exact kind of sign error that ruins an AUTO.
 *
 * Ported from a teammate's JVM simulator, which lets the code under test
 * declare its frame (`codeCoordinateFrame`) and converts at the boundary. Same
 * idea: pick a frame, and every pose and point the AUTO API hands you or takes
 * from you is in it.
 *
 * ## The frames
 *
 * | Frame | Units | Origin | +X | +Y | Heading |
 * | --- | --- | --- | --- | --- | --- |
 * | `sim` | metres | field centre | red wall to blue wall | audience wall to rear wall | radians CCW from +X |
 * | `ftc` | inches | field centre | red wall to blue wall | audience wall to rear wall | degrees CCW from +X |
 * | `pedro` | inches | a corner | audience to rear wall | blue wall to red wall | degrees, 0 along +X |
 *
 * `sim` and `ftc` are the same frame in different units -- the simulator's own,
 * documented in `field/biobuzz/constants.js` and fixed by the field CAD. So
 * `ftc` is "give me inches and degrees", which is most of what anybody wants,
 * and a routine can stop converting 0.3048 by hand.
 *
 * `pedro` is Pedro Pathing's frame, using the transform the JVM simulator
 * uses -- `pedro_x = ftc_y + 72`, `pedro_y = 72 - ftc_x`, and
 * `ftc_heading = pedro_heading + 90` -- so a routine written against their
 * setup reads the same numbers here. It is a corner origin on a 144 inch
 * square, which is what makes every Pedro coordinate positive. If your team
 * has set Pedro's origin on a different corner, `PEDRO_ORIGIN_INCHES` and the
 * two functions below are the only place that has to change.
 *
 * ## What is deliberately not claimed
 *
 * That these are the axis *names* in any particular published FIRST diagram.
 * Those diagrams are drawn from a chosen viewpoint and the letters move between
 * seasons and documents. The reference here is the simulator's own frame, whose
 * axes are pinned to the field CAD, and the table above says exactly what each
 * direction means on the field. Check it against your own numbers before you
 * trust an AUTO to it -- driving to `ftc` (0, 0) should put the robot on the
 * centre of the field, and `pedro` (72, 72) should put it in the same place.
 *
 * @module
 */
import { DEG, INCH, wrapAngle } from './MathUtil.js';

/** @typedef {'sim'|'ftc'|'pedro'} FieldFrame */
/** @typedef {{x: number, y: number, heading?: number}} Pose */

/** The frames, for a picker. */
export const FIELD_FRAMES = /** @type {FieldFrame[]} */ (['sim', 'ftc', 'pedro']);

/** Labels and units, for the UI. */
export const FRAME_LABELS = Object.freeze({
  sim: { label: 'Simulator (m, centre)', unit: 'm', angle: '°' },
  ftc: { label: 'FTC field (in, centre)', unit: 'in', angle: '°' },
  pedro: { label: 'Pedro (in, corner)', unit: 'in', angle: '°' },
});

/** The FIELD is 12 feet square, so a corner origin sits 72 inches out. */
export const FIELD_SPAN_INCHES = 144;
export const PEDRO_ORIGIN_INCHES = FIELD_SPAN_INCHES / 2;

// ------------------------------------------------------------ sim <-> ftc

/**
 * Metres and radians to inches and degrees. Same axes, same origin.
 * @param {Pose} pose
 */
export function ftcFromSim(pose) {
  return {
    x: pose.x / INCH,
    y: pose.y / INCH,
    heading: (pose.heading ?? 0) / DEG,
  };
}

/** @param {Pose} pose */
export function simFromFtc(pose) {
  return {
    x: pose.x * INCH,
    y: pose.y * INCH,
    heading: (pose.heading ?? 0) * DEG,
  };
}

// ---------------------------------------------------------- ftc <-> pedro

/** @param {Pose} pose */
export function pedroFromFtc(pose) {
  return {
    x: pose.y + PEDRO_ORIGIN_INCHES,
    y: PEDRO_ORIGIN_INCHES - pose.x,
    heading: (pose.heading ?? 0) - 90,
  };
}

/** @param {Pose} pose */
export function ftcFromPedro(pose) {
  return {
    x: PEDRO_ORIGIN_INCHES - pose.y,
    y: pose.x - PEDRO_ORIGIN_INCHES,
    heading: (pose.heading ?? 0) + 90,
  };
}

// ---------------------------------------------------------- sim <-> pedro

/** @param {Pose} pose */
export function pedroFromSim(pose) {
  return pedroFromFtc(ftcFromSim(pose));
}

/** @param {Pose} pose */
export function simFromPedro(pose) {
  return simFromFtc(ftcFromPedro(pose));
}

// --------------------------------------------------------------- by name

/**
 * A pose in the simulator's frame, expressed in `frame`.
 *
 * Headings come back wrapped to (-180, 180] for the two degree frames, because
 * a routine comparing against a written-down heading wants -90 and not 270,
 * and an unwrapped `pedro` heading is off by exactly the 90 degrees the
 * transform subtracts.
 * @param {Pose} pose
 * @param {FieldFrame} frame
 */
export function toFrame(pose, frame) {
  if (frame === 'sim') return { x: pose.x, y: pose.y, heading: wrapAngle(pose.heading ?? 0) };
  const out = frame === 'pedro' ? pedroFromSim(pose) : ftcFromSim(pose);
  out.heading = wrapDegrees(out.heading);
  return out;
}

/**
 * A pose in `frame`, expressed in the simulator's frame.
 * @param {Pose} pose
 * @param {FieldFrame} frame
 */
export function fromFrame(pose, frame) {
  if (frame === 'sim') return { x: pose.x, y: pose.y, heading: wrapAngle(pose.heading ?? 0) };
  const out = frame === 'pedro' ? simFromPedro(pose) : simFromFtc(pose);
  out.heading = wrapAngle(out.heading);
  return out;
}

/**
 * A length in the simulator's frame, in the units of `frame`.
 * @param {number} metres
 * @param {FieldFrame} frame
 */
export function lengthInFrame(metres, frame) {
  return frame === 'sim' ? metres : metres / INCH;
}

/**
 * A length in the units of `frame`, in metres.
 * @param {number} value
 * @param {FieldFrame} frame
 */
export function lengthFromFrame(value, frame) {
  return frame === 'sim' ? value : value * INCH;
}

/** An angle in the simulator's frame, in the units of `frame`. */
export function angleInFrame(radians, frame) {
  return frame === 'sim' ? wrapAngle(radians) : wrapDegrees(toFrame({ x: 0, y: 0, heading: radians }, frame).heading);
}

/** Degrees wrapped to (-180, 180]. */
export function wrapDegrees(degrees) {
  const wrapped = ((degrees + 180) % 360 + 360) % 360 - 180;
  // -180 and 180 are the same heading; report the positive one, so a robot
  // facing the red wall reads 180 rather than flipping sign on noise.
  return wrapped === -180 ? 180 : wrapped;
}

/** True when `frame` is one this module knows about. */
export function isFieldFrame(frame) {
  return FIELD_FRAMES.includes(/** @type {FieldFrame} */ (frame));
}
