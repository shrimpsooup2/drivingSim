import test from 'node:test';
import assert from 'node:assert/strict';
import { BallWorld } from '../src/physics/BallWorld.js';
import { Ball } from '../src/physics/Ball.js';
import { RigidBody2d } from '../src/physics/RigidBody2d.js';
import {
  ELEMENT_RESTITUTION,
  NECTAR_MASS,
  NECTAR_RADIUS,
  POLLEN_MASS,
  POLLEN_RADIUS,
  SETTLE_SPEED,
  TILE_RESTITUTION,
} from '../src/field/biobuzz/constants.js';

const SIZE = 3.6;
const HALF = SIZE / 2;
const ROBOT = { halfLength: 0.216, halfWidth: 0.203, height: 0.35 };

function world() {
  return new BallWorld({ fieldSize: SIZE, wallHeight: 0.3 });
}

function pollen(id = 'p1') {
  return new Ball({ id, kind: 'pollen', radius: POLLEN_RADIUS, mass: POLLEN_MASS });
}

function pusher(x, y, heading = 0) {
  const body = new RigidBody2d({ mass: 15, inertia: 0.6 });
  body.reset(x, y, heading);
  return body;
}

/** Drive a body at a constant velocity, stepping the world with it. */
function drive(w, bodies, seconds, step = 1 / 2000) {
  let peak = 0;
  const ball = w.balls[0];
  for (let t = 0; t < seconds; t += step) {
    for (const { body, vx, vy, omega, limit } of bodies) {
      body.velocity.set(vx, vy ?? 0);
      body.angularVelocity = omega ?? 0;
      body.position.x += step * vx;
      body.position.y += step * (vy ?? 0);
      if (limit) {
        body.position.x = Math.max(-limit, Math.min(limit, body.position.x));
        body.position.y = Math.max(-limit, Math.min(limit, body.position.y));
      }
      body.rotation.setRadians(body.rotation.radians + step * (omega ?? 0));
    }
    w.step(step);
    if (ball.speed > peak) peak = ball.speed;
  }
  return peak;
}

test('a POLLEN pinched against the wall is not launched', () => {
  // This used to reach 1e302 m/s in three seconds. Two separate faults: the
  // deep-contact normal was built by dividing a sign by a 1e-9 stand-in
  // distance, giving a normal a billion long, and the "carry the ball along"
  // term added a fraction of the closing speed on every substep with no bound.
  const w = world();
  const ball = pollen();
  ball.setPosition(HALF - ball.radius - 0.001, 0, ball.radius);
  w.add(ball);

  const body = pusher(HALF - ROBOT.halfLength - 0.3, 0);
  w.addBody(body, ROBOT.halfLength, ROBOT.halfWidth, ROBOT.height);

  const peak = drive(w, [{ body, vx: 1, limit: HALF - ROBOT.halfLength }], 3);

  // A plate cannot make a ball travel faster than the plate, plus what one
  // bounce off the wall gives back. A 1 m/s push has no business exceeding 2.
  assert.ok(peak < 2, `pinched POLLEN reached ${peak.toFixed(2)} m/s from a 1 m/s push`);
  assert.equal(w.speedCapHits, 0, 'and the divergence backstop never had to fire');
  // And it is still on the FIELD, not outside the perimeter.
  assert.ok(Math.abs(ball.x) <= HALF - ball.radius + 1e-9, `ball escaped to x=${ball.x}`);
  assert.ok(ball.isFinite());
});

test('a POLLEN pinched between two ROBOTS is not launched either', () => {
  const w = world();
  const ball = pollen();
  ball.setPosition(0, 0, ball.radius);
  w.add(ball);

  const left = pusher(-ROBOT.halfLength - ball.radius - 0.25, 0);
  const right = pusher(ROBOT.halfLength + ball.radius + 0.25, 0);
  w.addBody(left, ROBOT.halfLength, ROBOT.halfWidth, ROBOT.height);
  w.addBody(right, ROBOT.halfLength, ROBOT.halfWidth, ROBOT.height);

  const peak = drive(
    w,
    [
      { body: left, vx: 1.2, limit: 0.2 },
      { body: right, vx: -1.2, limit: 0.2 },
    ],
    3,
  );
  assert.ok(peak < 3, `squeezed POLLEN reached ${peak.toFixed(2)} m/s`);
  assert.equal(w.speedCapHits, 0);
  assert.ok(ball.isFinite());
});

