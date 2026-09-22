/**
 * Things a routine draws on the field, so you can see what it thinks.
 *
 * ## Why
 *
 * Because the hard part of debugging an AUTO is not what the robot did -- you
 * can watch that -- it is what the routine *believed*. Where did it think the
 * target was? What path did it plan? Which waypoint was it driving at when it
 * went into the HIVE leg? Telemetry answers that in numbers, badly: three
 * decimal coordinates on a side panel is a thing you have to decode, and a
 * cross on the tiles is a thing you just see.
 *
 * Ported from the JVM simulator's field view, which renders Pedro Pathing's and
 * FTC Dashboard's own drawing packets. Those arrive over the network from a
 * real robot; here the routine draws straight into this.
 *
 * ## Lifetime
 *
 * A packet you rebuild, the way Dashboard works: whatever has been drawn stays
 * until `clear()`, so a routine that plans a path once at the start can draw it
 * once and leave it, and a routine that wants a live overlay clears at the top
 * of its loop. Cleared automatically when the routine resets, because stale
 * drawings from the last run are worse than none.
 *
 * There is a cap, because a `loop` that draws without clearing is not a bug
 * anybody would notice until the tab ran out of memory.
 *
 * @module
 */

/** How many shapes are kept. Beyond this the oldest go. */
export const MAX_SHAPES = 500;

/**
 * Colours by name, because `robot.draw.line(a, b, 'red')` reads and
 * `robot.draw.line(a, b, [0.9, 0.3, 0.2])` does not.
 */
export const DRAW_COLOURS = Object.freeze({
  red: [0.92, 0.34, 0.29],
  blue: [0.32, 0.61, 0.95],
  green: [0.28, 0.82, 0.54],
  amber: [0.95, 0.64, 0.24],
  cyan: [0.35, 0.85, 1.0],
  magenta: [0.86, 0.45, 0.9],
  white: [0.92, 0.94, 0.97],
  grey: [0.56, 0.6, 0.66],
});

/** The default, chosen not to collide with either trail or with an alliance. */
const DEFAULT_COLOUR = DRAW_COLOURS.cyan;

/** How many segments a circle is drawn with. */
const CIRCLE_SEGMENTS = 32;

export class FieldDrawing {
  constructor() {
    /**
     * @type {Array<
     *   {kind: 'line', ax: number, ay: number, bx: number, by: number, colour: number[], alpha: number}
     *   | {kind: 'text', x: number, y: number, text: string, colour: number[], alpha: number}
     * >}
     */
    this.shapes = [];
    /** Bumped whenever something is added, so a renderer can cache. */
    this.revision = 0;
    /** Shapes asked for and dropped because of the cap. */
    this.dropped = 0;
  }

  clear() {
    if (this.shapes.length) this.revision++;
    this.shapes.length = 0;
    this.dropped = 0;
    return this;
  }

  get count() {
    return this.shapes.length;
  }

  /** Every text shape, for the 2D label pass. */
  get labels() {
    return this.shapes.filter((s) => s.kind === 'text');
  }

  _push(shape) {
    if (this.shapes.length >= MAX_SHAPES) {
      // Oldest out. A routine drawing in a loop without clearing then shows its
      // most recent work rather than its first, which is the useful end.
      this.shapes.shift();
      this.dropped++;
    }
    this.shapes.push(shape);
    this.revision++;
    return this;
  }

  /**
   * @param {number} ax
   * @param {number} ay
   * @param {number} bx
   * @param {number} by
   * @param {string|number[]} [colour]
   * @param {number} [alpha]
   */
  line(ax, ay, bx, by, colour, alpha = 0.95) {
    if (!allFinite(ax, ay, bx, by)) return this;
    return this._push({ kind: 'line', ax, ay, bx, by, colour: resolve(colour), alpha });
  }

  /** A closed polyline through the points, as [x, y] pairs. */
  path(points, colour, alpha = 0.95) {
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1];
      const b = points[i];
      this.line(a[0], a[1], b[0], b[1], colour, alpha);
    }
    return this;
  }

  circle(x, y, radius, colour, alpha = 0.9) {
    if (!allFinite(x, y, radius) || radius <= 0) return this;
    const c = resolve(colour);
    let px = x + radius;
    let py = y;
    for (let i = 1; i <= CIRCLE_SEGMENTS; i++) {
      const a = (i / CIRCLE_SEGMENTS) * Math.PI * 2;
      const nx = x + Math.cos(a) * radius;
      const ny = y + Math.sin(a) * radius;
      this.line(px, py, nx, ny, c, alpha);
      px = nx;
      py = ny;
    }
    return this;
  }

  /** A cross, for a target or a waypoint. `size` is the arm length. */
  point(x, y, colour, size = 0.06) {
    if (!allFinite(x, y)) return this;
    const c = resolve(colour);
    this.line(x - size, y - size, x + size, y + size, c);
    this.line(x - size, y + size, x + size, y - size, c);
    return this;
  }

  /**
   * An arrow: where, and which way. `heading` in radians.
   *
   * Drawn as a shaft with two barbs rather than a triangle, because at the
   * scale a whole field is drawn at a filled triangle is four pixels and a
   * line is legible.
   */
  pose(x, y, heading, colour, length = 0.25) {
    if (!allFinite(x, y, heading)) return this;
    const c = resolve(colour);
    const tipX = x + Math.cos(heading) * length;
    const tipY = y + Math.sin(heading) * length;
    this.line(x, y, tipX, tipY, c);
    const barb = length * 0.32;
    for (const sweep of [2.6, -2.6]) {
      this.line(
        tipX,
        tipY,
        tipX + Math.cos(heading + sweep) * barb,
        tipY + Math.sin(heading + sweep) * barb,
        c,
      );
    }
    return this;
  }

  /** A word or two on the tiles, drawn by the 2D overlay. */
  text(x, y, text, colour, alpha = 1) {
    if (!allFinite(x, y)) return this;
    return this._push({
      kind: 'text',
      x,
      y,
      text: String(text).slice(0, 64),
      colour: resolve(colour),
      alpha,
    });
  }
}

/** A colour name, a `#rrggbb`, or an [r, g, b] in 0..1. */
function resolve(colour) {
  if (Array.isArray(colour) && colour.length >= 3) return colour.slice(0, 3).map(unit);
  if (typeof colour === 'string') {
    const named = DRAW_COLOURS[colour.toLowerCase()];
    if (named) return named;
    const hex = /^#?([0-9a-f]{6})$/i.exec(colour.trim());
    if (hex) {
      const value = parseInt(hex[1], 16);
      return [((value >> 16) & 255) / 255, ((value >> 8) & 255) / 255, (value & 255) / 255];
    }
  }
  return DEFAULT_COLOUR;
}

function unit(v) {
  return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0;
}

function allFinite(...values) {
  return values.every((v) => Number.isFinite(v));
}

/** A CSS colour for the 2D overlay, from a stored [r, g, b]. */
export function cssColour(colour, alpha = 1) {
  const [r, g, b] = colour;
  return `rgba(${Math.round(r * 255)}, ${Math.round(g * 255)}, ${Math.round(b * 255)}, ${alpha})`;
}
