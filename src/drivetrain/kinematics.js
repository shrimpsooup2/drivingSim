/**
 * Drivetrain kinematics, derived generically from wheel geometry.
 *
 * Rather than hard-coding the four familiar mecanum equations, every wheel
 * contributes one row to an inverse-kinematics matrix built from its position,
 * steer angle and roller angle. The standard mecanum, tank, omni and X-drive
 * equations all drop out of the same construction, so a new wheel layout needs
 * no new kinematics code.
 *
 * ## Derivation
 *
 * A wheel at body-frame position (x, y), rolling along a direction `theta` from
 * the chassis +x axis, with rollers whose axis sits at `gamma` from that
 * rolling direction, can only transmit force along
 *
 *     p = (cos(theta + gamma), sin(theta + gamma))
 *
 * The rolling constraint along p is `v_contact . p = omega_wheel * R * cos(gamma)`,
 * and the contact velocity of a body-fixed point is
 * `v_contact = (vx - omega*y, vy + omega*x)`. Substituting and solving for the
 * wheel's surface speed gives one linear row:
 *
 *     omega_wheel * R = a*vx + b*vy + c*omega
 *     a = cos(theta+gamma)/cos(gamma)
 *     b = sin(theta+gamma)/cos(gamma)
 *     c = (x*sin(theta+gamma) - y*cos(theta+gamma))/cos(gamma)
 *
 * For a standard mecanum wheel at the front left (gamma = -45 degrees) this
 * reduces to the textbook `vx - vy - omega*(lx+ly)`.
 *
 * @module
 */

import { Twist2d } from '../math/Pose2d.js';

/**
 * @typedef {object} KinematicsRow
 * @property {number} a coefficient on vx
 * @property {number} b coefficient on vy
 * @property {number} c coefficient on omega
 */

/**
 * Build one inverse-kinematics row per wheel.
 * @param {import('../physics/Wheel.js').Wheel[]} wheels
 * @returns {KinematicsRow[]}
 */
export function buildInverseKinematics(wheels) {
  return wheels.map((w) => {
    // Traction wheels have no rollers: the constraint direction is the rolling
    // direction itself, which is the gamma = 0 case.
    const gamma = w.kind === 'traction' ? 0 : w.rollerAngle;
    const cg = Math.cos(gamma);
    // A roller axis perpendicular to the rolling direction could never be
    // driven; guard so a bad config produces zeros rather than infinities.
    if (Math.abs(cg) < 1e-6) return { a: 0, b: 0, c: 0 };
    const ang = w.steerAngle + gamma;
    const ca = Math.cos(ang);
    const sa = Math.sin(ang);
    return {
      a: ca / cg,
      b: sa / cg,
      c: (w.position.x * sa - w.position.y * ca) / cg,
    };
  });
}

/**
 * Chassis velocity -> required wheel surface speeds (m/s).
 * @param {KinematicsRow[]} rows
 * @param {number} vx m/s forward
 * @param {number} vy m/s left
 * @param {number} omega rad/s ccw
 * @param {Float64Array} [out]
 */
export function inverseKinematics(rows, vx, vy, omega, out) {
  const result = out && out.length === rows.length ? out : new Float64Array(rows.length);
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    result[i] = r.a * vx + r.b * vy + r.c * omega;
  }
  return result;
}

/**
 * Wheel surface speeds -> chassis velocity, by least squares.
 *
 * With four wheels and three degrees of freedom the system is overdetermined,
 * so wheel speeds that are not kinematically consistent (which is the normal
 * state of affairs once anything is slipping) get a best fit rather than a
 * contradiction. This is exactly how odometry from drive encoders behaves on a
 * real robot, including its drift.
 *
 * @param {KinematicsRow[]} rows
 * @param {ArrayLike<number>} wheelSpeeds m/s
 * @returns {Twist2d}
 */
