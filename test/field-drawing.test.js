import test from 'node:test';
import assert from 'node:assert/strict';
import { Config } from '../src/config/Config.js';
import { Simulation } from '../src/app/Simulation.js';
import { DRAW_COLOURS, FieldDrawing, MAX_SHAPES, cssColour } from '../src/teleop/FieldDrawing.js';
import { INCH } from '../src/math/MathUtil.js';

function rig() {
  const config = new Config();
  config.set('ai.enabled', false);
  return new Simulation(config);
}

test('a cross is two lines, a circle is a ring of them', () => {
  const drawing = new FieldDrawing();
  drawing.point(1, 2);
  assert.equal(drawing.count, 2);
  drawing.clear();
  drawing.circle(0, 0, 0.5);
  assert.equal(drawing.count, 32);
  // Every segment is on the circle.
  for (const shape of drawing.shapes) {
    assert.ok(Math.abs(Math.hypot(shape.ax, shape.ay) - 0.5) < 1e-9);
  }
});

test('an arrow points where it was told', () => {
  const drawing = new FieldDrawing();
  drawing.pose(0, 0, Math.PI / 2, 'red', 1);
  const shaft = drawing.shapes[0];
  assert.ok(Math.abs(shaft.bx) < 1e-9);
  assert.ok(Math.abs(shaft.by - 1) < 1e-9);
  assert.equal(drawing.count, 3, 'a shaft and two barbs');
  assert.deepEqual(shaft.colour, DRAW_COLOURS.red);
});

test('colours come by name, by hex, or by triple, and a bad one falls back', () => {
  const drawing = new FieldDrawing();
  drawing.line(0, 0, 1, 0, 'green');
  drawing.line(0, 0, 1, 0, '#ff8000');
  drawing.line(0, 0, 1, 0, [0.5, 0.25, 0.125]);
  drawing.line(0, 0, 1, 0, 'chartreuse');
  const [named, hex, triple, unknown] = drawing.shapes.map((s) => s.colour);
  assert.deepEqual(named, DRAW_COLOURS.green);
  assert.ok(Math.abs(hex[0] - 1) < 1e-9 && Math.abs(hex[1] - 128 / 255) < 1e-9 && hex[2] === 0);
  assert.deepEqual(triple, [0.5, 0.25, 0.125]);
  assert.deepEqual(unknown, DRAW_COLOURS.cyan, 'rather than throwing mid-routine');
  assert.equal(cssColour([1, 0.5, 0], 0.5), 'rgba(255, 128, 0, 0.5)');
});

test('a NaN is dropped rather than drawn', () => {
  const drawing = new FieldDrawing();
  drawing.line(0, 0, Number.NaN, 1);
  drawing.point(Number.POSITIVE_INFINITY, 0);
  drawing.circle(0, 0, -1);
  drawing.pose(0, Number.NaN, 0);
  assert.equal(drawing.count, 0);
});

test('drawing without clearing drops the oldest rather than the newest', () => {
  const drawing = new FieldDrawing();
  for (let i = 0; i < MAX_SHAPES + 50; i++) drawing.line(i, 0, i, 1);
  assert.equal(drawing.count, MAX_SHAPES);
  assert.equal(drawing.dropped, 50);
  // What survives is the recent end, which is the useful one.
  assert.equal(drawing.shapes[drawing.count - 1].ax, MAX_SHAPES + 49);
});

test('a routine draws in its own frame', () => {
  const sim = rig();
  const error = sim.autoRunner.compile(`
    function init(robot) {
      robot.frame = 'ftc';
      robot.draw.point({ x: 24, y: -12 }, 'amber');
      robot.draw.circle([0, 0], 12, 'green');
      robot.draw.text({ x: 0, y: 0 }, 'centre');
    }
    function loop(robot) {}
  `);
  assert.equal(error, null);
  sim.enableGame({ alliance: 'red' }).start();
  for (let i = 0; i < 4; i++) sim.step(1 / 60);

  const shapes = sim.drawing.shapes;
  assert.ok(shapes.length > 30, `drew ${shapes.length} shapes`);
  // The cross came first, and 24 inches is 0.6096 m.
  assert.ok(Math.abs(shapes[0].ax - (24 * INCH - 0.06)) < 1e-9, `at ${shapes[0].ax} m`);
  assert.ok(Math.abs(shapes[0].ay - (-12 * INCH - 0.06)) < 1e-9);
  // The circle's radius went through the same conversion.
  const ring = shapes.filter((s) => s.kind === 'line' && Math.abs(Math.hypot(s.ax, s.ay) - 12 * INCH) < 1e-9);
  assert.equal(ring.length, 32, 'a 12 inch circle in metres');
  const labels = sim.drawing.labels;
  assert.equal(labels.length, 1);
  assert.equal(labels[0].text, 'centre');
});

test('an arrow drawn from a pose uses the frame’s heading convention', () => {
  const sim = rig();
  sim.autoRunner.compile(`
    function init(robot) { robot.frame = 'pedro'; }
    function loop(robot) {
      robot.draw.clear();
      // Pedro heading 0 is the simulator's +y.
      robot.draw.pose({ x: 72, y: 72, heading: 0 }, 'white');
    }
  `);
  sim.enableGame({ alliance: 'red' }).start();
  for (let i = 0; i < 4; i++) sim.step(1 / 60);
  const shaft = sim.drawing.shapes[0];
  assert.ok(Math.abs(shaft.ax) < 1e-9 && Math.abs(shaft.ay) < 1e-9, 'from the field centre');
  assert.ok(Math.abs(shaft.bx) < 1e-9, `pointing along +y, not +x: ${shaft.bx}`);
  assert.ok(shaft.by > 0.2);
});

test('clear is the routine’s to call, and a reset does it for them', () => {
  const sim = rig();
  sim.autoRunner.compile(`
    function loop(robot) {
      robot.draw.clear();
      robot.draw.point(robot.truth, 'cyan');
      robot.telemetry.addData('shapes', robot.draw.count);
    }
  `);
  sim.enableGame({ alliance: 'red' }).start();
  for (let i = 0; i < 20; i++) sim.step(1 / 60);
  // Cleared every cycle, so it never grows.
  assert.equal(sim.drawing.count, 2);
  assert.equal(Number(sim.autoRunner.status().telemetry.shapes), 2);

  sim.resetRobot();
  assert.equal(sim.drawing.count, 0, 'stale drawings look current, so they go');
});

test('drawing at compile time cannot mark a staged field', () => {
  const sim = rig();
  const error = sim.autoRunner.compile(`
    robot.draw.point({ x: 1, y: 1 }, 'red');
    function loop(robot) {}
  `);
  assert.equal(error, null, 'it still compiles');
  assert.equal(sim.drawing.count, 0, 'but nothing was drawn');
});

test('a polyline takes points written either way round', () => {
  const drawing = new FieldDrawing();
  drawing.path([[0, 0], [1, 0], [1, 1]]);
  assert.equal(drawing.count, 2);

  const sim = rig();
  sim.autoRunner.compile(`
    function loop(robot) {
      robot.draw.clear();
      robot.draw.path([{ x: 0, y: 0 }, [0.5, 0], { x: 0.5, y: 0.5 }], 'magenta');
    }
  `);
  sim.enableGame({ alliance: 'red' }).start();
  for (let i = 0; i < 4; i++) sim.step(1 / 60);
  assert.equal(sim.drawing.count, 2);
  assert.deepEqual(sim.drawing.shapes[0].colour, DRAW_COLOURS.magenta);
});
