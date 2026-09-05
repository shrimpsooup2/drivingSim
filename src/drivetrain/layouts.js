import { Vec2 } from '../math/Vec2.js';
import { Wheel } from '../physics/Wheel.js';
import { DEG } from '../math/MathUtil.js';

/** @typedef {'mecanum'|'tank'|'tank6'|'omni'|'xdrive'} DrivetrainType */

/**
 * Wheel layout builders.
 *
 * Every FTC drivetrain worth simulating is a set of wheels at known positions
 * with known rolling and roller angles, so each builder just places wheels and
 * lets the shared physics and kinematics do the rest.
 *
 * Body frame convention (matching the FTC field coordinate system):
 *   +x forward, +y to the robot's left, heading counter-clockwise positive.
 *
 * @module
 */

/**
 * @typedef {object} LayoutOptions
 * @property {number} wheelbase   m, front axle to rear axle
 * @property {number} trackWidth  m, left wheel centre to right wheel centre
 * @property {number} wheelRadius m
 * @property {number} rollerAngle rad, magnitude of the mecanum roller angle
 * @property {number} rotationalInertia kg*m^2 per wheel, including reflected rotor inertia
 * @property {number} rollingResistance
 * @property {number} rollerDrag
 */

/**
 * Standard four-wheel mecanum, the default parallel-plate FTC drivetrain.
 *
 * Roller angles alternate in the classic X pattern seen from above:
 * front-left and back-right at -45 degrees, front-right and back-left at +45.
 * Get this pattern wrong and the robot strafes when you ask it to turn, which
 * is the single most common mecanum wiring/assembly mistake.
 *
 * @param {LayoutOptions} o
 * @returns {Wheel[]}
 */
export function mecanumLayout(o) {
  const lx = o.wheelbase / 2;
  const ly = o.trackWidth / 2;
  const g = o.rollerAngle;
  const common = {
    kind: /** @type {const} */ ('mecanum'),
    radius: o.wheelRadius,
    rotationalInertia: o.rotationalInertia,
    rollingResistance: o.rollingResistance,
    rollerDrag: o.rollerDrag,
    steerAngle: 0,
  };
  return [
    new Wheel({ ...common, name: 'frontLeft', position: new Vec2(lx, ly), rollerAngle: -g }),
    new Wheel({ ...common, name: 'frontRight', position: new Vec2(lx, -ly), rollerAngle: g }),
    new Wheel({ ...common, name: 'backLeft', position: new Vec2(-lx, ly), rollerAngle: g }),
    new Wheel({ ...common, name: 'backRight', position: new Vec2(-lx, -ly), rollerAngle: -g }),
  ];
}

/**
 * Four-wheel tank (skid steer) with traction wheels.
 *
 * Turning requires the wheels to scrub sideways across the tiles, so a tank
 * robot fights its own lateral grip every time it rotates. That scrub is
 * exactly what the wheel model's lateral friction channel produces, which is
 * why a long-wheelbase tank robot turns reluctantly while a square one spins
 * freely.
 *
 * @param {LayoutOptions} o
 */
export function tankLayout(o) {
  const lx = o.wheelbase / 2;
  const ly = o.trackWidth / 2;
  const common = {
    kind: /** @type {const} */ ('traction'),
    radius: o.wheelRadius,
    rotationalInertia: o.rotationalInertia,
    rollingResistance: o.rollingResistance,
    rollerDrag: 0,
    steerAngle: 0,
    rollerAngle: 0,
  };
  return [
    new Wheel({ ...common, name: 'frontLeft', position: new Vec2(lx, ly) }),
    new Wheel({ ...common, name: 'frontRight', position: new Vec2(lx, -ly) }),
    new Wheel({ ...common, name: 'backLeft', position: new Vec2(-lx, ly) }),
    new Wheel({ ...common, name: 'backRight', position: new Vec2(-lx, -ly) }),
  ];
}

/**
 * Six-wheel tank with a dropped centre axle.
 *
 * The centre wheels sit slightly lower, so the robot pivots about them and the
 * end wheels carry less load. That is modelled here by placing all six on the
 * ground and letting the load solver hand the centre pair the larger share via
 * `centreLoadBias`, which is the practical effect of the drop.
 *
 * @param {LayoutOptions & {centreLoadBias?: number}} o
 */
