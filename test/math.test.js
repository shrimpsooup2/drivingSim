import test from 'node:test';
import assert from 'node:assert/strict';
import { Vec2 } from '../src/math/Vec2.js';
import { Rotation2d } from '../src/math/Rotation2d.js';
import { Pose2d } from '../src/math/Pose2d.js';
import { blendedCurve, deadband, wrapAngle, clamp, powerCurve } from '../src/math/MathUtil.js';
import { PIDF } from '../src/math/PIDF.js';
import { DelayLine, SlewRateLimiter, LowPassFilter } from '../src/math/filters.js';

const near = (a, b, eps = 1e-9) =>
  assert.ok(Math.abs(a - b) < eps, `expected ${a} to be within ${eps} of ${b}`);

test('Vec2 basics', () => {
  const a = new Vec2(3, 4);
  near(a.length(), 5);
  near(Vec2.dot(a, new Vec2(1, 0)), 3);
  near(Vec2.cross(new Vec2(1, 0), new Vec2(0, 1)), 1);
  const p = new Vec2(1, 0).perp();
  near(p.x, 0);
  near(p.y, 1);
  const clamped = new Vec2(6, 8).clampedLength(5);
  near(clamped.length(), 5);
  near(new Vec2(0, 0).normalized().length(), 0);
});

test('Rotation2d round-trips and composes', () => {
  const r = Rotation2d.fromDegrees(37);
  near(r.degrees, 37, 1e-9);
  const v = new Vec2(0.3, -0.7);
  const back = r.unapply(r.apply(v));
  near(back.x, v.x, 1e-12);
  near(back.y, v.y, 1e-12);
  const composed = Rotation2d.fromDegrees(30).rotateBy(Rotation2d.fromDegrees(45));
  near(composed.degrees, 75, 1e-9);
});

test('Rotation2d.normalize repairs accumulated drift', () => {
  const r = new Rotation2d(2, 0);
  r.normalize();
  near(Math.hypot(r.cos, r.sin), 1);
});

test('wrapAngle maps into (-pi, pi]', () => {
  near(wrapAngle(3 * Math.PI), Math.PI, 1e-12);
  near(wrapAngle(-3 * Math.PI), Math.PI, 1e-12);
  near(wrapAngle(0.5), 0.5);
  near(wrapAngle(2 * Math.PI + 0.25), 0.25, 1e-12);
});

test('deadband is continuous at the band edge and reaches full scale', () => {
  near(deadband(0.05, 0.05), 0);
  // Just outside the band the output must start from zero, not jump.
  assert.ok(deadband(0.0501, 0.05) < 0.002);
  near(deadband(1, 0.05), 1, 1e-12);
  near(deadband(-1, 0.05), -1, 1e-12);
  near(deadband(0.3, 0), 0.3);
});

test('power curves keep sign and endpoints', () => {
  near(powerCurve(-0.5, 2), -0.25);
  near(powerCurve(1, 3), 1);
  near(blendedCurve(0.5, 2, 0), 0.5);
  near(blendedCurve(0.5, 2, 1), 0.25);
  near(blendedCurve(0.5, 2, 0.5), 0.375);
});

test('Pose2d transforms points into and out of its frame', () => {
  const pose = Pose2d.fromXYTheta(1, 2, Math.PI / 2);
  const world = pose.transformPoint(new Vec2(1, 0));
  near(world.x, 1, 1e-12);
  near(world.y, 3, 1e-12);
  const local = pose.inverseTransformPoint(world);
  near(local.x, 1, 1e-12);
  near(local.y, 0, 1e-12);
});

test('PIDF converges and respects output limits', () => {
  const pid = new PIDF({ kP: 2, kI: 6, kD: 0, outputMin: -1, outputMax: 1 });
  let measurement = 0;
  for (let i = 0; i < 2000; i++) {
    const out = pid.calculate(1, measurement, 0.01);
    assert.ok(out <= 1 && out >= -1, 'output escaped its limits');
    measurement += (out - measurement) * 0.05;
  }
  assert.ok(Math.abs(1 - measurement) < 0.02, `did not converge: ${measurement}`);
});

test('PIDF anti-windup keeps the integral bounded while saturated', () => {
  const pid = new PIDF({ kP: 1, kI: 50, outputMin: -1, outputMax: 1, maxIntegral: 10 });
  for (let i = 0; i < 1000; i++) pid.calculate(100, 0, 0.01);
  assert.ok(Math.abs(pid.integral) <= 10.001, `integral wound up to ${pid.integral}`);
});

test('SlewRateLimiter respects separate rise and fall rates', () => {
  const s = new SlewRateLimiter(2, 10);
  let v = 0;
  for (let i = 0; i < 5; i++) v = s.update(1, 0.1);
  near(v, 1, 1e-12);
  // Releasing to zero must use the fast fall rate, not the gentle rise rate:
  // one 0.1 s step at 10/s covers the whole way back.
  v = s.update(0, 0.1);
  near(v, 0, 1e-12);
});

test('SlewRateLimiter decelerates before reversing through zero', () => {
  const s = new SlewRateLimiter(2, 10);
  s.reset(1);
  // Commanding full reverse: the first step uses the fall rate (10/s).
  near(s.update(-1, 0.05), 0.5, 1e-12);
  // Still positive, so still decelerating.
  near(s.update(-1, 0.05), 0, 1e-12);
  // Now moving away from zero on the other side: the rise rate (2/s) applies.
  near(s.update(-1, 0.05), -0.1, 1e-12);
});

test('SlewRateLimiter reduces magnitude at the fall rate', () => {
  const s = new SlewRateLimiter(2, 10);
  s.reset(1);
  near(s.update(0.5, 0.01), 0.9, 1e-12);
});

test('SlewRateLimiter with an infinite rate passes through', () => {
  const s = new SlewRateLimiter(Infinity);
  near(s.update(0.7, 0.016), 0.7);
});

test('LowPassFilter approaches its input and starts from it', () => {
  const f = new LowPassFilter(5);
  near(f.update(1, 0.01), 1, 1e-12); // first sample initialises
  for (let i = 0; i < 1000; i++) f.update(2, 0.01);
  near(f.value, 2, 1e-6);
});

test('DelayLine holds a signal back by about the requested delay', () => {
  const d = new DelayLine(0.05);
  let out = 0;
  for (let i = 0; i < 200; i++) out = d.update(i, 0.01);
  // At t = 2.00 s the value from 0.05 s ago was sample 194 or 195.
  assert.ok(out >= 194 && out <= 195, `delayed output was ${out}`);
});

test('DelayLine with zero delay is a pass-through', () => {
  const d = new DelayLine(0);
  near(d.update(42, 0.01), 42);
});

test('clamp handles reversed and equal bounds safely', () => {
  near(clamp(5, 0, 10), 5);
  near(clamp(-5, 0, 10), 0);
  near(clamp(50, 0, 10), 10);
  near(clamp(3, 2, 2), 2);
});
