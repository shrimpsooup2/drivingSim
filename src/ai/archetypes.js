import { INCH } from '../math/MathUtil.js';

/**
 * What kind of robot an AI drives, and how well it is built.
 *
 * Three separate axes, kept separate on purpose, because on a real field they
 * are separate and conflating them produces opponents that are wrong in an
 * uninstructive way:
 *
 *   **Archetype** is what the machine is *for* -- the chassis, the mechanisms
 *   it has at all, and therefore what it can even attempt. A defender has no
 *   shooter; no amount of driver skill will make it score in a CELL.
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
 * @module
 */

/**
 * @typedef {object} RobotArchetype
 * @property {string} id
 * @property {string} name
 * @property {string} description
 * @property {number[]} color
 * @property {Record<string, any>} chassis dotted config overrides for the build
 * @property {'cycler'|'flowerFiller'|'defender'|'tipper'} role default plan
 * @property {object|null} launcher base launcher options, or null for no shooter
 * @property {object|null} intake base intake options, or null for no intake
 * @property {number} [preferredRange] metres it likes to shoot from
 */

/** @type {RobotArchetype[]} */
export const ROBOT_ARCHETYPES = [
  {
    id: 'cycler',
    name: 'Cycler',
    description:
      'The standard BIOBUZZ robot: a floor intake and a flywheel, built to pick POLLEN up and put it in a CELL as fast as it can. What most of the field will be.',
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
      motorCount: 1,
      inertia: 8.3e-4,
      transferEfficiency: 0.5,
      feedInterval: 0.35,
      maxRpm: 4000,
    },
  },
  {
    id: 'sniper',
    name: 'Sniper',
    description:
      'A big, heavy flywheel and a repeatable hood. It shoots from the back of the field and barely misses, but it holds one element and takes its time between shots.',
    color: [0.55, 0.45, 0.9, 1],
    role: 'cycler',
    preferredRange: 2.6,
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
    intake: { capacity: 1, reach: 3.5 * INCH, halfAngle: 0.45 },
    launcher: {
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
    id: 'gardener',
    name: 'Gardener',
    description:
      'A wide intake and a big magazine, no shooter at all. Sweeps POLLEN off the tiles and feeds it into FLOWERS, which is worth more per element than a CELL and cannot be tipped away.',
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
    intake: { capacity: 6, reach: 6.5 * INCH, halfAngle: 0.85 },
    launcher: null,
  },
  {
    id: 'defender',
    name: 'Defender',
    description:
      'Heavy, geared down, on traction wheels, with nothing but a bumper. It does not score; it stands between you and where you were going, and you will not push it out of the way.',
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
    launcher: null,
  },
  {
    id: 'scout',
    name: 'Scout',
    description:
      'Small, light and geared for speed, with a quick intake and a weak shooter. It gets to loose POLLEN first and has to shoot from close in, where the CELL is hardest to drop into.',
    color: [0.95, 0.72, 0.2, 1],
    role: 'cycler',
    preferredRange: 1.35,
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
    description:
      'Built around the HIVE. It fills its own raised CELL until the arm goes over, banking the TIP points and unlocking a NECTAR, then does it again. Nothing else on the field interests it.',
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
    intake: { capacity: 4, reach: 5 * INCH, halfAngle: 0.7 },
    launcher: {
      motorCount: 2,
      inertia: 1.1e-3,
      transferEfficiency: 0.55,
      feedInterval: 0.28,
      maxRpm: 4200,
    },
  },
];

/** @type {Record<string, RobotArchetype>} */
export const ARCHETYPE_BY_ID = Object.fromEntries(ROBOT_ARCHETYPES.map((a) => [a.id, a]));

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
 * @property {number} intakeCapacityDelta  elements added to the magazine
 * @property {number} intakeReachScale
 * @property {number} intakeSpinUpScale
 * @property {number} gearRatioScale       above 1 is geared slower
 * @property {number} jamChance            per cycle, costs it a second or two
 */

/**
 * How well the thing is actually built.
 *
 * These are not difficulty knobs dressed up as engineering. Each one is a
 * thing you can point at on a real robot: how many motors are on the flywheel,
 * whether the hood is a bolted plate or a shimmed one, whether the intake ever
 * jams. A rough build loses most of its scoring to repeatability and recovery
 * time, which is exactly what it loses in reality.
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
    intakeCapacityDelta: -1,
    intakeReachScale: 0.75,
    intakeSpinUpScale: 1.9,
    gearRatioScale: 1.12,
    jamChance: 0.13,
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
    intakeCapacityDelta: 0,
    intakeReachScale: 1,
    intakeSpinUpScale: 1,
    gearRatioScale: 1,
    jamChance: 0.04,
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
    intakeCapacityDelta: 1,
    intakeReachScale: 1.25,
    intakeSpinUpScale: 0.6,
    gearRatioScale: 0.92,
    jamChance: 0.005,
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
  };
}

/**
 * Launcher options for an archetype at a build quality, or null if it has no
 * shooter.
 *
 * The motor count comes from the quality rather than the archetype except
 * where the archetype has already committed to two -- a Sniper's whole
 * identity is the flywheel, so a rough Sniper is a rough *two-motor* shooter,
 * not a one-motor one.
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
