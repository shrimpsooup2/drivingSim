import test from 'node:test';
import assert from 'node:assert/strict';
import { Config } from '../src/config/Config.js';
import { Simulation } from '../src/app/Simulation.js';
import { DeadWheel } from '../src/hardware/DeadWheel.js';
import { Odometry } from '../src/hardware/Odometry.js';
import { INCH } from '../src/math/MathUtil.js';

function rig(overrides = {}) {
  const config = new Config();
  config.set('ai.enabled', false);
  for (const [path, value] of Object.entries(overrides)) config.set(path, value);
  const sim = new Simulation(config);
  sim.input.keyboardSource.active = true;
  return sim;
}

/** Drive with the keyboard for a while, as a driver would. */
function drive(sim, keys, seconds) {
  for (const key of keys) sim.input.keyboardSource.keys.add(key);
  for (let i = 0; i < Math.round(seconds * 60); i++) sim.step(1 / 60);
  for (const key of keys) sim.input.keyboardSource.keys.delete(key);
  return sim;
}

// --------------------------------------------------------------- the pod

test('a pod rolls the distance the floor went past it', () => {
  const pod = new DeadWheel({ radius: 0.024, ticksPerRev: 2000 });
  // A metre forward, in a hundred steps.
  for (let i = 0; i < 100; i++) pod.step({ x: 1, y: 0 }, 0, 0.01);
  pod.sample();
  assert.ok(Math.abs(pod.metres - 1) < 0.001, `read ${pod.metres} m`);
});

test('a pod at an offset reads the robot turning under it', () => {
  // 8 cm to the robot's left, measuring forward travel. Spin in place and it
  // reads backwards: the pod is being carried in -x while the robot rotates.
  const pod = new DeadWheel({ x: 0, y: 0.08, direction: 0 });
  for (let i = 0; i < 1000; i++) pod.step({ x: 0, y: 0 }, 1, 0.001);
  pod.sample();
  // One radian of rotation, 8 cm of offset: 8 cm of travel, the other way.
  assert.ok(Math.abs(pod.metres + 0.08) < 1e-4, `read ${pod.metres} m`);
});

test('a pod measuring sideways ignores forward motion', () => {
  const pod = new DeadWheel({ direction: Math.PI / 2 });
  for (let i = 0; i < 100; i++) pod.step({ x: 2, y: 0 }, 0, 0.01);
  pod.sample();
  assert.equal(pod.ticks, 0);
});

test('a pod reports whole ticks, and says what it rounded away', () => {
  const pod = new DeadWheel({ radius: 0.024, ticksPerRev: 2000 });
  // A third of a tick's worth of travel.
  const perTick = (2 * Math.PI * 0.024) / 2000;
  pod.step({ x: perTick / 3, y: 0 }, 0, 1);
  pod.sample();
  assert.equal(pod.ticks, 0, 'not enough for a whole tick');
  assert.ok(pod.ticksExact > 0.3 && pod.ticksExact < 0.34);
});

// ----------------------------------------------------------- the computer

test('spinning in place does not move the pose', () => {
  const odo = new Odometry({ quantise: false });
  let heading = 0;
  // A full turn, sampled the way a control loop would.
  for (let cycle = 0; cycle < 200; cycle++) {
    for (let i = 0; i < 10; i++) odo.step({ x: 0, y: 0 }, 1, 0.001);
    heading += 0.01;
    odo.sample(heading);
  }
  assert.ok(Math.hypot(odo.pose.x, odo.pose.y) < 1e-6, `moved ${Math.hypot(odo.pose.x, odo.pose.y)} m`);
  assert.ok(Math.abs(odo.pose.heading - 2) < 1e-6, `turned to ${odo.pose.heading}`);
});

test('a pod offset the board does not know about makes turning in place move the pose', () => {
  // The board was told -0.08; the pod is really 6 cm further out.
  const odo = new Odometry({ quantise: false, lateralOffset: -0.08, offsetError: -0.06 });
  let heading = 0;
  for (let cycle = 0; cycle < 100; cycle++) {
    for (let i = 0; i < 10; i++) odo.step({ x: 0, y: 0 }, 1, 0.001);
    heading += 0.01;
    odo.sample(heading);
  }
  // One radian of rotation and 6 cm of unaccounted offset.
  assert.ok(Math.hypot(odo.pose.x, odo.pose.y) > 0.04, `only ${Math.hypot(odo.pose.x, odo.pose.y)} m`);
});

