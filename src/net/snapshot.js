/**
 * Turning a live BIOBUZZ game into a snapshot, and a snapshot back into a
 * drawable field.
 *
 * ## The joiner runs a real field, not a puppet theatre
 *
 * A joining browser builds the whole game exactly as the host does -- the same
 * `BiobuzzField`, the same HIVE meshes, the same FLOWER geometry, the same
 * forty-four balls -- and then stops stepping the physics and overwrites the
 * positions from each snapshot instead. Nothing in the renderer, the HUD or the
 * match panel has to know whether it is looking at a simulation or a mirror.
 *
 * The alternative was a lightweight "what to draw" structure, which sounds
 * cheaper and is not: it means a second description of every object on the
 * FIELD, and every time the real one changes the mirror silently stops matching
 * it. Rebuilding the same field costs a few milliseconds once.
 *
 * ## Balls are matched by index
 *
 * There is no id in the ball section of a snapshot, which saves about 350 bytes
 * a packet. It works because both sides construct their elements in the same
 * order from the same constants and never reorder the array -- `BallWorld.balls`
 * is built once and mutated in place. `applySnapshot` checks the count and
 * refuses a mismatch rather than writing NECTAR positions onto POLLEN, because
 * that failure looks like broken physics rather than a broken assumption.
 *
 * @module
 */
import { PHASES, CONTAINERS } from './protocol.js';

/** Alliance as a byte, with 0 meaning nobody. */
const ALLIANCE_CODE = { none: 0, red: 1, blue: 2 };
const ALLIANCE_NAME = [null, 'red', 'blue'];

/**
 * Read the authoritative game into a plain snapshot.
 *
 * @param {any} game a `BiobuzzGame`
 * @param {number} tick
 * @returns {import('./protocol.js').Snapshot}
 */
export function buildSnapshot(game, tick) {
  const field = game.field;
  const match = game.match;
  const balls = field.ballWorld.balls;

  /** @type {any[]} */
  const robots = [];
  for (const entry of match.entries) {
    const body = entry.robot?.body;
    if (!body) continue;
    const launcher = launcherOf(entry);
    const intake = intakeOf(entry);
    robots.push({
      x: body.position.x,
      y: body.position.y,
      heading: body.rotation.radians,
      rpm: launcher?.rpm ?? 0,
      hood: launcher?.angle ?? 0,
      held: intake?.held?.length ?? 0,
      alliance: entry.alliance,
      driverControlled: Boolean(entry.driverControlled),
    });
  }

  /** @type {any[]} */
  const snapBalls = [];
  for (const ball of balls) {
    snapBalls.push({
      x: ball.x,
      y: ball.y,
      z: ball.z,
      ox: ball.ox,
      oy: ball.oy,
      oz: ball.oz,
      ow: ball.ow,
      kind: ball.kind,
      alliance: ball.alliance === 'red' || ball.alliance === 'blue' ? ball.alliance : null,
      container: ball.container?.kind ?? 'none',
      outOfBounds: Boolean(ball.outOfBounds),
    });
  }

  const hives = [field.hives.red, field.hives.blue].map((hive) => ({
    angle: hive.angle,
    up: hive.up === 'aft' ? 1 : 0,
  }));

  const flowers = field.flowers.map((flower) => ({
    count: flower.scoringElements().length,
    owner: ALLIANCE_CODE[flower.owner() ?? 'none'],
    bottom: ALLIANCE_CODE[flower.bottomNectarAlliance() ?? 'none'],
  }));

  return {
    tick,
    clock: match.matchClock ?? 0,
    phase: Math.max(0, PHASES.indexOf(match.phase)),
    robots,
    balls: snapBalls,
    hives,
    flowers,
  };
}

/**
 * Write a snapshot onto a mirrored game so it can be drawn.
 *
 * @param {any} game the joiner's own `BiobuzzGame`
 * @param {import('./protocol.js').Snapshot} snap
 * @returns {{applied: boolean, reason?: string}}
 */
export function applySnapshot(game, snap) {
  const field = game.field;
  const balls = field.ballWorld.balls;

  if (snap.balls.length !== balls.length) {
    // Both sides build their elements from the same constants, so a mismatch
    // means the two builds differ -- and writing one array onto the other
    // would show up as elements teleporting rather than as a version problem.
    return {
      applied: false,
      reason: `the host has ${snap.balls.length} elements and this build has ${balls.length}`,
    };
  }

  for (let i = 0; i < balls.length; i++) {
    const ball = balls[i];
    const from = snap.balls[i];
    ball.setPosition(from.x, from.y, from.z);
    ball.ox = from.ox;
    ball.oy = from.oy;
    ball.oz = from.oz;
    ball.ow = from.ow;
    ball.outOfBounds = from.outOfBounds;
    // The renderer asks "is this ball in a CELL" to decide whether to draw it,
    // and the scoring panel is driven by the host's own JSON, so the container
    // only has to carry its *kind*. Handing it a null ref keeps the shape the
    // renderer expects without inventing a reference to an object the mirror
    // has no business holding.
    ball.container = from.container === 'none' ? null : { kind: from.container, ref: null };
    // A mirrored ball must never be integrated: zeroing the velocity means a
    // dropped snapshot leaves it still rather than drifting off the FIELD.
    ball.stop?.();
  }

  const hives = [field.hives.red, field.hives.blue];
  for (let i = 0; i < hives.length && i < snap.hives.length; i++) {
    hives[i].angle = snap.hives[i].angle;
    hives[i].up = snap.hives[i].up === 1 ? 'aft' : 'fore';
    hives[i].angularVelocity = 0;
  }

  const entries = game.match?.entries ?? [];
  for (let i = 0; i < entries.length && i < snap.robots.length; i++) {
    const entry = entries[i];
    const from = snap.robots[i];
    const body = entry.robot?.body;
    if (!body) continue;
    body.position.x = from.x;
    body.position.y = from.y;
    body.rotation.setRadians(from.heading);
    body.velocity.x = 0;
    body.velocity.y = 0;
    body.angularVelocity = 0;
    entry.driverControlled = from.driverControlled;
    entry.mirrored = {
      rpm: from.rpm,
      hood: from.hood,
      held: from.held,
    };
  }

  field.mirroredFlowers = snap.flowers.map((f) => ({
    count: f.count,
    owner: ALLIANCE_NAME[f.owner] ?? null,
    bottom: ALLIANCE_NAME[f.bottom] ?? null,
  }));

  return { applied: true };
}

