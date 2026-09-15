import { INCH } from '../math/MathUtil.js';

/**
 * What kind of robot an AI drives, and how well it is built.
 *
 * Three separate axes, kept separate on purpose, because on a real field they
 * are separate and conflating them produces opponents that are wrong in an
 * uninstructive way:
 *
 *   **Archetype** is what the machine *is* -- the chassis, and specifically
 *   which scoring system it has. That is the interesting axis, because BIOBUZZ
 *   has two scoring routes with different mechanisms: G419 lets a ROBOT "only
 *   enter POLLEN and NECTAR into the top of a FLOWER" (21.25 in up, so a lift
 *   or an arm) while a CELL is 53.5 in up and has to be LAUNCHED into. A robot
 *   built for one cannot do the other, and a pushbot can do neither.
 *
 *   **Build quality** is how well that machine works. Two teams build the same
 *   cycler and one of them has two motors on the flywheel, a repeatable hood
 *   and an intake that does not jam. It scores twice as much with the same
 *   driver.
 *
 *   **Driver skill** (in `profiles.js`) is the human: reaction time,
 *   precision, how much power they dare use, how often they commit to
 *   something unhelpful.
 *
 * Practising against "a rookie driver on an excellent robot" and "a veteran on
 * a rough one" are genuinely different exercises, and at a real event you meet
 * both. So all three are chosen independently.
 *
 * ## The scoring systems
 *
 * Each archetype names a `launcher` (a flywheel, via `Launcher`), a `thrower`
 * (stored energy, via `Thrower`), an `intake` (a roller, or a jaw when
 * `grabber` is set), or none of them. They behave differently enough that the
 * archetype is the main thing that makes one opponent feel unlike another:
 *
 *   - a **single flywheel** gets about half the wheel's surface speed into the
 *     ball, because a ball against a fixed backplate spends part of the
 *     contact being spun up;
 *   - a **twin flywheel** grips from both sides and gets most of it, so it
 *     reaches the same range at far lower RPM and recovers faster;
 *   - a **catapult** is an energy source, not a speed source, so a heavier
 *     NECTAR comes out much slower and it has a hard maximum range;
 *   - a **puncher** is a small catapult: repeatable, quick to reset, useless
 *     past a couple of metres;
 *   - a **claw** cannot launch at all, so it lives on the FLOWERS.
 *
 * @module
 */

/**
 * @typedef {object} RobotArchetype
 * @property {string} id
 * @property {string} name
 * @property {string} system  one-line summary of the scoring mechanism
 * @property {string} description
 * @property {number[]} color
 * @property {Record<string, any>} chassis dotted config overrides for the build
 * @property {'cycler'|'flowerFiller'|'defender'|'tipper'} role default plan
 * @property {object|null} [launcher] flywheel options
 * @property {object|null} [thrower] stored-energy launcher options
 * @property {object|null} intake roller or jaw options, null for a pushbot
 * @property {number} [preferredRange] metres it likes to score from
 */