export function tank6Layout(o) {
  const lx = o.wheelbase / 2;
  const ly = o.trackWidth / 2;
  const common = {
    kind: /** @type {const} */ ('traction'),
    radius: o.wheelRadius,
    rotationalInertia: o.rotationalInertia,
    rollingResistance: o.rollingResistance,
    rollerDrag: 0,
    steerAngle: 0,
    rollerAngle: 0,
  };
  return [
    new Wheel({ ...common, name: 'frontLeft', position: new Vec2(lx, ly) }),
    new Wheel({ ...common, name: 'frontRight', position: new Vec2(lx, -ly) }),
    new Wheel({ ...common, name: 'midLeft', position: new Vec2(0, ly) }),
    new Wheel({ ...common, name: 'midRight', position: new Vec2(0, -ly) }),
    new Wheel({ ...common, name: 'backLeft', position: new Vec2(-lx, ly) }),
    new Wheel({ ...common, name: 'backRight', position: new Vec2(-lx, -ly) }),
  ];
}

/**
 * Four omni wheels in a plus configuration: two rolling fore-aft, two rolling
 * side to side. Holonomic like mecanum but with no roller-angle penalty on
 * grip, at the cost of having only half the wheels driving in any one
 * direction.
 *
 * @param {LayoutOptions} o
 */
export function omniLayout(o) {
  const lx = o.wheelbase / 2;
  const ly = o.trackWidth / 2;
  const common = {
    kind: /** @type {const} */ ('omni'),
    radius: o.wheelRadius,
    rotationalInertia: o.rotationalInertia,
    rollingResistance: o.rollingResistance,
    rollerDrag: o.rollerDrag,
    rollerAngle: 0,
  };
  return [
    new Wheel({ ...common, name: 'front', position: new Vec2(lx, 0), steerAngle: 90 * DEG }),
    new Wheel({ ...common, name: 'back', position: new Vec2(-lx, 0), steerAngle: 90 * DEG }),
    new Wheel({ ...common, name: 'left', position: new Vec2(0, ly), steerAngle: 0 }),
    new Wheel({ ...common, name: 'right', position: new Vec2(0, -ly), steerAngle: 0 }),
  ];
}

/**
 * X-drive: four omni wheels at the corners, each rolling at 45 degrees.
 * All four wheels contribute to every direction of travel, so it accelerates
 * harder than a plus-omni layout, and unlike mecanum it keeps full grip.
 *
 * The rolling directions must be **tangential** to a circle about the centre
 * (45, 135, 225 and 315 degrees), not radial. Get this backwards and every
 * wheel's moment arm collapses to `(lx - ly)/sqrt(2)`, which for a roughly
 * square chassis is nearly zero -- the robot translates fine and then barely
 * turns at all. Laid out correctly, all four wheels share the same moment arm
 * of `(lx + ly)/sqrt(2)`.
 *
 * One consequence worth knowing before you wire one up: driving straight
 * forward runs the left and right wheels in opposite directions, because their
 * rolling axes point different ways. That is correct, not a wiring mistake.
 *
 * @param {LayoutOptions} o
 */
export function xDriveLayout(o) {
  const lx = o.wheelbase / 2;
  const ly = o.trackWidth / 2;
  const common = {
    kind: /** @type {const} */ ('omni'),
    radius: o.wheelRadius,
    rotationalInertia: o.rotationalInertia,
    rollingResistance: o.rollingResistance,
    rollerDrag: o.rollerDrag,
    rollerAngle: 0,
  };
  return [
    new Wheel({ ...common, name: 'frontLeft', position: new Vec2(lx, ly), steerAngle: 135 * DEG }),
    new Wheel({ ...common, name: 'frontRight', position: new Vec2(lx, -ly), steerAngle: 45 * DEG }),
    new Wheel({ ...common, name: 'backLeft', position: new Vec2(-lx, ly), steerAngle: -135 * DEG }),
    new Wheel({ ...common, name: 'backRight', position: new Vec2(-lx, -ly), steerAngle: -45 * DEG }),
  ];
}

/** @type {Record<DrivetrainType, (o: LayoutOptions) => Wheel[]>} */
export const LAYOUT_BUILDERS = {
  mecanum: mecanumLayout,
  tank: tankLayout,
  tank6: tank6Layout,
  omni: omniLayout,
  xdrive: xDriveLayout,
};

/** Human-readable labels for the drivetrain selector. */
export const LAYOUT_LABELS = {
  mecanum: 'Mecanum (4 wheel)',
  tank: 'Tank / skid steer (4 wheel)',
  tank6: 'Tank, 6 wheel drop centre',
  omni: 'Omni (plus configuration)',
  xdrive: 'X-drive (4 omni at 45 deg)',
};

/**
 * @param {DrivetrainType} type
 * @param {LayoutOptions} options
 */
export function buildLayout(type, options) {
  const builder = LAYOUT_BUILDERS[type] ?? mecanumLayout;
  return builder(options);
}
