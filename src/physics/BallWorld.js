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
    /**
     * Air density, kg/m^3. Sea level and 20 C; a gym in Denver is about 15
     * percent thinner, which is worth a few inches of range.
     */
    this.airDensity = opts.airDensity ?? 1.204;
    /**
     * Sliding friction between an element and each surface it can touch.
     *
     * Plastic on foam tile grips well, which is why a landed ball scrubs into
     * a roll in a few centimetres rather than sliding across the FIELD.
     * Polycarbonate and a ROBOT's plate are slipperier, and plastic on plastic
     * between two elements slipperier still -- a pile of POLLEN shuffles.
     */
    this.floorFriction = opts.floorFriction ?? 0.5;
    this.wallFriction = opts.wallFriction ?? 0.3;
    this.bodyFriction = opts.bodyFriction ?? 0.3;
    this.ballFriction = opts.ballFriction ?? 0.22;
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
     * Solid structures balls bounce off, as callbacks. See `addCollider`.
     * @type {((ball: Ball, dt: number) => void)[]}
     */
    this.colliders = [];
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
    this.colliders.length = 0;
    this.bodies.length = 0;
  }

  /** @param {(ball: Ball, dt: number) => boolean} fn */
  addInteractor(fn) {
    this.interactors.push(fn);
    return this;
  }

  /**
   * Register something solid that is not a ROBOT: a CELL's walls, say.
   *
   * Separate from `interactors`, which claim ownership of a ball. A collider
   * only pushes it around, which is the difference between a structure a ball
   * bounces off and a container that has swallowed it. Both exist because a
   * CELL is the first and the second in that order -- the ball has to fly in
   * and rattle before anything adopts it.
   *
   * @param {(ball: Ball, dt: number) => void} fn
   */
  addCollider(fn) {
    this.colliders.push(fn);
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

    // Structures first, then ROBOTS: a ball is far more often being held by a
    // CELL's walls than shoved by a ROBOT, and resolving the ROBOT last lets
    // it win, which is what a 15 kg machine driving into something should do.
    for (const collide of this.colliders) {
      for (const ball of this.balls) {
        if (!ball.free || ball.outOfBounds) continue;
        collide(ball, dt);
      }
    }

    for (const entry of this.bodies) {
      for (const ball of this.balls) {
        if (!ball.free || ball.outOfBounds) continue;
        resolveBallVsBox(
          ball,
          entry.body,
          entry.halfLength,
          entry.halfWidth,
          entry.height,
          this.bodyFriction,
        );
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
    applyDrag(ball, dt, this.airDensity);

    // Rolling resistance, only while actually on the tiles. This is the
    // hysteresis loss in the foam, which is separate from the sliding friction
    // in `resolveSphereContact` -- a ball that has settled into a true roll has
    // no sliding left and would otherwise coast forever.
    if (ball.onFloor) {
      const speed = ball.groundSpeed;
      if (speed > 1e-4) {
        const decel = ball.rollingResistance * GRAVITY * dt;
        const scale = Math.max(0, 1 - decel / speed);
        ball.vx *= scale;
        ball.vy *= scale;
        // A rolling ball's spin decays with it, or it would arrive at the next
        // contact spinning as if it were still doing the old speed.
        ball.wx *= scale;
        ball.wy *= scale;
        ball.wz *= scale;
      } else {
        ball.vx = 0;
        ball.vy = 0;
        ball.wx = 0;
        ball.wy = 0;
        ball.wz = 0;
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
    resolveSphereContact(ball, 0, 0, 1, {
      restitution: this.floorRestitution,
      friction: this.floorFriction,
      minBounce: 0.35,
    });
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
    // Polycarbonate, so it gives back more than the foam floor does, and it
    // scrubs a glancing ball into a spin the same way the floor does.
    const wall = { restitution: ball.restitution, friction: this.wallFriction };
    if (ball.x < -limit) {
      ball.x = -limit;
      resolveSphereContact(ball, 1, 0, 0, wall);
    } else if (ball.x > limit) {
      ball.x = limit;
      resolveSphereContact(ball, -1, 0, 0, wall);
    }
    if (ball.y < -limit) {
      ball.y = -limit;
      resolveSphereContact(ball, 0, 1, 0, wall);
    } else if (ball.y > limit) {
      ball.y = limit;
      resolveSphereContact(ball, 0, -1, 0, wall);
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
              resolveBallPair(ball, other, this.ballFriction);
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

/**
 * Contact between two elements: impulse along the line of centres, friction
 * across it.
 *
 * The friction is what makes a pile behave like a pile. Without it every
 * contact was purely radial, so a POLLEN shoved into a heap pushed the others
 * out along clean lines and nothing tumbled -- balls slid past each other
 * without ever gripping. Plastic on plastic is slippery but it is not
 * frictionless.
 *
 * @param {Ball} a
 * @param {Ball} b
 * @param {number} [friction]
 */
export function resolveBallPair(a, b, friction = 0.22) {
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

  // Raise the per-step speed ceiling for both of them before applying it.
  //
  // `BallWorld._boundContactSpeed` holds a ball to what it was doing at the
  // start of the step unless a contact says otherwise, and a struck ball was
  // doing *nothing* -- so without this, every bit of momentum handed over got
  // scaled straight back out and a cue ball fired into a heap stopped dead
  // while the heap sat there. Momentum was being destroyed outright.
  //
  // The honest bound for a two-body collision: in the centre-of-mass frame
  // each ball's speed can only shrink, so in the lab frame neither can end up
  // faster than the centre of mass plus the whole relative speed.
  if (a.contactSpeedBound !== undefined || b.contactSpeedBound !== undefined) {
    const massSum = a.mass + b.mass;
    const cmx = (a.vx * a.mass + b.vx * b.mass) / massSum;
    const cmy = (a.vy * a.mass + b.vy * b.mass) / massSum;
    const cmz = (a.vz * a.mass + b.vz * b.mass) / massSum;
    const possible = Math.hypot(cmx, cmy, cmz) + Math.hypot(rvx, rvy, rvz);
    if (a.contactSpeedBound !== undefined && possible > a.contactSpeedBound) {
      a.contactSpeedBound = possible;
    }
    if (b.contactSpeedBound !== undefined && possible > b.contactSpeedBound) {
      b.contactSpeedBound = possible;
    }
  }
  a.vx -= nx * impulse * invA;
  a.vy -= ny * impulse * invA;
  a.vz -= nz * impulse * invA;
  b.vx += nx * impulse * invB;
  b.vy += ny * impulse * invB;
  b.vz += nz * impulse * invB;

  if (friction <= 0) return true;

  // Sliding speed where they touch, spin included. Each contact point sits one
  // radius along the line of centres from its own centre.
  const acx = nx * a.radius;
  const acy = ny * a.radius;
  const acz = nz * a.radius;
  const bcx = -nx * b.radius;
  const bcy = -ny * b.radius;
  const bcz = -nz * b.radius;
  let ux =
    b.vx + (b.wy * bcz - b.wz * bcy) - (a.vx + (a.wy * acz - a.wz * acy));
  let uy =
    b.vy + (b.wz * bcx - b.wx * bcz) - (a.vy + (a.wz * acx - a.wx * acz));
  let uz =
    b.vz + (b.wx * bcy - b.wy * bcx) - (a.vz + (a.wx * acy - a.wy * acx));
  const un = ux * nx + uy * ny + uz * nz;
  ux -= un * nx;
  uy -= un * ny;
  uz -= un * nz;
  const sliding = Math.hypot(ux, uy, uz);
  if (sliding < 1e-6) return true;

  // Effective mass at the contact for a tangential impulse, both spheres'
  // translation and rotation together.
  const tangentialInv =
    invA +
    invB +
    (a.radius * a.radius) / a.spinInertia +
    (b.radius * b.radius) / b.spinInertia;
  const magnitude = Math.min(sliding / tangentialInv, friction * impulse);
  const tx = (ux / sliding) * magnitude;
  const ty = (uy / sliding) * magnitude;
  const tz = (uz / sliding) * magnitude;

  a.vx += tx * invA;
  a.vy += ty * invA;
  a.vz += tz * invA;
  b.vx -= tx * invB;
  b.vy -= ty * invB;
  b.vz -= tz * invB;
  a.wx += (acy * tz - acz * ty) / a.spinInertia;
  a.wy += (acz * tx - acx * tz) / a.spinInertia;
  a.wz += (acx * ty - acy * tx) / a.spinInertia;
  b.wx -= (bcy * tz - bcz * ty) / b.spinInertia;
  b.wy -= (bcz * tx - bcx * tz) / b.spinInertia;
  b.wz -= (bcx * ty - bcy * tx) / b.spinInertia;
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
export function resolveBallVsBox(ball, body, halfLength, halfWidth, height, friction = 0.3) {
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

  // Tell `BallWorld._boundContactSpeed` how fast the quickest thing touching
  // this ball is going, so a sequence of contacts in one step cannot ratchet it
  // past what any of them could have imparted.
  const restitution = ball.restitution * 0.6;
  if (ball.contactSpeedBound !== undefined) {
    const surfaceSpeed = Math.hypot(surfaceVx, surfaceVy);
    const possible = (1 + restitution) * surfaceSpeed;
    if (possible > ball.contactSpeedBound) ball.contactSpeedBound = possible;
  }

  // A ROBOT is a box extruded upward, so every face normal is horizontal and
  // the vertical velocity plays no part in whether the ball is approaching it.
  const approaching = (ball.vx - surfaceVx) * nx + (ball.vy - surfaceVy) * ny;
  if (approaching < 0) {
    // Bounce off a much heavier body, with friction across the face -- which is
    // what makes a ball shoved by a plate roll rather than skate.
    resolveSphereContact(ball, nx, ny, 0, {
      restitution,
      friction,
      surfaceVx,
      surfaceVy,
    });
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


/**
 * Aerodynamic drag on a ball, applied as a velocity change over `dt`.
 *
 * `F = 0.5 * rho * Cd * A * v^2`, opposing motion. Integrated explicitly,
 * which is stable here because even at the muzzle the drag deceleration is a
 * fifth of gravity and the substep is half a millisecond.
 *
 * This is not a refinement. A 45 g POLLEN is 71 mm across, so it has a lot of
 * frontal area for its mass and it is a *wiffle* ball -- perforated, which
 * pushes the drag coefficient above a smooth sphere's. Leaving drag out
 * overstated the range of a shot by about a fifth, and it overstated it by
 * *different* amounts for a POLLEN and a NECTAR, which is exactly the sort of
 * error that teaches a driver the wrong aim.
 *
 * @param {Ball} ball
 * @param {number} dt
 * @param {number} rho air density, kg/m^3
 */
export function applyDrag(ball, dt, rho = 1.204) {
  const speed = Math.hypot(ball.vx, ball.vy, ball.vz);
  if (speed < 1e-4) return ball;
  const force = 0.5 * rho * ball.dragCoefficient * ball.area * speed * speed;
  // Clamped so a pathologically large step cannot reverse the velocity.
  const dv = Math.min(speed, (force / ball.mass) * dt);
  const scale = 1 - dv / speed;
  ball.vx *= scale;
  ball.vy *= scale;
  ball.vz *= scale;
  return ball;
}

/**
 * Resolve one contact on a sphere: bounce along the normal, friction across it.
 *
 * The friction is the part that was missing, and it is what makes a landing
 * look like a landing. A ball that arrives with horizontal speed and no spin
 * has a contact point sliding backwards along the ground, so the surface
 * scrubs it: the ball slows, picks up spin, and once the contact point has
 * stopped sliding it is rolling and the friction switches itself off. Skid,
 * then roll. Without it a ball landed and *slid*, and a pile of POLLEN pushed
 * apart along clean lines of centres instead of scattering.
 *
 * Coulomb, with the stick case handled exactly: the tangential impulse needed
 * to bring the contact point to rest on a sphere is
 * `m / (1 + m r^2 / J)` times the sliding speed, and if that is less than
 * `mu` times the normal impulse the ball grips instead of sliding. For a
 * wiffle ball (`J = 0.6 m r^2`) that factor is `m / 2.67`.
 *
 * @param {Ball} ball
 * @param {number} nx outward contact normal, pointing from the surface to the ball
 * @param {number} ny
 * @param {number} nz
 * @param {{restitution: number, friction: number, surfaceVx?: number,
 *          surfaceVy?: number, surfaceVz?: number, minBounce?: number}} opts
 * @returns {boolean} whether the ball is resting on this contact
 */
export function resolveSphereContact(ball, nx, ny, nz, opts) {
  const sx = opts.surfaceVx ?? 0;
  const sy = opts.surfaceVy ?? 0;
  const sz = opts.surfaceVz ?? 0;

  // Velocity of the ball relative to the surface, at its centre.
  let rvx = ball.vx - sx;
  let rvy = ball.vy - sy;
  let rvz = ball.vz - sz;
  const normal = rvx * nx + rvy * ny + rvz * nz;

  // --- Normal impulse. `minBounce` stops a ball buzzing on the floor forever
  // with ever-smaller hops; below it the bounce is simply absorbed.
  let impulse = 0;
  if (normal < 0) {
    const restitution = -normal < (opts.minBounce ?? 0) ? 0 : opts.restitution;
    impulse = -(1 + restitution) * normal;
    ball.vx += nx * impulse;
    ball.vy += ny * impulse;
    ball.vz += nz * impulse;
    rvx += nx * impulse;
    rvy += ny * impulse;
    rvz += nz * impulse;
  }

  const resting = normal < 0 && -normal < (opts.minBounce ?? 0);

  // --- Friction. Zero normal impulse means nothing pressing them together,
  // except for a resting contact, where the weight is being carried by the
  // position correction rather than by an impulse -- so give that case a
  // normal impulse equal to one step of gravity's worth, or a ball sitting
  // still would never scrub at all.
  const pressing = impulse > 1e-9 ? impulse : resting ? Math.abs(normal) + 1e-3 : 0;
  if (pressing <= 0 || opts.friction <= 0) return resting;

  // Contact point is one radius along -n from the centre, and its velocity
  // includes the spin.
  const cx = -nx * ball.radius;
  const cy = -ny * ball.radius;
  const cz = -nz * ball.radius;
  let ux = rvx + (ball.wy * cz - ball.wz * cy);
  let uy = rvy + (ball.wz * cx - ball.wx * cz);
  let uz = rvz + (ball.wx * cy - ball.wy * cx);
  // Only the part across the normal slides.
  const un = ux * nx + uy * ny + uz * nz;
  ux -= un * nx;
  uy -= un * ny;
  uz -= un * nz;
  const sliding = Math.hypot(ux, uy, uz);
  if (sliding < 1e-6) return resting;

  // Effective mass at the contact for a tangential impulse on a sphere.
  const J = ball.spinInertia;
  const reduced = 1 / (1 / ball.mass + (ball.radius * ball.radius) / J);
  const stick = (reduced * sliding) / ball.mass;
  const magnitude = Math.min(stick, opts.friction * pressing);

  const tx = -(ux / sliding) * magnitude;
  const ty = -(uy / sliding) * magnitude;
  const tz = -(uz / sliding) * magnitude;
  ball.vx += tx;
  ball.vy += ty;
  ball.vz += tz;
  // Torque from the tangential impulse: r_contact x P, over the inertia. The
  // impulse is stored per unit mass, so multiply the mass back in.
  const m = ball.mass;
  ball.wx += (m * (cy * tz - cz * ty)) / J;
  ball.wy += (m * (cz * tx - cx * tz)) / J;
  ball.wz += (m * (cx * ty - cy * tx)) / J;

  return resting;
}

export { GRAVITY };
