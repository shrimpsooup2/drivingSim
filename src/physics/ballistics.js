import { applyDrag, GRAVITY } from './BallWorld.js';

/**
 * Flight of a SCORING ELEMENT, and the aiming problems that go with it.
 *
 * ## Why this is numeric
 *
 * It used to be a closed form, because gravity alone gives a parabola and the
 * inverse -- "what speed puts it through that point" -- is a couple of lines of
 * algebra. Adding air drag ends that: the equation of motion is
 *
 *     dv/dt = -g*zhat - (rho*Cd*A / 2m) * |v| * v
 *
 * which has no useful closed-form inverse. It is also not optional. A POLLEN is
 * a 45 g wiffle ball 71 mm across, so at 7 m/s the drag on it is a sixth of its
 * weight and it acts for the whole flight: pretending it away overstates the
 * range of a shot by about a fifth, and by *different* amounts for a POLLEN and
 * a NECTAR. A guide that is a fifth optimistic teaches the wrong aim, which is
 * worse than no guide.
 *
 * So the arc is integrated with exactly the sequence `BallWorld` uses --
 * gravity, then drag, then position -- and the aiming solvers run a bisection
 * over that integration. Pass the world's own substep and the guide is not an
 * approximation of the trajectory, it *is* the trajectory, to floating point.
 *
 * ## Two step sizes, on purpose
 *
 * The guide integrates at the world's substep, because matching is the whole
 * point. The solvers integrate at `SOLVER_STEP`, because they run a bisection
 * inside an angle sweep and the AI does that several times a second for every
 * robot on the FIELD. At 1/240 the arc lands within about a centimetre of the
 * fine integration over a 3 m shot, against an aperture 20 in wide -- an error
 * two orders of magnitude below what it is deciding.
 *
 * @module
 */

/** Step the aiming solvers integrate at. See the note above. */
export const SOLVER_STEP = 1 / 240;

/**
 * @typedef {object} ArcPoint
 * @property {number} x
 * @property {number} y
 * @property {number} z
 * @property {number} t
 */

/**
 * Integrate a flight from a launch state.
 *
 * @param {{
 *   x: number, y: number, z: number,
 *   vx: number, vy: number, vz: number,
 *   mass: number, radius: number, dragCoefficient?: number,
 * }} launch
 * @param {{
 *   step?: number,
 *   floor?: number,
 *   maxTime?: number,
 *   airDensity?: number,
 *   stopAt?: (point: ArcPoint, previous: ArcPoint) => boolean,
 * }} [opts]
 * @returns {{points: ArcPoint[], flightTime: number, apex: ArcPoint,
 *            landing: ArcPoint, origin: ArcPoint}}
 */
export function integrateArc(launch, opts = {}) {
  const step = opts.step ?? SOLVER_STEP;
  const floor = opts.floor ?? 0;
  const maxTime = opts.maxTime ?? 6;
  const rho = opts.airDensity ?? 1.204;

  // A stand-in with just the fields `applyDrag` reads, so the guide and the
  // ball world cannot drift apart: one function, one drag model.
  const body = {
    vx: launch.vx,
    vy: launch.vy,
    vz: launch.vz,
    mass: launch.mass,
    dragCoefficient: launch.dragCoefficient ?? 0.6,
    get area() {
      return Math.PI * launch.radius * launch.radius;
    },
  };

  let x = launch.x;
  let y = launch.y;
  let z = launch.z;
  let t = 0;
  const points = [{ x, y, z, t }];
  let apex = points[0];

  while (t < maxTime) {
    // Exactly `BallWorld._integrate`'s order: gravity, drag, then position.
    body.vz -= GRAVITY * step;
    applyDrag(body, step, rho);
    x += body.vx * step;
    y += body.vy * step;
    z += body.vz * step;
    t += step;

    const point = { x, y, z, t };
    const previous = points[points.length - 1];
    points.push(point);
    if (z > apex.z) apex = point;

    if (opts.stopAt?.(point, previous)) break;
    // Down through the floor: stop on the landing rather than bouncing, which
    // is somebody else's problem.
    if (z <= floor + launch.radius && body.vz < 0) break;
  }

  return {
    points,
    flightTime: t,
    apex,
    landing: points[points.length - 1],
    origin: points[0],
  };
}

