import test from 'node:test';
import assert from 'node:assert/strict';
import { HUB_FULL_SCALE, HUB_LOOP_HZ, HubPidf, hubDefaultGains } from '../src/hardware/HubPidf.js';
import { Encoder } from '../src/hardware/Encoder.js';
import { Config } from '../src/config/Config.js';
import { Simulation } from '../src/app/Simulation.js';

test('the SDK’s default coefficients are full duty at full speed', () => {
  const gains = hubDefaultGains(2800);
  assert.ok(Math.abs(gains.f - HUB_FULL_SCALE / 2800) < 1e-9);
  assert.ok(Math.abs(gains.p - 0.1 * gains.f) < 1e-12);
  assert.ok(Math.abs(gains.i - 0.01 * gains.f) < 1e-12);
  assert.equal(gains.d, 0);

  // ... which means the feedforward alone asks for full duty at full speed.
  const pid = new HubPidf({ ...gains, p: 0, i: 0 });
  assert.ok(Math.abs(pid.update(2800, 2800, 0.02) - 1) < 1e-9);
  assert.ok(Math.abs(pid.update(1400, 1400, 0.02) - 0.5) < 1e-9);
});

test('the output is the hub’s 16-bit duty, clamped', () => {
  const pid = new HubPidf({ f: 0, p: 1000, i: 0, d: 0 });
  // An error of 32.767 ticks/sec at P = 1000 is exactly full scale.
  assert.ok(Math.abs(pid.update(32.767, 0, 0.02) - 1) < 1e-9);
  pid.reset();
  assert.equal(pid.update(1000, 0, 0.02), 1, 'and it does not go past it');
  assert.ok(pid.raw > HUB_FULL_SCALE, 'though it knows it wanted to');
});

test('I and D are scaled by the hub’s own loop rate, not by the caller’s', () => {
  // The same total elapsed time in two different step sizes has to build the
  // same integral, or the standard coefficient guidance means nothing.
  const slow = new HubPidf({ f: 0, p: 0, i: 1, d: 0 });
  const fast = new HubPidf({ f: 0, p: 0, i: 1, d: 0 });
  for (let i = 0; i < 10; i++) slow.update(100, 0, 0.02);
  for (let i = 0; i < 40; i++) fast.update(100, 0, 0.005);
  assert.ok(Math.abs(slow.integral - fast.integral) < 1e-9, `${slow.integral} vs ${fast.integral}`);
  // And the scaling really is the 20 Hz figure: 0.2 s of error 100 at 20 Hz.
  assert.ok(Math.abs(slow.integral - 100 * 0.2 * HUB_LOOP_HZ) < 1e-9);
});

test('the integral resets when the error changes sign', () => {
  const pid = new HubPidf({ f: 0, p: 0, i: 1, d: 0 });
  for (let i = 0; i < 20; i++) pid.update(100, 0, 0.02);
  assert.ok(pid.integral > 0, 'it wound up on the way to the setpoint');
  pid.update(100, 120, 0.02);
  // Past the setpoint: what accumulated getting here is not a reason to keep
  // pushing. Only the error of this iteration is in there now.
  assert.ok(pid.integral < 0, `integral is ${pid.integral}`);
  assert.ok(Math.abs(pid.integral - -20 * 0.02 * HUB_LOOP_HZ) < 1e-9);
});

test('it stops integrating while saturated, and caps the I term at a quarter of scale', () => {
  const pid = new HubPidf({ f: 0, p: 1000, i: 1, d: 0 });
  for (let i = 0; i < 50; i++) pid.update(10000, 0, 0.02);
  // P alone is far past full scale, so the integral must not have kept growing.
  assert.equal(pid.integral, 0, 'nothing was integrated while it was saturated');

  const gentle = new HubPidf({ f: 0, p: 0, i: 1, d: 0 });
  for (let i = 0; i < 2000; i++) gentle.update(100, 0, 0.02);
  assert.ok(
    Math.abs(gentle.integral * gentle.i) <= 0.25 * HUB_FULL_SCALE + 1e-9,
    `the I term alone reached ${gentle.integral * gentle.i}`,
  );
});

