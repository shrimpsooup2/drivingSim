import { Vec2 } from '../math/Vec2.js';
import { INCH } from '../math/MathUtil.js';
import { fieldWalls, resolveHalfPlanes } from '../physics/collision.js';

/**
 * The FTC field: a 12 ft square of foam tiles inside a perimeter wall.
 *
 * The field frame has its origin at the field centre, +x toward the far wall,
 * +y to the left as seen from the driver station, and headings counter-clockwise
 * positive. That matches the FTC field coordinate system, so poses read here
 * mean the same thing they do in your op-mode.
 *
 * Game elements are deliberately absent: the season has not started. Everything
 * needed to add them is in place -- see `addElement` and FieldElement.
 */
export class Field {
  /**
   * @param {import('../config/schema.js').SimConfig} config
   */
  constructor(config) {
    this.config = config;
    this.size = config.field.size;
    /** Foam tiles are 23.625 in square; six per side make up the field. */
    this.tileSize = 23.625 * INCH;
    this.tilesPerSide = 6;
    this.wallHeight = 12 * INCH;
    this.wallThickness = 1.5 * INCH;

    /** @type {import('./FieldElement.js').FieldElement[]} */
    this.elements = [];
    this._walls = fieldWalls(this.size);
    /** @type {import('../physics/collision.js').ContactResult[]} */
    this.lastContacts = [];
  }

  /** Rebuild static geometry after a config change. */
  applySettings(config) {
    this.config = config;
    if (this.size !== config.field.size) {
      this.size = config.field.size;
      this._walls = fieldWalls(this.size);
    }
    return this;
  }

  get halfSize() {
    return this.size / 2;
  }

  /**
   * Add a game element. Returns the element so callers can keep a reference.
   * @template {import('./FieldElement.js').FieldElement} T
   * @param {T} element
   * @returns {T}
   */
  addElement(element) {
    element.field = this;
    this.elements.push(element);
    return element;
  }

  /** @param {string} id */
  removeElement(id) {
    const i = this.elements.findIndex((e) => e.id === id);
    if (i >= 0) {
      this.elements[i].field = null;
      this.elements.splice(i, 1);
      return true;
    }
    return false;
  }

  /** All static collision geometry: the perimeter plus any collidable elements. */
  collisionPlanes() {
    if (this.elements.length === 0) return this._walls;
    const planes = [...this._walls];
    for (const el of this.elements) {
      if (el.collidable) planes.push(...el.halfPlanes());
    }
    return planes;
  }

  /**
   * Resolve the robot against the field.
   * @param {import('../physics/RigidBody2d.js').RigidBody2d} body
   * @param {number} halfLength
   * @param {number} halfWidth
   */
  collide(body, halfLength, halfWidth) {
    if (!this.config.field.collisionsEnabled) {
      this.lastContacts = [];
      return this.lastContacts;
    }
    this.lastContacts = resolveHalfPlanes(body, halfLength, halfWidth, this.collisionPlanes(), {
      restitution: this.config.field.wallRestitution,
      friction: this.config.field.wallFriction,
    });
    return this.lastContacts;
  }

  /** Advance any game elements. */
  update(dt) {
    for (const el of this.elements) el.update(dt);
  }

  reset() {
    for (const el of this.elements) el.reset();
    this.lastContacts = [];
  }

  /**
   * Convenience: the centre of tile (col, row), zero-indexed from the
   * back-right corner as seen from the driver station. Handy for placing
   * elements and starting positions once a game is known.
   * @param {number} col
   * @param {number} row
   */
  tileCenter(col, row) {
    const span = this.tileSize * this.tilesPerSide;
    const origin = -span / 2 + this.tileSize / 2;
    return new Vec2(origin + row * this.tileSize, origin + col * this.tileSize);
  }

  /** True if a point is inside the perimeter. */
  contains(point, margin = 0) {
    const h = this.halfSize - margin;
    return Math.abs(point.x) <= h && Math.abs(point.y) <= h;
  }
}
