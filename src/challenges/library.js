import { Vec2 } from '../math/Vec2.js';
import { DEG, INCH } from '../math/MathUtil.js';
import { Challenge } from './Challenge.js';
import { CircleZone, Corridor, Gate } from './zones.js';

/**
 * The drill library, in three tiers.
 *
 * **Basic** teaches the machine: how far it takes to stop, how it turns, how
 * precisely you can place it. **Intermediate** adds real manoeuvres -- tight
 * clearances against solid obstacles, reversing blind, working under a speed
 * limit. **Advanced** is long and contested: full-field routes, defenders in
 * the way, and a match-length window where pace has to be sustainable rather
 * than heroic.
 *
 * Everything is game-agnostic, because the season's game is unknown. What
 * transfers is control, judgement and consistency, and those are what these
 * measure.
 *
 * Courses are laid out relative to field size, so they still make sense if the
 * field parameter changes.
 *
 * @module
 */

const gate = (x, y, heading, width, label, extra = {}) => ({
  kind: /** @type {const} */ ('gate'),
  gate: new Gate({ center: new Vec2(x, y), heading, width }),
  label,
  ...extra,
});

const zone = (x, y, radius, label, extra = {}) => ({
  kind: /** @type {const} */ ('zone'),
  zone: new CircleZone({ center: new Vec2(x, y), radius }),
  label,
  ...extra,
});

const park = (x, y, radius, label, opts = {}) => ({
  kind: /** @type {const} */ ('park'),
  zone: new CircleZone({ center: new Vec2(x, y), radius }),
  label,
  dwellSeconds: opts.dwellSeconds ?? 1.0,
  speedLimit: opts.speedLimit ?? 0.08,
  ...opts,
});

const box = (x, y, w, h, heading = 0) => ({
  position: new Vec2(x, y),
  size: new Vec2(w, h),
  heading,
});

/**
 * A pair of pillars with a gap between them, plus the gate that scores passing
 * through it. Clearance is measured against the robot, so a "tight" gap is
 * genuinely tight: come in crooked and the diagonal will not fit.
 */
function pinch(x, gapCentreY, gapWidth, label, obstacles, extra = {}) {
  const pillarLength = 0.16;
  // Deliberately short: the pillars have to make the *gap* tight without
  // walling off the corridor between rows, or the course stops being drivable
  // rather than merely hard.
  const pillarWidth = 0.45;
  const inner = gapCentreY + gapWidth / 2 + pillarWidth / 2;
  const outer = gapCentreY - gapWidth / 2 - pillarWidth / 2;
  obstacles.push(box(x, inner, pillarLength, pillarWidth));
  obstacles.push(box(x, outer, pillarLength, pillarWidth));
  return gate(x, gapCentreY, 0, gapWidth, label, extra);
}

// ---------------------------------------------------------------- basic