test('a POLLEN driven over is pushed clear, not teleported', () => {
  // The centre inside the box is the degenerate case: the ball has been run
  // over rather than bumped. It should come out from under the nearest face.
  const w = world();
  const ball = pollen();
  w.add(ball);
  const body = pusher(0, 0);
  w.addBody(body, ROBOT.halfLength, ROBOT.halfWidth, ROBOT.height);

  // Right under the middle of the robot, which has no shortest-face answer
  // until the sign breaks the tie.
  ball.setPosition(0.02, 0, ball.radius);
  ball.setVelocity(0, 0, 0);
  w.step(1 / 2000);

  assert.ok(ball.isFinite());
  assert.ok(Math.abs(ball.x) < 1, `pushed to x=${ball.x}, should be just clear of the robot`);
  // Out from under it: no longer overlapping the box footprint.
  const outside =
    Math.abs(ball.x) > ROBOT.halfLength || Math.abs(ball.y) > ROBOT.halfWidth;
  assert.ok(outside, `still under the robot at (${ball.x.toFixed(3)}, ${ball.y.toFixed(3)})`);
  assert.ok(ball.speed < 2, `and not flung: ${ball.speed.toFixed(2)} m/s`);
});

test('a spinning ROBOT still flicks a POLLEN, but only as fast as its surface', () => {
  // The flick is wanted -- it is how a real robot clears a pile -- so the fix
  // for pinching must not have removed it.
  const w = world();
  const ball = pollen();
  ball.setPosition(0.3, 0, ball.radius);
  w.add(ball);
  const body = pusher(0, 0);
  w.addBody(body, ROBOT.halfLength, ROBOT.halfWidth, ROBOT.height);

  const omega = 6;
  const peak = drive(w, [{ body, vx: 0, vy: 0, omega }], 0.6);
  assert.ok(peak > 0.2, `a robot spinning at ${omega} rad/s should move it, got ${peak.toFixed(2)}`);

  // Surface speed at the corner is the physical bound on what a spin can
  // impart, plus restitution.
  const corner = Math.hypot(ROBOT.halfLength, ROBOT.halfWidth);
  assert.ok(
    peak < omega * corner * 1.6,
    `flick reached ${peak.toFixed(2)} m/s, past the ${(omega * corner).toFixed(2)} m/s surface`,
  );
});

test('a POLLEN in a corner with a ROBOT on it stays finite and in bounds', () => {
  const w = world();
  const ball = pollen();
  ball.setPosition(HALF - ball.radius, HALF - ball.radius, ball.radius);
  w.add(ball);
  const body = pusher(HALF - ROBOT.halfLength - 0.4, HALF - ROBOT.halfWidth - 0.4, 0.6);
  w.addBody(body, ROBOT.halfLength, ROBOT.halfWidth, ROBOT.height);

  const peak = drive(
    w,
    [{ body, vx: 1, vy: 1, omega: 2, limit: HALF - ROBOT.halfLength }],
    3,
  );
  assert.ok(peak < 4, `corner-trapped POLLEN reached ${peak.toFixed(2)} m/s`);
  assert.ok(ball.isFinite());
  assert.ok(Math.abs(ball.x) <= HALF - ball.radius + 1e-9);
  assert.ok(Math.abs(ball.y) <= HALF - ball.radius + 1e-9);
});

test('momentum survives a collision between two elements', () => {
  // The pinch guard holds each ball to what it was doing at the start of the
  // step unless a contact raises the ceiling, and a *struck* ball was doing
  // nothing at all. Before the pair solver raised its own ceiling, every bit
  // of momentum handed over was scaled straight back out: a POLLEN fired into
  // a stationary one stopped dead and the target never moved.
  // In mid-air and head-on, so the only thing acting is the pair solver.
  // Rolling on the tiles the answer is muddier and for good reason: a ball
  // with topspin drives itself forward off the floor after the hit, and a
  // spinning contact converts some translation into spin and into the ground.
  // Those are real, and they are not what this is checking.
  const w = world();
  const cue = pollen('cue');
  const target = pollen('target');
  cue.setPosition(-0.25, 0, 1);
  cue.setVelocity(2.5, 0, 0);
  target.setPosition(0, 0, 1);
  w.add(cue);
  w.add(target);

  // Total momentum across the one step the contact happens on.
  const total = () => cue.mass * cue.vx + target.mass * target.vx;
  let before = total();
  let after = before;
  let peak = 0;
  for (let i = 0; i < 400; i++) {
    const wasStill = target.groundSpeed < 1e-9;
    const priorTotal = total();
    w.step(1 / 2000);
    if (wasStill && target.groundSpeed > 1e-6) {
      before = priorTotal;
      after = total();
    }
    peak = Math.max(peak, target.groundSpeed);
  }

  assert.ok(peak > 1, `the target barely moved: ${peak.toFixed(2)} m/s`);
  // Equal masses, head-on: whatever one loses the other gains.
  assert.ok(
    Math.abs(after - before) < before * 0.02,
    `momentum jumped from ${before.toFixed(4)} to ${after.toFixed(4)} kg m/s across the contact`,
  );
  assert.equal(w.speedCapHits, 0);
});

