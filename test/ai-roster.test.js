import test from 'node:test';
import assert from 'node:assert/strict';
import { Config } from '../src/config/Config.js';
import { Simulation } from '../src/app/Simulation.js';
import { Vec2 } from '../src/math/Vec2.js';
import {
  ROBOT_ARCHETYPES,
  BUILD_QUALITIES,
  ARCHETYPE_BY_ID,
  QUALITY_BY_ID,
  launcherOptions,
  throwerOptions,
  intakeOptions,
} from '../src/ai/archetypes.js';
import { buildRoster, ROSTER_SLOTS } from '../src/ai/roster.js';
import { routeAroundHive } from '../src/ai/gamePlan.js';
import { Thrower } from '../src/robot/biobuzz/Thrower.js';
import { Launcher } from '../src/robot/biobuzz/Launcher.js';
import { POLLEN_MASS, NECTAR_MASS } from '../src/field/biobuzz/constants.js';

/** A deterministic stand-in for Math.random, so a MATCH replays identically. */
function seeded(seed) {
  let s = seed;
  return () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
}

function matchSim(overrides = {}, seed = 4242) {
  const config = new Config();
  config.set('ai.enabled', true);
  config.set('match.startPhase', 'teleop');
  for (const [path, value] of Object.entries(overrides)) config.set(path, value);
  const sim = new Simulation(config);
  sim.random = seeded(seed);
  return sim;
}

/** Run `seconds` of MATCH at the control rate. */
function play(sim, seconds, step = 1 / 50) {
  for (let i = 0; i < Math.round(seconds / step); i++) sim.step(step);
  return sim;
}

// --------------------------------------------------------------- the roster

test('the roster fills three seats, one of them on your own alliance', () => {
  const roster = buildRoster(
    {
      partner: { enabled: true, archetype: 'cycler', quality: 'solid', skill: 'veteran' },
      opponent1: { enabled: true, archetype: 'defender', quality: 'rough', skill: 'rookie' },
      opponent2: { enabled: true, archetype: 'gardener', quality: 'elite', skill: 'competent' },
    },
    'red',
    seeded(1),
  );

  assert.equal(roster.length, 3);
  assert.deepEqual(
    roster.map((r) => [r.slot, r.alliance, r.archetypeId, r.qualityId, r.skillId]),
    [
      ['partner', 'red', 'cycler', 'solid', 'veteran'],
      ['opponent1', 'blue', 'defender', 'rough', 'rookie'],
      ['opponent2', 'blue', 'gardener', 'elite', 'competent'],
    ],
  );
});

test('a disabled seat stays empty, and random resolves to something real', () => {
  const roster = buildRoster(
    {
      partner: { enabled: false },
      opponent1: { enabled: true, archetype: 'random', quality: 'random', skill: 'random' },
      opponent2: { enabled: true, archetype: 'nonsense', quality: 'nonsense', skill: 'x' },
    },
    'blue',
    seeded(7),
  );

  assert.equal(roster.length, 2);
  for (const entry of roster) {
    assert.ok(ARCHETYPE_BY_ID[entry.archetypeId], `${entry.archetypeId} is a real archetype`);
    assert.ok(QUALITY_BY_ID[entry.qualityId], `${entry.qualityId} is a real build quality`);
    assert.equal(entry.alliance, 'red', 'both opponents oppose a blue player');
  }
});

test('random really does vary, and the same seed repeats', () => {
  const config = {
    partner: { enabled: true, archetype: 'random', quality: 'random', skill: 'random' },
    opponent1: { enabled: true, archetype: 'random', quality: 'random', skill: 'random' },
    opponent2: { enabled: true, archetype: 'random', quality: 'random', skill: 'random' },
  };
  const key = (roster) => roster.map((r) => `${r.archetypeId}/${r.qualityId}/${r.skillId}`).join();

  const seen = new Set();
  for (let seed = 1; seed <= 25; seed++) seen.add(key(buildRoster(config, 'red', seeded(seed))));
  assert.ok(seen.size > 8, `25 seeds gave only ${seen.size} distinct line-ups`);
  assert.equal(key(buildRoster(config, 'red', seeded(9))), key(buildRoster(config, 'red', seeded(9))));
});

test('the settings panel covers every seat', () => {
  // The three slots are generated from one template, so the failure mode is a
  // slot with no controls at all rather than a wrong control.
  const config = new Config();
  for (const slot of ROSTER_SLOTS) {
    const settings = config.values.ai[slot.id];
    assert.ok(settings, `${slot.id} has no settings`);
    for (const key of ['enabled', 'archetype', 'quality', 'skill']) {
      assert.ok(key in settings, `${slot.id} is missing ${key}`);
    }
  }
});

