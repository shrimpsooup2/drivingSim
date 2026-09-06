import test from 'node:test';
import assert from 'node:assert/strict';
import { Config } from '../src/config/Config.js';
import { Simulation } from '../src/app/Simulation.js';
import { OpMode } from '../src/teleop/OpMode.js';
import { createChallenges, createChallenge } from '../src/challenges/library.js';
import { Challenge } from '../src/challenges/Challenge.js';
import { Gate, CircleZone, Corridor, segmentsIntersect, distanceToSegment, headingError } from '../src/challenges/zones.js';
import { Vec2 } from '../src/math/Vec2.js';
import { pointInObb } from '../src/physics/collision.js';
import { wrapAngle, clamp } from '../src/math/MathUtil.js';

/**
 * A crude autonomous driver, good enough to complete any of the drills.
 *
 * It exists to prove the courses are actually drivable. A drill that cannot be
 * finished is worse than no drill at all, and laying out gates by hand is
 * exactly the kind of thing that produces an unreachable objective or one whose
 * required crossing direction is impossible to satisfy from the approach.
 */
class AutoDriver extends OpMode {
  /** @param {Challenge} challenge */
  constructor(challenge) {
    super({ name: 'auto' });
    this.challenge = challenge;
    this.stuckFor = 0;
    this.unstickFor = 0;
    this.gateIndex = -1;
    this.committed = true;
    this.docking = false;
    this.dockIndex = -1;
  }

