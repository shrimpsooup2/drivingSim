import test from 'node:test';
import assert from 'node:assert/strict';
import { Config } from '../src/config/Config.js';
import { Field } from '../src/field/Field.js';
import { Ball } from '../src/physics/Ball.js';
import { BallWorld } from '../src/physics/BallWorld.js';
import { Hive } from '../src/field/biobuzz/Hive.js';
import { Flower } from '../src/field/biobuzz/Flower.js';
import { BiobuzzField } from '../src/field/biobuzz/BiobuzzField.js';
import { buildZones, gardenStagingPositions } from '../src/field/biobuzz/zones.js';
import {
  BLUE_START_UP,
  CELL_OPENING_BOTTOM,
  CELL_DEPTH,
  CELL_OPENING_HEIGHT,
  CELL_OPENING_WIDTH,
  CELL_OPENING_TOP,
  CELL_REST_HEIGHT,
  CELL_START_NECTAR,
  FIELD_INNER_HALF,
  FLOWER_ALONG_WALL,
  FLOWER_AXIS_OFFSET,
  FLOWER_RETRIEVAL_GAP,
  FLOWER_RING_DEPTH,
  FLOWER_RING_WIDTH,
  FLOWER_SCORING_BOTTOM,
  FLOWER_SCORING_TOP,
  FLOWER_STAGED_HEIGHTS,
  GARDEN_START_POLLEN,
  HALF_FIELD,
  HIVE_PIVOT_HEIGHT,
  HIVE_PIVOT_X,
  HIVE_TILT,
  NECTAR_MASS,
  NECTAR_PER_ALLIANCE,
  NECTAR_RADIUS,
  POLLEN_COUNT,
  POLLEN_MASS,
  POLLEN_RADIUS,
  POINTS,
  RED_START_UP,
  TILE_RESTITUTION,
  SETTLE_SPEED,
} from '../src/field/biobuzz/constants.js';
import { INCH } from '../src/math/MathUtil.js';

let nextId = 0;
const pollen = () =>
  new Ball({
    id: `p${nextId++}`,
    kind: 'pollen',
    radius: POLLEN_RADIUS,
    mass: POLLEN_MASS,
  });
const nectar = (alliance) =>
  new Ball({
    id: `n${nextId++}`,
    kind: 'nectar',
    alliance,
    radius: NECTAR_RADIUS,
    mass: NECTAR_MASS,
  });
const newFlower = () =>
  new Flower({ id: 'F', x: 0, y: -HALF_FIELD, facing: Math.PI / 2 });

// ------------------------------------------------------------------ balls

test('a dropped ball bounces, loses energy and comes to rest on the floor', () => {
  const world = new BallWorld({ fieldSize: 144 * INCH, wallHeight: 12 * INCH });
  const ball = pollen();
  ball.setPosition(0, 0, 1.0);
  world.add(ball);

  let bounces = 0;
  let wasFalling = true;
  for (let i = 0; i < 2000; i++) {
    world.step(1 / 240);
    if (wasFalling && ball.vz > 0) bounces++;
    wasFalling = ball.vz < 0;
  }

  assert.ok(bounces >= 2, `expected several bounces, saw ${bounces}`);
  assert.ok(Math.abs(ball.z - ball.radius) < 1e-3, `rests at radius, got ${ball.z}`);
  assert.ok(world.settled);
});

test('balls stay inside the field', () => {
  const world = new BallWorld({ fieldSize: 144 * INCH, wallHeight: 12 * INCH });
  for (let i = 0; i < 12; i++) {
    const ball = pollen();
    ball.setPosition((i - 6) * 0.05, 0, 0.3);
    ball.setVelocity(6 * Math.cos(i), 6 * Math.sin(i), 0);
    world.add(ball);
  }
  for (let i = 0; i < 2400; i++) world.step(1 / 240);
  for (const ball of world.balls) {
    assert.ok(Math.abs(ball.x) <= HALF_FIELD, `x in bounds, got ${ball.x}`);
    assert.ok(Math.abs(ball.y) <= HALF_FIELD, `y in bounds, got ${ball.y}`);
    assert.ok(ball.isFinite());
  }
});

// ------------------------------------------------------------------- hive

/**
 * A HIVE with somewhere for its contents to fall.
 *
 * A HIVE on its own used to be enough to test a load in, because a CELL
 * *positioned* what it held: staging put an element on a lattice and it stayed
 * there until the arm turned over. Nothing is positioned now -- an element in a
 * CELL is an ordinary free element that happens to be inside one -- so without
 * a world there is no gravity to settle it, no walls to catch it and no
 * neighbours to lean on, and the load simply hangs in space while the CELL
 * rotates out from under it.
 *
 * `stage` goes through `world.add` so the broadphase sizes its grid to the
 * elements, which is what lets two of them in a CELL actually touch.
 */
function hiveRig(opts) {
  const hive = new Hive(opts);
  const world = new BallWorld({
    fieldSize: 3.6,
    wallHeight: 0.29,
    restitution: TILE_RESTITUTION,
    settleSpeed: SETTLE_SPEED,
  });
  hive.balls = world.balls;
  world.addCollider((ball) => hive.collideBall(ball));
  hive.world = world;
  const stage = hive.stage.bind(hive);
  hive.stage = (ball) => {
    world.add(ball);
    return stage(ball);
  };
  return hive;
}

/** Advance a rigged HIVE and the world its contents live in. */
function stepHive(hive, dt, inAuto = false) {
  hive.update(dt, inAuto);
  hive.world?.step(dt);
}

test('the HIVE holds the three NECTAR staged in it at setup', () => {
  // Section 10.3.1 stages three NECTAR in the upward CELL of every HIVE. If the
  // tip threshold were at or below that mass every MATCH would begin with both
  // HIVES tipping, so this pins the calibration down.
  const hive = hiveRig({ alliance: 'red', pivotX: 0 });
  for (let i = 0; i < CELL_START_NECTAR; i++) hive.stage(nectar('red'));
  for (let i = 0; i < 2000; i++) stepHive(hive, 1 / 500);
  assert.equal(hive.tips, 0);
  assert.equal(hive.elementsInUpCell(), CELL_START_NECTAR);
});

/**
 * Run a hive until it has finished tipping *and* finished emptying.
 *
 * Those are two different moments, which they did not used to be. The arm
 * arriving at its far stop was once the same instant the load appeared on the
 * tiles, because a CELL that turned over teleported its contents out. Now the
 * load rolls along the CELL floor and leaves through the mouth, which takes
 * about half a second after the arm has stopped moving -- so waiting only for
 * the arm reports a HIVE that has tipped and not yet poured.
 */
function settle(hive, inAuto = false, limit = 8) {
  let t = 0;
  const dt = 1 / 500;
  while (t < limit) {
    stepHive(hive, dt, inAuto);
    t += dt;
    const atStop = Math.abs(Math.abs(hive.angle) - hive.tilt) < 1e-4;
    const stopped = atStop && Math.abs(hive.angularVelocity) < 1e-3;
    const emptied = hive.downBalls.length === 0;
    if (hive.tips > 0 && stopped && emptied) {
      // One more step before stopping. An element leaves a CELL during the
      // *world* step, and the HIVE only notices on its next one -- so the step
      // that empties a CELL is not the step that reports it, and breaking the
      // instant the CELL reads empty loses the last departures off the spill
      // list.
      stepHive(hive, dt, inAuto);
      break;
    }
  }
  return t;
}

test('the HIVE goes over once the load beats the latch, and arrives empty', () => {
  const hive = hiveRig({ alliance: 'red', pivotX: 0, startUp: 'fore' });
  for (let i = 0; i < CELL_START_NECTAR; i++) hive.stage(nectar('red'));
  hive.stage(pollen());

  const took = settle(hive);

  assert.equal(hive.tips, 1);
  assert.equal(hive.up, 'aft', 'the opposite CELL is now up');
  assert.equal(hive.elementsInUpCell(), 0, 'it arrives empty, ready to fill again');
  assert.equal(hive.takeSpilled().length, 4, 'and the old contents roll out of it');
  assert.ok(took > 0.3 && took < 5, `the rotation takes real time: ${took.toFixed(2)} s`);
});

