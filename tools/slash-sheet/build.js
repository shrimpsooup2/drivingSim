#!/usr/bin/env node
/**
 * Replace every frame of an explosion sprite sheet with a frame of the slash
 * effect, keeping the sheet's name, dimensions and frame layout.
 *
 * It finds the blobs the explosion is drawn as, orders them first to last,
 * spreads the slash's five frames across them (holding or dropping frames when
 * the counts do not match), and stamps each one centred on the blob it
 * replaces.
 * The slash is drawn at one fixed scale for every frame so the effect does not
 * pulse as it plays; only its position follows the sheet.
 *
 * Usage:
 *   node tools/slash-sheet/build.js explosion.png [options]
 *
 *   --out DIR        write to DIR (default: ./out), keeping the source filename
 *   --in-place       overwrite the source sheet instead
 *   --order MODE     stage (default) | grid | grid-reverse | 3,1,2,...
 *   --fit FRACTION   slash width as a fraction of a frame's width (default 0.9)
 *   --scale N        force N output pixels per art pixel, ignoring --fit
 *   --gap FRACTION   force the blob bridging distance, as a fraction of the
 *                    sheet's long edge (default: worked out from the sheet)
 *   --seeds LIST     split by nearest frame centre instead: "x,y x,y ..." or a
 *                    file of the same. Use this when the frames touch
 *   --grid CxR       split by a plain C x R grid of frame centres
 *   --plist FILE     use the sheet's plist: its frame order, rectangles and
 *                    rotation flags, rather than guessing them from the pixels
 *   --repack         rewrite the plist too: lay the frames out fresh, upright
 *                    and trimmed to the art, instead of reusing the old
 *                    rectangles. Bigger pixels, and no rotation to get wrong
 *   --verify PATH    write a filmstrip of the frames as the engine will
 *                    rebuild them, to check orientation and placement
 *   --preview PATH   also write a contact sheet of the slash frames alone
 *   --dry-run        report what was found without writing the sheet
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { decodePng, encodePng } from './png.js';
import { detectFrames, gridSeeds, orderFrames, partitionFrames } from './frames.js';
import { COLOR, HEIGHT, WIDTH, FRAME_COUNT, frameMasks, frameSequence } from './slash.js';
import { blankCanvas, blit, crop, rotateClockwise, rotateCounterClockwise, stampFrame } from './render.js';
import { atlasRegion, parsePlist, planLayout, shelfPack, sourceRect, writePlist } from './plist.js';

function parseArgs(argv) {
  const out = {
    input: null, out: 'out', inPlace: false, order: 'stage',
    fit: 0.9, scale: 0, gap: 0, preview: null, dryRun: false, seeds: null, grid: null,
    plist: null, verify: null, repack: false, fitGiven: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = () => {
      const next = argv[++i];
      if (next === undefined) throw new Error(`${arg} needs a value`);
      return next;
    };
    if (arg === '--out') out.out = value();
    else if (arg === '--in-place') out.inPlace = true;
    else if (arg === '--order') {
      const mode = value();
      out.order = /^[\d\s,]+$/.test(mode) ? mode.split(',').map((n) => Number(n.trim())) : mode;
    } else if (arg === '--fit') out.fit = Number(value());
    else if (arg === '--scale') out.scale = Number(value());
    else if (arg === '--gap') out.gap = Number(value());
    else if (arg === '--seeds') out.seeds = value();
    else if (arg === '--grid') out.grid = value();
    else if (arg === '--plist') out.plist = value();
    else if (arg === '--repack') out.repack = true;
    else if (arg === '--verify') out.verify = value();
    else if (arg === '--preview') out.preview = value();
    else if (arg === '--dry-run') out.dryRun = true;
    else if (arg === '--help' || arg === '-h') out.help = true;
    else if (arg.startsWith('-')) throw new Error(`unknown option ${arg}`);
    else if (!out.input) out.input = arg;
    else throw new Error(`unexpected extra argument ${arg}`);
  }
  return out;
}

/** Frame centres from "x,y x,y ...", or from a file holding the same. */
function parseSeeds(value) {
  const text = /^[\d\s,.]+$/.test(value) ? value : readFileSync(resolve(value), 'utf8');
  const seeds = text.trim().split(/\s+/).map((pair) => {
    const [x, y] = pair.split(',').map(Number);
    if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error(`bad frame centre "${pair}"`);
    return [x, y];
  });
  if (!seeds.length) throw new Error('--seeds listed no frame centres');
  return seeds;
}

