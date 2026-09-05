import test from 'node:test';
import assert from 'node:assert/strict';
import { Config } from '../src/config/Config.js';
import { Simulation } from '../src/app/Simulation.js';
import { OpMode } from '../src/teleop/OpMode.js';
import { createChallenges, createChallenge } from '../src/challenges/library.js';
import { Challenge } from '../src/challenges/Challenge.js';
import { Gate, CircleZone, Corridor, segmentsIntersect, distanceToSegment, headingError } from '../src/challenges/zones.js';
import { Vec2 } from '../src/math/Vec2.js';
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
      // Behind the gate: aim at a point beyond it, so driving at the target
      // crosses the plane the right way round. Already past it without having
      // scored it (approached from the side): loop back behind first.
      // The two cases must not overlap, or the driver oscillates on the
      // boundary and never actually reaches the gate.
      const lead = ahead < 0 ? 0.5 : -0.8;
      targetX = g.center.x + Math.cos(g.heading) * lead;
      targetY = g.center.y + Math.sin(g.heading) * lead;
    } else {
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

/** @param {Record<string, any>} [tweaks] */
function makeSim(tweaks = {}) {
  const config = new Config();
  for (const [path, value] of Object.entries(tweaks)) config.set(path, value);
  return new Simulation(config);
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

test('every drill can be completed by driving it', () => {
  for (const template of createChallenges()) {
    const sim = makeSim();
    const challenge = sim.challenges.select(template.id);
    assert.ok(challenge, `${template.id} could not be selected`);
    sim.setOpMode(new AutoDriver(challenge));

    // Generous budget: this driver is deliberately crude, and the point is to
    // prove the course is completable at all, not that it is completable fast.
    const limit = 60 * 150;
    let steps = 0;
    while (challenge.state !== 'complete' && steps < limit) {
      sim.step(1 / 60);
      steps++;
    }
    assert.equal(
      challenge.state,
      'complete',
      `${template.id} stalled at objective ${challenge.index + 1}/${challenge.total} ` +
        `("${challenge.current?.label}") after ${(steps / 60).toFixed(0)} s`,
    );
    assert.ok(challenge.result.score > 0);
  }
});

test('the strafe drill is completable on an X-drive too', () => {
  const sim = makeSim({ 'drivetrain.type': 'xdrive' });
  const challenge = sim.challenges.select('strafe');
  sim.setOpMode(new AutoDriver(challenge));
  let steps = 0;
  while (challenge.state !== 'complete' && steps < 60 * 150) {
    sim.step(1 / 60);
    steps++;
  }
  assert.equal(challenge.state, 'complete', 'strafe drill should work on any holonomic drivetrain');
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
