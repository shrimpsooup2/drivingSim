import test from 'node:test';
import assert from 'node:assert/strict';
import { Config } from '../src/config/Config.js';
import { Simulation } from '../src/app/Simulation.js';
import { AutoRunner } from '../src/teleop/AutoRunner.js';
import { EXAMPLE_AUTO } from '../src/teleop/autoExample.js';

function rig(opts = {}) {
  const config = new Config();
  config.set('ai.enabled', false);
  const sim = new Simulation(config);
  const game = sim.enableGame({ alliance: 'red', ...opts });
  return { sim, game };
}

test('a pasted routine compiles and takes the ROBOT during AUTO', () => {
  const { sim, game } = rig();
  assert.equal(sim.autoRunner.armed, false, 'nothing loaded, nothing armed');

  const error = sim.autoRunner.compile('function* auto(robot) { robot.drive(0.5, 0, 0); yield 1; }');
  assert.equal(error, null);
  assert.equal(sim.autoRunner.armed, true);

  game.start();
  assert.equal(sim.runningAuto, true, 'the routine has the ROBOT in AUTO');
  const startX = sim.robot.body.position.x;
  for (let i = 0; i < 30; i++) sim.step(1 / 60);
  assert.ok(sim.robot.body.position.x > startX + 0.05, 'and it is driving');

  // Not in TELEOP: the driver gets it back.
  for (let i = 0; i < 60 * 40 && game.match.phase !== 'teleop'; i++) sim.step(1 / 60);
  assert.equal(game.match.phase, 'teleop');
  assert.equal(sim.runningAuto, false);
});

test('a syntax error is reported rather than thrown at the frame loop', () => {
  const runner = new AutoRunner();
  const error = runner.compile('function* auto(robot) { yield 1;');
  assert.ok(error, 'it reports something');
  assert.match(error, /SyntaxError|Unexpected/);
  assert.equal(runner.armed, false);
  assert.equal(runner.status().state, 'error');
});

