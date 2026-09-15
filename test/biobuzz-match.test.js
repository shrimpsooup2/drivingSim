import test from 'node:test';
import assert from 'node:assert/strict';
import { Config } from '../src/config/Config.js';
import { Field } from '../src/field/Field.js';
import { Robot } from '../src/robot/Robot.js';
import { BiobuzzField } from '../src/field/biobuzz/BiobuzzField.js';
import { Match } from '../src/field/biobuzz/Match.js';
import {
  AUTO_SECONDS,
  FIELD_INNER_HALF,
  FLOWER_UNLOCK_REMAINING,
  POINTS,
  RP_THRESHOLDS,
  TELEOP_SECONDS,
  TRANSITION_SECONDS,
} from '../src/field/biobuzz/constants.js';
import { INCH } from '../src/math/MathUtil.js';

function setUpMatch(robotCount = 2) {
  const config = new Config().values;
  const field = new BiobuzzField({ field: new Field(config) });
  const robots = [];
  for (let i = 0; i < robotCount; i++) {
    robots.push({
      robot: new Robot(config),
      alliance: i % 2 === 0 ? 'red' : 'blue',
      id: `${i % 2 === 0 ? 'red' : 'blue'}${Math.floor(i / 2) + 1}`,
    });
  }
  const match = new Match({ field, robots });
  return { field, match, robots };
}

/**
 * Put a robot flat against a wall, allowing for how its footprint projects at
 * that heading -- a rotated robot reaches further than its half-width.
 * @param {'audience'|'rear'|'red'|'blue'} wall
 */
function againstWall(robot, wall, along, heading) {
  robot.reset(0, 0, heading);
  const { cos, sin } = robot.body.rotation;
  const ex = robot.halfLength * Math.abs(cos) + robot.halfWidth * Math.abs(sin);
  const ey = robot.halfLength * Math.abs(sin) + robot.halfWidth * Math.abs(cos);
  // Just inside, so the footprint touches the wall without overhanging it.
  const inset = 1e-6;
  if (wall === 'audience') robot.reset(along, -(FIELD_INNER_HALF - ey - inset), heading);
  else if (wall === 'rear') robot.reset(along, FIELD_INNER_HALF - ey - inset, heading);
  else if (wall === 'red') robot.reset(-(FIELD_INNER_HALF - ex - inset), along, heading);
  else robot.reset(FIELD_INNER_HALF - ex - inset, along, heading);
  return robot;
}

/**
 * Load the up CELL until the HIVE tips.
 *
 * Only the first tip of a MATCH is cheap: the CELL is staged with three NECTAR
 * already, so one more element carries it over. After that the CELL arrives
 * empty and it takes a full load again -- about seven POLLEN. Forgetting that
 * is how you end up thinking a TIP is one shot.
 */
function tipHive(field, match, alliance, dt = 1 / 50) {
  const hive = field.hives[alliance];
  const before = hive.tips;
  for (let guard = 0; guard < 400 && hive.tips === before; guard++) {
    // Anything loose on the floor or still pre-loaded, which includes what the
    // last tip spilled -- a real ALLIANCE re-collects its own spillage, and
    // with only 40 POLLEN on the field it has to.
    const ball = field.allBalls.find(
      (b) => b.free || b.container?.kind === 'preload',
    );
    if (!ball) break;
    hive.stage(ball);
    for (let i = 0; i < 25 && hive.tips === before; i++) match.update(dt);
  }
  return hive.tips > before;
}

const run = (match, seconds, dt = 1 / 50, onStep) => {
  for (let i = 0; i < Math.round(seconds / dt); i++) {
    match.update(dt);
    if (onStep) onStep(match.matchClock);
  }
};

// ------------------------------------------------------------------ clock

