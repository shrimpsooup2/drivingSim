import { Vec2 } from '../math/Vec2.js';

/**
 * Collision between the robot (an oriented box) and static field geometry.
 *
 * FTC collisions are almost entirely robot-against-wall and robot-against-field
 * element, both of which are static, so this solves the one-body case: a
 * sequential impulse solver with positional correction. That is enough to make
 * hitting a wall feel right -- the robot stops, scrubs along the wall under
 * friction, and rotates realistically if it hits at a corner.
 *
 * @module
 */

/**
 * @typedef {object} HalfPlane
 * @property {Vec2} normal inward-facing unit normal
 * @property {number} offset points p inside satisfy dot(p, normal) >= offset
 * @property {string} [id]
 */

/**
 * @typedef {object} ContactResult
 * @property {number} depth   maximum penetration, metres
 * @property {Vec2} normal
 * @property {string} id
 * @property {number} impulse total normal impulse applied, N*s
 */

/** Corner offsets of a box, in body frame. Reused to avoid per-frame allocation. */
const CORNER_SIGNS = [
  [1, 1],
  [1, -1],
  [-1, -1],
  [-1, 1],
];

/**
 * Build the four inward half-planes of a square field perimeter centred on the
 * origin.
 * @param {number} size inner dimension, metres
 * @returns {HalfPlane[]}
 */
export function fieldWalls(size) {
  const h = size / 2;
  return [
    { normal: new Vec2(1, 0), offset: -h, id: 'wall-left' },
    { normal: new Vec2(-1, 0), offset: -h, id: 'wall-right' },
    { normal: new Vec2(0, 1), offset: -h, id: 'wall-back' },
    { normal: new Vec2(0, -1), offset: -h, id: 'wall-front' },
  ];
}

/**
 * Resolve the robot box against a set of static half-planes.
 *
 * @param {import('./RigidBody2d.js').RigidBody2d} body
 * @param {number} halfLength half the frame length (along body +x)
 * @param {number} halfWidth  half the frame width (along body +y)
 * @param {HalfPlane[]} planes
 * @param {{restitution:number, friction:number, iterations?:number, correction?:number, slop?:number}} opts
 * @returns {ContactResult[]} contacts that were resolved this step
 */
export function resolveHalfPlanes(body, halfLength, halfWidth, planes, opts) {
  const restitution = opts.restitution;
  const friction = opts.friction;
  const iterations = opts.iterations ?? 2;
  const correctionRate = opts.correction ?? 0.5;
  const slop = opts.slop ?? 0.0005;

  /** @type {ContactResult[]} */
  const contacts = [];
  const invMass = 1 / body.mass;
  const invInertia = 1 / body.momentOfInertia;

  for (let iter = 0; iter < iterations; iter++) {
    for (const plane of planes) {
      const n = plane.normal;
      let deepest = Infinity;
      let totalImpulse = 0;
      let anyContact = false;

      for (const [sx, sy] of CORNER_SIGNS) {
        const local = new Vec2(sx * halfLength, sy * halfWidth);
        const world = body.rotation.apply(local);
        const px = body.position.x + world.x;
        const py = body.position.y + world.y;
        const separation = px * n.x + py * n.y - plane.offset;
        if (separation >= 0) continue;

        anyContact = true;
        if (separation < deepest) deepest = separation;

        // Relative velocity at this corner (the other body is static).
        const vx = body.velocity.x - body.angularVelocity * world.y;
        const vy = body.velocity.y + body.angularVelocity * world.x;
        const vn = vx * n.x + vy * n.y;

        if (vn < 0) {
          const rCrossN = world.x * n.y - world.y * n.x;
          const effInvMass = invMass + rCrossN * rCrossN * invInertia;
          // Restitution is only applied to meaningful impacts; without this a
          // robot resting against a wall jitters forever on numerical noise.
          const bounce = vn < -0.15 ? restitution : 0;
          const j = (-(1 + bounce) * vn) / effInvMass;
          if (j > 0) {
            applyImpulse(body, n.x * j, n.y * j, world, invMass, invInertia);
            totalImpulse += j;

            // Coulomb friction along the wall, clamped to mu * normal impulse.
            const vx2 = body.velocity.x - body.angularVelocity * world.y;
            const vy2 = body.velocity.y + body.angularVelocity * world.x;
            const vn2 = vx2 * n.x + vy2 * n.y;
            let tx = vx2 - vn2 * n.x;
            let ty = vy2 - vn2 * n.y;
            const tLen = Math.hypot(tx, ty);
            if (tLen > 1e-6) {
              tx /= tLen;
              ty /= tLen;
              const rCrossT = world.x * ty - world.y * tx;
              const effInvMassT = invMass + rCrossT * rCrossT * invInertia;
              let jt = -tLen / effInvMassT;
              const maxFriction = friction * j;
              if (jt < -maxFriction) jt = -maxFriction;
              if (jt > maxFriction) jt = maxFriction;
              applyImpulse(body, tx * jt, ty * jt, world, invMass, invInertia);
            }
          }
        }
      }

      if (anyContact && deepest < -slop) {
        // Push out along the normal. Correcting a fraction per iteration keeps
        // the robot from being flung away from a deep overlap.
        const push = (-deepest - slop) * correctionRate;
        body.position.x += n.x * push;
        body.position.y += n.y * push;
        if (iter === 0) {
          contacts.push({ depth: -deepest, normal: n, id: plane.id ?? 'plane', impulse: totalImpulse });
        }
      }
    }
  }

  return contacts;
}

