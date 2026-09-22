import test from 'node:test';
import assert from 'node:assert/strict';
import { Config } from '../src/config/Config.js';
import { Simulation } from '../src/app/Simulation.js';
import {
  FIELD_FRAMES,
  FIELD_SPAN_INCHES,
  fromFrame,
  pedroFromFtc,
  toFrame,
  wrapDegrees,
} from '../src/math/fieldFrames.js';
import { DEG, INCH } from '../src/math/MathUtil.js';

function rig() {
  const config = new Config();
  config.set('ai.enabled', false);
  return new Simulation(config);
}

const CLOSE = (a, b, tol = 1e-9) => Math.abs(a - b) < tol;

test('every frame round-trips a pose exactly', () => {
  const poses = [
    { x: 0, y: 0, heading: 0 },
    { x: 1.234, y: -0.567, heading: 2.1 },
    { x: -1.79, y: 1.1, heading: -1.9 },
  ];
  for (const frame of FIELD_FRAMES) {
    for (const pose of poses) {
      const back = fromFrame(toFrame(pose, frame), frame);
      assert.ok(CLOSE(back.x, pose.x, 1e-12), `${frame} x: ${back.x} vs ${pose.x}`);
      assert.ok(CLOSE(back.y, pose.y, 1e-12), `${frame} y`);
      assert.ok(CLOSE(back.heading, pose.heading, 1e-12), `${frame} heading`);
    }
  }
});

test('the FTC frame is the simulator frame in inches and degrees', () => {
  const ftc = toFrame({ x: 1, y: -0.5, heading: Math.PI / 2 }, 'ftc');
  assert.ok(CLOSE(ftc.x, 1 / INCH, 1e-9));
  assert.ok(CLOSE(ftc.y, -0.5 / INCH, 1e-9));
  assert.ok(CLOSE(ftc.heading, 90, 1e-9));
});

test('Pedro puts the whole field in the positive quadrant', () => {
  // The four corners of the tile field, plus the centre.
  const half = 70.1 * INCH;
  for (const x of [-half, half]) {
    for (const y of [-half, half]) {
      const pedro = toFrame({ x, y, heading: 0 }, 'pedro');
      assert.ok(pedro.x > 0 && pedro.x < FIELD_SPAN_INCHES, `x ${pedro.x}`);
      assert.ok(pedro.y > 0 && pedro.y < FIELD_SPAN_INCHES, `y ${pedro.y}`);
    }
  }
  const centre = toFrame({ x: 0, y: 0, heading: 0 }, 'pedro');
  assert.deepEqual([centre.x, centre.y], [72, 72], 'and the centre is the middle of it');
});

test('Pedro is the documented transform of the FTC frame', () => {
  // pedro_x = ftc_y + 72, pedro_y = 72 - ftc_x, ftc_heading = pedro_heading + 90.
  const sim = { x: 0.9, y: -1.3, heading: 0.4 };
  const ftc = toFrame(sim, 'ftc');
  const viaFtc = pedroFromFtc(ftc);
  const direct = toFrame(sim, 'pedro');
  assert.ok(CLOSE(direct.x, viaFtc.x, 1e-9));
  assert.ok(CLOSE(direct.y, viaFtc.y, 1e-9));
  assert.ok(CLOSE(direct.heading, wrapDegrees(viaFtc.heading), 1e-9));
  assert.ok(CLOSE(direct.heading, ftc.heading - 90, 1e-9), 'and the 90 degrees is there');
});

test('headings come back wrapped, and the red wall reads 180 rather than -180', () => {
  assert.equal(toFrame({ x: 0, y: 0, heading: Math.PI }, 'ftc').heading, 180);
  assert.equal(toFrame({ x: 0, y: 0, heading: -Math.PI }, 'ftc').heading, 180);
  assert.ok(CLOSE(toFrame({ x: 0, y: 0, heading: 3 * Math.PI / 2 }, 'ftc').heading, -90, 1e-9));
});

