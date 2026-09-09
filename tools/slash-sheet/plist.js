/**
 * Reading a TexturePacker / cocos2d sprite sheet plist.
 *
 * The plist is what makes a packed atlas usable: it names every frame, gives
 * its rectangle in the texture, and records two things no amount of looking at
 * the PNG will tell you.
 *
 * The first is rotation. To save space the packer stores some sprites turned
 * 90 degrees clockwise, flagged `textureRotated`, and the engine turns them
 * back when it draws. A frame's `spriteSize` is always the upright size, so a
 * rotated frame occupies height x width in the texture, not width x height.
 * Art written into one of those slots has to be turned clockwise on the way in
 * or it comes out on its side in game.
 *
 * The second is trimming. Each sprite was cropped to its own drawn pixels, so
 * frames are different sizes; `spriteSourceSize` is the untrimmed size they
 * all share and `spriteOffset` says where the crop sat inside it. That
 * untrimmed canvas -- not the texture -- is the space the animation plays in,
 * so it is the space to lay art out in.
 */

/** Parse the `{a,b}` and `{{a,b},{c,d}}` strings the format uses. */
function numbers(text) {
  return (text.match(/-?\d+/g) ?? []).map(Number);
}

/**
 * Parse a format-3 plist into frames, in the order their names sort.
 *
 * Packers name frames with a zero-padded counter, so sorting by name is the
 * order the animation plays in -- which is worth having, because it is not
 * something the texture itself reveals.
 */
export function parsePlist(xml) {
  const start = xml.indexOf('<key>frames</key>');
  const end = xml.indexOf('<key>metadata</key>');
  if (start < 0 || end < 0) throw new Error('not a TexturePacker plist: no frames/metadata sections');

  const frames = [];
  const entry = /<key>([^<]+)<\/key>\s*<dict>([\s\S]*?)<\/dict>/g;
  let match;
  while ((match = entry.exec(xml.slice(start + '<key>frames</key>'.length, end)))) {
    const [, name, body] = match;
    const value = (key) => {
      const found = body.match(new RegExp(`<key>${key}</key>\\s*<string>([^<]*)</string>`));
      if (!found) throw new Error(`frame ${name} has no ${key}`);
      return numbers(found[1]);
    };
    const [x, y] = value('textureRect');
    const [w, h] = value('spriteSize');
    const [offsetX, offsetY] = value('spriteOffset');
    const [sourceW, sourceH] = value('spriteSourceSize');
    frames.push({
      name, x, y, w, h, offsetX, offsetY, sourceW, sourceH,
      rotated: /<key>textureRotated<\/key>\s*<true\/>/.test(body),
    });
  }
  if (!frames.length) throw new Error('the plist lists no frames');
  frames.sort((a, b) => a.name.localeCompare(b.name));
  return frames;
}

/** The area a frame occupies in the texture, rotation accounted for. */
export function atlasRegion(frame) {
  return {
    x: frame.x,
    y: frame.y,
    w: frame.rotated ? frame.h : frame.w,
    h: frame.rotated ? frame.w : frame.h,
  };
}

/**
 * Where a frame's trimmed rectangle sits on the untrimmed source canvas.
 *
 * `spriteOffset` measures the crop's centre from the canvas centre with y
 * pointing up, as cocos2d does, so the sign flips for image coordinates.
 */
export function sourceRect(frame) {
  const left = Math.round(frame.sourceW / 2 + frame.offsetX - frame.w / 2);
  const top = Math.round(frame.sourceH / 2 - frame.offsetY - frame.h / 2);
  return { left, top, right: left + frame.w, bottom: top + frame.h };
}

/**
 * Pick the biggest scale, and one canvas origin, that clips no frame.
 *
 * Every frame is laid out at the same scale and the same origin on the source
 * canvas, so the art keeps one grid and one registration across the animation
 * -- the strokes stay hung off a common edge rather than each being centred in
 * its own crop. The cost is that the smallest crop on the sheet sets the
 * scale for all of them: art that spills outside a frame's crop is simply not
 * stored, so it would vanish in game.
 */