/** A contact sheet of the slash frames on their own, for eyeballing the art. */
function previewSheet(scale = 2, pad = 2) {
  const masks = frameMasks();
  const cellW = (WIDTH + pad * 2) * scale;
  const cellH = (HEIGHT + pad * 2) * scale;
  const canvas = blankCanvas(cellW * masks.length, cellH, 'alpha');
  masks.forEach((mask, i) => {
    stampFrame(canvas, mask, scale, i * cellW + cellW / 2, cellH / 2);
  });
  return canvas;
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[sorted.length >> 1];
}

/** The cells a frame's art actually covers. */
function inkBox(mask) {
  let left = WIDTH, right = -1, top = HEIGHT, bottom = -1;
  for (let row = 0; row < HEIGHT; row++) {
    for (let col = 0; col < WIDTH; col++) {
      if (!mask[row * WIDTH + col]) continue;
      if (col < left) left = col;
      if (col > right) right = col;
      if (row < top) top = row;
      if (row > bottom) bottom = row;
    }
  }
  return { left, right, top, bottom };
}

/**
 * Rebuild every frame the way the engine will, and lay them out in a row.
 *
 * This is the check that matters: it undoes the pack rotation, drops each
 * frame back onto its untrimmed canvas, and shows what actually reaches the
 * screen -- which is the only place a frame stored the wrong way round, or
 * clipped by its own crop, becomes obvious.
 */
function filmstrip(atlas, frames) {
  const { sourceW, sourceH } = frames[0];
  const strip = blankCanvas(sourceW * frames.length, sourceH, 'alpha');
  frames.forEach((frame, i) => {
    const stored = crop(atlas, atlasRegion(frame));
    const sprite = frame.rotated ? rotateCounterClockwise(stored) : stored;
    const rect = sourceRect(frame);
    blit(strip, sprite, i * sourceW + rect.left, rect.top);
  });
  return strip;
}

/**
 * Rebuild the sheet *and* its plist, laying every frame out fresh.
 *
 * Reusing the old rectangles means inheriting decisions made for the old art:
 * five frames packed rotated, and crops trimmed to an explosion, the smallest
 * of which caps how big an art pixel can be before something is clipped.
 * Repacking drops both. Frames go in upright, so there is no rotation left to
 * get the wrong way round, and each is trimmed to the slash rather than to the
 * blast it replaces, which lets the art fill the untrimmed canvas instead of
 * the tightest old crop.
 *
 * What does not change is what the engine keys off: the frame names, their
 * order, the untrimmed canvas size, and the sheet's own dimensions. Each
 * frame's `spriteOffset` is recomputed so it still lands where it should on
 * that canvas.
 */
function repackFromPlist(sheet, opts, inputPath) {
  const frames = parsePlist(readFileSync(resolve(opts.plist), 'utf8'));
  const art = frameMasks();
  const playing = frameSequence(frames.length);
  const { sourceW, sourceH } = frames[0];

  // Without --fit, take the largest pixel the untrimmed canvas will hold.
  const fit = opts.fitGiven ? opts.fit : 1;
  const scale = opts.scale > 0 ? Math.floor(opts.scale)
    : Math.max(1, Math.min(Math.floor((fit * sourceW) / WIDTH), Math.floor((fit * sourceH) / HEIGHT)));
  const originX = Math.round(sourceW / 2 - (WIDTH * scale) / 2);
  const originY = Math.round(sourceH / 2 - (HEIGHT * scale) / 2);

  const boxes = playing.map((k) => inkBox(art[k]));
  const sizes = boxes.map((b) => ({ w: (b.right - b.left + 1) * scale, h: (b.bottom - b.top + 1) * scale }));
  const spots = shelfPack(sizes, { width: sheet.width, height: sheet.height });

  const canvas = blankCanvas(sheet.width, sheet.height, 'alpha');
  const packed = frames.map((frame, i) => {
    const box = boxes[i];
    const { w, h } = sizes[i];
    const spot = spots[i];
    const mask = art[playing[i]];
    const sprite = { width: w, height: h, data: new Uint8Array(w * h * 4) };
    for (let row = box.top; row <= box.bottom; row++) {
      for (let col = box.left; col <= box.right; col++) {
        if (!mask[row * WIDTH + col]) continue;
        for (let dy = 0; dy < scale; dy++) {
          for (let dx = 0; dx < scale; dx++) {
            const at = (((row - box.top) * scale + dy) * w + (col - box.left) * scale + dx) * 4;
            sprite.data[at] = COLOR.r;
            sprite.data[at + 1] = COLOR.g;
            sprite.data[at + 2] = COLOR.b;
            sprite.data[at + 3] = COLOR.a;
          }
        }
      }
    }
    blit(canvas, sprite, spot.x, spot.y);
    // Where this frame sits on the untrimmed canvas, as an offset from centre
    // with y up, which is how the format states it.
    const left = originX + box.left * scale;
    const top = originY + box.top * scale;
    return {
      name: frame.name, x: spot.x, y: spot.y, w, h, rotated: false, sourceW, sourceH,
      offsetX: Math.round(left + w / 2 - sourceW / 2),
      offsetY: Math.round(sourceH / 2 - (top + h / 2)),
    };
  });

  console.log(`${basename(inputPath)}: ${sheet.width}x${sheet.height}`);
  console.log(`repacking ${frames.length} frames upright (was ${frames.filter((f) => f.rotated).length} rotated)`);
  console.log(`untrimmed canvas ${sourceW}x${sourceH}, slash art ${WIDTH}x${HEIGHT} at ${scale}x `
    + `= ${WIDTH * scale}x${HEIGHT * scale} from ${originX},${originY}`);
  console.log('');
  console.log(' play  slash  frame                     new rect in atlas    offset     rotated');
  packed.forEach((f, i) => {
    console.log(
      `  ${String(i + 1).padStart(2)}   ${String(playing[i] + 1).padStart(2)}/${FRAME_COUNT}   `
      + `${f.name.padEnd(25)} ${`${f.w}x${f.h} at ${f.x},${f.y}`.padEnd(20)} `
      + `${`{${f.offsetX},${f.offsetY}}`.padEnd(10)} no`,
    );
  });
  return { canvas, frames: packed };
}