/**
 * Where an arc crosses a plane, or null if it does not.
 *
 * The plane is given by a point on it and an outward normal; the crossing
 * wanted is the one going *inward*, which for a CELL's opening is the only
 * direction that counts as arriving. Found on the sampled polyline and then
 * refined by bisection between the two samples, so the answer does not depend
 * on the sample spacing.
 *
 * @param {ReturnType<typeof integrateArc>} arc
 * @param {{x:number,y:number,z:number}} point
 * @param {{x?:number,y:number,z:number}} normal
 * @param {(hit: {x:number,y:number,z:number,t:number}) => boolean} [accept]
 */
export function planeCrossing(arc, point, normal, accept) {
  const nx = normal.x ?? 0;
  const depth = (p) =>
    (p.x - point.x) * nx + (p.y - point.y) * normal.y + (p.z - point.z) * normal.z;

  for (let i = 1; i < arc.points.length; i++) {
    const a = arc.points[i - 1];
    const b = arc.points[i];
    if (depth(a) <= 0 || depth(b) > 0) continue;

    // Linear between two samples is enough here: over one step the arc is
    // straight to well under a millimetre.
    let lo = 0;
    let hi = 1;
    for (let k = 0; k < 24; k++) {
      const mid = (lo + hi) / 2;
      const p = {
        x: a.x + (b.x - a.x) * mid,
        y: a.y + (b.y - a.y) * mid,
        z: a.z + (b.z - a.z) * mid,
      };
      if (depth(p) > 0) lo = mid;
      else hi = mid;
    }
    const f = (lo + hi) / 2;
    const hit = {
      x: a.x + (b.x - a.x) * f,
      y: a.y + (b.y - a.y) * f,
      z: a.z + (b.z - a.z) * f,
      t: a.t + (b.t - a.t) * f,
    };
    if (!accept || accept(hit)) return hit;
  }
  return null;
}

/**
 * Height of the arc when it has travelled `range` horizontally, or null if it
 * never gets that far.
 *
 * @param {ReturnType<typeof integrateArc>} arc
 * @param {number} range
 */
export function heightAtRange(arc, range) {
  const origin = arc.origin;
  const distance = (p) => Math.hypot(p.x - origin.x, p.y - origin.y);
  for (let i = 1; i < arc.points.length; i++) {
    const a = arc.points[i - 1];
    const b = arc.points[i];
    const da = distance(a);
    const db = distance(b);
    if (db < range) continue;
    if (db === da) return b.z;
    const f = (range - da) / (db - da);
    return a.z + (b.z - a.z) * f;
  }
  return null;
}

/**
 * The launch speed that drops an element on a target, or null if no speed in
 * range does.
 *
 * Bisection on the height at the target's range, which is monotonic in speed
 * for a fixed angle: throw it harder and it is higher when it gets there. The
 * closed-form parabola gives the starting bracket, so this converges in a
 * dozen or so iterations from a good guess rather than from nothing.
 *
 * `null` for "it cannot be done" is the useful answer and it happens often: a
 * flat shot at a target above you has no solution at any speed, because the
 * arc is still climbing when it arrives and a CELL will not take a climbing
 * element.
 *
 * @param {{range: number, rise: number, angle: number, mass: number,
 *          radius: number, dragCoefficient?: number, maxSpeed?: number,
 *          step?: number, airDensity?: number, tolerance?: number}} query
 * @returns {{speed: number, arc: ReturnType<typeof integrateArc>,
 *            descending: boolean, apexRange: number}|null}
 */
