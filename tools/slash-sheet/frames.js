/**
 * Finding the frames in an explosion sheet, and working out what order they
 * play in.
 *
 * The sheet is not a tidy grid: the blobs sit at irregular spacings, some cells
 * are empty, and each blob is itself a scatter of disconnected chunks and
 * specks. So instead of assuming a grid, this clusters the drawn pixels: it
 * buckets them into coarse cells, spreads each cell outwards far enough to
 * bridge the gaps inside one blob but not the gaps between blobs, and treats
 * each connected island as one frame.
 */

/**
 * Decide which pixels count as drawn.
 *
 * A sheet exported with transparency is easy: alpha decides. One flattened onto
 * a white background is not, so fall back to "anything that is not near-white".
 */
export function inkMask(img, { alphaThreshold = 24, whiteThreshold = 238 } = {}) {
  const { width, height, data } = img;
  const total = width * height;
  let translucent = 0;
  for (let i = 3; i < data.length; i += 4) if (data[i] < 250) translucent++;
  const useAlpha = translucent > total * 0.001;

  const mask = new Uint8Array(total);
  let ink = 0;
  for (let i = 0; i < total; i++) {
    const at = i * 4;
    const a = data[at + 3];
    let drawn;
    if (useAlpha) {
      drawn = a > alphaThreshold;
    } else {
      const r = data[at];
      const g = data[at + 1];
      const b = data[at + 2];
      const max = Math.max(r, g, b);
      const min = Math.min(r, g, b);
      drawn = min < whiteThreshold || max - min > 12;
    }
    if (drawn) {
      mask[i] = 1;
      ink++;
    }
  }
  return { mask, ink, background: useAlpha ? 'alpha' : 'white' };
}

/**
 * Chebyshev distance from every cell to the nearest occupied one.
 *
 * Computing this once lets the sheet be re-clustered at any bridging distance
 * for the cost of a threshold, which is what makes the search below cheap.
 */
function distanceTransform(grid, gw, gh) {
  const far = gw + gh;
  const dist = new Int32Array(gw * gh);
  for (let i = 0; i < grid.length; i++) dist[i] = grid[i] ? 0 : far;
  const relax = (at, from) => {
    if (dist[from] + 1 < dist[at]) dist[at] = dist[from] + 1;
  };
  for (let y = 0; y < gh; y++) {
    for (let x = 0; x < gw; x++) {
      const at = y * gw + x;
      if (!dist[at]) continue;
      if (x > 0) relax(at, at - 1);
      if (y > 0) {
        relax(at, at - gw);
        if (x > 0) relax(at, at - gw - 1);
        if (x < gw - 1) relax(at, at - gw + 1);
      }
    }
  }
  for (let y = gh - 1; y >= 0; y--) {
    for (let x = gw - 1; x >= 0; x--) {
      const at = y * gw + x;
      if (!dist[at]) continue;
      if (x < gw - 1) relax(at, at + 1);
      if (y < gh - 1) {
        relax(at, at + gw);
        if (x < gw - 1) relax(at, at + gw + 1);
        if (x > 0) relax(at, at + gw - 1);
      }
    }
  }
  return dist;
}

/** Label 8-connected islands of a 0/1 grid; 0 means empty. */
function label(grid, gw, gh) {
  const labels = new Int32Array(gw * gh);
  const stack = [];
  let next = 0;
  for (let start = 0; start < grid.length; start++) {
    if (!grid[start] || labels[start]) continue;
    next++;
    labels[start] = next;
    stack.push(start);
    while (stack.length) {
      const at = stack.pop();
      const x = at % gw;
      const y = (at - x) / gw;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= gw || ny >= gh) continue;
          const to = ny * gw + nx;
          if (!grid[to] || labels[to]) continue;
          labels[to] = next;
          stack.push(to);
        }
      }
    }
  }
  return { labels, count: next };
}

/** Cells within `radius` of something drawn, as a 0/1 grid. */
function threshold(dist, radius) {
  const grid = new Uint8Array(dist.length);
  for (let i = 0; i < dist.length; i++) grid[i] = dist[i] <= radius ? 1 : 0;
  return grid;
}

/**
 * Pick the bridging distance on the sheet's own evidence.
 *
 * Widen the bridge one step at a time and the island count falls in stages:
 * a scatter of specks at first, then a long plateau where every island is
 * exactly one frame, then a collapse to one blob. The plateau is the answer,
 * so take the longest one and sit in the middle of it.
 */
function chooseRadius(dist, gw, gh, maxRadius) {
  const runs = [];
  for (let r = 1; r <= maxRadius; r++) {
    const { count } = label(threshold(dist, r), gw, gh);
    const run = runs[runs.length - 1];
    if (run && run.count === count) run.to = r;
    else runs.push({ count, from: r, to: r });
  }
  const length = (run) => run.to - run.from + 1;
  const multi = runs.filter((run) => run.count > 1);
  const best = multi.reduce((a, b) => (b && length(b) > length(a) ? b : a), multi[0]);
  if (!best || length(best) < 3) return maxRadius;
  return Math.round((best.from + best.to) / 2);
}