/**
 * Rebuild the sheet from its plist: the frames it names, in its order, each
 * laid out on the untrimmed canvas and written back into its own rectangle,
 * turned clockwise where the plist says the packer turned it.
 */
function buildFromPlist(sheet, opts, inputPath) {
  const frames = parsePlist(readFileSync(resolve(opts.plist), 'utf8'));
  const art = frameMasks();
  const playing = frameSequence(frames.length);
  const boxes = playing.map((k) => inkBox(art[k]));
  const plan = planLayout(frames, boxes, {
    width: WIDTH, height: HEIGHT, fit: opts.fit, scale: opts.scale > 0 ? opts.scale : 0,
  });

  console.log(`${basename(inputPath)}: ${sheet.width}x${sheet.height}`);
  console.log(`${frames.length} frames from ${basename(opts.plist)}, `
    + `${frames.filter((f) => f.rotated).length} of them packed rotated`);
  console.log(`untrimmed canvas ${frames[0].sourceW}x${frames[0].sourceH}, `
    + `slash art ${WIDTH}x${HEIGHT} at ${plan.scale}x from ${plan.originX},${plan.originY}`);
  console.log('');
  console.log(' play  slash  frame                     rect in atlas       rotated  trimmed to');
  frames.forEach((frame, i) => {
    const region = atlasRegion(frame);
    console.log(
      `  ${String(i + 1).padStart(2)}   ${String(playing[i] + 1).padStart(2)}/${FRAME_COUNT}   `
      + `${frame.name.padEnd(25)} ${`${region.w}x${region.h} at ${frame.x},${frame.y}`.padEnd(19)} `
      + `${frame.rotated ? 'yes    ' : 'no     '}  ${frame.w}x${frame.h}`,
    );
  });

  const canvas = blankCanvas(sheet.width, sheet.height, 'alpha');
  frames.forEach((frame, i) => {
    const mask = art[playing[i]];
    const rect = sourceRect(frame);
    const sprite = { width: frame.w, height: frame.h, data: new Uint8Array(frame.w * frame.h * 4) };
    for (let row = 0; row < HEIGHT; row++) {
      for (let col = 0; col < WIDTH; col++) {
        if (!mask[row * WIDTH + col]) continue;
        for (let dy = 0; dy < plan.scale; dy++) {
          const sy = plan.originY + row * plan.scale + dy - rect.top;
          if (sy < 0 || sy >= frame.h) continue;
          for (let dx = 0; dx < plan.scale; dx++) {
            const sx = plan.originX + col * plan.scale + dx - rect.left;
            if (sx < 0 || sx >= frame.w) continue;
            const at = (sy * frame.w + sx) * 4;
            sprite.data[at] = COLOR.r;
            sprite.data[at + 1] = COLOR.g;
            sprite.data[at + 2] = COLOR.b;
            sprite.data[at + 3] = COLOR.a;
          }
        }
      }
    }
    blit(canvas, frame.rotated ? rotateClockwise(sprite) : sprite, frame.x, frame.y);
  });
  return { canvas, frames };
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help || !opts.input) {
    console.log(readFileSync(new URL(import.meta.url), 'utf8').split('*/')[0].replace(/^#![^\n]*\n\/\*\*\n/, '').replace(/^ \* ?/gm, ''));
    process.exit(opts.input ? 0 : 1);
  }

  const inputPath = resolve(opts.input);
  const sheet = decodePng(readFileSync(inputPath));
  const outPath = opts.inPlace ? inputPath : resolve(opts.out, basename(inputPath));
  if (outPath === inputPath && !opts.inPlace) throw new Error('refusing to overwrite the source; pass --in-place');

  if (opts.repack && !opts.plist) throw new Error('--repack needs --plist');
  if (opts.plist) {
    const { canvas, frames } = opts.repack
      ? repackFromPlist(sheet, opts, inputPath)
      : buildFromPlist(sheet, opts, inputPath);
    if (opts.verify) {
      mkdirSync(dirname(resolve(opts.verify)), { recursive: true });
      writeFileSync(resolve(opts.verify), encodePng(filmstrip(canvas, frames)));
      console.log(`\nwrote a rebuilt-frames filmstrip to ${opts.verify}`);
    }
    if (opts.dryRun) {
      console.log('\n--dry-run: no sheet written');
      return;
    }
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, encodePng(canvas));
    console.log(`\nwrote ${outPath} (${canvas.width}x${canvas.height}, same name and size as the source)`);
    if (opts.repack) {
      const plistOut = opts.inPlace ? resolve(opts.plist) : resolve(opts.out, basename(opts.plist));
      writeFileSync(plistOut, writePlist(frames, {
        textureFileName: basename(outPath), width: canvas.width, height: canvas.height,
      }));
      console.log(`wrote ${plistOut} (${frames.length} frames, none rotated)`);
    }
    return;
  }

  if (opts.seeds && opts.grid) throw new Error('pass --seeds or --grid, not both');

  let found;
  let how;
  if (opts.seeds || opts.grid) {
    let seeds;
    if (opts.seeds) {
      seeds = parseSeeds(opts.seeds);
      how = `${seeds.length} frame centres`;
    } else {
      const [cols, rows] = opts.grid.split(/[x*,]/i).map(Number);
      if (!(cols > 0) || !(rows > 0)) throw new Error(`bad --grid "${opts.grid}"; use CxR, e.g. 3x4`);
      seeds = gridSeeds(sheet, cols, rows);
      how = `a ${cols}x${rows} grid`;
    }
    found = partitionFrames(sheet, seeds);
  } else {
    found = detectFrames(sheet, { gap: opts.gap });
    how = `bridging gaps up to ${found.radius} cells`;
  }
  const { frames, background } = found;
  const ordered = orderFrames(frames, opts.order);
  const playing = frameSequence(ordered.length);

  const scale = opts.scale > 0
    ? Math.max(1, Math.round(opts.scale))
    : Math.max(1, Math.round(Math.min(
      (opts.fit * median(frames.map((f) => f.w))) / WIDTH,
      (opts.fit * median(frames.map((f) => f.h))) / HEIGHT,
    )));

  console.log(`${basename(inputPath)}: ${sheet.width}x${sheet.height}, ${background} background`);
  console.log(`found ${ordered.length} frames (${how}), ordered by "${
    Array.isArray(opts.order) ? 'explicit list' : opts.order}"`);
  if (ordered.length === 1 && !opts.seeds && !opts.grid) {
    console.log('only one frame came out: the sheet\'s blobs touch, so pass --seeds or --grid');
  }
  console.log(`slash art ${WIDTH}x${HEIGHT} at ${scale}x = ${WIDTH * scale}x${HEIGHT * scale} px per frame`);
  console.log('');
  console.log(' play  slash        centre        frame box            ink    density');
  ordered.forEach((frame, i) => {
    console.log(
      `  ${String(i + 1).padStart(2)}   ${String(playing[i] + 1).padStart(2)}/${FRAME_COUNT}  `
      + `${`${Math.round(frame.cx)},${Math.round(frame.cy)}`.padEnd(12)}  `
      + `${`${frame.w}x${frame.h} at ${frame.x0},${frame.y0}`.padEnd(20)}  `
      + `${String(frame.ink).padStart(7)}  ${frame.density.toFixed(3)}`,
    );
  });

  if (opts.preview) {
    mkdirSync(dirname(resolve(opts.preview)), { recursive: true });
    writeFileSync(resolve(opts.preview), encodePng(previewSheet()));
    console.log(`\nwrote frame preview to ${opts.preview}`);
  }

  if (opts.dryRun) {
    console.log('\n--dry-run: no sheet written');
    return;
  }

  const canvas = blankCanvas(sheet.width, sheet.height, background);
  const art = frameMasks();
  ordered.forEach((frame, i) => {
    stampFrame(canvas, art[playing[i]], scale, frame.cx, frame.cy);
  });

  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, encodePng(canvas));
  console.log(`\nwrote ${outPath} (${canvas.width}x${canvas.height}, same name and size as the source)`);
}

try {
  main();
} catch (error) {
  console.error(`slash-sheet: ${error.message}`);
  process.exit(1);
}
