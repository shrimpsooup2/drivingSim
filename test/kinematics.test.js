import test from 'node:test';
import assert from 'node:assert/strict';
import { buildLayout, LAYOUT_BUILDERS } from '../src/drivetrain/layouts.js';
import {
  buildInverseKinematics,
  desaturate,
  forwardKinematics,
  inverseKinematics,
  maxChassisSpeeds,
} from '../src/drivetrain/kinematics.js';
import { DEG } from '../src/math/MathUtil.js';

const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `expected ${a} within ${eps} of ${b}`);

const OPTS = {
  wheelbase: 0.32,
  trackWidth: 0.34,
  wheelRadius: 0.048,
  rollerAngle: 45 * DEG,
  rotationalInertia: 0.005,
  rollingResistance: 0.02,
  rollerDrag: 0.09,
};

test('mecanum inverse kinematics matches the textbook equations', () => {
  const wheels = buildLayout('mecanum', OPTS);
  const rows = buildInverseKinematics(wheels);
  const k = OPTS.wheelbase / 2 + OPTS.trackWidth / 2;

  // v_FL = vx - vy - w(lx+ly); v_FR = vx + vy + w(lx+ly);
  // v_BL = vx + vy - w(lx+ly); v_BR = vx - vy + w(lx+ly)
  const expected = [
    [1, -1, -k],
    [1, 1, k],
    [1, 1, -k],
    [1, -1, k],
  ];
  rows.forEach((row, i) => {
    near(row.a, expected[i][0], 1e-12);
    near(row.b, expected[i][1], 1e-12);
    near(row.c, expected[i][2], 1e-12);
  });
});

test('forward kinematics inverts inverse kinematics for every layout', () => {
  for (const type of Object.keys(LAYOUT_BUILDERS)) {
    const rows = buildInverseKinematics(buildLayout(type, OPTS));
    const holonomic = type === 'mecanum' || type === 'omni' || type === 'xdrive';
    const cases = holonomic
      ? [[0.7, -0.3, 1.1], [1.2, 0.9, -2.0], [0, 0, 0]]
      : [[0.7, 0, 1.1], [-1.2, 0, -2.0]];
    for (const [vx, vy, omega] of cases) {
      const speeds = inverseKinematics(rows, vx, vy, omega);
      const twist = forwardKinematics(rows, speeds);
      near(twist.vx, vx, 1e-9);
      near(twist.vy, vy, 1e-9);
      near(twist.omega, omega, 1e-9);
    }
  }
});

test('tank cannot strafe and mecanum can', () => {
  const tank = buildInverseKinematics(buildLayout('tank', OPTS));
  for (const speed of inverseKinematics(tank, 0, 1, 0)) near(speed, 0, 1e-12);

  const mecanum = buildInverseKinematics(buildLayout('mecanum', OPTS));
  const strafe = inverseKinematics(mecanum, 0, 1, 0);
  assert.ok([...strafe].every((s) => Math.abs(s) > 0.5), 'mecanum must strafe');
  // Strafing drives one diagonal pair forward and the other back.
  near(strafe[0] + strafe[1] + strafe[2] + strafe[3], 0, 1e-12);
});

test('X-drive wheels each contribute cos(45) to forward motion', () => {
  const rows = buildInverseKinematics(buildLayout('xdrive', OPTS));
  // Left and right wheels roll in opposite senses along their own 45 degree
  // axes; the magnitude is what matters.
  for (const speed of inverseKinematics(rows, 1, 0, 0)) near(Math.abs(speed), Math.SQRT1_2, 1e-9);
});

test('X-drive wheels are tangential, so all four share one turning moment arm', () => {
  const rows = buildInverseKinematics(buildLayout('xdrive', OPTS));
  const arm = (OPTS.wheelbase / 2 + OPTS.trackWidth / 2) * Math.SQRT1_2;
  for (const row of rows) near(row.c, arm, 1e-9);
  // Every wheel drives the same way to spin the robot.
  const speeds = inverseKinematics(rows, 0, 0, 1);
  for (const speed of speeds) near(speed, arm, 1e-9);
});

test('driving straight turns every mecanum wheel the same way', () => {
  const rows = buildInverseKinematics(buildLayout('mecanum', OPTS));
  for (const speed of inverseKinematics(rows, 1, 0, 0)) near(speed, 1, 1e-12);
});

test('turning in place produces equal and opposite sides', () => {
  const wheels = buildLayout('mecanum', OPTS);
  const rows = buildInverseKinematics(wheels);
  const speeds = inverseKinematics(rows, 0, 0, 1);
  wheels.forEach((wheel, i) => {
    // Left wheels go backwards for a counter-clockwise turn.
    const expectSign = wheel.position.y > 0 ? -1 : 1;
    assert.equal(Math.sign(speeds[i]), expectSign, `${wheel.name} turned the wrong way`);
  });
});

test('desaturate preserves direction while scaling into range', () => {
  const speeds = [2, -1, 0.5, 0];
  desaturate(speeds, 1);
  near(Math.max(...speeds.map(Math.abs)), 1, 1e-12);
  near(speeds[1] / speeds[0], -0.5, 1e-12);
  // Already in range: untouched.
  const small = [0.4, -0.2];
  desaturate(small, 1);
  near(small[0], 0.4, 1e-12);
});

test('max chassis speeds are consistent with the wheel limit', () => {
  const rows = buildInverseKinematics(buildLayout('mecanum', OPTS));
  const wheelSpeed = 1.571;
  const max = maxChassisSpeeds(rows, wheelSpeed);
  near(max.forward, wheelSpeed, 1e-9);
  // A standard 45 degree mecanum layout strafes as fast as it drives, in
  // theory; roller drag is what costs you in practice.
  near(max.strafe, wheelSpeed, 1e-9);
  near(max.turn, wheelSpeed / (OPTS.wheelbase / 2 + OPTS.trackWidth / 2), 1e-9);
});

test('tank reports zero achievable strafe speed', () => {
  const rows = buildInverseKinematics(buildLayout('tank', OPTS));
  near(maxChassisSpeeds(rows, 1.5).strafe, 0, 1e-12);
});

test('layouts place the expected number of wheels', () => {
  assert.equal(buildLayout('mecanum', OPTS).length, 4);
  assert.equal(buildLayout('tank', OPTS).length, 4);
  assert.equal(buildLayout('tank6', OPTS).length, 6);
  assert.equal(buildLayout('omni', OPTS).length, 4);
  assert.equal(buildLayout('xdrive', OPTS).length, 4);
});

test('mecanum roller angles alternate in the standard X pattern', () => {
  const [fl, fr, bl, br] = buildLayout('mecanum', OPTS);
  near(fl.rollerAngle, -45 * DEG, 1e-12);
  near(fr.rollerAngle, 45 * DEG, 1e-12);
  near(bl.rollerAngle, 45 * DEG, 1e-12);
  near(br.rollerAngle, -45 * DEG, 1e-12);
  // Diagonally opposite wheels share a roller angle.
  near(fl.rollerAngle, br.rollerAngle, 1e-12);
  near(fr.rollerAngle, bl.rollerAngle, 1e-12);
});
