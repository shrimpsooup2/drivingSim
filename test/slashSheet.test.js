import test from 'node:test';
import assert from 'node:assert/strict';
import { decodePng, encodePng } from '../tools/slash-sheet/png.js';
import { detectFrames, gridSeeds, orderFrames, partitionFrames } from '../tools/slash-sheet/frames.js';
import { FRAME_COUNT, HEIGHT, WIDTH, frameMask, frameMasks, frameSequence } from '../tools/slash-sheet/slash.js';
import { blankCanvas, snapCorner, stampFrame } from '../tools/slash-sheet/render.js';

/** A blank RGBA image. */
function canvas(width, height, fill = 0) {
  const data = new Uint8Array(width * height * 4);
  if (fill) data.fill(fill);
  return { width, height, data };
}

/** Paint an opaque disc, so tests can lay out sheets the way the real one is. */
function disc(img, cx, cy, radius, [r, g, b]) {
  for (let y = Math.max(0, cy - radius); y <= Math.min(img.height - 1, cy + radius); y++) {
    for (let x = Math.max(0, cx - radius); x <= Math.min(img.width - 1, cx + radius); x++) {
      if ((x - cx) ** 2 + (y - cy) ** 2 > radius * radius) continue;
      const at = (y * img.width + x) * 4;
      img.data[at] = r;
      img.data[at + 1] = g;
      img.data[at + 2] = b;
      img.data[at + 3] = 255;
    }
  }
}

/** A ring of chunks: `density` picks between a solid blob and a threadbare one. */
function blob(img, cx, cy, radius, density) {
  const chunks = 24;
  for (let i = 0; i < chunks; i++) {
    const angle = (i / chunks) * Math.PI * 2;
    disc(img, Math.round(cx + Math.cos(angle) * radius * 0.8), Math.round(cy + Math.sin(angle) * radius * 0.8),
      Math.round(radius * 0.18), [90, 200, 90]);
  }
  if (density > 0.5) disc(img, cx, cy, Math.round(radius * 0.7), [90, 200, 90]);
}

test('PNG encoding round-trips every pixel', () => {
  const img = canvas(37, 23);
  for (let i = 0; i < img.data.length; i++) img.data[i] = (i * 37) & 0xff;
  const back = decodePng(encodePng(img));
  assert.equal(back.width, img.width);
  assert.equal(back.height, img.height);
  assert.deepEqual(Array.from(back.data), Array.from(img.data));
});

test('every slash frame stays inside the art grid and none is empty', () => {
  for (let i = 0; i < FRAME_COUNT; i++) {
    const mask = frameMask(i);
    assert.equal(mask.length, WIDTH * HEIGHT);
    assert.ok(mask.some((on) => on), `frame ${i + 1} drew nothing`);
  }
});

test('the drawn frames hold the ink they were drawn with', () => {
  // The strip's five strokes, in the order they play. Guards the rectangles
  // against an edit that silently drops or duplicates part of a frame.
  const ink = frameMasks().map((mask) => mask.reduce((total, on) => total + on, 0));
  assert.deepEqual(ink, [13, 25, 39, 25, 13]);
});

test('the art has exactly the lone pixels it means to have', () => {
  // The grid is coarse enough that a stroke is one or two pixels wide, so a
  // pixel standing alone is no longer proof of a stray -- frame 5 breaks up
  // into specks and one of them is meant to be a single pixel. Pinning the
  // count per frame still catches a stray introduced by an edit.
  const lone = frameMasks().map((mask) => {
    const on = (x, y) => (x < 0 || y < 0 || x >= WIDTH || y >= HEIGHT ? 0 : mask[y * WIDTH + x]);
    let count = 0;
    for (let y = 0; y < HEIGHT; y++) {
      for (let x = 0; x < WIDTH; x++) {
        if (!on(x, y)) continue;
        if (!on(x - 1, y) && !on(x + 1, y) && !on(x, y - 1) && !on(x, y + 1)) count++;
      }
    }
    return count;
  });
  assert.deepEqual(lone, [0, 0, 0, 0, 1]);
});

test('the grid is coarse enough that a sheet frame gets big blocks', () => {
  // What makes it read as pixel art: on a frame the size of the ones on
  // PlayerExplosion_03-uhd.png, one art pixel is a chunky block, not a speck.
  const frameSize = 530;
  const scale = Math.floor((0.9 * frameSize) / HEIGHT);
  assert.ok(scale >= 15, `art pixels would land at only ${scale}px on a ${frameSize}px frame`);
});