  loop(dt) {
    const robot = this.robot;
    const objective = this.challenge.current;
    if (!objective || !robot) {
      robot?.drivetrain.driveNormalized(0, 0, 0);
      return;
    }

    const position = robot.body.position;
    const heading = robot.body.rotation.radians;

    // Wedged against an obstacle or an opponent. A driver that only ever drives
    // at the target would sit there forever, so back off and try again -- which
    // is also what a real driver does.
    const wantsToMove = this.challenge.state === 'running';
    if (wantsToMove && robot.body.speed < 0.06 && objective.kind !== 'park') {
      this.stuckFor += dt;
    } else {
      this.stuckFor = 0;
    }
    if (this.stuckFor > 1.2) {
      this.unstickFor = 0.7;
      this.stuckFor = 0;
    }
    if (this.unstickFor > 0) {
      this.unstickFor -= dt;
      robot.drivetrain.driveNormalized(-0.5, 0.35, 0.3);
      return;
    }

    if (this.dockIndex !== this.challenge.index) {
      this.dockIndex = this.challenge.index;
      this.docking = false;
    }

    let targetX;
    let targetY;
    let wantStop = false;
    let targetHeading;

    if (objective.kind === 'gate') {
      const g = objective.gate;
      // How far past the gate's plane the robot already is, measured along the
      // direction the gate must be crossed in.
      const ahead = (position.x - g.center.x) * Math.cos(g.heading) +
        (position.y - g.center.y) * Math.sin(g.heading);

      // Hysteresis, not a bare threshold. A robot stopped exactly on the gate
      // plane -- which is precisely what happens when it wedges on something --
      // has `ahead == 0`, and a naive comparison flips the target every frame
      // so it rocks in place forever. Commit to driving through once clearly
      // behind, and only give up and loop round once clearly past.
      if (this.gateIndex !== this.challenge.index) {
        this.gateIndex = this.challenge.index;
        this.committed = ahead < 0;
      }
      if (ahead < -0.12) this.committed = true;
      else if (ahead > 0.25) this.committed = false;

      const lead = this.committed ? 0.35 : -0.8;
      targetX = g.center.x + Math.cos(g.heading) * lead;
      targetY = g.center.y + Math.sin(g.heading) * lead;
    } else if (objective.requireReverse && objective.headingTarget !== undefined) {
      // Reverse docking is a two-phase manoeuvre, and doing it in one arc does
      // not work: line up square in front of the bay first, then back straight
      // in. Trying to steer while reversing into a narrow slot is exactly how
      // you clip the walls, in the simulator and on a real field.
      const facing = objective.headingTarget;
      const centre = objective.zone.center;
      // The bay is entered by moving *opposite* the way the robot faces.
      const stageX = centre.x + Math.cos(facing) * 0.75;
      const stageY = centre.y + Math.sin(facing) * 0.75;
      const squared = Math.abs(wrapAngle(facing - heading)) < 0.2;
      const atStage = Math.hypot(stageX - position.x, stageY - position.y) < 0.18;
      if (this.docking || (squared && atStage)) {
        this.docking = true;
        targetX = centre.x;
        targetY = centre.y;
        wantStop = true;
      } else {
        targetX = stageX;
        targetY = stageY;
      }
      targetHeading = facing;
    } else {
      this.docking = false;
      targetX = objective.zone.center.x;
      targetY = objective.zone.center.y;
      wantStop = objective.kind === 'park';
      targetHeading = objective.headingTarget;
    }

    const dx = targetX - position.x;
    const dy = targetY - position.y;
    const distance = Math.hypot(dx, dy);

    // Field-centric: rotate the field-frame error into the robot frame.
    const c = Math.cos(-heading);
    const s = Math.sin(-heading);
    const forward = dx * c - dy * s;
    const strafe = dx * s + dy * c;

    const gain = wantStop ? 2.2 : 3.0;
    const cap = wantStop ? clamp(distance * 2.5, 0.12, 0.55) : 0.8;
    let fwd = clamp(forward * gain, -cap, cap);
    let str = clamp(strafe * gain, -cap, cap);

    // A reverse *gate* has no fixed heading, so face away from where it is going.
    if (objective.requireReverse && objective.kind === 'gate') {
      targetHeading = Math.atan2(dy, dx) + Math.PI;
    }

    // Tank cannot strafe, so turn toward the target instead.
    let turn = 0;
    if (!robot.drivetrain.canStrafe) {
      const bearing = Math.atan2(dy, dx);
      turn = clamp(wrapAngle(bearing - heading) * 1.6, -0.7, 0.7);
      str = 0;
      // Do not drive hard while badly misaligned, or it arcs past the target.
      if (Math.abs(wrapAngle(bearing - heading)) > 0.8) fwd = 0;
    } else if (targetHeading !== undefined) {
      turn = clamp(wrapAngle(targetHeading - heading) * 2.0, -0.6, 0.6);
    }

    if (wantStop && distance < 0.06) {
      fwd = 0;
      str = 0;
      if (targetHeading === undefined) turn = 0;
    }

    robot.drivetrain.driveNormalized(fwd, str, turn);
  }
}

/** Small deterministic PRNG, so AI drills are reproducible in tests. */
function seededRandom(seed = 12345) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

/** @param {Record<string, any>} [tweaks] */
function makeSim(tweaks = {}) {
  const config = new Config();
  for (const [path, value] of Object.entries(tweaks)) config.set(path, value);
  const sim = new Simulation(config);
  sim.random = seededRandom();
  return sim;
}

/** Run a drill to completion (or give up), returning how long it took. */
function driveUntilDone(sim, challenge, maxSeconds = 180) {
  sim.setOpMode(new AutoDriver(challenge));
  const limit = Math.round(maxSeconds * 60);
  let steps = 0;
  while (challenge.state === 'ready' || challenge.state === 'running') {
    sim.step(1 / 60);
    steps++;
    if (steps >= limit) break;
  }
  return steps / 60;
}

// ---------------------------------------------------------------- geometry

test('gate crossing is direction-sensitive', () => {
  const g = new Gate({ center: new Vec2(0, 0), heading: 0, width: 1 });
  assert.equal(g.crossed(new Vec2(-0.2, 0), new Vec2(0.2, 0)), true);
  assert.equal(g.crossed(new Vec2(0.2, 0), new Vec2(-0.2, 0)), false, 'reverse must not count');
  assert.equal(g.crossed(new Vec2(-0.2, 2), new Vec2(0.2, 2)), false, 'missing the gate must not count');
});