/**
 * Blend two snapshots, for drawing between them.
 *
 * A joiner receives 20 snapshots a second and draws 60 frames, so two frames in
 * three are between two known states. Without this the whole FIELD moves in
 * 50 ms steps, which looks worse than the latency it is hiding.
 *
 * Interpolating rather than extrapolating is deliberate: it means the drawn
 * state is always one that really happened, at the cost of being a snapshot
 * interval behind. Extrapolation would hide that delay and put elements
 * through walls whenever a packet was late, which is the wrong trade for
 * something people are using to learn where things are.
 *
 * @param {import('./protocol.js').Snapshot} a
 * @param {import('./protocol.js').Snapshot} b
 * @param {number} t 0 at `a`, 1 at `b`
 */
export function blendSnapshots(a, b, t) {
  const u = t < 0 ? 0 : t > 1 ? 1 : t;
  if (u <= 0) return a;
  if (u >= 1) return b;
  if (a.balls.length !== b.balls.length || a.robots.length !== b.robots.length) return b;

  return {
    tick: b.tick,
    clock: lerp(a.clock, b.clock, u),
    // Phase is a state, not a quantity: half way between AUTO and TELEOP is
    // not a thing, and the newer one is the true one.
    phase: b.phase,
    robots: b.robots.map((to, i) => {
      const from = a.robots[i];
      return {
        ...to,
        x: lerp(from.x, to.x, u),
        y: lerp(from.y, to.y, u),
        heading: lerpAngle(from.heading, to.heading, u),
        rpm: lerp(from.rpm, to.rpm, u),
        hood: lerp(from.hood, to.hood, u),
      };
    }),
    balls: b.balls.map((to, i) => {
      const from = a.balls[i];
      // A ball that changed container has been picked up, scored or spilled,
      // and its two positions are not two points on one path -- so it jumps
      // rather than sliding through the HIVE wall on the way.
      if (from.container !== to.container) return to;
      return {
        ...to,
        x: lerp(from.x, to.x, u),
        y: lerp(from.y, to.y, u),
        z: lerp(from.z, to.z, u),
        ...blendQuat(from, to, u),
      };
    }),
    hives: b.hives.map((to, i) => ({
      ...to,
      angle: a.hives[i] ? lerp(a.hives[i].angle, to.angle, u) : to.angle,
    })),
    flowers: b.flowers,
  };
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

/** Shortest way round, so a robot crossing +/-pi does not spin the long way. */
function lerpAngle(a, b, t) {
  let delta = b - a;
  while (delta > Math.PI) delta -= 2 * Math.PI;
  while (delta < -Math.PI) delta += 2 * Math.PI;
  return a + delta * t;
}

/**
 * Normalised linear blend between two orientations.
 *
 * `nlerp`, not `slerp`: at 50 ms apart the two rotations are close enough that
 * the angular-velocity error is invisible, and it is a handful of multiplies
 * instead of two trig calls per ball per frame. The sign flip matters though --
 * `q` and `-q` are the same rotation, and blending between them without it
 * takes the ball the long way round and looks like a violent wobble.
 */
function blendQuat(from, to, t) {
  let { ox, oy, oz, ow } = to;
  const dot = from.ox * ox + from.oy * oy + from.oz * oz + from.ow * ow;
  if (dot < 0) {
    ox = -ox;
    oy = -oy;
    oz = -oz;
    ow = -ow;
  }
  const x = lerp(from.ox, ox, t);
  const y = lerp(from.oy, oy, t);
  const z = lerp(from.oz, oz, t);
  const w = lerp(from.ow, ow, t);
  const length = Math.hypot(x, y, z, w) || 1;
  return { ox: x / length, oy: y / length, oz: z / length, ow: w / length };
}

/** @param {{intake?: any, opponent?: any, robot?: any}} entry */
function intakeOf(entry) {
  if (entry.intake) return entry.intake;
  if (entry.opponent?.intake) return entry.opponent.intake;
  return entry.robot?.subsystems?.find((s) => Array.isArray(s.held)) ?? null;
}

function launcherOf(entry) {
  if (entry.launcher) return entry.launcher;
  if (entry.opponent?.launcher) return entry.opponent.launcher;
  return entry.robot?.subsystems?.find((s) => typeof s.rpm === 'number') ?? null;
}

export { CONTAINERS };
