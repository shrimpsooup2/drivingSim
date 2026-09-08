import test from 'node:test';
import assert from 'node:assert/strict';
import { decodePng, encodePng } from '../tools/slash-sheet/png.js';
import { detectFrames, gridSeeds, orderFrames, partitionFrames } from '../tools/slash-sheet/frames.js';
import { FRAME_COUNT, HEIGHT, WIDTH, frameMask, frameMasks, frameSequence } from '../tools/slash-sheet/slash.js';

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

test('the traced frames still hold the ink they were cut from the screenshot with', () => {
  // The strip's five strokes, in the order they play. Guards the run data
  // against an edit that silently drops or duplicates part of a frame.
  const ink = frameMasks().map((mask) => mask.reduce((total, on) => total + on, 0));
  assert.deepEqual(ink, [382, 819, 1222, 704, 259]);
  assert.equal(ink.reduce((a, b) => a + b, 0), 3386);
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

test('the rebuilt sheet keeps its size and puts a slash on every frame', () => {
  const sheet = canvas(1200, 700, 255);
  const centres = [[200, 350], [600, 350], [1000, 350]];
  centres.forEach(([cx, cy], i) => blob(sheet, cx, cy, 120, i === 0 ? 1 : 0));

  const { frames } = detectFrames(sheet);
  const ordered = orderFrames(frames);
  assert.equal(ordered.length, centres.length);

  const scale = 4;
  const art = frameMasks();
  const playing = frameSequence(ordered.length);
  const out = canvas(sheet.width, sheet.height, 255);
  ordered.forEach((frame, i) => {
    const mask = art[playing[i]];
    const left = Math.round(frame.cx - (WIDTH * scale) / 2);
    const top = Math.round(frame.cy - (HEIGHT * scale) / 2);
    for (let row = 0; row < HEIGHT; row++) {
      for (let col = 0; col < WIDTH; col++) {
        if (!mask[row * WIDTH + col]) continue;
        for (let dy = 0; dy < scale; dy++) {
          for (let dx = 0; dx < scale; dx++) {
            const at = ((top + row * scale + dy) * out.width + left + col * scale + dx) * 4;
            out.data[at] = 0xfd;
            out.data[at + 1] = 0x64;
            out.data[at + 2] = 0x81;
            out.data[at + 3] = 0xff;
          }
        }
      }
    }
  });

  const back = decodePng(encodePng(out));
  assert.equal(back.width, sheet.width);
  assert.equal(back.height, sheet.height);
  const drawn = partitionFrames(back, centres).frames;
  assert.equal(drawn.length, centres.length);
  drawn.forEach((frame, i) => {
    assert.ok(frame.ink > 0, `nothing drawn near ${centres[i]}`);
    assert.ok(Math.abs(frame.cx - centres[i][0]) < WIDTH * scale, 'slash drifted off its blob');
  });
});
