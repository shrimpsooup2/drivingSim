/**
 * Painting slash frames onto a sheet.
 *
 * Everything here works in whole art pixels. A frame is scaled by an integer
 * factor and its corner is snapped to a whole number of art pixels from the
 * sheet's origin, so every frame on a sheet shares one grid: same block size,
 * same phase, no frame offset from its neighbours by part of a block.
 */
import { COLOR, HEIGHT, WIDTH } from './slash.js';

/** A blank RGBA canvas: transparent, or opaque white to match a flattened sheet. */
export function blankCanvas(width, height, background) {
  const data = new Uint8Array(width * height * 4);
  if (background === 'white') data.fill(255);
  return { width, height, data };
}

/**
 * Where frame `mask` lands when centred as near (cx, cy) as the grid allows.
 *
 * Snapping moves a frame by less than half an art pixel, which is nothing
 * against the size of a frame, and is what keeps the sheet on one grid.
 */
export function snapCorner(scale, cx, cy) {
  return {
    left: Math.round((cx - (WIDTH * scale) / 2) / scale) * scale,
    top: Math.round((cy - (HEIGHT * scale) / 2) / scale) * scale,
  };
}

/** Stamp one slash frame, nearest-neighbour scaled, centred near (cx, cy). */
export function stampFrame(canvas, mask, scale, cx, cy) {
  const { left, top } = snapCorner(scale, cx, cy);
  for (let row = 0; row < HEIGHT; row++) {
    for (let col = 0; col < WIDTH; col++) {
      if (!mask[row * WIDTH + col]) continue;
      for (let dy = 0; dy < scale; dy++) {
        const y = top + row * scale + dy;
        if (y < 0 || y >= canvas.height) continue;
        for (let dx = 0; dx < scale; dx++) {
          const x = left + col * scale + dx;
          if (x < 0 || x >= canvas.width) continue;
          const at = (y * canvas.width + x) * 4;
          canvas.data[at] = COLOR.r;
          canvas.data[at + 1] = COLOR.g;
          canvas.data[at + 2] = COLOR.b;
          canvas.data[at + 3] = COLOR.a;
        }
      }
    }
  }
}
