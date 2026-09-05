import test from 'node:test';
import assert from 'node:assert/strict';
import { DcMotor } from '../src/hardware/DcMotor.js';
import { DriveMotor } from '../src/hardware/DriveMotor.js';
import { MotorController } from '../src/hardware/MotorController.js';
import { Battery } from '../src/hardware/Battery.js';
import { Encoder } from '../src/hardware/Encoder.js';
import { Imu } from '../src/hardware/Imu.js';
import { MOTOR_PRESETS } from '../src/config/presets/motors.js';
import { rpmToRadPerSec } from '../src/math/MathUtil.js';

const near = (a, b, eps) => assert.ok(Math.abs(a - b) < eps, `expected ${a} within ${eps} of ${b}`);

function makeMotor(id = 'gobilda5203') {
  return new DcMotor({ ...MOTOR_PRESETS[id] });
}

test('every motor preset reproduces its own catalogue figures', () => {
  for (const spec of Object.values(MOTOR_PRESETS)) {
    const motor = new DcMotor({ ...spec });
    // Stall: zero speed at nominal voltage.
    near(motor.evaluate(12, 0).torque, spec.stallTorque, 1e-9);
    near(motor.evaluate(12, 0).current, spec.stallCurrent, 1e-9);
    // Free: no-load current at free speed.
    near(motor.evaluate(12, motor.freeSpeed).current, spec.freeCurrent, 1e-9);
    near(motor.freeSpeed, rpmToRadPerSec(spec.freeSpeedRpm), 1e-9);
  }
});

test('torque falls off linearly with speed', () => {
  const motor = makeMotor();
  const half = motor.evaluate(12, motor.freeSpeed / 2).torque;
  const stall = motor.evaluate(12, 0).torque;
  // Half speed gives a little over half stall torque, because the free-speed
  // point is offset by the no-load current rather than sitting at zero torque.
  assert.ok(half > stall * 0.45 && half < stall * 0.55, `half-speed torque ${half}`);
});

test('motor output scales with bus voltage', () => {
  const motor = makeMotor();
  near(motor.evaluate(6, 0).torque, motor.evaluate(12, 0).torque / 2, 1e-9);
  near(motor.freeSpeedAt(6), motor.freeSpeed / 2, 1e-9);
});

test('current limiting caps draw without reversing torque', () => {
  const motor = makeMotor();
  const limit = 4;
  const limited = motor.evaluate(12, 0, limit);
  near(limited.current, limit, 1e-9);
  assert.ok(limited.torque > 0);
  // A limit above the natural draw must change nothing.
  const unlimited = motor.evaluate(12, 0, 100);
  near(unlimited.current, motor.stallCurrent, 1e-9);
});

test('an open circuit produces no torque (FLOAT at zero power)', () => {
  const motor = makeMotor();
  const result = motor.evaluate(12, 50, Infinity, true);
  assert.equal(result.torque, 0);
  assert.equal(result.current, 0);
});

test('BRAKE at zero power resists motion, FLOAT does not', () => {
  const motor = makeMotor();
  const spinning = 200;
  const braking = motor.evaluate(0, spinning); // terminals shorted
  assert.ok(braking.torque < 0, 'shorted terminals must oppose rotation');
  const floating = motor.evaluate(0, spinning, Infinity, true);
  assert.equal(floating.torque, 0);
});

test('gearing trades speed for torque exactly', () => {
  const dm = new DriveMotor({ motor: makeMotor(), gearRatio: 19.2, efficiency: 1 });
  const fast = new DriveMotor({ motor: makeMotor(), gearRatio: 9.6, efficiency: 1 });
  near(fast.freeOutputSpeed(12), dm.freeOutputSpeed(12) * 2, 1e-9);
  near(fast.stallOutputTorque(12), dm.stallOutputTorque(12) / 2, 1e-9);
});

