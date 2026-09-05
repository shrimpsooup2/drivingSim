import { DEG, INCH } from '../../math/MathUtil.js';

/**
 * Starting points for common FTC chassis.
 *
 * These describe real, buildable configurations. Load one, then adjust it
 * toward your own robot -- the closer the mass, CG height and gear ratio are to
 * the real thing, the more practice here transfers to the field.
 *
 * @typedef {object} RobotPreset
 * @property {string} id
 * @property {string} name
 * @property {string} description
 * @property {Record<string, any>} values dotted config paths
 */

/** @type {RobotPreset[]} */
export const ROBOT_PRESETS = [
  {
    id: 'straferMecanum',
    name: 'goBILDA Strafer (312 RPM mecanum)',
    description:
      'The default. A parallel-plate mecanum chassis on 96 mm wheels with 312 RPM Yellow Jackets. Tops out around 5 ft/s and is what most FTC teams actually drive.',
    values: {
      'drivetrain.type': 'mecanum',
      'drivetrain.wheelbase': 12.75 * INCH,
      'drivetrain.trackWidth': 14 * INCH,
      'drivetrain.wheelRadius': 0.048,
      'drivetrain.rollerAngle': 45 * DEG,
      'motor.preset': 'gobilda5203',
      'motor.gearRatio': 19.2,
      'motor.externalRatio': 1,
      'chassis.mass': 13.5,
      'chassis.cgHeight': 0.11,
      'chassis.length': 17 * INCH,
      'chassis.width': 16 * INCH,
    },
  },
  {
    id: 'fastMecanum',
    name: 'Fast mecanum (435 RPM)',
    description:
      'The same chassis geared for speed: 13.7:1 gives about 7 ft/s. Quick across the field, but traction-limited under acceleration and much easier to spin out.',
    values: {
      'drivetrain.type': 'mecanum',
      'drivetrain.wheelbase': 12.75 * INCH,
      'drivetrain.trackWidth': 14 * INCH,
      'drivetrain.wheelRadius': 0.048,
      'motor.preset': 'gobilda5203',
      'motor.gearRatio': 13.7,
      'chassis.mass': 13.5,
      'chassis.cgHeight': 0.11,
    },
  },
  {
    id: 'torqueMecanum',
    name: 'Pushing mecanum (223 RPM)',
    description:
      'Geared down to 26.9:1 for about 3.7 ft/s. Slow, but it will not lose a pushing match, and the wheels are far harder to break loose.',
    values: {
      'drivetrain.type': 'mecanum',
      'motor.preset': 'gobilda5203',
      'motor.gearRatio': 26.9,
      'chassis.mass': 15.5,
      'chassis.cgHeight': 0.12,
    },
  },
  {
    id: 'tankTraction',
    name: 'Tank, 4 traction wheels',
    description:
      'No strafing, but roughly 40% more forward grip than mecanum because force goes straight down the robot instead of along a 45 degree roller. The classic pushing-robot choice.',
    values: {
      'drivetrain.type': 'tank',
      'drivetrain.wheelbase': 11 * INCH,
      'drivetrain.trackWidth': 14 * INCH,
      'motor.preset': 'gobilda5203',
      'motor.gearRatio': 19.2,
      'chassis.mass': 14,
      'driver.scheme': 'arcade',
    },
  },
  {
    id: 'tank6',
    name: 'Tank, 6 wheel drop centre',
    description:
      'Six wheels with the centre pair carrying most of the load, so the robot pivots about its middle and turns far more willingly than a four-wheel tank.',
    values: {
      'drivetrain.type': 'tank6',
      'drivetrain.wheelbase': 14 * INCH,
      'drivetrain.trackWidth': 14 * INCH,
      'motor.preset': 'gobilda5203',
      'motor.gearRatio': 19.2,
      'chassis.mass': 15,
      'driver.scheme': 'arcade',
    },
  },
  {
    id: 'xdrive',
    name: 'X-drive (4 omni at 45 deg)',
    description:
      'Holonomic like mecanum but without the roller-angle grip penalty, and every wheel drives in every direction. Quick and nimble; harder to build square.',
    values: {
      'drivetrain.type': 'xdrive',
      'motor.preset': 'gobilda5203',
      'motor.gearRatio': 13.7,
      'chassis.mass': 12.5,
      'driver.scheme': 'robotCentric',
    },
  },
  {
    id: 'tippy',
    name: 'Tall and tippy (training)',
    description:
      'A deliberately high CG with a narrow track. Use it to feel how weight transfer unloads wheels, and to practise driving something that will tip if you turn hard at speed.',
    values: {
      'drivetrain.type': 'mecanum',
      'drivetrain.trackWidth': 10 * INCH,
      'chassis.mass': 17,
      'chassis.cgHeight': 0.30,
      'chassis.height': 0.42,
      'motor.gearRatio': 13.7,
    },
  },
  {
    id: 'tiredBattery',
    name: 'Last match of the day',
    description:
      'The default chassis on a half-drained pack with high internal resistance. The robot is noticeably slower and weaker, and sags hard under acceleration. Worth practising against.',
    values: {
      'battery.startingStateOfCharge': 0.45,
      'battery.internalResistance': 0.055,
      'battery.openCircuitVoltage': 12.6,
    },
  },
];

/** @type {Record<string, RobotPreset>} */
export const ROBOT_PRESET_BY_ID = Object.fromEntries(ROBOT_PRESETS.map((p) => [p.id, p]));
