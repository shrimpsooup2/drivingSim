import test from 'node:test';
import assert from 'node:assert/strict';
import { Config } from '../src/config/Config.js';
import { Simulation } from '../src/app/Simulation.js';
import { PENALTY_POINTS, RULES, rulesByCoverage } from '../src/field/biobuzz/rules.js';
import { MAX_CONTROLLED } from '../src/field/biobuzz/constants.js';
import {
  BUILD_QUALITIES,
  ROBOT_ARCHETYPES,
  intakeOptions,
} from '../src/ai/archetypes.js';

/**
 * Every Game Rule label in BIOBUZZ V1, read out of the manual once and pinned
 * here.
 *
 * The audit's whole value is that it is complete, and "complete" is only worth
 * anything if something checks. A rule the manual has and `rules.js` does not
 * is a gap nobody would notice otherwise.
 */
const MANUAL_RULES = [
  'G101', 'G102',
  'G201', 'G202', 'G203', 'G204', 'G205',
  'G301', 'G302', 'G303', 'G304', 'G305',
  'G401', 'G402', 'G403', 'G404', 'G405', 'G406', 'G407', 'G408', 'G409', 'G410',
  'G411', 'G412', 'G413', 'G414', 'G415', 'G416', 'G417', 'G418', 'G419', 'G420',
  'G421', 'G422', 'G423', 'G424', 'G425', 'G426', 'G427', 'G428',
];

function newGame(opts = {}) {
  const config = new Config();
  // The roster is off by default here: these tests put ROBOTS exactly where
  // they need them, and three more driving around would move things.
  config.set('ai.enabled', false);
  const sim = new Simulation(config);
  return sim.enableGame({ alliance: 'red', ...opts }).start();
}

/** Citations for one rule, in order. */
function cited(match, id) {
  return match.referee.citations.filter((c) => c.rule === id);
}

/** Four loose POLLEN, wherever they happen to be. */
function loosePollen(game, n) {
  return game.field.ballWorld.balls.filter((b) => b.free && b.kind === 'pollen').slice(0, n);
}

// ------------------------------------------------------------------- the audit

test('the audit covers every Game Rule in the manual, exactly once', () => {
  const ids = RULES.map((r) => r.id);
  assert.deepEqual([...ids].sort(), [...MANUAL_RULES].sort());
  assert.equal(new Set(ids).size, ids.length, 'no rule listed twice');
});

test('every rule says what the sim does about it, and every live rule says how', () => {
  for (const r of RULES) {
    assert.ok(r.title.length > 5, `${r.id} has no title`);
    assert.ok(r.penalty.length > 3, `${r.id} does not record its Violation line`);
    assert.ok(r.note.length > 20, `${r.id} does not explain its coverage`);
    if (r.coverage === 'live') {
      assert.ok(r.assess, `${r.id} is live but has no machine-readable penalty`);
      const a = r.assess;
      assert.ok(
        a.foul || a.card,
        `${r.id} is live but assesses neither a foul nor a card`,
      );
    } else {
      assert.equal(r.assess, undefined, `${r.id} is not live but carries an assessment`);
    }
  }
});

test('Table 10-4: a MINOR FOUL is 5 points and a MAJOR FOUL is 20', () => {
  assert.equal(PENALTY_POINTS.minor, 5);
  assert.equal(PENALTY_POINTS.major, 20);
});

test('the eleven rules the sim officiates are the ones it claims to', () => {
  const live = rulesByCoverage().live.map((r) => r.id);
  assert.deepEqual(live, [
    'G401', 'G402', 'G403', 'G404', 'G405', 'G407', 'G408', 'G409', 'G410', 'G417', 'G421',
  ]);
});

// ------------------------------------------------- G405 and the 10.8.2 return

