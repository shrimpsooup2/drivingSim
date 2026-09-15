import { Ball } from './Ball.js';

const GRAVITY = 9.80665;

/**
 * Free-body physics for the SCORING ELEMENTS.
 *
 * Runs at its own rate, well below the drivetrain's. Wheel contact is a stiff
 * constraint that needs sub-millisecond steps; a bouncing ball is not, so
 * stepping 56 of them at 2 kHz would be most of the frame budget for no gain.
 *
 * Ball-against-ball uses a uniform grid for broadphase. All-pairs would be
 * 1540 tests per step, which at any useful rate is the dominant cost; a grid
 * keeps it to the handful of genuine neighbours.
 */
export class BallWorld {
  /**
   * @param {{fieldSize: number, wallHeight: number, restitution?: number,
   *          maxSpeed?: number}} opts
   */
  constructor(opts) {
    /** @type {Ball[]} */
    this.balls = [];
    this.fieldSize = opts.fieldSize;
    this.halfSize = opts.fieldSize / 2;
    this.wallHeight = opts.wallHeight;
    /** Tile bounce. Foam is dead, so a ball dropped on it barely returns. */
    this.floorRestitution = opts.restitution ?? 0.35;
    /**
     * Hard ceiling on a free element's speed, m/s. See `_capSpeed`: this is a
     * divergence backstop, set above anything a mechanism here can produce, not
     * a tuning knob.
     */
    this.maxSpeed = opts.maxSpeed ?? 25;
    /** How many times the cap has fired. Should stay zero; useful if it does not. */
    this.speedCapHits = 0;

    /**
     * Things that may claim a ball before free physics runs: intakes, CELLS,
     * FLOWERS. Each is called with every free ball and returns true if it took
     * ownership.
     * @type {((ball: Ball, dt: number) => boolean)[]}
     */
    this.interactors = [];
    /**
     * Solid bodies balls bounce off: the player's robot and every opponent.
     * @type {{body: any, halfLength: number, halfWidth: number, height: number}[]}
     */
    this.bodies = [];

    this._grid = new Map();
    this._cellSize = 0.12;
    this.settled = false;
  }

  /** @param {Ball} ball */
  add(ball) {
    this.balls.push(ball);
    // The grid is sized to the largest ball so a neighbour is never more than
    // one cell away.
    this._cellSize = Math.max(this._cellSize, ball.radius * 2.2);
    return ball;
  }

  clear() {
    this.balls.length = 0;
    this.interactors.length = 0;
    this.bodies.length = 0;
  }

  /** @param {(ball: Ball, dt: number) => boolean} fn */
  addInteractor(fn) {
    this.interactors.push(fn);
  }

  /** Register a robot so balls collide with it. */
  addBody(body, halfLength, halfWidth, height) {
    this.bodies.push({ body, halfLength, halfWidth, height });
  }

  clearBodies() {
    this.bodies.length = 0;
  }

  get freeBalls() {
    return this.balls.filter((b) => b.free && !b.outOfBounds);
  }

  /**
   * Advance every free ball.
   * @param {number} dt seconds
   */
  step(dt) {
    // Containers get first refusal: a ball being swallowed by an intake or
    // dropping into a FLOWER should stop doing free physics the same step,
    // not after another bounce.
    for (const ball of this.balls) {
      if (!ball.free || ball.outOfBounds) continue;
      for (const interact of this.interactors) {
        if (interact(ball, dt)) break;
      }
    }

    for (const ball of this.balls) {
      if (!ball.free || ball.outOfBounds) continue;
      this._integrate(ball, dt);
      this._resolveFloor(ball);
    }

    // What each ball was doing before anything touched it, and how fast the
    // fastest surface that touches it this step is moving. Together those bound
    // what a step of contact resolution is allowed to leave it doing -- see
    // `_boundContactSpeed`.
    for (const ball of this.balls) {
      if (!ball.free || ball.outOfBounds) continue;
      ball.contactSpeedBound = ball.speed;
    }

    for (const entry of this.bodies) {
      for (const ball of this.balls) {
        if (!ball.free || ball.outOfBounds) continue;
        resolveBallVsBox(ball, entry.body, entry.halfLength, entry.halfWidth, entry.height);
      }
    }

    this._resolveBallPairs();

    for (const ball of this.balls) {
      if (!ball.free || ball.outOfBounds) continue;
      this._boundContactSpeed(ball);
    }

    // Containment last, so the FIELD has the final word on where an element is.
    // Resolved before the ROBOTS, a ball squeezed between a ROBOT and the wall
    // was pushed out of the ROBOT and then left there -- outside the
    // perimeter, because nothing clamped it again that step.
    for (const ball of this.balls) {
      if (!ball.free || ball.outOfBounds) continue;
      this._resolveFloor(ball);
      this._resolveWalls(ball);
    }

    let moving = false;
    for (const ball of this.balls) {
      if (!ball.isFinite()) {
        // A diverged ball would poison the score; drop it to the floor at rest.
        ball.setPosition(0, 0, ball.radius).stop();
      }
      if (ball.free && !ball.outOfBounds) this._capSpeed(ball);
      if (ball.free && !ball.outOfBounds && ball.speed > 0.05) moving = true;
    }
    // The manual assesses most scoring "after all SCORING ELEMENTS and ROBOTS
    // have come to rest", so the match needs to know when that is.
    this.settled = !moving;
  }

