/**
 * Procedural textures, drawn once into a 2D canvas and uploaded.
 *
 * Generating them beats shipping image files: nothing to load, nothing to get
 * out of sync with the field dimensions, and the tile grid can be regenerated
 * if the field size parameter changes.
 * @module
 */

/**
 * FTC foam tile: a dark grey square with the interlocking edge notches and a
 * speckled surface. The grid this produces is the main distance cue a driver
 * has from the driver-station view, so it is drawn with real contrast rather
 * than as a flat colour.
 */
export function drawTile(ctx, size) {
  ctx.fillStyle = '#3a3d42';
  ctx.fillRect(0, 0, size, size);

  // Speckle, so large flat areas do not band.
  const speckles = Math.floor(size * size * 0.02);
  for (let i = 0; i < speckles; i++) {
    const x = Math.random() * size;
    const y = Math.random() * size;
    const shade = 40 + Math.random() * 45;
    ctx.fillStyle = `rgba(${shade},${shade + 2},${shade + 6},0.55)`;
    ctx.fillRect(x, y, 1.6, 1.6);
  }

  // Seam between tiles.
  const seam = Math.max(2, size * 0.016);
  ctx.strokeStyle = 'rgba(16,17,20,0.92)';
  ctx.lineWidth = seam;
  ctx.strokeRect(seam / 2, seam / 2, size - seam, size - seam);

  // Interlocking puzzle tabs on each edge. Kept subtle: they are a real feature
  // of the tiles, but the seam grid is what a driver reads distance from.
  ctx.fillStyle = 'rgba(26,28,33,0.42)';
  const tab = size * 0.09;
  const mid = size / 2;
  for (const [cx, cy] of [[mid, seam], [mid, size - seam], [seam, mid], [size - seam, mid]]) {
    ctx.beginPath();
    ctx.arc(cx, cy, tab * 0.5, 0, Math.PI * 2);
    ctx.fill();
  }

  // Slight top-left highlight so tiles read as raised foam.
  const grad = ctx.createLinearGradient(0, 0, size, size);
  grad.addColorStop(0, 'rgba(255,255,255,0.055)');
  grad.addColorStop(0.5, 'rgba(255,255,255,0)');
  grad.addColorStop(1, 'rgba(0,0,0,0.09)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, size, size);
}

/**
 * Mecanum wheel tread: diagonal roller bands.
 *
 * The cylinder's UV runs around the circumference in u and along the axle in v,
 * so a diagonal line in UV space appears as a helical roller on the wheel.
 * `handed` flips the diagonal, which is what makes the left and right wheels of
 * a mecanum drivetrain visibly mirror images -- a genuinely useful cue, since
 * fitting a mecanum wheel on the wrong corner is a classic build mistake and
 * here you can see it.
 *
 * @param {number} handed +1 or -1
 */
export function drawMecanumTread(handed) {
  return (ctx, size) => {
    ctx.fillStyle = '#2b2e33';
    ctx.fillRect(0, 0, size, size);

    const rollers = 12;
    const bandWidth = size / rollers;
    ctx.lineWidth = bandWidth * 0.62;
    ctx.lineCap = 'round';

    for (let i = -rollers; i < rollers * 2; i++) {
      const x = i * bandWidth;
      const grad = ctx.createLinearGradient(x, 0, x + size * handed, size);
      grad.addColorStop(0, '#6c7076');
      grad.addColorStop(0.5, '#9aa0a8');
      grad.addColorStop(1, '#5d6167');
      ctx.strokeStyle = grad;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      // 45 degrees in UV space: one full axle traverse per one band of rotation.
      ctx.lineTo(x + size * handed, size);
      ctx.stroke();
    }

    // Hub ring at each end of the barrel.
    ctx.fillStyle = 'rgba(20,21,24,0.85)';
    ctx.fillRect(0, 0, size, size * 0.06);
    ctx.fillRect(0, size * 0.94, size, size * 0.06);
  };
}

/** Plain traction tread: straight circumferential grooves. */
export function drawTractionTread(ctx, size) {
  ctx.fillStyle = '#26282c';
  ctx.fillRect(0, 0, size, size);
  const grooves = 7;
  for (let i = 0; i < grooves; i++) {
    const y = ((i + 0.5) / grooves) * size;
    ctx.fillStyle = i % 2 ? '#3c4046' : '#4a4e55';
    ctx.fillRect(0, y - size * 0.035, size, size * 0.07);
  }
  ctx.fillStyle = 'rgba(18,19,22,0.8)';
  ctx.fillRect(0, 0, size, size * 0.07);
  ctx.fillRect(0, size * 0.93, size, size * 0.07);
}

/** Brushed-metal look for the chassis plates. */
export function drawPlate(ctx, size) {
  ctx.fillStyle = '#b9bfc7';
  ctx.fillRect(0, 0, size, size);
  for (let i = 0; i < size * 3; i++) {
    const y = Math.random() * size;
    const shade = 170 + Math.random() * 60;
    ctx.strokeStyle = `rgba(${shade},${shade + 4},${shade + 10},0.28)`;
    ctx.lineWidth = Math.random() * 1.6;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(size, y + (Math.random() - 0.5) * 3);
    ctx.stroke();
  }
  // goBILDA-style pattern of lightening holes.
  ctx.fillStyle = 'rgba(60,64,70,0.5)';
  const spacing = size / 8;
  for (let x = spacing; x < size; x += spacing) {
    for (let y = spacing; y < size; y += spacing) {
      ctx.beginPath();
      ctx.arc(x, y, spacing * 0.17, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

/**
 * Where the holes go on a POLLEN or NECTAR.
 *
 * The SCORING ELEMENTS are "Gopher ResisDent polyethylene balls" -- moulded
 * perforated playground balls -- and Figures 9-13 and 9-14 show what that means:
 * round holes about a sixth of the ball's diameter, laid out in latitude bands
 * with a moulding seam running round the equator between the two middle bands.
 *
 * Bands rather than an even scatter, because that is what a two-part mould
 * produces and it is visibly what the figures show: the seam has a clear lane
 * of its own, and the holes either side of it line up in a ring.
 *
 * Returned as unit axes so the mask can be built by measuring the angle from
 * each one, which keeps the holes round on the sphere rather than round in UV
 * space -- those are very different things near the poles.
 *
 * @returns {{x:number,y:number,z:number}[]}
 */
export function wiffleHoleAxes() {
  /** [latitude in degrees from the equator, holes in the band, phase offset] */
  const bands = [
    [90, 1, 0],
    [60, 6, 0],
    [30, 8, 0.5],
    [-30, 8, 0],
    [-60, 6, 0.5],
    [-90, 1, 0],
  ];
  const out = [];
  for (const [latDeg, count, phase] of bands) {
    const lat = (latDeg * Math.PI) / 180;
    const z = Math.sin(lat);
    const ring = Math.cos(lat);
    for (let i = 0; i < count; i++) {
      const theta = ((i + phase) / count) * Math.PI * 2;
      out.push({ x: ring * Math.cos(theta), y: ring * Math.sin(theta), z });
    }
  }
  return out;
}

/** Angular radius of one hole, radians. A sixth of the ball's diameter across. */
export const WIFFLE_HOLE_ANGLE = (10 * Math.PI) / 180;

/**
 * The perforation mask for a SCORING ELEMENT, as a white texture with the holes
 * punched out of its alpha.
 *
 * White and not coloured, so one texture serves the yellow POLLEN and both
 * colours of NECTAR: the fragment shader multiplies it by `uColor`, so the mask
 * carries only the holes, the wall shading around them and the moulding seam.
 *
 * Each texel is turned back into a direction on the sphere and measured against
 * every hole axis, which is the only way to get holes that are round *on the
 * ball*. Painting circles in UV space would give lozenges at the equator and
 * smears at the poles. It is bounded per hole rather than brute-forced over the
 * whole image -- a hole covers a couple of thousand texels out of a quarter of a
 * million, so the loop only visits the rows and columns it can reach.
 *
 * Alpha below `uAlphaCut` is discarded by the shader, so these are real holes:
 * you see the inner shell through them, and the ball's silhouette is unbroken
 * because the mask never reaches the rim it is drawn on.
 */
export function drawWiffleBall(ctx, size) {
  // The canvas is square and the map is equirectangular, so v is stretched: it
  // covers 180 degrees where u covers 360. Harmless -- it only spends more
  // texels on latitude than it needs -- and it avoids a second texture shape
  // for one texture.
  const width = size;
  const height = size;
  const image = ctx.createImageData(width, height);
  const data = image.data;

  // Base: opaque white, with the mould seam as a bright ridge and a shadow
  // just below it. Subtle -- it is a moulding line, not a stripe.
  for (let row = 0; row < height; row++) {
    const v = (row + 0.5) / height;
    const fromSeam = Math.abs(v - 0.5);
    let shade = 1;
    // A moulding line, not a stripe: one texel row of highlight where the two
    // mould halves meet and a slightly wider shadow under it. At 1.1 and 0.88
    // it read as a painted band across the ball.
    if (fromSeam < 0.004) shade = 1.06;
    else if (fromSeam < 0.011) shade = 0.93;
    for (let col = 0; col < width; col++) {
      const i = (row * width + col) * 4;
      const value = Math.min(255, Math.round(255 * shade));
      data[i] = value;
      data[i + 1] = value;
      data[i + 2] = value;
      data[i + 3] = 255;
    }
  }

  const holes = wiffleHoleAxes();
  const R = WIFFLE_HOLE_ANGLE;
  // A texel of feather on the cut edge, and a rim of wall shading outside it.
  const feather = Math.PI / height;
  const rim = R * 0.35;
  const reach = R + rim;

  for (const hole of holes) {
    const phiHole = Math.acos(Math.max(-1, Math.min(1, hole.z)));
    const thetaHole = Math.atan2(hole.y, hole.x);
    const rowFrom = Math.max(0, Math.floor(((phiHole - reach) / Math.PI) * height));
    const rowTo = Math.min(height - 1, Math.ceil(((phiHole + reach) / Math.PI) * height));

    for (let row = rowFrom; row <= rowTo; row++) {
      const phi = ((row + 0.5) / height) * Math.PI;
      const cosPhi = Math.cos(phi);
      const sinPhi = Math.sin(phi);
      // The band of longitudes this row can reach: solve
      //   cos(angle) = cosPhi*cosPhiHole + sinPhi*sinPhiHole*cos(dTheta)
      // for cos(angle) = cos(reach). A row through the pole spans every
      // longitude, which is exactly what `sinPhi -> 0` gives here.
      const denom = sinPhi * Math.sin(phiHole);
      let dTheta = Math.PI;
      if (denom > 1e-6) {
        const c = (Math.cos(reach) - cosPhi * Math.cos(phiHole)) / denom;
        if (c > 1) continue; // this row cannot reach the hole at all
        dTheta = c < -1 ? Math.PI : Math.acos(c);
      }
      const span = Math.ceil((dTheta / (Math.PI * 2)) * width) + 1;
      const centreCol = Math.round(((thetaHole / (Math.PI * 2) + 1) % 1) * width);

      for (let d = -span; d <= span; d++) {
        const col = ((centreCol + d) % width + width) % width;
        const theta = ((col + 0.5) / width) * Math.PI * 2;
        // Exact angle from the hole axis, so the edge is a circle on the ball.
        const dot =
          sinPhi * Math.cos(theta) * hole.x +
          sinPhi * Math.sin(theta) * hole.y +
          cosPhi * hole.z;
        const angle = Math.acos(Math.max(-1, Math.min(1, dot)));
        if (angle >= reach) continue;

        const i = (row * width + col) * 4;
        if (angle <= R - feather) {
          data[i + 3] = 0;
          continue;
        }
        if (angle < R) {
          // Feathered cut edge: one texel of partial alpha, so the hole does
          // not crawl as the ball turns.
          const t = (angle - (R - feather)) / feather;
          const alpha = Math.round(255 * t);
          if (alpha < data[i + 3]) data[i + 3] = alpha;
          continue;
        }
        // Outside the hole: the moulded wall around it, darkest at the edge.
        const t = (angle - R) / rim;
        const shade = 0.4 + 0.6 * t * t;
        const value = Math.round(data[i] * shade);
        if (value < data[i]) {
          data[i] = value;
          data[i + 1] = value;
          data[i + 2] = value;
        }
      }
    }
  }

  ctx.putImageData(image, 0, 0);
}
