import test from 'node:test';
import assert from 'node:assert/strict';
import { Config } from '../src/config/Config.js';
import { Simulation } from '../src/app/Simulation.js';
import { Encoder } from '../src/hardware/Encoder.js';
import { Imu } from '../src/hardware/Imu.js';
import { DeadWheel } from '../src/hardware/DeadWheel.js';

function rig() {
  const config = new Config();
  config.set('ai.enabled', false);
  const sim = new Simulation(config);
  sim.input.keyboardSource.active = true;
  return sim;
}

function drive(sim, keys, seconds) {
  for (const key of keys) sim.input.keyboardSource.keys.add(key);
  for (let i = 0; i < Math.round(seconds * 60); i++) sim.step(1 / 60);
  for (const key of keys) sim.input.keyboardSource.keys.delete(key);
}

test('a dead encoder reads zero for ever', () => {
  const encoder = new Encoder({ ticksPerRev: 28, gearRatio: 19.2 });
  let angle = 0;
  const turn = () => {
    angle += 1;
    return encoder.update(angle, 0.02);
  };
  turn();
  assert.ok(encoder.ticks > 50, 'it was counting');
  encoder.fault = 'dead';
  turn();
  assert.equal(encoder.ticks, 0);
  turn();
  assert.equal(encoder.ticks, 0);
  encoder.fault = 'none';
  turn();
  assert.ok(encoder.ticks > 50, 'and it comes back when you plug it in again');
});

test('a stuck encoder holds whatever it was reading', () => {
  const encoder = new Encoder({ ticksPerRev: 28, gearRatio: 19.2 });
  let angle = 0;
  for (let i = 0; i < 3; i++) encoder.update((angle += 1), 0.02);
  const held = encoder.ticks;
  assert.ok(held > 100);
  encoder.fault = 'stuck';
  for (let i = 0; i < 5; i++) encoder.update((angle += 1), 0.02);
  assert.equal(encoder.ticks, held);
  // The reported velocity decays to nothing rather than snapping: it is a
  // filtered difference of counts, and the filter still holds what it saw.
  assert.ok(
    Math.abs(encoder.velocityTicksPerSec) < 1,
    `reports ${encoder.velocityTicksPerSec} ticks/s`,
  );
});

test('an offset is a miscounted reset, not a failure', () => {
  const encoder = new Encoder({ ticksPerRev: 28, gearRatio: 19.2 });
  encoder.offsetTicks = 500;
  encoder.update(1, 0.02);
  const withOffset = encoder.ticks;
  encoder.offsetTicks = 0;
  encoder.update(2, 0.02);
  assert.ok(Math.abs(withOffset - encoder.ticks) > 300, 'it really shifted the reading');
});

test('a stuck IMU is the nasty one: it never reports an error', () => {
  const imu = new Imu({ driftRateDegPerSec: 0, noiseDeg: 0, latencySeconds: 0 });
  imu.reset(0);
  imu.update(1, 0, 0.02);
  const held = imu.heading;
  imu.fault = 'stuck';
  for (let i = 0; i < 20; i++) imu.update(i * 0.2, 1, 0.02);
  assert.equal(imu.heading, held, 'the robot turned and the heading did not');
  assert.equal(imu.angularVelocity, 0);
  imu.fault = 'dead';
  imu.update(2, 1, 0.02);
  assert.equal(imu.heading, 0);
});

test('a dead pod stops counting while the other one carries on', () => {
  const sim = rig();
  const odometry = sim.robot.odometry;
  drive(sim, ['KeyW'], 0.5);
  assert.ok(Math.abs(odometry.forward.ticks) > 50, 'the forward pod was counting');

  odometry.forward.fault = 'dead';
  const poseBefore = { ...odometry.pose };
  drive(sim, ['KeyW'], 0.6);
  assert.equal(odometry.forward.ticks, 0);
  // The pose stops advancing along the robot's own axis, so the estimate now
  // sits still while the robot drives away from it.
  const moved = Math.hypot(odometry.pose.x - poseBefore.x, odometry.pose.y - poseBefore.y);
  const trulyMoved = Math.hypot(
    sim.robot.body.position.x - poseBefore.x,
    sim.robot.body.position.y - poseBefore.y,
  );
  assert.ok(moved < 0.05, `the estimate moved ${moved.toFixed(3)} m`);
  assert.ok(trulyMoved > 0.2, `while the robot moved ${trulyMoved.toFixed(3)} m`);
});

test('a dead encoder breaks a distance-based routine and nothing looks wrong', () => {
  const sim = rig();
  sim.autoRunner.compile(`
    function* auto(robot) {
      robot.resetEncoders();
      robot.drive(0.5, 0, 0);
      const deadline = robot.time + 2;
      yield () => robot.travelled >= 0.5 || robot.time > deadline;
      robot.drive(0, 0, 0);
      robot.telemetry.addData('travelled', robot.travelled.toFixed(3));
      robot.telemetry.addData('reallyWent', robot.truth.x.toFixed(3));
    }
  `);
  sim.enableGame({ alliance: 'red' }).start();
  for (const motor of sim.robot.drivetrain.motors) motor.encoder.fault = 'dead';
  for (let i = 0; i < 60 * 4; i++) sim.step(1 / 60);

  const status = sim.autoRunner.status();
  assert.equal(status.state, 'done', status.error ?? '');
  assert.equal(Number(status.telemetry.travelled), 0, 'it never saw a tick');
  // It drove until its own deadline, which on a real field means until
  // something stopped it.
  assert.ok(status.runtime > 1.9, `it gave up after ${status.runtime.toFixed(2)} s`);
});

test('a pod reports nothing when its arm lifts, and everything when it comes back', () => {
  const pod = new DeadWheel({ ticksPerRev: 2000 });
  for (let i = 0; i < 100; i++) pod.step({ x: 1, y: 0 }, 0, 0.01);
  pod.sample();
  const before = pod.ticks;
  assert.ok(before > 100);

  pod.fault = 'stuck';
  for (let i = 0; i < 100; i++) pod.step({ x: 1, y: 0 }, 0, 0.01);
  pod.sample();
  assert.equal(pod.ticks, before);
  assert.equal(pod.deltaTicks, 0);

  pod.fault = 'none';
  pod.sample();
  // The wheel kept turning while the reading was frozen, so the next reading
  // jumps -- which is what a pod that drops back onto the tiles does.
  assert.ok(pod.ticks > before * 1.8, `jumped to ${pod.ticks}`);
});