test('gate crossing survives a large step (no tunnelling)', () => {
  const g = new Gate({ center: new Vec2(0, 0), heading: 0, width: 1 });
  // A robot at 5 m/s moves 8 cm per 60 Hz frame; this is far beyond that.
  assert.equal(g.crossed(new Vec2(-2, 0.1), new Vec2(2, 0.1)), true);
});

test('gate endpoints are perpendicular to its heading', () => {
  const g = new Gate({ center: new Vec2(1, 1), heading: 0, width: 2 });
  const [a, b] = g.endpoints;
  assert.ok(Math.abs(a.x - 1) < 1e-12 && Math.abs(b.x - 1) < 1e-12);
  assert.ok(Math.abs(Math.abs(a.y - b.y) - 2) < 1e-12);
});

test('segment intersection handles parallel and touching cases', () => {
  const p = (x, y) => new Vec2(x, y);
  assert.equal(segmentsIntersect(p(0, 0), p(1, 0), p(0, 1), p(1, 1)), false, 'parallel');
  assert.equal(segmentsIntersect(p(0, 0), p(1, 1), p(0, 1), p(1, 0)), true, 'crossing');
  assert.equal(segmentsIntersect(p(0, 0), p(1, 0), p(2, -1), p(2, 1)), false, 'too short to reach');
});

test('corridor stray distance is zero inside and grows outside', () => {
  const c = new Corridor({ points: [new Vec2(-1, 0), new Vec2(1, 0)], halfWidth: 0.25 });
  assert.equal(c.strayDistance(new Vec2(0, 0.1)), 0);
  assert.ok(Math.abs(c.strayDistance(new Vec2(0, 0.6)) - 0.35) < 1e-9);
});

test('distanceToSegment clamps to the endpoints', () => {
  const a = new Vec2(0, 0);
  const b = new Vec2(1, 0);
  assert.ok(Math.abs(distanceToSegment(new Vec2(0.5, 0.3), a, b) - 0.3) < 1e-9);
  assert.ok(Math.abs(distanceToSegment(new Vec2(-1, 0), a, b) - 1) < 1e-9);
});

test('headingError is symmetric and wraps', () => {
  assert.ok(Math.abs(headingError(0, Math.PI * 2 - 0.1) - 0.1) < 1e-9);
  assert.ok(Math.abs(headingError(0.1, -0.1) - 0.2) < 1e-9);
});

// ---------------------------------------------------------------- library

test('every drill builds a course inside the field with room for the robot', () => {
  const sim = makeSim();
  const halfDiagonal = Math.hypot(sim.config.chassis.length, sim.config.chassis.width) / 2;
  for (const challenge of createChallenges()) {
    challenge.build(sim.field);
    assert.ok(challenge.objectives.length > 0, `${challenge.id} has no objectives`);
    assert.ok(challenge.name && challenge.description, `${challenge.id} is missing text`);

    for (const objective of challenge.objectives) {
      const p = objective.gate ? objective.gate.center : objective.zone.center;
      const clearance = sim.field.halfSize - Math.max(Math.abs(p.x), Math.abs(p.y));
      assert.ok(
        clearance >= halfDiagonal,
        `${challenge.id}: objective "${objective.label}" is ${clearance.toFixed(3)} m from the wall, ` +
          `too tight for a robot of half-diagonal ${halfDiagonal.toFixed(3)} m`,
      );
    }
    const start = new Vec2(challenge.startPose.x, challenge.startPose.y);
    assert.ok(sim.field.contains(start, halfDiagonal), `${challenge.id}: start pose is out of bounds`);
  }
});