function applyImpulse(body, jx, jy, r, invMass, invInertia) {
  body.velocity.x += jx * invMass;
  body.velocity.y += jy * invMass;
  body.angularVelocity += (r.x * jy - r.y * jx) * invInertia;
}

/**
 * World-frame corners of the robot box, in order. Used by the renderer and by
 * future element-vs-robot tests.
 * @param {import('./RigidBody2d.js').RigidBody2d} body
 * @param {number} halfLength
 * @param {number} halfWidth
 * @returns {Vec2[]}
 */
export function boxCorners(body, halfLength, halfWidth) {
  return CORNER_SIGNS.map(([sx, sy]) => {
    const local = new Vec2(sx * halfLength, sy * halfWidth);
    const world = body.rotation.apply(local);
    return new Vec2(body.position.x + world.x, body.position.y + world.y);
  });
}

/**
 * Separating-axis test between two oriented boxes.
 *
 * Not used by the perimeter walls (half-planes are exact and cheaper there),
 * but this is the routine a future game element or a second robot would use, so
 * it lives here ready to go.
 *
 * @param {{centre:Vec2, halfLength:number, halfWidth:number, cos:number, sin:number}} a
 * @param {{centre:Vec2, halfLength:number, halfWidth:number, cos:number, sin:number}} b
 * @returns {{normal:Vec2, depth:number}|null} minimum translation to separate a from b
 */
export function obbOverlap(a, b) {
  const axes = [
    new Vec2(a.cos, a.sin),
    new Vec2(-a.sin, a.cos),
    new Vec2(b.cos, b.sin),
    new Vec2(-b.sin, b.cos),
  ];
  let bestDepth = Infinity;
  let bestAxis = null;

  const d = Vec2.sub(b.centre, a.centre);
  for (const axis of axes) {
    const ra =
      a.halfLength * Math.abs(axis.x * a.cos + axis.y * a.sin) +
      a.halfWidth * Math.abs(axis.x * -a.sin + axis.y * a.cos);
    const rb =
      b.halfLength * Math.abs(axis.x * b.cos + axis.y * b.sin) +
      b.halfWidth * Math.abs(axis.x * -b.sin + axis.y * b.cos);
    const dist = Math.abs(Vec2.dot(d, axis));
    const overlap = ra + rb - dist;
    if (overlap <= 0) return null;
    if (overlap < bestDepth) {
      bestDepth = overlap;
      bestAxis = Vec2.dot(d, axis) < 0 ? new Vec2(-axis.x, -axis.y) : axis.clone();
    }
  }
  return bestAxis ? { normal: bestAxis, depth: bestDepth } : null;
}