// ----------------------------------------------------------------- the FIELD

test('every shooting archetype has somewhere legal it can score from', () => {
  // This is the invariant that matters most, and it is not obvious: a CELL
  // faces along the HIVE's arm and only accepts a descending element, so the
  // shot has to come from outside the opening plane -- which is a band near the
  // far wall -- *and* be within the mechanism's reach. The catapult failed it,
  // and not for lack of energy: its arm stopped at 72 degrees and the lofted
  // solution at the ranges the FIELD allows wants 76. It stood in the open all
  // match holding four POLLEN.
  for (const archetype of ROBOT_ARCHETYPES) {
    if (!archetype.launcher && !archetype.thrower) continue;
    for (const playerAlliance of ['red', 'blue']) {
      const sim = matchSim({
        'match.alliance': playerAlliance,
        'ai.partner.enabled': false,
        'ai.opponent2.enabled': false,
        'ai.opponent1.archetype': archetype.id,
        'ai.opponent1.quality': 'solid',
        'ai.opponent1.skill': 'veteran',
      });
      const game = sim.enableGame().start();
      const ai = sim.opponents[0];
      assert.ok(ai.launcher, `${archetype.id} should have built a launcher`);

      const hive = game.field.hives[ai.alliance];
      const target = game.field.hiveTarget(ai.alliance);
      const limit = sim.field.halfSize - ai.robot.halfLength - 0.06;

      let spots = 0;
      for (let ri = 0; ri < 20 && spots === 0; ri++) {
        const range = 0.8 + ri * 0.15;
        for (let i = 0; i < 72; i++) {
          const azimuth = (i / 72) * Math.PI * 2;
          const x = target.x + Math.cos(azimuth) * range;
          const y = target.y + Math.sin(azimuth) * range;
          if (Math.abs(x) > limit || Math.abs(y) > limit) continue;
          if (hive.openingDepth(hive.up, x, y, ai.launcher.exitHeight) <= 0) continue;
          if (!ai.launcher.aimFor(target, undefined, { x, y })) continue;
          spots++;
        }
      }
      assert.ok(
        spots > 0,
        `a ${archetype.id} on ${ai.alliance} has nowhere on the tiles it can score from`,
      );
    }
  }
});

test('paths route around the HIVE rather than into it', () => {
  // The two A-frames block the middle of the FIELD in a band. Driving the
  // straight line wedges a robot against a strut leg, where it sits at half
  // power going nowhere.
  const from = new Vec2(1.4, 0.1);
  const to = new Vec2(-1.4, 0.1);
  const waypoint = routeAroundHive(from, to);
  assert.notEqual(waypoint, to, 'a line straight through the HIVE needs a waypoint');
  assert.ok(Math.abs(waypoint.y) > 0.6, 'and the waypoint is clear of the frame in y');

  // Already clear: handed straight back, so the common case costs nothing.
  const clear = new Vec2(-1.4, 1.5);
  assert.equal(routeAroundHive(new Vec2(1.4, 1.5), clear), clear);

  // Walking the two legs converges rather than looping.
  let at = from;
  const seen = [];
  for (let i = 0; i < 6; i++) {
    const next = routeAroundHive(at, to);
    seen.push(`${next.x.toFixed(2)},${next.y.toFixed(2)}`);
    if (next === to) break;
    at = next;
  }
  assert.ok(seen.length <= 4, `route took ${seen.length} legs: ${seen.join(' -> ')}`);
  assert.equal(routeAroundHive(at, to), to, 'the last leg is the goal itself');
});

// ------------------------------------------------------------ playing a MATCH

test('a shooting AI puts elements in its own CELL', () => {
  const sim = matchSim({
    'ai.partner.enabled': false,
    'ai.opponent2.enabled': false,
    'ai.opponent1.archetype': 'twinWheel',
    'ai.opponent1.quality': 'elite',
    'ai.opponent1.skill': 'veteran',
  });
  const game = sim.enableGame().start();
  const ai = sim.opponents[0];
  const hive = game.field.hives[ai.alliance];

  play(sim, 45);
  assert.ok(ai.launcher.shots > 3, `only ${ai.launcher.shots} shots in 45 s`);
  assert.ok(
    hive.tips > 0 || hive.elementsInUpCell() > 3,
    'nothing it fired ended up in the CELL',
  );
});