  /**
   * Hold a ball to what the surfaces touching it could actually have done.
   *
   * Each individual contact is already energy-correct: against a body orders
   * of magnitude heavier, the ball leaves at `e` times the speed it arrived,
   * measured in the surface's frame. What is *not* bounded is a sequence of
   * them inside one step. A ball trapped in a corner by a turning ROBOT is
   * resolved against the face, then the x wall, then the y wall, and the face's
   * normal has rotated slightly by the time it comes round again -- so each
   * contact does a little work along a slightly different axis and the ball
   * ratchets upward. It reached 6 m/s off a 2 m/s ROBOT.
   *
   * The bound is physical and tight: within one step a ball cannot end up
   * faster than it started, nor faster than `(1 + e)` times the quickest
   * surface that touched it. Nothing legitimate is clipped -- a ball in free
   * flight touches nothing, a launched ball is set by the launcher, and a
   * single honest bounce already satisfies it.
   */
  _boundContactSpeed(ball) {
    const bound = ball.contactSpeedBound;
    if (bound === undefined) return false;
    const speed = ball.speed;
    if (speed <= bound || speed < 1e-6) return false;
    const scale = bound / speed;
    ball.vx *= scale;
    ball.vy *= scale;
    ball.vz *= scale;
    return true;
  }

  /**
   * Backstop against a solver artefact, not a physical effect.
   *
   * Nothing on this FIELD can legitimately move an element faster than a
   * flywheel does: the fastest shooter here is 4500 rpm on a 2 in wheel at 0.62
   * transfer, which is 14.8 m/s at the muzzle. Anything past `maxSpeed` did not
   * come from a mechanism, it came from a contact resolution going wrong, and
   * letting it through means a POLLEN leaving the FIELD or tunnelling through a
   * wall in one substep.
   *
   * The contact code is written so this should never fire -- see
   * `resolveBallVsBox` -- so it scales the velocity down rather than zeroing
   * it, keeping the direction in case something does reach here.
   */
  _capSpeed(ball) {
    const speed = ball.speed;
    if (speed <= this.maxSpeed) return false;
    const scale = this.maxSpeed / speed;
    ball.vx *= scale;
    ball.vy *= scale;
    ball.vz *= scale;
    this.speedCapHits += 1;
    return true;
  }

  _integrate(ball, dt) {
    ball.vz -= GRAVITY * dt;

    // Rolling resistance, only while actually on the tiles.
    if (ball.onFloor) {
      const speed = ball.groundSpeed;
      if (speed > 1e-4) {
        const decel = ball.rollingResistance * GRAVITY * dt;
        const scale = Math.max(0, 1 - decel / speed);
        ball.vx *= scale;
        ball.vy *= scale;
      } else {
        ball.vx = 0;
        ball.vy = 0;
      }
    }

    ball.x += ball.vx * dt;
    ball.y += ball.vy * dt;
    ball.z += ball.vz * dt;
  }

  _resolveFloor(ball) {
    if (ball.z > ball.radius) {
      ball.onFloor = false;
      return;
    }
    ball.z = ball.radius;
    if (ball.vz < 0) {
      // Below a threshold, stop bouncing rather than buzzing on the floor
      // forever with ever-smaller hops.
      ball.vz = -ball.vz < 0.35 ? 0 : -ball.vz * this.floorRestitution;
    }
    ball.onFloor = Math.abs(ball.vz) < 0.05;
  }