test('the MATCH runs 30 s AUTO, 8 s transition and 2:00 TELEOP', () => {
  const { match } = setUpMatch();
  assert.equal(match.phase, 'setup');
  match.start();

  const seen = [];
  let t = 0;
  const dt = 1 / 50;
  while (match.phase !== 'ended' && t < 300) {
    const before = match.phase;
    match.update(dt);
    if (match.phase !== before) seen.push([before, match.phase, t + dt]);
    t += dt;
  }

  assert.deepEqual(
    seen.map((s) => `${s[0]}->${s[1]}`),
    ['auto->transition', 'transition->teleop', 'teleop->ended'],
  );
  assert.ok(Math.abs(seen[0][2] - AUTO_SECONDS) < dt * 1.5);
  assert.ok(Math.abs(seen[1][2] - (AUTO_SECONDS + TRANSITION_SECONDS)) < dt * 1.5);
  assert.ok(Math.abs(seen[2][2] - match.totalSeconds) < dt * 1.5);
  assert.equal(match.totalSeconds, AUTO_SECONDS + TRANSITION_SECONDS + TELEOP_SECONDS);
});

test('the clock does not drift with a coarse step', () => {
  // The phase advance carries its overflow, so a big dt cannot shave a slice
  // off each period.
  const { match } = setUpMatch();
  match.start();
  let t = 0;
  const dt = 0.3;
  while (match.phase !== 'ended' && t < 300) {
    match.update(dt);
    t += dt;
  }
  assert.ok(
    Math.abs(t - match.totalSeconds) <= dt,
    `ended at ${t.toFixed(2)} s, expected ${match.totalSeconds}`,
  );
});

test('only TELEOP is driver control', () => {
  const { match } = setUpMatch();
  match.start();
  assert.ok(match.inAuto && !match.driverControl);
  run(match, AUTO_SECONDS + 1);
  assert.equal(match.phase, 'transition');
  assert.ok(!match.driverControl, 'nobody drives during the transition');
  run(match, TRANSITION_SECONDS);
  assert.equal(match.phase, 'teleop');
  assert.ok(match.driverControl);
});

// ------------------------------------------------------------ leave / park

test('LEAVE is earned by coming off the wall, once, during AUTO only', () => {
  const { match, robots } = setUpMatch(2);
  const red = robots[0].robot;
  againstWall(red, 'audience', -40 * INCH, Math.PI / 2);
  againstWall(robots[1].robot, 'rear', 40 * INCH, -Math.PI / 2);
  assert.ok(match.touchingWall(red), 'staged against the wall');

  match.start();
  run(match, 1);
  assert.equal(match.score().red.leave, 0, 'still on the wall, no LEAVE');

  red.body.position.y += 0.4;
  assert.ok(!match.touchingWall(red));
  run(match, 1);
  assert.equal(match.score().red.leave, POINTS.leaveAuto);

  // Going back to the wall does not take it away.
  againstWall(red, 'audience', -40 * INCH, Math.PI / 2);
  run(match, 1);
  assert.equal(match.score().red.leave, POINTS.leaveAuto, 'LEAVE is not revoked');

  // Blue never moved.
  assert.equal(match.score().blue.leave, 0);
});

test('leaving the wall for the first time in TELEOP earns no LEAVE', () => {
  const { match, robots } = setUpMatch(2);
  const red = robots[0].robot;
  againstWall(red, 'audience', -40 * INCH, Math.PI / 2);
  againstWall(robots[1].robot, 'rear', 40 * INCH, -Math.PI / 2);
  match.start();
  run(match, AUTO_SECONDS + TRANSITION_SECONDS + 1);
  assert.equal(match.phase, 'teleop');
  red.body.position.y += 0.4;
  run(match, 1);
  assert.equal(match.score().red.leave, 0, 'Table 10-2 has no TELEOP LEAVE');
});