/** @type {RobotArchetype[]} */
export const ROBOT_ARCHETYPES = [
  {
    id: 'cycler',
    name: 'Cycler',
    system: 'Single flywheel, roller intake',
    description:
      'The standard BIOBUZZ robot: a floor intake and one flywheel against a backplate, built to pick POLLEN up and put it in a CELL as fast as it can. What most of the field will be.',
    color: [0.85, 0.35, 0.35, 1],
    role: 'cycler',
    preferredRange: 1.7,
    chassis: {
      'drivetrain.type': 'mecanum',
      'drivetrain.wheelbase': 12.75 * INCH,
      'drivetrain.trackWidth': 14 * INCH,
      'chassis.length': 17 * INCH,
      'chassis.width': 16 * INCH,
      'chassis.mass': 14,
      'motor.gearRatio': 19.2,
    },
    intake: { capacity: 3, reach: 4.5 * INCH, halfAngle: 0.6 },
    launcher: {
      kind: 'flywheel',
      motorCount: 1,
      inertia: 8.3e-4,
      transferEfficiency: 0.5,
      feedInterval: 0.35,
      maxRpm: 4000,
    },
  },
  {
    id: 'twinWheel',
    name: 'Twin-wheel shooter',
    system: 'Two counter-rotating flywheels',
    description:
      'A pair of wheels gripping the element from both sides, so almost all of the surface speed reaches it. Half the RPM of a single wheel for the same range, and it recovers between shots quickly enough to empty a magazine without waiting.',
    color: [0.3, 0.72, 0.78, 1],
    role: 'cycler',
    preferredRange: 1.9,
    chassis: {
      'drivetrain.type': 'mecanum',
      'drivetrain.wheelbase': 12.75 * INCH,
      'drivetrain.trackWidth': 14 * INCH,
      'chassis.length': 17.5 * INCH,
      'chassis.width': 16 * INCH,
      'chassis.mass': 15.5,
      'motor.gearRatio': 19.2,
    },
    intake: { capacity: 4, reach: 5 * INCH, halfAngle: 0.65 },
    launcher: {
      kind: 'twin flywheel',
      motorCount: 2,
      inertia: 1.2e-3,
      // Gripped from both sides there is no backplate to slip against, so the
      // element leaves at nearly the surface speed rather than half of it.
      transferEfficiency: 0.9,
      feedInterval: 0.3,
      maxRpm: 3600,
    },
  },
  {
    id: 'sniper',
    name: 'Sniper',
    system: 'Heavy single flywheel, long hood',
    description:
      'A big, heavy flywheel and a repeatable hood. It takes the longest shot the FIELD allows and barely misses, but it holds one element and takes an age to spin up.',
    color: [0.55, 0.45, 0.9, 1],
    role: 'cycler',
    // A CELL faces along the arm and only accepts a descending element, so the
    // furthest legal stand-off is about 2.15 m -- past that you are behind the
    // opening plane and no shot exists at any angle. "Long range" on this
    // FIELD means the far corner, not the far wall.
    preferredRange: 2.1,
    chassis: {
      'drivetrain.type': 'mecanum',
      'drivetrain.wheelbase': 13 * INCH,
      'drivetrain.trackWidth': 14.5 * INCH,
      'chassis.length': 17.5 * INCH,
      'chassis.width': 16.5 * INCH,
      'chassis.mass': 16.5,
      'chassis.cgHeight': 0.12,
      'motor.gearRatio': 19.2,
    },
    intake: { capacity: 2, reach: 3.5 * INCH, halfAngle: 0.45 },
    launcher: {
      kind: 'heavy flywheel',
      motorCount: 2,
      // Three times the flywheel inertia: it takes far longer to spin up and
      // barely notices a ball going through, which is exactly the trade a
      // long-range shooter makes.
      inertia: 2.4e-3,
      transferEfficiency: 0.62,
      feedInterval: 0.8,
      maxRpm: 4500,
    },
  },
  {
    id: 'catapult',
    name: 'Catapult',
    system: 'Elastic throwing arm',
    description:
      'Surgical tubing and a cup. No spin-up and no recovery problem -- but a fixed amount of energy, so range comes from the release angle alone, a NECTAR goes a third less far than a POLLEN, and it cannot throw again until the motor has wound it back.',
    color: [0.9, 0.45, 0.6, 1],
    role: 'cycler',
    preferredRange: 1.9,
    chassis: {
      'drivetrain.type': 'mecanum',
      'drivetrain.wheelbase': 12 * INCH,
      'drivetrain.trackWidth': 14 * INCH,
      'chassis.length': 17 * INCH,
      'chassis.width': 16.5 * INCH,
      'chassis.mass': 14.5,
      'motor.gearRatio': 19.2,
    },
    intake: { capacity: 3, reach: 5 * INCH, halfAngle: 0.7 },
    thrower: {
      kind: 'catapult',
      energy: 1.35,
      efficiency: 0.72,
      resetSeconds: 1.3,
      batch: 1,
      // 80 degrees, not 72. A CELL only takes a descending element, so the
      // shot has to be the lofted one of the two solutions -- and at the two
      // metres the FIELD actually allows, that root is 76 degrees. An arm that
      // stopped at 72 could not score from anywhere on the tiles: it was not
      // short of energy, it was short of elevation.
      maxAngle: (80 * Math.PI) / 180,
    },
  },
  {
    id: 'lobber',
    name: 'Lobber',
    system: 'Elastic arm, throws a handful',
    description:
      'A catapult with a tray instead of a cup. It throws three at once and the stored energy is shared between them, so they come out slow and spread -- it has to drive right up to the HIVE, and it either fills the CELL or misses with all three.',
    color: [0.95, 0.6, 0.3, 1],
    role: 'tipper',
    preferredRange: 1.5,
    chassis: {
      'drivetrain.type': 'mecanum',
      'drivetrain.wheelbase': 12.5 * INCH,
      'drivetrain.trackWidth': 15 * INCH,
      'chassis.length': 17.5 * INCH,
      'chassis.width': 17 * INCH,
      'chassis.mass': 15.5,
      'motor.gearRatio': 17.2,
    },
    intake: { capacity: 5, reach: 6 * INCH, halfAngle: 0.8 },
    thrower: {
      kind: 'catapult',
      // Sized for three at a time: shared out, each element gets about 1.13 J,
      // which is a shade under what the single-shot catapult gives one. So the
      // penalty for throwing a handful is range and spread, not nothing.
      energy: 3.4,
      efficiency: 0.68,
      resetSeconds: 1.8,
      batch: 3,
      minAngle: (40 * Math.PI) / 180,
      maxAngle: (78 * Math.PI) / 180,
    },
  },
  {
    id: 'puncher',
    name: 'Puncher',
    system: 'Spring-loaded linear slide',
    description:
      'A slide that punches one element out at a fixed speed. Utterly repeatable and back in half a second, but there is not much energy in it: it has one narrow band of range that works and has to sit in it.',
    color: [0.75, 0.75, 0.35, 1],
    role: 'cycler',
    preferredRange: 1.8,
    chassis: {
      'drivetrain.type': 'mecanum',
      'drivetrain.wheelbase': 11.5 * INCH,
      'drivetrain.trackWidth': 13 * INCH,
      'chassis.length': 15.5 * INCH,
      'chassis.width': 15 * INCH,
      'chassis.mass': 11.5,
      'motor.gearRatio': 15.2,
    },
    intake: { capacity: 3, reach: 4.5 * INCH, halfAngle: 0.7, spinUpTime: 0.12 },
    thrower: {
      kind: 'puncher',
      energy: 0.95,
      efficiency: 0.82,
      resetSeconds: 0.45,
      batch: 1,
      minAngle: (52 * Math.PI) / 180,
      maxAngle: (76 * Math.PI) / 180,
      energyScatter: 0.01,
    },
  },
  {
    id: 'gardener',
    name: 'Gardener',
    system: 'Wide roller intake and a lift',
    description:
      'A wide intake, a big magazine and a lift that drops elements into the top of a FLOWER. No launcher at all. A FLOWER pays 2 for every element in it and cannot be tipped away, but filling one means stopping still beside it, one element at a time.',
    color: [0.4, 0.78, 0.45, 1],
    role: 'flowerFiller',
    chassis: {
      'drivetrain.type': 'mecanum',
      'drivetrain.wheelbase': 12 * INCH,
      'drivetrain.trackWidth': 15 * INCH,
      'chassis.length': 17.5 * INCH,
      'chassis.width': 17.5 * INCH,
      'chassis.mass': 13,
      'motor.gearRatio': 15.2,
    },
    intake: {
      capacity: 6,
      reach: 6.5 * INCH,
      halfAngle: 0.85,
      placeSeconds: 0.8,
      placeReach: 9 * INCH,
    },
  },
  {
    id: 'clawbot',
    name: 'Clawbot',
    system: 'Single-element jaw on an arm',
    description:
      'A jaw on an arm. It has to stop and close on one element at a time, which is slow, but the arm reaches further over a FLOWER than a lift does and it can pull POLLEN out of the bottom of one just as easily. No launcher, so CELLS are out of reach entirely.',
    color: [0.62, 0.66, 0.72, 1],
    role: 'flowerFiller',
    chassis: {
      'drivetrain.type': 'mecanum',
      'drivetrain.wheelbase': 11.5 * INCH,
      'drivetrain.trackWidth': 13.5 * INCH,
      'chassis.length': 16 * INCH,
      'chassis.width': 15 * INCH,
      'chassis.mass': 12,
      'motor.gearRatio': 19.2,
    },
    intake: {
      // A jaw, not a roller: it must be nearly stopped, its capture cone is
      // narrow, and it holds one thing.
      grabber: true,
      capacity: 1,
      reach: 3 * INCH,
      halfAngle: 0.3,
      captureSpeed: 0.12,
      spinUpTime: 0.45,
      placeSeconds: 1.1,
      placeReach: 13 * INCH,
      placeTolerance: 4 * INCH,
    },
  },
  {
    id: 'defender',
    name: 'Defender',
    system: 'Nothing but a bumper',
    description:
      'Heavy, geared down, on traction wheels, with no mechanism at all. It does not score; it stands between you and where you were going, and you will not push it out of the way.',
    color: [0.45, 0.5, 0.95, 1],
    role: 'defender',
    chassis: {
      'drivetrain.type': 'tank',
      'drivetrain.wheelbase': 13 * INCH,
      'drivetrain.trackWidth': 15 * INCH,
      'chassis.length': 18 * INCH,
      'chassis.width': 17.5 * INCH,
      'chassis.mass': 19,
      'chassis.cgHeight': 0.13,
      'motor.gearRatio': 26.9,
    },
    intake: null,
  },
  {
    id: 'pushbot',
    name: 'Pushbot',
    system: 'None -- a kit chassis',
    description:
      'A stock kit chassis somebody bolted a battery to. It drives around, gets in the way by accident, and scores nothing. There is one on nearly every field and you will be matched with it.',
    color: [0.6, 0.55, 0.45, 1],
    role: 'defender',
    chassis: {
      'drivetrain.type': 'tank',
      'drivetrain.wheelbase': 11 * INCH,
      'drivetrain.trackWidth': 13 * INCH,
      'chassis.length': 15 * INCH,
      'chassis.width': 14 * INCH,
      'chassis.mass': 10,
      'motor.gearRatio': 19.2,
    },
    intake: null,
  },
  {
    id: 'scout',
    name: 'Scout',
    system: 'Light single flywheel',
    description:
      'Small, light and geared for speed, with a quick intake and a weak shooter. It gets to loose POLLEN first and has to shoot from close in, where the CELL is hardest to drop into.',
    color: [0.95, 0.72, 0.2, 1],
    role: 'cycler',
    preferredRange: 1.2,
    chassis: {
      'drivetrain.type': 'mecanum',
      'drivetrain.wheelbase': 10 * INCH,
      'drivetrain.trackWidth': 11 * INCH,
      'chassis.length': 13 * INCH,
      'chassis.width': 12.5 * INCH,
      'chassis.mass': 8.5,
      'chassis.cgHeight': 0.09,
      'motor.gearRatio': 13.7,
    },
    intake: { capacity: 2, reach: 4 * INCH, halfAngle: 0.7, spinUpTime: 0.1 },
    launcher: {
      kind: 'flywheel',
      motorCount: 1,
      inertia: 4.5e-4,
      transferEfficiency: 0.42,
      feedInterval: 0.3,
      maxRpm: 3400,
    },
  },
  {
    id: 'tipper',
    name: 'Tipper',
    system: 'Twin flywheel, big magazine',
    description:
      'Built around the HIVE. It fills up, drives into range and empties the whole magazine into its own raised CELL to force the arm over, banking the TIP points and unlocking a NECTAR. Nothing else on the field interests it.',
    color: [0.9, 0.55, 0.25, 1],
    role: 'tipper',
    preferredRange: 1.6,
    chassis: {
      'drivetrain.type': 'mecanum',
      'drivetrain.wheelbase': 12.5 * INCH,
      'drivetrain.trackWidth': 14 * INCH,
      'chassis.length': 17 * INCH,
      'chassis.width': 16 * INCH,
      'chassis.mass': 15,
      'motor.gearRatio': 19.2,
    },
    intake: { capacity: 5, reach: 5 * INCH, halfAngle: 0.7 },
    launcher: {
      kind: 'twin flywheel',
      motorCount: 2,
      inertia: 1.1e-3,
      transferEfficiency: 0.86,
      feedInterval: 0.26,
      maxRpm: 3800,
    },
  },
];

