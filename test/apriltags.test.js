import test from 'node:test';
import assert from 'node:assert/strict';
import { Config } from '../src/config/Config.js';
import { Simulation } from '../src/app/Simulation.js';
import { Camera } from '../src/hardware/Camera.js';
import {
  APRILTAG_CLUSTERS,
  APRILTAG_IDS,
  APRILTAG_SIZE,
  clusterTags,
  fieldTags,
} from '../src/field/biobuzz/aprilTags.js';
import { INCH } from '../src/math/MathUtil.js';

function rig(overrides = {}) {
  const config = new Config();
  config.set('ai.enabled', false);
  for (const [path, value] of Object.entries(overrides)) config.set(path, value);
  const sim = new Simulation(config);
  const game = sim.enableGame({ alliance: 'red' }).start();
  return { sim, game };
}

/** Put the robot somewhere and let the pipeline fill up. */
function look(sim, x, y, heading) {
  sim.placeRobot(x, y, heading);
  sim.robot.camera.reset();
  for (let i = 0; i < 30; i++) sim.step(1 / 60);
  return sim.robot.camera.detections;
}

// ------------------------------------------------------------- the library

test('there are sixteen tags with the manual’s IDs on the manual’s CELLS', () => {
  const { game } = rig();
  const tags = fieldTags(game.field.hives);
  assert.equal(tags.length, 16);
  assert.deepEqual([...tags.map((t) => t.id)].sort((a, b) => a - b), APRILTAG_IDS);
  for (const tag of tags) assert.equal(tag.size, APRILTAG_SIZE);

  // 9.9: 30-33 on the red CELL away from the audience, 34-37 on the red CELL on
  // the audience side. The audience is at -y here, which is `fore`.
  const byId = new Map(tags.map((t) => [t.id, t]));
  assert.equal(byId.get(30).side, 'aft');
  assert.equal(byId.get(34).side, 'fore');
  assert.equal(byId.get(38).side, 'fore');
  assert.equal(byId.get(42).side, 'aft');
  assert.equal(byId.get(30).alliance, 'red');
  assert.equal(byId.get(41).alliance, 'blue');
  assert.deepEqual(APRILTAG_CLUSTERS.blue.aft, [42, 43, 44, 45]);
});

test('a cluster is four tags on one plane, facing away from the CELL', () => {
  const { game } = rig();
  const hive = game.field.hives.red;
  const tags = clusterTags(hive, 'fore');
  assert.equal(tags.length, 4);

  // All four share a normal, and it points down: the sticker is on the bottom
  // of the CELL facing the tiles.
  const normal = tags[0].normal;
  for (const tag of tags) assert.deepEqual(tag.normal, normal);
  assert.ok(normal.z < -0.5, `the cluster faces z ${normal.z}`);

  // They lie in that plane, four inches apart on centre.
  const centre = {
    x: tags.reduce((t, g) => t + g.x, 0) / 4,
    y: tags.reduce((t, g) => t + g.y, 0) / 4,
    z: tags.reduce((t, g) => t + g.z, 0) / 4,
  };
  for (const tag of tags) {
    const d =
      (tag.x - centre.x) * normal.x + (tag.y - centre.y) * normal.y + (tag.z - centre.z) * normal.z;
    assert.ok(Math.abs(d) < 1e-12, 'coplanar');
    const spread = Math.hypot(tag.x - centre.x, tag.y - centre.y, tag.z - centre.z);
    assert.ok(Math.abs(spread - Math.SQRT2 * 2 * INCH) < 1e-9, `spread ${spread / INCH} in`);
  }

  // The top edge points outward along the arm, because the bottom edge points
  // at the middle of the FIELD.
  const outward = hive.openingNormal('fore');
  assert.ok(Math.abs(tags[0].up.y - outward.y) < 1e-12);
  assert.ok(Math.abs(tags[0].up.z - outward.z) < 1e-12);
});

test('the tags move when the HIVE tips', () => {
  const { sim, game } = rig();
  const hive = game.field.hives.red;
  const before = new Map(fieldTags(game.field.hives).map((t) => [t.id, { ...t }]));
  hive.angle = -hive.angle;
  const after = new Map(fieldTags(game.field.hives).map((t) => [t.id, t]));
  const raised = after.get(30);
  assert.ok(
    Math.abs(raised.z - before.get(30).z) > 0.3,
    `a tipped CELL should move its tags: ${before.get(30).z} -> ${raised.z}`,
  );
  assert.ok(sim.time >= 0);
});

