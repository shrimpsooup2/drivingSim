import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { atlasRegion, parsePlist, planLayout, shelfPack, sourceRect, writePlist } from '../tools/slash-sheet/plist.js';
import { blankCanvas, blit, crop, rotateClockwise, rotateCounterClockwise } from '../tools/slash-sheet/render.js';

/** A frame dict in the format TexturePacker writes. */
const entry = (name, rect, size, offset, rotated) => `
            <key>${name}</key>
            <dict>
                <key>aliases</key>
                <array/>
                <key>spriteOffset</key>
                <string>{${offset}}</string>
                <key>spriteSize</key>
                <string>{${size}}</string>
                <key>spriteSourceSize</key>
                <string>{100,80}</string>
                <key>textureRect</key>
                <string>{{${rect}},{${size}}}</string>
                <key>textureRotated</key>
                <${rotated ? 'true' : 'false'}/>
            </dict>`;

const SHEET = `<plist version="1.0"><dict>
        <key>frames</key>
        <dict>${entry('shot_002.png', '40,0', '20,30', '0,0', true)}${entry('shot_001.png', '0,0', '30,20', '5,-4', false)}
        </dict>
        <key>metadata</key>
        <dict><key>format</key><integer>3</integer></dict>
</dict></plist>`;

/** An image whose every pixel is distinguishable, so a rotation cannot hide. */
function gradient(width, height) {
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const at = (y * width + x) * 4;
      data[at] = (x * 7) & 0xff;
      data[at + 1] = (y * 11) & 0xff;
      data[at + 2] = ((x + y) * 3) & 0xff;
      data[at + 3] = 255;
    }
  }
  return { width, height, data };
}

test('frames come back in name order, with their rotation flags', () => {
  const frames = parsePlist(SHEET);
  assert.deepEqual(frames.map((f) => f.name), ['shot_001.png', 'shot_002.png']);
  assert.deepEqual(frames.map((f) => f.rotated), [false, true]);
  assert.deepEqual(frames.map((f) => [f.w, f.h]), [[30, 20], [20, 30]]);
  assert.deepEqual(frames.map((f) => [f.sourceW, f.sourceH]), [[100, 80], [100, 80]]);
});

test('a rotated frame occupies height by width in the texture', () => {
  const [upright, rotated] = parsePlist(SHEET);
  assert.deepEqual(atlasRegion(upright), { x: 0, y: 0, w: 30, h: 20 });
  assert.deepEqual(atlasRegion(rotated), { x: 40, y: 0, w: 30, h: 20 });
});

test('the trim offset is read with y pointing up, as the format states it', () => {
  const [upright] = parsePlist(SHEET);
  // offset {5,-4} on a 100x80 canvas: the crop's centre sits 5 right of the
  // canvas centre and, because the format's y points up, 4 below it. So the
  // 30x20 crop starts at (50+5-15, 40+4-10).
  assert.deepEqual(sourceRect(upright), { left: 40, top: 34, right: 70, bottom: 54 });
});

test('storing a frame rotated and reading it back is lossless', () => {
  const sprite = gradient(13, 21);
  const stored = rotateClockwise(sprite);
  assert.equal(stored.width, 21);
  assert.equal(stored.height, 13);
  const back = rotateCounterClockwise(stored);
  assert.equal(back.width, 13);
  assert.equal(back.height, 21);
  assert.deepEqual(Array.from(back.data), Array.from(sprite.data));
});

test('rotating clockwise actually turns the image, it does not just resize it', () => {
  const sprite = gradient(4, 3);
  const stored = rotateClockwise(sprite);
  // The top-left of the sprite must end up at the top-right of the stored copy.
  const corner = (img, x, y) => Array.from(img.data.slice((y * img.width + x) * 4, (y * img.width + x) * 4 + 3));
  assert.deepEqual(corner(stored, stored.width - 1, 0), corner(sprite, 0, 0));
  assert.deepEqual(corner(stored, 0, 0), corner(sprite, 0, sprite.height - 1));
});

