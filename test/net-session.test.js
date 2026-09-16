import test from 'node:test';
import assert from 'node:assert/strict';
import { Config } from '../src/config/Config.js';
import { Simulation } from '../src/app/Simulation.js';
import { LoopbackLink } from '../src/net/NetLink.js';
import { NetHost, INPUT_TIMEOUT } from '../src/net/NetHost.js';
import { NetClient } from '../src/net/NetClient.js';
import { FtcGamepad } from '../src/input/FtcGamepad.js';
import { buildSnapshot, blendSnapshots } from '../src/net/snapshot.js';
import { encodeSnapshot } from '../src/net/protocol.js';

/**
 * A real host and a real client, wired to each other with no socket between.
 *
 * This is the layer where the interesting bugs live -- a seat bound to the
 * wrong robot, a snapshot written onto the wrong ball, a blend that slides an
 * element through a HIVE wall -- and none of them are reachable from a
 * protocol round-trip test. A loopback pair means they are reachable from
 * `node --test` instead of from two browsers and a stopwatch.
 */
function rig({ latencySteps = 0 } = {}) {
  const links = LoopbackLink.pair({ latencySteps });

  const hostConfig = new Config();
  hostConfig.set('ai.enabled', true);
  hostConfig.set('ai.partner.archetype', 'twinWheel');
  hostConfig.set('ai.opponent1.archetype', 'gardener');
  hostConfig.set('ai.opponent2.archetype', 'catapult');
  const hostSim = new Simulation(hostConfig);
  const hostGame = hostSim.enableGame({ alliance: 'red', startPhase: 'teleop' });
  hostGame.start();
  const host = new NetHost({ link: links.host, sim: hostSim });
  hostSim.net = host;

  // The joiner builds the same field, then never steps it.
  const clientConfig = new Config();
  clientConfig.set('ai.enabled', true);
  clientConfig.set('ai.partner.archetype', 'twinWheel');
  clientConfig.set('ai.opponent1.archetype', 'gardener');
  clientConfig.set('ai.opponent2.archetype', 'catapult');
  const clientSim = new Simulation(clientConfig);
  const clientGame = clientSim.enableGame({ alliance: 'red', startPhase: 'teleop' });
  clientGame.start();
  const client = new NetClient({ link: links.client, sim: clientSim });
  clientSim.net = client;

  return { links, host, hostSim, hostGame, client, clientSim, clientGame };
}

/** The relay stamps the sender byte; the loopback has to do it too. */
function asPeer(link, id = 'p1') {
  const sender = Number(id.slice(1));
  const original = link.sendBinary.bind(link);
  link.sendBinary = (data) => {
    const bytes = new Uint8Array(data instanceof ArrayBuffer ? data.slice(0) : data);
    bytes[1] = sender;
    return original(bytes);
  };
  return link;
}

test('a joiner is given a robot that is already on the field', () => {
  const { host, hostSim, client } = rig();
  const before = hostSim.opponents.length;

  host._onJson({ t: 'peer', id: 'p1', name: 'Ada', joined: true });

  assert.equal(hostSim.opponents.length, before, 'nobody gained a robot');
  assert.equal(host.seats.size, 1);
  assert.equal(client.seated, true, 'and the joiner was told which one');
  assert.ok(client.slot >= 0);
  assert.ok(['red', 'blue'].includes(client.alliance));
  assert.ok(client.label, `expected a robot name, got ${JSON.stringify(client.label)}`);

  // The rules care: a robot under a human is DRIVER controlled.
  const entry = hostSim.game.match.entries[client.slot];
  assert.equal(entry.driverControlled, true);
});

test('three joiners fill the field and a fourth is turned away', () => {
  const { host, client } = rig();
  for (const id of ['p1', 'p2', 'p3']) {
    host._onJson({ t: 'peer', id, name: id, joined: true });
  }
  assert.equal(host.seats.size, 3, 'three other robots, three seats');

  host._onJson({ t: 'peer', id: 'p4', name: 'late', joined: true });
  assert.equal(host.seats.size, 3, 'no fourth seat');
  // The refusal is relayed to everyone in the loopback, which is enough to
  // show the host said something rather than silently ignoring them.
  assert.match(client.refused || '', /taken/);
});

test('a joiner leaving hands its robot back to the AI', () => {
  const { host, hostSim } = rig();
  host._onJson({ t: 'peer', id: 'p1', name: 'Ada', joined: true });
  const slot = host.seats.get('p1').slot;
  assert.equal(hostSim.game.match.entries[slot].driverControlled, true);

  host._onJson({ t: 'peer', id: 'p1', joined: false });
  assert.equal(host.seats.size, 0);
  assert.equal(
    hostSim.game.match.entries[slot].driverControlled,
    false,
    'an empty seat is not a driver',
  );
  assert.match(host.log.join(' '), /the AI has .* back/);
});

