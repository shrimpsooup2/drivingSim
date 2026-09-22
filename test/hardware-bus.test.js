import test from 'node:test';
import assert from 'node:assert/strict';
import { Config } from '../src/config/Config.js';
import { Simulation } from '../src/app/Simulation.js';
import { HardwareBus, HUB_TRANSACTION_MS } from '../src/hardware/HardwareBus.js';

function rig(overrides = {}) {
  const config = new Config();
  config.set('ai.enabled', false);
  for (const [path, value] of Object.entries(overrides)) config.set(path, value);
  return new Simulation(config);
}

test('a transaction costs what a hub transaction costs', () => {
  const bus = new HardwareBus();
  bus.beginCycle();
  bus.write();
  bus.i2c();
  bus.endCycle();
  assert.equal(
    Math.round(bus.lastSeconds * 1e6),
    Math.round((HUB_TRANSACTION_MS.write + HUB_TRANSACTION_MS.i2c) * 1000),
  );
  assert.deepEqual(bus.lastCounts, { write: 1, read: 0, bulkRead: 0, i2c: 1 });
});

test('one bulk read covers a pass over the sensors, and a second pass costs another', () => {
  const bus = new HardwareBus({ cachingMode: 'AUTO' });
  bus.beginCycle();
  for (const name of ['lf', 'rf', 'lb', 'rb']) bus.cachedRead(`${name}.position`);
  assert.equal(bus.lastCounts.bulkRead + bus.cycleCounts.bulkRead, 1, 'four encoders, one packet');
  assert.equal(bus.cycleCounts.read, 0, 'and no single reads at all');

  // Reading one of them again is the thing that expires the cache.
  bus.cachedRead('lf.position');
  assert.equal(bus.cycleCounts.bulkRead, 2);

  // Velocity is a different register in the same packet, so it is free.
  const before = bus.cycleCounts.bulkRead;
  bus.cachedRead('rf.velocity');
  assert.equal(bus.cycleCounts.bulkRead, before);
});

test('caching OFF makes every reading its own round trip', () => {
  const bus = new HardwareBus({ cachingMode: 'OFF' });
  bus.beginCycle();
  for (const name of ['lf', 'rf', 'lb', 'rb']) bus.cachedRead(`${name}.position`);
  bus.endCycle();
  assert.equal(bus.lastCounts.read, 4);
  assert.equal(bus.lastCounts.bulkRead, 0);
  assert.equal(
    Math.round(bus.lastSeconds * 1000),
    Math.round(4 * HUB_TRANSACTION_MS.read),
    'four reads, not one packet -- twice the cost of AUTO',
  );
});

test('MANUAL caching hands back the same packet until you clear it', () => {
  const bus = new HardwareBus({ cachingMode: 'MANUAL' });
  bus.beginCycle();
  bus.cachedRead('lf.position');
  assert.equal(bus.cycleCounts.bulkRead, 1, 'the first reading has to fetch one');
  for (let i = 0; i < 20; i++) bus.cachedRead('lf.position');
  assert.equal(bus.cycleCounts.bulkRead, 1, 'and every reading after it is free');

  bus.clearBulkCache();
  bus.cachedRead('lf.position');
  assert.equal(bus.cycleCounts.bulkRead, 2, 'clearing it is what costs');
});

test('the simulator reading its own devices is charged nothing', () => {
  const bus = new HardwareBus();
  bus.beginCycle();
  bus.own(() => {
    bus.write(10);
    bus.i2c();
    bus.cachedRead('lf.position');
    // Nested, as the renderer reaching through a subsystem into a motor is.
    bus.own(() => bus.write());
  });
  bus.endCycle();
  assert.equal(bus.lastSeconds, 0);
  assert.equal(bus.lastTransactions, 0);
  assert.equal(bus.exempt, false, 'and it hands the boundary back afterwards');
});

test('a repeated command is not a transaction', () => {
  const sim = rig();
  const controller = sim.robot.drivetrain.motors[0].controller;
  const bus = sim.robot.bus;

  bus.reset();
  controller.setPower(0.5);
  assert.equal(bus.counts.write, 1);
  controller.setPower(0.5);
  assert.equal(bus.counts.write, 1, 'the SDK skips a power it has already sent');
  controller.setPower(0.6);
  assert.equal(bus.counts.write, 2);
});