test('the latch holds exactly the staged load and goes over on one more', () => {
  // Section 10.3.1 stages three NECTAR, which must hold. One more element has
  // to take it over, or the game would be unplayable.
  const hold = hiveRig({ alliance: 'red', pivotX: 0, startUp: 'fore' });
  for (let i = 0; i < CELL_START_NECTAR; i++) hold.stage(nectar('red'));
  for (let i = 0; i < 3000; i++) stepHive(hold, 1 / 500);
  assert.equal(hold.tips, 0);
  assert.ok(hold.netTorque < 0, 'net torque still pins it to the fore stop');

  const over = hiveRig({ alliance: 'red', pivotX: 0, startUp: 'fore' });
  for (let i = 0; i < CELL_START_NECTAR; i++) over.stage(nectar('red'));
  over.stage(pollen());
  assert.ok(over.netTorque > 0, 'one more element reverses the torque');
  settle(over);
  assert.equal(over.tips, 1);
});

test('an empty CELL needs a full load again, about seven POLLEN', () => {
  const hive = hiveRig({ alliance: 'red', pivotX: 0, startUp: 'fore' });
  let held = 0;
  for (let i = 0; i < 12; i++) {
    hive.stage(pollen());
    settle(hive);
    if (hive.tips > 0) break;
    held++;
  }
  assert.ok(held >= 5 && held <= 8, `expected around seven POLLEN, held ${held}`);
});

test('a heavier load goes over faster, because it is a torque balance', () => {
  const marginal = hiveRig({ alliance: 'red', pivotX: 0, startUp: 'fore' });
  for (let i = 0; i < 4; i++) marginal.stage(nectar('red'));
  const slow = settle(marginal);

  const loaded = hiveRig({ alliance: 'red', pivotX: 0, startUp: 'fore' });
  for (let i = 0; i < 8; i++) loaded.stage(nectar('red'));
  const quick = settle(loaded);

  assert.equal(marginal.tips, 1);
  assert.equal(loaded.tips, 1);
  assert.ok(quick < slow * 0.8, `${quick.toFixed(2)} s loaded vs ${slow.toFixed(2)} s marginal`);
});

test('the down CELL cannot hold anything, which is why a tip empties it', () => {
  const hive = new Hive({ alliance: 'red', pivotX: 0, startUp: 'fore' });
  // The opening faces straight out along the arm, so its upward component is
  // exactly the sine of the arm angle: +0.5 raised, -0.5 lowered. That is not a
  // tuned number -- it follows from the figure's two opening heights.
  const expected = Math.sin(hive.tilt);
  assert.ok(Math.abs(hive.openingUpwardness('fore') - expected) < 1e-9);
  assert.ok(Math.abs(hive.openingUpwardness('aft') + expected) < 1e-9);
  assert.ok(hive.openingUpwardness('aft') < 0, 'the lowered CELL faces downward');

  // And it refuses a ball outright.
  const ball = pollen();
  const down = hive.cellOpening('aft');
  ball.setPosition(0, down.y, down.z);
  ball.setVelocity(0, 0, -0.5);
  assert.ok(!hive.interactBall(ball));
});

test('both CELLS on both HIVES stand on their base, apex up', () => {
  // The pentagon has a 20 in base and an apex 14 in above it. Which way that
  // apex points is the difference between a basket and a funnel, and it is not
  // visible in a span check -- flipping "up" covers the same 53.5-to-65.6 in
  // interval, just from the other end. So check the direction itself.
  for (const startUp of ['fore', 'aft']) {
    const hive = new Hive({ alliance: 'red', pivotX: 0, startUp });
    for (const side of ['fore', 'aft']) {
      const up = hive.openingUp(side);
      const centre = hive.cellOpening(side);
      const apex = {
        y: centre.y + up.y * (CELL_OPENING_HEIGHT / 2),
        z: centre.z + up.z * (CELL_OPENING_HEIGHT / 2),
      };
      const base = {
        y: centre.y - up.y * (CELL_OPENING_HEIGHT / 2),
        z: centre.z - up.z * (CELL_OPENING_HEIGHT / 2),
      };
      assert.ok(
        apex.z > base.z,
        `${startUp}-up hive, ${side} CELL: apex at ${apex.z.toFixed(3)} m is below the base at ${base.z.toFixed(3)} m`,
      );
      // It is also a unit vector perpendicular to the opening normal, which is
      // what makes the (normal, up) pair a usable frame for the renderer.
      const n = hive.openingNormal(side);
      assert.ok(Math.abs(Math.hypot(up.y, up.z) - 1) < 1e-12);
      assert.ok(Math.abs(up.y * n.y + up.z * n.z) < 1e-12);
    }
  }
});

test('the pentagon taper is above the shoulder, not below it', () => {
  // The taper only bites near the apex. Measuring height from the wrong edge
  // put the narrow part at the bottom, which let a shot into the top corners
  // through and rejected one along the base -- exactly backwards.
  for (const side of ['fore', 'aft']) {
    const hive = new Hive({ alliance: 'red', pivotX: 0, startUp: side });
    // Derived here from the arm angle rather than read off the HIVE, so that a
    // flipped `openingUp` moves the measurement without also moving the ball
    // and cancelling itself out.
    const up = { y: -Math.sin(hive.angle), z: Math.cos(hive.angle) };
    const n = hive.openingNormal(side);
    const centre = hive.cellOpening(side);
    // A ball entering 1 in below the apex, offset most of the way to the old
    // 20 in edge: outside the pentagon there, inside it near the base.
    const nearApex = CELL_OPENING_HEIGHT / 2 - 1 * 0.0254;
    const nearBase = -CELL_OPENING_HEIGHT / 2 + 1 * 0.0254;
    const offset = 8 * 0.0254;
    // Asked of the geometry directly. `interactBall` now only adopts an
    // element that has already come to rest inside the CELL -- a moving one is
    // the walls' business -- so putting a ball in the mouth at 1.5 m/s and
    // expecting it to be taken is no longer the question being asked here.
    const inside = (v) => {
      const ball = pollen();
      ball.setPosition(
        centre.x + offset,
        centre.y + up.y * v + n.y * 0.01,
        centre.z + up.z * v + n.z * 0.01,
      );
      return hive.openingContains(side, ball.x, ball.y, ball.z, {
        margin: 0,
        outward: ball.radius,
      });
    };
    assert.ok(inside(nearBase), `${side}: a point along the base is inside`);
    assert.ok(!inside(nearApex), `${side}: a point 8 in off centre at the apex is not`);
  }
});

test('the CELL opening is where Figure 9-9 puts it, not where the contents rest', () => {
  const hive = new Hive({ alliance: 'red', pivotX: 0, startUp: 'fore' });
  const opening = hive.cellOpening('fore');
  const rest = hive.cellRest('fore');
  const half = (CELL_OPENING_HEIGHT / 2) * Math.cos(hive.tilt);

  // Figure 9-9: bottom of the opening 53.5 in, top 65.6 in.
  assert.ok(Math.abs(opening.z - half - CELL_OPENING_BOTTOM) < 1e-3);
  assert.ok(Math.abs(opening.z + half - CELL_OPENING_TOP) < 1e-3);

  // The CAD stages its NECTAR on the floor, well below the opening.
  assert.ok(Math.abs(rest.z - CELL_REST_HEIGHT) < 1e-9);
  assert.ok(
    opening.z - rest.z > 8 * INCH,
    'the aperture is over eight inches above where the contents sit',
  );
  assert.ok(Math.abs(rest.y) < Math.abs(opening.y), 'and further in along the arm');

  // The opening faces out along the arm, 30 degrees above horizontal.
  const n = hive.openingNormal('fore');
  assert.ok(Math.abs(Math.hypot(n.y, n.z) - 1) < 1e-9);
  assert.ok(Math.abs(n.z - Math.sin(hive.tilt)) < 1e-9);
  assert.ok(n.y < 0, 'outward, on the fore side');
});