test('a launched POLLEN loses speed to drag and nothing else', () => {
  // The divergence backstop must not clip a legitimate shot. The fastest
  // shooter modelled here is 4500 rpm on a 2 in wheel at 0.62 transfer, which
  // is 14.8 m/s at the muzzle.
  const w = world();
  const ball = pollen();
  ball.setPosition(0, 0, 0.3);
  ball.setVelocity(10, 0, 8);
  w.add(ball);
  assert.ok(w.maxSpeed > 14.8, 'the cap has to sit above the fastest shooter');

  const dt = 1 / 2000;
  w.step(dt);
  assert.equal(w.speedCapHits, 0, 'nothing clipped it');

  // Drag only, and in the right amount: F = 0.5 * rho * Cd * A * v^2, opposing
  // motion, so the loss is shared between the components in proportion.
  // Gravity goes in first, so the speed the drag sees already has that step.
  const vz = 8 - 9.80665 * dt;
  const speed = Math.hypot(10, vz);
  const force = 0.5 * w.airDensity * ball.dragCoefficient * ball.area * speed * speed;
  const loss = ((force / ball.mass) * dt) / speed;
  assert.ok(
    Math.abs(ball.vx - 10 * (1 - loss)) < 1e-9,
    `vx ${ball.vx} should be 10 less its share of the drag`,
  );
  assert.ok(Math.abs(ball.vz - vz * (1 - loss)) < 1e-9);
  assert.ok(loss * speed > 0.002, 'and the drag is a real amount, not a rounding error');
});

test('drag costs a real fraction of the range of a shot', () => {
  // A 45 g POLLEN is 71 mm across and perforated, so it has a lot of frontal
  // area for its mass: at 6 m/s the drag on one is a ninth of its weight, and
  // it acts for the whole flight. Leaving it out is not a rounding error, it is
  // a different aim point.
  //
  // Measured to the *first* landing. Carrying on until it stops bouncing would
  // be measuring the bounces, which drag barely touches.
  const range = (drag) => {
    // A deliberately huge FIELD: a 6 m/s shot flies further than a real one is
    // wide, and the first version of this test measured a ball that had already
    // bounced off the far wall and was coming back.
    const w = new BallWorld({ fieldSize: 60, wallHeight: 0.3 });
    const ball = pollen();
    ball.dragCoefficient = drag;
    ball.setPosition(-1.5, 0, 0.3);
    ball.setVelocity(6, 0, 5);
    w.add(ball);
    const start = ball.x;
    for (let i = 0; i < 8000; i++) {
      const rising = ball.vz > 0;
      w.step(1 / 2000);
      if (!rising && ball.z <= ball.radius + 1e-9) break;
    }
    return ball.x - start;
  };
  const vacuum = range(0);
  const real = range(0.6);
  const lost = 1 - real / vacuum;
  assert.ok(
    lost > 0.08 && lost < 0.4,
    `drag cost ${(lost * 100).toFixed(0)} percent of the range (${real.toFixed(2)} m vs ${vacuum.toFixed(2)} m in vacuum)`,
  );
});

