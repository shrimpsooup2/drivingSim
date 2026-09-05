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
