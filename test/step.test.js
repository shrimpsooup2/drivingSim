import test from 'node:test';
import assert from 'node:assert/strict';
import { Config } from '../src/config/Config.js';
import { Simulation } from '../src/app/Simulation.js';

function rig(overrides = {}) {
  const config = new Config();
  config.set('ai.enabled', false);
  for (const [path, value] of Object.entries(overrides)) config.set(path, value);
  const sim = new Simulation(config);
  // Driving, so a step that advanced nothing is visible as a robot that did
  // not move. Through the keyboard rather than `driveNormalized`, because the
  // op-mode rewrites the motor commands from the sticks on every cycle.
  sim.input.keyboardSource.active = true;
  sim.input.keyboardSource.keys.add('KeyW');
  return sim;
}

test('a pause with no budget freezes the clock', () => {
  const sim = rig();
  for (let i = 0; i < 10; i++) sim.step(1 / 60);
  sim.pause(true);
  assert.equal(sim.frozen, true);
  const at = sim.time;
  for (let i = 0; i < 10; i++) sim.step(1 / 60);
  assert.equal(sim.time, at, 'nothing advanced');
});

test('a step advances exactly its budget and freezes again', () => {
  const sim = rig();
  for (let i = 0; i < 10; i++) sim.step(1 / 60);
  const at = sim.time;

  sim.stepFor(0.001);
  assert.equal(sim.paused, true, 'stepping pauses, so the buttons work while running');
  assert.equal(sim.frozen, false, 'and there is a budget to spend');
  sim.step(1 / 60);

  assert.ok(Math.abs(sim.time - (at + 0.001)) < 1e-9, `advanced to ${sim.time - at}`);
  assert.equal(sim.frozen, true, 'and it is frozen again');
  assert.equal(sim.stepRemaining, 0);
});

test('a step does not run for the length of a frame', () => {
  const stepped = rig();
  const running = rig();
  for (const sim of [stepped, running]) for (let i = 0; i < 10; i++) sim.step(1 / 60);
  const before = { stepped: stepped.robot.body.speed, running: running.robot.body.speed };

  stepped.stepFor(0.001);
  stepped.step(1 / 60);
  running.step(1 / 60);

  // One millisecond of acceleration against sixteen.
  const gained = {
    stepped: stepped.robot.body.speed - before.stepped,
    running: running.robot.body.speed - before.running,
  };
  assert.ok(
    gained.running > gained.stepped * 8,
    `stepped gained ${gained.stepped.toFixed(4)}, ran gained ${gained.running.toFixed(4)}`,
  );
});

test('a 100 ms step is not cut short by the frame budget', () => {
  const sim = rig();
  for (let i = 0; i < 10; i++) sim.step(1 / 60);
  const at = sim.time;
  // Longer than sim.maxFrameSeconds, which is what bounds an ordinary frame.
  assert.ok(0.1 > sim.config.sim.maxFrameSeconds, 'the point of the test');
  sim.stepFor(0.1);
  sim.step(1 / 60);
  assert.ok(Math.abs(sim.time - (at + 0.1)) < 1e-9, `advanced ${(sim.time - at) * 1000} ms`);
});

test('asking for another step replaces what was left rather than queueing it', () => {
  const sim = rig();
  sim.stepFor(0.1);
  sim.stepFor(0.005);
  assert.ok(Math.abs(sim.stepRemaining - 0.005) < 1e-9);
  const at = sim.time;
  sim.step(1 / 60);
  assert.ok(Math.abs(sim.time - (at + 0.005)) < 1e-9);
});

test('a budget comes out in whole substeps, and comes out exactly', () => {
  // The reason the budget is a substep count and not a deadline: 100 ms is 200
  // substeps of 0.5 ms right up until floating-point subtraction leaves the
  // accumulator a hair under one substep, and then the last one slips into the
  // next frame.
  const sim = rig({ 'sim.substepHz': 300 });
  const h = 1 / 300;
  for (let i = 0; i < 10; i++) sim.step(1 / 60);

  const at = sim.time;
  sim.stepFor(h * 2.4);
  assert.equal(sim.stepRemaining, h * 2, 'rounded to the nearest substep');
  sim.step(1 / 60);
  assert.ok(Math.abs(sim.time - (at + h * 2)) < 1e-12, `advanced ${(sim.time - at) / h} substeps`);
  assert.equal(sim.frozen, true, 'all in one frame');
  sim.step(1 / 60);
  assert.ok(Math.abs(sim.time - (at + h * 2)) < 1e-12, 'and nothing more happened');

  // Smaller than one substep still does one, or the button is dead at low
  // substep rates.
  sim.stepFor(h / 10);
  assert.equal(sim.stepRemaining, h);
});

test('a cycle step is one op-mode loop, and the loop rate sets its length', () => {
  const sim = rig();
  for (let i = 0; i < 30; i++) sim.step(1 / 60);
  const period = sim.controlPeriod;
  const at = sim.time;
  sim.stepOneCycle();
  assert.ok(Math.abs(sim.stepRemaining - period) < 1e-9);
  sim.step(1 / 60);
  assert.ok(Math.abs(sim.time - (at + period)) < 1e-9);
});

test('the op-mode is frozen with the world, not left running', () => {
  const sim = rig();
  sim.autoRunner.compile('function loop(robot, dt) { robot.telemetry.addData("n", (Number(robot.telemetry.n) || 0) + 1); }');
  sim.enableGame({ alliance: 'red' }).start();
  for (let i = 0; i < 20; i++) sim.step(1 / 60);
  const cycles = Number(sim.autoRunner.status().telemetry.n);
  assert.ok(cycles > 0, 'the routine was running');

  sim.pause(true);
  for (let i = 0; i < 30; i++) sim.step(1 / 60);
  assert.equal(Number(sim.autoRunner.status().telemetry.n), cycles, 'and it stopped with the world');
});

test('resuming clears the budget rather than leaving one armed', () => {
  const sim = rig();
  sim.stepFor(0.05);
  sim.pause(false);
  assert.equal(sim.stepRemaining, 0);
  assert.equal(sim.frozen, false);
  const at = sim.time;
  sim.step(1 / 60);
  assert.ok(sim.time > at + 0.01, 'a full frame ran, not 50 ms of step');
});

test('resetting the robot throws the budget away', () => {
  const sim = rig();
  sim.stepFor(0.05);
  sim.resetRobot();
  assert.equal(sim.stepRemaining, 0);
});
