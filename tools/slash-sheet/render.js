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

/**
 * Turn a sprite 90 degrees clockwise, the way a packer stores a rotated frame.
 *
 * The engine turns it back counter-clockwise on the way out, so art has to go
 * in this way round to come out upright.
 */
export function rotateClockwise({ width, height, data }) {
  const out = { width: height, height: width, data: new Uint8Array(width * height * 4) };
  for (let y = 0; y < out.height; y++) {
    for (let x = 0; x < out.width; x++) {
      const from = ((height - 1 - x) * width + y) * 4;
      const to = (y * out.width + x) * 4;
      out.data[to] = data[from];
      out.data[to + 1] = data[from + 1];
      out.data[to + 2] = data[from + 2];
      out.data[to + 3] = data[from + 3];
    }
  }
  return out;
}

/** Turn a stored frame back: the counter-clockwise move the engine makes. */
export function rotateCounterClockwise({ width, height, data }) {
  const out = { width: height, height: width, data: new Uint8Array(width * height * 4) };
  for (let y = 0; y < out.height; y++) {
    for (let x = 0; x < out.width; x++) {
      const from = (x * width + (width - 1 - y)) * 4;
      const to = (y * out.width + x) * 4;
      out.data[to] = data[from];
      out.data[to + 1] = data[from + 1];
      out.data[to + 2] = data[from + 2];
      out.data[to + 3] = data[from + 3];
    }
  }
  return out;
}

/** Copy `src` into `dest` with its top-left corner at (x, y). */
export function blit(dest, src, x, y) {
  for (let sy = 0; sy < src.height; sy++) {
    const dy = y + sy;
    if (dy < 0 || dy >= dest.height) continue;
    for (let sx = 0; sx < src.width; sx++) {
      const dx = x + sx;
      if (dx < 0 || dx >= dest.width) continue;
      const from = (sy * src.width + sx) * 4;
      const to = (dy * dest.width + dx) * 4;
      dest.data[to] = src.data[from];
      dest.data[to + 1] = src.data[from + 1];
      dest.data[to + 2] = src.data[from + 2];
      dest.data[to + 3] = src.data[from + 3];
    }
  }
}

/** Cut a rectangle out of an image. */
export function crop(src, { x, y, w, h }) {
  const out = { width: w, height: h, data: new Uint8Array(w * h * 4) };
  for (let sy = 0; sy < h; sy++) {
    for (let sx = 0; sx < w; sx++) {
      const from = ((y + sy) * src.width + x + sx) * 4;
      const to = (sy * w + sx) * 4;
      out.data[to] = src.data[from];
      out.data[to + 1] = src.data[from + 1];
      out.data[to + 2] = src.data[from + 2];
      out.data[to + 3] = src.data[from + 3];
    }
  }
  return out;
}