/** @type {Record<string, RobotArchetype>} */
export const ARCHETYPE_BY_ID = Object.fromEntries(ROBOT_ARCHETYPES.map((a) => [a.id, a]));

/** Archetypes that can put something in a CELL. */
export const SHOOTING_ARCHETYPES = ROBOT_ARCHETYPES.filter((a) => a.launcher || a.thrower);

/**
 * @typedef {object} BuildQuality
 * @property {string} id
 * @property {string} name
 * @property {string} description
 * @property {number} shooterMotors        motors on the flywheel
 * @property {number} feedIntervalScale    time between shots
 * @property {number} hoodScatterDegrees   run-to-run hood repeatability
 * @property {number} rpmScatter           run-to-run wheel repeatability
 * @property {number} readyTolerance       how close to target before it fires
 * @property {number} resetScale           a thrower's winding time
 * @property {number} energyScatter        a thrower's throw-to-throw energy
 * @property {number} intakeCapacityDelta  elements added to the magazine
 * @property {number} intakeReachScale
 * @property {number} intakeSpinUpScale
 * @property {number} placeScale           time to place into a FLOWER
 * @property {number} gearRatioScale       above 1 is geared slower
 * @property {number} jamsPerMinute        intake seizures, each costing a second
 */

/**
 * How well the thing is actually built.
 *
 * These are not difficulty knobs dressed up as engineering. Each one is
 * something you can point at on a real robot: how many motors are on the
 * flywheel, whether the hood is a bolted plate or a shimmed one, whether the
 * intake ever jams. A rough build loses most of its scoring to repeatability
 * and recovery time, which is what it loses in reality.
 *
 * @type {BuildQuality[]}
 */