test('the opening is a pentagon, so the top corners are tighter than the base', () => {
  const hive = new Hive({ alliance: 'red', pivotX: 0, startUp: 'fore' });
  const opening = hive.cellOpening('fore');
  const n = hive.openingNormal('fore');

  const up = hive.openingUp('fore');

  /** Is a point `v` up the opening's face and `dx` off centre inside it? */
  const at = (v, dx) => {
    const ball = pollen();
    const along = v - CELL_OPENING_HEIGHT / 2;
    ball.setPosition(
      opening.x + dx,
      opening.y + up.y * along,
      opening.z + up.z * along,
    );
    return hive.openingContains('fore', ball.x, ball.y, ball.z, {
      margin: 0,
      outward: ball.radius,
    });
  };

  // Low down the face, the full 20 in width is available.
  assert.ok(at(3 * INCH, 8 * INCH), 'wide at the base');
  // Near the apex the pentagon has closed in.
  assert.ok(!at(13 * INCH, 8 * INCH), 'narrow at the apex');

  // And the CELL's walls are where the outline says: a ball on the line that
  // aims at the top corner is stopped by the rib rather than let through.
  const planes = hive.cellPlanes('fore');
  const local = hive.cellLocal('fore', opening.x + 8 * INCH, opening.y, opening.z, planes);
  const apexLocal = {
    a: 8 * INCH,
    v: 13 * INCH,
  };
  const worst = Math.min(
    ...planes.edges.map((e) => e.a * apexLocal.a + e.v * apexLocal.v - e.offset),
  );
  assert.ok(worst < 0, 'the top-corner point is outside the pentagon');
  assert.ok(Math.abs(local.d) < 1e-9, 'and the opening plane is where it should be');
});

test('a shot has to physically arrive -- the CELL does not snap it out of the air', () => {
  // A CELL that simply accepts anything crossing its mouth pulls the ball out
  // of mid-air onto a shelf, which looks like a magnet and teaches nothing: a
  // shot that should have rattled off the rib scored, and one that should have
  // bounced out stayed in. It has five walls and a back panel instead, and now
  // nothing is taken at all -- a shot that scores is one that flew in, hit
  // something and came to rest in there, and "in the CELL" is a question about
  // where it is rather than about who owns it.
  const hive = hiveRig({ alliance: 'red', pivotX: 0, startUp: 'fore' });
  const opening = hive.cellOpening('fore');
  const normal = hive.openingNormal('fore');
  const ball = pollen();

  // Dead centre of the mouth, heading straight in at shooting speed.
  ball.setPosition(
    opening.x,
    opening.y + normal.y * 0.02,
    opening.z + normal.z * 0.02,
  );
  ball.setVelocity(-normal.y * 4, -normal.z * 4, 0);
  ball.setVelocity(0, -normal.y * 4, -normal.z * 4);

  assert.equal(hive.elementsInUpCell(), 0, 'nothing in the CELL yet');
  assert.equal(hive.interactBall(ball), false, 'and a CELL never takes anything');

  // The walls are what stop it. Step it through them, and it should end up
  // inside, slowed, and still an ordinary free element.
  hive.balls.push(ball);
  const speeds = [];
  for (let i = 0; i < 4000; i++) {
    const dt = 1 / 2000;
    ball.vz -= 9.80665 * dt;
    ball.x += ball.vx * dt;
    ball.y += ball.vy * dt;
    ball.z += ball.vz * dt;
    hive.collideBall(ball);
    if (i % 500 === 0) speeds.push(ball.speed);
  }
  hive.update(1 / 2000, false);

  assert.ok(hive.containsElement('fore', ball), 'it ends up inside the CELL');
  assert.equal(hive.elementsInUpCell(), 1, 'and counts for the score');
  assert.equal(ball.container, null, 'without ever being taken out of the physics');
  assert.ok(
    ball.speed < 0.6,
    `the walls should have taken the speed out of it, left doing ${ball.speed.toFixed(2)} m/s`,
  );
  assert.ok(speeds[0] > speeds[speeds.length - 1], 'and it slowed down rather than being stopped');
});

test('the CELL walls stop a ball rather than letting it through', () => {
  const hive = new Hive({ alliance: 'red', pivotX: 0, startUp: 'fore' });
  const planes = hive.cellPlanes('fore');
  const opening = hive.cellOpening('fore');
  const normal = hive.openingNormal('fore');

  // Fired hard at the back panel from inside the mouth. Without walls it flew
  // straight out the back of the structure.
  const ball = pollen();
  ball.setPosition(opening.x, opening.y, opening.z);
  ball.setVelocity(0, -normal.y * 8, -normal.z * 8);
  for (let i = 0; i < 400; i++) {
    const dt = 1 / 2000;
    ball.x += ball.vx * dt;
    ball.y += ball.vy * dt;
    ball.z += ball.vz * dt;
    hive.collideBall(ball);
  }
  const local = hive.cellLocal('fore', ball.x, ball.y, ball.z, planes);
  assert.ok(
    local.d < planes.depth + ball.radius,
    `it went ${local.d.toFixed(3)} m deep, past the ${planes.depth.toFixed(3)} m back panel`,
  );
});

test('a CELL wall only exists where the structure does', () => {
  // Each side plate is bounded by its own two vertices, and the tube is
  // bounded along its depth. Unbounded, the plane of one CELL's wall reached
  // across the whole FIELD: a shot from the far corner at the red CELL was
  // swatted out of the air by a blue CELL a metre and a half off its line.
  const hive = new Hive({ alliance: 'blue', pivotX: 0.324, startUp: 'aft' });
  const planes = hive.cellPlanes('fore');
  const opening = hive.cellOpening('fore');
  const up = hive.openingUp('fore');

  // A foot above the pentagon's apex, in the plane of a side wall, inside the
  // tube's depth: in line with a wall but a long way past where it ends.
  const above = CELL_OPENING_HEIGHT / 2 + 0.3;
  const ball = pollen();
  ball.setPosition(
    opening.x + CELL_OPENING_WIDTH / 2,
    opening.y + up.y * above + planes.inward.y * 0.15,
    opening.z + up.z * above + planes.inward.z * 0.15,
  );
  ball.setVelocity(0, 0, -4);
  const before = { ...ball };
  hive.collideBall(ball);
  assert.equal(ball.vz, before.vz, 'nothing there, so nothing happened');
  assert.equal(ball.y, before.y);
  assert.equal(ball.z, before.z);
});

test('the arm feels the shot, not just what settles in it', () => {
  // Newton's third law, and the reason a *volley* can take a HIVE over rather
  // than only the weight that piles up afterwards. A POLLEN arriving at 6 m/s
  // carries 0.27 kg m/s, and landed two thirds of a metre out on the lever
  // that is a real angular impulse.
  const hive = new Hive({ alliance: 'red', pivotX: 0, startUp: 'fore' });
  const opening = hive.cellOpening('fore');
  const normal = hive.openingNormal('fore');
  hive.angularVelocity = 0;

  // Arriving *descending*, which is the only way a CELL accepts anything: the
  // manual's own geometry forces the shot to drop in. The direction matters to
  // the answer -- a shot fired flat along the arm pushes at the pivot and
  // produces almost no torque at all, which is correct and not what a real
  // shot does.
  const ball = pollen();
  ball.setPosition(opening.x, opening.y, opening.z + 0.02);
  ball.setVelocity(0, -normal.y * 1.5, -5);
  for (let i = 0; i < 600; i++) {
    const dt = 1 / 2000;
    ball.x += ball.vx * dt;
    ball.y += ball.vy * dt;
    ball.z += ball.vz * dt;
    hive.collideBall(ball);
  }
  assert.ok(
    Math.abs(hive.angularVelocity) > 1e-4,
    `the arm should have been nudged, got ${hive.angularVelocity.toExponential(2)} rad/s`,
  );
  // The fore CELL is raised, so weight landing in it drives that end down --
  // which for this sign convention means the angle rising toward a tip.
  assert.ok(
    hive.angularVelocity > 0,
    `and nudged toward tipping, got ${hive.angularVelocity.toExponential(2)} rad/s`,
  );
});