test('the two elements are drag-matched, so drag is not what separates them', () => {
  // This test used to assert the opposite, on estimated masses of 45 g and
  // 85 g: a NECTAR was heavier for its frontal area and so about a tenth less
  // affected. At the real masses that difference disappears.
  //
  // The ballistic coefficient is area over mass. A POLLEN is 1.4 in at 24.9 g
  // and a NECTAR is 1.81 in at 41.3 g, and (1.81/1.4)^2 = 1.67 against a mass
  // ratio of 1.66 -- so the two come out within one percent of each other.
  // Whether that is deliberate on AndyMark's part or a coincidence of moulding
  // two sizes in the same wall thickness, it is worth knowing: you do not
  // re-aim between element types because of the air.
  const decel = (radius, mass) => {
    const w = world();
    const ball = new Ball({ id: 'x', kind: 'pollen', radius, mass });
    ball.setPosition(0, 0, 1);
    ball.setVelocity(6, 0, 0);
    w.add(ball);
    const before = ball.vx;
    w.step(1 / 2000);
    return (before - ball.vx) * 2000;
  };
  const pollenDecel = decel(POLLEN_RADIUS, POLLEN_MASS);
  const nectarDecel = decel(NECTAR_RADIUS, NECTAR_MASS);

  // At 6 m/s: 0.5 * 1.204 * 0.6 * pi * 0.0356^2 * 36 / 0.0249 = 2.07 m/s^2,
  // which is a fifth of gravity and acts for the whole flight. It was 1.15
  // when POLLEN was thought to weigh 45 g -- drag deceleration goes as 1/m, so
  // halving the mass doubles it, and a lighter ball is pushed about by the air
  // *more*, not less.
  assert.ok(
    pollenDecel > 1.9 && pollenDecel < 2.25,
    `POLLEN decelerates at ${pollenDecel.toFixed(2)} m/s^2, expected about 2.07`,
  );

  const ratio = nectarDecel / pollenDecel;
  assert.ok(
    ratio > 0.97 && ratio < 1.03,
    `the two should be within a few percent, got ${(ratio * 100).toFixed(1)} percent`,
  );

  // What *does* separate them is the flywheel, and that belongs to the
  // launcher rather than the air: droop goes as the ball's inertia against the
  // wheel's, so a NECTAR leaves slower at the same RPM. Asserted in
  // `biobuzz-robot.test.js`; named here so the pair is findable.
});

test('a ball that lands skidding scrubs into a roll', () => {
  // This is what "falling and scattering" mostly looks like. Without friction
  // at the contact the ball landed and *slid*, keeping its whole horizontal
  // speed and never picking up any spin.
  //
  // Sampled shortly after it settles. Left for three seconds, rolling
  // resistance brings it to a complete stop and the answer is zero either way.
  const w = world();
  const ball = pollen();
  ball.setPosition(-1, 0, 0.5);
  ball.setVelocity(3, 0, -1);
  w.add(ball);

  let settled = 0;
  for (let i = 0; i < 2000 * 2; i++) {
    w.step(1 / 2000);
    if (ball.onFloor && ++settled > 100) break;
  }
  assert.ok(ball.onFloor, 'it settled onto the tiles');
  assert.ok(ball.spinRate > 10, `it should be spinning, got ${ball.spinRate.toFixed(2)} rad/s`);

  // Rolling without slipping means the contact point is stationary. Solving
  // `v + w x c = 0` at a contact one radius below the centre gives
  // `w_y = v_x / r`, so that is what a ball rolling in +x should be doing.
  const rolling = ball.vx / ball.radius;
  assert.ok(
    Math.abs(ball.wy - rolling) < Math.abs(rolling) * 0.1 + 1,
    `spin ${ball.wy.toFixed(2)} should be near the rolling rate ${rolling.toFixed(2)}`,
  );
  assert.ok(ball.vx > 0.4, 'and it kept rolling forward rather than stopping dead');
  assert.ok(ball.vx < 2.6, `but lost speed to the scrub: ${ball.vx.toFixed(2)} of 3 m/s`);
});

test('a dropped ball does not pick up spin out of nowhere', () => {
  const w = world();
  const ball = pollen();
  ball.setPosition(0, 0, 0.6);
  w.add(ball);
  for (let i = 0; i < 2000 * 2; i++) w.step(1 / 2000);
  assert.ok(ball.onFloor);
  assert.ok(ball.spinRate < 1e-6, `dropped straight down it should not spin, got ${ball.spinRate}`);
  assert.ok(ball.groundSpeed < 1e-6, 'nor wander');
});

