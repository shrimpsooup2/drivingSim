import { INCH } from '../../math/MathUtil.js';

/**
 * The launch systems the player's ROBOT can be built with.
 *
 * A CELL is 53.5 in up and the manual says ROBOTS "LAUNCH them into their
 * CELLS", so getting anything in there means throwing it -- and how you throw
 * it changes what practising feels like more than almost anything else on the
 * robot:
 *
 *   a **single flywheel** runs the element against a fixed backplate and gets
 *   about half the surface speed into it, so it needs high RPM, and it loses
 *   6 percent of that speed to every ball that goes through. The skill is
 *   patience -- watch the recovery bar, and do not fire early.
 *
 *   **twin flywheels** grip from both sides, so nearly all the surface speed
 *   reaches the element. Same range at far lower RPM, and it recovers quickly
 *   enough to empty a magazine at feeder speed. Easier, and the reason most
 *   teams end up there.
 *
 *   a **catapult** stores a fixed number of joules, so speed goes as
 *   `sqrt(2*eta*E/m)` and a NECTAR comes out a quarter slower than a POLLEN.
 *   There is no firing early -- it is wound or it is not -- so the rhythm is
 *   set by the reset, and range comes from the release angle alone.
 *
 *   a **puncher** is a small catapult: back in half a second, utterly
 *   repeatable, and out of energy past about a metre and a half.
 *
 * Drilling with the wrong one is worse than not drilling, which is why this is
 * a setting rather than a fixed choice.
 *
 * @module
 */

/**
 * @typedef {object} LaunchSystem
 * @property {string} id
 * @property {string} label
 * @property {string} help
 * @property {boolean} thrower  true to build a `Thrower`, false for a `Launcher`
 * @property {object} options   constructor options for whichever class
 */

/** @type {Record<string, LaunchSystem>} */
export const LAUNCH_SYSTEMS = {
  flywheel: {
    id: 'flywheel',
    label: 'Single flywheel',
    help: 'One wheel against a backplate. High RPM, a real recovery cost per shot, and the classic "wait for the wheel" discipline.',
    thrower: false,
    options: {
      kind: 'flywheel',
      motorCount: 1,
      inertia: 8.3e-4,
      transferEfficiency: 0.5,
      feedInterval: 0.35,
      maxRpm: 4000,
      targetRpm: 2400,
    },
  },
  twinFlywheel: {
    id: 'twinFlywheel',
    label: 'Twin flywheels',
    help: 'Two counter-rotating wheels gripping from both sides: nearly all the surface speed reaches the element, so the same range needs about half the RPM and recovery is quick.',
    thrower: false,
    options: {
      kind: 'twin flywheel',
      motorCount: 2,
      inertia: 1.2e-3,
      transferEfficiency: 0.9,
      feedInterval: 0.3,
      maxRpm: 3600,
      targetRpm: 1500,
    },
  },
  heavyFlywheel: {
    id: 'heavyFlywheel',
    label: 'Heavy flywheel',
    help: 'Three times the inertia. Slow to spin up and barely notices a ball going through, which is what a long-range shooter wants.',
    thrower: false,
    options: {
      kind: 'heavy flywheel',
      motorCount: 2,
      inertia: 2.4e-3,
      transferEfficiency: 0.62,
      feedInterval: 0.8,
      maxRpm: 4500,
      targetRpm: 2600,
    },
  },
  catapult: {
    id: 'catapult',
    label: 'Catapult',
    help: 'Elastic and a cup. No spin-up, no recovery, but a fixed energy: range comes from the release angle, a NECTAR goes much shorter than a POLLEN, and nothing happens at all until the motor has wound it back.',
    thrower: true,
    options: {
      kind: 'catapult',
      energy: 1.35,
      efficiency: 0.72,
      resetSeconds: 1.3,
      batch: 1,
      // A CELL only accepts a descending element, so the shot must be the
      // lofted root, which at the ranges this FIELD allows is around 76
      // degrees. An arm stopping at the usual 72 cannot score at all.
      maxAngle: (80 * Math.PI) / 180,
      exitHeight: 12 * INCH,
    },
  },
  puncher: {
    id: 'puncher',
    label: 'Linear puncher',
    help: 'A spring-loaded slide. Repeatable and back in half a second, with only enough energy for one narrow band of range -- you have to find it and stay in it.',
    thrower: true,
    options: {
      kind: 'puncher',
      energy: 0.95,
      efficiency: 0.82,
      resetSeconds: 0.45,
      batch: 1,
      minAngle: (52 * Math.PI) / 180,
      maxAngle: (76 * Math.PI) / 180,
      exitHeight: 11 * INCH,
    },
  },
};

/** Options for the settings panel. */
export const LAUNCH_SYSTEM_OPTIONS = Object.values(LAUNCH_SYSTEMS).map((s) => ({
  value: s.id,
  label: s.label,
}));
