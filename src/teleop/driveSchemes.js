/**
 * Mappings from gamepad sticks to a chassis command.
 *
 * Each scheme returns raw, unshaped values in -1..1:
 *   `forward` positive drives toward the far wall,
 *   `strafe`  positive moves to the robot's left,
 *   `turn`    positive rotates counter-clockwise.
 *
 * Shaping (deadband, response curve, scaling, ramping, field-centric rotation)
 * happens afterwards in DriverProcessor, so schemes stay small and comparable.
 *
 * Remember the FTC convention: `left_stick_y` is **negative** when pushed
 * forward, hence the negations below.
 *
 * @module
 */

/** Holonomic, robot relative: left stick translates, right stick rotates. */
export function robotCentric(g) {
  return {
    forward: -g.left_stick_y,
    strafe: -g.left_stick_x,
    turn: -g.right_stick_x,
  };
}

/**
 * Holonomic, field relative. Identical stick mapping to robot centric -- the
 * difference is applied later, by rotating the translation command by the
 * negated IMU heading.
 */
export function fieldCentric(g) {
  return robotCentric(g);
}

/**
 * Tank: each stick drives one side. Converted to forward/turn here so the rest
 * of the pipeline is shared, which also means a tank scheme works on a mecanum
 * robot if a driver prefers it.
 */
export function tank(g) {
  const left = -g.left_stick_y;
  const right = -g.right_stick_y;
  return {
    forward: (left + right) / 2,
    strafe: 0,
    // Left stick ahead of right yields a counter-clockwise turn.
    turn: (left - right) / 2,
  };
}

/** Arcade: one stick does everything. */
export function arcade(g) {
  return {
    forward: -g.left_stick_y,
    strafe: 0,
    turn: -g.left_stick_x,
  };
}

/** Split arcade: throttle on the left stick, steering on the right. */
export function splitArcade(g) {
  return {
    forward: -g.left_stick_y,
    strafe: 0,
    turn: -g.right_stick_x,
  };
}

export const SCHEMES = {
  robotCentric,
  fieldCentric,
  tank,
  arcade,
  splitArcade,
};

/** Schemes that can command sideways motion. */
export const HOLONOMIC_SCHEMES = new Set(['robotCentric', 'fieldCentric']);