class SprintStop extends Challenge {
  constructor() {
    super({
      id: 'sprint',
      name: 'Sprint and stop',
      description:
        'Full power to the far end, then stop inside the target. Teaches how far your robot actually takes to stop, which is always further than it feels.',
      tip: 'Start braking earlier than feels right. Then try it again with FLOAT instead of BRAKE.',
      tier: 'basic',
      par: { gold: 6, silver: 8, bronze: 11 },
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

class ShuttleRun extends Challenge {
  constructor() {
    super({
      id: 'shuttle',
      name: 'Shuttle run (4 cycles)',
      description:
        'Four round trips between the near and far zones. The closest simple drill to a real match: repeatable cycles where every overshoot costs you twice.',
      tip: 'Consistency beats top speed. A clean cycle you can repeat eight times wins the match.',
      tier: 'basic',
      par: { gold: 18, silver: 24, bronze: 32 },
    });
  }

  build(field) {
    const half = field.halfSize;
    const near = -half + 24 * INCH;
    const far = half - 24 * INCH;
    this.startPose = { x: near, y: 0, heading: 0 };
    this.objectives = [];
    for (let lap = 1; lap <= 4; lap++) {
      this.objectives.push(zone(far, 0, 14 * INCH, `Far ${lap}`));
      this.objectives.push(zone(near, 0, 14 * INCH, `Near ${lap}`));
    }
  }
}

class Slalom extends Challenge {
  constructor() {
    super({
      id: 'slalom',
      name: 'Slalom',
      description:
        'Weave through six gates in order, then park. Rewards carrying speed through the turns instead of stopping to rotate at each one.',
      tip: 'Look ahead to the gate after the one you are entering.',
      tier: 'basic',
      par: { gold: 16, silver: 21, bronze: 28 },
    });
  }

  build(field) {
    const half = field.halfSize;
    this.startPose = { x: -half + 18 * INCH, y: 0, heading: 0 };
    const count = 6;
    const spacing = (field.size - 44 * INCH) / count;
    const offset = field.size * 0.22;
    this.objectives = [];
    for (let i = 0; i < count; i++) {
      const x = -half + 30 * INCH + spacing * i;
      this.objectives.push(gate(x, i % 2 === 0 ? offset : -offset, 0, 28 * INCH, String(i + 1)));
    }
    this.objectives.push(park(half - 24 * INCH, 0, 14 * INCH, 'Finish', { dwellSeconds: 0.6 }));
  }
}

class PrecisionParking extends Challenge {
  constructor() {
    super({
      id: 'parking',
      name: 'Precision parking',
      description:
        'Four small targets. Stop dead inside each one, square to the field, and hold it. This is what scoring alignment actually feels like.',
      tip: 'Hold the left trigger for precision mode as you arrive.',
      tier: 'basic',
      wallPenalty: 3,
      par: { gold: 22, silver: 29, bronze: 38 },
    });
  }

  build(field) {
    const q = field.size * 0.26;
    this.startPose = { x: -field.halfSize + 22 * INCH, y: 0, heading: 0 };
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

// ---------------------------------------------------------- intermediate

class FigureEight extends Challenge {
  constructor() {
    super({
      id: 'figureEight',
      name: 'Figure eight (3 laps)',
      description:
        'Three laps of a figure eight through the field centre. Both turn directions get equal work, which is how you discover that you are better at one of them.',
      tip: 'Time each loop. The slower direction is the one to practise.',
      tier: 'intermediate',
      par: { gold: 26, silver: 34, bronze: 45 },
    });
  }

  build(field) {
    // Circles of radius d centred at (+/-d, 0): both pass through the origin
    // and share a tangent there, which is what makes it one continuous path
    // rather than two loops with a stop between them.
    const d = field.size * 0.19;
    this.startPose = { x: 0, y: 0, heading: -90 * DEG };
    const lap = (n) => [
      gate(d, -d, 0, 28 * INCH, `${n}a`),
      gate(d * 2, 0, 90 * DEG, 28 * INCH, `${n}b`),
      gate(d, d, 180 * DEG, 28 * INCH, `${n}c`),
      gate(-d, -d, 180 * DEG, 28 * INCH, `${n}d`),
      gate(-d * 2, 0, 90 * DEG, 28 * INCH, `${n}e`),
      gate(-d, d, 0, 28 * INCH, `${n}f`),
    ];
    this.objectives = [...lap(1), ...lap(2), ...lap(3)];
  }
}

class BarrelCourse extends Challenge {
  constructor() {
    super({
      id: 'barrels',
      name: 'Barrel course',
      description:
        'Eight waypoints in a set order that deliberately does not follow a tidy loop, with pillars in the way. Trains route planning, not just car control.',
      tip: 'Read two waypoints ahead and pick the approach angle that sets up the next one.',
      tier: 'intermediate',
      par: { gold: 30, silver: 40, bronze: 54 },
    });
  }

  build(field) {
    const s = field.size;
    this.startPose = { x: -field.halfSize + 20 * INCH, y: 0, heading: 0 };
    const radius = 10 * INCH;
    const points = [
      [0.28, 0.30], [-0.22, 0.30], [0.30, -0.02],
      [-0.30, -0.28], [0.20, -0.32], [-0.02, 0.02],
      [0.34, 0.34], [-0.34, -0.02],
    ];
    this.objectives = points.map(([fx, fy], i) => zone(fx * s, fy * s, radius, String(i + 1)));
    this.objectives.push(
      park(-field.halfSize + 22 * INCH, 0, 12 * INCH, 'Home', { dwellSeconds: 0.8 }),
    );
    // Pillars that make the direct line between some pairs unusable.
    this.obstacles = [
      box(0.05 * s, 0.16 * s, 0.16, 0.5),
      box(-0.12 * s, -0.14 * s, 0.5, 0.16),
      box(0.26 * s, 0.14 * s, 0.16, 0.42),
    ];
  }
}

class Threading extends Challenge {
  constructor() {
    super({
      id: 'threading',
      name: 'Threading the needle',
      description:
        'Four narrow gaps between solid pillars, alternating across the field. The gaps are barely wider than the robot, so arriving crooked means not fitting at all.',
      tip: 'Square up before the gap, not in it. Clipping a pillar spins you and costs three seconds.',
      tier: 'intermediate',
      obstaclePenalty: 3,
      par: { gold: 22, silver: 30, bronze: 42 },
    });
  }

  build(field) {
    const half = field.halfSize;
    this.startPose = { x: -half + 18 * INCH, y: 0, heading: 0 };
    this.obstacles = [];
    const gapWidth = 25 * INCH;
    const offset = field.size * 0.14;
    const xs = [-1.15, -0.4, 0.35, 1.1];
    this.objectives = xs.map((x, i) =>
      pinch(x, i % 2 === 0 ? offset : -offset, gapWidth, String(i + 1), this.obstacles),
    );
    // Straight on from the last gap, rather than back on the centre line where
    // the final pair of pillars sits.
    this.objectives.push(
      park(half - 13 * INCH, -offset, 12 * INCH, 'Finish', { dwellSeconds: 0.7 }),
    );
  }
}

class ReverseDock extends Challenge {
  constructor() {
    super({
      id: 'reverseDock',
      name: 'Reverse docking',
      description:
        'Back into three slots, each facing away from you. Reversing accurately into a space you cannot see well is one of the most useful and least practised skills in FTC.',
      tip: 'Line up square first, then reverse straight. Trying to steer while backing in rarely ends well.',
      tier: 'intermediate',
      obstaclePenalty: 3,
      wallPenalty: 3,
      par: { gold: 24, silver: 32, bronze: 44 },
    });
  }

  build(field) {
    const half = field.halfSize;
    this.startPose = { x: -half + 22 * INCH, y: 0, heading: 0 };
    this.obstacles = [];
    this.objectives = [];

    // Three bays along the far wall, each formed by two side walls. The robot
    // must reverse in, which is checked in the body frame, so it really has to
    // be going backwards rather than merely ending up facing the right way.
    const bayY = [field.size * 0.28, 0, -field.size * 0.28];
    const bayX = half - 20 * INCH;
    // Clearance either side of the robot once it is in: tight enough to demand
    // a straight approach, wide enough that a good one fits.
    const bayHalfWidth = 15 * INCH;
    bayY.forEach((y, i) => {
      this.obstacles.push(box(bayX, y + bayHalfWidth, 0.44, 0.1));
      this.obstacles.push(box(bayX, y - bayHalfWidth, 0.44, 0.1));
      // Facing back down the field, so the only way into the bay is backwards.
      // `requireReverse` is checked at the moment the robot crosses into the
      // zone, since by the time it is parked it is stationary.
      this.objectives.push(
        park(bayX, y, 9 * INCH, `Bay ${i + 1}`, {
          dwellSeconds: 1.0,
          headingTarget: 180 * DEG,
          headingTolerance: 12 * DEG,
          requireReverse: true,
        }),
      );
      // Leaving the bay forwards resets you for the next one.
      if (i < bayY.length - 1) {
        this.objectives.push(gate(0, y, 180 * DEG, field.size * 0.5, `Out ${i + 1}`));
      }
    });
  }
}

class StrafeGauntlet extends Challenge {
  constructor() {
    super({
      id: 'strafe',
      name: 'Strafe gauntlet',
      description:
        'Gates that face sideways, so the only way through is to strafe, with pillars narrowing the lanes. Holonomic drivetrains only.',
      tip: 'Keep the robot pointed down the field the whole way. Heading hold makes this far easier.',
      tier: 'intermediate',
      holonomicOnly: true,
      obstaclePenalty: 3,
      par: { gold: 15, silver: 21, bronze: 29 },
    });
  }

  build(field) {
    const half = field.halfSize;
    const step = field.size * 0.2;
    this.startPose = { x: -half + 22 * INCH, y: step, heading: 0 };
    this.obstacles = [
      box(-step, step * 1.6, 0.5, 0.14),
      box(step, -step * 1.6, 0.5, 0.14),
    ];
    this.objectives = [
      gate(-half + 22 * INCH, 0, -90 * DEG, 26 * INCH, '1'),
      gate(-step, -step, 0, 26 * INCH, '2'),
      gate(-step, 0, 90 * DEG, 26 * INCH, '3'),
      gate(step, step, 0, 26 * INCH, '4'),
      gate(step, 0, -90 * DEG, 26 * INCH, '5'),
      park(half - 24 * INCH, -step, 12 * INCH, 'Finish', {
        dwellSeconds: 0.8,
        headingTarget: 0,
        headingTolerance: 12 * DEG,
      }),
    ];
  }
}

class SlowZone extends Challenge {
  constructor() {
    super({
      id: 'slowZone',
      name: 'Delicate approach',
      description:
        'Five targets, each with a speed limit on the way in. Charging the approach costs time for every second you are over, so you have to decide when it is worth it.',
      tip: 'Get up to speed between targets and shed it early. The penalty is per second, so a brief overrun is cheap.',
      tier: 'intermediate',
      speedPenaltyPerSecond: 5,
      par: { gold: 26, silver: 35, bronze: 46 },
    });
  }

  build(field) {
    const s = field.size;
    this.startPose = { x: -field.halfSize + 22 * INCH, y: 0, heading: 0 };
    const slow = { approachSpeedLimit: 0.5, approachRadius: 0.55, dwellSeconds: 0.7 };
    const points = [
      [0.30, 0.28], [-0.28, 0.30], [0.32, -0.26], [-0.30, -0.28], [0.02, 0.0],
    ];
    this.objectives = points.map(([fx, fy], i) =>
      park(fx * s, fy * s, 9 * INCH, String(i + 1), { ...slow }),
    );
  }
}

// ------------------------------------------------------------- advanced

class Maze extends Challenge {
  constructor() {
    super({
      id: 'maze',
      name: 'The maze',
      description:
        'A serpentine route through four full-width barriers with alternating openings. Long, tight, and unforgiving of a wide line.',
      tip: 'Take the openings square and use the space between barriers to set up the next one.',
      tier: 'advanced',
      obstaclePenalty: 3,
      par: { gold: 30, silver: 42, bronze: 58 },
    });
  }

  build(field) {
    const half = field.halfSize;
    this.startPose = { x: -half + 18 * INCH, y: 0, heading: 0 };
    this.obstacles = [];
    this.objectives = [];

    const rows = 4;
    const gapWidth = 26 * INCH;
    for (let i = 0; i < rows; i++) {
      // Spacing has to exceed the robot's length so there is room to line up
      // for the next opening after clearing the last one.
      const x = -half + 0.63 + i * 0.7;
      const gapY = i % 2 === 0 ? field.size * 0.19 : -field.size * 0.19;
      // Two wall segments either side of the opening, stopping short of the
      // perimeter so the robot is never fully boxed in by a solver hiccup.
      const top = half - 0.06;
      const bottom = -half + 0.06;
      const upperStart = gapY + gapWidth / 2;
      const lowerEnd = gapY - gapWidth / 2;
      if (top - upperStart > 0.05) {
        this.obstacles.push(box(x, (top + upperStart) / 2, 0.12, top - upperStart));
      }
      if (lowerEnd - bottom > 0.05) {
        this.obstacles.push(box(x, (lowerEnd + bottom) / 2, 0.12, lowerEnd - bottom));
      }
      this.objectives.push(gate(x, gapY, 0, gapWidth, String(i + 1)));
    }
    this.objectives.push(
      park(half - 14 * INCH, 0, 12 * INCH, 'Finish', { dwellSeconds: 0.8 }),
    );
  }
}

class GauntletRun extends Challenge {
  constructor() {
    super({
      id: 'gauntlet',
      name: 'The gauntlet',
      description:
        'The long one. A full-field route combining a sprint, two tight pinches, a reversed gate, a squared-up park in the far corner and a return leg. Everything the other drills teach, in one run.',
      tip: 'Pace it. The reverse gate and the corner park are where runs are lost, not the sprint.',
      tier: 'advanced',
      obstaclePenalty: 3,
      wallPenalty: 3,
      par: { gold: 48, silver: 65, bronze: 88 },
    });
  }

  build(field) {
    const half = field.halfSize;
    const s = field.size;
    this.startPose = { x: -half + 18 * INCH, y: 0, heading: 0 };
    this.obstacles = [];

    const outbound = [
      gate(-half + 30 * INCH, 0, 0, s * 0.6, 'Go'),
      pinch(-0.45, s * 0.2, 26 * INCH, 'P1', this.obstacles),
      pinch(0.35, -s * 0.2, 26 * INCH, 'P2', this.obstacles),
      park(half - 22 * INCH, -s * 0.28, 10 * INCH, 'Corner', {
        dwellSeconds: 1.0,
        headingTarget: 0,
        headingTolerance: 10 * DEG,
      }),
    ];

    // The hard bit: reverse out of the corner through a gate behind you.
    const reverseLeg = [
      gate(half - 30 * INCH, -s * 0.28, 180 * DEG, 30 * INCH, 'Back', { requireReverse: true }),
      zone(half - 26 * INCH, s * 0.3, 12 * INCH, 'Far side'),
    ];

    // The homeward leg has to route around the outbound pinches rather than
    // back through them. The pillars leave a clear corridor between the two
    // rows, so the return drops down the middle before turning for home; a
    // straight line from H1 to H2 would try to squeeze through the P1 gap
    // diagonally and wedge on its corner.
    const homeward = [
      gate(0.3, s * 0.24, 180 * DEG, 30 * INCH, 'H1'),
      gate(0, s * 0.04, -90 * DEG, 28 * INCH, 'H2'),
      gate(-0.4, -s * 0.19, 180 * DEG, 30 * INCH, 'H3'),
      park(-half + 24 * INCH, 0, 11 * INCH, 'Home', {
        dwellSeconds: 1.0,
        headingTarget: 180 * DEG,
        headingTolerance: 12 * DEG,
      }),
    ];

    this.objectives = [...outbound, ...reverseLeg, ...homeward];
  }
}

class Defended extends Challenge {
  constructor() {
    super({
      id: 'defended',
      name: 'Under defence',
      description:
        'Three shuttle cycles with a heavy Pusher actively denying your route. It will not chase you -- it will sit between you and where you are going, which is far more annoying.',
      tip: 'Do not fight it head on. Bait it one way and go the other, or use the corners it is too slow to cover.',
      tier: 'advanced',
      par: { gold: 30, silver: 42, bronze: 58 },
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
    this.opponents = [
      {
        profileId: 'pusher',
        skillId: 'competent',
        behavior: 'blocker',
        start: { x: 0.2, y: 0, heading: Math.PI },
      },
    ];
  }
}

class Evasion extends Challenge {
  constructor() {
    super({
      id: 'evasion',
      name: 'Evasion',
      description:
        'Collect six waypoints while a fast, light Scout hunts you down. It is quicker than you and it will not stop, but it weighs half what you do.',
      tip: 'You cannot out-run it, so out-turn it. Change direction where it has to commit.',
      tier: 'advanced',
      par: { gold: 28, silver: 38, bronze: 52 },
    });
  }

  build(field) {
    const s = field.size;
    this.startPose = { x: -field.halfSize + 22 * INCH, y: 0, heading: 0 };
    const points = [
      [0.32, 0.30], [-0.30, 0.30], [0.32, -0.30],
      [-0.30, -0.30], [0.0, 0.32], [0.0, -0.32],
    ];
    this.objectives = points.map(([fx, fy], i) => zone(fx * s, fy * s, 11 * INCH, String(i + 1)));
    this.opponents = [
      {
        profileId: 'scout',
        skillId: 'veteran',
        behavior: 'chaser',
        start: { x: field.halfSize - 24 * INCH, y: 0, heading: Math.PI },
      },
    ];
  }
}

class MatchSimulation extends Challenge {
  constructor() {
    super({
      id: 'matchSim',
      name: 'Match simulation (2:00)',
      description:
        'Two minutes, two opponents, obstacles in the way. Complete as many cycles as you can. Unlike every other drill, the score is how much you got done, not how fast one lap was -- which is the difference between a hot lap and a match.',
      tip: 'Pick a pace you can hold for two minutes. Almost everyone starts too fast and loses more time to mistakes than they gained.',
      tier: 'advanced',
      scoreMode: 'count',
      duration: 120,
      par: { gold: 12, silver: 8, bronze: 5 },
    });
  }

  build(field) {
    const half = field.halfSize;
    const s = field.size;
    const near = -half + 24 * INCH;
    const far = half - 24 * INCH;
    this.startPose = { x: near, y: 0, heading: 0 };

    // A short repeating cycle: out to one of two far targets, back to the near
    // zone. Looping is handled by the base class in count mode.
    this.objectives = [
      zone(far, s * 0.22, 12 * INCH, 'Far A'),
      zone(near, 0, 13 * INCH, 'Home'),
      zone(far, -s * 0.22, 12 * INCH, 'Far B'),
      zone(near, 0, 13 * INCH, 'Home'),
    ];

    this.obstacles = [
      box(0, s * 0.06, 0.16, 0.7),
      box(-0.2, -s * 0.22, 0.6, 0.16),
      box(0.5, -s * 0.02, 0.16, 0.6),
    ];

    this.opponents = [
      {
        profileId: 'pusher',
        skillId: 'competent',
        behavior: 'blocker',
        start: { x: 0.3, y: 0.4, heading: Math.PI },
      },
      {
        profileId: 'rival',
        skillId: 'competent',
        behavior: 'camper',
        start: { x: 0.3, y: -0.6, heading: Math.PI },
      },
    ];
  }
}

/** Every drill, easiest first. */
export const CHALLENGE_CLASSES = [
  SprintStop,
  ShuttleRun,
  Slalom,
  PrecisionParking,
  FigureEight,
  BarrelCourse,
  Threading,
  ReverseDock,
  StrafeGauntlet,
  SlowZone,
  Maze,
  GauntletRun,
  Defended,
  Evasion,
  MatchSimulation,
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

export const TIER_LABELS = {
  basic: 'Basic — learn the machine',
  intermediate: 'Intermediate — real manoeuvres',
  advanced: 'Advanced — long and contested',
};