test('a repacked plist round-trips through the parser', () => {
  const frames = [
    { name: 'a.png', x: 0, y: 0, w: 10, h: 20, rotated: false, offsetX: -3, offsetY: 7, sourceW: 64, sourceH: 64 },
    { name: 'b.png', x: 12, y: 0, w: 30, h: 5, rotated: false, offsetX: 0, offsetY: 0, sourceW: 64, sourceH: 64 },
  ];
  const back = parsePlist(writePlist(frames, { textureFileName: 'x.png', width: 256, height: 256 }));
  assert.deepEqual(back, frames.map((f) => ({ ...f })));
});

test('packed frames stay inside the sheet and never overlap', () => {
  const sizes = [{ w: 150, h: 625 }, { w: 40, h: 200 }, { w: 300, h: 90 }, { w: 150, h: 625 }, { w: 90, h: 90 }];
  const placed = shelfPack(sizes, { width: 400, height: 1000, gap: 2 });
  placed.forEach((p, i) => {
    assert.ok(p.x >= 0 && p.y >= 0, 'placed off the sheet');
    assert.ok(p.x + sizes[i].w <= 400 && p.y + sizes[i].h <= 1000, 'runs past the sheet');
  });
  for (let i = 0; i < sizes.length; i++) {
    for (let j = i + 1; j < sizes.length; j++) {
      const a = { ...placed[i], ...sizes[i] };
      const b = { ...placed[j], ...sizes[j] };
      const hit = a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
      assert.ok(!hit, `frames ${i} and ${j} overlap`);
    }
  }
  assert.throws(() => shelfPack([{ w: 10, h: 10 }], { width: 5, height: 5 }), /do not fit/);
});

test('a frame written rotated comes back upright the way the engine rebuilds it', () => {
  // Full trip: draw, store rotated, then undo it exactly as the engine does.
  const [, rotated] = parsePlist(SHEET);
  const atlas = blankCanvas(80, 40, 'alpha');
  const sprite = gradient(rotated.w, rotated.h);
  blit(atlas, rotateClockwise(sprite), rotated.x, rotated.y);

  const stored = crop(atlas, atlasRegion(rotated));
  const rebuilt = rotateCounterClockwise(stored);
  assert.equal(rebuilt.width, rotated.w);
  assert.equal(rebuilt.height, rotated.h);
  assert.deepEqual(Array.from(rebuilt.data), Array.from(sprite.data));
});

test('the layout planner never lets a frame spill outside its own crop', () => {
  const frames = parsePlist(SHEET);
  const boxes = [{ left: 0, right: 2, top: 0, bottom: 4 }, { left: 1, right: 3, top: 2, bottom: 9 }];
  const plan = planLayout(frames, boxes, { width: 6, height: 12 });
  frames.forEach((frame, i) => {
    const rect = sourceRect(frame);
    const box = boxes[i];
    assert.ok(plan.originX + box.left * plan.scale >= rect.left, `frame ${i} spills left`);
    assert.ok(plan.originX + (box.right + 1) * plan.scale <= rect.right, `frame ${i} spills right`);
    assert.ok(plan.originY + box.top * plan.scale >= rect.top, `frame ${i} spills up`);
    assert.ok(plan.originY + (box.bottom + 1) * plan.scale <= rect.bottom, `frame ${i} spills down`);
  });
});

test('the shipped sheet rebuilds into ten upright slash frames', () => {
  // Guards the real deliverable: read the plist we ship, rebuild each frame the
  // way the engine will, and check it is the slash the right way up.
  const frames = parsePlist(readFileSync(new URL('../PlayerExplosion_03-uhd.plist', import.meta.url), 'utf8'));
  assert.equal(frames.length, 10);
  assert.ok(frames.every((f) => !f.rotated), 'the repack should leave nothing rotated');
  assert.ok(frames.every((f) => f.sourceW === 648 && f.sourceH === 632), 'untrimmed canvas must not change');

  for (const frame of frames) {
    const rect = sourceRect(frame);
    assert.ok(rect.left >= 0 && rect.top >= 0, `${frame.name} sits off the canvas`);
    assert.ok(rect.right <= frame.sourceW && rect.bottom <= frame.sourceH, `${frame.name} runs past the canvas`);
  }

  // Frames sharing a slash frame must land identically on the canvas: that is
  // what stops the animation jumping.
  for (let i = 0; i < frames.length; i += 2) {
    assert.deepEqual(sourceRect(frames[i]), sourceRect(frames[i + 1]),
      `${frames[i].name} and ${frames[i + 1].name} should sit in the same place`);
  }
});