test('G405: a ROBOT that spits an element out of the FIELD takes a MAJOR FOUL', () => {
  const game = newGame({ startPhase: 'teleop' });
  const match = game.match;
  const [ball] = loosePollen(game, 1);

  ball.setPosition(0, 0, 1);
  ball.touch('eject', match.robotMeta('player'), game.field.ballWorld.clock);
  ball.outOfBounds = true;
  game.update(1 / 50);
  game.update(1 / 50);

  const calls = cited(match, 'G405');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].penalty, 'major');
  assert.equal(calls[0].points, PENALTY_POINTS.major);
  // Table 10-4: "a credit of 20 points towards the *opponent's* MATCH point
  // total" -- so it appears on blue's score, not as a deduction from red's.
  assert.equal(match.score().blue.penalty, PENALTY_POINTS.major);
  assert.equal(match.score().red.penalty, 0);
  assert.equal(match.score().red.fouls.major, 1);
});

test('G405: a LAUNCHED element that leaves is a scoring attempt and costs nothing', () => {
  const game = newGame({ startPhase: 'teleop' });
  const match = game.match;
  const [ball] = loosePollen(game, 1);

  ball.setPosition(0, 0, 1);
  ball.touch('launch', match.robotMeta('player'), game.field.ballWorld.clock);
  ball.outOfBounds = true;
  game.update(1 / 50);
  game.update(1 / 50);

  assert.equal(cited(match, 'G405').length, 0, 'the rule exempts scoring attempts by name');
  assert.equal(match.score().blue.penalty, 0);
});

test('G405: an element squeezed out between two ROBOTS is not a deliberate ejection', () => {
  const game = newGame({ startPhase: 'teleop' });
  const match = game.match;
  const [ball] = loosePollen(game, 1);
  const meta = match.robotMeta('player');

  ball.setPosition(0, 0, 1);
  // What `Referee._markContact` would have written while the two frames met.
  ball.touch('contact', { ...meta, contested: true }, game.field.ballWorld.clock);
  ball.outOfBounds = true;
  game.update(1 / 50);
  game.update(1 / 50);

  assert.equal(cited(match, 'G405').length, 0);
});

test('Section 10.8.2: POLLEN that leaves comes back in the nearest clear spot', () => {
  const game = newGame({ startPhase: 'teleop' });
  const [ball] = loosePollen(game, 1);
  // Out over the audience wall, three quarters of the way along it.
  ball.setPosition(0.9, 2.4, 0.9);
  ball.outOfBounds = true;
  game.update(1 / 50);

  assert.equal(game.field.pendingReturns, 1, 'queued for FIELD STAFF');

  let t = 0;
  while (game.field.pendingReturns > 0 && t < 30) {
    game.update(1 / 50);
    t += 1 / 50;
  }
  assert.ok(
    t > game.field.returnDelay - 0.5 && t < game.field.returnDelay + 0.5,
    `expected the return near ${game.field.returnDelay} s, got ${t.toFixed(2)}`,
  );
  assert.equal(ball.outOfBounds, false);
  assert.ok(ball.free, 'loose on the tiles again');
  assert.ok(Math.abs(ball.x) < 1.83 && Math.abs(ball.y) < 1.83, 'inside the perimeter');
  assert.ok(
    Math.abs(ball.y - 1.83) < 0.5,
    `and near where it went out, not teleported: y=${ball.y.toFixed(2)}`,
  );
  assert.ok(Math.abs(ball.z - ball.radius) < 1e-6, 'resting on the floor');
});

test('Section 10.8.2: NECTAR that leaves goes back to its own DRIVE TEAM', () => {
  const game = newGame({ startPhase: 'teleop' });
  const nectar = game.field.nectar.red[0];
  nectar.release();
  nectar.setPosition(0, 0, 1);
  nectar.outOfBounds = true;
  const before = game.field.nectarAvailable('red');

  let t = 0;
  while (nectar.container?.kind !== 'allianceArea' && t < 30) {
    game.update(1 / 50);
    t += 1 / 50;
  }
  assert.equal(nectar.container?.kind, 'allianceArea', 'with the DRIVE TEAM, not on the tiles');
  assert.equal(
    game.field.nectarAvailable('red'),
    before + 1,
    'and available to enter through the LOADING ZONE again, per G427',
  );
});

// ---------------------------------------------------------------- the rest

