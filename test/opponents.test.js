import test from 'node:test';
import assert from 'node:assert/strict';
import { Config } from '../src/config/Config.js';
import { Simulation } from '../src/app/Simulation.js';
import { OpMode } from '../src/teleop/OpMode.js';
import { Opponent } from '../src/ai/Opponent.js';
import { OPPONENT_PROFILES, SKILL_LEVELS, PROFILE_BY_ID, SKILL_BY_ID } from '../src/ai/profiles.js';
import { blocker, chaser, shadow, intentToCommand } from '../src/ai/behaviors.js';
import { RigidBody2d } from '../src/physics/RigidBody2d.js';
import { resolveDynamicPair, obbOverlap, pointInObb } from '../src/physics/collision.js';
import { Vec2 } from '../src/math/Vec2.js';

function seededRandom(seed = 999) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

function makeSim(tweaks = {}) {
  const config = new Config();
  for (const [path, value] of Object.entries(tweaks)) config.set(path, value);
  const sim = new Simulation(config);
  sim.random = seededRandom();
  return sim;
}

class Drive extends OpMode {
  constructor(forward = 0, strafe = 0, turn = 0) {
    super({ name: 'drive' });
    this.command = [forward, strafe, turn];
  }
  loop() {
    this.robot.drivetrain.driveNormalized(...this.command);
  }
}

// ---------------------------------------------------------------- profiles

test('opponent profiles are distinct and buildable', () => {
  const base = new Config().values;
  const seen = new Set();
  const masses = [];
  for (const profile of OPPONENT_PROFILES) {
    assert.ok(!seen.has(profile.id), `duplicate profile id ${profile.id}`);
    seen.add(profile.id);
    assert.ok(profile.name && profile.description, `${profile.id} is missing text`);

    const opponent = new Opponent({
      profileId: profile.id,
      skillId: 'competent',
      behavior: 'chaser',
      start: { x: 0, y: 0, heading: 0 },
      baseConfig: base,
      random: seededRandom(),
    });
    assert.ok(opponent.robot.body.mass > 0);
    assert.ok(opponent.robot.drivetrain.wheels.length >= 4);
    masses.push(opponent.robot.body.mass);
  }
  // The point of having several is that they are not interchangeable.
  assert.ok(Math.max(...masses) > Math.min(...masses) * 2, 'profiles should differ substantially in mass');
});

test('a scout is faster than a pusher, and a pusher is heavier', () => {
  const base = new Config().values;
  const build = (id) =>
    new Opponent({ profileId: id, skillId: 'veteran', behavior: 'chaser', start: { x: 0, y: 0, heading: 0 }, baseConfig: base });
  const scout = build('scout');
  const pusher = build('pusher');
  const topSpeed = (o) => o.robot.drivetrain.motors[0].freeOutputSpeed(12) * o.config.drivetrain.wheelRadius;
  assert.ok(topSpeed(scout) > topSpeed(pusher) * 1.5, 'the scout should be far quicker');
  assert.ok(pusher.robot.body.mass > scout.robot.body.mass * 1.8, 'the pusher should be far heavier');
  assert.equal(pusher.robot.drivetrain.canStrafe, false, 'the pusher is a tank build');
});

test('skill levels are ordered from worse to better', () => {
  for (let i = 1; i < SKILL_LEVELS.length; i++) {
    const worse = SKILL_LEVELS[i - 1];
    const better = SKILL_LEVELS[i];
    assert.ok(better.reactionSeconds < worse.reactionSeconds, 'reaction should improve');
    assert.ok(better.aimNoise < worse.aimNoise, 'precision should improve');
    assert.ok(better.maxPower >= worse.maxPower, 'commitment should not decrease');
    assert.ok(better.mistakeChance < worse.mistakeChance, 'mistakes should become rarer');
  }
});

// --------------------------------------------------------------- behaviors