export const BUILD_QUALITIES = [
  {
    id: 'rough',
    name: 'Thrown together',
    description:
      'One motor on the flywheel, a hood that moves when you look at it, an intake that jams. Scores, but slowly and not from range.',
    shooterMotors: 1,
    feedIntervalScale: 1.7,
    hoodScatterDegrees: 2.6,
    rpmScatter: 0.055,
    // Fires while the wheel is still 12 percent low, which is the single
    // biggest reason a rough robot shoots short.
    readyTolerance: 0.88,
    resetScale: 1.6,
    energyScatter: 0.09,
    intakeCapacityDelta: -1,
    intakeReachScale: 0.75,
    intakeSpinUpScale: 1.9,
    placeScale: 1.7,
    gearRatioScale: 1.12,
    jamsPerMinute: 12,
  },
  {
    id: 'solid',
    name: 'Competition ready',
    description:
      'A sound league robot. Repeatable, recovers between shots, occasionally fumbles a pickup.',
    shooterMotors: 1,
    feedIntervalScale: 1,
    hoodScatterDegrees: 1,
    rpmScatter: 0.02,
    readyTolerance: 0.96,
    resetScale: 1,
    energyScatter: 0.03,
    intakeCapacityDelta: 0,
    intakeReachScale: 1,
    intakeSpinUpScale: 1,
    placeScale: 1,
    gearRatioScale: 1,
    jamsPerMinute: 4,
  },
  {
    id: 'elite',
    name: 'Worlds calibre',
    description:
      'Two motors on the wheel, a hood you could measure with a gauge block, an intake that never misses. Recovers fast enough to shoot as quickly as it can feed.',
    shooterMotors: 2,
    feedIntervalScale: 0.72,
    hoodScatterDegrees: 0.3,
    rpmScatter: 0.006,
    readyTolerance: 0.985,
    resetScale: 0.7,
    energyScatter: 0.008,
    intakeCapacityDelta: 1,
    intakeReachScale: 1.25,
    intakeSpinUpScale: 0.6,
    placeScale: 0.7,
    gearRatioScale: 0.92,
    jamsPerMinute: 0.5,
  },
];