test('G403: powered movement during the transition draws a warning then a MAJOR FOUL', () => {
  const game = newGame({ autoSeconds: 0.2, transitionSeconds: 6 });
  const match = game.match;
  for (let i = 0; i < 400 && match.phase !== 'teleop'; i++) {
    game.sim.robot.drivetrain.driveNormalized(0.5, 0, 0);
    game.update(1 / 50);
  }
  const calls = cited(match, 'G403');
  assert.ok(calls.length >= 2, `expected an escalation, got ${calls.length}`);
  assert.equal(calls[0].penalty, 'warning');
  assert.equal(calls[1].penalty, 'major');
  assert.equal(calls[1].card, 'yellow');
  // "MAJOR FOUL per MATCH": charged once however long it goes on.
  assert.equal(match.score().red.fouls.major, 1);
});

test('G404: a flywheel left spinning after the buzzer is powered movement', () => {
  const game = newGame({ startPhase: 'teleop', teleopSeconds: 0.5 });
  const match = game.match;
  game.launcher.spinning = true;
  for (let i = 0; i < 200; i++) game.update(1 / 50);

  const calls = cited(match, 'G404');
  assert.ok(calls.length >= 2, `expected an escalation, got ${calls.length}`);
  assert.equal(calls[0].penalty, 'warning');
  assert.ok(
    calls.some((c) => c.penalty === 'major'),
    'sustained powered movement is STRATEGIC',
  );
});

test('G404: still rolling at the buzzer is not a violation', () => {
  const game = newGame({ startPhase: 'teleop', teleopSeconds: 0.5 });
  const match = game.match;
  // Coasting: momentum, no command. The rule excuses "movement due to inertia".
  for (let i = 0; i < 200; i++) {
    game.sim.robot.body.velocity.set(1.2, 0);
    game.update(1 / 50);
  }
  assert.equal(cited(match, 'G404').length, 0);
});

test('G407: taking a fifth element is one instance, not one per step', () => {
  const game = newGame({ startPhase: 'teleop' });
  const match = game.match;
  game.intake.capacity = 12;
  for (const ball of loosePollen(game, 2)) game.intake.give(ball);
  for (let i = 0; i < 20; i++) game.update(1 / 50);

  assert.ok(game.intake.count > 4, `holding ${game.intake.count}`);
  const calls = cited(match, 'G407');
  assert.equal(calls.length, 1, 'one breach, one citation');
  assert.equal(calls[0].penalty, 'warning');
});

test('G408: holding the opponent NECTAR is called once per element', () => {
  const game = newGame({ startPhase: 'teleop' });
  const match = game.match;
  game.intake.capacity = 12;
  const nectar = game.field.nectar.blue[0];
  nectar.release();
  game.intake.give(nectar);
  for (let i = 0; i < 20; i++) game.update(1 / 50);

  const calls = cited(match, 'G408');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].penalty, 'warning');
  // The Violation line is a card and no points, so the score must not move.
  assert.equal(match.score().blue.penalty, 0);
});

test('G409: two catches off a TIPPED HIVE are forgiven, the third is STRATEGIC', () => {
  const game = newGame({ startPhase: 'teleop' });
  const match = game.match;
  const robot = game.sim.robot;
  robot.reset(0, 0.9, 0);
  robot.body.velocity.set(0, 0);

  for (const ball of loosePollen(game, 3)) {
    ball.setPosition(0, 0.9, 0.15);
    ball.setVelocity(0, 0, -0.5);
    // What `Hive._releaseWhatCannotBeHeld` sets on a spilled load.
    ball.fromTip = { alliance: 'red', t: 0 };
    game.update(1 / 200);
    game.update(1 / 200);
  }

  const calls = cited(match, 'G409');
  assert.equal(calls.length, 3);
  assert.equal(calls[0].penalty, 'warning');
  assert.equal(calls[1].penalty, 'warning');
  assert.equal(calls[2].penalty, 'strategic');
  assert.equal(calls[2].card, 'yellow');
});

