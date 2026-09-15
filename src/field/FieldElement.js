import { Vec2 } from '../math/Vec2.js';

/**
 * Base class for anything that lives on the field beyond the perimeter.
 *
 * Nothing here is game-specific. BIOBUZZ's structures are built on this class,
 * which is the point: a game should not need changes to the core.
 * The interface is deliberately small: an element has a pose, optional
 * collision geometry, an optional physics step, and a way to describe itself to
 * the renderer. When kickoff happens, a goal, a game piece or a scoring zone is
 * a subclass of this, registered with the Field -- no core changes required.
 *
 * See docs/EXTENDING.md for a worked example.
 */
export class FieldElement {
  /**
   * @param {{id?:string, position?:Vec2, heading?:number, collidable?:boolean}} [opts]
   */
  constructor(opts = {}) {
    this.id = opts.id ?? `element-${Math.random().toString(36).slice(2, 8)}`;
    this.position = opts.position ?? new Vec2();
    this.heading = opts.heading ?? 0;
    /** When true, the Field includes this element in robot collision tests. */
    this.collidable = opts.collidable ?? true;
    /** Set by the Field when the element is added. */
    this.field = /** @type {import('./Field.js').Field|null} */ (null);
  }

  /**
   * Advance the element. Called once per rendered frame with the simulated
   * frame time, not per physics substep.
   * @param {number} _dt seconds
   */
  update(_dt) {}

  /**
   * Static collision geometry contributed to the robot collision pass.
   * Return an empty array for a non-colliding element such as a scoring zone.
   * @returns {import('../physics/collision.js').HalfPlane[]}
   */
  halfPlanes() {
    return [];
  }

  /**
   * Description for the renderer. Returning null means "nothing to draw", which
   * is correct for logical-only elements.
   * @returns {{kind:string, position:Vec2, heading:number, size?:Vec2, height?:number, color?:number[]}|null}
   */
  describe() {
    return null;
  }

  /** Restore to the element's starting state when the field is reset. */
  reset() {}
}