test('a velocity past 32767 ticks a second wraps, as the hub reports it', () => {
  // A bare motor with a through-bore encoder: 8192 counts, spinning fast.
  const encoder = new Encoder({ ticksPerRev: 8192, gearRatio: 1, velocityFilterHz: 1000 });
  let angle = 0;
  const omega = 30; // rad/s -> about 39,000 ticks/sec
  for (let i = 0; i < 50; i++) {
    angle += omega * 0.001;
    encoder.update(angle, 0.001);
  }
  const expected = (omega / (2 * Math.PI)) * 8192;
  assert.ok(expected > 32767, `the test needs to be past the limit: ${expected}`);
  assert.ok(
    encoder.velocityTicksPerSec < 0,
    `it should read large and negative, read ${encoder.velocityTicksPerSec}`,
  );
  assert.ok(Math.abs(encoder.velocityRadPerSec) < omega, 'and nothing downstream can tell');

  // Switched off, it reads the truth.
  const honest = new Encoder({
    ticksPerRev: 8192,
    gearRatio: 1,
    velocityFilterHz: 1000,
    overflow16Bit: false,
  });
  let a = 0;
  for (let i = 0; i < 50; i++) {
    a += omega * 0.001;
    honest.update(a, 0.001);
  }
  assert.ok(honest.velocityTicksPerSec > 30000, `read ${honest.velocityTicksPerSec}`);
});

test('a slow shaft never gets near the limit, which is why nobody hits this on a drivetrain', () => {
  // The default drive motor: 537.6 ticks per wheel revolution at 312 rpm.
  const encoder = new Encoder({ ticksPerRev: 28, gearRatio: 19.2, velocityFilterHz: 1000 });
  let angle = 0;
  for (let i = 0; i < 50; i++) {
    angle += 33 * 0.001; // rad/s at the output, well past free speed
    encoder.update(angle, 0.001);
  }
  assert.ok(encoder.velocityTicksPerSec > 0, `read ${encoder.velocityTicksPerSec}`);
});

test('a robot in RUN_USING_ENCODER holds its speed on the hub loop', () => {
  const config = new Config();
  config.set('ai.enabled', false);
  config.set('control.runMode', 'RUN_USING_ENCODER');
  const sim = new Simulation(config);
  assert.equal(sim.robot.drivetrain.motors[0].controller.velocityLoop, 'hub');

  sim.input.keyboardSource.active = true;
  sim.input.keyboardSource.keys.add('KeyW');
  // One second, not three: the field is only two metres from the middle to the
  // wall, and a robot pinned against it is a robot whose wheels are slipping.
  for (let i = 0; i < 60; i++) sim.step(1 / 60);

  const wheel = sim.robot.drivetrain.wheels[0];
  const rolling = sim.robot.body.speed / sim.config.drivetrain.wheelRadius;
  assert.ok(sim.robot.body.speed > 1, `full stick should be moving: ${sim.robot.body.speed} m/s`);
  assert.ok(
    Math.abs(wheel.angularVelocity - rolling) < rolling * 0.15,
    `and rolling rather than slipping: wheel ${wheel.angularVelocity}, ground ${rolling}`,
  );

  // Half stick, and it settles near half the commanded speed rather than
  // wherever the load leaves it.
  sim.input.keyboardSource.keys.delete('KeyW');
  sim.resetRobot();
  const motor = sim.robot.drivetrain.motors[0];
  for (let i = 0; i < 90; i++) {
    for (const m of sim.robot.drivetrain.motors) m.controller.setPower(0.5);
    sim.robot.updateControl(1 / 90, null);
    for (let j = 0; j < 30; j++) sim.robot.stepPhysics(1 / 2700);
  }
  const half = sim.robot.drivetrain.wheels[0].angularVelocity / motor.nominalOutputSpeed;
  assert.ok(half > 0.42 && half < 0.58, `half stick held ${(half * 100).toFixed(0)}% of free speed`);
});

test('the panel can switch the loop over and type coefficients into it', () => {
  const config = new Config();
  config.set('ai.enabled', false);
  const sim = new Simulation(config);
  const controller = () => sim.robot.drivetrain.motors[0].controller;

  assert.equal(controller().hubGains, null, 'the SDK defaults, derived from the motor');
  config.set('control.hubPidfDefaults', false);
  config.set('control.hubF', 20);
  assert.equal(controller().hubGains.f, 20);

  config.set('control.velocityLoop', 'normalised');
  assert.equal(controller().velocityLoop, 'normalised');
});