export function forwardKinematics(rows, wheelSpeeds) {
  // Normal equations: (M^T M) v = M^T s, a symmetric 3x3 solve.
  let m00 = 0, m01 = 0, m02 = 0, m11 = 0, m12 = 0, m22 = 0;
  let r0 = 0, r1 = 0, r2 = 0;
  for (let i = 0; i < rows.length; i++) {
    const { a, b, c } = rows[i];
    const s = wheelSpeeds[i];
    m00 += a * a; m01 += a * b; m02 += a * c;
    m11 += b * b; m12 += b * c;
    m22 += c * c;
    r0 += a * s; r1 += b * s; r2 += c * s;
  }
  // Regularise relative to the matrix's own scale. An absolute epsilon would
  // bias small-magnitude systems (a narrow chassis, or metres-vs-millimetres)
  // by a visible amount while doing nothing for large ones.
  const eps = 1e-12 * (m00 + m11 + m22) + Number.MIN_VALUE;
  const m = [
    [m00 + eps, m01, m02],
    [m01, m11 + eps, m12],
    [m02, m12, m22 + eps],
  ];
  const b = [r0, r1, r2];

  for (let col = 0; col < 3; col++) {
    let pivot = col;
    for (let r = col + 1; r < 3; r++) {
      if (Math.abs(m[r][col]) > Math.abs(m[pivot][col])) pivot = r;
    }
    if (Math.abs(m[pivot][col]) < 1e-12) return new Twist2d(0, 0, 0);
    if (pivot !== col) {
      [m[col], m[pivot]] = [m[pivot], m[col]];
      [b[col], b[pivot]] = [b[pivot], b[col]];
    }
    const d = m[col][col];
    for (let c2 = col; c2 < 3; c2++) m[col][c2] /= d;
    b[col] /= d;
    for (let r = 0; r < 3; r++) {
      if (r === col) continue;
      const f = m[r][col];
      if (f === 0) continue;
      for (let c2 = col; c2 < 3; c2++) m[r][c2] -= f * m[col][c2];
      b[r] -= f * b[col];
    }
  }
  return new Twist2d(b[0], b[1], b[2]);
}

/**
 * Theoretical maxima for a drivetrain, used to normalise driver commands and to
 * label the HUD.
 *
 * The strafe figure is why mecanum robots feel sluggish sideways: for a
 * standard 45 degree layout the wheels must turn just as fast to strafe as to
 * drive, so top strafing speed equals top forward speed *in theory*, but roller
 * drag and the reduced grip along the roller axis mean the real figure is
 * typically 10-25% lower.
 *
 * @param {KinematicsRow[]} rows
 * @param {number} maxWheelSurfaceSpeed m/s, free speed at the current bus voltage
 */
export function maxChassisSpeeds(rows, maxWheelSurfaceSpeed) {
  const worst = (fn) => {
    let peak = 0;
    for (const r of rows) peak = Math.max(peak, Math.abs(fn(r)));
    return peak > 1e-9 ? maxWheelSurfaceSpeed / peak : 0;
  };
  return {
    forward: worst((r) => r.a),
    strafe: worst((r) => r.b),
    turn: worst((r) => r.c),
  };
}

/**
 * Scale a set of commanded wheel speeds so none exceeds the achievable maximum,
 * preserving the *shape* of the motion.
 *
 * This is the "desaturate" step every good mecanum op-mode needs. Clipping each
 * wheel independently instead changes the direction the robot travels, which is
 * why a robot commanded to drive diagonally while turning veers off course.
 *
 * @param {Float64Array|number[]} speeds modified in place
 * @param {number} maxSpeed
 */
export function desaturate(speeds, maxSpeed) {
  let peak = 0;
  for (let i = 0; i < speeds.length; i++) peak = Math.max(peak, Math.abs(speeds[i]));
  if (peak > maxSpeed && peak > 1e-9) {
    const k = maxSpeed / peak;
    for (let i = 0; i < speeds.length; i++) speeds[i] *= k;
  }
  return speeds;
}