test('an unknown frame is refused rather than silently treated as metres', () => {
  const sim = rig();
  sim.autoRunner.compile(
    'function init(robot) { robot.frame = "roadrunner"; }\nfunction loop(robot) {}',
  );
  sim.enableGame({ alliance: 'red' }).start();
  for (let i = 0; i < 10; i++) sim.step(1 / 60);
  const status = sim.autoRunner.status();
  assert.equal(status.state, 'error');
  assert.match(status.error, /robot\.frame must be one of/);
});

test('a routine in FTC coordinates reads inches and degrees', () => {
  const sim = rig();
  const error = sim.autoRunner.compile(`
    function init(robot) { robot.frame = 'ftc'; }
    function loop(robot) {
      const t = robot.truth;
      robot.telemetry.addData('x', t.x.toFixed(2));
      robot.telemetry.addData('y', t.y.toFixed(2));
      robot.telemetry.addData('heading', t.heading.toFixed(1));
      robot.telemetry.addData('frame', robot.frame);
      robot.telemetry.addData('cellX', robot.cellTarget.x.toFixed(1));
      robot.telemetry.addData('toCell', robot.distanceTo(robot.cellTarget).toFixed(1));
    }
  `);
  assert.equal(error, null);
  sim.enableGame({ alliance: 'red' }).start();
  sim.placeRobot(-48, 12, 0, 'ftc');
  for (let i = 0; i < 4; i++) sim.step(1 / 60);

  const t = sim.autoRunner.status().telemetry;
  assert.equal(t.frame, 'ftc');
  assert.ok(Math.abs(Number(t.x) + 48) < 1, `x read ${t.x}`);
  assert.ok(Math.abs(Number(t.y) - 12) < 1, `y read ${t.y}`);
  assert.ok(Math.abs(Number(t.heading)) < 1, `heading read ${t.heading}`);
  // The CELL is a long way off in inches, which is the point of the units.
  assert.ok(Number(t.toCell) > 20, `distance read ${t.toCell} in`);
});

test('a point handed in is read in the routine’s frame, both ways', () => {
  const sim = rig();
  sim.autoRunner.compile(`
    function init(robot) { robot.frame = 'pedro'; }
    function loop(robot) {
      // The field centre, in Pedro coordinates.
      robot.telemetry.addData('toCentre', robot.distanceTo({ x: 72, y: 72 }).toFixed(2));
      robot.telemetry.addData('bearing', robot.bearingTo({ x: 72, y: 72 }).toFixed(1));
      const back = robot.frames.from({ x: 72, y: 72, heading: 0 });
      robot.telemetry.addData('backX', back.x.toFixed(3));
      robot.telemetry.addData('backY', back.y.toFixed(3));
    }
  `);
  sim.enableGame({ alliance: 'red' }).start();
  // A metre out along +x, facing the centre.
  sim.placeRobot(-1, 0, 0);
  for (let i = 0; i < 4; i++) sim.step(1 / 60);

  const t = sim.autoRunner.status().telemetry;
  assert.ok(Math.abs(Number(t.toCentre) - 1 / INCH) < 1, `${t.toCentre} in from the centre`);
  // Facing +x in the simulator is -90 in Pedro, and the centre is straight ahead.
  assert.ok(Math.abs(Number(t.bearing) + 90) < 1, `bearing read ${t.bearing}`);
  assert.ok(Math.abs(Number(t.backX)) < 1e-6, 'and Pedro (72, 72) is the field centre');
  assert.ok(Math.abs(Number(t.backY)) < 1e-6);
});

