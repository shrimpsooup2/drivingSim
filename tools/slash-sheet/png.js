/**
 * Minimal PNG reader/writer.
 *
 * Everything in this project is dependency-free, so rather than pulling in an
 * image library this decodes/encodes PNG directly on top of Node's zlib. It
 * covers what a sprite sheet needs: non-interlaced images of any colour type,
 * 8- or 16-bit, decoded to straight RGBA8; encoding is always RGBA8.
 */
import { inflateSync, deflateSync } from 'node:zlib';

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

/** Channels per pixel for each PNG colour type. */
const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

/** Reverse the per-scanline filters, in place, returning the raw sample bytes. */
function unfilter(raw, height, bytesPerRow, bpp) {
  const out = Buffer.alloc(height * bytesPerRow);
  let src = 0;
  for (let y = 0; y < height; y++) {
    const type = raw[src++];
    const row = y * bytesPerRow;
    const prev = row - bytesPerRow;
    for (let x = 0; x < bytesPerRow; x++) {
      const value = raw[src + x];
      const a = x >= bpp ? out[row + x - bpp] : 0;
      const b = y > 0 ? out[prev + x] : 0;
      const c = x >= bpp && y > 0 ? out[prev + x - bpp] : 0;
      let recon;
      switch (type) {
        case 0: recon = value; break;
        case 1: recon = value + a; break;
        case 2: recon = value + b; break;
        case 3: recon = value + ((a + b) >> 1); break;
        case 4: recon = value + paeth(a, b, c); break;
        default: throw new Error(`unsupported PNG filter type ${type} on row ${y}`);
      }
      out[row + x] = recon & 0xff;
    }
    src += bytesPerRow;
  }
  return out;
}

/** Read `bitDepth`-wide sample number `index` out of a packed scanline. */
function readPacked(row, offset, index, bitDepth) {
  const perByte = 8 / bitDepth;
  const byte = row[offset + Math.floor(index / perByte)];
  const shift = 8 - bitDepth * ((index % perByte) + 1);
  return (byte >> shift) & ((1 << bitDepth) - 1);
}

/**
 * Decode a PNG buffer to `{ width, height, data }` where `data` is RGBA8.
 */
export function decodePng(buffer) {
  if (!buffer.subarray(0, 8).equals(SIGNATURE)) throw new Error('not a PNG file');

  let width = 0;
  let height = 0;
  let bitDepth = 8;
  let colorType = 6;
  let interlace = 0;
  let palette = null;
  let paletteAlpha = null;
  let transparent = null;
  const idat = [];

  let pos = 8;
  while (pos < buffer.length) {
    const length = buffer.readUInt32BE(pos);
    const type = buffer.toString('ascii', pos + 4, pos + 8);
    const body = buffer.subarray(pos + 8, pos + 8 + length);
    pos += 12 + length;
    if (type === 'IHDR') {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      bitDepth = body[8];
      colorType = body[9];
      interlace = body[12];
    } else if (type === 'PLTE') {
      palette = Buffer.from(body);
    } else if (type === 'tRNS') {
      if (colorType === 3) paletteAlpha = Buffer.from(body);
      else transparent = Buffer.from(body);
    } else if (type === 'IDAT') {
      idat.push(Buffer.from(body));
    } else if (type === 'IEND') {
      break;
    }
  }

  if (interlace !== 0) throw new Error('interlaced PNGs are not supported; re-save without Adam7');
  const channels = CHANNELS[colorType];
  if (!channels) throw new Error(`unsupported PNG colour type ${colorType}`);

  const raw = inflateSync(Buffer.concat(idat));
  const bitsPerPixel = channels * bitDepth;
  const bytesPerRow = Math.ceil((bitsPerPixel * width) / 8);
  const bpp = Math.max(1, Math.ceil(bitsPerPixel / 8));
  const samples = unfilter(raw, height, bytesPerRow, bpp);

  const data = new Uint8Array(width * height * 4);
  const step = bitDepth === 16 ? 2 : 1;
  const scale = bitDepth < 8 ? 255 / ((1 << bitDepth) - 1) : 1;

  for (let y = 0; y < height; y++) {
    const row = y * bytesPerRow;
    for (let x = 0; x < width; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 255;
      if (bitDepth < 8) {
        const value = readPacked(samples, row, x * channels, bitDepth);
        if (colorType === 3) {
          r = palette[value * 3];
          g = palette[value * 3 + 1];
          b = palette[value * 3 + 2];
          if (paletteAlpha && value < paletteAlpha.length) a = paletteAlpha[value];
        } else {
          r = g = b = Math.round(value * scale);
        }
      } else {
        const at = row + x * channels * step;
        const s0 = samples[at];
        if (colorType === 0) {
          r = g = b = s0;
          if (transparent && transparent.readUInt16BE(0) === (bitDepth === 16 ? samples.readUInt16BE(at) : s0)) a = 0;
        } else if (colorType === 2) {
          r = s0;
          g = samples[at + step];
          b = samples[at + 2 * step];
        } else if (colorType === 3) {
          r = palette[s0 * 3];
          g = palette[s0 * 3 + 1];
          b = palette[s0 * 3 + 2];
          if (paletteAlpha && s0 < paletteAlpha.length) a = paletteAlpha[s0];
        } else if (colorType === 4) {
          r = g = b = s0;
          a = samples[at + step];
        } else {
          r = s0;
          g = samples[at + step];
          b = samples[at + 2 * step];
          a = samples[at + 3 * step];
        }
      }
      const out = (y * width + x) * 4;
      data[out] = r;
      data[out + 1] = g;
      data[out + 2] = b;
      data[out + 3] = a;
    }
  }

  return { width, height, data };
}

function chunk(type, body) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(body.length, 0);
  head.write(type, 4, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), body])), 0);
  return Buffer.concat([head, body, crc]);
}

/** Pick the scanline filter with the smallest absolute-sum, as libpng does. */
function filterRow(row, prev, bytesPerRow, bpp, scratch) {
  let best = null;
  let bestScore = Infinity;
  for (const type of [0, 1, 2, 4]) {
    let score = 0;
    for (let x = 0; x < bytesPerRow; x++) {
      const value = row[x];
      const a = x >= bpp ? row[x - bpp] : 0;
      const b = prev ? prev[x] : 0;
      const c = x >= bpp && prev ? prev[x - bpp] : 0;
      let sub;
      switch (type) {
        case 0: sub = value; break;
        case 1: sub = value - a; break;
        case 2: sub = value - b; break;
        default: sub = value - paeth(a, b, c); break;
      }
      sub &= 0xff;
      scratch[x] = sub;
      score += sub < 128 ? sub : 256 - sub;
    }
    if (score < bestScore) {
      bestScore = score;
      best = Buffer.concat([Buffer.from([type]), Buffer.from(scratch.subarray(0, bytesPerRow))]);
    }
  }
  return best;
}

/** Encode `{ width, height, data }` (RGBA8) as an 8-bit RGBA PNG buffer. */
export function encodePng({ width, height, data }) {
  const bytesPerRow = width * 4;
  const rows = [];
  const scratch = Buffer.alloc(bytesPerRow);
  let prev = null;
  for (let y = 0; y < height; y++) {
    const row = Buffer.from(data.buffer, data.byteOffset + y * bytesPerRow, bytesPerRow);
    rows.push(filterRow(row, prev, bytesPerRow, 4, scratch));
    prev = row;
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(Buffer.concat(rows), { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