test('a shot fired flat along the arm barely torques it', () => {
  // The other half of the same physics, and worth pinning because it is
  // counter-intuitive: a force pointed at the pivot has no lever on it. A shot
  // arriving along the arm's axis pushes the CELL toward the pivot rather than
  // down, so it does almost nothing to the balance -- which is one more reason
  // a CELL only takes a descending element.
  const flat = new Hive({ alliance: 'red', pivotX: 0, startUp: 'fore' });
  const steep = new Hive({ alliance: 'red', pivotX: 0, startUp: 'fore' });
  const opening = flat.cellOpening('fore');
  const normal = flat.openingNormal('fore');

  const fire = (hive, vy, vz) => {
    const ball = pollen();
    ball.setPosition(opening.x, opening.y, opening.z + 0.02);
    ball.setVelocity(0, vy, vz);
    hive.angularVelocity = 0;
    for (let i = 0; i < 600; i++) {
      const dt = 1 / 2000;
      ball.y += ball.vy * dt;
      ball.z += ball.vz * dt;
      hive.collideBall(ball);
    }
    return hive.angularVelocity;
  };

  const alongArm = fire(flat, -normal.y * 5, -normal.z * 5);
  const descending = fire(steep, -normal.y * 1.5, -5);
  assert.ok(
    descending > Math.abs(alongArm),
    `descending ${descending.toExponential(2)} should beat along-the-arm ${alongArm.toExponential(2)}`,
  );
});

test('the tip follows where the weight is, not how many elements there are', () => {
  // The lever arm used to be assumed: every element counted as if it sat at the
  // CELL's rest point, so the balance was a function of the count alone. Two
  // elements at the back of a CELL and two at its mouth are not the same
  // torque, and now they are not treated as such.
  const deep = new Hive({ alliance: 'red', pivotX: 0, startUp: 'fore' });
  const shallow = new Hive({ alliance: 'red', pivotX: 0, startUp: 'fore' });

  const place = (hive, along) => {
    const ball = pollen();
    const opening = hive.cellOpening('fore');
    const normal = hive.openingNormal('fore');
    hive.foreBalls.push(ball);
    ball.attachTo('cell', hive);
    ball.setPosition(
      opening.x,
      opening.y - normal.y * along,
      opening.z - normal.z * along,
    );
    return ball;
  };

  // Same element, same mass, different depth into the same CELL.
  place(deep, CELL_DEPTH * 0.9);
  place(shallow, CELL_DEPTH * 0.1);

  assert.ok(
    Math.abs(deep.netTorque) !== Math.abs(shallow.netTorque),
    'the same element at two depths must not give the same torque',
  );
  // Further out along the raised arm is a longer lever, so it pulls harder
  // toward the tip.
  assert.ok(
    deep.netTorque < shallow.netTorque,
    `deep ${deep.netTorque.toFixed(4)} should push harder toward the tip than shallow ${shallow.netTorque.toFixed(4)}`,
  );
});

test('a TIP during AUTO is counted separately', () => {
  const hive = new Hive({ alliance: 'blue', pivotX: 0 });
  for (let i = 0; i < 4; i++) hive.stage(nectar('blue'));
  settle(hive, true);
  assert.equal(hive.tips, 1);
  assert.equal(hive.autoTips, 1);
});

// ----------------------------------------------------------------- flower

test('a FLOWER stacks elements and only the bottom one sits below the scoring volume', () => {
  const flower = newFlower();
  for (let i = 0; i < 4; i++) assert.ok(flower.add(pollen()));

  assert.equal(flower.stack.length, 4);
  assert.equal(
    flower.scoringElements().length,
    3,
    'the bottom POLLEN is the retrievable one, in the retrieval opening',
  );
  for (let i = 1; i < flower.stack.length; i++) {
    assert.ok(
      flower.stack[i].z > flower.stack[i - 1].z,
      'the stack is ordered bottom to top',
    );
  }
});

test('a FLOWER fills up and then refuses more', () => {
  const flower = newFlower();
  let added = 0;
  while (flower.add(pollen())) added++;
  assert.ok(added >= 6 && added <= 10, `plausible capacity, got ${added}`);
  assert.ok(flower.full);
  assert.ok(flower.stack[flower.stack.length - 1].z <= flower.openingHeight);
});

test('G418: only POLLEN comes out of the bottom, so a low NECTAR plugs the FLOWER', () => {
  assert.ok(
    NECTAR_RADIUS * 2 > FLOWER_RETRIEVAL_GAP,
    'the geometry itself is what enforces G418',
  );
  const flower = newFlower();
  flower.add(nectar('blue'));
  flower.add(pollen());
  assert.equal(flower.removeBottom(), null);
  assert.equal(flower.stack.length, 2);

  const open = newFlower();
  open.add(pollen());
  open.add(nectar('red'));
  const taken = open.removeBottom();
  assert.ok(taken && taken.kind === 'pollen');
  assert.ok(taken.free, 'it comes back out loose');
  assert.equal(open.stack.length, 1);
});

test('the FLOWER stack drops down when the bottom POLLEN is pulled', () => {
  const flower = newFlower();
  for (let i = 0; i < 4; i++) flower.add(pollen());
  const topBefore = flower.stack[3].z;
  flower.removeBottom();
  assert.ok(flower.stack[2].z < topBefore - 1e-6, 'everything above settles');
  assert.ok(Math.abs(flower.stack[0].z - flower.stack[0].radius) < 1e-9);
});

test('FLOWER ownership goes to the top-most NECTAR and the bonus to the bottom-most', () => {
  const flower = newFlower();
  for (let i = 0; i < 4; i++) flower.add(pollen());
  assert.equal(flower.owner(), null, 'no NECTAR means nobody owns it');
  assert.deepEqual(flower.score(), { red: 0, blue: 0 });

  flower.add(nectar('red'));
  flower.add(pollen());
  assert.equal(flower.owner(), 'red');
  assert.equal(flower.bottomNectarAlliance(), 'red');
  const redHeld = flower.score();
  assert.equal(
    redHeld.red,
    flower.scoringElements().length * POINTS.elementInOwnedFlower +
      POINTS.bottomNectarBonus,
  );

  // One late NECTAR takes the whole tube, including POLLEN red put there.
  flower.add(nectar('blue'));
  assert.equal(flower.owner(), 'blue');
  assert.equal(flower.bottomNectarAlliance(), 'red', 'red keeps the bottom bonus');
  const stolen = flower.score();
  assert.equal(stolen.red, POINTS.bottomNectarBonus);
  assert.ok(stolen.blue > redHeld.red - POINTS.bottomNectarBonus);
});

test('the backstop makes a long shot forgiving and a short one not', () => {
  const shoot = (offsetIntoField) => {
    const flower = newFlower();
    const ball = pollen();
    // The FLOWER faces +y, so a positive offset is short of it into the FIELD.
    ball.setPosition(0, -HALF_FIELD + offsetIntoField, flower.openingHeight);
    ball.setVelocity(0, 0, -0.5);
    return flower.interactBall(ball);
  };
  assert.ok(shoot(0), 'dead centre goes in');
  assert.ok(shoot(-2 * INCH), 'long, caught by the backstop');
  assert.ok(!shoot(2 * INCH), 'the same error short of the tube misses');
  assert.ok(!shoot(-5 * INCH), 'well past the backstop misses too');
});

test('a rising ball is not captured by a FLOWER', () => {
  const flower = newFlower();
  const ball = pollen();
  ball.setPosition(0, -HALF_FIELD, flower.openingHeight);
  ball.setVelocity(0, 0, 2);
  assert.ok(!flower.interactBall(ball));
});

// ------------------------------------------------------------------ zones