test('the blocker puts itself between the player and their objective', () => {
  const player = new Vec2(-1.2, 0);
  const target = new Vec2(1.2, 0);
  const intent = blocker({
    playerPosition: player,
    playerVelocity: new Vec2(1, 0),
    playerHeading: 0,
    playerTarget: target,
    selfPosition: new Vec2(0, 1.5),
    selfHeading: 0,
    fieldHalfSize: 1.83,
    time: 0,
  });
  // It should sit on the segment between them, not on top of either.
  assert.ok(intent.point.x > player.x && intent.point.x < target.x, 'blocking point is not between them');
  assert.ok(Math.abs(intent.point.y) < 0.05, 'blocking point should be on the line');
});

test('the blocker falls back to the player when there is no objective', () => {
  const player = new Vec2(0.4, -0.3);
  const intent = blocker({
    playerPosition: player,
    playerVelocity: new Vec2(0, 0),
    playerHeading: 0,
    playerTarget: null,
    selfPosition: new Vec2(0, 0),
    selfHeading: 0,
    fieldHalfSize: 1.83,
    time: 0,
  });
  assert.equal(intent.point.x, player.x);
});

test('the chaser aims at the player and the shadow mirrors them', () => {
  const ctx = {
    playerPosition: new Vec2(0.8, -0.4),
    playerVelocity: new Vec2(0, 0),
    playerHeading: 0,
    playerTarget: null,
    selfPosition: new Vec2(0, 0),
    selfHeading: 0,
    fieldHalfSize: 1.83,
    time: 0,
  };
  assert.equal(chaser(ctx).point.x, 0.8);
  assert.equal(shadow(ctx).point.x, -0.8);
  assert.equal(shadow(ctx).point.y, 0.4);
});

test('commands are bounded and respect the skill power cap', () => {
  const ctx = {
    playerPosition: new Vec2(5, 5),
    playerVelocity: new Vec2(0, 0),
    playerHeading: 0,
    playerTarget: null,
    selfPosition: new Vec2(0, 0),
    selfHeading: 0,
    fieldHalfSize: 1.83,
    time: 0,
  };
  for (const skill of SKILL_LEVELS) {
    const command = intentToCommand({ point: new Vec2(5, 5) }, ctx, skill, true, 0);
    for (const value of [command.forward, command.strafe, command.turn]) {
      assert.ok(value >= -1 && value <= 1, 'commands must stay in range');
    }
    // With zero noise, a long way from the target, it should be at its cap.
    assert.ok(Math.abs(command.forward) <= skill.maxPower + 1e-9);
  }
});

test('a tank opponent never commands strafe', () => {
  const ctx = {
    playerPosition: new Vec2(0, 2),
    playerVelocity: new Vec2(0, 0),
    playerHeading: 0,
    playerTarget: null,
    selfPosition: new Vec2(0, 0),
    selfHeading: 0,
    fieldHalfSize: 1.83,
    time: 0,
  };
  const command = intentToCommand({ point: new Vec2(0, 2) }, ctx, SKILL_BY_ID.veteran, false, 0);
  assert.equal(command.strafe, 0);
  assert.ok(Math.abs(command.turn) > 0.1, 'it should turn toward the target instead');
});

// ---------------------------------------------------------------- physics

test('robot-on-robot collision conserves momentum', () => {
  const a = new RigidBody2d({ mass: 15, momentOfInertia: 0.4 });
  const b = new RigidBody2d({ mass: 15, momentOfInertia: 0.4 });
  a.reset(-0.3, 0, 0);
  b.reset(0.1, 0, 0);
  a.velocity.set(1.5, 0);
  const before = a.mass * a.velocity.x + b.mass * b.velocity.x;
  for (let i = 0; i < 40; i++) {
    resolveDynamicPair(a, 0.216, 0.203, b, 0.216, 0.203, { restitution: 0.2, friction: 0.4 });
  }
  const after = a.mass * a.velocity.x + b.mass * b.velocity.x;
  assert.ok(Math.abs(after - before) < 1e-6, `momentum changed: ${before} -> ${after}`);
});