  _resolveWalls(ball) {
    const limit = this.halfSize - ball.radius;
    // A ball above the wall has left the FIELD, which is a real outcome:
    // launched elements do sail out and get reintroduced by FIELD STAFF.
    if (ball.z - ball.radius > this.wallHeight) {
      if (Math.abs(ball.x) > this.halfSize || Math.abs(ball.y) > this.halfSize) {
        ball.outOfBounds = true;
        return;
      }
    }
    if (ball.x < -limit) {
      ball.x = -limit;
      if (ball.vx < 0) ball.vx = -ball.vx * ball.restitution;
    } else if (ball.x > limit) {
      ball.x = limit;
      if (ball.vx > 0) ball.vx = -ball.vx * ball.restitution;
    }
    if (ball.y < -limit) {
      ball.y = -limit;
      if (ball.vy < 0) ball.vy = -ball.vy * ball.restitution;
    } else if (ball.y > limit) {
      ball.y = limit;
      if (ball.vy > 0) ball.vy = -ball.vy * ball.restitution;
    }
  }

  /** Uniform-grid broadphase, then an impulse along the line of centres. */
  _resolveBallPairs() {
    const grid = this._grid;
    grid.clear();
    const size = this._cellSize;

    for (const ball of this.balls) {
      if (!ball.free || ball.outOfBounds) continue;
      const key = cellKey(ball.x, ball.y, ball.z, size);
      let bucket = grid.get(key);
      if (!bucket) {
        bucket = [];
        grid.set(key, bucket);
      }
      bucket.push(ball);
    }

    for (const ball of this.balls) {
      if (!ball.free || ball.outOfBounds) continue;
      const ix = Math.floor(ball.x / size);
      const iy = Math.floor(ball.y / size);
      const iz = Math.floor(ball.z / size);
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          for (let dz = -1; dz <= 1; dz++) {
            const bucket = grid.get(`${ix + dx},${iy + dy},${iz + dz}`);
            if (!bucket) continue;
            for (const other of bucket) {
              // Each pair is visited twice; the id comparison keeps it to once.
              if (other === ball || other.id <= ball.id) continue;
              resolveBallPair(ball, other);
            }
          }
        }
      }
    }
  }
}

function cellKey(x, y, z, size) {
  return `${Math.floor(x / size)},${Math.floor(y / size)},${Math.floor(z / size)}`;
}

/** Elastic-ish impulse between two spheres along the line of centres. */
export function resolveBallPair(a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const dz = b.z - a.z;
  const distanceSquared = dx * dx + dy * dy + dz * dz;
  const minimum = a.radius + b.radius;
  if (distanceSquared >= minimum * minimum || distanceSquared < 1e-12) return false;

  const distance = Math.sqrt(distanceSquared);
  const nx = dx / distance;
  const ny = dy / distance;
  const nz = dz / distance;

  // Separate them, split by inverse mass so the lighter POLLEN gives way to
  // the heavier NECTAR rather than both moving equally.
  const overlap = minimum - distance;
  const invA = 1 / a.mass;
  const invB = 1 / b.mass;
  const invSum = invA + invB;
  a.x -= nx * overlap * (invA / invSum);
  a.y -= ny * overlap * (invA / invSum);
  a.z -= nz * overlap * (invA / invSum);
  b.x += nx * overlap * (invB / invSum);
  b.y += ny * overlap * (invB / invSum);
  b.z += nz * overlap * (invB / invSum);

  const rvx = b.vx - a.vx;
  const rvy = b.vy - a.vy;
  const rvz = b.vz - a.vz;
  const approaching = rvx * nx + rvy * ny + rvz * nz;
  if (approaching >= 0) return true;

  const restitution = Math.min(a.restitution, b.restitution);
  const impulse = (-(1 + restitution) * approaching) / invSum;
  a.vx -= nx * impulse * invA;
  a.vy -= ny * impulse * invA;
  a.vz -= nz * impulse * invA;
  b.vx += nx * impulse * invB;
  b.vy += ny * impulse * invB;
  b.vz += nz * impulse * invB;
  return true;
}

/**
 * Bounce a ball off a robot, treated as its plan-view box extruded upward.
 *
 * The robot's *surface* velocity at the contact matters, not just its centre
 * velocity: a spinning robot flicks balls sideways, which is exactly how a
 * real one clears a pile.
 *
 * @param {Ball} ball
 * @param {import('./RigidBody2d.js').RigidBody2d} body
 * @param {number} halfLength
 * @param {number} halfWidth
 * @param {number} height
 */