test('the taped zones match the field CAD, including the LOADING ZONE not being in a corner', () => {
  const zones = buildZones();
  const near = (a, b, tol = 1e-9) => Math.abs(a - b) < tol;

  // Sizes: the manual rounds these to 23 x 11 and 23 x 2.
  for (const zone of [zones.redLoading, zones.blueLoading]) {
    assert.ok(near(zone.depth, 22.69 * INCH, 1e-6), 'LOADING ZONE is 22.69 in along its wall');
  }
  for (const zone of [zones.redGarden, zones.blueGarden]) {
    assert.ok(near(zone.width, 22.69 * INCH, 1e-6));
    assert.ok(near(zone.depth, 2 * INCH, 1e-6));
  }

  // The LOADING ZONE touches exactly one wall -- its own ALLIANCE wall -- and
  // is clear of both end walls. Parking means the middle of your wall.
  assert.ok(near(zones.redLoading.minX, -FIELD_INNER_HALF));
  assert.ok(zones.redLoading.minY > -FIELD_INNER_HALF + 20 * INCH);
  assert.ok(zones.redLoading.maxY < FIELD_INNER_HALF - 20 * INCH);
  assert.ok(near(zones.blueLoading.maxX, FIELD_INNER_HALF));

  // GARDENS are in a corner, against two walls, and diagonally opposite.
  for (const zone of [zones.redGarden, zones.blueGarden]) {
    const onX = near(Math.abs(zone.minX), 70.1 * INCH) || near(Math.abs(zone.maxX), 70.1 * INCH);
    const onY = near(Math.abs(zone.minY), 70.1 * INCH) || near(Math.abs(zone.maxY), 70.1 * INCH);
    assert.ok(onX && onY, `${zone.label} is in a corner`);
  }
  assert.ok(zones.redGarden.centerX * zones.blueGarden.centerX < 0);
  assert.ok(zones.redGarden.centerY * zones.blueGarden.centerY < 0);

  // Red's GARDEN is against the audience wall, its LOADING ZONE toward the rear.
  assert.ok(zones.redGarden.centerY < 0, "red's GARDEN is on the audience wall");
  assert.ok(zones.redLoading.centerY > 0, "red's LOADING ZONE is toward the rear");

  // The whole layout is 180 degrees rotationally symmetric.
  const mirrored = (a, b) =>
    near(a.minX, -b.maxX, 1e-9) && near(a.minY, -b.maxY, 1e-9);
  assert.ok(mirrored(zones.redLoading, zones.blueLoading));
  assert.ok(mirrored(zones.redGarden, zones.blueGarden));
});

test('zone overlap is "at least partially in", for balls and for robots', () => {
  const zones = buildZones();
  const zone = zones.redLoading;
  const r = POLLEN_RADIUS;

  assert.ok(zone.overlapsCircle(zone.centerX, zone.centerY, r));
  assert.ok(
    zone.overlapsCircle(zone.maxX + r * 0.5, zone.centerY, r),
    'a ball straddling the tape counts',
  );
  assert.ok(!zone.overlapsCircle(zone.maxX + r * 2, zone.centerY, r));

  const half = 9 * INCH;
  assert.ok(
    zone.overlapsBox(zone.maxX + half - 1 * INCH, zone.centerY, 0, half, half),
    'a robot with one corner in the zone is PARKED',
  );
  assert.ok(!zone.overlapsBox(zone.maxX + half + 1 * INCH, zone.centerY, 0, half, half));
  assert.ok(
    zone.overlapsBox(zone.maxX + half * Math.SQRT2 - 1 * INCH, zone.centerY, Math.PI / 4, half, half),
    'a rotated robot reaches further',
  );
});

test('GARDEN staging puts all four POLLEN on the strip, starting by the ALLIANCE AREA', () => {
  const zones = buildZones();
  for (const zone of [zones.redGarden, zones.blueGarden]) {
    const spots = gardenStagingPositions(zone);
    assert.equal(spots.length, GARDEN_START_POLLEN);
    for (const spot of spots) {
      assert.ok(zone.overlapsCircle(spot.x, spot.y, POLLEN_RADIUS));
    }
    // The line starts in the corner closest to the ALLIANCE AREA (Section 10.3.1).
    const outer = zone.centerX < 0 ? zone.minX : zone.maxX;
    const first = Math.abs(spots[0].x - outer);
    const last = Math.abs(spots[spots.length - 1].x - outer);
    assert.ok(first < last);
  }
});

// ------------------------------------------------------------------ field

test('the FIELD is staged with all 56 SCORING ELEMENTS where Section 10.3.1 puts them', () => {
  const field = new Field(new Config().values);
  const bb = new BiobuzzField({ field });

  assert.equal(bb.allBalls.length, POLLEN_COUNT + NECTAR_PER_ALLIANCE * 2);

  const where = {};
  for (const ball of bb.allBalls) {
    const key = ball.container ? ball.container.kind : 'loose';
    where[key] = (where[key] ?? 0) + 1;
  }
  assert.equal(where.flower, 16, '4 POLLEN in each of the 4 FLOWERS');
  assert.equal(where.preload, 16, '4 POLLEN pre-loaded in each of the 4 ROBOTS');
  assert.equal(where.allianceArea, 10, '5 NECTAR per ALLIANCE with the DRIVE TEAM');

  // There is no 'cell' container any more: an element in a CELL is an
  // ordinary free element that happens to be inside one, so the staged NECTAR
  // count as loose here and the CELLS have to be asked where they are.
  const inCells = bb.hives.red.upBalls.length + bb.hives.blue.upBalls.length;
  assert.equal(inCells, CELL_START_NECTAR * 2, '3 NECTAR in each upward CELL');
  assert.equal(where.cell, undefined, 'and none of them is owned by one');
  assert.equal(where.loose - inCells, 8, '4 POLLEN in each GARDEN');

  assert.equal(bb.preloadGroups.length, 4);
  for (const group of bb.preloadGroups) assert.equal(group.length, 4);
  assert.deepEqual(bb.gardenCounts(), { red: 4, blue: 4 });
});

test('the two HIVES start tilted opposite ways and neither tips at setup', () => {
  const field = new Field(new Config().values);
  const bb = new BiobuzzField({ field });
  assert.notEqual(bb.hives.red.up, bb.hives.blue.up);

  for (let i = 0; i < 240; i++) bb.update(1 / 120, { inAuto: true });
  assert.equal(bb.hives.red.tips, 0);
  assert.equal(bb.hives.blue.tips, 0);
  assert.equal(bb.hives.red.elementsInUpCell(), CELL_START_NECTAR);
  assert.equal(bb.hives.blue.elementsInUpCell(), CELL_START_NECTAR);
});

test('the HIVE structure and the FLOWERS are solid', () => {
  const field = new Field(new Config().values);
  const before = field.elements.length;
  const bb = new BiobuzzField({ field });
  assert.equal(
    field.elements.length,
    before + 10,
    'two foot bars, four struts and four FLOWER tubes',
  );
  for (const obstacle of bb.obstacles) {
    assert.ok(obstacle.collidable);
    assert.ok(obstacle.height > 0);
    assert.equal(obstacle.visible, false, 'the game draws these itself');
  }

  bb.dispose();
  assert.equal(field.elements.length, before, 'and it all comes back out again');
});

test('G427: NECTAR only enters after a TIP unlocks it, through the LOADING ZONE', () => {
  const field = new Field(new Config().values);
  const bb = new BiobuzzField({ field });

  assert.equal(bb.nectarAvailable('red'), 0);
  assert.equal(bb.introduceNectar('red'), null, 'nothing to hand in before a TIP');

  bb.unlockNectar('red', 1);
  assert.equal(bb.nectarAvailable('red'), 1);
  const ball = bb.introduceNectar('red');
  assert.ok(ball && ball.kind === 'nectar' && ball.alliance === 'red');
  assert.ok(ball.free);
  assert.ok(
    bb.zones.redLoading.overlapsCircle(ball.x, ball.y, ball.radius),
    'it enters through the LOADING ZONE',
  );
  assert.equal(bb.nectarAvailable('red'), 0, 'one TIP, one NECTAR');

  // The 60-second rule releases whatever is left, and no more.
  bb.unlockNectar('red', 'all');
  assert.equal(bb.nectarAvailable('red'), 4);
  bb.unlockNectar('red', 'all');
  assert.equal(bb.nectarAvailable('red'), 4, 'never more than the five staged');
});