/**
 * Locate every frame drawn on the sheet.
 *
 * `gap` overrides the bridging distance, as a fraction of the sheet's long
 * edge; left at 0 the distance is chosen from the sheet itself.
 */
export function detectFrames(img, { gap = 0, minInkFraction = 0.02 } = {}) {
  const { width, height } = img;
  const { mask, background } = inkMask(img);

  const cell = Math.max(1, Math.round(Math.min(width, height) / 400));
  const gw = Math.ceil(width / cell);
  const gh = Math.ceil(height / cell);
  const occ = new Uint8Array(gw * gh);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (mask[y * width + x]) occ[Math.floor(y / cell) * gw + Math.floor(x / cell)] = 1;
    }
  }

  const dist = distanceTransform(occ, gw, gh);
  const maxRadius = Math.max(3, Math.round(0.09 * Math.max(gw, gh)));
  const radius = gap > 0
    ? Math.max(1, Math.round(gap * Math.max(gw, gh)))
    : chooseRadius(dist, gw, gh, maxRadius);

  const { labels, count } = label(threshold(dist, radius), gw, gh);
  if (!count) throw new Error('no drawn pixels found in the sheet');

  const boxes = Array.from({ length: count + 1 }, () => ({
    x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity, ink: 0,
  }));
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!mask[y * width + x]) continue;
      const id = labels[Math.floor(y / cell) * gw + Math.floor(x / cell)];
      const box = boxes[id];
      if (x < box.x0) box.x0 = x;
      if (y < box.y0) box.y0 = y;
      if (x > box.x1) box.x1 = x;
      if (y > box.y1) box.y1 = y;
      box.ink++;
    }
  }

  const biggest = boxes.reduce((max, box) => Math.max(max, box.ink), 0);
  const frames = [];
  for (let id = 1; id <= count; id++) {
    const box = boxes[id];
    if (box.ink < biggest * minInkFraction) continue;
    const w = box.x1 - box.x0 + 1;
    const h = box.y1 - box.y0 + 1;
    frames.push({
      x0: box.x0,
      y0: box.y0,
      x1: box.x1,
      y1: box.y1,
      w,
      h,
      cx: (box.x0 + box.x1 + 1) / 2,
      cy: (box.y0 + box.y1 + 1) / 2,
      ink: box.ink,
      radius: Math.sqrt(w * h),
      density: box.ink / (w * h),
    });
  }
  if (!frames.length) throw new Error('every candidate frame was rejected as noise; try a smaller --gap');
  return { frames, background, cell, radius };
}

/** Reading order: top-to-bottom in rows, left-to-right within each row. */
function readingOrder(frames) {
  const heights = frames.map((f) => f.h).sort((a, b) => a - b);
  const tolerance = heights[heights.length >> 1] * 0.5;
  const rows = [];
  for (const frame of [...frames].sort((a, b) => a.cy - b.cy)) {
    const row = rows[rows.length - 1];
    if (row && Math.abs(frame.cy - row.cy) <= tolerance) row.items.push(frame);
    else rows.push({ cy: frame.cy, items: [frame] });
  }
  return rows.flatMap((row) => row.items.sort((a, b) => a.cx - b.cx));
}

/**
 * Order the frames first to last.
 *
 * `stage` reads the explosion itself rather than the layout, which is what the
 * sheet actually needs: a blast starts small and solid and ends wide and
 * threadbare, so `radius x (1 - density)` rises steadily from the first frame
 * to the last. `grid` and `grid-reverse` fall back to plain reading order, and
 * an explicit comma-separated list of 1-based indices overrides everything.
 */
export function orderFrames(frames, order = 'stage') {
  if (Array.isArray(order)) {
    if (order.length !== frames.length) {
      throw new Error(`--order lists ${order.length} frames but ${frames.length} were found`);
    }
    return order.map((n) => {
      const frame = frames[n - 1];
      if (!frame) throw new Error(`--order refers to frame ${n}, which does not exist`);
      return frame;
    });
  }
  if (order === 'grid') return readingOrder(frames);
  if (order === 'grid-reverse') return readingOrder(frames).reverse();
  if (order !== 'stage') throw new Error(`unknown --order "${order}"`);

  const widest = frames.reduce((max, f) => Math.max(max, f.radius), 1);
  return [...frames]
    .map((frame) => ({ frame, score: (frame.radius / widest) * (1 - frame.density) }))
    .sort((a, b) => a.score - b.score || a.frame.cy - b.frame.cy || a.frame.cx - b.frame.cx)
    .map((entry) => entry.frame);
}