test('a FLOWER AI fills FLOWERS and never touches a CELL', () => {
  const sim = matchSim({
    'ai.partner.enabled': false,
    'ai.opponent2.enabled': false,
    'ai.opponent1.archetype': 'gardener',
    'ai.opponent1.quality': 'elite',
    'ai.opponent1.skill': 'veteran',
  });
  const game = sim.enableGame().start();
  const ai = sim.opponents[0];
  assert.equal(ai.launcher, null, 'a gardener has no launcher at all');

  const before = game.field.flowers.reduce((n, f) => n + f.stack.length, 0);
  play(sim, 60);
  const after = game.field.flowers.reduce((n, f) => n + f.stack.length, 0);
  assert.ok(after > before, `FLOWERS went from ${before} to ${after}`);
  assert.equal(game.field.hives[ai.alliance].tips, 0, 'and it tipped nothing');
});

test('a pushbot scores nothing, which is the point of it', () => {
  const sim = matchSim({
    'ai.partner.enabled': false,
    'ai.opponent2.enabled': false,
    'ai.opponent1.archetype': 'pushbot',
    'ai.opponent1.quality': 'elite',
    'ai.opponent1.skill': 'veteran',
  });
  const game = sim.enableGame().start();
  const ai = sim.opponents[0];
  assert.equal(ai.launcher, null);
  assert.equal(ai.intake, null, 'and no intake either');

  const flowers = game.field.flowers.reduce((n, f) => n + f.stack.length, 0);
  const from = { x: ai.robot.body.position.x, y: ai.robot.body.position.y };
  play(sim, 40);
  assert.equal(game.field.hives[ai.alliance].tips, 0);
  assert.equal(game.field.flowers.reduce((n, f) => n + f.stack.length, 0), flowers);
  // It does move, though: an obstacle that sits still is just furniture.
  // Measured from the pose, because `stats` is only accumulated for the
  // player's own ROBOT -- it is a session readout for the HUD, not physics.
  const moved = Math.hypot(ai.robot.body.position.x - from.x, ai.robot.body.position.y - from.y);
  assert.ok(moved > 0.5, `a pushbot still drives around, moved ${moved.toFixed(2)} m`);
});

test('the roster comes off with the game, and hand-added opponents stay', () => {
  const sim = matchSim({
    'ai.partner.archetype': 'cycler',
    'ai.opponent1.archetype': 'defender',
    'ai.opponent2.enabled': false,
  });
  const mine = sim.addOpponent({
    profileId: 'rival',
    skillId: 'competent',
    behavior: 'chaser',
    start: { x: 1, y: 1, heading: 0 },
  });
  assert.equal(sim.opponents.length, 1);

  const game = sim.enableGame().start();
  assert.equal(sim.opponents.length, 3, 'two roster robots joined the one already there');
  assert.equal(game.participants.length, 4);

  sim.disableGame();
  assert.equal(sim.opponents.length, 1, 'only the roster robots left');
  assert.equal(sim.opponents[0], mine);
  assert.equal(mine.intake, null, 'and its mechanisms went with the game');
});

test('the seats stay empty until you ask for them', () => {
  const sim = matchSim({ 'ai.enabled': false });
  const game = sim.enableGame().start();
  assert.equal(sim.opponents.length, 0);
  assert.equal(game.participants.length, 1, 'just you');
});

test('changing the roster settings rebuilds the FIELD', () => {
  const config = new Config();
  config.set('ai.enabled', true);
  config.set('ai.partner.archetype', 'cycler');
  config.set('ai.partner.quality', 'solid');
  config.set('ai.partner.skill', 'veteran');
  config.set('ai.opponent1.enabled', false);
  config.set('ai.opponent2.enabled', false);
  const sim = new Simulation(config);
  sim.random = seeded(3);
  const game = sim.enableGame().start();
  assert.equal(sim.opponents.length, 1);
  assert.equal(sim.opponents[0].archetype.id, 'cycler');

  config.set('ai.partner.archetype', 'defender');
  assert.notEqual(sim.game, game, 'a different robot means a different game');
  assert.equal(sim.opponents.length, 1);
  assert.equal(sim.opponents[0].archetype.id, 'defender');

  // Turning the seats off empties the FIELD.
  config.set('ai.enabled', false);
  assert.equal(sim.opponents.length, 0);
  assert.equal(sim.game.participants.length, 1);
});

test('a roster left on Random is not re-rolled by an unrelated setting', () => {
  // Comparing the resolved line-up rather than the settings would re-roll on
  // every change, so the robots would swap identity mid-MATCH whenever anyone
  // nudged a slider.
  const config = new Config();
  config.set('ai.enabled', true);
  const sim = new Simulation(config);
  sim.random = seeded(5);
  const game = sim.enableGame().start();
  const before = game.lineup().map((r) => r.name).join();

  config.set('match.teleopSeconds', 90);
  config.set('view.showTrail', false);
  assert.equal(sim.game, game, 'the game was not rebuilt');
  assert.equal(sim.game.lineup().map((r) => r.name).join(), before);
});

