import test from 'node:test';
import assert from 'node:assert/strict';
import { Config } from '../src/config/Config.js';
import { Simulation } from '../src/app/Simulation.js';
import { Intake } from '../src/robot/biobuzz/Intake.js';
import { Launcher } from '../src/robot/biobuzz/Launcher.js';
import {
  NECTAR_PER_ALLIANCE,
  POLLEN_COUNT,
  PRELOAD_POLLEN,
} from '../src/field/biobuzz/constants.js';

function newSim() {
  const sim = new Simulation(new Config());
  return sim;
}

test('enabling the game stages a full FIELD and a legal ROBOT', () => {
  const sim = newSim();
  const game = sim.enableGame({ alliance: 'red' }).start();

  assert.equal(game.field.allBalls.length, POLLEN_COUNT + NECTAR_PER_ALLIANCE * 2);
  assert.equal(game.participants.length, 1);
  assert.equal(game.intake.count, PRELOAD_POLLEN, 'four pre-load POLLEN, per G304.G');

  const check = game.match.checkStartingPosition(sim.robot, 'red');
  assert.ok(check.legal, `expected a legal start, got ${check.reasons.join('; ')}`);
});

test('the game comes off the simulation cleanly', () => {
  const sim = newSim();
  const before = sim.field.elements.length;
  const game = sim.enableGame().start();
  assert.ok(sim.field.elements.length > before);
  assert.ok(sim.robot.subsystems.length >= 2);
  const mass = sim.robot.body.mass;

  sim.disableGame();
  assert.equal(sim.game, null);
  assert.equal(sim.field.elements.length, before, 'the HIVE and FLOWERS are gone');
  assert.equal(
    sim.robot.subsystems.filter((s) => s instanceof Intake || s instanceof Launcher).length,
    0,
    'and so are the mechanisms',
  );
  assert.ok(sim.robot.body.mass < mass, 'the carried POLLEN went with them');
  assert.ok(game.participants.length === 0);
});

test('enabling the game twice is the same game', () => {
  const sim = newSim();
  const first = sim.enableGame();
  const second = sim.enableGame();
  assert.equal(first, second);
  assert.equal(sim.robot.subsystems.filter((s) => s instanceof Intake).length, 1);
});

test('opponents the user added are kept, and get an intake of their own', () => {
  const sim = newSim();
  sim.addOpponent({
    profileId: 'rival',
    skillId: 'competent',
    behavior: 'chaser',
    start: { x: 1, y: 0, heading: Math.PI },
  });
  const game = sim.enableGame({ alliance: 'red' }).start();

  assert.equal(sim.opponents.length, 1, 'switching the game on must not clear them');
  assert.equal(game.participants.length, 2);
  const opponent = game.participants[1];
  assert.equal(opponent.alliance, 'blue', 'an opponent goes on the other side');
  assert.ok(opponent.intake instanceof Intake);
  assert.equal(opponent.intake.count, PRELOAD_POLLEN);
  const check = game.match.checkStartingPosition(opponent.robot, opponent.alliance);
  assert.ok(check.legal, `opponent staged illegally: ${check.reasons.join('; ')}`);
});

test('a drill is dropped when the game starts, but a bare field is left alone', () => {
  const sim = newSim();
  sim.challenges.select(sim.challenges.available()[0].id);
  assert.ok(sim.challenges.active);
  sim.enableGame();
  assert.equal(sim.challenges.active, null, 'a drill owns its own obstacles');

  const other = newSim();
  other.addOpponent({
    profileId: 'rival',
    skillId: 'competent',
    behavior: 'chaser',
    start: { x: 1, y: 0, heading: Math.PI },
  });
  other.enableGame();
  assert.equal(other.opponents.length, 1);
});