export function solveSpeedForTarget(query) {
  const { range, rise, angle } = query;
  if (range <= 0) return null;
  const maxSpeed = query.maxSpeed ?? 30;

  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const fly = (speed) =>
    integrateArc(
      {
        x: 0,
        y: 0,
        z: 0,
        vx: speed * cos,
        vy: 0,
        vz: speed * sin,
        mass: query.mass,
        radius: query.radius,
        dragCoefficient: query.dragCoefficient,
      },
      {
        step: query.step ?? SOLVER_STEP,
        airDensity: query.airDensity,
        // Far below the target, so the arc is not cut off before it gets there.
        floor: rise - 6 - query.radius,
        maxTime: 6,
      },
    );

  // Bracket from the drag-free closed form, which is always too slow and so is
  // a sound lower bound. Drag over these ranges costs about a fifth of the
  // range, which needs roughly a tenth more speed, so 1.7x is a generous upper
  // bound -- and starting tight is what keeps this affordable: the AI solves
  // this several times a second for every robot on the FIELD.
  const denom = 2 * cos * cos * (range * Math.tan(angle) - rise);
  if (denom <= 0) return null;
  const free = Math.sqrt((GRAVITY * range * range) / denom);
  if (!Number.isFinite(free) || free <= 0) return null;
  let lo = free;
  let hi = Math.min(maxSpeed, free * 1.7);
  if (hi <= lo) return null;

  const shortfall = (speed) => {
    const arc = fly(speed);
    const height = heightAtRange(arc, range);
    return height === null ? -Infinity : height - rise;
  };

  if (shortfall(hi) < 0) return null; // cannot reach it even flat out
  // A centimetre per second is two orders of magnitude finer than the 20 in
  // aperture it is aiming at, so there is nothing to gain past it.
  const tolerance = query.tolerance ?? 0.01;
  while (hi - lo > tolerance) {
    const mid = (lo + hi) / 2;
    if (shortfall(mid) < 0) lo = mid;
    else hi = mid;
  }

  const speed = (lo + hi) / 2;
  const arc = fly(speed);
  // Descending on arrival is what a CELL requires: the apex has to come
  // before the target.
  const apexRange = Math.hypot(arc.apex.x, arc.apex.y);
  return { speed, arc, descending: apexRange < range, apexRange };
}

/**
 * Drag-free speed that would put an element through a target: the closed form
 * this module used to be.
 *
 * Kept, and exported, because it is the right tool for *screening*. Choosing
 * somewhere to stand means testing hundreds of candidate positions, and paying
 * for a drag integration on each is thousands of times the cost of deciding
 * which one to walk to. It is optimistic by about a tenth in speed, so it
 * never rules out a shot that is actually possible -- which is the direction a
 * screen has to err in.
 *
 * The real solve then runs once, on the candidate that was chosen.
 *
 * @param {number} range
 * @param {number} rise
 * @param {number} angle
 * @returns {{speed: number, descending: boolean, apexRange: number}|null}
 */
export function freeFlightSolution(range, rise, angle) {
  const cos = Math.cos(angle);
  const denom = 2 * cos * cos * (range * Math.tan(angle) - rise);
  if (denom <= 0 || range <= 0) return null;
  const v2 = (GRAVITY * range * range) / denom;
  if (!(v2 > 0)) return null;
  const apexRange = (v2 * Math.sin(angle) * cos) / GRAVITY;
  return { speed: Math.sqrt(v2), descending: apexRange < range, apexRange };
}

/**
 * Position on an integrated arc at time `t`, interpolated between samples.
 *
 * Callers want `at(t)` because that is what a closed form gave them, and
 * because refining a plane crossing needs to ask for arbitrary times. Linear
 * between two integration samples is well inside the error of the integration
 * itself.
 *
 * @param {ReturnType<typeof integrateArc>} arc
 * @param {number} t
 */
export function sampleArc(arc, t) {
  const points = arc.points;
  if (points.length === 1 || t <= 0) return { ...points[0] };
  const last = points[points.length - 1];
  if (t >= last.t) return { ...last };
  // Uniform step, so the index is direct rather than a search.
  const step = points[1].t - points[0].t;
  const i = Math.min(points.length - 2, Math.max(0, Math.floor(t / step)));
  const a = points[i];
  const b = points[i + 1];
  const span = b.t - a.t || 1;
  const f = (t - a.t) / span;
  return {
    x: a.x + (b.x - a.x) * f,
    y: a.y + (b.y - a.y) * f,
    z: a.z + (b.z - a.z) * f,
    t,
  };
}
