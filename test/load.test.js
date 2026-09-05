import test from 'node:test';
import assert from 'node:assert/strict';
import { LoadModel, distributeLoad, GRAVITY } from '../src/physics/LoadDistribution.js';
import { Vec2 } from '../src/math/Vec2.js';

const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `expected ${a} within ${eps} of ${b}`);

const L = 0.36;
const T = 0.34;
const WHEELS = [
  new Vec2(L / 2, T / 2),
  new Vec2(L / 2, -T / 2),
  new Vec2(-L / 2, T / 2),
  new Vec2(-L / 2, -T / 2),
];
const MASS = 15;
const WEIGHT = MASS * GRAVITY;

const sum = (loads) => [...loads].reduce((a, b) => a + b, 0);

test('a centred CG at rest loads all four wheels equally', () => {
  const model = new LoadModel({ cgHeight: 0.2 });
  const loads = model.update(WHEELS, MASS, new Vec2(0, 0));
  for (const load of loads) near(load, WEIGHT / 4);
  near(sum(loads), WEIGHT);
});

test('a forward CG offset matches the textbook axle split', () => {
  for (const offset of [0, 0.03, -0.05, 0.08]) {
    const model = new LoadModel({ cgHeight: 0.2, cgOffset: new Vec2(offset, 0) });
    const loads = model.update(WHEELS, MASS, new Vec2(0, 0));
    const frontFraction = (loads[0] + loads[1]) / WEIGHT;
    // A CG `e` ahead of centre on wheelbase L puts 1/2 + e/L on the front axle.
    near(frontFraction, 0.5 + offset / L, 1e-6);
  }
});

test('weight transfer under acceleration matches m*a*h/L', () => {
  const h = 0.2;
  const model = new LoadModel({ cgHeight: h });
  for (const accel of [2, 5, 8]) {
    const loads = model.update(WHEELS, MASS, new Vec2(accel, 0));
    const frontFraction = (loads[0] + loads[1]) / WEIGHT;
    // Accelerating forward unloads the front by m*a*h/L newtons in total.
    near(frontFraction, 0.5 - (h * accel) / (GRAVITY * L), 1e-6);
    near(sum(loads), WEIGHT);
  }
});

test('lateral acceleration transfers load across the track', () => {
  const h = 0.2;
  const model = new LoadModel({ cgHeight: h });
  const loads = model.update(WHEELS, MASS, new Vec2(0, 4));
  // Accelerating to the left loads the right-hand wheels.
  assert.ok(loads[1] > loads[0], 'right wheels should carry more');
  near(loads[0], loads[2], 1e-9);
  near(loads[1], loads[3], 1e-9);
  near(sum(loads), WEIGHT);
});

test('a wheel that lifts reports zero load, never negative', () => {
  const model = new LoadModel({ cgHeight: 0.25 });
  const loads = model.update(WHEELS, MASS, new Vec2(0, 20));
  for (const load of loads) assert.ok(load >= 0, `negative load ${load}`);
  assert.ok([...loads].some((l) => l === 0), 'a corner should have lifted');
  near(sum(loads), WEIGHT, 1e-6);
});

test('total load is conserved for any acceleration', () => {
  const model = new LoadModel({ cgHeight: 0.18 });
  for (let ax = -12; ax <= 12; ax += 3) {
    for (let ay = -12; ay <= 12; ay += 3) {
      near(sum(model.update(WHEELS, MASS, new Vec2(ax, ay))), WEIGHT, 1e-6);
    }
  }
});

test('transferFactor 0 disables weight transfer entirely', () => {
  const model = new LoadModel({ cgHeight: 0.2, transferFactor: 0 });
  const loads = model.update(WHEELS, MASS, new Vec2(8, 3));
  for (const load of loads) near(load, WEIGHT / 4);
});

test('a lower CG transfers less weight', () => {
  const low = new LoadModel({ cgHeight: 0.08 }).update(WHEELS, MASS, new Vec2(6, 0));
  const high = new LoadModel({ cgHeight: 0.3 }).update(WHEELS, MASS, new Vec2(6, 0));
  const lowSpread = Math.max(...low) - Math.min(...low);
  const highSpread = Math.max(...high) - Math.min(...high);
  assert.ok(highSpread > lowSpread * 2, 'a tall robot must transfer far more weight');
});

test('six wheels are handled without special-casing', () => {
  const six = [
    new Vec2(L / 2, T / 2), new Vec2(L / 2, -T / 2),
    new Vec2(0, T / 2), new Vec2(0, -T / 2),
    new Vec2(-L / 2, T / 2), new Vec2(-L / 2, -T / 2),
  ];
  const loads = new LoadModel({ cgHeight: 0.15 }).update(six, MASS, new Vec2(0, 0));
  near(sum(loads), WEIGHT);
  assert.equal(loads.length, 6);
});

test('degenerate layouts fall back to an even split rather than NaN', () => {
  const collinear = [new Vec2(0, 0.1), new Vec2(0, -0.1)];
  const loads = distributeLoad(collinear, 100, new Float64Array(2));
  for (const load of loads) assert.ok(Number.isFinite(load));
  near(sum(loads), 100, 1e-6);
});

test('load imbalance reports evenness', () => {
  near(LoadModel.loadImbalance(new Float64Array([25, 25, 25, 25])), 0.25, 1e-12);
  near(LoadModel.loadImbalance(new Float64Array([100, 0, 0, 0])), 1, 1e-12);
});