test('a light robot bounces off a heavy one, not the other way round', () => {
  const hit = (massA, massB) => {
    const a = new RigidBody2d({ mass: massA, momentOfInertia: 0.4 });
    const b = new RigidBody2d({ mass: massB, momentOfInertia: 0.4 });
    a.reset(-0.3, 0, 0);
    b.reset(0.1, 0, 0);
    a.velocity.set(1.5, 0);
    for (let i = 0; i < 40; i++) {
      resolveDynamicPair(a, 0.216, 0.203, b, 0.216, 0.203, { restitution: 0.2, friction: 0.4 });
    }
    return { a: a.velocity.x, b: b.velocity.x };
  };
  const lightIntoHeavy = hit(6, 21);
  const heavyIntoLight = hit(21, 6);
  // The mover keeps far more of its speed when it outweighs what it hit.
  assert.ok(
    heavyIntoLight.a > lightIntoHeavy.a * 2,
    `heavy should barely slow (${heavyIntoLight.a}) vs light (${lightIntoHeavy.a})`,
  );
});

test('two robots never end up occupying the same space', () => {
  const a = new RigidBody2d({ mass: 14, momentOfInertia: 0.4 });
  const b = new RigidBody2d({ mass: 14, momentOfInertia: 0.4 });
  a.reset(0, 0, 0);
  b.reset(0.02, 0.01, 0.3); // deeply overlapping
  for (let i = 0; i < 200; i++) {
    resolveDynamicPair(a, 0.216, 0.203, b, 0.216, 0.203, { restitution: 0, friction: 0.4 });
  }
  const separation = Math.hypot(a.position.x - b.position.x, a.position.y - b.position.y);
  assert.ok(separation > 0.05, `robots stayed on top of each other (${separation.toFixed(3)} m apart)`);
  assert.ok(Number.isFinite(separation));
});

// -------------------------------------------------------------- integration

test('opponents run real physics and stay on the field', () => {
  const sim = makeSim();
  sim.addOpponent({ profileId: 'rival', skillId: 'veteran', behavior: 'chaser', start: { x: 1, y: 0, heading: Math.PI } });
  sim.setStartPose(-1.2, 0, 0);
  sim.resetRobot();
  sim.setOpMode(new Drive(0.8, 0.4, 0));
  for (let i = 0; i < 60 * 12; i++) sim.step(1 / 60);

  for (const opponent of sim.opponents) {
    const body = opponent.robot.body;
    assert.ok(body.isFinite(), 'opponent physics diverged');
    assert.ok(sim.field.contains(new Vec2(body.position.x, body.position.y), -0.3), 'opponent left the field');
    // It must actually be driving, not sitting still or teleporting.
    assert.ok(body.speed < 4, `implausible opponent speed ${body.speed}`);
  }
});

test('a chaser closes on the player', () => {
  const sim = makeSim();
  sim.addOpponent({ profileId: 'scout', skillId: 'veteran', behavior: 'chaser', start: { x: 1.4, y: 1.4, heading: Math.PI } });
  sim.setStartPose(-1.2, -1.2, 0);
  sim.resetRobot();
  sim.setOpMode(new Drive(0, 0, 0)); // sitting duck
  const start = Vec2.distance(sim.robot.body.position, sim.opponents[0].robot.body.position);
  for (let i = 0; i < 60 * 8; i++) sim.step(1 / 60);
  const end = Vec2.distance(sim.robot.body.position, sim.opponents[0].robot.body.position);
  assert.ok(end < start * 0.5, `chaser did not close: ${start.toFixed(2)} -> ${end.toFixed(2)} m`);
});

test('a heavy opponent blocks the player where a light one gets shoved aside', () => {
  // Park an opponent in the player's path and drive into it at full power.
  // `patroller` with a single waypoint at its own start makes it hold station,
  // which keeps the comparison about mass rather than about who drove better.
  const pushThrough = (profileId) => {
    const sim = makeSim();
    const start = { x: 0.9, y: 0, heading: Math.PI };
    sim.addOpponent({
      profileId,
      skillId: 'veteran',
      behavior: 'patroller',
      start,
      waypoints: [new Vec2(start.x, start.y)],
    });
    sim.setStartPose(-0.2, 0, 0);
    sim.resetRobot();
    sim.setOpMode(new Drive(1, 0, 0));
    for (let i = 0; i < 60 * 8; i++) sim.step(1 / 60);
    return {
      player: sim.robot.body.position.x,
      opponent: sim.opponents[0].robot.body.position.x,
    };
  };

  const vsBrick = pushThrough('brick');
  const vsScout = pushThrough('scout');

  assert.ok(
    vsScout.opponent > vsBrick.opponent + 0.15,
    `the light scout should be driven back further (scout ${vsScout.opponent.toFixed(2)} vs brick ${vsBrick.opponent.toFixed(2)})`,
  );
  assert.ok(
    vsScout.player > vsBrick.player,
    `the player should make more ground against the scout (${vsScout.player.toFixed(2)} vs ${vsBrick.player.toFixed(2)})`,
  );
});

