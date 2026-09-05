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