test('a jam is the robot, not the driver', () => {
  // Jams used to be rolled once per re-plan, and the re-plan rate comes from
  // driver skill -- so a veteran on a rough robot jammed about once a second
  // and never scored, while a rookie on the same robot was mechanically
  // reliable. Exactly backwards.
  const jamsFor = (skillId) => {
    const sim = matchSim(
      {
        'ai.partner.enabled': false,
        'ai.opponent2.enabled': false,
        'ai.opponent1.archetype': 'cycler',
        'ai.opponent1.quality': 'rough',
        'ai.opponent1.skill': skillId,
      },
      31,
    );
    sim.enableGame().start();
    play(sim, 60);
    return sim.opponents[0].jams;
  };

  const rookie = jamsFor('rookie');
  const veteran = jamsFor('veteran');
  assert.ok(rookie > 0 && veteran > 0, `rough builds should jam: ${rookie} / ${veteran}`);
  assert.ok(
    Math.abs(rookie - veteran) <= Math.max(6, rookie * 0.8),
    `driver skill changed the jam count: rookie ${rookie}, veteran ${veteran}`,
  );
});

// -------------------------------------------------------- build quality axis

test('build quality changes the machine in the directions it claims to', () => {
  const cycler = ARCHETYPE_BY_ID.cycler;
  const rough = launcherOptions(cycler, QUALITY_BY_ID.rough);
  const elite = launcherOptions(cycler, QUALITY_BY_ID.elite);

  assert.ok(elite.motorCount > rough.motorCount, 'more motors on the wheel');
  assert.ok(elite.feedInterval < rough.feedInterval, 'feeds faster');
  assert.ok(elite.readyTolerance > rough.readyTolerance, 'waits for the wheel properly');
  assert.ok(elite.hoodScatter < rough.hoodScatter, 'and holds its hood angle');
  assert.ok(elite.rpmScatter < rough.rpmScatter);

  const roughIntake = intakeOptions(cycler, QUALITY_BY_ID.rough);
  const eliteIntake = intakeOptions(cycler, QUALITY_BY_ID.elite);
  assert.ok(eliteIntake.capacity > roughIntake.capacity);
  assert.ok(eliteIntake.reach > roughIntake.reach);
  assert.ok(eliteIntake.spinUpTime < roughIntake.spinUpTime);

  // A thrower has no "fired too early" failure, so quality shows up in the
  // winding time and the throw-to-throw spread instead.
  const catapult = ARCHETYPE_BY_ID.catapult;
  const roughThrow = throwerOptions(catapult, QUALITY_BY_ID.rough);
  const eliteThrow = throwerOptions(catapult, QUALITY_BY_ID.elite);
  assert.ok(eliteThrow.resetSeconds < roughThrow.resetSeconds);
  assert.ok(eliteThrow.energyScatter < roughThrow.energyScatter);
  assert.ok(eliteThrow.angleScatter < roughThrow.angleScatter);
});

test('an archetype committed to two motors keeps them at every build quality', () => {
  // A Sniper's whole identity is the flywheel. A rough Sniper is a rough
  // two-motor shooter, not a one-motor one.
  const sniper = ARCHETYPE_BY_ID.sniper;
  for (const quality of BUILD_QUALITIES) {
    assert.ok(launcherOptions(sniper, quality).motorCount >= 2, `${quality.id} sniper`);
  }
});

// --------------------------------------------------------- thrower behaviour

test('a catapult is an energy source, so mass matters far more than it does to a wheel', () => {
  const thrower = new Thrower({ energy: 1.35, efficiency: 0.72 });
  const pollen = thrower.exitSpeedFor(POLLEN_MASS);
  const nectar = thrower.exitSpeedFor(NECTAR_MASS);
  // v = sqrt(2*eta*E/m), so the ratio is sqrt(m_p/m_n) exactly.
  assert.ok(
    Math.abs(nectar / pollen - Math.sqrt(POLLEN_MASS / NECTAR_MASS)) < 1e-12,
    'speed should go as one over the square root of mass',
  );
  assert.ok(nectar < pollen * 0.75, `a NECTAR leaves at ${nectar.toFixed(2)} vs ${pollen.toFixed(2)}`);

  // A flywheel barely notices, because it is a speed source and the mass only
  // shows up in the droop.
  const wheel = new Launcher({ transferEfficiency: 0.5 });
  wheel.omega = 250;
  const ratio = wheel.exitSpeedFor(NECTAR_MASS) / wheel.exitSpeedFor(POLLEN_MASS);
  assert.ok(ratio > 0.92, `a flywheel's NECTAR is only ${((1 - ratio) * 100).toFixed(0)}% slower`);
});