test('drill ids are unique and lookup works', () => {
  const ids = createChallenges().map((c) => c.id);
  assert.equal(new Set(ids).size, ids.length, 'duplicate drill id');
  assert.ok(createChallenge('slalom'));
  assert.equal(createChallenge('nonexistent'), null);
});

// ---------------------------------------------------------------- state machine

test('the clock does not start until the robot moves', () => {
  const sim = makeSim();
  const challenge = sim.challenges.select('sprint');
  for (let i = 0; i < 120; i++) sim.step(1 / 60);
  assert.equal(challenge.state, 'ready');
  assert.equal(challenge.elapsed, 0, 'a stationary robot must not burn clock');
});

test('wall contact adds a penalty but is rate limited', () => {
  const sim = makeSim();
  const challenge = sim.challenges.select('sprint');
  sim.setOpMode(new (class extends OpMode {
    loop() { this.robot.drivetrain.driveNormalized(1, 0, 0); }
  })());
  // Long enough to reach the far wall and sit against it for several seconds.
  for (let i = 0; i < 60 * 8; i++) sim.step(1 / 60);
  assert.ok(challenge.wallHits > 0, 'driving into the wall should be penalised');
  assert.ok(
    challenge.wallHits < 8 * 2,
    `resting on a wall must not accrue a penalty every frame (got ${challenge.wallHits})`,
  );
});

test('resetting the robot restarts the drill clock', () => {
  const sim = makeSim();
  const challenge = sim.challenges.select('sprint');
  sim.setOpMode(new (class extends OpMode {
    loop() { this.robot.drivetrain.driveNormalized(0.6, 0, 0); }
  })());
  for (let i = 0; i < 60; i++) sim.step(1 / 60);
  assert.ok(challenge.elapsed > 0.5);
  sim.resetRobot();
  assert.equal(challenge.elapsed, 0);
  assert.equal(challenge.state, 'ready');
});

// ---------------------------------------------------------------- drivability

test('every uncontested drill can be completed by driving it', () => {
  for (const template of createChallenges()) {
    // Drills with an opponent are covered separately: a defender is *supposed*
    // to be able to stop a naive driver, so demanding completion here would be
    // testing that defence does not work.
    if (template.opponents.length > 0 || template.scoreMode === 'count') continue;

    const sim = makeSim();
    const challenge = sim.challenges.select(template.id);
    assert.ok(challenge, `${template.id} could not be selected`);
    driveUntilDone(sim, challenge, 200);

    assert.equal(
      challenge.state,
      'complete',
      `${template.id} stalled at objective ${challenge.index + 1}/${challenge.total} ` +
        `("${challenge.current?.label}") after ${challenge.elapsed.toFixed(0)} s`,
    );
    assert.ok(challenge.result.score > 0);
  }
});

test('par thresholds are ordered in the direction that drill scores', () => {
  for (const template of createChallenges()) {
    if (!template.par) continue;
    const { gold, silver, bronze } = template.par;
    if (template.higherIsBetter) {
      // Count mode: more completions is better, so gold is the highest bar.
      assert.ok(gold > silver && silver > bronze, `${template.id}: count par is not ordered`);
    } else {
      assert.ok(gold < silver && silver < bronze, `${template.id}: time par is not ordered`);
    }
    assert.ok(template.grade(gold) === 'gold', `${template.id}: gold par does not grade gold`);
    assert.ok(template.grade(bronze) === 'bronze', `${template.id}: bronze par does not grade bronze`);
  }
});

test('no objective is buried inside a solid obstacle', () => {
  // An objective placed inside (or hard against) a pillar can never be reached,
  // and nothing about the course looks wrong until someone tries to drive it.
  // The robot's half-width is used as the clearance, since it has to fit there.
  const sim = makeSim();
  const clearance = sim.config.chassis.width / 2;
  for (const template of createChallenges()) {
    const challenge = sim.challenges.select(template.id);
    const colliders = sim.field.obstacleColliders();
    for (const objective of challenge.objectives) {
      const p = objective.gate ? objective.gate.center : objective.zone.center;
      for (const collider of colliders) {
        const inflated = {
          ...collider,
          halfLength: collider.halfLength + clearance,
          halfWidth: collider.halfWidth + clearance,
        };
        assert.ok(
          !pointInObb(p, inflated),
          `${template.id}: objective "${objective.label}" at ${p} is inside or against ${collider.id}`,
        );
      }
    }
  }
});