test('the staged FIELD settles without anything escaping or sinking', () => {
  const field = new Field(new Config().values);
  const bb = new BiobuzzField({ field });
  for (let i = 0; i < 720; i++) bb.update(1 / 240, { inAuto: true });

  assert.ok(bb.ballWorld.settled);
  for (const ball of bb.ballWorld.freeBalls) {
    assert.ok(Math.abs(ball.x) <= HALF_FIELD && Math.abs(ball.y) <= HALF_FIELD);
    assert.ok(ball.z >= ball.radius - 1e-4, 'nothing falls through the tiles');
  }
  assert.deepEqual(bb.gardenCounts(), { red: 4, blue: 4 }, 'staged POLLEN stays put');
  for (const flower of bb.flowers) assert.equal(flower.stack.length, 4);
});

test('the score at setup is only what is already staged on the FIELD', () => {
  const field = new Field(new Config().values);
  const bb = new BiobuzzField({ field });
  const score = bb.fieldScore();
  for (const alliance of ['red', 'blue']) {
    assert.equal(score[alliance].cell, CELL_START_NECTAR * POINTS.elementInCell);
    assert.equal(score[alliance].garden, GARDEN_START_POLLEN * POINTS.elementInGarden);
    assert.equal(score[alliance].flower, 0, 'no NECTAR in a FLOWER means no owner');
    assert.equal(score[alliance].bottomNectar, 0);
    assert.equal(score[alliance].tips, 0);
  }
});

// --------------------------------------------------------------- field CAD

test('the four FLOWERS sit one per wall, as the field CAD places them', () => {
  const field = new Field(new Config().values);
  const bb = new BiobuzzField({ field });
  assert.equal(bb.flowers.length, 4);

  // One against each of the four walls, 68.04 in out and 23.39 in along.
  const walls = new Set();
  for (const flower of bb.flowers) {
    const out = Math.max(Math.abs(flower.x), Math.abs(flower.y));
    const along = Math.min(Math.abs(flower.x), Math.abs(flower.y));
    assert.ok(Math.abs(out - FLOWER_AXIS_OFFSET) < 1e-9);
    assert.ok(Math.abs(along - FLOWER_ALONG_WALL) < 1e-9);
    walls.add(
      Math.abs(flower.x) > Math.abs(flower.y)
        ? (flower.x < 0 ? 'red' : 'blue')
        : (flower.y < 0 ? 'audience' : 'rear'),
    );
    // `facing` points from the wall into the FIELD.
    const inward = -(flower.x * Math.cos(flower.facing) + flower.y * Math.sin(flower.facing));
    assert.ok(inward > 0, `${flower.id} faces into the field`);
  }
  assert.equal(walls.size, 4, 'one FLOWER per wall');

  // 180 degree rotational symmetry: every FLOWER has an opposite.
  for (const flower of bb.flowers) {
    assert.ok(
      bb.flowers.some(
        (o) => Math.abs(o.x + flower.x) < 1e-9 && Math.abs(o.y + flower.y) < 1e-9,
      ),
    );
  }
});

test('the FLOWER scoring volume is the span of the pipes, and the staged POLLEN straddle its floor', () => {
  const flower = newFlower();
  assert.equal(flower.scoringBottom, FLOWER_SCORING_BOTTOM);
  assert.equal(flower.scoringTop, FLOWER_SCORING_TOP);

  // The CAD stages four POLLEN per FLOWER. The bottom one tops out below the
  // scoring floor, so it is the retrievable one; the other three score.
  const scoring = FLOWER_STAGED_HEIGHTS.filter(
    (z) => z + POLLEN_RADIUS > FLOWER_SCORING_BOTTOM,
  );
  assert.equal(scoring.length, 3);
  assert.ok(FLOWER_STAGED_HEIGHTS[0] + POLLEN_RADIUS < FLOWER_SCORING_BOTTOM);
});

test('the shooting target is the CELL opening, on the right side of each HIVE', () => {
  const field = new Field(new Config().values);
  const bb = new BiobuzzField({ field });

  const red = bb.hiveTarget('red');
  const blue = bb.hiveTarget('blue');
  const close = (a, b) => Math.abs(a - b) < 1e-9;

  assert.ok(close(Math.abs(red.x), HIVE_PIVOT_X), 'centred on its own pivot');
  const half = (CELL_OPENING_HEIGHT / 2) * Math.cos(HIVE_TILT);
  assert.ok(Math.abs(red.z - half - CELL_OPENING_BOTTOM) < 1e-3, 'Figure 9-9: 53.5 in');
  assert.ok(Math.abs(red.z + half - CELL_OPENING_TOP) < 1e-3, 'Figure 9-9: 65.6 in');

  // Red's audience-side CELL is up, blue's rear-side one is.
  assert.equal(bb.hives.red.up, RED_START_UP);
  assert.equal(bb.hives.blue.up, BLUE_START_UP);
  assert.ok(red.y < 0, "red's up CELL is on the audience side");
  assert.ok(blue.y > 0, "blue's up CELL is on the rear side");

  // The down CELL is a mirror across the arm, and below the pivot.
  const down = bb.hives.red.cellOpening(RED_START_UP === 'fore' ? 'aft' : 'fore');
  assert.ok(down.z < HIVE_PIVOT_HEIGHT, 'the down CELL is below the pivot');
  assert.ok(Math.sign(down.y) !== Math.sign(red.y), 'and on the other side');
});

test("each HIVE's down CELL faces the FLOWER on its own half of the field", () => {
  // Section 10.3.1: "the CELL which points at a FLOWER should be the one tilted
  // down". With one FLOWER per wall this is what that resolves to.
  const field = new Field(new Config().values);
  const bb = new BiobuzzField({ field });

  for (const alliance of ['red', 'blue']) {
    const hive = bb.hives[alliance];
    const down = hive.cellOpening(hive.up === 'fore' ? 'aft' : 'fore');
    const wallY = Math.sign(down.y) * FLOWER_AXIS_OFFSET;
    const flower = bb.flowers.find((f) => Math.abs(f.y - wallY) < 1e-9);
    assert.ok(flower, `a FLOWER on the wall ${alliance}'s down CELL faces`);
    assert.ok(
      Math.sign(flower.x) === Math.sign(hive.pivotX),
      `${alliance}'s down CELL faces the FLOWER on its own half`,
    );
  }
});

// ------------------------------------------------- the structures as obstacles

test('the HIVE frame goes in as its foot bars and the reachable strut shadows', () => {
  const field = new Field(new Config().values);
  const bb = new BiobuzzField({ field });

  const feet = bb.obstacles.filter((o) => o.id.startsWith('hiveFoot'));
  const struts = bb.obstacles.filter((o) => o.id.startsWith('hiveStrut'));
  assert.equal(feet.length, 2);
  assert.equal(struts.length, 4, 'two struts per side');

  for (const foot of feet) {
    // 2 in thick, the full depth, and only 2.15 in tall -- bumper height.
    assert.ok(Math.abs(foot.size.x - 2 * INCH) < 1e-9);
    assert.ok(Math.abs(foot.size.y - 38.94 * INCH) < 1e-9);
    assert.ok(Math.abs(foot.height - 2.15 * INCH) < 1e-9);
  }
  // Struts are oriented, not axis-aligned: they run up and inward.
  for (const strut of struts) {
    assert.ok(Math.abs(Math.sin(strut.heading)) > 0.1, 'a strut is on a diagonal');
    assert.ok(strut.size.x > 8 * INCH && strut.size.x < 12 * INCH);
  }
});

test('a ROBOT crosses the field front to back under the HIVE, but not side to side', () => {
  // The frame reads as open in the middle, and front to back it is: nothing
  // below the CELLS at 38 in. But the foot bars are continuous 2 in walls
  // across the full depth, so going side to side you go *around* the frame.
  const field = new Field(new Config().values);
  const bb = new BiobuzzField({ field });
  const half = 9 * INCH;

  const blocked = (x, y) =>
    bb.obstacles.some((o) => {
      const c = Math.abs(Math.cos(o.heading));
      const s = Math.abs(Math.sin(o.heading));
      const ex = (o.size.x / 2) * c + (o.size.y / 2) * s;
      const ey = (o.size.x / 2) * s + (o.size.y / 2) * c;
      return (
        Math.abs(x - o.position.x) < ex + half && Math.abs(y - o.position.y) < ey + half
      );
    });

  // A corridor straight down the middle, clear the whole way.
  for (let y = -60; y <= 60; y += 4) {
    assert.ok(!blocked(0, y * INCH), `the middle should be clear at y = ${y} in`);
  }
  // Crossing side to side through the frame is not on: the foot bar stops you.
  assert.ok(blocked(-23.75 * INCH, 0), 'the red foot bar blocks the centre line');
  assert.ok(blocked(23.75 * INCH, 0), 'and so does the blue one');
  // Around the outside of the frame is clear.
  assert.ok(!blocked(-23.75 * INCH, 32 * INCH), 'past the end of the frame is open');
});

