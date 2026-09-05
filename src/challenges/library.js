import { Vec2 } from '../math/Vec2.js';
import { DEG, INCH } from '../math/MathUtil.js';
import { Challenge } from './Challenge.js';
import { CircleZone, Corridor, Gate } from './zones.js';

/**
 * The drill library.
 *
 * Every drill trains a skill that transfers to any game, because the season's
 * game is not known: judging distance from the driver station, stopping where
 * you meant to, turning smoothly, keeping the wheels hooked up, and moving
 * sideways with intent.
 *
 * Courses are laid out relative to field size rather than in absolute
 * coordinates, so they still make sense if the field parameter is changed.
 *
 * @module
 */

/** Convenience: a gate spanning `width`, centred at (x, y), facing `heading`. */
function gate(x, y, heading, width, label) {
  return {
    kind: /** @type {const} */ ('gate'),
    gate: new Gate({ center: new Vec2(x, y), heading, width }),
    label,
  };
}

/** Convenience: a zone objective satisfied by entering it. */
function zone(x, y, radius, label) {
  return {
    kind: /** @type {const} */ ('zone'),
    zone: new CircleZone({ center: new Vec2(x, y), radius }),
    label,
  };
}

/** Convenience: a zone that must be stopped in, optionally facing a heading. */
function park(x, y, radius, label, opts = {}) {
  return {
    kind: /** @type {const} */ ('park'),
    zone: new CircleZone({ center: new Vec2(x, y), radius }),
    label,
    dwellSeconds: opts.dwellSeconds ?? 1.0,
    speedLimit: opts.speedLimit ?? 0.08,
    headingTarget: opts.headingTarget,
    headingTolerance: opts.headingTolerance,
  };
}

/**
 * Sprint and stop.
 *
 * The first drill anyone should run. Full power down the field, then stop
 * inside a target -- which teaches braking distance, the single thing new
 * drivers consistently underestimate.
 */
class SprintStop extends Challenge {
  constructor() {
    super({
      id: 'sprint',
      name: 'Sprint and stop',
      description:
        'Full power to the far end, then stop inside the target. Teaches how far your robot actually takes to stop, which is always further than it feels.',
      tip: 'Start braking earlier than feels right. Try it again with FLOAT instead of BRAKE.',
    });
  }

  build(field) {
    const half = field.halfSize;
    this.startPose = { x: -half + 20 * INCH, y: 0, heading: 0 };
    this.objectives = [
      gate(0, 0, 0, field.size * 0.8, 'Halfway'),
      park(half - 26 * INCH, 0, 12 * INCH, 'Stop here', { dwellSeconds: 0.8 }),
    ];
  }
}

/**
 * Shuttle run: the classic cycle drill.
 *
 * Three round trips between two zones. This is the closest thing to what an
 * FTC match actually asks of a driver -- repeatable trips under time pressure,
 * where the cost of overshooting compounds every cycle.
 */
class ShuttleRun extends Challenge {
  constructor() {
    super({
      id: 'shuttle',
      name: 'Shuttle run (3 cycles)',
      description:
        'Three round trips between the near and far zones. The closest drill to a real match: repeatable cycles where every overshoot costs you twice.',
      tip: 'Consistency beats top speed. A clean cycle you can repeat six times wins.',
    });
  }

  build(field) {
    const half = field.halfSize;
    const near = -half + 24 * INCH;
    const far = half - 24 * INCH;
    this.startPose = { x: near, y: 0, heading: 0 };
    this.objectives = [];
    for (let lap = 1; lap <= 3; lap++) {
      this.objectives.push(zone(far, 0, 14 * INCH, `Far ${lap}`));
      this.objectives.push(zone(near, 0, 14 * INCH, `Near ${lap}`));
    }
  }
}

/**
 * Slalom.
 *
 * Five gates alternating across the field. Rewards carrying speed through a
 * turn rather than stopping to rotate between each one.
 */
class Slalom extends Challenge {
  constructor() {
    super({
      id: 'slalom',
      name: 'Slalom',
      description:
        'Weave through five gates in order. Rewards carrying speed through the turns instead of stopping to rotate at each one.',
      tip: 'Look ahead to the gate after the one you are entering.',
    });
  }