test('G409: an element that has hit the TILES first is free to collect', () => {
  const game = newGame({ startPhase: 'teleop' });
  const match = game.match;
  const robot = game.sim.robot;
  robot.reset(0, 0.9, 0);
  robot.body.velocity.set(0, 0);

  const [ball] = loosePollen(game, 1);
  // Dropped from a TIP, but landed before the ROBOT got there.
  ball.setPosition(0, 1.4, ball.radius);
  ball.setVelocity(0, 0, -0.2);
  ball.fromTip = { alliance: 'red', t: 0 };
  game.update(1 / 200);
  assert.equal(ball.fromTip, null, 'the TILES closed the window');

  ball.setPosition(0, 0.9, 0.15);
  game.update(1 / 200);
  game.update(1 / 200);
  assert.equal(cited(match, 'G409').length, 0);
});

test('G410: a NECTAR into a FLOWER before the last minute is a MAJOR FOUL each', () => {
  const game = newGame({ startPhase: 'teleop', teleopSeconds: 120 });
  const match = game.match;
  const flower = game.field.flowers[0];
  for (const nectar of game.field.nectar.red.slice(0, 2)) {
    nectar.release();
    flower.add(nectar);
  }
  game.update(1 / 50);
  game.update(1 / 50);

  assert.equal(match.earlyFlowerNectar.red, 2, 'the MATCH counts them');
  const calls = cited(match, 'G410');
  assert.equal(calls.length, 2, 'and the REFEREE charges one per NECTAR');
  assert.equal(match.score().blue.penalty, 2 * PENALTY_POINTS.major);
});

test('G417: LAUNCHING at the opponent HIVE is meddling; missing your own is not', () => {
  const game = newGame({ startPhase: 'teleop' });
  const match = game.match;

  // Dropped into the aperture from just above it, which is what the tail of a
  // real arc does -- a CELL only accepts a descending element.
  const drop = (target, ball) => {
    ball.setPosition(target.x, target.y, target.z + 0.25);
    ball.setVelocity(0, 0, -2);
    ball.touch('launch', match.robotMeta('player'), game.field.ballWorld.clock);
    // Until it is inside a CELL *and has stopped*. There is no `cell` container
    // to wait for any more -- an element in a CELL is a free element that
    // happens to be inside one -- so the condition is where it is and what it
    // is doing.
    //
    // Both halves matter. Containment has a radius of slack, so a falling
    // element reads as inside the moment its centre crosses the mouth, which
    // is before it has touched anything; stopping there left the G417 strike
    // noted but not yet seen by the REFEREE, because `observe` runs before
    // `field.update` and so consumes what the *previous* step recorded.
    const inACell = () =>
      ['red', 'blue'].some((alliance) => game.field.hives[alliance].upBalls.includes(ball));
    for (let k = 0; k < 600; k++) {
      game.update(1 / 400);
      if (inACell() && ball.speed < 0.2) break;
    }
    for (let k = 0; k < 4; k++) game.update(1 / 400);
    assert.ok(inACell(), 'the shot has to actually arrive');
  };

  // Red's own HIVE: example H, explicitly not a violation.
  drop(game.field.hiveTarget('red'), loosePollen(game, 1)[0]);
  assert.equal(cited(match, 'G417').length, 0);

  // Blue's HIVE: example D.
  drop(game.field.hiveTarget('blue'), loosePollen(game, 1)[0]);
  const calls = cited(match, 'G417');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].penalty, 'warning');
  assert.match(calls[0].detail, /blue HIVE/);
});

test('G417: driving into the HIVE frame hard is ramming; nudging it is not', () => {
  const nudge = newGame({ startPhase: 'teleop' });
  nudge.sim.robot.reset(-0.35, 0, 0);
  nudge.sim.robot.body.velocity.set(-0.3, 0);
  for (let i = 0; i < 20; i++) nudge.update(1 / 100);
  assert.equal(cited(nudge.match, 'G417').length, 0, 'example G: an accidental bump');

  const ram = newGame({ startPhase: 'teleop' });
  ram.sim.robot.reset(-0.35, 0, 0);
  ram.sim.robot.body.velocity.set(-2.5, 0);
  for (let i = 0; i < 20; i++) ram.update(1 / 100);
  const calls = cited(ram.match, 'G417');
  assert.equal(calls.length, 1, 'example A: ramming the frame at high speed');
  assert.match(calls[0].detail, /rammed/);
});

