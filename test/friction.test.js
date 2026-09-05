import test from 'node:test';
import assert from 'node:assert/strict';
import {
  axialSlipForce,
  axialStiffness,
  combinedSlipForce,
  compileFriction,
  defaultFrictionSettings,
  effectiveSlipReference,
  frictionShape,
} from '../src/physics/friction.js';

const near = (a, b, eps) => assert.ok(Math.abs(a - b) < eps, `expected ${a} within ${eps} of ${b}`);

test('Pacejka peaks exactly at the configured slip', () => {
  const f = compileFriction(defaultFrictionSettings());
  let best = 0;
  let bestX = 0;
  for (let x = 0; x <= 10; x += 0.0005) {
    const v = frictionShape(x, f);
    if (v > best) {
      best = v;
      bestX = x;
    }
  }
  near(best, 1, 1e-3);
  // Normalised slip 1.0 is by definition `slipAtPeakGrip`.
  near(bestX, 1, 2e-3);
});

test('Pacejka settles to the configured kinetic ratio', () => {
  for (const ratio of [0.6, 0.75, 0.9]) {
    const f = compileFriction({ ...defaultFrictionSettings(), kineticRatio: ratio });
    // The plateau is asymptotic, so check it is approaching from above.
    const far = frictionShape(500, f);
    near(far, ratio, 0.02);
    assert.ok(frictionShape(1, f) > far, 'peak grip must exceed sliding grip');
  }
});

test('smooth models saturate at 1 and never exceed it', () => {
  for (const model of ['tanh', 'linear']) {
    const f = compileFriction({ ...defaultFrictionSettings(), model });
    assert.ok(frictionShape(50, f) <= 1.0000001);
    near(frictionShape(50, f), 1, 1e-3);
    near(frictionShape(0, f), 0, 1e-9);
  }
});

test('friction always opposes slip', () => {
  const f = compileFriction(defaultFrictionSettings());
  for (const slip of [-3, -0.4, -0.01, 0.01, 0.4, 3]) {
    const force = axialSlipForce(slip, 30, 1.0, f, 0);
    assert.ok(Math.sign(force) === -Math.sign(slip), `slip ${slip} gave force ${force}`);
  }
  near(axialSlipForce(0, 30, 1, f, 0), 0, 1e-12);
});

test('no normal force means no friction', () => {
  const f = compileFriction(defaultFrictionSettings());
  near(axialSlipForce(1, 0, 1, f, 0), 0, 1e-12);
  const combined = combinedSlipForce(1, 1, 0, f, 0);
  near(combined.x, 0, 1e-12);
  near(combined.y, 0, 1e-12);
});

test('combined slip stays inside the friction ellipse', () => {
  const f = compileFriction(defaultFrictionSettings());
  const N = 40;
  const maxLong = f.muLongitudinal * N;
  const maxLat = f.muLateral * N;
  for (let angle = 0; angle < Math.PI * 2; angle += 0.05) {
    for (const magnitude of [0.05, 0.2, 1, 5, 40]) {
      const force = combinedSlipForce(
        Math.cos(angle) * magnitude,
        Math.sin(angle) * magnitude,
        N,
        f,
        0,
      );
      const ellipse = (force.x / maxLong) ** 2 + (force.y / maxLat) ** 2;
      // Pacejka overshoots 1 slightly at the peak; allow for that but no more.
      assert.ok(ellipse <= 1.0001, `escaped the friction ellipse: ${ellipse}`);
    }
  }
});

test('combining longitudinal and lateral slip robs each of grip', () => {
  const f = compileFriction(defaultFrictionSettings());
  const N = 40;
  const pureLong = combinedSlipForce(5, 0, N, f, 0).x;
  const bothWays = combinedSlipForce(5, 5, N, f, 0).x;
  assert.ok(
    Math.abs(bothWays) < Math.abs(pureLong) * 0.8,
    'a wheel already sliding sideways must have less forward grip',
  );
});

test('slip reference scales with rolling speed above the floor', () => {
  const f = compileFriction(defaultFrictionSettings());
  near(effectiveSlipReference(f, 0), f.slipAtPeakGrip, 1e-12);
  // At 5 m/s, 12% slip ratio dominates the 0.15 m/s floor.
  near(effectiveSlipReference(f, 5), 0.6, 1e-9);
});

test('stiffness is positive on the rising branch and zero past the peak', () => {
  const f = compileFriction(defaultFrictionSettings());
  const rising = axialStiffness(0.02, 40, 1, f, 0);
  assert.ok(rising > 0, 'contact must be stiff below the peak');
  // Well past the peak the curve is falling, which is a real instability and
  // must not be damped away by the implicit step.
  near(axialStiffness(4, 40, 1, f, 0), 0, 1e-9);
});

test('compileFriction is deterministic and cached', () => {
  const a = compileFriction(defaultFrictionSettings());
  const b = compileFriction(defaultFrictionSettings());
  assert.equal(a._B, b._B);
  assert.equal(a._C, b._C);
});