test('a rookie is measurably worse than a veteran at the same job', () => {
  const closingDistance = (skillId) => {
    const sim = makeSim();
    sim.addOpponent({ profileId: 'rival', skillId, behavior: 'chaser', start: { x: 1.5, y: 0, heading: Math.PI } });
    sim.setStartPose(-1.5, 0, 0);
    sim.resetRobot();
    sim.setOpMode(new Drive(0, 0, 0));
    for (let i = 0; i < 60 * 6; i++) sim.step(1 / 60);
    return Vec2.distance(sim.robot.body.position, sim.opponents[0].robot.body.position);
  };
  const rookie = closingDistance('rookie');
  const veteran = closingDistance('veteran');
  assert.ok(veteran < rookie, `veteran (${veteran.toFixed(2)}) should close faster than rookie (${rookie.toFixed(2)})`);
});

test('opponent behaviour is reproducible when the randomness is seeded', () => {
  const run = () => {
    const sim = makeSim();
    sim.addOpponent({ profileId: 'rival', skillId: 'rookie', behavior: 'chaser', start: { x: 1.2, y: 0.4, heading: Math.PI } });
    sim.setStartPose(-1.2, 0, 0);
    sim.resetRobot();
    sim.setOpMode(new Drive(0.5, 0, 0));
    for (let i = 0; i < 60 * 5; i++) sim.step(1 / 60);
    return sim.opponents[0].robot.body.position.clone();
  };
  const a = run();
  const b = run();
  assert.ok(Vec2.distance(a, b) < 1e-9, 'seeded opponents must be deterministic');
});

test('drills spawn and clean up their opponents', () => {
  const sim = makeSim();
  sim.challenges.select('matchSim');
  assert.equal(sim.opponents.length, 2);
  sim.challenges.select('sprint');
  assert.equal(sim.opponents.length, 0, 'the previous drill\'s opponents should be removed');
  sim.challenges.select('defended');
  assert.equal(sim.opponents.length, 1);
  sim.challenges.clear();
  assert.equal(sim.opponents.length, 0);
});

test('being shoved by an opponent costs time in a contested drill', () => {
  const sim = makeSim();
  const challenge = sim.challenges.select('defended');
  assert.ok(challenge.opponentPenalty > 0);
  challenge.state = 'running';
  sim.robotContact = true;
  challenge.update(1 / 60, sim);
  assert.ok(challenge.opponentHits > 0, 'contact should be counted');
  assert.ok(challenge.penaltySeconds >= challenge.opponentPenalty);

  // Rate limited, so being leaned on does not bill every frame.
  const after = challenge.penaltySeconds;
  for (let i = 0; i < 30; i++) challenge.update(1 / 60, sim);
  assert.equal(challenge.penaltySeconds, after, 'the penalty should be rate limited');
});

test('config changes reach the opponents without losing their build', () => {
  const sim = makeSim();
  sim.addOpponent({ profileId: 'pusher', skillId: 'competent', behavior: 'blocker', start: { x: 0, y: 0, heading: 0 } });
  const before = sim.opponents[0].robot.body.mass;
  // Change something global; the opponent keeps its own chassis mass.
  sim.configStore.set('surface.muLongitudinal', 0.6);
  assert.equal(sim.opponents[0].robot.body.mass, before, 'opponent lost its own build');
  assert.equal(sim.opponents[0].config.surface.muLongitudinal, 0.6, 'opponent missed the global change');
});