  build(field) {
    const half = field.halfSize;
    this.startPose = { x: -half + 18 * INCH, y: 0, heading: 0 };
    const count = 5;
    const spacing = (field.size - 44 * INCH) / count;
    const offset = field.size * 0.22;
    this.objectives = [];
    for (let i = 0; i < count; i++) {
      const x = -half + 30 * INCH + spacing * i;
      const y = i % 2 === 0 ? offset : -offset;
      this.objectives.push(gate(x, y, 0, 26 * INCH, String(i + 1)));
    }
    this.objectives.push(park(half - 24 * INCH, 0, 14 * INCH, 'Finish', { dwellSeconds: 0.6 }));
  }
}

/**
 * Precision parking.
 *
 * Four small targets, each requiring a full stop with the robot square to the
 * field. This is the drill that makes the difference at a scoring position,
 * and the one where the precision trigger earns its keep.
 */
class PrecisionParking extends Challenge {
  constructor() {
    super({
      id: 'parking',
      name: 'Precision parking',
      description:
        'Four small targets. Stop dead inside each one, square to the field, and hold it. This is what scoring alignment actually feels like.',
      tip: 'Hold the left trigger for precision mode as you arrive.',
      wallPenalty: 3,
    });
  }

  build(field) {
    const q = field.size * 0.26;
    this.startPose = { x: -field.halfSize + 28 * INCH, y: 0, heading: 0 };
    const radius = 7 * INCH;
    const options = { dwellSeconds: 1.2, headingTolerance: 8 * DEG, speedLimit: 0.05 };
    this.objectives = [
      park(q, q, radius, 'A', { ...options, headingTarget: 0 }),
      park(q, -q, radius, 'B', { ...options, headingTarget: 90 * DEG }),
      park(-q, -q, radius, 'C', { ...options, headingTarget: 180 * DEG }),
      park(-q, q, radius, 'D', { ...options, headingTarget: -90 * DEG }),
    ];
  }
}

/**
 * Figure eight.
 *
 * Two tangent loops crossing at the field centre, taken in opposite senses so
 * both turn directions get equal work. Drivers are almost always noticeably
 * worse in one direction, and this is how you find out which.
 *
 * The geometry matters: the loops are circles of radius `d` centred at
 * `(+/-d, 0)`, so both pass through the origin and share a tangent there. Laid
 * out any other way the path has a kink at the crossing and stops being a
 * figure eight at all -- it becomes two separate loops with a stop between them,
 * which trains nothing.
 */
class FigureEight extends Challenge {
  constructor() {
    super({
      id: 'figureEight',
      name: 'Figure eight',
      description:
        'Two laps of a figure eight through the field centre. Both turn directions get equal work, which is how you discover that you are better at one of them.',
      tip: 'Count how long each loop takes. The slower direction is the one to practise.',
    });
  }

  build(field) {
    // Loop radius. The course spans 2d either side of centre, so this leaves
    // room for the robot's own diagonal inside the perimeter.
    const d = field.size * 0.19;

    // Start at the crossing point, facing the way the right-hand loop leaves it.
    this.startPose = { x: 0, y: 0, heading: -90 * DEG };

    // Right loop counter-clockwise, then left loop clockwise. Each gate faces
    // along the direction of travel at that point on the circle.
    const lap = (n) => [
      gate(d, -d, 0, 28 * INCH, `${n}a`),
      gate(d * 2, 0, 90 * DEG, 28 * INCH, `${n}b`),
      gate(d, d, 180 * DEG, 28 * INCH, `${n}c`),
      gate(-d, -d, 180 * DEG, 28 * INCH, `${n}d`),
      gate(-d * 2, 0, 90 * DEG, 28 * INCH, `${n}e`),
      gate(-d, d, 0, 28 * INCH, `${n}f`),
    ];
    this.objectives = [...lap(1), ...lap(2)];
  }
}

/**
 * Strafe gauntlet.
 *
 * Gates that face sideways, so they can only be cleared by moving laterally.
 * Hidden on tank drivetrains, which cannot do it at all.
 */
class StrafeGauntlet extends Challenge {
  constructor() {
    super({
      id: 'strafe',
      name: 'Strafe gauntlet',
      description:
        'Gates that face sideways, so the only way through is to strafe. Holonomic drivetrains only.',
      tip: 'Keep the robot pointed down the field the whole way. Heading hold makes this much easier.',
      holonomicOnly: true,
    });
  }

