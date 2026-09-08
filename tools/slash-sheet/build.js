#!/usr/bin/env node
/**
 * Replace every frame of an explosion sprite sheet with a frame of the slash
 * effect, keeping the sheet's name, dimensions and frame layout.
 *
 * It finds the blobs the explosion is drawn as, orders them first to last,
 * spreads the slash's stages across them (holding or dropping stages when the
 * counts do not match), and stamps each stage centred on the blob it replaces.
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
 *   --preview PATH   also write a contact sheet of the slash stages alone
 *   --dry-run        report what was found without writing the sheet
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { decodePng, encodePng } from './png.js';
import { detectFrames, orderFrames } from './frames.js';
import { COLOR, HEIGHT, WIDTH, STAGE_COUNT, stageMasks, stageSequence } from './slash.js';

function parseArgs(argv) {
  const out = {
    input: null, out: 'out', inPlace: false, order: 'stage',
    fit: 0.9, scale: 0, gap: 0, preview: null, dryRun: false,
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
    else if (arg === '--preview') out.preview = value();
    else if (arg === '--dry-run') out.dryRun = true;
    else if (arg === '--help' || arg === '-h') out.help = true;
    else if (arg.startsWith('-')) throw new Error(`unknown option ${arg}`);
    else if (!out.input) out.input = arg;
    else throw new Error(`unexpected extra argument ${arg}`);
  }
  return out;
}

/** A blank RGBA canvas: transparent, or opaque white to match a flattened sheet. */
function blankCanvas(width, height, background) {
  const data = new Uint8Array(width * height * 4);
  if (background === 'white') data.fill(255);
  return { width, height, data };
}

/** Stamp one slash stage, nearest-neighbour scaled, centred on (cx, cy). */
function stampStage(canvas, mask, scale, cx, cy) {
  const left = Math.round(cx - (WIDTH * scale) / 2);
  const top = Math.round(cy - (HEIGHT * scale) / 2);
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

/** A contact sheet of the slash stages on their own, for eyeballing the art. */
function previewSheet(scale = 6, pad = 2) {
  const masks = stageMasks();
  const cellW = (WIDTH + pad * 2) * scale;
  const cellH = (HEIGHT + pad * 2) * scale;
  const canvas = blankCanvas(cellW * masks.length, cellH, 'alpha');
  masks.forEach((mask, i) => {
    stampStage(canvas, mask, scale, i * cellW + cellW / 2, cellH / 2);
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
  const { frames, background, radius } = detectFrames(sheet, { gap: opts.gap });
  const ordered = orderFrames(frames, opts.order);
  const stages = stageSequence(ordered.length);

  const scale = opts.scale > 0
    ? Math.max(1, Math.round(opts.scale))
    : Math.max(1, Math.round(Math.min(
      (opts.fit * median(frames.map((f) => f.w))) / WIDTH,
      (opts.fit * median(frames.map((f) => f.h))) / HEIGHT,
    )));

  console.log(`${basename(inputPath)}: ${sheet.width}x${sheet.height}, ${background} background`);
  console.log(`found ${ordered.length} frames (bridging gaps up to ${radius} cells), ordered by "${
    Array.isArray(opts.order) ? 'explicit list' : opts.order}"`);
  console.log(`slash art ${WIDTH}x${HEIGHT} at ${scale}x = ${WIDTH * scale}x${HEIGHT * scale} px per frame`);
  console.log('');
  console.log(' play  stage        centre        frame box            ink    density');
  ordered.forEach((frame, i) => {
    console.log(
      `  ${String(i + 1).padStart(2)}   ${String(stages[i] + 1).padStart(2)}/${STAGE_COUNT}  `
      + `${`${Math.round(frame.cx)},${Math.round(frame.cy)}`.padEnd(12)}  `
      + `${`${frame.w}x${frame.h} at ${frame.x0},${frame.y0}`.padEnd(20)}  `
      + `${String(frame.ink).padStart(7)}  ${frame.density.toFixed(3)}`,
    );
  });

  if (opts.preview) {
    mkdirSync(dirname(resolve(opts.preview)), { recursive: true });
    writeFileSync(resolve(opts.preview), encodePng(previewSheet()));
    console.log(`\nwrote stage preview to ${opts.preview}`);
  }

  if (opts.dryRun) {
    console.log('\n--dry-run: no sheet written');
    return;
  }

  const canvas = blankCanvas(sheet.width, sheet.height, background);
  ordered.forEach((frame, i) => {
    stampStage(canvas, stageMasks()[stages[i]], scale, frame.cx, frame.cy);
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