test('PARK is judged where the ROBOT is when each period ends', () => {
  const { field, match, robots } = setUpMatch(2);
  const red = robots[0].robot;
  const zone = field.zones.redLoading;

  againstWall(red, 'audience', -40 * INCH, Math.PI / 2);
  againstWall(robots[1].robot, 'rear', 40 * INCH, -Math.PI / 2);
  match.start();

  // Drive into the LOADING ZONE before AUTO ends.
  run(match, AUTO_SECONDS - 2);
  red.reset(zone.centerX, zone.centerY, 0);
  run(match, 3);
  assert.equal(match.phase, 'transition');
  assert.equal(match.score().red.parkAuto, POINTS.parkAuto);

  // Leave again and be elsewhere at the buzzer.
  red.reset(0, 0, 0);
  run(match, TRANSITION_SECONDS + TELEOP_SECONDS + 1);
  assert.equal(match.phase, 'ended');
  const score = match.score();
  assert.equal(score.red.parkAuto, POINTS.parkAuto, 'the AUTO park is banked');
  assert.equal(score.red.parkTeleop, 0, 'but not parked at the end');
});

test('a robot only partly inside the LOADING ZONE is still PARKED', () => {
  const { field, match, robots } = setUpMatch(2);
  const red = robots[0].robot;
  const zone = field.zones.redLoading;
  // Straddling the tape on the inner edge.
  red.reset(zone.maxX + red.halfLength - 1 * INCH, zone.centerY, 0);
  assert.ok(match.parked(red, 'red'));
  red.reset(zone.maxX + red.halfLength + 2 * INCH, zone.centerY, 0);
  assert.ok(!match.parked(red, 'red'));
});

// ------------------------------------------------------------------- tips

test('each TIP scores 20 and releases one NECTAR to the DRIVE TEAM', () => {
  const { field, match } = setUpMatch(0);
  match.start();

  assert.equal(field.nectarAvailable('red'), 0);
  assert.ok(tipHive(field, match, 'red'));

  const score = match.score();
  assert.equal(score.red.tips, 1);
  assert.equal(score.red.autoTips, 1, 'it happened during AUTO');
  assert.equal(score.red.tipPoints, POINTS.hiveTipAuto);
  assert.equal(field.nectarAvailable('red'), 1, 'one TIP, one NECTAR');
});

test('a TELEOP tip is worth the same but counts separately', () => {
  const { field, match } = setUpMatch(0);
  match.start();
  run(match, AUTO_SECONDS + TRANSITION_SECONDS + 1);
  assert.equal(match.phase, 'teleop');

  assert.ok(tipHive(field, match, 'blue'));
  const score = match.score();
  assert.equal(score.blue.tips, 1);
  assert.equal(score.blue.autoTips, 0);
  assert.equal(score.blue.tipPoints, POINTS.hiveTipTeleop);
});

test('the last 60 seconds release every remaining NECTAR', () => {
  const { field, match } = setUpMatch(0);
  match.start();
  run(match, AUTO_SECONDS + TRANSITION_SECONDS + 1);

  // Tip twice, so two are already out.
  for (let i = 0; i < 2; i++) assert.ok(tipHive(field, match, 'red'), `tip ${i + 1}`);
  const unlockedByTips = field.nectarAvailable('red');
  assert.equal(unlockedByTips, 2);

  // Run to the one-minute mark.
  while (match.teleopRemaining > FLOWER_UNLOCK_REMAINING + 0.5) match.update(1 / 50);
  assert.ok(!match.flowerUnlocked);
  run(match, 1);
  assert.ok(match.flowerUnlocked, 'the FLOWERS open with a minute left');

  field.unlockNectar('red', 'all');
  assert.equal(field.nectarAvailable('red'), 5, 'all five staged NECTAR are available');
});

// ---------------------------------------------------------------- flowers

test('G410: NECTAR in a FLOWER before the last minute is recorded as a violation', () => {
  const { field, match } = setUpMatch(0);
  match.start();

  const nectar = field.nectar.red[0];
  nectar.release();
  field.flowers[0].add(nectar);
  run(match, 1);

  assert.equal(match.score().red.earlyFlowerNectar, 1);
  assert.ok(
    match.score().red.bottomNectar > 0,
    'it still scores -- the ALLIANCE simply takes the penalty',
  );
});

