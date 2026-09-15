import test from 'node:test';
import assert from 'node:assert/strict';
import { Config } from '../src/config/Config.js';
import { Simulation } from '../src/app/Simulation.js';
import { Intake } from '../src/robot/biobuzz/Intake.js';
import { Launcher } from '../src/robot/biobuzz/Launcher.js';
import {
  FIELD_INNER_HALF,
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

test('the trajectory guide agrees with where the ball actually goes', () => {
  // The guide is only worth drawing if it is the same parabola the ball world
  // integrates. So: ask the guide, then fire, and require them to agree -- at
  // several ranges, and with the wheel deliberately short as well as ready.
  const sim = newSim();
  const game = sim.enableGame({ alliance: 'red' }).start();
  const hive = game.field.hives.red;
  const target = game.field.hiveTarget('red');

  // Real spots on the tiles, not a standoff measured along the CELL's normal:
  // straight out along the arm from the raised CELL is outside the perimeter,
  // and a shot from a position the ROBOT cannot occupy proves nothing.
  const SPOTS = [
    [-1.3, -1.4],
    [0.6, -1.4],
    [1.2, -1.3],
  ];
  const setUp = ([x, y]) => {
    sim.robot.reset(x, y, Math.atan2(target.y - y, target.x - x));
    sim.robot.body.velocity.set(0, 0);
    sim.robot.body.angularVelocity = 0;
    game.loadPreloads();
    return game.aimAtHive();
  };
  const spinTo = (fraction) => {
    game.launcher.spinning = true;
    game.launcher.omega = (game.launcher.targetRpm * fraction * 2 * Math.PI) / 60;
  };
  // `launch` rather than `_tryShoot`, because `_tryShoot` refuses to fire
  // until the wheel is ready -- which is the right behaviour and also means the
  // "fired too early" case cannot be reached through it. Going straight to
  // `launch` is the same code path a real shot takes, minus that one gate, so
  // the question stays "at this wheel speed, do the guide and the ball agree".
  const fireAndWatch = () => {
    const before = hive.elementsInUpCell();
    const ball = game.intake.take();
    assert.ok(ball, 'the launcher should have had something to fire');
    game.launcher.launch(ball);
    for (let i = 0; i < 2000; i++) {
      game.update(1 / 500);
      if (hive.elementsInUpCell() > before) return true;
    }
    return false;
  };

  for (const spot of SPOTS) {
    const where = `(${spot[0]}, ${spot[1]})`;
    assert.ok(setUp(spot), `the shot from ${where} is solvable`);
    assert.ok(
      Math.max(Math.abs(spot[0]), Math.abs(spot[1])) <
        FIELD_INNER_HALF - sim.robot.halfLength,
      `${where} has to be somewhere the ROBOT actually fits`,
    );
    spinTo(1);
    const [arc] = game.shotPreview('live');
    assert.ok(arc, 'a spun-up launcher has a trajectory');
    assert.ok(arc.points.length > 8, 'and enough points to draw');
    const predicted = arc.hit;
    const actual = fireAndWatch();
    assert.equal(
      predicted,
      actual,
      `from ${where} the guide said ${predicted ? 'hit' : 'miss'} and the ball ${actual ? 'went in' : 'did not'}`,
    );
    assert.ok(predicted, `a solved, spun-up shot from ${where} should score`);
    game.start();
  }

  // Firing at 80 percent of target is the mistake the guide exists to show.
  assert.ok(setUp(SPOTS[0]));
  spinTo(0.8);
  const [short] = game.shotPreview('live');
  assert.equal(short.hit, false, 'a shot taken before the wheel recovers misses');
  assert.equal(fireAndWatch(), false, 'and really does miss');

  // With the wheel short, the solved arc still scores -- that gap is the point.
  game.start();
  assert.ok(setUp(SPOTS[0]));
  spinTo(0.8);
  const both = game.shotPreview('both');
  assert.equal(both.length, 2);
  assert.equal(both.find((a) => a.kind === 'live').hit, false);
  assert.equal(both.find((a) => a.kind === 'solution').hit, true);

  // And the arc carries the ROBOT's own velocity, so a shot taken while
  // sliding sideways visibly swings off the CELL -- the other thing the guide
  // is for, and the harder one to believe without seeing it.
  game.start();
  assert.ok(setUp(SPOTS[0]));
  spinTo(1);
  assert.equal(game.shotPreview('live')[0].hit, true, 'standing still, it goes in');
  sim.robot.body.velocity.set(1.6, 0);
  assert.equal(
    game.shotPreview('live')[0].hit,
    false,
    'sliding sideways at 1.6 m/s, the same shot misses',
  );
  assert.equal(fireAndWatch(), false, 'and the ball really does miss');
});

test('the guide uses the same aperture test the HIVE does', () => {
  // Two copies of "is this in the CELL" is how a guide draws a hit on a shot
  // the HIVE then refuses, so there is only one, and this is it.
  const sim = newSim();
  const game = sim.enableGame({ alliance: 'red' }).start();
  const hive = game.field.hives.red;
  const centre = hive.cellOpening(hive.up);

  assert.ok(hive.openingContains(hive.up, centre.x, centre.y, centre.z));
  // A foot to the side of a 20 in wide opening is outside it.
  assert.ok(!hive.openingContains(hive.up, centre.x + 0.305, centre.y, centre.z));
  // And the plane's own sign convention: outside is positive.
  const n = hive.openingNormal(hive.up);
  assert.ok(hive.openingDepth(hive.up, centre.x, centre.y + n.y * 0.2, centre.z + n.z * 0.2) > 0);
  assert.ok(hive.openingDepth(hive.up, centre.x, centre.y - n.y * 0.2, centre.z - n.z * 0.2) < 0);
  assert.ok(Math.abs(hive.openingDepth(hive.up, centre.x, centre.y, centre.z)) < 1e-12);
});

test('match settings come from the config, and apply to a running MATCH', () => {
  const config = new Config();
  config.set('match.autoSeconds', 5);
  config.set('match.teleopSeconds', 40);
  config.set('match.flowerUnlockRemaining', 40);
  const sim = new Simulation(config);
  const game = sim.enableGame().start();

  assert.equal(game.match.autoSeconds, 5);
  assert.equal(game.match.teleopSeconds, 40);
  assert.equal(game.match.totalSeconds, 5 + 8 + 40);

  // Changing a period mid-match takes effect there and then.
  config.set('match.teleopSeconds', 90);
  assert.equal(game.match.teleopSeconds, 90);

  // FLOWERS opening for the whole of TELEOP is how you drill the endgame.
  config.set('match.flowerUnlockRemaining', 90);
  for (let i = 0; i < 40; i++) game.update(0.5);
  assert.equal(game.match.phase, 'teleop');
  assert.ok(game.match.flowerUnlocked, 'the FLOWERS are open from the start');
});

test('starting in TELEOP skips AUTO without awarding it', () => {
  const config = new Config();
  config.set('match.startPhase', 'teleop');
  const sim = new Simulation(config);
  const game = sim.enableGame().start();

  assert.equal(game.match.phase, 'teleop');
  assert.equal(game.match.teleopRemaining, game.match.teleopSeconds);
  // The AUTO period is treated as having happened with nothing moving, so the
  // clock is past it but nothing was scored for it.
  assert.equal(game.match.matchClock, game.match.autoSeconds + game.match.transitionSeconds);
  const score = game.match.score();
  assert.equal(score[game.alliance].leave, 0);
  assert.equal(score[game.alliance].parkAuto, 0);

  // Driving off the wall now must not retroactively earn LEAVE.
  sim.robot.reset(0, 0, 0);
  game.update(0.1);
  assert.equal(game.match.score()[game.alliance].leave, 0);
});

test('switching alliance rebuilds the game on the other side', () => {
  const config = new Config();
  const sim = new Simulation(config);
  const game = sim.enableGame().start();
  assert.equal(game.alliance, 'red');
  const redX = sim.robot.body.position.x;

  config.set('match.alliance', 'blue');
  const rebuilt = sim.game;
  assert.equal(rebuilt.alliance, 'blue');
  assert.notEqual(rebuilt, game, 'the alliance cannot be changed in place');
  assert.ok(
    Math.sign(sim.robot.body.position.x) !== Math.sign(redX),
    'and the ROBOT is staged on the other wall',
  );
  const check = rebuilt.match.checkStartingPosition(sim.robot, 'blue');
  assert.ok(check.legal, `expected a legal blue start, got ${check.reasons.join('; ')}`);

  // Only one game, and only one set of mechanisms on the robot.
  assert.equal(
    sim.robot.subsystems.filter((x) => x instanceof Intake).length,
    1,
    'the old intake went with the old game',
  );
});

test('auto-restart loops the MATCH, and off means off', () => {
  const config = new Config();
  config.set('match.autoSeconds', 1);
  config.set('match.transitionSeconds', 0);
  config.set('match.teleopSeconds', 2);
  const sim = new Simulation(config);
  const game = sim.enableGame().start();

  const runPast = () => {
    for (let i = 0; i < 200; i++) game.update(0.1);
  };

  runPast();
  assert.equal(game.match.phase, 'ended', 'without auto-restart it stays ended');

  config.set('match.autoRestart', true);
  game.start();
  // Long enough to end and get past the restart delay.
  for (let i = 0; i < 80; i++) game.update(0.1);
  assert.notEqual(game.match.phase, 'ended', 'with it on, a new MATCH is underway');
});

test('the drift warning threshold is a setting, not the physics', () => {
  const config = new Config();
  const sim = new Simulation(config);
  const game = sim.enableGame().start();

  sim.robot.body.velocity.set(0.5, 0);
  assert.equal(game.telemetry().moving, true, 'half a metre per second is a warning');
  config.set('match.moveTolerance', 1.5);
  assert.equal(game.telemetry().moving, false, 'until you say it is not');
  // And the shot itself still carries the velocity either way -- the setting
  // moves the warning, not the ballistics.
  const arc = game.launcher.trajectory();
  assert.ok(Math.abs(arc.points[1].x - arc.origin.x) > 0, 'the arc still drifts');
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