test('the loop rate is earned: driving costs four writes and an IMU reading', () => {
  const sim = rig();
  const bus = sim.robot.bus;

  // Sitting still with the sticks centred: nothing changes, so nothing is
  // written, and the loop is the IMU read plus the overhead.
  for (let i = 0; i < 30; i++) sim.step(1 / 60);
  const idle = sim.controlPeriod * 1000;
  assert.equal(bus.lastCounts.write, 0, 'no motor power changed');
  assert.equal(bus.lastCounts.i2c, 1, 'one IMU reading, which field-centric drive needs');
  assert.ok(
    Math.abs(idle - (5 + HUB_TRANSACTION_MS.i2c)) < 1e-6,
    `idle loop was ${idle.toFixed(2)} ms`,
  );

  // Now drive. While the acceleration ramp is moving, all four powers change
  // every cycle, and each one is its own transaction.
  sim.input.keyboardSource.active = true;
  sim.input.keyboardSource.keys.add('KeyW');
  let peak = 0;
  let writes = 0;
  for (let i = 0; i < 20; i++) {
    sim.step(1 / 60);
    peak = Math.max(peak, sim.controlPeriod * 1000);
    writes = Math.max(writes, bus.lastCounts.write);
  }
  assert.equal(writes, 4, 'four motors, four writes');
  assert.ok(
    peak > idle + 9,
    `driving should cost 10 ms more than idling, got ${peak.toFixed(1)} vs ${idle.toFixed(1)}`,
  );

  // And once the ramp has settled on a constant power there is nothing left to
  // send, so the loop speeds back up. This is real, and it is why a loop time
  // measured while standing still is not the loop time that matters.
  for (let i = 0; i < 120; i++) sim.step(1 / 60);
  assert.equal(bus.lastCounts.write, 0, 'the same power twice is one transaction');
  assert.ok(sim.controlPeriod * 1000 < peak - 9);
});

test('reading the same sensor four times a cycle really does slow the loop down', () => {
  const thrifty = rig();
  thrifty.autoRunner.compile(`
    function loop(robot) {
      const h = robot.imu.heading;
      robot.drive(0.4, 0, h * 0);
    }
  `);
  const wasteful = rig();
  wasteful.autoRunner.compile(`
    function loop(robot) {
      let h = 0;
      for (let i = 0; i < 4; i++) h += robot.imu.heading;
      robot.drive(0.4, 0, h * 0);
    }
  `);

  for (const sim of [thrifty, wasteful]) {
    sim.enableGame({ alliance: 'red' }).start();
    for (let i = 0; i < 60; i++) sim.step(1 / 60);
  }

  assert.equal(thrifty.robot.bus.lastCounts.i2c, 1);
  assert.equal(wasteful.robot.bus.lastCounts.i2c, 4);
  assert.ok(
    wasteful.controlPeriod > thrifty.controlPeriod + 0.007,
    `${(wasteful.controlPeriod * 1000).toFixed(1)} ms vs ${(thrifty.controlPeriod * 1000).toFixed(1)} ms`,
  );
});

test('switching hub latency off goes back to the rate in the panel', () => {
  const sim = rig({ 'control.hub.latency': false, 'control.loopRateHz': 40 });
  assert.equal(sim.robot.bus.enabled, false);
  for (let i = 0; i < 30; i++) sim.step(1 / 60);
  assert.equal(Math.round(sim.controlPeriod * 1000), 25, '40 Hz is a 25 ms period');
  // Transactions are still counted, so the inspector still has something to show.
  assert.ok(sim.robot.bus.counts.i2c > 0);
  assert.equal(sim.robot.bus.totalSeconds, 0, 'they just cost nothing');
});

test('a changed transaction cost reaches a running robot', () => {
  const config = new Config();
  config.set('ai.enabled', false);
  const sim = new Simulation(config);
  config.set('control.hub.i2cMs', 10);
  for (let i = 0; i < 30; i++) sim.step(1 / 60);
  assert.equal(sim.robot.bus.i2cMs, 10);
  assert.equal(Math.round(sim.controlPeriod * 1000), 15, '5 ms of overhead plus a 10 ms reading');
});

test('an AI robot is not charged for anything', () => {
  const config = new Config();
  config.set('ai.enabled', true);
  const sim = new Simulation(config);
  const game = sim.enableGame({ alliance: 'red' }).start();
  for (let i = 0; i < 60; i++) sim.step(1 / 60);
  assert.ok(sim.opponents.length > 0, 'the roster put robots on the field');
  for (const opponent of sim.opponents) {
    assert.equal(opponent.robot.bus.totalSeconds, 0);
    assert.equal(opponent.robot.bus.counts.write, 0, 'nobody is writing code for it');
  }
  assert.ok(game.match.phase);
});

test('the routine can see its own loop time and clear the cache', () => {
  const sim = rig({ 'control.hub.cachingMode': 'MANUAL' });
  const error = sim.autoRunner.compile(`
    function loop(robot) {
      robot.hub.clearBulkCache();
      const e = robot.encoders;
      robot.telemetry.addData('loop', robot.hub.loopMs.toFixed(1));
      robot.telemetry.addData('io', robot.hub.ioMs.toFixed(1));
      robot.telemetry.addData('calls', robot.hub.transactions);
      robot.telemetry.addData('mode', robot.hub.cachingMode);
      robot.telemetry.addData('ticks', Object.keys(e).length);
    }
  `);
  assert.equal(error, null);
  sim.enableGame({ alliance: 'red' }).start();
  for (let i = 0; i < 60; i++) sim.step(1 / 60);

  const t = sim.autoRunner.status().telemetry;
  assert.equal(t.mode, 'MANUAL');
  assert.equal(t.ticks, 4, 'four encoders came back');
  assert.ok(Number(t.io) > 0, 'and reading them cost something');
  assert.ok(Number(t.loop) >= Number(t.io), 'the loop is the I/O plus the overhead');
  assert.equal(sim.robot.bus.lastCounts.bulkRead, 1, 'cleared once, fetched once');
});