test('NECTAR entered after the FLOWERS open is not a violation', () => {
  const { field, match } = setUpMatch(0);
  match.start();
  while (match.teleopRemaining > FLOWER_UNLOCK_REMAINING - 1) match.update(1 / 50);
  assert.ok(match.flowerUnlocked);

  const nectar = field.nectar.blue[0];
  nectar.release();
  field.flowers[0].add(nectar);
  run(match, 1);
  assert.equal(match.score().blue.earlyFlowerNectar, 0);
});

test('one late NECTAR takes a FLOWER the other ALLIANCE filled', () => {
  const { field, match } = setUpMatch(0);
  const flower = field.flowers[0];
  flower.clear();

  // POLLEN first: a NECTAR resting on the tile sits below the 4.25 in floor of
  // the scoring volume, so it would claim nothing and plug the tube as well.
  for (let i = 0; i < 3; i++) {
    field.pollen[i].release();
    flower.add(field.pollen[i]);
  }
  const redNectar = field.nectar.red[0];
  redNectar.release();
  flower.add(redNectar);
  for (let i = 3; i < 5; i++) {
    field.pollen[i].release();
    flower.add(field.pollen[i]);
  }
  match.start();
  run(match, 1);
  const held = match.score();
  assert.ok(held.red.flower > 0 && held.blue.flower === 0);
  assert.equal(held.red.bottomNectar, POINTS.bottomNectarBonus);

  // Blue drops one on top.
  const blueNectar = field.nectar.blue[0];
  blueNectar.release();
  flower.add(blueNectar);
  run(match, 1);
  const stolen = match.score();
  assert.equal(stolen.red.flower, 0, 'red loses every element in the tube');
  assert.ok(stolen.blue.flower >= held.red.flower, 'and blue gets them all');
  assert.equal(stolen.red.bottomNectar, POINTS.bottomNectarBonus, 'red keeps the bottom bonus');
});

// ------------------------------------------------------------- end of match

test('a HIVE that tips at the buzzer gives its CELL contents back', () => {
  const { field, match } = setUpMatch(0);
  match.start();
  const before = match.score().red.cell;
  assert.equal(before, 3 * POINTS.elementInCell, 'three staged NECTAR are worth 6');

  assert.ok(tipHive(field, match, 'red'));
  assert.equal(match.score().red.cell, 0, 'the tip empties the CELL');
  assert.equal(match.score().red.tipPoints, POINTS.hiveTipAuto, 'but the TIP itself is banked');
});

// ------------------------------------------------------------ ranking points

test('RANKING POINTS follow the thresholds in Table 10-3', () => {
  const { field, match } = setUpMatch(0);
  match.start();

  const tip = (alliance, times) => {
    for (let i = 0; i < times; i++) {
      assert.ok(tipHive(field, match, alliance), `tip ${i + 1} of ${times}`);
    }
  };

  tip('red', RP_THRESHOLDS.pollinator1Tips - 1);
  assert.equal(match.score().red.rp.pollinator1, 0);
  tip('red', 1);
  assert.equal(match.score().red.rp.pollinator1, 1);
  assert.equal(match.score().red.rp.pollinator2, 0);

  tip('red', RP_THRESHOLDS.pollinator2Tips - RP_THRESHOLDS.pollinator1Tips);
  const score = match.score();
  assert.equal(score.red.tips, RP_THRESHOLDS.pollinator2Tips);
  assert.equal(score.red.rp.pollinator1, 1);
  assert.equal(score.red.rp.pollinator2, 1, 'both POLLINATOR RPs, they are cumulative');
});

