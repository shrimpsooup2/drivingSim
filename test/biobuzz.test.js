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
  CELL_START_NECTAR,
  FLOWER_RETRIEVAL_HEIGHT,
  GARDEN_START_POLLEN,
  HALF_FIELD,
  NECTAR_DIAMETER,
  NECTAR_MASS,
  NECTAR_PER_ALLIANCE,
  POLLEN_COUNT,
  POLLEN_DIAMETER,
  POLLEN_MASS,
  POINTS,
} from '../src/field/biobuzz/constants.js';
import { INCH } from '../src/math/MathUtil.js';

let nextId = 0;
const pollen = () =>
  new Ball({
    id: `p${nextId++}`,
    kind: 'pollen',
    radius: POLLEN_DIAMETER / 2,
    mass: POLLEN_MASS,
  });
const nectar = (alliance) =>
  new Ball({
    id: `n${nextId++}`,
    kind: 'nectar',
    alliance,
    radius: NECTAR_DIAMETER / 2,
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

test('the HIVE holds the three NECTAR staged in it at setup', () => {
  // Section 10.3.1 stages three NECTAR in the upward CELL of every HIVE. If the
  // tip threshold were at or below that mass every MATCH would begin with both
  // HIVES tipping, so this pins the calibration down.
  const hive = new Hive({ alliance: 'red', pivotX: 0 });
  for (let i = 0; i < CELL_START_NECTAR; i++) hive.stage(nectar('red'));
  for (let i = 0; i < 60; i++) hive.update(1 / 60, false);
  assert.equal(hive.tips, 0);
  assert.equal(hive.elementsInUpCell(), CELL_START_NECTAR);
});

test('the HIVE tips once loaded past the threshold, spills, and comes back empty', () => {
  const hive = new Hive({ alliance: 'red', pivotX: 0, startUp: 'fore' });
  for (let i = 0; i < CELL_START_NECTAR; i++) hive.stage(nectar('red'));
  hive.stage(pollen());

  for (let i = 0; i < 120; i++) hive.update(1 / 60, false);

  assert.equal(hive.tips, 1);
  assert.equal(hive.up, 'aft', 'the opposite CELL is now up');
  assert.equal(hive.elementsInUpCell(), 0, 'it arrives empty, ready to fill again');
  assert.equal(hive.takeSpilled().length, 4, 'the old contents fall out');
});

test('a TIP during AUTO is counted separately', () => {
  const hive = new Hive({ alliance: 'blue', pivotX: 0 });
  for (let i = 0; i < 4; i++) hive.stage(nectar('blue'));
  for (let i = 0; i < 120; i++) hive.update(1 / 60, true);
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
    NECTAR_DIAMETER > FLOWER_RETRIEVAL_HEIGHT,
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

test('the taped zones are the size the manual gives and sit in opposite corners', () => {
  const zones = buildZones();
  const near = (a, b) => Math.abs(a - b) < 1e-9;

  for (const zone of [zones.redLoading, zones.blueLoading]) {
    assert.ok(near(zone.width, 11 * INCH) && near(zone.depth, 23 * INCH));
  }
  for (const zone of [zones.redGarden, zones.blueGarden]) {
    assert.ok(near(zone.width, 23 * INCH) && near(zone.depth, 2 * INCH));
  }

  // Every zone is in a corner, against two walls.
  for (const zone of zones.all) {
    const onX = near(Math.abs(zone.minX), HALF_FIELD) || near(Math.abs(zone.maxX), HALF_FIELD);
    const onY = near(Math.abs(zone.minY), HALF_FIELD) || near(Math.abs(zone.maxY), HALF_FIELD);
    assert.ok(onX && onY, `${zone.label} is in a corner`);
  }

  // "GARDENS ... in opposite corners of the FIELD" (Section 9.3).
  assert.ok(zones.redGarden.centerX * zones.blueGarden.centerX < 0);
  assert.ok(zones.redGarden.centerY * zones.blueGarden.centerY < 0);
  // Each ALLIANCE's two zones are on its own side of the FIELD.
  assert.ok(zones.redLoading.centerX < 0 && zones.redGarden.centerX < 0);
  assert.ok(zones.blueLoading.centerX > 0 && zones.blueGarden.centerX > 0);
});

test('zone overlap is "at least partially in", for balls and for robots', () => {
  const zones = buildZones();
  const zone = zones.redLoading;
  const r = POLLEN_DIAMETER / 2;

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
    const spots = gardenStagingPositions(zone, GARDEN_START_POLLEN, POLLEN_DIAMETER / 2);
    assert.equal(spots.length, GARDEN_START_POLLEN);
    for (const spot of spots) {
      assert.ok(zone.overlapsCircle(spot.x, spot.y, POLLEN_DIAMETER / 2));
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
  assert.equal(where.loose, 8, '4 POLLEN in each GARDEN');
  assert.equal(where.cell, 6, '3 NECTAR in each upward CELL');
  assert.equal(where.allianceArea, 10, '5 NECTAR per ALLIANCE with the DRIVE TEAM');

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
  assert.equal(field.elements.length, before + 6, 'two frame legs and four FLOWER tubes');
  for (const obstacle of bb.obstacles) {
    assert.ok(obstacle.collidable);
    assert.ok(obstacle.height > 0);
  }
  // The frame really does block the middle of the FIELD.
  const legs = bb.obstacles.filter((o) => o.id.startsWith('hiveFrameLeg'));
  assert.equal(legs.length, 2);
  assert.ok(legs[0].position.x * legs[1].position.x < 0);
  for (const leg of legs) assert.ok(leg.size.y > 36 * INCH);

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