test('a batch shares the stored energy, and the solver knows it', () => {
  const single = new Thrower({ energy: 3.4, batch: 1 });
  const triple = new Thrower({ energy: 3.4, batch: 3 });
  // Same elastic, three at a time: each leaves at 1/sqrt(3) of the speed.
  const target = { x: 2, y: 0, z: 1.5 };
  const fake = { halfLength: 0.2 };
  for (const t of [single, triple]) {
    t.robot = fake;
    Object.defineProperty(t, 'pose', {
      value: { x: 0, y: 0, cos: 1, sin: 0, vx: 0, vy: 0 },
      configurable: true,
    });
  }
  const one = single.trajectory();
  const three = triple.trajectory();
  assert.ok(
    Math.abs(three.speed / one.speed - 1 / Math.sqrt(3)) < 1e-9,
    'a triple throw is 1/sqrt(3) the speed',
  );
  // And the aiming solver has to agree with the launch, or it aims for a range
  // it cannot reach and then declines every shot on the FIELD.
  const solved = triple.solutionFor(target);
  if (solved) assert.ok(Math.abs(solved.speed - three.speed) < 1e-9);
  const solvedSingle = single.solutionFor(target);
  if (solvedSingle) assert.ok(Math.abs(solvedSingle.speed - one.speed) < 1e-9);
});

test('a thrower is loaded or it is not -- there is no firing early', () => {
  const thrower = new Thrower({ resetSeconds: 1, energy: 1 });
  assert.equal(thrower.ready, true);
  assert.equal(thrower.needsSpinUp, false, 'nothing to spin up, so the HUD must not ask');
  thrower.resetRemaining = 1;
  assert.equal(thrower.ready, false);
  assert.ok(thrower.recovery < 0.01);
  thrower.applyForces(0.5, 12);
  assert.ok(Math.abs(thrower.recovery - 0.5) < 1e-9, 'half wound');
  assert.ok(thrower.current > 0, 'and drawing current while it winds');
  thrower.applyForces(0.6, 12);
  assert.equal(thrower.ready, true);
  assert.ok(thrower.current > 0, 'the last of the winding still draws');
  thrower.applyForces(0.1, 12);
  assert.equal(thrower.current, 0, 'loaded and idle draws nothing');
});

// -------------------------------------------------------------- routing

test('the corridor between the A-frames is drivable, so the middle is reachable', () => {
  // An element the HIVE has just dropped lands right under it. The keep-out
  // used to be one box over the whole middle of the FIELD, and a target inside
  // a box is unroutable -- the AI circled it for the rest of the MATCH without
  // ever reaching it.
  const from = new Vec2(0, -1.4);
  const to = new Vec2(0, 0);
  assert.deepEqual(
    [routeAroundHive(from, to).x, routeAroundHive(from, to).y],
    [to.x, to.y],
    'front to back through the middle is a straight line',
  );
});

test('a target inside an A-frame footprint becomes a spot beside it', () => {
  // Resting against the inner face of the red foot bar: not somewhere a ROBOT
  // can put its centre, so the plan has to stand at the edge and let the intake
  // reach. The old routing looped forever on this instead, because the segment
  // test calls any endpoint inside the box a crossing.
  const to = new Vec2(-0.55, 0.1);
  // Approached from inside the corridor, which is where the detour ends up, the
  // standing spot is right there and the intake covers the rest -- it reaches
  // four to six inches.
  const beside = routeAroundHive(new Vec2(-0.1, 0.1), to);
  assert.notDeepEqual([beside.x, beside.y], [to.x, to.y], 'it is not driven onto');
  assert.ok(
    Math.hypot(beside.x - to.x, beside.y - to.y) < 0.35,
    `stood ${Math.hypot(beside.x - to.x, beside.y - to.y).toFixed(2)} m away`,
  );

  // And from outside the frame the route converges on that same spot rather
  // than cycling, which is the behaviour that was broken.
  let at = new Vec2(-1.5, 0.1);
  const seen = new Set();
  for (let i = 0; i < 12; i++) {
    const next = routeAroundHive(at, to);
    const key = `${next.x.toFixed(3)},${next.y.toFixed(3)}`;
    if (key === `${at.x.toFixed(3)},${at.y.toFixed(3)}`) break;
    assert.ok(!seen.has(key), `route revisited ${key}`);
    seen.add(key);
    at = next;
  }
  assert.ok(
    Math.hypot(at.x - to.x, at.y - to.y) < 0.45,
    `the route ended ${Math.hypot(at.x - to.x, at.y - to.y).toFixed(2)} m from the element`,
  );
});