test('a routine with no entry point says so', () => {
  const runner = new AutoRunner();
  const error = runner.compile('const x = 1;');
  assert.match(error, /auto\(robot\)|loop\(robot/);
  assert.equal(runner.armed, false);
});

test('a routine that throws mid-run stops the ROBOT and reports where', () => {
  const { sim, game } = rig();
  sim.autoRunner.compile(`
    function* auto(robot) {
      robot.drive(1, 0, 0);
      yield 0.1;
      robot.nope.deeper();
    }
  `);
  game.start();
  for (let i = 0; i < 30; i++) sim.step(1 / 60);

  const status = sim.autoRunner.status();
  assert.equal(status.state, 'error');
  assert.match(status.error, /TypeError/);
  assert.ok(
    sim.robot.drivetrain.commandedEffort < 0.05,
    'and it is not left driving into the wall',
  );
});

test('yield takes a number of seconds, a predicate, or one cycle', () => {
  const { sim, game } = rig();
  // Each stage logs the time it reached, so the assertions are about the
  // *contract* rather than about how many frames it takes to get there.
  sim.autoRunner.compile(`
    function* auto(robot) {
      robot.log('start ' + robot.time.toFixed(3));
      yield 0.5;
      robot.log('after-seconds ' + robot.time.toFixed(3));
      yield () => robot.time > 1.0;
      robot.log('after-predicate ' + robot.time.toFixed(3));
      const before = robot.time;
      yield;
      robot.log('after-cycle ' + (robot.time - before).toFixed(3));
    }
  `);
  game.start();
  for (let i = 0; i < 120; i++) sim.step(1 / 60);

  const log = sim.autoRunner.status().log;
  const at = (tag) => {
    const line = log.find((l) => l.startsWith(tag));
    assert.ok(line, `${tag} never happened; log was ${log.join(' | ')}`);
    return Number(line.split(' ')[1]);
  };

  // A number of seconds waits that long.
  assert.ok(at('start') < 0.05, 'it starts immediately');
  assert.ok(
    Math.abs(at('after-seconds') - 0.5) < 0.04,
    `yield 0.5 resumed at ${at('after-seconds')}`,
  );
  // A predicate waits until it holds, and not a moment longer. `>=` rather
  // than `>` because it resumes on the very cycle the condition turns true,
  // which for `time > 1.0` is a time that rounds to exactly 1.000.
  assert.ok(
    at('after-predicate') >= 1.0 && at('after-predicate') < 1.05,
    `the predicate resumed at ${at('after-predicate')}`,
  );
  // A bare yield is one op-mode cycle, which is 20 ms.
  const cycle = at('after-cycle');
  assert.ok(cycle > 0 && cycle < 0.05, `a bare yield cost ${cycle} s`);
  assert.equal(sim.autoRunner.status().state, 'done');
});

test('timed waits do not accumulate the op-mode period as drift', () => {
  const { sim, game } = rig();
  // Ten tenths of a second. Each wait lands mid-cycle, so without carrying the
  // overshoot the routine would finish up to 200 ms late -- a third of a metre
  // of drive at 1.5 m/s, which is the difference between a working auto and a
  // wasted one.
  sim.autoRunner.compile(`
    function* auto(robot) {
      for (let i = 0; i < 10; i++) yield 0.1;
      robot.telemetry.addData('finished', robot.time.toFixed(3));
    }
  `);
  game.start();
  for (let i = 0; i < 120; i++) sim.step(1 / 60);

  const finished = Number(sim.autoRunner.telemetry.finished);
  assert.ok(Number.isFinite(finished), 'it finished');
  assert.ok(
    Math.abs(finished - 1.0) < 0.05,
    `ten 0.1 s waits took ${finished.toFixed(3)} s`,
  );
});

test('a loop(robot, dt) routine runs every cycle', () => {
  const { sim, game } = rig();
  sim.autoRunner.compile(`
    let cycles = 0;
    let elapsed = 0;
    function loop(robot, dt) {
      cycles += 1;
      elapsed += dt;
      robot.telemetry.addData('cycles', cycles);
      robot.telemetry.addData('elapsed', elapsed.toFixed(3));
      robot.drive(elapsed < 0.4 ? 0.5 : 0, 0, 0);
    }
  `);
  game.start();
  for (let i = 0; i < 60; i++) sim.step(1 / 60);

  const cycles = Number(sim.autoRunner.telemetry.cycles);
  assert.ok(cycles > 20, `ran ${cycles} times in a second`);
  assert.ok(Math.abs(Number(sim.autoRunner.telemetry.elapsed) - 1) < 0.1);
});

test('compiling cannot move the ROBOT, even from the top level', () => {
  const { sim } = rig();
  const before = { ...sim.robot.body.position };
  // Top-level code runs at compile time -- that is how `auto` gets defined --
  // so it is handed a stub with no ROBOT behind it.
  const error = sim.autoRunner.compile(`
    robot.drive(1, 0, 0);
    robot.intake(1);
    function* auto(robot) { yield; }
  `);
  assert.equal(error, null, 'it still compiles');
  assert.equal(sim.robot.drivetrain.commandedEffort, 0);
  assert.equal(sim.robot.body.position.x, before.x);
});

test('the ROBOT is not driven by the sticks during AUTO (G401)', () => {
  const { sim, game } = rig();
  sim.autoRunner.compile('function* auto(robot) { yield 30; }');
  game.start();

  // Hold full forward on the gamepad. With a routine loaded it must do nothing,
  // and the REFEREE must not call G401 either -- nobody is touching anything.
  for (let i = 0; i < 60; i++) {
    sim.input.keyboardSource.keys.add('KeyW');
    sim.input.keyboardSource.active = true;
    sim.step(1 / 60);
  }
  assert.ok(
    sim.robot.body.speed < 0.05,
    `the sticks moved it at ${sim.robot.body.speed.toFixed(2)} m/s`,
  );
  assert.equal(
    game.match.referee.citations.filter((c) => c.rule === 'G401').length,
    0,
    'and a routine driving is not a DRIVE TEAM touching the controls',
  );
});

test('the example routine scores a real AUTO on both alliances', () => {
  for (const alliance of ['red', 'blue']) {
    const { sim, game } = rig({ alliance });
    assert.equal(sim.autoRunner.compile(EXAMPLE_AUTO), null, `${alliance} compiles`);
    game.start();
    for (let i = 0; i < 60 * 31; i++) sim.step(1 / 60);

    const status = sim.autoRunner.status();
    assert.equal(status.state, 'done', `${alliance}: ${status.error ?? ''}`);
    const score = game.match.score()[alliance];
    assert.ok(score.leave > 0, `${alliance} earned LEAVE`);
    assert.ok(score.parkAuto > 0, `${alliance} parked`);
    assert.ok(
      score.total >= 20,
      `${alliance} scored ${score.total}: leave ${score.leave}, park ${score.parkAuto}, ` +
        `tips ${score.tips}, cell ${score.cell}`,
    );
    assert.equal(
      game.match.referee.citations.length,
      0,
      `${alliance} broke a rule: ${game.match.referee.citations.map((c) => c.rule).join(', ')}`,
    );
  }
});

test('resetting the MATCH re-runs the routine without recompiling', () => {
  const { sim, game } = rig();
  sim.autoRunner.compile(`
    function* auto(robot) {
      robot.drive(0.5, 0, 0);
      yield 0.3;
      robot.drive(0, 0, 0);
      robot.telemetry.addData('ran', 'yes');
    }
  `);
  game.start();
  for (let i = 0; i < 40; i++) sim.step(1 / 60);
  assert.equal(sim.autoRunner.status().state, 'done');

  game.start();
  assert.equal(sim.autoRunner.status().state, 'compiled', 'armed again, not re-run yet');
  assert.equal(sim.autoRunner.armed, true, 'and still compiled');
  for (let i = 0; i < 40; i++) sim.step(1 / 60);
  assert.equal(sim.autoRunner.status().state, 'done');
});