test('the SWARM RP needs LEAVE and PARK points from both ROBOTS', () => {
  const { field, match, robots } = setUpMatch(4);
  const zone = field.zones.redLoading;
  const reds = robots.filter((r) => r.alliance === 'red').map((r) => r.robot);

  for (const robot of reds) againstWall(robot, 'audience', -40 * INCH, Math.PI / 2);
  match.start();
  run(match, 1);

  // One robot doing everything is 13 points -- short of the 16 threshold.
  reds[0].body.position.y += 0.4;
  run(match, 1);
  reds[0].reset(zone.centerX, zone.centerY, 0);
  run(match, AUTO_SECONDS);
  assert.equal(match.phase, 'transition');
  assert.equal(match.score().red.swarmPoints, POINTS.leaveAuto + POINTS.parkAuto);
  assert.equal(match.score().red.rp.swarm, 0);

  // Both parked at the end of TELEOP clears it.
  reds[1].reset(zone.centerX, zone.centerY + 6 * INCH, 0);
  run(match, TRANSITION_SECONDS + TELEOP_SECONDS + 1);
  assert.equal(match.phase, 'ended');
  const score = match.score();
  assert.ok(
    score.red.swarmPoints >= RP_THRESHOLDS.swarmPoints,
    `expected at least ${RP_THRESHOLDS.swarmPoints}, got ${score.red.swarmPoints}`,
  );
  assert.equal(score.red.rp.swarm, 1);
});

test('the win bonus is only awarded once the MATCH is over', () => {
  const { field, match } = setUpMatch(0);
  match.start();
  assert.ok(tipHive(field, match, 'red'));

  assert.ok(match.score().red.total > match.score().blue.total);
  assert.equal(match.score().red.rp.result, 0, 'not while it is still being played');
  assert.equal(match.score().winner, null);

  run(match, match.totalSeconds);
  assert.equal(match.phase, 'ended');
  const final = match.score();
  assert.equal(final.winner, 'red');
  assert.equal(final.red.rp.result, POINTS.win);
  assert.equal(final.blue.rp.result, 0);
});

test('an even MATCH is a tie and both ALLIANCES take the tie point', () => {
  const { match } = setUpMatch(0);
  match.start();
  run(match, match.totalSeconds + 1);
  const final = match.score();
  assert.equal(final.red.total, final.blue.total, 'the staged field is symmetric');
  assert.equal(final.winner, 'tie');
  assert.equal(final.red.rp.result, POINTS.tie);
  assert.equal(final.blue.rp.result, POINTS.tie);
});

// -------------------------------------------------------------------- G304

test('G304 accepts a legal start and names what is wrong with an illegal one', () => {
  const { field, match, robots } = setUpMatch(2);
  const red = robots[0].robot;

  againstWall(red, 'audience', -40 * INCH, Math.PI / 2);
  const legal = match.checkStartingPosition(red, 'red');
  assert.ok(legal.legal, `expected a legal start, got ${legal.reasons.join('; ')}`);

  // Off the wall.
  red.body.position.y += 0.3;
  assert.match(
    match.checkStartingPosition(red, 'red').reasons.join(';'),
    /G304\.C/,
    'not touching the wall',
  );

  // Wrong half of the field.
  againstWall(red, 'audience', 40 * INCH, Math.PI / 2);
  assert.match(match.checkStartingPosition(red, 'red').reasons.join(';'), /G304\.A/);

  // In its own LOADING ZONE.
  const zone = field.zones.redLoading;
  red.reset(zone.minX + red.halfLength, zone.centerY, 0);
  assert.match(match.checkStartingPosition(red, 'red').reasons.join(';'), /G304\.E/);

  // Parked on a FLOWER.
  const flower = field.flowers.find((f) => f.x < 0 && Math.abs(f.x) > Math.abs(f.y));
  againstWall(red, 'red', flower.y, 0);
  assert.match(match.checkStartingPosition(red, 'red').reasons.join(';'), /G304\.D/);
});