test('crossing the FIELD sideways goes round the end of the frames', () => {
  const from = new Vec2(-1.5, 0);
  const to = new Vec2(1.5, 0);
  const first = routeAroundHive(from, to);
  assert.notDeepEqual([first.x, first.y], [to.x, to.y], 'the straight line is blocked');
  assert.ok(Math.abs(first.y) > 0.7, `into a lane clear of the frames: y=${first.y}`);

  // Follow the route and it terminates at the destination rather than cycling.
  let at = from;
  const seen = new Set();
  for (let i = 0; i < 12; i++) {
    const next = routeAroundHive(at, to);
    if (next.x === to.x && next.y === to.y) break;
    const key = `${next.x.toFixed(3)},${next.y.toFixed(3)}`;
    assert.ok(!seen.has(key), `route revisited ${key}`);
    seen.add(key);
    at = next;
  }
  assert.ok(
    Math.hypot(at.x - to.x, at.y - to.y) < 1.2,
    `the route got to within ${Math.hypot(at.x - to.x, at.y - to.y).toFixed(2)} m`,
  );
});

// ----------------------------------------------------------- playing better

test('an AI cycler fills its magazine before driving off to shoot', () => {
  const config = new Config();
  config.set('ai.enabled', false);
  const sim = new Simulation(config);
  const opponent = sim.addOpponent({
    id: 'blue1',
    alliance: 'blue',
    archetypeId: 'twinWheel',
    qualityId: 'elite',
    skillId: 'veteran',
    start: { x: 1.4, y: 0.4, heading: Math.PI },
  });
  const game = sim.enableGame({ alliance: 'red', startPhase: 'teleop' }).start();
  const intake = opponent._biobuzz.intake;
  assert.ok(intake.capacity >= 3, 'this archetype has a magazine worth filling');

  // Empty it, then give it one element and let it plan.
  for (const ball of intake.held.slice()) ball.release();
  intake.held.length = 0;
  const pollen = game.field.ballWorld.balls.filter((b) => b.free && b.kind === 'pollen')[0];
  intake.give(pollen);
  for (let i = 0; i < 30; i++) sim.step(1 / 60);

  assert.equal(
    opponent.state.phase,
    'collecting',
    'one element is not a cycle -- the drive to the CELL costs more than the pickup',
  );
});

test('an AI heads for its LOADING ZONE before the buzzer, which is 5 points', () => {
  const config = new Config();
  config.set('ai.enabled', false);
  const sim = new Simulation(config);
  const opponent = sim.addOpponent({
    id: 'blue1',
    alliance: 'blue',
    archetypeId: 'twinWheel',
    qualityId: 'elite',
    skillId: 'veteran',
    start: { x: 0.9, y: -1.4, heading: Math.PI },
  });
  const game = sim.enableGame({ alliance: 'red', startPhase: 'teleop', teleopSeconds: 8 }).start();

  for (let i = 0; i < 60 * 9; i++) sim.step(1 / 60);
  assert.equal(game.match.phase, 'ended');
  assert.ok(
    game.match.parked(opponent.robot, 'blue'),
    `expected a PARK, ended at (${opponent.robot.body.position.x.toFixed(2)}, ` +
      `${opponent.robot.body.position.y.toFixed(2)})`,
  );
  assert.equal(game.match.score().blue.parkTeleop, 5);
});

/**
 * Both of these are the same bug wearing two hats: something that is
 * legitimately allowed to disturb the AI's driving disturbed it so much that it
 * left a PARK it had already made, in the last second, for no points. A drive
 * team does plenty of things wrong at the buzzer; driving out of their own
 * LOADING ZONE is not one of them.
 */