test('a pile of POLLEN scatters rather than sliding past itself', () => {
  // Frictionless contacts pushed balls apart along clean lines of centres and
  // nothing tumbled. With friction they grip, spin each other up and spread.
  const w = world();
  const balls = [];
  // A hex pack: one in the middle and six just touching it. Laid out on a
  // circle any tighter than 2r they start overlapping, and the first step
  // blows the heap apart on the overlap correction before the cue arrives --
  // which is what the earlier version of this test was measuring.
  const pitch = 2 * POLLEN_RADIUS;
  const middle = pollen('p0');
  middle.setPosition(0, 0, middle.radius);
  w.add(middle);
  balls.push(middle);
  for (let i = 0; i < 6; i++) {
    const ball = pollen(`p${i + 1}`);
    const angle = (i / 6) * Math.PI * 2;
    ball.setPosition(Math.cos(angle) * pitch, Math.sin(angle) * pitch, ball.radius);
    w.add(ball);
    balls.push(ball);
  }
  // Fire one through the middle of it.
  const cue = pollen('cue');
  cue.setPosition(-0.5, 0, cue.radius);
  cue.setVelocity(3, 0, 0);
  w.add(cue);

  // Peak spin during the collision, not what is left after rolling resistance
  // has stopped everything: the scatter is the event, not the aftermath.
  let spinning = 0;
  for (let i = 0; i < 2000 * 3; i++) {
    w.step(1 / 2000);
    spinning = Math.max(spinning, balls.filter((b) => b.spinRate > 2).length);
  }
  assert.ok(spinning >= 3, `only ${spinning} of 7 ever span`);
  const spread = balls.map((b) => Math.hypot(b.x, b.y));
  assert.ok(Math.max(...spread) > 0.12, 'the heap spread out');
  for (const ball of balls) assert.ok(ball.isFinite());
});

// ------------------------------------------------- orientation and the mask

test('a spinning element turns, and the turn matches the spin it was given', () => {
  const ball = new Ball({
    id: 'p', kind: 'pollen', radius: POLLEN_RADIUS, mass: POLLEN_MASS,
  });
  // A quarter turn about z, integrated in small steps.
  const rate = Math.PI / 2;
  ball.setSpin(0, 0, rate);
  const steps = 2000;
  for (let i = 0; i < steps; i++) ball.integrateSpin(1 / steps);

  // The quaternion for a rotation of `a` about z is (0, 0, sin(a/2), cos(a/2)).
  assert.ok(Math.abs(ball.ox) < 1e-9);
  assert.ok(Math.abs(ball.oy) < 1e-9);
  assert.ok(
    Math.abs(ball.oz - Math.sin(rate / 2)) < 1e-4,
    `oz ${ball.oz} vs ${Math.sin(rate / 2)}`,
  );
  assert.ok(Math.abs(ball.ow - Math.cos(rate / 2)) < 1e-4);
});

test('the orientation quaternion stays a unit quaternion over a whole MATCH', () => {
  const ball = new Ball({
    id: 'p', kind: 'pollen', radius: POLLEN_RADIUS, mass: POLLEN_MASS,
  });
  // Hard tumbling about all three axes, for two minutes at the physics rate.
  ball.setSpin(180, -120, 90);
  for (let i = 0; i < 120 * 2000; i++) ball.integrateSpin(1 / 2000);
  const length = Math.hypot(ball.ox, ball.oy, ball.oz, ball.ow);
  assert.ok(Math.abs(length - 1) < 1e-9, `drifted to ${length}`);
  assert.ok(Number.isFinite(ball.ow));
});

test('an element with no spin does not turn, and a reset puts it back', () => {
  const ball = new Ball({
    id: 'p', kind: 'pollen', radius: POLLEN_RADIUS, mass: POLLEN_MASS,
  });
  for (let i = 0; i < 100; i++) ball.integrateSpin(0.01);
  assert.equal(ball.ow, 1);

  ball.setSpin(3, 0, 0);
  for (let i = 0; i < 100; i++) ball.integrateSpin(0.01);
  assert.ok(ball.ow < 0.999, 'it turned');
  ball.resetOrientation();
  assert.equal(ball.ow, 1);
  assert.equal(ball.ox, 0);
});

test('a landing element ends up turned, because the floor spun it up', () => {
  const w = world();
  const ball = w.add(
    new Ball({ id: 'p', kind: 'pollen', radius: POLLEN_RADIUS, mass: POLLEN_MASS }),
  );
  ball.setPosition(0, 0, 0.5);
  ball.setVelocity(2.5, 0, -1.5);
  for (let i = 0; i < 400; i++) w.step(1 / 400);
  assert.ok(ball.spinRate > 1, `scrubbed into a roll: ${ball.spinRate.toFixed(1)} rad/s`);
  assert.ok(
    Math.abs(ball.ow) < 0.999,
    'and the orientation followed it, so the perforations turn with the ball',
  );
});