test('G421: a PIN is called at 3 seconds and again every 3 after', () => {
  const config = new Config();
  config.set('ai.enabled', false);
  const sim = new Simulation(config);
  const opponent = sim.addOpponent({
    id: 'blue1',
    alliance: 'blue',
    start: { x: 0.5, y: 0, heading: Math.PI },
  });
  const game = sim.enableGame({ alliance: 'red', startPhase: 'teleop' }).start();
  const match = game.match;
  const robot = sim.robot;
  const gap = robot.halfLength + opponent.robot.halfLength - 0.01;

  // Held frame to frame, with the pinned ROBOT going nowhere. Positions are
  // pinned by hand each step so the drivetrains cannot wander out of it.
  for (let i = 0; i < 400; i++) {
    robot.body.position.set(0, 0);
    robot.body.velocity.set(0.4, 0);
    opponent.robot.body.position.set(gap, 0);
    opponent.robot.body.velocity.set(0, 0);
    game.update(1 / 50);
  }

  const calls = cited(match, 'G421');
  assert.ok(calls.length >= 2, `expected repeats, got ${calls.length}`);
  assert.ok(calls.every((c) => c.penalty === 'major'));
  // "per instance and an additional MAJOR FOUL for every 3 seconds": these do
  // stack, unlike the per-MATCH rules.
  assert.equal(match.score().blue.penalty, calls.length * PENALTY_POINTS.major);
});

test('G421: pushing an opponent two feet is not a PIN', () => {
  const config = new Config();
  config.set('ai.enabled', false);
  const sim = new Simulation(config);
  const opponent = sim.addOpponent({
    id: 'blue1',
    alliance: 'blue',
    start: { x: 0.5, y: 0, heading: Math.PI },
  });
  const game = sim.enableGame({ alliance: 'red', startPhase: 'teleop' }).start();
  const match = game.match;
  const robot = sim.robot;
  const gap = robot.halfLength + opponent.robot.halfLength - 0.01;

  // In contact the whole way, but both travelling: G421.B pauses the count
  // once either ROBOT has moved 2 ft from where the PIN began.
  let x = -1;
  for (let i = 0; i < 400; i++) {
    x += 0.004;
    robot.body.position.set(x, 0);
    robot.body.velocity.set(0.2, 0);
    opponent.robot.body.position.set(x + gap, 0);
    opponent.robot.body.velocity.set(0.2, 0);
    game.update(1 / 50);
  }
  assert.equal(cited(match, 'G421').length, 0);
});

test('nothing is officiated during pre-MATCH setup', () => {
  const game = newGame();
  game.match.reset();
  game.intake.capacity = 12;
  for (const ball of loosePollen(game, 3)) game.intake.give(ball);
  for (let i = 0; i < 20; i++) {
    game.sim.robot.drivetrain.driveNormalized(1, 0, 0);
    game.update(1 / 50);
  }
  assert.equal(game.match.phase, 'setup');
  assert.equal(game.match.referee.citations.length, 0);
});

test('resetting the MATCH clears every citation and the return queue', () => {
  const game = newGame({ startPhase: 'teleop' });
  const match = game.match;
  const [ball] = loosePollen(game, 1);
  ball.setPosition(0, 0, 1);
  ball.touch('eject', match.robotMeta('player'), game.field.ballWorld.clock);
  ball.outOfBounds = true;
  game.update(1 / 50);
  game.update(1 / 50);
  assert.ok(match.referee.citations.length > 0);

  match.reset();
  assert.equal(match.referee.citations.length, 0);
  assert.equal(match.referee.fouls.red.major, 0);
  assert.equal(game.field.pendingReturns, 0);
  assert.equal(match.score().blue.penalty, 0);
});

test('G405: a stale touch is not an ejection', () => {
  const game = newGame({ startPhase: 'teleop' });
  const match = game.match;
  const [ball] = loosePollen(game, 1);

  // Brushed early in the MATCH, and out of bounds a long time later. The
  // staleness window reads the ball world's clock, which is the clock the
  // stamp was made on -- comparing it against the MATCH clock instead made
  // this test pass for the wrong reason, because the two never line up.
  ball.touch('contact', match.robotMeta('player'), game.field.ballWorld.clock);
  for (let i = 0; i < 300; i++) game.update(1 / 50);

  ball.setPosition(0, 0, 1);
  ball.outOfBounds = true;
  game.update(1 / 50);
  game.update(1 / 50);
  assert.equal(cited(match, 'G405').length, 0);
  // But it still comes back, because Section 10.8.2 is not about blame.
  assert.equal(game.field.pendingReturns, 1);
});