  build(field) {
    const half = field.halfSize;
    const step = field.size * 0.2;
    this.startPose = { x: -half + 28 * INCH, y: step, heading: 0 };
    this.objectives = [
      gate(-half + 28 * INCH, 0, -90 * DEG, 24 * INCH, '1'),
      gate(-step, -step, 0, 24 * INCH, '2'),
      gate(-step, 0, 90 * DEG, 24 * INCH, '3'),
      gate(step, step, 0, 24 * INCH, '4'),
      gate(step, 0, -90 * DEG, 24 * INCH, '5'),
      park(half - 24 * INCH, -step, 12 * INCH, 'Finish', {
        dwellSeconds: 0.8,
        headingTarget: 0,
        headingTolerance: 12 * DEG,
      }),
    ];
  }
}

/**
 * Barrel course.
 *
 * Numbered waypoints visited in a fixed order that deliberately does not follow
 * a neat loop, so the driver has to plan a route rather than follow a rail.
 */
class BarrelCourse extends Challenge {
  constructor() {
    super({
      id: 'barrels',
      name: 'Barrel course',
      description:
        'Seven waypoints in a set order that does not follow a tidy loop. Trains route planning, not just car control.',
      tip: 'Read two waypoints ahead and pick the approach angle that sets up the next one.',
    });
  }

  build(field) {
    const s = field.size;
    this.startPose = { x: -field.halfSize + 20 * INCH, y: 0, heading: 0 };
    const radius = 10 * INCH;
    const points = [
      [0.28, 0.30],
      [-0.22, 0.30],
      [0.30, -0.02],
      [-0.30, -0.28],
      [0.20, -0.32],
      [-0.02, 0.02],
      [0.34, 0.34],
    ];
    this.objectives = points.map(([fx, fy], i) =>
      zone(fx * s, fy * s, radius, String(i + 1)),
    );
    this.objectives.push(
      park(-field.halfSize + 28 * INCH, 0, 12 * INCH, 'Home', { dwellSeconds: 0.8 }),
    );
  }
}

/**
 * Tight lane.
 *
 * A narrow corridor with a dogleg. Straying outside costs time continuously
 * rather than ending the run, so the drill rewards staying smooth under
 * pressure instead of punishing a single mistake.
 */
class TightLane extends Challenge {
  constructor() {
    super({
      id: 'lane',
      name: 'Tight lane',
      description:
        'A narrow corridor with a dogleg. Straying outside costs time for as long as you are out, so smoothness beats speed.',
      tip: 'Slow into the corner, straighten early, then get back on the power.',
      wallPenalty: 3,
    });
  }

  build(field) {
    const half = field.halfSize;
    const y = field.size * 0.22;
    const points = [
      new Vec2(-half + 20 * INCH, -y),
      new Vec2(-field.size * 0.1, -y),
      new Vec2(field.size * 0.1, y),
      new Vec2(half - 20 * INCH, y),
    ];
    this.startPose = { x: points[0].x, y: points[0].y, heading: 0 };
    this.decorations = [
      {
        kind: 'corridor',
        corridor: new Corridor({ points, halfWidth: 14 * INCH }),
        penaltyPerSecond: 3,
        straying: false,
      },
    ];
    this.objectives = [
      gate(-field.size * 0.1, -y, 45 * DEG, 28 * INCH, '1'),
      gate(field.size * 0.1, y, 45 * DEG, 28 * INCH, '2'),
      park(points[3].x, points[3].y, 12 * INCH, 'Finish', { dwellSeconds: 0.8 }),
    ];
  }
}

/** Every drill, in the order they should be attempted. */
export const CHALLENGE_CLASSES = [
  SprintStop,
  ShuttleRun,
  Slalom,
  PrecisionParking,
  FigureEight,
  BarrelCourse,
  TightLane,
  StrafeGauntlet,
];

/** Fresh instances, so a caller can hold state without sharing it. */
export function createChallenges() {
  return CHALLENGE_CLASSES.map((Cls) => new Cls());
}

/** @param {string} id */
export function createChallenge(id) {
  const Cls = CHALLENGE_CLASSES.find((C) => new C().id === id);
  return Cls ? new Cls() : null;
}