test('ticksPerUnit follows the frame', () => {
  const sim = rig();
  sim.autoRunner.compile(`
    function loop(robot) {
      robot.frame = 'sim';
      robot.telemetry.addData('perMetre', robot.ticksPerUnit.toFixed(2));
      robot.frame = 'ftc';
      robot.telemetry.addData('perInch', robot.ticksPerUnit.toFixed(2));
    }
  `);
  sim.enableGame({ alliance: 'red' }).start();
  for (let i = 0; i < 4; i++) sim.step(1 / 60);
  const t = sim.autoRunner.status().telemetry;
  assert.ok(
    Math.abs(Number(t.perMetre) * INCH - Number(t.perInch)) < 0.01,
    `${t.perMetre} per metre vs ${t.perInch} per inch`,
  );
});

test('placing the robot moves it without resetting anything else', () => {
  const sim = rig();
  const game = sim.enableGame({ alliance: 'red' }).start();
  sim.input.keyboardSource.active = true;
  sim.input.keyboardSource.keys.add('KeyW');
  // Short, because the HIVE's A-frame is straight ahead of the start pose and
  // a robot that has already run into it is not moving any more.
  for (let i = 0; i < 20; i++) sim.step(1 / 60);
  sim.input.keyboardSource.keys.delete('KeyW');

  const held = game.intake.count;
  const charge = sim.robot.battery.stateOfCharge;
  const epoch = sim.robot.teleportEpoch;
  assert.ok(sim.robot.body.speed > 0.05, `it was moving, at ${sim.robot.body.speed}`);

  sim.placeRobot(0.5, -1, Math.PI / 2);
  assert.ok(CLOSE(sim.robot.body.position.x, 0.5, 1e-9));
  assert.ok(CLOSE(sim.robot.body.position.y, -1, 1e-9));
  assert.ok(CLOSE(sim.robot.body.rotation.radians, Math.PI / 2, 1e-9));
  assert.equal(sim.robot.body.speed, 0, 'a teleport has no velocity that means anything');
  assert.equal(sim.robot.teleportEpoch, epoch + 1, 'and it says so');
  assert.equal(game.intake.count, held, 'the intake kept its load');
  assert.equal(sim.robot.battery.stateOfCharge, charge, 'and the battery was not recharged');
});

test('placing in a frame, and reading the pose back in one', () => {
  const sim = rig();
  sim.placeRobot(12, -63, 90, 'ftc');
  const pose = sim.pose('ftc');
  assert.ok(CLOSE(pose.x, 12, 1e-9));
  assert.ok(CLOSE(pose.y, -63, 1e-9));
  assert.ok(CLOSE(pose.heading, 90, 1e-9));
  // The same place, in the other two.
  assert.ok(CLOSE(sim.pose().x, 12 * INCH, 1e-9));
  assert.ok(CLOSE(sim.pose().heading, 90 * DEG, 1e-9));
  const pedro = sim.pose('pedro');
  assert.ok(CLOSE(pedro.x, 9, 1e-9), `pedro x ${pedro.x}`);
  assert.ok(CLOSE(pedro.y, 60, 1e-9), `pedro y ${pedro.y}`);
  assert.ok(CLOSE(pedro.heading, 0, 1e-9), `pedro heading ${pedro.heading}`);
});

test('placing keeps the heading when none is given, and does not move the start pose', () => {
  const sim = rig();
  sim.setStartPose(-1.5, 0, 0.3);
  sim.resetRobot();
  sim.placeRobot(1, 1);
  assert.ok(CLOSE(sim.robot.body.rotation.radians, 0.3, 1e-9), 'heading left alone');
  sim.resetRobot();
  assert.ok(CLOSE(sim.robot.body.position.x, -1.5, 1e-9), 'and a reset still goes home');
});

test('a start pose can be given in a frame', () => {
  const sim = rig();
  sim.setStartPose(9, 60, 0, 'pedro');
  sim.resetRobot();
  const ftc = sim.pose('ftc');
  assert.ok(CLOSE(ftc.x, 12, 1e-9), `x ${ftc.x}`);
  assert.ok(CLOSE(ftc.y, -63, 1e-9), `y ${ftc.y}`);
  assert.ok(CLOSE(ftc.heading, 90, 1e-9), `heading ${ftc.heading}`);
});