test('a "per MATCH" rule stops repeating itself in the list', () => {
  const game = newGame({ startPhase: 'teleop' });
  const referee = game.match.referee;
  // G407 is "MAJOR FOUL and YELLOW CARD per MATCH", so the score stops moving
  // after the first assessed instance -- and the list should stop growing too,
  // while the count behind it keeps going.
  for (let i = 0; i < 12; i++) referee.cite('G407', 'red', 'CONTROLLED 6 SCORING ELEMENTS');
  const calls = cited(game.match, 'G407');
  assert.ok(calls.length < 12 && calls.length >= 4, `kept ${calls.length} of 12`);
  assert.equal(referee.fouls.red.major, 1, 'charged exactly once');
  assert.equal(game.match.score().blue.penalty, PENALTY_POINTS.major);
});

test('the AI stands down between the periods and after the buzzer', () => {
  const config = new Config();
  config.set('ai.enabled', false);
  const sim = new Simulation(config);
  sim.addOpponent({
    id: 'blue1',
    alliance: 'blue',
    archetypeId: 'twinWheel',
    qualityId: 'solid',
    skillId: 'veteran',
    start: { x: 1.4, y: 0.5, heading: Math.PI },
  });
  const game = sim
    .enableGame({ alliance: 'red', autoSeconds: 4, transitionSeconds: 6 })
    .start();

  // Into the transition, then check nothing is being commanded.
  for (let i = 0; i < 60 * 6 && game.match.phase !== 'transition'; i++) sim.step(1 / 60);
  assert.equal(game.match.phase, 'transition');
  for (let i = 0; i < 60 * 3; i++) sim.step(1 / 60);

  assert.equal(game.match.phase, 'transition');
  assert.equal(cited(game.match, 'G403').length, 0, 'G403: motionless between the periods');
  for (const opponent of sim.opponents) {
    assert.ok(
      opponent.robot.drivetrain.commandedEffort < 0.05,
      `${opponent.id} is still commanding ${opponent.robot.drivetrain.commandedEffort}`,
    );
  }
});

test('every archetype is built inside G407, at every build quality', () => {
  for (const archetype of ROBOT_ARCHETYPES) {
    if (!archetype.intake) continue;
    for (const quality of BUILD_QUALITIES) {
      const options = intakeOptions(archetype, quality);
      assert.ok(
        options.capacity <= MAX_CONTROLLED,
        `${archetype.id} at ${quality.id} holds ${options.capacity}, over G407's ${MAX_CONTROLLED}`,
      );
    }
  }
});

test('the intake refuses the opponent NECTAR, and takes it when told not to sort', () => {
  const game = newGame({ startPhase: 'teleop' });
  const robot = game.sim.robot;
  robot.reset(0, 0, 0);
  robot.body.velocity.set(0, 0);
  game.intake.held.length = 0;
  game.intake.capacity = 4;

  const place = (ball) => {
    ball.release();
    ball.setPosition(robot.halfLength + ball.radius, 0, ball.radius);
    ball.stop();
  };
  // Through `sim.step`, because the roller only ramps and only sweeps when the
  // robot's subsystems are actually stepped -- `game.update` advances the MATCH
  // and the FIELD and nothing on the ROBOT.
  const run = () => {
    for (let i = 0; i < 60; i++) {
      game.intake.command = 1;
      game.sim.step(1 / 60);
    }
  };

  const theirs = game.field.nectar.blue[0];
  place(theirs);
  run();
  assert.equal(game.intake.count, 0, 'G408: it drives straight over the wrong colour');

  game.intake.sortByAlliance = false;
  place(theirs);
  run();
  assert.equal(game.intake.count, 1, 'and a ROBOT with no colour sensor swallows it');
  assert.equal(cited(game.match, 'G408').length, 1);
});