function parkedOpponent(teleopSeconds = 8) {
  const config = new Config();
  config.set('ai.enabled', false);
  const sim = new Simulation(config);
  const opponent = sim.addOpponent({
    id: 'blue1',
    alliance: 'blue',
    archetypeId: 'twinWheel',
    qualityId: 'elite',
    skillId: 'veteran',
    start: { x: 0.9, y: -1.4, heading: Math.PI },
    // Pinned high: it never rolls a mistake or a jam of its own (both fire on
    // `random() <` a small chance), and `_noise` holds at +0.98 instead of
    // being re-rolled 12 times a second. That matters below -- a sign that
    // flips at 12 Hz averages out, and averaging out is what hid this.
    random: () => 0.99,
  });
  const game = sim.enableGame({ alliance: 'red', startPhase: 'teleop', teleopSeconds }).start();
  // Long enough to give up on cycling and settle into the zone.
  for (let i = 0; i < 60 * 5; i++) sim.step(1 / 60);
  assert.ok(
    game.match.parked(opponent.robot, 'blue'),
    `expected it to be in the zone by now, at (${opponent.robot.body.position.x.toFixed(2)}, ` +
      `${opponent.robot.body.position.y.toFixed(2)})`,
  );
  return { sim, game, opponent };
}

test('a jam does not make an AI abandon its PARK to chase the player', () => {
  const { sim, game, opponent } = parkedOpponent();

  // Seize the intake for the rest of the MATCH. `jamsPerMinute` would get
  // there eventually, but which second it picks is exactly the randomness this
  // is about, so it is forced.
  opponent._jammedUntil = opponent.time + 10;
  for (let i = 0; i < 60 * 4; i++) sim.step(1 / 60);

  assert.equal(game.match.phase, 'ended');
  assert.ok(
    game.match.parked(opponent.robot, 'blue'),
    `a jammed intake is a mechanism failure, not a change of plan; ended at ` +
      `(${opponent.robot.body.position.x.toFixed(2)}, ` +
      `${opponent.robot.body.position.y.toFixed(2)})`,
  );
  assert.equal(game.match.score().blue.parkTeleop, 5);
});

test('a driver mistake does not drive an AI out of a PARK it has already made', () => {
  const { sim, game, opponent } = parkedOpponent();

  // Mid-mistake for the rest of the MATCH, and at full displacement. The sign
  // is re-rolled every re-plan, so this covers both directions.
  opponent._mistakeUntil = opponent.time + 10;
  opponent._noise = 1;
  for (let i = 0; i < 60 * 4; i++) sim.step(1 / 60);
  assert.equal(game.match.phase, 'ended');

  assert.ok(
    game.match.parked(opponent.robot, 'blue'),
    `a fumble displaces a drive, and there is no drive left to displace; ended at ` +
      `(${opponent.robot.body.position.x.toFixed(2)}, ` +
      `${opponent.robot.body.position.y.toFixed(2)})`,
  );
  assert.equal(game.match.score().blue.parkTeleop, 5);
});

test('a mistake still throws a long drive well off course', () => {
  // Same robot, same first two seconds, once clean and once fumbling the whole
  // way. Scaling the mistake by the length of the drive must not have quietly
  // turned it off for drives that actually go somewhere.
  const drive = (mistake) => {
    const config = new Config();
    config.set('ai.enabled', false);
    const sim = new Simulation(config);
    const opponent = sim.addOpponent({
      id: 'blue1',
      alliance: 'blue',
      archetypeId: 'twinWheel',
      qualityId: 'elite',
      skillId: 'veteran',
      start: { x: 1.3, y: 1.2, heading: Math.PI },
      random: () => 0.99, // never rolls a mistake of its own, never jams
    });
    sim.enableGame({ alliance: 'red', startPhase: 'teleop', teleopSeconds: 60 }).start();
    for (let i = 0; i < 60 * 2; i++) {
      if (mistake) {
        opponent._mistakeUntil = opponent.time + 1;
        opponent._noise = 1;
      }
      sim.step(1 / 60);
    }
    return new Vec2(opponent.robot.body.position.x, opponent.robot.body.position.y);
  };

  const clean = drive(false);
  const fumbled = drive(true);
  assert.ok(
    Vec2.sub(clean, fumbled).length() > 0.3,
    `a fumbled drive should end up somewhere else: clean (${clean.x.toFixed(2)}, ` +
      `${clean.y.toFixed(2)}) vs fumbled (${fumbled.x.toFixed(2)}, ${fumbled.y.toFixed(2)})`,
  );
});

/**
 * Traffic. None of the plans know about the other three ROBOTS -- they name a
 * place to be -- so without this an AI drove straight through whoever was
 * standing there, which the REFEREE calls as a G421 PIN every three seconds.
 */