/** @type {Record<string, BuildQuality>} */
export const QUALITY_BY_ID = Object.fromEntries(BUILD_QUALITIES.map((q) => [q.id, q]));

/**
 * Chassis config overrides for an archetype at a given build quality.
 *
 * Quality touches the gearing, because a conservatively geared robot is the
 * usual shape of a cautious build, and it is the one quality effect a driver
 * feels immediately when they try to out-run it.
 *
 * @param {RobotArchetype} archetype
 * @param {BuildQuality} quality
 */
export function chassisConfig(archetype, quality) {
  const out = { ...archetype.chassis };
  const ratio = out['motor.gearRatio'];
  if (ratio) out['motor.gearRatio'] = ratio * quality.gearRatioScale;
  return out;
}

/**
 * Intake options for an archetype at a build quality, or null if it has none.
 * @param {RobotArchetype} archetype
 * @param {BuildQuality} quality
 */
export function intakeOptions(archetype, quality) {
  if (!archetype.intake) return null;
  const base = archetype.intake;
  return {
    ...base,
    capacity: Math.max(1, (base.capacity ?? 3) + quality.intakeCapacityDelta),
    reach: (base.reach ?? 4 * INCH) * quality.intakeReachScale,
    spinUpTime: (base.spinUpTime ?? 0.15) * quality.intakeSpinUpScale,
    placeSeconds: (base.placeSeconds ?? 0.9) * quality.placeScale,
  };
}

