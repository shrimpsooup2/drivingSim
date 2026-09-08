/**
 * The slash animation, drawn as pixel art.
 *
 * The reference screenshot is a filmstrip: five red strokes side by side, one
 * per frame, playing left to right. The stroke stabs in short, draws out
 * longer over the next two frames, curls into a hook, then breaks apart into
 * specks.
 *
 * Those strokes were traced out of the screenshot first, and this art was then
 * redrawn from the traces by hand on a grid at half their resolution. The
 * trace itself could not be used as art: the screenshot is a resized JPEG, so
 * its edges carry a pixel of wobble that reads as fuzz rather than as pixel
 * art. Redrawing squares that off -- every frame here is a stack of solid
 * rectangles, so every edge is a clean step and every run is deliberate --
 * while keeping each stroke's silhouette, its steps, and the gaps in it.
 *
 * Frames keep the top edge they had in the strip -- they all hang from the
 * same blade edge, and frames 4 and 5 start lower than the rest because that
 * is how they were drawn -- and are centred horizontally in the grid.
 *
 * Each frame is a list of rectangles `[topRow, bottomRow, leftCol, rightCol]`,
 * inclusive on all four sides. They may overlap; the frame is their union.
 */

/** Grid the frames are drawn on, in art pixels. */
export const WIDTH = 17;
export const HEIGHT = 74;

/** The stroke's colour, sampled from the middle of the strokes themselves. */
export const COLOR = { r: 0xfd, g: 0x64, b: 0x81, a: 0xff };

/** The five frames of the animation, first to last. */
const FRAMES = [
  // 1. The stab: a short stroke that swells in the middle and steps left as it
  //    tapers off.
  [
    [0, 6, 8, 10],
    [7, 18, 6, 10],
    [19, 25, 6, 8],
  ],
  // 2. Drawn out to twice the length, with the same swell and a wider step.
  [
    [1, 6, 9, 11],
    [7, 18, 7, 11],
    [19, 20, 7, 9],
    [21, 36, 4, 9],
    [37, 48, 7, 9],
  ],
  // 3. Full length: the tip has torn away from the stroke, which drifts right
  //    down its length and trails off in two steps.
  [
    [1, 8, 8, 10],
    [11, 21, 6, 8],
    [22, 43, 4, 8],
    [44, 49, 4, 10],
    [50, 64, 6, 10],
    [65, 70, 8, 10],
    [71, 73, 10, 12],
  ],
  // 4. The curl: the stroke thickens, bends right into a hook, and meets a
  //    piece that has broken off ahead of it.
  [
    [4, 7, 3, 5],
    [11, 15, 0, 2],
    [16, 24, 0, 5],
    [25, 27, 0, 7],
    [28, 32, 2, 7],
    [33, 34, 2, 9],
    [35, 35, 4, 10],
    [34, 35, 14, 16],
    [36, 36, 5, 16],
    [37, 38, 5, 13],
    [39, 40, 9, 12],
  ],
  // 5. Broken up: specks either side of what is left of the curl.
  [
    [1, 4, 14, 16],
    [6, 8, 0, 2],
    [8, 9, 5, 7],
    [8, 9, 11, 14],
    [10, 11, 2, 13],
    [12, 13, 2, 11],
    [14, 15, 5, 9],
  ],
];

/** Number of frames in the animation. */
export const FRAME_COUNT = FRAMES.length;

/** Rasterise frame `index` to a WIDTH x HEIGHT mask of 0/1 bytes. */
export function frameMask(index) {
  const mask = new Uint8Array(WIDTH * HEIGHT);
  for (const [top, bottom, left, right] of FRAMES[index]) {
    if (top < 0 || left < 0 || bottom >= HEIGHT || right >= WIDTH || top > bottom || left > right) {
      throw new Error(`slash frame ${index + 1} has a bad rectangle ${[top, bottom, left, right]}`);
    }
    for (let row = top; row <= bottom; row++) {
      for (let col = left; col <= right; col++) mask[row * WIDTH + col] = 1;
    }
  }
  return mask;
}

/** All frame masks, first to last. */
export function frameMasks() {
  return FRAMES.map((_, i) => frameMask(i));
}

/**
 * Spread the animation over `count` sheet frames, first to last.
 *
 * A sheet usually holds more frames than the slash has, so frames are held for
 * a beat or more; where a sheet holds fewer, frames are dropped evenly. Either
 * way the first is frame 1, the last is frame 5, and the order never goes
 * backwards.
 */
export function frameSequence(count) {
  if (count <= 0) return [];
  if (count === 1) return [0];
  const out = [];
  for (let i = 0; i < count; i++) {
    out.push(Math.round((i * (FRAME_COUNT - 1)) / (count - 1)));
  }
  return out;
}
