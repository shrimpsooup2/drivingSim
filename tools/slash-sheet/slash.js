/**
 * The slash animation, traced from the reference screenshot.
 *
 * The screenshot is a filmstrip: five red strokes side by side, one per frame,
 * playing left to right. The stroke stabs in short, draws out longer over the
 * next two frames, curls into a hook, then breaks apart into specks.
 *
 * The art here is not a redrawing of that -- it is the screenshot's own
 * silhouettes. Each frame was cut out of the strip at full resolution and
 * stored verbatim as vertical runs `[column, topRow, bottomRow]` on a shared
 * WIDTH x HEIGHT grid, so what plays back is exactly what was drawn.
 *
 * Frames keep the top edge they had in the strip -- they all hang from the
 * same blade edge, and frames 4 and 5 start lower than the rest because that
 * is how they were drawn -- and are centred horizontally in the grid.
 */

/** Grid the frames were traced onto, one cell per screenshot pixel. */
export const WIDTH = 33;
export const HEIGHT = 148;

/** The stroke's colour, sampled from the middle of the strokes themselves. */
export const COLOR = { r: 0xfd, g: 0x64, b: 0x81, a: 0xff };

/** The five frames of the animation, first to last. */
const FRAMES = [
  // Frame 1
  [
    [12, 14, 50], [13, 14, 50], [14, 14, 50], [15, 14, 50], [16, 13, 50], [17, 1, 50], [18, 1, 36],
    [19, 0, 36], [20, 0, 36], [21, 1, 36],
  ],
  // Frame 2
  [
    [9, 43, 68], [9, 71, 72], [10, 42, 74], [11, 42, 74], [12, 42, 74], [13, 42, 74], [14, 15, 97],
    [15, 15, 96], [16, 15, 97], [17, 15, 97], [18, 2, 96], [19, 2, 39], [19, 51, 97], [20, 2, 38],
    [21, 2, 38], [22, 2, 38], [23, 2, 38],
  ],
  // Frame 3
  [
    [8, 43, 98], [9, 43, 98], [10, 43, 98], [11, 43, 98], [12, 21, 129], [13, 21, 129],
    [14, 21, 129], [15, 21, 129], [16, 3, 16], [16, 21, 130], [17, 3, 17], [17, 22, 142],
    [18, 3, 17], [18, 89, 142], [19, 3, 17], [19, 89, 142], [20, 3, 17], [20, 88, 142],
    [21, 3, 17], [21, 89, 146], [22, 90, 90], [22, 142, 147], [23, 143, 147], [24, 143, 147],
    [25, 143, 146],
  ],
  // Frame 4
  [
    [0, 23, 25], [0, 30, 50], [0, 52, 53], [1, 23, 54], [2, 23, 55], [3, 23, 55], [4, 23, 55],
    [5, 10, 10], [5, 12, 14], [5, 23, 68], [6, 9, 14], [6, 31, 68], [7, 9, 14], [7, 32, 68],
    [8, 9, 14], [8, 31, 68], [9, 9, 15], [9, 32, 69], [10, 9, 14], [10, 32, 77], [11, 49, 77],
    [12, 49, 77], [13, 49, 77], [14, 49, 77], [15, 51, 55], [15, 67, 77], [16, 67, 77],
    [17, 67, 77], [18, 67, 77], [19, 67, 81], [20, 71, 81], [21, 72, 81], [22, 72, 81],
    [23, 72, 79], [24, 72, 78], [25, 72, 77], [26, 72, 76], [27, 71, 76], [28, 68, 73],
    [28, 75, 75], [29, 68, 72], [30, 68, 72], [31, 68, 72], [32, 69, 72],
  ],
  // Frame 5
  [
    [0, 13, 13], [0, 15, 16], [1, 13, 17], [2, 12, 17], [3, 12, 17], [4, 12, 17], [5, 13, 17],
    [5, 21, 25], [6, 21, 26], [7, 21, 26], [8, 21, 26], [9, 21, 26], [10, 17, 29], [11, 17, 30],
    [12, 17, 30], [13, 17, 30], [14, 17, 30], [15, 18, 18], [15, 20, 30], [16, 21, 30],
    [17, 21, 30], [18, 21, 30], [19, 21, 27], [20, 21, 26], [21, 21, 26], [22, 21, 26],
    [23, 18, 26], [24, 17, 22], [25, 17, 21], [26, 17, 21], [27, 17, 21], [28, 3, 8], [28, 18, 20],
    [29, 3, 8], [30, 3, 8], [31, 3, 8], [32, 3, 8],
  ],
];

/** Number of frames in the animation. */
export const FRAME_COUNT = FRAMES.length;

/** Rasterise frame `index` to a WIDTH x HEIGHT mask of 0/1 bytes. */
export function frameMask(index) {
  const mask = new Uint8Array(WIDTH * HEIGHT);
  for (const [col, top, bottom] of FRAMES[index]) {
    for (let row = top; row <= bottom; row++) {
      if (col < 0 || col >= WIDTH || row < 0 || row >= HEIGHT) {
        throw new Error(`slash frame ${index + 1} draws outside the ${WIDTH}x${HEIGHT} grid at ${col},${row}`);
      }
      mask[row * WIDTH + col] = 1;
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