// -------------------------------------------------------------- the camera

test('the camera sees the tags, and the pose it implies is good to a few centimetres', () => {
  const { sim } = rig();
  const found = look(sim, -0.3, -1.4, Math.PI / 2);
  assert.ok(found.length >= 4, `saw ${found.length} tags`);
  // Biggest first, so the first one is the one to trust.
  for (let i = 1; i < found.length; i++) {
    assert.ok(found[i - 1].pixels >= found[i].pixels);
  }
  const body = sim.robot.body;
  const pose = sim.robot.camera.bestPose(body.rotation.radians);
  const error = Math.hypot(pose.x - body.position.x, pose.y - body.position.y);
  assert.ok(error < 0.06, `${(error * 1000).toFixed(0)} mm out`);
});

test('a pitched-up camera is what makes a raised CELL readable', () => {
  const { sim } = rig({ 'camera.pitchDegrees': 0 });
  const level = look(sim, -0.3, -0.9, Math.PI / 2).length;
  sim.configStore.set('camera.pitchDegrees', 25);
  const pitched = look(sim, -0.3, -0.9, Math.PI / 2).length;
  assert.equal(level, 0, 'a level camera is looking under them');
  assert.ok(pitched >= 4, `pitched up it found ${pitched}`);
});

test('a detection is stale, and says how stale', () => {
  const { sim } = rig({ 'camera.latencyMs': 100 });
  const found = look(sim, -0.3, -1.4, Math.PI / 2);
  assert.ok(found.length > 0);
  assert.ok(found[0].age >= 0.1, `age ${found[0].age}`);
  assert.ok(found[0].age < 0.15, 'and not older than a frame past the latency');

  // The staleness has a cost: a fix taken while moving lands behind the robot.
  sim.input.keyboardSource.active = true;
  sim.input.keyboardSource.keys.add('KeyW');
  for (let i = 0; i < 40; i++) sim.step(1 / 60);
  sim.input.keyboardSource.keys.delete('KeyW');
  const moving = sim.robot.camera.detections;
  if (moving.length) {
    const pose = sim.robot.camera.bestPose(sim.robot.body.rotation.radians);
    const behind = Math.hypot(
      pose.x - sim.robot.body.position.x,
      pose.y - sim.robot.body.position.y,
    );
    assert.ok(behind > 0.02, `a fix taken at speed should lag: ${(behind * 1000).toFixed(0)} mm`);
  }
});

test('nothing is seen from behind a tag, however close', () => {
  // On the far side of the HIVE from red's tags, looking back at them: the
  // printed faces are pointing away.
  const camera = new Camera({ random: () => 0.5 });
  // At the camera's own height, so the test is about which way the face
  // points and not about the vertical field of view.
  const tag = {
    id: 30,
    size: APRILTAG_SIZE,
    x: 0,
    y: 1,
    z: 0.25,
    normal: { x: 0, y: 1, z: 0 },
    up: { x: 0, y: 0, z: 1 },
    right: { x: 1, y: 0, z: 0 },
  };
  // In front of the face: visible.
  camera.reset();
  camera.update(1, { x: 0, y: 2, heading: -Math.PI / 2 }, [tag]);
  camera.update(0.1, { x: 0, y: 2, heading: -Math.PI / 2 }, [tag]);
  assert.equal(camera.detections.length, 1);

  // Behind it: nothing, at the same range.
  camera.reset();
  camera.update(1, { x: 0, y: 0, heading: Math.PI / 2 }, [tag]);
  camera.update(0.1, { x: 0, y: 0, heading: Math.PI / 2 }, [tag]);
  assert.equal(camera.detections.length, 0);
});