test('a FLOWER obstacle matches its ring plates and faces the right way', () => {
  const field = new Field(new Config().values);
  const bb = new BiobuzzField({ field });
  const tubes = bb.obstacles.filter((o) => o.id.endsWith('Tube'));
  assert.equal(tubes.length, 4);

  for (const tube of tubes) {
    const wide = Math.max(tube.size.x, tube.size.y);
    const deep = Math.min(tube.size.x, tube.size.y);
    assert.ok(Math.abs(wide - FLOWER_RING_WIDTH) < 1e-9);
    assert.ok(Math.abs(deep - FLOWER_RING_DEPTH) < 1e-9);
    // The wide axis runs along the wall it is mounted on.
    const onEndWall = Math.abs(tube.position.y) > Math.abs(tube.position.x);
    assert.equal(
      tube.size.x > tube.size.y,
      onEndWall,
      `${tube.id} should be widest along its own wall`,
    );
  }
});

test('an element against the outside of a CELL corner falls, it does not hang there', () => {
  const hive = new Hive({ alliance: 'red', pivotX: -HIVE_PIVOT_X, startUp: 'aft' });

  // A little outside the bottom-back corner of a CELL: within a radius of both
  // the floor plate and the back panel, and off toward one side. Resolved plate
  // by plate as two-sided slabs, the two normals are 60 degrees apart with
  // upward components -- so each push shoved the element into the other's slab
  // and the pair of them held it against gravity for the rest of the MATCH. It
  // did not merely fail to fall; it crept *upward*.
  //
  // A pentagonal prism is convex, so from outside there is exactly one contact.
  for (const side of ['fore', 'aft']) {
    const planes = hive.cellPlanes(side);
    const ball = new Ball({
      id: 'p', kind: 'pollen', radius: POLLEN_RADIUS, mass: POLLEN_MASS,
    });
    const a = -0.25;
    const v = 0.0089;
    const d = planes.depth + 0.0087;
    ball.setPosition(
      planes.origin.x + a,
      planes.origin.y + planes.up.y * (v - planes.baseOffset) + planes.inward.y * d,
      planes.origin.z + planes.up.z * (v - planes.baseOffset) + planes.inward.z * d,
    );
    ball.stop();

    const startZ = ball.z;
    // The HIVE is not in a ball world here, so integrate the two lines that
    // matter -- gravity and the collider.
    for (let i = 0; i < 1200; i++) {
      ball.vz -= 9.80665 / 400;
      ball.x += ball.vx / 400;
      ball.y += ball.vy / 400;
      ball.z += ball.vz / 400;
      hive.collideBall(ball);
    }
    assert.ok(
      ball.z < startZ - 0.3,
      `the ${side} CELL let it go: z ${startZ.toFixed(3)} -> ${ball.z.toFixed(3)}`,
    );
  }
});

test('an element inside a CELL is still held by its floor', () => {
  const hive = new Hive({ alliance: 'red', pivotX: -HIVE_PIVOT_X, startUp: 'fore' });
  const planes = hive.cellPlanes('fore');
  const ball = new Ball({
    id: 'p', kind: 'pollen', radius: POLLEN_RADIUS, mass: POLLEN_MASS,
  });
  // A radius above the floor, half the depth in: where a scored element sits.
  const v = POLLEN_RADIUS;
  const d = planes.depth * 0.5;
  ball.setPosition(
    planes.origin.x,
    planes.origin.y + planes.up.y * (v - planes.baseOffset) + planes.inward.y * d,
    planes.origin.z + planes.up.z * (v - planes.baseOffset) + planes.inward.z * d,
  );
  ball.stop();

  for (let i = 0; i < 800; i++) {
    ball.vz -= 9.80665 / 800;
    ball.x += ball.vx / 800;
    ball.y += ball.vy / 800;
    ball.z += ball.vz / 800;
    hive.collideBall(ball);
  }
  const local = hive.cellLocal('fore', ball.x, ball.y, ball.z);
  assert.ok(local.v > -0.01, `still on the floor of the CELL: v=${local.v.toFixed(3)}`);
  assert.ok(local.d > -0.05 && local.d < planes.depth + 0.05, `and still in it: d=${local.d.toFixed(3)}`);
});

test('a TIPPING HIVE pours its load out of the CELL mouth, not out of the pivot', () => {
  // The complaint this comes from: "the balls just drop down, when they should
  // be rolling off the hive as it goes down". They did drop, because a CELL
  // that turned over teleported every element to one point near the *back* of
  // the cell -- a hand's width from the pivot -- and released them all in the
  // same instant with a random sideways shove to stop them landing in a single
  // stack. So the load fell out of the middle of the hive and scattered
  // sideways, which is neither of the two things a real load does.
  const hive = hiveRig({ alliance: 'red', pivotX: 0, startUp: 'fore' });
  for (let i = 0; i < CELL_START_NECTAR; i++) hive.stage(nectar('red'));
  for (let i = 0; i < 4; i++) hive.stage(pollen());

  const released = [];
  const dt = 1 / 500;
  let t = 0;
  let tippedAt = null;
  const seen = new Set();
  while (t < 8) {
    stepHive(hive, dt);
    t += dt;
    if (tippedAt === null && hive.tips > 0) tippedAt = t;
    for (const ball of hive.spilled) {
      if (seen.has(ball.id)) continue;
      seen.add(ball.id);
      // The CELL's own geometry *at this instant*, not at the end of the tip.
      // The arm is still swinging when the load starts coming out, so a mouth
      // position read after it has settled is tens of centimetres away from
      // where the mouth was when the element went through it.
      released.push({
        ball,
        t,
        y: ball.y,
        z: ball.z,
        vy: ball.vy,
        vz: ball.vz,
        spin: ball.wx,
        // Where it was in the CELL's own frame as it left, which is the only
        // frame in which "came out of the opening" is a clean statement: `d`
        // is depth in from the mouth, so negative means it has crossed the
        // opening plane going out.
        local: hive.cellLocal('fore', ball.x, ball.y, ball.z),
        depth: hive.cellPlanes('fore').depth,
        // And how far out along the arm, which does not depend on the angle.
        fromPivot: Math.hypot(ball.y, ball.z - HIVE_PIVOT_HEIGHT),
        mouthFromPivot: Math.hypot(
          hive.cellOpening('fore').y,
          hive.cellOpening('fore').z - HIVE_PIVOT_HEIGHT,
        ),
        backFromPivot: Math.hypot(
          hive.cellRest('fore').y,
          hive.cellRest('fore').z - HIVE_PIVOT_HEIGHT,
        ),
      });
    }
    if (hive.tips > 0 && hive.downBalls.length === 0) {
      // As in `settle`: a departure during the world step is reported on the
      // HIVE's next step, so give it one.
      stepHive(hive, dt);
      for (const ball of hive.spilled) {
        if (seen.has(ball.id)) continue;
        seen.add(ball.id);
        released.push({
          ball,
          t,
          y: ball.y,
          z: ball.z,
          vy: ball.vy,
          vz: ball.vz,
          spin: ball.wx,
          local: hive.cellLocal('fore', ball.x, ball.y, ball.z),
          depth: hive.cellPlanes('fore').depth,
          fromPivot: Math.hypot(ball.y, ball.z - HIVE_PIVOT_HEIGHT),
          mouthFromPivot: Math.hypot(
            hive.cellOpening('fore').y,
            hive.cellOpening('fore').z - HIVE_PIVOT_HEIGHT,
          ),
          backFromPivot: Math.hypot(
            hive.cellRest('fore').y,
            hive.cellRest('fore').z - HIVE_PIVOT_HEIGHT,
          ),
        });
      }
      break;
    }
  }

  assert.equal(hive.tips, 1);
  assert.equal(released.length, 7, 'the whole load comes out');

  for (const r of released) {
    assert.ok(
      r.mouthFromPivot > r.backFromPivot,
      'the mouth is further out along the arm than the back, or this test is upside down',
    );
    // Out through the opening: past the mouth plane, and only just past it.
    assert.ok(
      r.local.d < 0,
      `should leave through the mouth, but was ${r.local.d.toFixed(3)} m deep in the CELL`,
    );
    assert.ok(
      r.local.d > -0.2,
      `should leave *at* the mouth, not teleported clear of it: d ${r.local.d.toFixed(3)}`,
    );
    // And out at the far end of the arm rather than dropping out of the
    // middle of the HIVE, which is what it used to do.
    assert.ok(
      r.fromPivot > r.backFromPivot,
      `released ${r.fromPivot.toFixed(3)} m from the pivot, with the CELL's back at ` +
        `${r.backFromPivot.toFixed(3)} m and its mouth at ${r.mouthFromPivot.toFixed(3)} m`,
    );
    // Travelling outward, which is the direction the mouth faces -- the fore
    // CELL opens toward -y.
    assert.ok(r.vy < -0.05, `should leave travelling outward, got vy ${r.vy.toFixed(3)}`);
    // Moving, rather than being set down: it has rolled to the mouth under
    // gravity and carries the speed it got there with.
    assert.ok(
      Math.hypot(r.vy, r.vz) > 0.1,
      `should leave with the speed it rolled up, got ${Math.hypot(r.vy, r.vz).toFixed(3)} m/s`,
    );
  }

  // It pours rather than dumping: the arm reaches its stop and the load keeps
  // coming for a while after.
  const firstOut = released[0].t - tippedAt;
  assert.ok(
    firstOut > 0.1,
    `the load should take time to reach the mouth, left ${firstOut.toFixed(3)} s after the tip`,
  );
  // Elements queued behind others cannot leave at the same moment.
  const span = released[released.length - 1].t - released[0].t;
  assert.ok(span > 0, `a queued load cannot all leave at once, span ${span.toFixed(3)} s`);

  // No sideways scatter invented for the look of it. Some x velocity is real
  // now -- elements inside a CELL touch each other, and being jostled by a
  // neighbour pushes one sideways -- but it is contact, not a random shove, so
  // it stays small next to the speed they are rolling at.
  for (const r of released) {
    assert.ok(
      Math.abs(r.ball.vx) < 0.3,
      `sideways speed should come from contact, not a dice roll: ${r.ball.vx.toFixed(3)} m/s`,
    );
  }
});

