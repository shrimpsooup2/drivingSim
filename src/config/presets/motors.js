/**
 * FTC motor catalogue.
 *
 * Free speed, stall torque, stall current and free current are bare-motor
 * figures (before any gearbox) from vendor spec sheets. Vendors do revise
 * these, so check them against the current sheet for your part number.
 *
 * **Rotor inertia is not published by any FTC motor vendor.** The values here
 * are estimated from motor can geometry (armature treated as a steel cylinder
 * of roughly 25 mm diameter) and are the least trustworthy numbers in this
 * file. They matter: reflected through a 19.2:1 gearbox, 7e-6 kg*m^2 adds
 * about 5 kg of apparent mass to a 15 kg robot, and it is the main reason a
 * simulated robot accelerates differently from the real one.
 *
 * To calibrate against your robot: time it from a standstill to top speed on
 * a clear stretch of tiles, then adjust `motor.rotorInertia` until the
 * simulator matches. Everything else in the acceleration model is pinned to
 * published figures, so this is the right knob to turn.
 *
 * Every number is editable at runtime in the parameter panel. Measured values
 * from your own robot beat any catalogue figure.
 *
 * @module
 */

/**
 * @typedef {object} MotorSpec
 * @property {string} id
 * @property {string} name
 * @property {string} vendor
 * @property {number} freeSpeedRpm  bare motor, at 12 V
 * @property {number} stallTorque   N*m at the bare motor shaft, 12 V
 * @property {number} stallCurrent  amps
 * @property {number} freeCurrent   amps
 * @property {number} ticksPerRev   quadrature counts per motor-shaft revolution
 * @property {number} rotorInertia  kg*m^2 (estimated)
 * @property {string} [note]
 */

/** @type {Record<string, MotorSpec>} */
export const MOTOR_PRESETS = {
  gobilda5203: {
    id: 'gobilda5203',
    name: 'goBILDA 5203/5202 Yellow Jacket',
    vendor: 'goBILDA',
    freeSpeedRpm: 6000,
    stallTorque: 0.126,
    stallCurrent: 9.2,
    freeCurrent: 0.25,
    ticksPerRev: 28,
    rotorInertia: 7e-6,
    note: 'The most common FTC drivetrain motor. Bare-motor figures; the geared part numbers (312 RPM, 435 RPM, ...) are gearbox options applied on top. Rotor inertia is estimated, not published -- calibrate it against your robot.',
  },
  revHdHex: {
    id: 'revHdHex',
    name: 'REV HD Hex Motor',
    vendor: 'REV Robotics',
    freeSpeedRpm: 6000,
    stallTorque: 0.105,
    stallCurrent: 11.5,
    freeCurrent: 0.4,
    ticksPerRev: 28,
    rotorInertia: 7e-6,
  },
  neverest: {
    id: 'neverest',
    name: 'AndyMark NeveRest (classic)',
    vendor: 'AndyMark',
    freeSpeedRpm: 6600,
    stallTorque: 0.171,
    stallCurrent: 11.5,
    freeCurrent: 0.4,
    ticksPerRev: 28,
    rotorInertia: 8e-6,
  },
  torquenado: {
    id: 'torquenado',
    name: 'TETRIX TorqueNADO',
    vendor: 'Pitsco',
    freeSpeedRpm: 6600,
    stallTorque: 0.17,
    stallCurrent: 11,
    freeCurrent: 0.4,
    ticksPerRev: 24,
    rotorInertia: 8e-6,
  },
  revCoreHex: {
    id: 'revCoreHex',
    name: 'REV Core Hex (bare equivalent)',
    vendor: 'REV Robotics',
    freeSpeedRpm: 9000,
    stallTorque: 0.0475,
    stallCurrent: 4.4,
    freeCurrent: 0.2,
    ticksPerRev: 4,
    rotorInertia: 3e-6,
    note: 'Ships with a 72:1 gearbox built in (125 RPM, 3.2 N*m output). Set gear ratio to 72 to match the real part. Too weak for a competitive drivetrain; included for completeness.',
  },
};

/**
 * Common goBILDA Yellow Jacket gearbox options, by output speed.
 * Ratios are the exact planetary values, not the marketing round numbers.
 */
export const GOBILDA_GEARBOXES = [
  { ratio: 3.7, outputRpm: 1620, label: '3.7:1 (1620 RPM)' },
  { ratio: 5.2, outputRpm: 1150, label: '5.2:1 (1150 RPM)' },
  { ratio: 13.7, outputRpm: 435, label: '13.7:1 (435 RPM)' },
  { ratio: 19.2, outputRpm: 312, label: '19.2:1 (312 RPM)' },
  { ratio: 26.9, outputRpm: 223, label: '26.9:1 (223 RPM)' },
  { ratio: 50.9, outputRpm: 117, label: '50.9:1 (117 RPM)' },
  { ratio: 71.2, outputRpm: 84, label: '71.2:1 (84 RPM)' },
];

export const DEFAULT_MOTOR_ID = 'gobilda5203';