test('an element bounces like a hollow plastic ball, not like a beanbag', () => {
  // The complaint this comes from: elements "seem too heavy and they just
  // drop". They did. At the old floor restitution of 0.35 a metre drop came
  // back 11 cm and was dead on the second bounce.
  //
  // Note that the masses have nothing to do with it. Restitution is a property
  // of the two materials, so an ideal bounce returns the same *fraction* of
  // the drop whatever the ball weighs -- which is why correcting the masses
  // (they were about double) did not change the bounce at all, and this is a
  // separate fix.
  const drop = (mass, radius) => {
    const w = new BallWorld({
      fieldSize: 3.6,
      wallHeight: 0.29,
      restitution: TILE_RESTITUTION,
      settleSpeed: SETTLE_SPEED,
    });
    const ball = new Ball({ id: 'b', kind: 'pollen', mass, radius, restitution: ELEMENT_RESTITUTION });
    w.add(ball);
    ball.setPosition(0, 0, 1);
    ball.stop();

    const peaks = [];
    let lastVz = 0;
    let settled = null;
    for (let i = 0; i < 2000 * 8; i++) {
      w.step(1 / 2000);
      if (lastVz > 0 && ball.vz <= 0 && ball.z > radius + 0.002) peaks.push(ball.z - radius);
      lastVz = ball.vz;
      if (settled === null && Math.abs(ball.vz) < 1e-4 && ball.z <= radius + 1e-4) {
        settled = i / 2000;
      }
    }
    return { peaks, settled, height: 1 - radius, restZ: ball.z, radius };
  };

  for (const [label, mass, radius] of [
    ['POLLEN', POLLEN_MASS, POLLEN_RADIUS],
    ['NECTAR', NECTAR_MASS, NECTAR_RADIUS],
  ]) {
    const r = drop(mass, radius);
    const cor = Math.sqrt(r.peaks[0] / r.height);

    assert.ok(
      r.peaks[0] > 0.2 && r.peaks[0] < 0.4,
      `${label} should come back about 29 cm of a metre, got ${(r.peaks[0] * 100).toFixed(1)} cm`,
    );
    assert.ok(
      cor > 0.48 && cor < TILE_RESTITUTION + 0.01,
      `${label} effective COR ${cor.toFixed(2)}, against a configured ${TILE_RESTITUTION}`,
    );
    // Drag takes a little out of the rebound, so the measured COR should come
    // in just *under* the configured one rather than matching it exactly.
    assert.ok(cor < TILE_RESTITUTION, `${label} should lose a little to the air, got ${cor.toFixed(3)}`);

    assert.ok(
      r.peaks.length >= 4,
      `${label} should bounce several visible times, got ${r.peaks.length}`,
    );
    // And still come to rest, on the floor, rather than buzzing for ever --
    // which is what the settle threshold is for.
    assert.ok(r.settled !== null && r.settled < 3, `${label} settled at ${r.settled}`);
    assert.ok(
      Math.abs(r.restZ - r.radius) < 1e-4,
      `${label} should rest on the tiles, at z ${r.restZ.toFixed(4)} against r ${r.radius.toFixed(4)}`,
    );
  }
});

test('the real element masses are the published ones', () => {
  // AndyMark lists the BIOBUZZ Scoring Elements at 0.055 lb and 0.091 lb.
  // Pinned because these were estimates of 45 g and 85 g, roughly double, and
  // the error was invisible: it shows up as shots that carry too well and a
  // HIVE that needs twice the load to tip.
  assert.ok(Math.abs(POLLEN_MASS - 0.055 * 0.45359237) < 0.0004, `POLLEN ${POLLEN_MASS} kg`);
  assert.ok(Math.abs(NECTAR_MASS - 0.091 * 0.45359237) < 0.0004, `NECTAR ${NECTAR_MASS} kg`);

  // The listing's diameters agree with the CAD, which is the cross-check that
  // makes the masses beside them worth trusting.
  assert.ok(Math.abs(POLLEN_RADIUS * 2 - 2.8 * 0.0254) < 1e-4);
  assert.ok(Math.abs(NECTAR_RADIUS * 2 - 3.62 * 0.0254) < 1e-4);
});
