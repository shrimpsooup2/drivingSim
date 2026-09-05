/**
 * Geometry primitives the driving drills are built from.
 *
 * Deliberately game-agnostic: gates, zones and corridors describe *driving*,
 * not scoring, so none of this needs revisiting when the season's game is
 * announced.
 *
 * @module
 */

import { Vec2 } from '../math/Vec2.js';
import { wrapAngle } from '../math/MathUtil.js';

/**
 * Do segments p1->p2 and p3->p4 cross?
 *
 * Used for gate detection, and it has to be a *segment* test rather than a
 * point-in-region test: a fast robot moves several centimetres per physics
 * frame, so checking "is the robot on the gate line right now" would let it
 * tunnel straight through the gate without registering.
 */
export function segmentsIntersect(p1, p2, p3, p4) {
  const d1x = p2.x - p1.x;
  const d1y = p2.y - p1.y;
  const d2x = p4.x - p3.x;
  const d2y = p4.y - p3.y;
  const denominator = d1x * d2y - d1y * d2x;
  if (Math.abs(denominator) < 1e-12) return false; // parallel
  const t = ((p3.x - p1.x) * d2y - (p3.y - p1.y) * d2x) / denominator;
  const u = ((p3.x - p1.x) * d1y - (p3.y - p1.y) * d1x) / denominator;
  return t >= 0 && t <= 1 && u >= 0 && u <= 1;
}

/** Shortest distance from a point to the segment a->b. */
export function distanceToSegment(point, a, b) {
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const lengthSquared = abx * abx + aby * aby;
  if (lengthSquared < 1e-12) return Math.hypot(point.x - a.x, point.y - a.y);
  let t = ((point.x - a.x) * abx + (point.y - a.y) * aby) / lengthSquared;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.hypot(point.x - (a.x + abx * t), point.y - (a.y + aby * t));
}

/**
 * A gate the robot must drive through, in a specified direction.
 *
 * The gate spans `width` perpendicular to `heading`, and only a crossing that
 * travels along +heading counts. Direction matters: without it, reversing back
 * through a gate you have already cleared would re-trigger it, and a slalom
 * would be solvable by oscillating in place.
 */
export class Gate {
  /**
   * @param {{center: Vec2, heading: number, width: number, label?: string}} opts
   */
  constructor(opts) {
    this.center = opts.center;
    this.heading = opts.heading;
    this.width = opts.width;
    this.label = opts.label ?? '';
  }

  /** The two posts, as field-frame points. */
  get endpoints() {
    const nx = -Math.sin(this.heading);
    const ny = Math.cos(this.heading);
    const h = this.width / 2;
    return [
      new Vec2(this.center.x + nx * h, this.center.y + ny * h),
      new Vec2(this.center.x - nx * h, this.center.y - ny * h),
    ];
  }

  /**
   * Did the robot pass through this gate travelling the right way?
   * @param {Vec2} previous robot centre on the previous check
   * @param {Vec2} current  robot centre now
   */
  crossed(previous, current) {
    const [a, b] = this.endpoints;
    if (!segmentsIntersect(previous, current, a, b)) return false;
    // Travelling along +heading, not back through it.
    const travelX = current.x - previous.x;
    const travelY = current.y - previous.y;
    return travelX * Math.cos(this.heading) + travelY * Math.sin(this.heading) > 0;
  }
}

/** A circular region on the floor. */
export class CircleZone {
  /** @param {{center: Vec2, radius: number, label?: string}} opts */
  constructor(opts) {
    this.center = opts.center;
    this.radius = opts.radius;
    this.label = opts.label ?? '';
  }

  contains(point) {
    return Math.hypot(point.x - this.center.x, point.y - this.center.y) <= this.radius;
  }

  distanceFrom(point) {
    return Math.hypot(point.x - this.center.x, point.y - this.center.y);
  }
}

/** An axis-aligned or rotated rectangular region. */
export class RectZone {
  /** @param {{center: Vec2, size: Vec2, heading?: number, label?: string}} opts */
  constructor(opts) {
    this.center = opts.center;
    this.size = opts.size;
    this.heading = opts.heading ?? 0;
    this.label = opts.label ?? '';
  }

  contains(point) {
    const dx = point.x - this.center.x;
    const dy = point.y - this.center.y;
    const c = Math.cos(-this.heading);
    const s = Math.sin(-this.heading);
    const localX = dx * c - dy * s;
    const localY = dx * s + dy * c;
    return Math.abs(localX) <= this.size.x / 2 && Math.abs(localY) <= this.size.y / 2;
  }
}

/**
 * A corridor the robot must stay inside, defined by a centre line and a width.
 * Used by the lane drill, where straying is penalised rather than fatal.
 */
export class Corridor {
  /** @param {{points: Vec2[], halfWidth: number}} opts */
  constructor(opts) {
    this.points = opts.points;
    this.halfWidth = opts.halfWidth;
  }

  /** Distance outside the corridor; 0 when inside. */
  strayDistance(point) {
    let best = Infinity;
    for (let i = 1; i < this.points.length; i++) {
      best = Math.min(best, distanceToSegment(point, this.points[i - 1], this.points[i]));
    }
    return Math.max(0, best - this.halfWidth);
  }
}

/**
 * How far a heading is from a target, in radians, always positive.
 * Used by drills that require the robot to be square to something.
 */
export function headingError(actual, target) {
  return Math.abs(wrapAngle(target - actual));
}