test('it follows the arc, not the chord', () => {
  // A quarter circle of radius 1 m, driven forward while turning.
  const arc = new Odometry({ quantise: false });
  const radius = 1;
  const omega = 1;
  let heading = 0;
  const steps = 1571; // ~pi/2 radians at 1 rad/s in 1 ms steps
  for (let cycle = 0; cycle < steps / 10; cycle++) {
    for (let i = 0; i < 10; i++) arc.step({ x: radius * omega, y: 0 }, omega, 0.001);
    heading += omega * 0.01;
    arc.sample(heading);
  }
  // A quarter turn about a centre 1 m to the left ends at (1, 1).
  assert.ok(Math.abs(arc.pose.x - 1) < 0.01, `x ${arc.pose.x}`);
  assert.ok(Math.abs(arc.pose.y - 1) < 0.01, `y ${arc.pose.y}`);
});

test('a yaw scalar two percent out is seven degrees out after four turns', () => {
  const odo = new Odometry({ quantise: false, yawScalar: 1.02 });
  let heading = 0;
  // One full turn: four right angles, in a hundred cycles of 10 ms.
  for (let cycle = 0; cycle < 100; cycle++) {
    for (let i = 0; i < 10; i++) odo.step({ x: 0, y: 0 }, Math.PI * 2, 0.001);
    heading += Math.PI * 2 * 0.01;
    odo.sample(heading);
  }
  // 2 percent of 360 is 7.2 degrees, which is where a wrapped pose ends up
  // after one full turn the board thinks was slightly longer than it was.
  const wrong = odo.pose.heading * (180 / Math.PI);
  assert.ok(Math.abs(wrong - 7.2) < 0.3, `out by ${wrong} degrees`);
});

test('three pods take their heading from the pods and not from the IMU', () => {
  const odo = new Odometry({ type: 'threePod', quantise: false, trackWidth: 0.3 });
  assert.ok(odo.forward2, 'there is a third pod');
  for (let cycle = 0; cycle < 100; cycle++) {
    for (let i = 0; i < 10; i++) odo.step({ x: 0, y: 0 }, 1, 0.001);
    // A wildly wrong IMU, which it must not be listening to.
    odo.sample(cycle * 0.5);
  }
  assert.ok(Math.abs(odo.pose.heading - 1) < 1e-6, `turned to ${odo.pose.heading}`);
});

// ------------------------------------------------------------ on the robot

test('a driven robot ends up where the odometry says, to within a couple of centimetres', () => {
  const sim = rig();
  drive(sim, ['KeyW'], 1.5);
  drive(sim, ['KeyQ'], 0.6);
  drive(sim, ['KeyW'], 1);
  for (let i = 0; i < 60; i++) sim.step(1 / 60);

  const truth = sim.robot.body;
  const error = sim.robot.odometry.error({
    x: truth.position.x,
    y: truth.position.y,
    heading: truth.rotation.radians,
  });
  assert.ok(sim.robot.stats.distanceTravelled > 0.5, 'it went somewhere');
  assert.ok(error.distance < 0.03, `drifted ${(error.distance / INCH).toFixed(2)} in`);
});

test('odometry beats the drive encoders, which is why teams fit it', () => {
  // Wheels slip; pods do not. Drive into a wall and the drive encoders book
  // travel that never happened, while the pods report roughly none.
  const sim = rig();
  const startX = -sim.field.halfSize + sim.robot.halfLength + 0.01;
  sim.placeRobot(startX, 0, Math.PI);
  drive(sim, ['KeyW'], 2);

  const perMetre =
    sim.robot.drivetrain.motors[0].encoder.ticksPerOutputRev /
    (2 * Math.PI * sim.config.drivetrain.wheelRadius);
  const wheelMetres =
    sim.robot.drivetrain.motors.reduce((total, m) => total + Math.abs(m.encoder.ticks), 0) /
    sim.robot.drivetrain.motors.length /
    perMetre;
  const trueMoved = Math.hypot(
    sim.robot.body.position.x - startX,
    sim.robot.body.position.y,
  );
  const podMetres = Math.hypot(
    sim.robot.odometry.pose.x - startX,
    sim.robot.odometry.pose.y,
  );

  assert.ok(trueMoved < 0.05, `the robot barely moved: ${trueMoved.toFixed(3)} m`);
  assert.ok(
    wheelMetres > 0.4,
    `the drive encoders should have booked a lot of travel, got ${wheelMetres.toFixed(3)} m`,
  );
  assert.ok(
    podMetres < wheelMetres / 5,
    `the pods should be far closer to the truth: ${podMetres.toFixed(3)} m of pods ` +
      `against ${wheelMetres.toFixed(3)} m of wheels`,
  );
});