/** World-frame corners of an oriented box, counter-clockwise. */
export function obbCorners(box) {
  const ux = box.cos;
  const uy = box.sin;
  const vx = -box.sin;
  const vy = box.cos;
  const l = box.halfLength;
  const w = box.halfWidth;
  return [
    new Vec2(box.centre.x + ux * l + vx * w, box.centre.y + uy * l + vy * w),
    new Vec2(box.centre.x + ux * l - vx * w, box.centre.y + uy * l - vy * w),
    new Vec2(box.centre.x - ux * l - vx * w, box.centre.y - uy * l - vy * w),
    new Vec2(box.centre.x - ux * l + vx * w, box.centre.y + -uy * l + vy * w),
  ];
}

/** Is a world-frame point inside an oriented box? */
export function pointInObb(point, box) {
  const dx = point.x - box.centre.x;
  const dy = point.y - box.centre.y;
  const along = dx * box.cos + dy * box.sin;
  const across = -dx * box.sin + dy * box.cos;
  return Math.abs(along) <= box.halfLength && Math.abs(across) <= box.halfWidth;
}

/**
 * Resolve the robot against a set of static oriented boxes.
 *
 * The perimeter uses half-planes, which are exact and cheap for an infinite
 * wall. Field obstacles are finite, so they need a real box-vs-box test: a
 * half-plane obstacle would push the robot away even when it is well past the
 * end of it.
 *
 * Contact points are taken as the robot corners that have penetrated, falling
 * back to the obstacle corners inside the robot. Resolving at the corners
 * rather than at the centres is what makes a glancing hit spin the robot, which
 * is exactly what happens on a real field and is most of why clipping an
 * obstacle is so costly.
 *
 * @param {import('./RigidBody2d.js').RigidBody2d} body
 * @param {number} halfLength
 * @param {number} halfWidth
 * @param {{centre:Vec2, halfLength:number, halfWidth:number, cos:number, sin:number, id?:string}[]} obstacles
 * @param {{restitution:number, friction:number, iterations?:number, correction?:number, slop?:number}} opts
 * @returns {ContactResult[]}
 */
export function resolveObstacles(body, halfLength, halfWidth, obstacles, opts) {
  /** @type {ContactResult[]} */
  const contacts = [];
  if (obstacles.length === 0) return contacts;

  const iterations = opts.iterations ?? 2;
  const correctionRate = opts.correction ?? 0.6;
  const slop = opts.slop ?? 0.0005;
  const invMass = 1 / body.mass;
  const invInertia = 1 / body.momentOfInertia;

  for (let iter = 0; iter < iterations; iter++) {
    for (const obstacle of obstacles) {
      const robot = {
        centre: body.position,
        halfLength,
        halfWidth,
        cos: body.rotation.cos,
        sin: body.rotation.sin,
      };
      const overlap = obbOverlap(robot, obstacle);
      if (!overlap) continue;

      // obbOverlap's normal points from the robot toward the obstacle, so the
      // robot must be pushed the other way to separate.
      const nx = -overlap.normal.x;
      const ny = -overlap.normal.y;

      // Gather contact points: robot corners buried in the obstacle first,
      // since those describe the collision best.
      const points = [];
      for (const corner of boxCorners(body, halfLength, halfWidth)) {
        if (pointInObb(corner, obstacle)) points.push(corner);
      }
      if (points.length === 0) {
        for (const corner of obbCorners(obstacle)) {
          if (pointInObb(corner, robot)) points.push(corner);
        }
      }
      if (points.length === 0) {
        // Edge-on overlap with no corner inside either shape: apply the impulse
        // at the point on the robot nearest the obstacle.
        points.push(new Vec2(body.position.x - nx * halfLength, body.position.y - ny * halfLength));
      }

      let totalImpulse = 0;
      const share = 1 / points.length;

      for (const point of points) {
        const rx = point.x - body.position.x;
        const ry = point.y - body.position.y;
        const vx = body.velocity.x - body.angularVelocity * ry;
        const vy = body.velocity.y + body.angularVelocity * rx;
        const vn = vx * nx + vy * ny;
        if (vn >= 0) continue; // separating already

        const rCrossN = rx * ny - ry * nx;
        const effInvMass = invMass + rCrossN * rCrossN * invInertia;
        const bounce = vn < -0.15 ? opts.restitution : 0;
        const j = ((-(1 + bounce) * vn) / effInvMass) * share;
        if (j <= 0) continue;

        body.velocity.x += nx * j * invMass;
        body.velocity.y += ny * j * invMass;
        body.angularVelocity += (rx * (ny * j) - ry * (nx * j)) * invInertia;
        totalImpulse += j;

        // Friction along the contact, clamped to mu * normal impulse.
        const vx2 = body.velocity.x - body.angularVelocity * ry;
        const vy2 = body.velocity.y + body.angularVelocity * rx;
        const vn2 = vx2 * nx + vy2 * ny;
        let tx = vx2 - vn2 * nx;
        let ty = vy2 - vn2 * ny;
        const tLen = Math.hypot(tx, ty);
        if (tLen > 1e-6) {
          tx /= tLen;
          ty /= tLen;
          const rCrossT = rx * ty - ry * tx;
          const effInvMassT = invMass + rCrossT * rCrossT * invInertia;
          let jt = (-tLen / effInvMassT) * share;
          const maxFriction = opts.friction * j;
          jt = Math.max(-maxFriction, Math.min(maxFriction, jt));
          body.velocity.x += tx * jt * invMass;
          body.velocity.y += ty * jt * invMass;
          body.angularVelocity += (rx * (ty * jt) - ry * (tx * jt)) * invInertia;
        }
      }

      if (overlap.depth > slop) {
        const push = (overlap.depth - slop) * correctionRate;
        body.position.x += nx * push;
        body.position.y += ny * push;
        if (iter === 0) {
          contacts.push({
            depth: overlap.depth,
            normal: new Vec2(nx, ny),
            id: obstacle.id ?? 'obstacle',
            impulse: totalImpulse,
          });
        }
      }
    }
  }

  return contacts;
}