test('frames spread over a sheet without ever going backwards', () => {
  for (const count of [1, 4, FRAME_COUNT, 12, 40]) {
    const sequence = frameSequence(count);
    assert.equal(sequence.length, count);
    assert.equal(sequence[0], 0);
    assert.equal(sequence[count - 1], count === 1 ? 0 : FRAME_COUNT - 1);
    for (let i = 1; i < sequence.length; i++) {
      assert.ok(sequence[i] >= sequence[i - 1], 'frame order went backwards');
    }
  }
});

test('frames are found as separate blobs, not as one merged island', () => {
  const sheet = canvas(900, 600, 255);
  const centres = [[150, 150], [450, 150], [750, 150], [150, 450], [450, 450], [750, 450]];
  centres.forEach(([cx, cy], i) => blob(sheet, cx, cy, 60 + i * 10, i < 2 ? 1 : 0));

  const { frames, background } = detectFrames(sheet);
  assert.equal(background, 'white');
  assert.equal(frames.length, centres.length);
  for (const [cx, cy] of centres) {
    assert.ok(
      frames.some((f) => Math.abs(f.cx - cx) < 12 && Math.abs(f.cy - cy) < 12),
      `no frame found near ${cx},${cy}`,
    );
  }
});

test('a transparent sheet is read from its alpha, not its colour', () => {
  const sheet = canvas(600, 300);
  blob(sheet, 150, 150, 70, 1);
  blob(sheet, 450, 150, 70, 0);
  const { frames, background } = detectFrames(sheet);
  assert.equal(background, 'alpha');
  assert.equal(frames.length, 2);
});

test('stage order runs from the small solid blast to the wide threadbare one', () => {
  const sheet = canvas(900, 300, 255);
  // Laid out deliberately against play order, so ordering cannot pass by luck.
  blob(sheet, 150, 150, 110, 0);
  blob(sheet, 450, 150, 80, 0);
  blob(sheet, 750, 150, 50, 1);

  const { frames } = detectFrames(sheet);
  const ordered = orderFrames(frames, 'stage');
  assert.equal(ordered.length, 3);
  assert.ok(ordered[0].cx > ordered[2].cx, 'the dense blob should play first');
  for (let i = 1; i < ordered.length; i++) {
    assert.ok(ordered[i].radius >= ordered[i - 1].radius, 'the blast should not shrink as it plays');
  }
});

test('reading order and an explicit order override the heuristic', () => {
  const sheet = canvas(900, 600, 255);
  const centres = [[150, 150], [450, 150], [750, 150], [150, 450]];
  centres.forEach(([cx, cy]) => blob(sheet, cx, cy, 70, 0));

  const { frames } = detectFrames(sheet);
  const grid = orderFrames(frames, 'grid').map((f) => [Math.round(f.cx), Math.round(f.cy)]);
  assert.deepEqual(grid.map(([, cy]) => cy < 300), [true, true, true, false]);
  assert.ok(grid[0][0] < grid[1][0] && grid[1][0] < grid[2][0], 'top row should read left to right');

  assert.deepEqual(
    orderFrames(frames, 'grid-reverse').map((f) => Math.round(f.cx)),
    orderFrames(frames, 'grid').map((f) => Math.round(f.cx)).reverse(),
  );
  assert.deepEqual(orderFrames(frames, [2, 1, 4, 3]), [frames[1], frames[0], frames[3], frames[2]]);
  assert.throws(() => orderFrames(frames, [1, 2]), /lists 2 frames/);
});

test('touching blobs are split by their frame centres, not by bridging', () => {
  // Two blobs close enough that any bridging distance merges them.
  const sheet = canvas(600, 300, 255);
  blob(sheet, 180, 150, 90, 1);
  blob(sheet, 330, 150, 90, 1);
  assert.equal(detectFrames(sheet).frames.length, 1, 'fixture should defeat the bridging clusterer');

  const { frames } = partitionFrames(sheet, [[180, 150], [330, 150]]);
  assert.equal(frames.length, 2);
  assert.ok(Math.abs(frames[0].cx - 180) < 25 && Math.abs(frames[1].cx - 330) < 25);
  assert.ok(frames[0].x1 < frames[1].x0 + 40, 'the split should fall between the blobs');
});