test('a course with solid obstacles actually blocks the robot', () => {
  const sim = makeSim();
  const challenge = sim.challenges.select('threading');
  assert.ok(challenge.obstacles.length >= 8, 'threading should place pillars');
  // Aim straight at a pillar rather than the gap.
  const pillar = sim.field.elements[0];
  sim.setStartPose(pillar.position.x - 1.0, pillar.position.y, 0);
  sim.resetRobot();
  sim.setOpMode(new (class extends OpMode {
    loop() { this.robot.drivetrain.driveNormalized(1, 0, 0); }
  })());
  for (let i = 0; i < 60 * 5; i++) sim.step(1 / 60);
  assert.ok(
    sim.robot.body.position.x < pillar.position.x,
    'the robot drove through a solid obstacle',
  );
  assert.ok(challenge.obstacleHits > 0, 'hitting an obstacle should be penalised');
});

test('the reverse gate cannot be cleared driving forwards', () => {
  const sim = makeSim();
  const challenge = sim.challenges.select('gauntlet');
  const reverseIndex = challenge.objectives.findIndex((o) => o.requireReverse);
  assert.ok(reverseIndex >= 0, 'the gauntlet should contain a reverse gate');
  const objective = challenge.objectives[reverseIndex];

  // Jump straight to that objective and cross it nose-first.
  challenge.index = reverseIndex;
  challenge.state = 'running';
  const g = objective.gate;
  const before = new Vec2(g.center.x - Math.cos(g.heading) * 0.4, g.center.y - Math.sin(g.heading) * 0.4);
  const after = new Vec2(g.center.x + Math.cos(g.heading) * 0.4, g.center.y + Math.sin(g.heading) * 0.4);

  const body = sim.robot.body;
  body.reset(before.x, before.y, g.heading); // facing the way it is travelling
  challenge._previousPosition = before.clone();
  body.position.set(after.x, after.y);
  body.velocity.set(Math.cos(g.heading) * 1.0, Math.sin(g.heading) * 1.0);
  challenge.update(1 / 60, sim);
  assert.equal(challenge.index, reverseIndex, 'crossing nose-first must not count');

  // Now the same crossing, but facing backwards.
  body.reset(before.x, before.y, g.heading + Math.PI);
  challenge._previousPosition = before.clone();
  body.position.set(after.x, after.y);
  body.velocity.set(Math.cos(g.heading) * 1.0, Math.sin(g.heading) * 1.0);
  challenge.update(1 / 60, sim);
  assert.equal(challenge.index, reverseIndex + 1, 'crossing in reverse should count');
});

test('speed limits on an approach cost time only when exceeded', () => {
  const sim = makeSim();
  const challenge = sim.challenges.select('slowZone');
  const objective = challenge.current;
  assert.ok(objective.approachSpeedLimit, 'the delicate approach drill needs a speed limit');

  challenge.state = 'running';
  const body = sim.robot.body;
  // Inside the approach radius, under the limit: no penalty.
  body.reset(objective.zone.center.x - 0.3, objective.zone.center.y, 0);
  body.velocity.set(0.2, 0);
  challenge.update(0.5, sim);
  assert.equal(challenge.penaltySeconds, 0);

  // Same place, well over the limit: charged per second.
  body.velocity.set(1.6, 0);
  challenge.update(0.5, sim);
  assert.ok(challenge.penaltySeconds > 0, 'speeding through the approach should cost time');
});