test('a full MATCH runs through the simulation without anything escaping', () => {
  const sim = newSim();
  const game = sim.enableGame({ alliance: 'red' }).start();

  let frames = 0;
  while (game.match.phase !== 'ended' && frames < 20000) {
    sim.step(1 / 60);
    frames++;
  }
  assert.equal(game.match.phase, 'ended');
  assert.ok(
    Math.abs(game.match.matchClock - game.match.totalSeconds) < 0.5,
    `match clock ${game.match.matchClock.toFixed(2)} should land on ${game.match.totalSeconds}`,
  );

  for (const ball of game.field.allBalls) {
    assert.ok(ball.isFinite(), `${ball.id} diverged`);
    if (!ball.free) continue;
    assert.ok(Math.abs(ball.x) <= game.field.ballWorld.halfSize + 1e-3);
    assert.ok(Math.abs(ball.y) <= game.field.ballWorld.halfSize + 1e-3);
    assert.ok(ball.z >= ball.radius - 1e-3, `${ball.id} fell through the tiles`);
  }

  // Nothing may be held by two containers at once.
  const owners = new Map();
  const claim = (ball) => owners.set(ball, (owners.get(ball) ?? 0) + 1);
  for (const alliance of ['red', 'blue']) {
    for (const ball of game.field.hives[alliance].foreBalls) claim(ball);
    for (const ball of game.field.hives[alliance].aftBalls) claim(ball);
  }
  for (const flower of game.field.flowers) for (const ball of flower.stack) claim(ball);
  for (const entry of game.participants) for (const ball of entry.intake.held) claim(ball);
  assert.equal(
    [...owners.values()].filter((n) => n > 1).length,
    0,
    'a ball ended up in two containers',
  );
});

test('telemetry gives the HUD everything it needs', () => {
  const sim = newSim();
  const game = sim.enableGame({ alliance: 'red' }).start();
  const t = game.telemetry();

  assert.equal(t.alliance, 'red');
  assert.equal(t.phase, 'auto');
  assert.ok(t.teleopRemaining > 0);
  assert.equal(t.flowerUnlocked, false);
  assert.equal(t.held, PRELOAD_POLLEN);
  assert.ok('rpm' in t.shooter && 'ready' in t.shooter && 'hoodDegrees' in t.shooter);
  for (const alliance of ['red', 'blue']) {
    for (const key of ['leave', 'parkAuto', 'parkTeleop', 'tipPoints', 'cell', 'flower', 'bottomNectar', 'garden', 'total']) {
      assert.equal(typeof t.score[alliance][key], 'number', `${alliance}.${key}`);
    }
  }
});

test('the whole intake to launcher to CELL loop works through the game', () => {
  const sim = newSim();
  const game = sim.enableGame({ alliance: 'red' }).start();
  const target = game.field.hiveTarget('red');

  sim.robot.reset(target.x, target.y - 1.5, Math.PI / 2);
  // reset() clears the subsystems, so re-load after moving.
  game.loadPreloads();
  assert.ok(game.intake.count > 0);

  assert.ok(game.aimAtHive(), 'the shot from 1.5 m is solvable');
  game.launcher.spinning = true;
  while (!game.launcher.ready) game.launcher.applyForces(1 / 1000, 12.5);

  const before = game.field.hives.red.elementsInUpCell();
  game.launcher.fire();
  game.launcher.applyForces(1 / 1000, 12.5);

  let landed = false;
  for (let i = 0; i < 2000 && !landed; i++) {
    game.update(1 / 500);
    landed = game.field.hives.red.elementsInUpCell() > before;
  }
  assert.ok(landed, 'a shot fed from the intake lands in the CELL');
});

test('a drill runs on a bare field and the game comes back afterwards', () => {
  // A driver should be able to dip into a drill and return to the match.
  // The drill lays out its own course, and 56 SCORING ELEMENTS rolling around
  // a slalom is not the drill.
  const sim = newSim();
  sim.enableGame({ alliance: 'red' }).start();
  const solids = sim.field.elements.length;
  assert.ok(solids > 0);

  sim.challenges.select(sim.challenges.available()[0].id);
  assert.equal(sim.game, null, 'the game steps aside for a drill');
  assert.equal(
    sim.robot.subsystems.filter((s) => s instanceof Intake || s instanceof Launcher).length,
    0,
    'and takes its mechanisms with it',
  );

  sim.challenges.clear();
  assert.ok(sim.game, 'and comes back when the drill is cleared');
  assert.equal(sim.field.elements.length, solids);
  assert.equal(sim.game.intake.count, PRELOAD_POLLEN, 'restaged, with its pre-load');
});

test('loading a second drill does not lose the fact the game was running', () => {
  const sim = newSim();
  sim.enableGame().start();
  const drills = sim.challenges.available();

  sim.challenges.select(drills[0].id);
  sim.challenges.select(drills[1].id);
  assert.equal(sim.game, null);

  sim.challenges.clear();
  assert.ok(sim.game, 'two drills in a row still restores the game');
});

test('a drill loaded with no game running leaves it off', () => {
  const sim = newSim();
  assert.equal(sim.game, null);
  sim.challenges.select(sim.challenges.available()[0].id);
  sim.challenges.clear();
  assert.equal(sim.game, null, 'nothing to restore');
});