function trafficContext(selfX, selfY, targetX, targetY, others) {
  const config = new Config();
  config.set('ai.enabled', false);
  const sim = new Simulation(config);
  const opponent = sim.addOpponent({
    id: 'blue1',
    alliance: 'blue',
    archetypeId: 'twinWheel',
    qualityId: 'elite',
    skillId: 'veteran',
    start: { x: selfX, y: selfY, heading: 0 },
  });
  opponent.matchId = 'blue1';
  const entries = others.map((o, i) => ({
    id: o.id ?? `other${i}`,
    robot: { body: { position: { x: o.x, y: o.y } } },
  }));
  const ctx = {
    selfPosition: new Vec2(selfX, selfY),
    selfHeading: 0,
    game: { match: { entries: [...entries, { id: 'blue1', robot: opponent.robot }] } },
  };
  const intent = { point: new Vec2(targetX, targetY), arrive: true, faceTarget: true, fire: true };
  opponent._yieldToTraffic(intent, ctx);
  return intent;
}

test('an AI steers around a ROBOT standing in its path', () => {
  // Straight down +x, with somebody parked half a metre along the line.
  const intent = trafficContext(0, 0, 1.4, 0, [{ x: 0.5, y: 0 }]);
  assert.ok(
    Math.abs(intent.point.y) > 0.5,
    `expected a waypoint off to one side, got (${intent.point.x.toFixed(2)}, ${intent.point.y.toFixed(2)})`,
  );
  assert.equal(intent.arrive, false, 'a detour waypoint is not somewhere to settle');
  assert.equal(intent.fire, false, 'and not somewhere to shoot from');
});

test('an AI passes on the side the other ROBOT is not on', () => {
  const left = trafficContext(0, 0, 1.4, 0, [{ x: 0.5, y: 0.2 }]);
  assert.ok(left.point.y < 0, `blocker to the left, so pass right: ${left.point.y.toFixed(2)}`);
  const right = trafficContext(0, 0, 1.4, 0, [{ x: 0.5, y: -0.2 }]);
  assert.ok(right.point.y > 0, `blocker to the right, so pass left: ${right.point.y.toFixed(2)}`);
});

test('an AI does not swerve away from the ROBOT it is driving at', () => {
  // A defender blocking the player: the player *is* the destination, and
  // steering around the destination would make the whole role impossible.
  const intent = trafficContext(0, 0, 1.4, 0, [{ x: 1.4, y: 0 }]);
  assert.equal(intent.point.x, 1.4, 'target untouched');
  assert.equal(intent.point.y, 0);
  assert.equal(intent.arrive, true, 'still arriving');
  assert.equal(intent.fire, true);
});

test('an AI ignores traffic that is not in the way', () => {
  const beside = trafficContext(0, 0, 1.4, 0, [{ x: 0.5, y: 0.9 }]);
  assert.equal(beside.point.y, 0, 'a robot a metre off the line is not traffic');
  const behind = trafficContext(0, 0, 1.4, 0, [{ x: -0.5, y: 0 }]);
  assert.equal(behind.point.y, 0, 'and neither is one behind it');
  const faraway = trafficContext(0, 0, 4, 0, [{ x: 2.5, y: 0 }]);
  assert.equal(faraway.point.y, 0, 'nor one further off than the lookahead');
});

test('an AI goes around a stationary ROBOT rather than PINNING it', () => {
  const config = new Config();
  config.set('ai.enabled', false);
  const sim = new Simulation(config);
  const opponent = sim.addOpponent({
    id: 'blue1',
    alliance: 'blue',
    archetypeId: 'twinWheel',
    qualityId: 'elite',
    skillId: 'veteran',
    start: { x: 0.2, y: -0.9, heading: 0 },
    random: () => 0.99,
  });
  // Short TELEOP, so the plan is PARK from the first cycle and the AI's target
  // is the one place on the FIELD this test can predict: its LOADING ZONE.
  const game = sim.enableGame({ alliance: 'red', startPhase: 'teleop', teleopSeconds: 12 }).start();
  opponent.robot.reset(0.2, -0.9, 0);
  // And the player parked squarely on the line it has to drive, doing nothing --
  // which is what a driver practising their aim looks like, and the case that
  // used to cost a MAJOR FOUL every three seconds.
  sim.setStartPose(0.85, -0.9, 0);
  sim.resetRobot();

  for (let i = 0; i < 60 * 13; i++) sim.step(1 / 60);

  const pins = game.match.referee.recent(999).filter((c) => c.rule === 'G421');
  assert.equal(
    pins.length,
    0,
    `it should have gone around: ${pins.map((c) => c.detail).join('; ')}`,
  );
  assert.ok(
    game.match.parked(opponent.robot, 'blue'),
    `and still got there, ended at (${opponent.robot.body.position.x.toFixed(2)}, ` +
      `${opponent.robot.body.position.y.toFixed(2)})`,
  );
});
