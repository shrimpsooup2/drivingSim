import { INCH } from '../math/MathUtil.js';

/**
 * Opponent robot builds and driver skill levels.
 *
 * Each opponent is a *fully simulated robot* -- same drivetrain, motor curve,
 * battery and traction model as the player's. That matters: a scripted mover
 * that glides along a path teaches nothing, because it cannot be out-driven.
 * These have to accelerate, break traction and get shoved, so beating one is a
 * real driving result.
 *
 * @module
 */

/**
 * @typedef {object} OpponentProfile
 * @property {string} id
 * @property {string} name
 * @property {string} description
 * @property {Record<string, any>} config  dotted config overrides for its build
 * @property {number[]} color
 */

/** @type {OpponentProfile[]} */
export const OPPONENT_PROFILES = [
  {
    id: 'scout',
    name: 'Scout',
    description:
      'Small, light and geared for speed. Very hard to out-run and very easy to push out of the way -- if you can catch it.',
    color: [0.95, 0.72, 0.2, 1],
    config: {
      'drivetrain.type': 'mecanum',
      'drivetrain.wheelbase': 10 * INCH,
      'drivetrain.trackWidth': 11 * INCH,
      'chassis.length': 13 * INCH,
      'chassis.width': 12.5 * INCH,
      'chassis.mass': 8.5,
      'chassis.cgHeight': 0.09,
      'motor.gearRatio': 13.7,
    },
  },
  {
    id: 'rival',
    name: 'Rival',
    description:
      'A mirror of a standard competition robot: same size, same weight, same gearing as yours. Whoever drives better wins.',
    color: [0.85, 0.35, 0.35, 1],
    config: {
      'drivetrain.type': 'mecanum',
      'drivetrain.wheelbase': 12.75 * INCH,
      'drivetrain.trackWidth': 14 * INCH,
      'chassis.length': 17 * INCH,
      'chassis.width': 16 * INCH,
      'chassis.mass': 14,
      'motor.gearRatio': 19.2,
    },
  },
  {
    id: 'pusher',
    name: 'Pusher',
    description:
      'Heavy, geared down, on traction wheels. Slow across the field but you will not move it, and it will move you. The classic defensive build.',
    color: [0.45, 0.5, 0.95, 1],
    config: {
      'drivetrain.type': 'tank',
      'drivetrain.wheelbase': 13 * INCH,
      'drivetrain.trackWidth': 15 * INCH,
      'chassis.length': 18 * INCH,
      'chassis.width': 17.5 * INCH,
      'chassis.mass': 19,
      'chassis.cgHeight': 0.13,
      'motor.gearRatio': 26.9,
    },
  },
  {
    id: 'brick',
    name: 'Brick',
    description:
      'Barely moves, but nothing shifts it either. A rolling roadblock that parks where you want to be.',
    color: [0.55, 0.58, 0.62, 1],
    config: {
      'drivetrain.type': 'tank',
      'drivetrain.wheelbase': 12 * INCH,
      'drivetrain.trackWidth': 16 * INCH,
      'chassis.length': 17.5 * INCH,
      'chassis.width': 17.5 * INCH,
      'chassis.mass': 21,
      'motor.gearRatio': 50.9,
    },
  },
];

/** @type {Record<string, OpponentProfile>} */
export const PROFILE_BY_ID = Object.fromEntries(OPPONENT_PROFILES.map((p) => [p.id, p]));

/**
 * @typedef {object} SkillLevel
 * @property {string} id
 * @property {string} name
 * @property {number} reactionSeconds  how stale its picture of you is
 * @property {number} aimNoise         random error added to its commands
 * @property {number} maxPower         fraction of full power it will use
 * @property {number} replanHz         how often it picks a new target
 * @property {number} prediction       seconds of your motion it leads by
 * @property {number} mistakeChance    probability per re-plan of a wasted move
 */

/** @type {SkillLevel[]} */
export const SKILL_LEVELS = [
  {
    id: 'rookie',
    name: 'Rookie',
    reactionSeconds: 0.45,
    aimNoise: 0.18,
    maxPower: 0.55,
    replanHz: 2.5,
    prediction: 0,
    mistakeChance: 0.25,
  },
  {
    id: 'competent',
    name: 'Competent',
    reactionSeconds: 0.22,
    aimNoise: 0.08,
    maxPower: 0.78,
    replanHz: 6,
    prediction: 0.2,
    mistakeChance: 0.08,
  },
  {
    id: 'veteran',
    name: 'Veteran',
    reactionSeconds: 0.1,
    aimNoise: 0.03,
    maxPower: 1,
    replanHz: 12,
    prediction: 0.45,
    mistakeChance: 0.01,
  },
];

/** @type {Record<string, SkillLevel>} */
export const SKILL_BY_ID = Object.fromEntries(SKILL_LEVELS.map((s) => [s.id, s]));