test('a raised CELL holds its load against the back wall', () => {
  // The other half of the same model. The CELL floor runs out along the arm,
  // so the arm's angle *is* the floor's slope -- which means the same rolling
  // that empties a lowered CELL is what holds a raised one, and there is no
  // separate "held" rule to keep in step with it.
  const hive = hiveRig({ alliance: 'red', pivotX: 0, startUp: 'fore' });
  for (let i = 0; i < CELL_START_NECTAR; i++) hive.stage(nectar('red'));
  for (let i = 0; i < 1500; i++) stepHive(hive, 1 / 500);

  assert.equal(hive.tips, 0, 'three staged NECTAR do not tip it');
  assert.equal(hive.elementsInUpCell(), CELL_START_NECTAR);

  const back = hive.cellRest('fore');
  const mouth = hive.cellOpening('fore');
  for (const ball of hive.upBalls) {
    const toBack = Math.abs(ball.y - back.y);
    const toMouth = Math.abs(ball.y - mouth.y);
    assert.ok(
      toBack < toMouth,
      `a held element should settle against the back: ${toBack.toFixed(3)} m from it, ` +
        `${toMouth.toFixed(3)} m from the mouth`,
    );
  }
});

test('the same load spills the same way twice', () => {
  // The old spill drew two `Math.random()` values per element, so no two tips
  // were alike and none could be regression-tested. It is now the arm's
  // rotation and gravity along a floor, which is repeatable.
  const run = () => {
    const hive = hiveRig({ alliance: 'red', pivotX: 0, startUp: 'fore' });
    for (let i = 0; i < CELL_START_NECTAR; i++) hive.stage(nectar('red'));
    for (let i = 0; i < 4; i++) hive.stage(pollen());
    for (let i = 0; i < 4000; i++) stepHive(hive, 1 / 500);
    return hive.takeSpilled().map((b) => [b.x, b.y, b.z, b.vx, b.vy, b.vz]);
  };
  assert.deepEqual(run(), run());
});

test('a load in a CELL is not frozen: a new arrival knocks it about', () => {
  // This is the whole point of nothing being adopted. A CELL used to take
  // ownership of anything that stopped moving in it and thereafter *place* it
  // on a lattice, so a settled load was scenery: the next shot could not
  // disturb it, and two elements in the same CELL could not touch.
  const hive = hiveRig({ alliance: 'red', pivotX: 0, startUp: 'fore' });
  for (let i = 0; i < CELL_START_NECTAR; i++) hive.stage(nectar('red'));
  for (let i = 0; i < 300; i++) stepHive(hive, 1 / 500);

  const settled = hive.upBalls.map((b) => ({ ball: b, x: b.x, y: b.y, z: b.z }));
  assert.equal(settled.length, CELL_START_NECTAR, 'the staged load is still there');

  // They are resting against each other, not parked on a grid.
  let nearest = Infinity;
  for (let i = 0; i < settled.length; i++) {
    for (let j = i + 1; j < settled.length; j++) {
      const a = settled[i].ball;
      const b = settled[j].ball;
      nearest = Math.min(
        nearest,
        Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z) - (a.radius + b.radius),
      );
    }
  }
  assert.ok(nearest < 0.02, `the load should be in contact, nearest gap ${(nearest * 1000).toFixed(1)} mm`);

  // Now drop a shot in on top of it.
  const opening = hive.cellOpening('fore');
  const shot = pollen();
  hive.world.add(shot);
  shot.setPosition(opening.x, opening.y, opening.z + 0.3);
  shot.setVelocity(0, 0, -3.5);
  for (let i = 0; i < 400; i++) stepHive(hive, 1 / 500);

  let shifted = 0;
  for (const before of settled) {
    shifted = Math.max(
      shifted,
      Math.hypot(
        before.ball.x - before.x,
        before.ball.y - before.y,
        before.ball.z - before.z,
      ),
    );
  }
  assert.ok(
    shifted > 0.005,
    `the arriving element should move the load, shifted ${(shifted * 1000).toFixed(1)} mm`,
  );
  // And it did not pass through them: everything is still in there.
  assert.ok(hive.upBalls.length >= CELL_START_NECTAR, 'nothing was displaced out of the CELL');
});

test('an element in a CELL is never taken out of the physics', () => {
  // The property the rest of the simulator depends on. `BallWorld` only steps
  // elements with no container, so attaching one to a CELL is what stopped it
  // falling, bouncing and colliding -- which is why a CELL now owns nothing
  // and answers "what is in me" by looking.
  const hive = hiveRig({ alliance: 'red', pivotX: 0, startUp: 'fore' });
  for (let i = 0; i < CELL_START_NECTAR; i++) hive.stage(nectar('red'));
  for (let i = 0; i < 300; i++) stepHive(hive, 1 / 500);

  assert.equal(hive.elementsInUpCell(), CELL_START_NECTAR);
  for (const ball of hive.upBalls) {
    assert.equal(ball.container, null, `${ball.id} should still be a free element`);
    assert.equal(ball.free, true);
  }
  // And a CELL refuses to take anything, whatever it is asked.
  const loose = pollen();
  hive.world.add(loose);
  const opening = hive.cellOpening('fore');
  loose.setPosition(opening.x, opening.y, opening.z);
  loose.stop();
  assert.equal(hive.interactBall(loose), false, 'a CELL is not a container');
  assert.equal(loose.container, null);
});