test('a tag too small on the sensor does not decode', () => {
  const camera = new Camera({ random: () => 0.5, latencySeconds: 0, minTagPixels: 14 });
  const far = (range) => {
    const tag = {
      id: 30,
      size: APRILTAG_SIZE,
      x: range,
      y: 0,
      z: 0.25,
      normal: { x: -1, y: 0, z: 0 },
      up: { x: 0, y: 0, z: 1 },
      right: { x: 0, y: 1, z: 0 },
    };
    camera.reset();
    camera.update(1, { x: 0, y: 0, heading: 0 }, [tag]);
    camera.update(0.05, { x: 0, y: 0, heading: 0 }, [tag]);
    return camera.detections.length;
  };
  // 640 px over 60 degrees is about 1.6 mrad a pixel, so a 3.25 in tag is 14 px
  // wide at roughly 3.8 m.
  assert.equal(far(2), 1);
  assert.equal(far(4.5), 0);
});

test('the field of view is the limit, and the vertical one comes from the sensor', () => {
  const camera = new Camera({ random: () => 0.5, latencySeconds: 0, fovDegrees: 60 });
  const fov = camera.fov;
  assert.ok(Math.abs(fov.h - Math.PI / 3) < 1e-9);
  // 4:3 at 60 degrees across is about 46 up and down.
  assert.ok(Math.abs((fov.v * 180) / Math.PI - 46.8) < 1, `${(fov.v * 180) / Math.PI} deg`);
});

test('a routine reads the tags and can take a fix', () => {
  const { sim } = rig();
  const error = sim.autoRunner.compile(`
    function init(robot) { robot.frame = 'ftc'; }
    function loop(robot) {
      robot.telemetry.addData('count', robot.camera.count);
      robot.telemetry.addData('fitted', robot.camera.fitted);
      const tags = robot.camera.tags;
      if (tags.length) {
        robot.telemetry.addData('id', tags[0].id);
        robot.telemetry.addData('range', tags[0].range.toFixed(1));
        robot.telemetry.addData('age', tags[0].ageMs.toFixed(0));
        const pose = robot.camera.pose();
        robot.telemetry.addData('poseX', pose.x.toFixed(1));
        robot.telemetry.addData('took', robot.camera.fix());
      }
    }
  `);
  assert.equal(error, null);
  // Somewhere the tags are visible, and with the odometry deliberately wrong so
  // a fix has something to correct.
  sim.placeRobot(-0.3, -1.4, Math.PI / 2);
  sim.robot.odometry.pose.x += 0.3;
  for (let i = 0; i < 40; i++) sim.step(1 / 60);

  const t = sim.autoRunner.status().telemetry;
  assert.equal(t.fitted, 'true');
  assert.ok(Number(t.count) >= 4, `saw ${t.count}`);
  assert.ok(Number(t.range) > 20, `range ${t.range} in should be in inches`);
  assert.ok(Number(t.age) > 10, `age ${t.age} ms`);
  // Inches, and near the robot.
  assert.ok(Math.abs(Number(t.poseX) + 0.3 / 0.0254) < 6, `pose x ${t.poseX} in`);
  assert.equal(t.took, 'true');
  assert.ok(
    Math.abs(sim.robot.odometry.pose.x - sim.robot.body.position.x) < 0.08,
    'the fix pulled the odometry back onto the robot',
  );
});

test('reading the camera costs no loop time, and taking a fix costs one transaction', () => {
  const { sim } = rig();
  sim.autoRunner.compile(`
    function loop(robot) {
      const tags = robot.camera.tags;
      const again = robot.camera.tags;
      const pose = robot.camera.pose();
    }
  `);
  sim.placeRobot(-0.3, -1.4, Math.PI / 2);
  for (let i = 0; i < 30; i++) sim.step(1 / 60);
  assert.equal(sim.robot.bus.lastCounts.i2c, 0, 'vision is on its own thread');

  sim.autoRunner.compile('function loop(robot) { robot.camera.fix(); }');
  sim.placeRobot(-0.3, -1.4, Math.PI / 2);
  for (let i = 0; i < 30; i++) sim.step(1 / 60);
  assert.equal(sim.robot.bus.lastCounts.i2c, 1, 'but writing the Pinpoint is a transaction');
});

test('with no camera fitted the API says so', () => {
  const { sim } = rig({ 'camera.enabled': false });
  assert.equal(sim.robot.camera.enabled, false);
  const found = look(sim, -0.3, -1.4, Math.PI / 2);
  assert.equal(found.length, 0);
  assert.equal(sim.robot.camera.bestPose(0), null);
});