test('a frame box ignores a stray speck from its neighbour', () => {
  const sheet = canvas(600, 300, 255);
  blob(sheet, 300, 150, 70, 1);
  disc(sheet, 560, 40, 3, [90, 200, 90]); // bleed: far away, and tiny
  const [loose] = partitionFrames(sheet, [[300, 150]], { trim: 0 }).frames;
  const [tight] = partitionFrames(sheet, [[300, 150]]).frames;
  assert.ok(loose.x1 > 500, 'an untrimmed box should stretch to the speck');
  assert.ok(tight.x1 < 400, 'the trimmed box should stay on the blob');
});

test('a grid of frame centres covers the sheet evenly', () => {
  const seeds = gridSeeds({ width: 600, height: 400 }, 3, 2);
  assert.deepEqual(seeds, [[100, 100], [300, 100], [500, 100], [100, 300], [300, 300], [500, 300]]);
});

test('a frame lands on the sheet grid whatever centre it is given', () => {
  const scale = 7;
  for (const cx of [0, 1, 100.5, 617, 1859.5]) {
    for (const cy of [0, 3, 250.5, 1727]) {
      const { left, top } = snapCorner(scale, cx, cy);
      assert.ok(left % scale === 0, `left ${left} is off the grid for centre ${cx},${cy}`);
      assert.ok(top % scale === 0, `top ${top} is off the grid for centre ${cx},${cy}`);
      // Snapping must not shove the frame off its blob.
      assert.ok(Math.abs(left + (WIDTH * scale) / 2 - cx) <= scale / 2);
      assert.ok(Math.abs(top + (HEIGHT * scale) / 2 - cy) <= scale / 2);
    }
  }
});

test('every block on a rebuilt sheet is one size and one grid', () => {
  // Centres deliberately off the grid and off each other's phase: before the
  // corners were snapped, each frame landed on a lattice of its own.
  const scale = 7;
  const canvas = blankCanvas(1200, 700, 'alpha');
  const art = frameMasks();
  [[201, 353], [604, 348.5], [1002.5, 351]].forEach(([cx, cy], i) => {
    stampFrame(canvas, art[i], scale, cx, cy);
  });

  const on = (x, y) => canvas.data[(y * canvas.width + x) * 4 + 3] > 0;
  const runs = [];
  for (let y = 0; y < canvas.height; y++) {
    let start = -1;
    for (let x = 0; x <= canvas.width; x++) {
      const ink = x < canvas.width && on(x, y);
      if (ink && start < 0) start = x;
      else if (!ink && start >= 0) { runs.push([start, x - start]); start = -1; }
    }
  }
  for (let x = 0; x < canvas.width; x++) {
    let start = -1;
    for (let y = 0; y <= canvas.height; y++) {
      const ink = y < canvas.height && on(x, y);
      if (ink && start < 0) start = y;
      else if (!ink && start >= 0) { runs.push([start, y - start]); start = -1; }
    }
  }

  assert.ok(runs.length > 50, 'expected the frames to actually draw something');
  for (const [start, length] of runs) {
    assert.ok(start % scale === 0, `a run starts at ${start}, off the ${scale}px grid`);
    assert.ok(length % scale === 0, `a run is ${length}px, not a whole number of blocks`);
  }
});

test('the rebuilt sheet keeps its size and puts a slash on every frame', () => {
  const sheet = canvas(1200, 700, 255);
  const centres = [[200, 350], [600, 350], [1000, 350]];
  centres.forEach(([cx, cy], i) => blob(sheet, cx, cy, 120, i === 0 ? 1 : 0));

  const { frames } = detectFrames(sheet);
  const ordered = orderFrames(frames);
  assert.equal(ordered.length, centres.length);

  const art = frameMasks();
  const playing = frameSequence(ordered.length);
  const out = blankCanvas(sheet.width, sheet.height, 'white');
  ordered.forEach((frame, i) => stampFrame(out, art[playing[i]], 4, frame.cx, frame.cy));

  const back = decodePng(encodePng(out));
  assert.equal(back.width, sheet.width);
  assert.equal(back.height, sheet.height);
  const drawn = partitionFrames(back, centres).frames;
  assert.equal(drawn.length, centres.length);
  drawn.forEach((frame, i) => {
    assert.ok(frame.ink > 0, `nothing drawn near ${centres[i]}`);
    assert.ok(Math.abs(frame.cx - centres[i][0]) < WIDTH * 4, 'slash drifted off its blob');
  });
});