export function resolveBallVsBox(ball, body, halfLength, halfWidth, height) {
  if (ball.z - ball.radius > height) return false;

  // Into the robot frame.
  const dx = ball.x - body.position.x;
  const dy = ball.y - body.position.y;
  const cos = body.rotation.cos;
  const sin = body.rotation.sin;
  const localX = dx * cos + dy * sin;
  const localY = -dx * sin + dy * cos;

  const closestX = Math.max(-halfLength, Math.min(halfLength, localX));
  const closestY = Math.max(-halfWidth, Math.min(halfWidth, localY));
  const offsetX = localX - closestX;
  const offsetY = localY - closestY;
  const distance = Math.hypot(offsetX, offsetY);

  if (distance >= ball.radius) return false;

  let normalLocalX;
  let normalLocalY;
  let push;
  if (distance > 1e-9) {
    // Touching a face, an edge or a corner from outside.
    normalLocalX = offsetX / distance;
    normalLocalY = offsetY / distance;
    push = ball.radius - distance;
  } else {
    // The centre is *inside* the box -- a ball run over, or squeezed under a
    // ROBOT that drove onto it. Push it out through the nearest face.
    //
    // The normal has to be built as a unit vector directly. Deriving it from a
    // sign-valued offset divided by a 1e-9 stand-in distance produced a normal
    // a billion units long, which the position correction then multiplied by
    // the ball's radius: a POLLEN pinched between a ROBOT and the wall was
    // teleported 3.6e7 m down the field and every impulse after that was
    // scaled by 1e9 as well. That is where the "pinched to absurd speed"
    // behaviour came from -- not from the contact model, from this normalize.
    const toX = halfLength - Math.abs(localX);
    const toY = halfWidth - Math.abs(localY);
    if (toX < toY) {
      normalLocalX = Math.sign(localX) || 1;
      normalLocalY = 0;
      // Out through the near face *and* clear of it, or the next substep finds
      // the centre inside again and does this forever.
      push = ball.radius + toX;
    } else {
      normalLocalX = 0;
      normalLocalY = Math.sign(localY) || 1;
      push = ball.radius + toY;
    }
  }

  // Back to world.
  const nx = normalLocalX * cos - normalLocalY * sin;
  const ny = normalLocalX * sin + normalLocalY * cos;
  ball.x += nx * push;
  ball.y += ny * push;

  // Robot surface velocity at the contact point.
  const contactX = closestX * cos - closestY * sin;
  const contactY = closestX * sin + closestY * cos;
  const surfaceVx = body.velocity.x - body.angularVelocity * contactY;
  const surfaceVy = body.velocity.y + body.angularVelocity * contactX;

  const relativeVx = ball.vx - surfaceVx;
  const relativeVy = ball.vy - surfaceVy;

  // Tell `BallWorld._boundContactSpeed` how fast the quickest thing touching
  // this ball is going, so a sequence of contacts in one step cannot ratchet it
  // past what any of them could have imparted.
  if (ball.contactSpeedBound !== undefined) {
    const restitution = ball.restitution * 0.6;
    const surfaceSpeed = Math.hypot(surfaceVx, surfaceVy);
    const possible = (1 + restitution) * surfaceSpeed;
    if (possible > ball.contactSpeedBound) ball.contactSpeedBound = possible;
  }

  const approaching = relativeVx * nx + relativeVy * ny;
  if (approaching < 0) {
    // Bounce off a much heavier body: the ball leaves at `e` times the speed it
    // arrived, measured against the moving face.
    const restitution = ball.restitution * 0.6;
    const impulse = -(1 + restitution) * approaching;
    ball.vx += nx * impulse;
    ball.vy += ny * impulse;
  } else {
    // Already separating, but a face driving into a ball should carry it along
    // rather than sliding through it.
    //
    // Written as a *target* rather than as an addition, and this matters: the
    // additive form ran on every contact, every substep. A ball pinched between
    // a ROBOT and the wall cannot move away, so it took another fraction of the
    // closing speed two thousand times a second and left at whatever speed you
    // like -- it reached 1e302 m/s in three seconds. A pushing plate cannot
    // make a ball travel faster than the plate, so bring it up to the face's
    // own normal speed and no further. That bound is also what makes the pinch
    // converge instead of diverge: each cycle of ROBOT-bounce and wall-bounce
    // now loses energy to both restitutions.
    const faceSpeed = surfaceVx * nx + surfaceVy * ny;
    const ballSpeed = ball.vx * nx + ball.vy * ny;
    if (faceSpeed > ballSpeed) {
      const delta = faceSpeed - ballSpeed;
      ball.vx += nx * delta;
      ball.vy += ny * delta;
    }
  }
  return true;
}

export { GRAVITY };
