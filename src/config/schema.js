import { DEG, INCH } from '../math/MathUtil.js';
import { MOTOR_PRESETS, DEFAULT_MOTOR_ID, GOBILDA_GEARBOXES } from './presets/motors.js';
import { LAYOUT_LABELS } from '../drivetrain/layouts.js';

/**
 * The single source of truth for every tunable in the simulator.
 *
 * Each parameter carries its type, range, unit, default and a plain-English
 * explanation of what it changes. The parameter panel is generated from this
 * list, so adding a tunable is one entry here and nothing else -- no UI code,
 * no serialisation code, no defaults duplicated in three places.
 *
 * Values are stored in SI. `display` names the unit shown in the UI.
 *
 * @module
 */

/**
 * @typedef {object} ParamDef
 * @property {string} path         dotted path into the config object
 * @property {string} label
 * @property {'number'|'enum'|'boolean'} type
 * @property {any} default
 * @property {string} [help]
 * @property {number} [min]
 * @property {number} [max]
 * @property {number} [step]
 * @property {string} [unit]       SI unit the value is stored in
 * @property {string} [display]    unit shown in the UI (value is converted into it)
 * @property {string} [suffix]     label shown after the value when it is *already*
 *                                 stored in that unit, so no conversion happens.
 *                                 Use this rather than `unit` for the handful of
 *                                 values kept in non-SI form (RPM, milliseconds,
 *                                 degrees per second) because the code that
 *                                 consumes them expects those units.
 * @property {{value:any,label:string}[]} [options]
 * @property {boolean} [advanced]  hidden until "show advanced" is enabled
 * @property {boolean} [rebuild]   changing this requires rebuilding the drivetrain
 */

/**
 * @typedef {object} ParamGroup
 * @property {string} id
 * @property {string} label
 * @property {string} description
 * @property {ParamDef[]} params
 */

const motorOptions = Object.values(MOTOR_PRESETS).map((m) => ({ value: m.id, label: m.name }));
const gearboxOptions = GOBILDA_GEARBOXES.map((g) => ({ value: g.ratio, label: g.label }));
const layoutOptions = Object.entries(LAYOUT_LABELS).map(([value, label]) => ({ value, label }));