test('a joiner’s sticks move the robot the host is simulating', () => {
  const { links, host, hostSim, client } = rig();
  asPeer(links.client);
  host._onJson({ t: 'peer', id: 'p1', name: 'Ada', joined: true });

  const seat = host.seats.get('p1');
  const start = seat.opponent.robot.body.position.x;
  const startY = seat.opponent.robot.body.position.y;

  const pad = new FtcGamepad();
  pad.left_stick_y = -1; // full forward, FTC sign convention
  pad.connected = true;

  for (let frame = 0; frame < 90; frame++) {
    client.sendInput(pad);
    hostSim.step(1 / 60);
  }

  const moved = Math.hypot(
    seat.opponent.robot.body.position.x - start,
    seat.opponent.robot.body.position.y - startY,
  );
  assert.ok(moved > 0.3, `expected the remote robot to drive, moved ${moved.toFixed(3)} m`);
  assert.ok(seat.packets > 50, `expected input to keep arriving, got ${seat.packets}`);
});

test('input drying up hands the robot back without unseating anybody', () => {
  const { links, host, hostSim, client } = rig();
  asPeer(links.client);
  host._onJson({ t: 'peer', id: 'p1', name: 'Ada', joined: true });
  const seat = host.seats.get('p1');

  const pad = new FtcGamepad();
  pad.left_stick_y = -1;
  for (let frame = 0; frame < 30; frame++) {
    client.sendInput(pad);
    hostSim.step(1 / 60);
  }
  assert.ok(host.seatFor(seat.opponent), 'driving while packets arrive');

  // Now the laptop lid closes.
  for (let frame = 0; frame < Math.ceil(INPUT_TIMEOUT * 60) + 20; frame++) {
    hostSim.step(1 / 60);
  }
  assert.equal(host.seatFor(seat.opponent), null, 'the AI has it back');
  assert.equal(host.seats.size, 1, 'but the seat is still theirs to come back to');
  assert.match(host.log.join(' '), /stopped sending/);
});

test('the joiner’s field ends up where the host’s is', () => {
  const { host, hostSim, client, clientSim, clientGame, hostGame } = rig();
  host._onJson({ t: 'peer', id: 'p1', name: 'Ada', joined: true });

  // Let the host's match run so the two fields are genuinely different, then
  // let the snapshots catch the joiner up.
  for (let frame = 0; frame < 240; frame++) hostSim.step(1 / 60);
  assert.ok(client.snapshots > 0, 'snapshots arrived');

  // Draw a few frames so the blend lands on the newest snapshot.
  for (let frame = 0; frame < 10; frame++) clientSim.step(1 / 60);
  assert.equal(client.mismatch, '', client.mismatch);
  assert.ok(client.applied > 0);

  const hostBalls = hostGame.field.ballWorld.balls;
  const clientBalls = clientGame.field.ballWorld.balls;
  assert.equal(clientBalls.length, hostBalls.length);

  // Every element within a blend interval's worth of travel of the truth.
  let worst = 0;
  for (let i = 0; i < hostBalls.length; i++) {
    worst = Math.max(
      worst,
      Math.hypot(
        hostBalls[i].x - clientBalls[i].x,
        hostBalls[i].y - clientBalls[i].y,
        hostBalls[i].z - clientBalls[i].z,
      ),
    );
  }
  assert.ok(worst < 0.25, `worst element disagreement ${worst.toFixed(3)} m`);

  // And the robots.
  const hostEntries = hostGame.match.entries;
  const clientEntries = clientGame.match.entries;
  for (let i = 0; i < hostEntries.length; i++) {
    const a = hostEntries[i].robot.body.position;
    const b = clientEntries[i].robot.body.position;
    assert.ok(
      Math.hypot(a.x - b.x, a.y - b.y) < 0.3,
      `robot ${i} is ${Math.hypot(a.x - b.x, a.y - b.y).toFixed(3)} m out`,
    );
  }

  // The HIVES too, since a tip is 20 points and the joiner has to see it.
  assert.ok(
    Math.abs(hostGame.field.hives.red.angle - clientGame.field.hives.red.angle) < 0.05,
    'the red HIVE should be at the same angle',
  );
});

test('the joiner is handed the host’s own score, not its own idea of one', () => {
  const { host, hostSim, client } = rig();
  host._onJson({ t: 'peer', id: 'p1', joined: true });
  for (let frame = 0; frame < 120; frame++) hostSim.step(1 / 60);

  assert.ok(client.matchState, 'a match update arrived');
  const hostScore = hostSim.game.match.score();
  assert.equal(client.matchState.score.red.total, hostScore.red.total);
  assert.equal(client.matchState.score.blue.total, hostScore.blue.total);
  assert.equal(client.matchState.status.phase, hostSim.game.match.phase);
});

test('a client never integrates its own physics', () => {
  const { clientSim, clientGame } = rig();
  // No snapshots at all: whatever the field was built as, it stays as, rather
  // than quietly running a second, divergent match behind the mirror.
  const ball = clientGame.field.ballWorld.balls[0];
  ball.setPosition(0, 0, 0.5);
  for (let frame = 0; frame < 120; frame++) clientSim.step(1 / 60);
  assert.equal(ball.z, 0.5, 'gravity did not run');
  assert.equal(clientSim.substepsLastFrame, 0, 'and no substeps were taken');
});

