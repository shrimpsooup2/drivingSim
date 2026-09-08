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
 *   --preview PATH   also write a contact sheet of the slash frames alone
 *   --dry-run        report what was found without writing the sheet
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { decodePng, encodePng } from './png.js';
import { detectFrames, gridSeeds, orderFrames, partitionFrames } from './frames.js';
import { HEIGHT, WIDTH, FRAME_COUNT, frameMasks, frameSequence } from './slash.js';
import { blankCanvas, stampFrame } from './render.js';

function parseArgs(argv) {
  const out = {
    input: null, out: 'out', inPlace: false, order: 'stage',
    fit: 0.9, scale: 0, gap: 0, preview: null, dryRun: false, seeds: null, grid: null,
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

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help || !opts.input) {
    console.log(readFileSync(new URL(import.meta.url), 'utf8').split('*/')[0].replace(/^#![^\n]*\n\/\*\*\n/, '').replace(/^ \* ?/gm, ''));
    process.exit(opts.input ? 0 : 1);
  }

  const inputPath = resolve(opts.input);
  const sheet = decodePng(readFileSync(inputPath));
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

  const outPath = opts.inPlace ? inputPath : resolve(opts.out, basename(inputPath));
  if (outPath === inputPath && !opts.inPlace) throw new Error('refusing to overwrite the source; pass --in-place');
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