/** @type {ParamGroup[]} */
export const SCHEMA = [
  {
    id: 'drivetrain',
    label: 'Drivetrain',
    description:
      'Wheel layout and geometry. The default is a parallel-plate mecanum chassis on 96 mm wheels, the most common FTC configuration.',
    params: [
      {
        path: 'drivetrain.type',
        label: 'Drivetrain type',
        type: 'enum',
        options: layoutOptions,
        default: 'mecanum',
        rebuild: true,
        help: 'Mecanum and X-drive can strafe; tank cannot. Tank has ~30% more forward grip because its wheels put force straight down the robot rather than along a 45 degree roller.',
      },
      {
        path: 'drivetrain.wheelbase',
        label: 'Wheelbase',
        type: 'number',
        default: 0.3239,
        min: 0.08,
        max: 0.44,
        step: 0.001,
        unit: 'm',
        display: 'in',
        rebuild: true,
        help: 'Front axle to rear axle. A longer wheelbase resists spinning out but turns more reluctantly.',
      },
      {
        path: 'drivetrain.trackWidth',
        label: 'Track width',
        type: 'number',
        default: 0.3556,
        min: 0.08,
        max: 0.44,
        step: 0.001,
        unit: 'm',
        display: 'in',
        rebuild: true,
        help: 'Left wheel centre to right wheel centre. Wider is more stable against tipping and gives more turning leverage.',
      },
      {
        path: 'drivetrain.wheelRadius',
        label: 'Wheel radius',
        type: 'number',
        default: 0.048,
        min: 0.02,
        max: 0.09,
        step: 0.0005,
        unit: 'm',
        display: 'mm',
        rebuild: true,
        help: '48 mm = a 96 mm goBILDA mecanum wheel. Bigger wheels raise top speed and lower acceleration for the same gearing.',
      },
      {
        path: 'drivetrain.wheelMass',
        label: 'Wheel mass',
        type: 'number',
        default: 0.32,
        min: 0.05,
        max: 1.2,
        step: 0.01,
        unit: 'kg',
        display: 'kg',
        advanced: true,
        rebuild: true,
        help: 'Sets how much of the motor torque is spent spinning the wheel up rather than moving the robot. Usually small next to the reflected rotor inertia.',
      },
      {
        path: 'drivetrain.rollerAngle',
        label: 'Mecanum roller angle',
        type: 'number',
        default: 45 * DEG,
        min: 20 * DEG,
        max: 70 * DEG,
        step: DEG,
        unit: 'rad',
        display: 'deg',
        advanced: true,
        rebuild: true,
        help: 'Standard mecanum wheels use 45 degrees. Lower angles trade strafing authority for forward grip.',
      },
    ],
  },

  {
    id: 'chassis',
    label: 'Chassis & mass',
    description:
      'Mass properties. These decide how the robot accelerates, how quickly it rotates, and how much weight transfers off the front wheels when the driver slams forward.',
    params: [
      {
        path: 'chassis.mass',
        label: 'Robot mass',
        type: 'number',
        default: 15,
        min: 3,
        max: 30,
        step: 0.1,
        unit: 'kg',
        display: 'kg',
        help: 'Total mass including battery and mechanisms. The FTC limit is 42 lb (19.05 kg); a drivetrain-only chassis is usually 8-12 kg.',
      },
      {
        path: 'chassis.length',
        label: 'Frame length',
        type: 'number',
        default: 0.4318,
        min: 0.15,
        max: 0.46,
        step: 0.001,
        unit: 'm',
        display: 'in',
        help: 'Used for collisions and for the default moment of inertia. 17 in leaves a little room inside the 18 in sizing cube.',
      },
      {
        path: 'chassis.width',
        label: 'Frame width',
        type: 'number',
        default: 0.4064,
        min: 0.15,
        max: 0.46,
        step: 0.001,
        unit: 'm',
        display: 'in',
        help: 'Outside width across the side plates.',
      },
      {
        path: 'chassis.height',
        label: 'Frame height',
        type: 'number',
        default: 0.18,
        min: 0.05,
        max: 0.46,
        step: 0.005,
        unit: 'm',
        display: 'in',
        help: 'Visual only for now; a future mechanism model will use it.',
      },
      {
        path: 'chassis.autoInertia',
        label: 'Auto moment of inertia',
        type: 'boolean',
        default: true,
        help: 'Estimates rotational inertia from mass and frame size as a uniform slab, then applies the concentration factor below.',
      },
      {
        path: 'chassis.inertiaFactor',
        label: 'Inertia concentration factor',
        type: 'number',
        default: 1.25,
        min: 0.6,
        max: 2.5,
        step: 0.01,
        advanced: true,
        help: 'Real robots carry mass at the perimeter (motors, plates, battery), so their rotational inertia runs 10-40% above a uniform slab. Raise this if the simulated robot spins up faster than yours.',
      },
      {
        path: 'chassis.momentOfInertia',
        label: 'Moment of inertia (manual)',
        type: 'number',
        default: 0.4,
        min: 0.05,
        max: 3,
        step: 0.01,
        unit: 'kg*m^2',
        advanced: true,
        help: 'Used only when auto is off. Measure it by timing your robot through a known rotation at known power.',
      },
      {
        path: 'chassis.cgHeight',
        label: 'CG height',
        type: 'number',
        default: 0.12,
        min: 0.02,
        max: 0.45,
        step: 0.005,
        unit: 'm',
        display: 'in',
        help: 'Height of the centre of gravity above the tiles. This alone controls how much weight transfers under acceleration, and how easily the robot tips when it hits a wall sideways.',
      },
      {
        path: 'chassis.cgOffsetX',
        label: 'CG offset (forward)',
        type: 'number',
        default: 0,
        min: -0.15,
        max: 0.15,
        step: 0.002,
        unit: 'm',
        display: 'in',
        help: 'Positive moves the CG toward the front. A nose-heavy robot pushes harder but has less rear grip when accelerating.',
      },
      {
        path: 'chassis.cgOffsetY',
        label: 'CG offset (left)',
        type: 'number',
        default: 0,
        min: -0.15,
        max: 0.15,
        step: 0.002,
        unit: 'm',
        display: 'in',
        help: 'Positive moves the CG to the robot\'s left. An off-centre battery makes the robot pull to one side at full power.',
      },
      {
        path: 'chassis.weightTransferFactor',
        label: 'Weight transfer factor',
        type: 'number',
        default: 1,
        min: 0,
        max: 1.5,
        step: 0.01,
        advanced: true,
        help: '1 is the rigid-body answer. Lower it to approximate a chassis that flexes, which spreads transfer out over time. Set to 0 to switch weight transfer off entirely and see how much it was affecting you.',
      },
    ],
  },

  {
    id: 'motor',
    label: 'Motors & gearing',
    description:
      'Motor curve and drivetrain reduction. Defaults describe a goBILDA Yellow Jacket at 19.2:1, the 312 RPM part that most mecanum chassis use.',
    params: [
      {
        path: 'motor.preset',
        label: 'Motor preset',
        type: 'enum',
        options: motorOptions,
        default: DEFAULT_MOTOR_ID,
        rebuild: true,
        help: 'Loads catalogue figures into the fields below. Editing any field afterwards is fine and is encouraged if you have measured your own motors.',
      },
      {
        path: 'motor.gearRatio',
        label: 'Gearbox ratio',
        type: 'number',
        default: 19.2,
        min: 1,
        max: 200,
        step: 0.1,
        rebuild: true,
        help: 'Motor revolutions per output revolution. Common goBILDA options: ' +
          gearboxOptions.map((g) => g.label).join(', ') + '.',
      },
      {
        path: 'motor.externalRatio',
        label: 'External reduction',
        type: 'number',
        default: 1,
        min: 0.2,
        max: 5,
        step: 0.01,
        advanced: true,
        rebuild: true,
        help: 'Any extra chain, belt or gear stage between the gearbox and the wheel. 1 for a direct-drive parallel-plate chassis.',
      },
      {
        path: 'motor.efficiency',
        label: 'Drivetrain efficiency',
        type: 'number',
        default: 0.8,
        min: 0.3,
        max: 1,
        step: 0.01,
        help: 'Fraction of motor torque that reaches the wheel. A multi-stage planetary plus a chain run is realistically 0.70-0.85. Assuming 1.0 is the most common reason a simulated robot out-accelerates the real one.',
      },
      {
        path: 'motor.freeSpeedRpm',
        label: 'Free speed (bare motor)',
        type: 'number',
        default: 6000,
        min: 1000,
        max: 20000,
        step: 10,
        suffix: 'rpm',
        advanced: true,
        rebuild: true,
        help: 'Motor shaft speed with no load at 12 V, before the gearbox.',
      },
      {
        path: 'motor.stallTorque',
        label: 'Stall torque (bare motor)',
        type: 'number',
        default: 0.126,
        min: 0.005,
        max: 1,
        step: 0.001,
        unit: 'N*m',
        advanced: true,
        rebuild: true,
        help: 'Torque at zero speed and 12 V, before the gearbox.',
      },
      {
        path: 'motor.stallCurrent',
        label: 'Stall current',
        type: 'number',
        default: 9.2,
        min: 1,
        max: 40,
        step: 0.1,
        unit: 'A',
        advanced: true,
        rebuild: true,
        help: 'Current at zero speed and 12 V. Sets the winding resistance, so it drives how hard the battery sags.',
      },
      {
        path: 'motor.freeCurrent',
        label: 'Free current',
        type: 'number',
        default: 0.25,
        min: 0,
        max: 5,
        step: 0.01,
        unit: 'A',
        advanced: true,
        rebuild: true,
        help: 'No-load current: the motor\'s own internal friction.',
      },
      {
        path: 'motor.ticksPerRev',
        label: 'Encoder ticks / motor rev',
        type: 'number',
        default: 28,
        min: 1,
        max: 4096,
        step: 1,
        advanced: true,
        rebuild: true,
        help: '28 for goBILDA, REV HD Hex and NeveRest motors (7 pulses in quadrature).',
      },
      {
        path: 'motor.rotorInertia',
        label: 'Rotor inertia',
        type: 'number',
        default: 7e-6,
        min: 1e-6,
        max: 1e-4,
        step: 1e-6,
        unit: 'kg*m^2',
        advanced: true,
        rebuild: true,
        help: 'Reflected through the gearbox this is multiplied by the ratio squared, so at 19.2:1 it adds around 5 kg of apparent mass to a 15 kg robot. No FTC vendor publishes it, so the default is a geometric estimate -- this is the knob to turn if the simulator accelerates differently from your real robot.',
      },
      {
        path: 'motor.staticFrictionTorque',
        label: 'Breakaway torque',
        type: 'number',
        default: 0.05,
        min: 0,
        max: 0.6,
        step: 0.005,
        unit: 'N*m',
        advanced: true,
        help: 'Torque needed at the wheel before the drivetrain moves at all. This is what you feel pushing a powered-off robot.',
      },
      {
        path: 'motor.viscousFriction',
        label: 'Viscous friction',
        type: 'number',
        default: 0.004,
        min: 0,
        max: 0.1,
        step: 0.0005,
        unit: 'N*m/(rad/s)',
        advanced: true,
        help: 'Speed-proportional drag in the gearbox and bearings.',
      },
    ],
  },

  {
    id: 'battery',
    label: 'Battery',
    description:
      'A 12 V FTC pack with real internal resistance. Motor current sags the bus, and because both speed and torque scale with voltage the robot gets slower and weaker exactly when it is working hardest.',
    params: [
      {
        path: 'battery.enabled',
        label: 'Simulate voltage sag',
        type: 'boolean',
        default: true,
        help: 'Turn off to hold the bus at a fixed voltage. Useful for isolating whether a handling problem is electrical or mechanical.',
      },
      {
        path: 'battery.openCircuitVoltage',
        label: 'Resting voltage (full)',
        type: 'number',
        default: 13.0,
        min: 9,
        max: 14,
        step: 0.05,
        unit: 'V',
        help: 'A freshly charged FTC pack sits a little above 13 V.',
      },
      {
        path: 'battery.internalResistance',
        label: 'Internal resistance',
        type: 'number',
        default: 0.03,
        min: 0.005,
        max: 0.2,
        step: 0.001,
        unit: 'ohm',
        help: 'The main knob for pack health. A new pack is around 0.02 ohm; a well-used one can be 0.05 or worse, which is several volts of sag at full current.',
      },
      {
        path: 'battery.startingStateOfCharge',
        label: 'Starting charge',
        type: 'number',
        default: 1,
        min: 0.05,
        max: 1,
        step: 0.01,
        help: 'Start a session part-drained to rehearse the last match of the day, when the pack is tired and the robot handles differently.',
      },
      {
        path: 'battery.capacityAmpHours',
        label: 'Pack capacity',
        type: 'number',
        default: 3,
        min: 0.5,
        max: 6,
        step: 0.1,
        unit: 'Ah',
        advanced: true,
        help: 'Standard FTC NiMH packs are 3000 mAh.',
      },
      {
        path: 'battery.baseLoadAmps',
        label: 'Base electrical load',
        type: 'number',
        default: 1.2,
        min: 0,
        max: 10,
        step: 0.1,
        unit: 'A',
        advanced: true,
        help: 'Control Hub, servos and sensors draw current before the drive motors do.',
      },
      {
        path: 'battery.nominalVoltage',
        label: 'Motor rating voltage',
        type: 'number',
        default: 12,
        min: 6,
        max: 24,
        step: 0.5,
        unit: 'V',
        advanced: true,
        rebuild: true,
        help: 'The voltage the motor catalogue figures were measured at. Leave at 12 for FTC.',
      },
    ],
  },

  {
    id: 'control',
    label: 'Control Hub',
    description:
      'How commands become motor output. Run mode and loop timing change the feel of the robot more than most teams expect.',
    params: [
      {
        path: 'control.runMode',
        label: 'Run mode',
        type: 'enum',
        options: [
          { value: 'RUN_WITHOUT_ENCODER', label: 'RUN_WITHOUT_ENCODER (open loop)' },
          { value: 'RUN_USING_ENCODER', label: 'RUN_USING_ENCODER (velocity PID)' },
        ],
        default: 'RUN_WITHOUT_ENCODER',
        help: 'Open loop sends the stick value straight out as duty cycle, so speed depends on battery and load. Velocity PID holds a commanded speed regardless, which tracks straighter but responds a touch more slowly.',
      },
      {
        path: 'control.zeroPowerBehavior',
        label: 'Zero power behavior',
        type: 'enum',
        options: [
          { value: 'BRAKE', label: 'BRAKE (shorted, resists motion)' },
          { value: 'FLOAT', label: 'FLOAT (open circuit, coasts)' },
        ],
        default: 'BRAKE',
        help: 'BRAKE shorts the motor so back-EMF stops the robot near where you release the stick. FLOAT lets it coast, which feels smoother but overshoots.',
      },
      {
        path: 'control.currentLimit',
        label: 'Per-motor current limit',
        type: 'number',
        default: 20,
        min: 2,
        max: 40,
        step: 0.5,
        unit: 'A',
        help: 'The REV Control Hub limits each port to 20 A. Lowering it reduces battery sag at the cost of acceleration.',
      },
      {
        path: 'control.loopRateHz',
        label: 'Op-mode loop rate',
        type: 'number',
        default: 50,
        min: 5,
        max: 200,
        step: 1,
        unit: 'Hz',
        help: 'How often your op-mode gets to change motor commands. A typical FTC loop runs 30-60 Hz, and the robot cannot react faster than this no matter how quick the driver is.',
      },
      {
        path: 'control.inputLatencyMs',
        label: 'Input latency',
        type: 'number',
        default: 40,
        min: 0,
        max: 200,
        step: 1,
        suffix: 'ms',
        help: 'Gamepad poll, Driver Station, wifi, then the next loop cycle. Around 40 ms is realistic, and it is a large part of why a real robot feels less immediate than a naive simulator.',
      },
      {
        path: 'control.kP',
        label: 'Velocity kP',
        type: 'number',
        default: 1.5,
        min: 0,
        max: 20,
        step: 0.05,
        advanced: true,
        help: 'Gains are normalised: 1.0 means a full-scale velocity error commands full duty. Only used in RUN_USING_ENCODER.',
      },
      { path: 'control.kI', label: 'Velocity kI', type: 'number', default: 2.0, min: 0, max: 50, step: 0.1, advanced: true },
      { path: 'control.kD', label: 'Velocity kD', type: 'number', default: 0, min: 0, max: 5, step: 0.01, advanced: true },
      {
        path: 'control.kF',
        label: 'Velocity kF',
        type: 'number',
        default: 1.0,
        min: 0,
        max: 3,
        step: 0.01,
        advanced: true,
        help: 'Feedforward. 1.0 is the correct value for an ideal motor: full duty produces full speed.',
      },
      {
        path: 'control.encoderFilterHz',
        label: 'Encoder velocity filter',
        type: 'number',
        default: 20,
        min: 1,
        max: 200,
        step: 1,
        unit: 'Hz',
        advanced: true,
        help: 'Velocity is a difference of quantised tick counts, so it is far noisier than position. Lower cutoffs give a smoother signal at the cost of lag in the velocity loop.',
      },
      {
        path: 'control.quantiseEncoders',
        label: 'Quantise encoder counts',
        type: 'boolean',
        default: true,
        advanced: true,
        help: 'Round encoder readings to whole ticks, as real hardware does. Turn off to see how much of your velocity noise comes from quantisation.',
      },
    ],
  },

  {
    id: 'surface',
    label: 'Tiles & friction',
    description:
      'The contact model between wheels and the field. These are the numbers that decide whether the robot digs in or spins its wheels.',
    params: [
      {
        path: 'surface.model',
        label: 'Friction model',
        type: 'enum',
        options: [
          { value: 'pacejka', label: 'Pacejka (peak then slide)' },
          { value: 'tanh', label: 'Smooth saturating' },
          { value: 'linear', label: 'Linear saturating' },
        ],
        default: 'pacejka',
        help: 'Pacejka reproduces the drop from static to sliding grip, so breaking the wheels loose actually costs you. The other two saturate smoothly with no peak and are more forgiving numerically.',
      },
      {
        path: 'surface.muLongitudinal',
        label: 'Grip, rolling direction',
        type: 'number',
        default: 1.05,
        min: 0.1,
        max: 2,
        step: 0.01,
        help: 'Peak friction coefficient along the direction the wheel rolls. Rubber tread on clean FTC foam tiles is roughly 1.0-1.2; dusty tiles are noticeably less.',
      },
      {
        path: 'surface.muLateral',
        label: 'Grip, sideways',
        type: 'number',
        default: 1.0,
        min: 0.1,
        max: 2,
        step: 0.01,
        help: 'Peak friction across the wheel. Only affects traction wheels; roller wheels are free in their roller direction by construction.',
      },
      {
        path: 'surface.slipAtPeakGrip',
        label: 'Slip at peak grip',
        type: 'number',
        default: 0.15,
        min: 0.01,
        max: 1,
        step: 0.005,
        unit: 'm/s',
        advanced: true,
        help: 'How much sliding it takes to develop full grip. Smaller values make contact stiffer and the robot more responsive, but need a higher substep rate to stay stable.',
      },
      {
        path: 'surface.peakSlipRatio',
        label: 'Peak slip ratio',
        type: 'number',
        default: 0.12,
        min: 0,
        max: 0.5,
        step: 0.005,
        advanced: true,
        help: 'Above walking pace, peak grip moves to this fraction of rolling speed, which is how real tyres behave. Set to 0 for a pure slip-velocity model.',
      },
      {
        path: 'surface.kineticRatio',
        label: 'Sliding / peak grip',
        type: 'number',
        default: 0.8,
        min: 0.3,
        max: 0.99,
        step: 0.01,
        help: 'How much grip is left once a wheel has broken loose. 0.8 means spinning wheels give you 20% less force than wheels on the edge of grip, which is why easing into the throttle beats mashing it.',
      },
      {
        path: 'surface.curvature',
        label: 'Friction curve shape',
        type: 'number',
        default: 0.95,
        min: -1,
        max: 0.99,
        step: 0.01,
        advanced: true,
        help: 'Pacejka E. Shapes how sharply grip builds before the peak.',
      },
      {
        path: 'surface.rollingResistance',
        label: 'Rolling resistance',
        type: 'number',
        default: 0.02,
        min: 0,
        max: 0.15,
        step: 0.001,
        help: 'Deformation loss of the wheel in the foam, as a fraction of the load it carries. Foam tiles are much higher than a hard floor, which is why a robot coasts to a stop so quickly.',
      },
      {
        path: 'surface.rollerDrag',
        label: 'Roller drag (mecanum/omni)',
        type: 'number',
        default: 0.09,
        min: 0,
        max: 0.4,
        step: 0.005,
        help: 'Bearing friction and foam scrub along a roller\'s free direction. This is what makes strafing measurably slower and less efficient than driving straight.',
      },
    ],
  },

  {
    id: 'driver',
    label: 'Driver controls',
    description:
      'Everything between the stick and the drivetrain command. This is where most of the "feel" of a robot is decided, and the cheapest thing to experiment with.',
    params: [
      {
        path: 'driver.scheme',
        label: 'Drive scheme',
        type: 'enum',
        options: [
          { value: 'robotCentric', label: 'Robot centric (holonomic)' },
          { value: 'fieldCentric', label: 'Field centric (holonomic)' },
          { value: 'tank', label: 'Tank (two sticks)' },
          { value: 'arcade', label: 'Arcade (one stick)' },
          { value: 'splitArcade', label: 'Split arcade (throttle/turn separate)' },
        ],
        default: 'robotCentric',
        help: 'Robot centric means forward is wherever the robot is pointing. Field centric means forward is always away from the driver station, using the IMU.',
      },
      {
        path: 'driver.deadband',
        label: 'Stick deadband',
        type: 'number',
        default: 0.05,
        min: 0,
        max: 0.4,
        step: 0.005,
        help: 'Ignores small stick offsets so a worn controller does not creep. Values outside the band are rescaled so there is no jump at the edge.',
      },
      {
        path: 'driver.exponent',
        label: 'Response curve exponent',
        type: 'number',
        default: 2,
        min: 1,
        max: 4,
        step: 0.1,
        help: '1 is linear. 2 or 3 gives fine control near centre and full power at the ends, which most drivers prefer for precise alignment.',
      },
      {
        path: 'driver.curveBlend',
        label: 'Curve blend',
        type: 'number',
        default: 0.7,
        min: 0,
        max: 1,
        step: 0.01,
        help: 'Mixes between linear (0) and the full exponent curve (1). Around 0.7 keeps low-speed precision without feeling dead off centre.',
      },
      {
        path: 'driver.driveScale',
        label: 'Forward power limit',
        type: 'number',
        default: 1,
        min: 0.1,
        max: 1,
        step: 0.01,
        help: 'Caps forward/back power.',
      },
      {
        path: 'driver.strafeScale',
        label: 'Strafe power limit',
        type: 'number',
        default: 1,
        min: 0.1,
        max: 1.5,
        step: 0.01,
        help: 'Many teams push this above 1 to compensate for mecanum strafing being slower, then desaturation scales everything back down.',
      },
      {
        path: 'driver.turnScale',
        label: 'Turn power limit',
        type: 'number',
        default: 0.8,
        min: 0.1,
        max: 1,
        step: 0.01,
        help: 'Turning is usually the easiest axis to overdrive. Reducing it is the fastest fix for a robot that feels twitchy.',
      },
      {
        path: 'driver.slowModeFactor',
        label: 'Precision mode factor',
        type: 'number',
        default: 0.35,
        min: 0.05,
        max: 1,
        step: 0.01,
        help: 'Multiplier while the precision trigger is held. Used for scoring alignment.',
      },
      {
        path: 'driver.slewRate',
        label: 'Acceleration ramp',
        type: 'number',
        default: 6,
        min: 0.5,
        max: 60,
        step: 0.1,
        unit: '1/s',
        help: 'How fast commanded power may rise, in full-scale units per second. 6 means zero to full in about 170 ms. Lower values stop the driver from breaking the wheels loose, at the cost of responsiveness. Set high to disable.',
      },
      {
        path: 'driver.slewRateDown',
        label: 'Deceleration ramp',
        type: 'number',
        default: 30,
        min: 0.5,
        max: 100,
        step: 0.5,
        advanced: true,
        help: 'Separate ramp for reducing power. Keeping this fast means the robot still stops promptly even with a gentle acceleration ramp.',
      },
      {
        path: 'driver.turnSlewRate',
        label: 'Turn ramp',
        type: 'number',
        default: 10,
        min: 0.5,
        max: 100,
        step: 0.5,
        advanced: true,
        help: 'Separate ramp for the rotation axis.',
      },
      {
        path: 'driver.headingLockEnabled',
        label: 'Heading hold',
        type: 'boolean',
        default: false,
        help: 'When the driver is not commanding a turn, hold the current heading with a PD loop on the IMU. Stops the robot from being knocked off course, and makes strafing track straight.',
      },
      {
        path: 'driver.headingLockP',
        label: 'Heading hold kP',
        type: 'number',
        default: 2.5,
        min: 0,
        max: 20,
        step: 0.1,
        advanced: true,
      },
      {
        path: 'driver.headingLockD',
        label: 'Heading hold kD',
        type: 'number',
        default: 0.15,
        min: 0,
        max: 3,
        step: 0.01,
        advanced: true,
      },
      {
        path: 'driver.invertDrive',
        label: 'Invert forward axis',
        type: 'boolean',
        default: false,
        advanced: true,
      },
      {
        path: 'driver.invertTurn',
        label: 'Invert turn axis',
        type: 'boolean',
        default: false,
        advanced: true,
      },
    ],
  },

  {
    id: 'imu',
    label: 'IMU',
    description:
      'The heading sensor field-centric driving depends on. Its imperfections are modelled because they are the usual reason field-centric "stops working" mid-match.',
    params: [
      { path: 'imu.enabled', label: 'Simulate IMU error', type: 'boolean', default: true, help: 'Off gives a perfect heading, which is useful for telling an IMU problem apart from a driving problem.' },
      {
        path: 'imu.driftRateDegPerSec',
        label: 'Drift rate',
        type: 'number',
        default: 0.05,
        min: 0,
        max: 2,
        step: 0.01,
        suffix: 'deg/s',
        help: 'Accumulating bias. At 0.05 deg/s the heading is off by more than 7 degrees by the end of a two and a half minute match, which is enough to notice when strafing.',
      },
      { path: 'imu.noiseDeg', label: 'Angle noise', type: 'number', default: 0.05, min: 0, max: 2, step: 0.01, suffix: 'deg', advanced: true },
      { path: 'imu.latencySeconds', label: 'Read latency', type: 'number', default: 0.005, min: 0, max: 0.1, step: 0.001, unit: 's', advanced: true, help: 'I2C read delay inside the hub.' },
    ],
  },

  {
    id: 'field',
    label: 'Field',
    description: 'The 12 ft by 12 ft FTC field: foam tiles and a perimeter wall.',
    params: [
      {
        path: 'field.size',
        label: 'Field size',
        type: 'number',
        default: 144 * INCH,
        min: 60 * INCH,
        max: 200 * INCH,
        step: INCH,
        unit: 'm',
        display: 'in',
        help: 'Inside dimension of the perimeter. A competition field is 12 ft (144 in).',
      },
      {
        path: 'field.wallRestitution',
        label: 'Wall bounce',
        type: 'number',
        default: 0.15,
        min: 0,
        max: 0.8,
        step: 0.01,
        help: 'How much speed is returned on impact. FTC field walls are fairly dead; a robot mostly stops rather than bouncing.',
      },
      {
        path: 'field.wallFriction',
        label: 'Wall friction',
        type: 'number',
        default: 0.4,
        min: 0,
        max: 1.5,
        step: 0.01,
        help: 'Sliding friction along the wall. High values make a robot pinned against the wall hard to slide along it.',
      },
      {
        path: 'field.collisionsEnabled',
        label: 'Wall collisions',
        type: 'boolean',
        default: true,
      },
    ],
  },

  {
    id: 'sim',
    label: 'Simulation',
    description:
      'Solver settings. The defaults are chosen so the contact model stays stable; lower the substep rate only if you need the performance.',
    params: [
      {
        path: 'sim.substepHz',
        label: 'Physics substep rate',
        type: 'number',
        default: 2000,
        min: 250,
        max: 8000,
        step: 50,
        unit: 'Hz',
        help: 'Wheel contact is by far the stiffest part of the simulation. Too low and the robot jitters or the wheels oscillate; 2000 Hz is comfortable and costs very little.',
      },
      {
        path: 'sim.timeScale',
        label: 'Time scale',
        type: 'number',
        default: 1,
        min: 0.1,
        max: 2,
        step: 0.05,
        help: 'Slow motion for studying a manoeuvre, or to practise a sequence before running it at full speed.',
      },
      {
        path: 'sim.maxFrameSeconds',
        label: 'Max frame step',
        type: 'number',
        default: 0.05,
        min: 0.01,
        max: 0.25,
        step: 0.005,
        unit: 's',
        advanced: true,
        help: 'Caps how much simulated time one rendered frame may advance, so a stall in the browser cannot make the robot teleport.',
      },
    ],
  },

  {
    id: 'view',
    label: 'View & overlays',
    description: 'Camera and debug rendering. None of this affects the physics.',
    params: [
      {
        path: 'view.camera',
        label: 'Camera',
        type: 'enum',
        options: [
          { value: 'driverStation', label: 'Driver station (match view)' },
          { value: 'chase', label: 'Chase' },
          { value: 'overhead', label: 'Overhead' },
          { value: 'orbit', label: 'Free orbit' },
        ],
        default: 'driverStation',
        help: 'Driver station is the view you actually have in a match: low, from one side, with the far end of the field hard to judge.',
      },
      { path: 'view.showForceVectors', label: 'Wheel force vectors', type: 'boolean', default: true, help: 'Green is grip in reserve, red means that wheel is at the limit and sliding.' },
      { path: 'view.showSlip', label: 'Slip markers', type: 'boolean', default: true },
      { path: 'view.showTrail', label: 'Path trail', type: 'boolean', default: true },
      { path: 'view.showLoads', label: 'Wheel load rings', type: 'boolean', default: false, help: 'Ring size shows how much weight each wheel is carrying right now.' },
      { path: 'view.showHud', label: 'Telemetry HUD', type: 'boolean', default: true },
      { path: 'view.showGraphs', label: 'Telemetry graphs', type: 'boolean', default: true },
      { path: 'view.trailSeconds', label: 'Trail length', type: 'number', default: 6, min: 1, max: 30, step: 1, unit: 's', advanced: true },
    ],
  },
];

/** Flat list of every parameter, for lookups. */
export const ALL_PARAMS = SCHEMA.flatMap((g) => g.params);

/** @type {Map<string, ParamDef>} */
export const PARAM_BY_PATH = new Map(ALL_PARAMS.map((p) => [p.path, p]));

/**
 * Build the nested defaults object from the schema.
 * @returns {SimConfig}
 */
export function defaultConfig() {
  /** @type {any} */
  const out = {};
  for (const param of ALL_PARAMS) {
    const parts = param.path.split('.');
    let node = out;
    for (let i = 0; i < parts.length - 1; i++) {
      node[parts[i]] ??= {};
      node = node[parts[i]];
    }
    node[parts[parts.length - 1]] = param.default;
  }
  // Values not exposed as tunables but needed by the model.
  out.motor.name = MOTOR_PRESETS[DEFAULT_MOTOR_ID].name;
  return out;
}

/**
 * The shape produced by `defaultConfig`. Declared loosely on purpose: the
 * schema is the authority, and this typedef exists so editors can autocomplete.
 * @typedef {ReturnType<typeof defaultConfig> & Record<string, any>} SimConfig
 */