/**
 * Flywheel options for an archetype at a build quality, or null if it does not
 * have one.
 *
 * The motor count comes from the quality *except* where the archetype has
 * already committed to two -- a Sniper's whole identity is the flywheel, so a
 * rough Sniper is a rough two-motor shooter, not a one-motor one.
 *
 * @param {RobotArchetype} archetype
 * @param {BuildQuality} quality
 */
export function launcherOptions(archetype, quality) {
  if (!archetype.launcher) return null;
  const base = archetype.launcher;
  return {
    ...base,
    motorCount: Math.max(base.motorCount ?? 1, quality.shooterMotors),
    feedInterval: (base.feedInterval ?? 0.35) * quality.feedIntervalScale,
    readyTolerance: quality.readyTolerance,
    hoodScatter: (quality.hoodScatterDegrees * Math.PI) / 180,
    rpmScatter: quality.rpmScatter,
  };
}

/**
 * Stored-energy launcher options, or null if this archetype has no thrower.
 *
 * Quality shows up as the winding time and the throw-to-throw energy spread.
 * There is no "fired too early" failure on a thrower -- it is loaded or it is
 * not -- so a rough one loses to its reset and its consistency instead.
 *
 * @param {RobotArchetype} archetype
 * @param {BuildQuality} quality
 */
export function throwerOptions(archetype, quality) {
  if (!archetype.thrower) return null;
  const base = archetype.thrower;
  return {
    ...base,
    resetSeconds: (base.resetSeconds ?? 1.3) * quality.resetScale,
    angleScatter: (quality.hoodScatterDegrees * Math.PI) / 180,
    energyScatter: Math.max(base.energyScatter ?? 0, quality.energyScatter),
  };
}