test('a snapshot from a field of a different size is refused, not applied', () => {
  const { host, hostSim, client, clientGame } = rig();
  host._onJson({ t: 'peer', id: 'p1', joined: true });
  for (let frame = 0; frame < 30; frame++) hostSim.step(1 / 60);

  // Pretend this build has one element fewer than the host's.
  const balls = clientGame.field.ballWorld.balls;
  const removed = balls.pop();
  client.update(1 / 60);
  assert.match(client.mismatch, /elements/, 'it should say what does not line up');

  balls.push(removed);
  client.update(1 / 60);
  assert.equal(client.mismatch, '', 'and recover once it does line up');
});

test('a blend never moves an element that changed container', () => {
  const { hostSim, hostGame } = rig();
  for (let frame = 0; frame < 60; frame++) hostSim.step(1 / 60);

  const a = buildSnapshot(hostGame, 1);
  const b = JSON.parse(JSON.stringify(a));
  b.tick = 2;
  // One element gets picked up and moves to where an intake would hold it.
  b.balls[0].container = 'intake';
  b.balls[0].x = a.balls[0].x + 1.5;
  // Another just rolls.
  b.balls[1].x = a.balls[1].x + 0.1;

  const mid = blendSnapshots(a, b, 0.5);
  assert.equal(
    mid.balls[0].x,
    b.balls[0].x,
    'a collected element jumps to the robot rather than sliding across the field',
  );
  assert.ok(
    Math.abs(mid.balls[1].x - (a.balls[1].x + 0.05)) < 1e-6,
    'a rolling element interpolates',
  );
});

test('a blend takes the short way round on heading and orientation', () => {
  const base = {
    tick: 1,
    clock: 0,
    phase: 3,
    robots: [
      {
        slot: 0,
        x: 0,
        y: 0,
        heading: 3.0,
        rpm: 0,
        hood: 0,
        held: 0,
        alliance: 'red',
        driverControlled: true,
      },
    ],
    balls: [],
    hives: [],
    flowers: [],
  };
  const next = JSON.parse(JSON.stringify(base));
  next.tick = 2;
  next.robots[0].heading = -3.0; // across the +/-pi seam

  const mid = blendSnapshots(base, next, 0.5);
  // The short way is through pi (about 3.14), not back through zero.
  assert.ok(
    Math.abs(mid.robots[0].heading) > 3.0,
    `expected it to pass through pi, got ${mid.robots[0].heading.toFixed(3)}`,
  );

  // And a quaternion against its own negation, which is the same rotation --
  // blending those without a sign flip takes the ball the long way and looks
  // like a violent wobble.
  const spin = {
    ...base,
    balls: [
      {
        x: 0,
        y: 0,
        z: 0,
        ox: 0.6,
        oy: 0,
        oz: 0,
        ow: 0.8,
        kind: 'pollen',
        alliance: null,
        container: 'none',
        outOfBounds: false,
      },
    ],
  };
  const flipped = JSON.parse(JSON.stringify(spin));
  flipped.tick = 2;
  Object.assign(flipped.balls[0], { ox: -0.6, oy: 0, oz: 0, ow: -0.8 });

  const between = blendSnapshots(spin, flipped, 0.5);
  const b = between.balls[0];
  assert.ok(Math.abs(Math.hypot(b.ox, b.oy, b.oz, b.ow) - 1) < 1e-6, 'still a unit quaternion');
  // Half way between q and itself is q, so nothing should have moved.
  assert.ok(Math.abs(Math.abs(b.ow) - 0.8) < 1e-6, `ow drifted to ${b.ow}`);
});

test('a late snapshot is dropped rather than rewinding the field', () => {
  const { host, hostSim, client } = rig();
  host._onJson({ t: 'peer', id: 'p1', joined: true });
  for (let frame = 0; frame < 60; frame++) hostSim.step(1 / 60);
  const seen = client.snapshots;
  const tick = client._newer.tick;

  // Replay an old one, as a packet that took the scenic route would.
  const stale = buildSnapshot(hostSim.game, tick - 5);
  const before = client._newer;
  client._onBinary(encodeSnapshot(stale));
  assert.equal(client._newer, before, 'the newer snapshot is still the newer one');
  assert.equal(client.snapshots, seen + 1, 'it was counted, then discarded');
});

test('the host tells joiners when it disappears and when it restarts', () => {
  const { host, client } = rig();
  host._onJson({ t: 'peer', id: 'p1', joined: true });

  host.announceReset();
  assert.equal(client._newer, null, 'the joiner drops its stale snapshots');
  assert.match(client.log.join(' '), /restarted/);

  client._onJson({ t: 'hostGone' });
  assert.equal(client.hostGone, true);
  assert.match(client.status().role, /client/);
});
