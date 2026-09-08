/**
 * The slash effect, drawn as pixel art.
 *
 * The reference screenshot shows one moment of the effect: four vertical
 * streaks of increasing length (the blade trail), a hook curling to the right
 * below the fourth streak, and a small chevron of specks trailing off to the
 * upper right. Every stage below is built from those same elements at the same
 * columns, so the sequence reads as one effect: the streaks stab in and grow,
 * reach the pose in the screenshot, then tear loose from the top and fall away
 * until only a few specks are left.
 *
 * Art is stored as vertical runs `[column, topRow, bottomRow]` on a fixed
 * WIDTH x HEIGHT grid; a single-pixel dot is a run whose rows are equal. The
 * grid is fixed rather than trimmed per stage so the effect does not jitter
 * when the frames are centred on the explosion sheet.
 */

/** Grid the art is authored on, in art pixels. */
export const WIDTH = 28;
export const HEIGHT = 22;

/** Flat rose-pink of the reference screenshot; the art uses no other colour. */
export const COLOR = { r: 0xf9, g: 0x56, b: 0x6c, a: 0xff };

/**
 * Stages of the effect, first to last. Stage 4 is the pose in the screenshot.
 */
const STAGES = [
  // 1. The blade lands: four short nubs and the chevron's inner pair.
  [
    [0, 0, 0],
    [4, 0, 1],
    [9, 0, 2],
    [15, 0, 0],
    [23, 0, 0], [24, 0, 0],
  ],
  // 2. Streaks draw downward; the hook starts under the fourth streak.
  [
    [0, 0, 2],
    [4, 0, 4],
    [9, 0, 6],
    [15, 0, 1], [15, 4, 5],
    [22, 0, 0], [25, 0, 0], [23, 1, 1], [24, 1, 1],
  ],
  // 3. Nearly full extension; the chevron opens out.
  [
    [0, 0, 4],
    [4, 0, 7],
    [9, 0, 9],
    [15, 0, 1], [15, 4, 7],
    [21, 0, 0], [26, 0, 0], [22, 1, 1], [25, 1, 1], [23, 2, 2],
  ],
  // 4. The screenshot pose: streaks at full length, hook curled right, chevron
  //    complete, with the longest streak stepping right as it drips.
  [
    [0, 0, 5],
    [4, 0, 10],
    [9, 0, 11], [10, 11, 18],
    [15, 0, 1], [15, 4, 9], [16, 9, 10], [17, 10, 10], [19, 10, 10],
    [21, 0, 0], [26, 0, 0], [22, 1, 1], [25, 1, 1], [23, 2, 2], [24, 2, 2],
  ],
  // 5. The trail lets go of the blade edge: the whole curtain drops a row and
  //    the tops start to clear.
  [
    [0, 3, 6],
    [4, 3, 11],
    [9, 3, 12], [10, 12, 19],
    [15, 2, 2], [15, 7, 10], [16, 10, 11], [17, 11, 11], [19, 11, 11],
    [21, 1, 1], [26, 1, 1], [22, 2, 2], [25, 2, 2], [23, 3, 3], [24, 3, 3],
  ],
  // 6. Falling and eaten away from the top; the hook has lost its stem.
  [
    [0, 7, 7],
    [4, 7, 12],
    [9, 7, 13], [10, 13, 20],
    [15, 11, 11], [16, 11, 12], [17, 12, 12], [19, 12, 12],
    [22, 3, 3], [25, 3, 3], [23, 4, 4], [24, 4, 4],
  ],
  // 7. Only the heavy end of each drip is still falling.
  [
    [4, 13, 14],
    [9, 13, 15], [10, 15, 21],
    [16, 14, 14], [17, 14, 14],
    [23, 6, 6], [24, 6, 6],
  ],
  // 8. Last specks before the effect is gone.
  [
    [4, 16, 16],
    [10, 19, 21],
    [17, 15, 15],
  ],
];

/** Number of authored stages. */
export const STAGE_COUNT = STAGES.length;

/**
 * Rasterise stage `index` to a WIDTH x HEIGHT mask of 0/1 bytes.
 */
export function stageMask(index) {
  const mask = new Uint8Array(WIDTH * HEIGHT);
  for (const [col, top, bottom] of STAGES[index]) {
    for (let row = top; row <= bottom; row++) {
      if (col < 0 || col >= WIDTH || row < 0 || row >= HEIGHT) {
        throw new Error(`slash stage ${index + 1} draws outside the ${WIDTH}x${HEIGHT} grid at ${col},${row}`);
      }
      mask[row * WIDTH + col] = 1;
    }
  }
  return mask;
}

/** All stage masks, first to last. */
export function stageMasks() {
  return STAGES.map((_, i) => stageMask(i));
}

/**
 * Spread `count` frames over the authored stages, first to last.
 *
 * A sheet usually has more frames than the slash has stages, so stages are
 * held for a frame or more; where a sheet has fewer, stages are dropped
 * evenly. Either way the first frame is stage 1 and the last is the final
 * stage, and the order never goes backwards.
 */
export function stageSequence(count) {
  if (count <= 0) return [];
  if (count === 1) return [0];
  const out = [];
  for (let i = 0; i < count; i++) {
    out.push(Math.round((i * (STAGE_COUNT - 1)) / (count - 1)));
  }
  return out;
}