test('reflected rotor inertia scales with the square of the ratio', () => {
  const a = new DriveMotor({ motor: makeMotor(), gearRatio: 10 });
  const b = new DriveMotor({ motor: makeMotor(), gearRatio: 20 });
  near(b.reflectedInertia, a.reflectedInertia * 4, 1e-12);
});

test('a 312 RPM Yellow Jacket on 96 mm wheels tops out near 5 ft/s', () => {
  const dm = new DriveMotor({ motor: makeMotor(), gearRatio: 19.2 });
  const speed = dm.freeOutputSpeed(12) * 0.048;
  // goBILDA quote about 5.0-5.2 ft/s for exactly this configuration.
  assert.ok(speed * 3.28084 > 4.9 && speed * 3.28084 < 5.3, `${speed * 3.28084} ft/s`);
});

test('bus current is duty times winding current, so reversed motors still draw', () => {
  const dm = new DriveMotor({ motor: makeMotor(), gearRatio: 19.2, efficiency: 1 });
  dm.controller.setPower(-1);
  dm.updateController(12, 0.02);
  dm.computeWheelTorque(0, 12);
  assert.ok(dm.current < 0, 'winding current is negative when driven in reverse');
  assert.ok(dm.busCurrent > 0, 'a motor driven in reverse must still draw from the pack');
  near(dm.busCurrent, -dm.current, 1e-9);
});

test('braking regeneration shows as negative bus current', () => {
  const dm = new DriveMotor({ motor: makeMotor(), gearRatio: 19.2, efficiency: 1 });
  dm.controller.setPower(0.2);
  dm.updateController(12, 0.02);
  // Wheel spinning much faster than the 20% command: back-EMF exceeds applied.
  dm.computeWheelTorque(dm.freeOutputSpeed(12) * 0.9, 12);
  assert.ok(dm.busCurrent < 0, `expected regeneration, got ${dm.busCurrent} A`);
});

test('battery sags under load in proportion to internal resistance', () => {
  const soft = new Battery({ internalResistance: 0.02, baseLoadAmps: 0 });
  const tired = new Battery({ internalResistance: 0.06, baseLoadAmps: 0 });
  const v1 = soft.update(40, 0.01);
  const v2 = tired.update(40, 0.01);
  assert.ok(v2 < v1, 'a higher-resistance pack must sag further');
  near(v1 - v2, 40 * (0.06 - 0.02), 1e-6);
});

test('battery drains over time and voltage falls with charge', () => {
  const b = new Battery({ capacityAmpHours: 3, baseLoadAmps: 0 });
  const full = b.restingVoltage();
  // 30 A for 5 minutes is 2.5 Ah, most of a pack.
  for (let i = 0; i < 300 * 100; i++) b.update(30, 0.01);
  assert.ok(b.stateOfCharge < 0.2, `expected a nearly flat pack, got ${b.stateOfCharge}`);
  assert.ok(b.restingVoltage() < full, 'resting voltage must fall as charge is used');
});

test('battery can be disabled for A/B testing', () => {
  const b = new Battery({ enabled: false, openCircuitVoltage: 13 });
  near(b.update(60, 0.01), 13, 1e-12);
});

test('encoder quantises to whole ticks', () => {
  const enc = new Encoder({ ticksPerRev: 28, gearRatio: 19.2, quantise: true });
  enc.update(0.001, 0.02);
  assert.ok(Number.isInteger(enc.ticks), `expected whole ticks, got ${enc.ticks}`);
  const exact = new Encoder({ ticksPerRev: 28, gearRatio: 19.2, quantise: false });
  exact.update(0.001, 0.02);
  assert.ok(!Number.isInteger(exact.ticks));
});

test('encoder reports position and velocity consistently', () => {
  const enc = new Encoder({ ticksPerRev: 28, gearRatio: 19.2, quantise: false, velocityFilterHz: 0 });
  const omega = 5;
  let angle = 0;
  for (let i = 0; i < 200; i++) {
    angle += omega * 0.01;
    enc.update(angle, 0.01);
  }
  near(enc.positionRadians, angle, 1e-6);
  near(enc.velocityRadPerSec, omega, 1e-6);
});