test('a routine reads the pose in its own frame, and can tell it where it is', () => {
  const sim = rig();
  const error = sim.autoRunner.compile(`
    function init(robot) { robot.frame = 'ftc'; }
    function loop(robot) {
      const p = robot.odometry.pose;
      robot.telemetry.addData('x', p.x.toFixed(1));
      robot.telemetry.addData('y', p.y.toFixed(1));
      robot.telemetry.addData('fitted', robot.odometry.fitted);
      if (robot.time > 0.2 && !robot.telemetry.snapped) {
        robot.odometry.set({ x: 0, y: 0, heading: 0 });
        robot.telemetry.addData('snapped', 'yes');
      }
    }
  `);
  assert.equal(error, null);
  sim.enableGame({ alliance: 'red' }).start();
  sim.placeRobot(-48, 12, 0, 'ftc');
  for (let i = 0; i < 5; i++) sim.step(1 / 60);

  const t = sim.autoRunner.status().telemetry;
  assert.equal(t.fitted, 'true');
  assert.ok(Math.abs(Number(t.x) + 48) < 1, `x read ${t.x}`);
  assert.ok(Math.abs(Number(t.y) - 12) < 1, `y read ${t.y}`);

  for (let i = 0; i < 20; i++) sim.step(1 / 60);
  assert.equal(sim.autoRunner.status().telemetry.snapped, 'yes');
  assert.ok(Math.abs(sim.robot.odometry.pose.x) < 0.2, 'setPosition moved the estimate');
});

test('reading the pose costs one I2C transaction, and reading it apart costs three', () => {
  const thrifty = rig();
  thrifty.autoRunner.compile('function loop(robot) { const p = robot.odometry.pose; }');
  const wasteful = rig();
  wasteful.autoRunner.compile(
    'function loop(robot) { const x = robot.odometry.x, y = robot.odometry.y, h = robot.odometry.heading; }',
  );
  for (const sim of [thrifty, wasteful]) {
    sim.enableGame({ alliance: 'red' }).start();
    for (let i = 0; i < 30; i++) sim.step(1 / 60);
  }
  assert.equal(thrifty.robot.bus.lastCounts.i2c, 1);
  assert.equal(wasteful.robot.bus.lastCounts.i2c, 3);
});

test('with no pods fitted the API says so rather than making a pose up', () => {
  const sim = rig({ 'odometry.enabled': false });
  assert.equal(sim.robot.odometry.enabled, false);
  assert.equal(sim.telemetry().odometry, null);
  drive(sim, ['KeyW'], 0.5);
  assert.deepEqual(sim.robot.odometry.pose, { x: sim.startPose.x, y: sim.startPose.y, heading: sim.startPose.heading });
});

test('the odometry trail is sampled with the real one and cleared by a teleport', () => {
  const sim = rig();
  drive(sim, ['KeyW'], 1);
  assert.ok(sim.trail.length > 5, 'there is a trail');
  assert.equal(sim.odometryTrail.length, sim.trail.length, 'a point each, at the same moments');

  sim.placeRobot(1, 1, 0);
  assert.equal(sim.trail.length, 0);
  assert.equal(sim.odometryTrail.length, 0);
  assert.ok(Math.abs(sim.robot.odometry.pose.x - 1) < 1e-9, 'and the estimate came along');
});

test('moving a pod offset in the panel does not teleport the estimate', () => {
  const config = new Config();
  config.set('ai.enabled', false);
  const sim = new Simulation(config);
  sim.input.keyboardSource.active = true;
  drive(sim, ['KeyW'], 1);
  const at = { ...sim.robot.odometry.pose };
  config.set('odometry.forwardOffset', 0.12);
  assert.ok(Math.abs(sim.robot.odometry.pose.x - at.x) < 1e-9);
  assert.equal(sim.robot.odometry.lateral.x, 0.12, 'but the pod did move');
});