export function planLayout(frames, boxes, { width, height, fit = 1, scale: cap = 0 }) {
  if (frames.length !== boxes.length) throw new Error('every frame needs an art box');
  const start = cap > 0 ? Math.floor(cap) : Math.floor((fit * frames[0].sourceH) / height);
  for (let scale = start; scale >= 1; scale--) {
    let xLow = -Infinity, xHigh = Infinity, yLow = -Infinity, yHigh = Infinity;
    frames.forEach((frame, i) => {
      const rect = sourceRect(frame);
      const box = boxes[i];
      xLow = Math.max(xLow, rect.left - box.left * scale);
      xHigh = Math.min(xHigh, rect.right - (box.right + 1) * scale);
      yLow = Math.max(yLow, rect.top - box.top * scale);
      yHigh = Math.min(yHigh, rect.bottom - (box.bottom + 1) * scale);
    });
    if (xLow > xHigh || yLow > yHigh) continue;
    // Centre the art on the canvas where the crops allow it.
    const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, Math.round(v)));
    return {
      scale,
      originX: clamp(frames[0].sourceW / 2 - (width * scale) / 2, xLow, xHigh),
      originY: clamp(frames[0].sourceH / 2 - (height * scale) / 2, yLow, yHigh),
    };
  }
  throw new Error('no scale fits every frame inside its trimmed rectangle');
}

/** Serialise frames back out as a format-3 plist. */
export function writePlist(frames, { textureFileName, width, height }) {
  const entries = frames.map((f) => `            <key>${f.name}</key>
            <dict>
                <key>aliases</key>
                <array/>
                <key>spriteOffset</key>
                <string>{${f.offsetX},${f.offsetY}}</string>
                <key>spriteSize</key>
                <string>{${f.w},${f.h}}</string>
                <key>spriteSourceSize</key>
                <string>{${f.sourceW},${f.sourceH}}</string>
                <key>textureRect</key>
                <string>{{${f.x},${f.y}},{${f.w},${f.h}}}</string>
                <key>textureRotated</key>
                <${f.rotated ? 'true' : 'false'}/>
            </dict>`).join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple Computer//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
    <dict>
        <key>frames</key>
        <dict>
${entries}
        </dict>
        <key>metadata</key>
        <dict>
            <key>format</key>
            <integer>3</integer>
            <key>pixelFormat</key>
            <string>RGBA8888</string>
            <key>premultiplyAlpha</key>
            <false/>
            <key>realTextureFileName</key>
            <string>${textureFileName}</string>
            <key>size</key>
            <string>{${width},${height}}</string>
            <key>textureFileName</key>
            <string>${textureFileName}</string>
        </dict>
    </dict>
</plist>
`;
}

/**
 * Lay rectangles out in shelves, tallest first, with a gap between them.
 *
 * A packer earns its keep when space is tight; here the art uses a tenth of
 * the sheet, so the simplest thing that leaves a clean margin between frames
 * is enough. The gap matters: without it a filtered texture lookup at a
 * frame's edge can pick up its neighbour.
 */
export function shelfPack(sizes, { width, height, gap = 2 }) {
  const order = [...sizes.keys()].sort((a, b) => sizes[b].h - sizes[a].h || sizes[b].w - sizes[a].w);
  const placed = new Array(sizes.length);
  let x = 0;
  let y = 0;
  let shelf = 0;
  for (const i of order) {
    const { w, h } = sizes[i];
    if (x + w > width) {
      y += shelf + gap;
      x = 0;
      shelf = 0;
    }
    if (y + h > height) throw new Error(`the frames do not fit in ${width}x${height}`);
    placed[i] = { x, y };
    x += w + gap;
    shelf = Math.max(shelf, h);
  }
  return placed;
}