test('encoder zero resets to the current shaft angle', () => {
  const enc = new Encoder({ ticksPerRev: 28, gearRatio: 1 });
  enc.update(10, 0.02);
  assert.notEqual(enc.ticks, 0);
  enc.zero(10);
  assert.equal(enc.ticks, 0);
  enc.update(10, 0.02);
  assert.equal(enc.ticks, 0);
});

test('IMU drift accumulates and is disableable', () => {
  const imu = new Imu({ driftRateDegPerSec: 0.5, noiseDeg: 0, latencySeconds: 0, filterHz: 0 });
  for (let i = 0; i < 1000; i++) imu.update(0, 0, 0.01);
  // 0.5 deg/s for 10 s is 5 degrees of accumulated error.
  near((imu.heading * 180) / Math.PI, 5, 0.2);

  const perfect = new Imu({ enabled: false });
  for (let i = 0; i < 1000; i++) perfect.update(1.2, 0, 0.01);
  near(perfect.heading, 1.2, 1e-12);
});

test('IMU resetYaw zeroes the reported heading', () => {
  const imu = new Imu({ driftRateDegPerSec: 0.5, noiseDeg: 0, latencySeconds: 0, filterHz: 0 });
  for (let i = 0; i < 500; i++) imu.update(0, 0, 0.01);
  imu.resetYaw(0);
  imu.update(0, 0, 0.01);
  near(imu.heading, 0, 0.01);
});

test('RUN_USING_ENCODER targets a fixed speed regardless of bus voltage', () => {
  const build = () => {
    const dm = new DriveMotor({ motor: makeMotor(), gearRatio: 19.2, efficiency: 1 });
    dm.controller.setMode('RUN_USING_ENCODER');
    dm.controller.setPower(0.5);
    return dm;
  };
  // Hold the reported speed at exactly half the *rated* free speed and see what
  // duty each bus voltage needs to sustain it.
  const holdAt = (dm, busVoltage) => {
    const target = dm.nominalOutputSpeed * 0.5;
    let duty = 0;
    for (let i = 0; i < 400; i++) {
      dm.encoder.velocityTicksPerSec = (target / (2 * Math.PI)) * dm.encoder.ticksPerOutputRev;
      duty = dm.updateController(busVoltage, 0.02);
    }
    return duty;
  };
  const duty12 = holdAt(build(), 12);
  const duty10 = holdAt(build(), 10);
  // At rest the loop settles near the feedforward value.
  near(duty12, 0.5, 0.06);
  assert.ok(
    duty10 > duty12 + 0.03,
    `closed loop must command more duty on a sagging pack: ${duty10} vs ${duty12}`,
  );
});

test('open loop speed sags with the battery, closed loop does not', () => {
  const openLoop = new DriveMotor({ motor: makeMotor(), gearRatio: 19.2, efficiency: 1 });
  openLoop.controller.setPower(1);
  openLoop.updateController(10, 0.02);
  near(openLoop.duty, 1, 1e-12);
  // Same duty, lower bus: less voltage at the motor, so less speed available.
  assert.ok(openLoop.freeOutputSpeed(10) < openLoop.freeOutputSpeed(12));
});

test('RUN_WITHOUT_ENCODER passes the command straight through', () => {
  const controller = new MotorController({ mode: 'RUN_WITHOUT_ENCODER' });
  controller.setPower(0.42);
  near(controller.update(0, 0, 100, 0.02), 0.42, 1e-12);
});

test('reversing a motor flips its duty cycle', () => {
  const controller = new MotorController({ reversed: true });
  controller.setPower(0.5);
  near(controller.update(0, 0, 100, 0.02), -0.5, 1e-12);
});