test('count-mode drills score completions against a fixed clock', () => {
  const sim = makeSim();
  const challenge = sim.challenges.select('matchSim');
  assert.equal(challenge.scoreMode, 'count');
  assert.ok(challenge.higherIsBetter);
  // Shorten the window so the test is quick; the mechanism is the same.
  challenge.duration = 25;
  driveUntilDone(sim, challenge, 40);
  assert.equal(challenge.state, 'complete', 'the match clock should end the run');
  assert.ok(challenge.elapsed >= 25 - 0.1, 'it should have run the whole window');
  assert.ok(challenge.completions > 0, 'the driver should have scored at least one objective');
  assert.equal(challenge.score, challenge.completions);
});

test('count-mode courses loop rather than finishing early', () => {
  const sim = makeSim();
  const challenge = sim.challenges.select('matchSim');
  challenge.duration = 200;
  challenge.state = 'running';
  // Satisfy every objective in turn and check it wraps around.
  for (let i = 0; i < challenge.total; i++) {
    challenge.index = i;
    const objective = challenge.objectives[i];
    sim.robot.body.position.set(objective.zone.center.x, objective.zone.center.y);
    sim.robot.body.velocity.set(0.5, 0);
    challenge.update(1 / 60, sim);
  }
  assert.equal(challenge.index, 0, 'the course should wrap to the start');
  assert.equal(challenge.laps, 1);
  assert.equal(challenge.state, 'running', 'it must not finish before the clock does');
});

// ---------------------------------------------------------------- runner

test('holonomic-only drills are hidden from tank drivetrains', () => {
  const sim = makeSim();
  assert.ok(sim.challenges.available().some((c) => c.id === 'strafe'));
  sim.configStore.set('drivetrain.type', 'tank');
  assert.ok(!sim.challenges.available().some((c) => c.id === 'strafe'));
  sim.configStore.set('drivetrain.type', 'mecanum');
  assert.ok(sim.challenges.available().some((c) => c.id === 'strafe'));
});

test('selecting a drill places the robot on its start line', () => {
  const sim = makeSim();
  const challenge = sim.challenges.select('slalom');
  assert.ok(Math.abs(sim.robot.body.position.x - challenge.startPose.x) < 1e-9);
  assert.ok(Math.abs(sim.robot.body.position.y - challenge.startPose.y) < 1e-9);
  assert.equal(sim.robot.body.speed, 0);
});

test('records are kept per drivetrain, since times are not comparable across them', () => {
  const sim = makeSim();
  const runner = sim.challenges;
  runner.clearRecords();
  const challenge = runner.select('sprint');
  challenge.elapsed = 9;
  challenge.state = 'running';
  runner._record(challenge);
  assert.ok(runner.bestFor('sprint'));

  sim.configStore.set('drivetrain.type', 'tank');
  assert.equal(runner.bestFor('sprint'), null, 'a mecanum time must not appear as a tank record');
  runner.clearRecords();
});

test('a faster run replaces the record and a slower one does not', () => {
  const sim = makeSim();
  const runner = sim.challenges;
  runner.clearRecords();
  const challenge = runner.select('sprint');

  challenge.elapsed = 10;
  runner._record(challenge);
  assert.equal(runner.bestFor('sprint').score, 10);

  challenge.elapsed = 12;
  runner._record(challenge);
  assert.equal(runner.bestFor('sprint').score, 10, 'a slower run must not overwrite the record');

  challenge.elapsed = 7;
  runner._record(challenge);
  assert.equal(runner.bestFor('sprint').score, 7);
  runner.clearRecords();
});

test('clearing the active drill returns to free driving', () => {
  const sim = makeSim();
  sim.challenges.select('sprint');
  assert.ok(sim.challenges.active);
  sim.challenges.clear();
  assert.equal(sim.challenges.active, null);
  // The simulation must keep running normally with no drill loaded.
  for (let i = 0; i < 60; i++) sim.step(1 / 60);
  assert.ok(sim.robot.body.isFinite());
});