/**
 * Resolve a collision between two *moving* boxes.
 *
 * Robot-on-robot contact cannot reuse the static path: both bodies must take
 * impulses, split by inverse mass, and both must be pushed apart. That split is
 * what makes size and weight matter -- a 6 kg minibot bounces off a 17 kg
 * pusher rather than moving it, which is exactly the asymmetry that makes
 * defence worth practising against.
 *
 * @param {import('./RigidBody2d.js').RigidBody2d} bodyA
 * @param {number} halfLengthA
 * @param {number} halfWidthA
 * @param {import('./RigidBody2d.js').RigidBody2d} bodyB
 * @param {number} halfLengthB
 * @param {number} halfWidthB
 * @param {{restitution:number, friction:number, iterations?:number, correction?:number, slop?:number}} opts
 * @returns {ContactResult|null}
 */
export function resolveDynamicPair(bodyA, halfLengthA, halfWidthA, bodyB, halfLengthB, halfWidthB, opts) {
  const iterations = opts.iterations ?? 2;
  const correctionRate = opts.correction ?? 0.5;
  const slop = opts.slop ?? 0.0008;
  const invMassA = 1 / bodyA.mass;
  const invMassB = 1 / bodyB.mass;
  const invInertiaA = 1 / bodyA.momentOfInertia;
  const invInertiaB = 1 / bodyB.momentOfInertia;
  const invMassSum = invMassA + invMassB;
  /** @type {ContactResult|null} */
  let reported = null;

  for (let iter = 0; iter < iterations; iter++) {
    const boxA = {
      centre: bodyA.position,
      halfLength: halfLengthA,
      halfWidth: halfWidthA,
      cos: bodyA.rotation.cos,
      sin: bodyA.rotation.sin,
    };
    const boxB = {
      centre: bodyB.position,
      halfLength: halfLengthB,
      halfWidth: halfWidthB,
      cos: bodyB.rotation.cos,
      sin: bodyB.rotation.sin,
    };
    const overlap = obbOverlap(boxA, boxB);
    if (!overlap) return reported;

    // Normal points from A toward B, so A is pushed along -n and B along +n.
    const nx = overlap.normal.x;
    const ny = overlap.normal.y;

    const points = [];
    for (const corner of boxCorners(bodyA, halfLengthA, halfWidthA)) {
      if (pointInObb(corner, boxB)) points.push(corner);
    }
    for (const corner of obbCorners(boxB)) {
      if (pointInObb(corner, boxA)) points.push(corner);
    }
    if (points.length === 0) {
      points.push(new Vec2((bodyA.position.x + bodyB.position.x) / 2, (bodyA.position.y + bodyB.position.y) / 2));
    }

    const share = 1 / points.length;
    let totalImpulse = 0;

    for (const point of points) {
      const rax = point.x - bodyA.position.x;
      const ray = point.y - bodyA.position.y;
      const rbx = point.x - bodyB.position.x;
      const rby = point.y - bodyB.position.y;

      const vax = bodyA.velocity.x - bodyA.angularVelocity * ray;
      const vay = bodyA.velocity.y + bodyA.angularVelocity * rax;
      const vbx = bodyB.velocity.x - bodyB.angularVelocity * rby;
      const vby = bodyB.velocity.y + bodyB.angularVelocity * rbx;

      // Relative velocity of B with respect to A along the normal. Negative
      // means they are closing.
      const rvx = vbx - vax;
      const rvy = vby - vay;
      const vn = rvx * nx + rvy * ny;
      if (vn >= 0) continue;

      const rCrossNA = rax * ny - ray * nx;
      const rCrossNB = rbx * ny - rby * nx;
      const effInvMass =
        invMassSum + rCrossNA * rCrossNA * invInertiaA + rCrossNB * rCrossNB * invInertiaB;
      const bounce = vn < -0.2 ? opts.restitution : 0;
      const j = ((-(1 + bounce) * vn) / effInvMass) * share;
      if (j <= 0) continue;
      totalImpulse += j;

      applyPairImpulse(bodyA, bodyB, nx * j, ny * j, rax, ray, rbx, rby, invMassA, invMassB, invInertiaA, invInertiaB);

      // Friction, so a shoulder-to-shoulder shove drags rather than slides.
      const vax2 = bodyA.velocity.x - bodyA.angularVelocity * ray;
      const vay2 = bodyA.velocity.y + bodyA.angularVelocity * rax;
      const vbx2 = bodyB.velocity.x - bodyB.angularVelocity * rby;
      const vby2 = bodyB.velocity.y + bodyB.angularVelocity * rbx;
      const rvx2 = vbx2 - vax2;
      const rvy2 = vby2 - vay2;
      const vn2 = rvx2 * nx + rvy2 * ny;
      let tx = rvx2 - vn2 * nx;
      let ty = rvy2 - vn2 * ny;
      const tLen = Math.hypot(tx, ty);
      if (tLen > 1e-6) {
        tx /= tLen;
        ty /= tLen;
        const rCrossTA = rax * ty - ray * tx;
        const rCrossTB = rbx * ty - rby * tx;
        const effInvMassT =
          invMassSum + rCrossTA * rCrossTA * invInertiaA + rCrossTB * rCrossTB * invInertiaB;
        let jt = ((-tLen) / effInvMassT) * share;
        const maxFriction = opts.friction * j;
        jt = Math.max(-maxFriction, Math.min(maxFriction, jt));
        applyPairImpulse(bodyA, bodyB, tx * jt, ty * jt, rax, ray, rbx, rby, invMassA, invMassB, invInertiaA, invInertiaB);
      }
    }

    if (overlap.depth > slop) {
      // Split the separation by inverse mass: the lighter robot gives way.
      const push = (overlap.depth - slop) * correctionRate;
      bodyA.position.x -= nx * push * (invMassA / invMassSum);
      bodyA.position.y -= ny * push * (invMassA / invMassSum);
      bodyB.position.x += nx * push * (invMassB / invMassSum);
      bodyB.position.y += ny * push * (invMassB / invMassSum);
    }

    if (iter === 0) {
      reported = { depth: overlap.depth, normal: new Vec2(nx, ny), id: 'robot', impulse: totalImpulse };
    }
  }
  return reported;
}

function applyPairImpulse(bodyA, bodyB, jx, jy, rax, ray, rbx, rby, invMassA, invMassB, invInertiaA, invInertiaB) {
  bodyA.velocity.x -= jx * invMassA;
  bodyA.velocity.y -= jy * invMassA;
  bodyA.angularVelocity -= (rax * jy - ray * jx) * invInertiaA;
  bodyB.velocity.x += jx * invMassB;
  bodyB.velocity.y += jy * invMassB;
  bodyB.angularVelocity += (rbx * jy - rby * jx) * invInertiaB;
}
