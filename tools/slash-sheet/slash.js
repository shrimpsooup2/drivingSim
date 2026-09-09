/**
 * The slash animation, drawn as pixel art.
 *
 * The reference screenshot is a filmstrip: five red strokes side by side, one
 * per frame, playing left to right. The stroke stabs in short, draws out
 * longer over the next two frames, curls into a hook, then breaks apart into
 * specks.
 *
 * Those strokes were traced out of the screenshot first, and this art was then
 * redrawn from the traces by hand, on a grid a sixth of their resolution. The
 * trace itself could not be used as art: the screenshot is a resized JPEG, so
 * its edges carry a pixel of wobble that reads as fuzz rather than as pixel
 * art, and its resolution is far finer than pixel art wants. Redrawing on a
 * coarse grid fixes both -- every frame here is a stack of solid rectangles,
 * so every edge is a clean step and every run is deliberate -- while keeping
 * each stroke's silhouette, its steps, and the gaps in it.
 *
 * At this size a stroke is one or two pixels wide and a speck is a single
 * pixel, which is the point: on a sheet frame around 530px across each pixel
 * lands about 19px square.
 *
 * Frames keep the top edge they had in the strip -- they all hang from the
 * same blade edge, and frames 4 and 5 start lower than the rest because that
 * is how they were drawn -- and are centred horizontally in the grid.
 *
 * Each frame is a list of rectangles `[topRow, bottomRow, leftCol, rightCol]`,
 * inclusive on all four sides. They may overlap; the frame is their union.
 */

/** Grid the frames are drawn on, in art pixels. */
export const WIDTH = 6;
export const HEIGHT = 25;

/**
 * The stroke's colour: a dark, fully saturated red.
 *
 * The screenshot's own strokes sample at #fd6481, which is the same hue but
 * pale -- 69% lightness makes it read pink rather than red. This keeps that
 * hue and takes the lightness down to 42% at full saturation, which lifts the
 * chroma from 0.60 to 0.84.
 */
export const COLOR = { r: 0xd6, g: 0x00, b: 0x29, a: 0xff };

/** The five frames of the animation, first to last. */
const FRAMES = [
  // 1. The stab: a short stroke that swells in the middle and steps left as it
  //    tapers off.
  [
    [0, 1, 3, 3],
    [2, 5, 2, 3],
    [6, 8, 2, 2],
  ],
  // 2. Drawn out to twice the length, with the same swell and a wider step.
  [
    [0, 2, 3, 3],
    [3, 6, 2, 3],
    [7, 11, 1, 2],
    [12, 15, 2, 2],
  ],
  // 3. Full length: the tip has torn away from the stroke, which drifts right
  //    down its length and trails off in two steps.
  [
    [1, 2, 3, 3],
    [4, 7, 2, 2],
    [8, 14, 1, 2],
    [15, 15, 1, 3],
    [16, 21, 2, 3],
    [22, 23, 3, 3],
    [24, 24, 3, 4],
  ],
  // 4. The curl: the stroke thickens, bends right into a hook, and meets a
  //    piece that has broken off ahead of it.
  [
    [1, 2, 1, 1],
    [4, 4, 0, 0],
    [5, 8, 0, 1],
    [9, 9, 0, 2],
    [10, 11, 1, 2],
    [11, 11, 5, 5],
    [12, 12, 2, 5],
    [13, 13, 3, 4],
  ],
  // 5. Broken up: specks either side of what is left of the curl. The tip that
  //    has run furthest ahead is down to a single pixel.
  [
    [1, 1, 5, 5],
    [2, 2, 0, 0],
    [3, 3, 2, 2],
    [3, 3, 4, 4],
    [4, 4, 1, 4],
    [5, 5, 2, 3],
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
