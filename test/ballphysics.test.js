import test from 'node:test';
import assert from 'node:assert/strict';
import { BallWorld } from '../src/physics/BallWorld.js';
import { Ball } from '../src/physics/Ball.js';
import { RigidBody2d } from '../src/physics/RigidBody2d.js';
import { POLLEN_MASS, POLLEN_RADIUS } from '../src/field/biobuzz/constants.js';

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

test('a launched POLLEN keeps its speed -- the cap is above anything real', () => {
  // The backstop must not clip a legitimate shot. The fastest shooter modelled
  // here is 4500 rpm on a 2 in wheel at 0.62 transfer: 14.8 m/s at the muzzle.
  const w = world();
  const ball = pollen();
  ball.setPosition(0, 0, 0.3);
  ball.setVelocity(10, 0, 8);
  w.add(ball);
  assert.ok(w.maxSpeed > 14.8, 'the cap has to sit above the fastest shooter');
  w.step(1 / 2000);
  assert.ok(Math.abs(ball.vx - 10) < 1e-6, 'a shot is untouched');
  assert.equal(w.speedCapHits, 0);
});
