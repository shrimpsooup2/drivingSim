import { Vec2 } from '../math/Vec2.js';
import { FieldElement } from './FieldElement.js';

/**
 * A solid box on the field that the robot can hit.
 *
 * Physical obstacles are what make a course genuinely demanding. Without them,
 * a "tight" route is only tight by convention -- nothing stops the driver
 * cutting straight through it, so the drill measures willingness to follow
 * instructions rather than control. With them, clearance is real, a clipped
 * corner spins the robot, and recovering costs time.
 *
 * Built on FieldElement, so once the season's game arrives its scoring
 * structures collide exactly the same way with no new machinery.
 */
export class Obstacle extends FieldElement {
  /**
   * @param {{
   *   id?: string,
   *   position: Vec2,
   *   size: Vec2,
   *   heading?: number,
   *   height?: number,
   *   color?: number[],
   * }} opts
   */
  constructor(opts) {
    super({ id: opts.id, position: opts.position, heading: opts.heading ?? 0, collidable: true });
    this.size = opts.size;
    this.height = opts.height ?? 0.3;
    this.color = opts.color ?? [0.85, 0.45, 0.18, 1];
    /** Set by the collision pass whenever the robot is touching this. */
    this.touched = false;
  }

  /**
   * Oriented-box collider in the form the collision solver wants.
   * Obstacles are static, so this can be rebuilt each frame for free.
   */
  collider() {
    return {
      centre: this.position,
      halfLength: this.size.x / 2,
      halfWidth: this.size.y / 2,
      cos: Math.cos(this.heading),
      sin: Math.sin(this.heading),
      id: this.id,
    };
  }

  /**
   * Obstacles are solid boxes, not half-planes. Returning nothing here keeps
   * them out of the perimeter pass, which handles infinite walls.
   */
  halfPlanes() {
    return [];
  }

  describe() {
    return {
      kind: 'obstacle',
      position: this.position,
      heading: this.heading,
      size: this.size,
      height: this.height,
      color: this.touched ? [0.95, 0.3, 0.22, 1] : this.color,
    };
  }

  reset() {
    this.touched = false;
  }
}
