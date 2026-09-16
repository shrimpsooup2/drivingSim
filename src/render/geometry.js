/**
 * Procedural mesh builders.
 *
 * Every mesh is unit-sized and centred, so a single model matrix with scale can
 * place any box or cylinder without rebuilding geometry when the robot's
 * dimensions change in the parameter panel.
 *
 * Vertex layout is interleaved: position (3), normal (3), uv (2).
 * @module
 */

/** @typedef {{vertices: Float32Array, indices: Uint16Array}} MeshData */

/** Unit cube from -0.5 to +0.5 on every axis, with per-face normals. */
export function boxMesh() {
  const v = [];
  const idx = [];
  const faces = [
    { n: [0, 0, 1], u: [1, 0, 0], w: [0, 1, 0] },
    { n: [0, 0, -1], u: [-1, 0, 0], w: [0, 1, 0] },
    { n: [1, 0, 0], u: [0, 1, 0], w: [0, 0, 1] },
    { n: [-1, 0, 0], u: [0, -1, 0], w: [0, 0, 1] },
    { n: [0, 1, 0], u: [-1, 0, 0], w: [0, 0, 1] },
    { n: [0, -1, 0], u: [1, 0, 0], w: [0, 0, 1] },
  ];
  for (const f of faces) {
    const base = v.length / 8;
    for (const [su, sw, uu, vv] of [
      [-1, -1, 0, 0],
      [1, -1, 1, 0],
      [1, 1, 1, 1],
      [-1, 1, 0, 1],
    ]) {
      v.push(
        (f.n[0] + su * f.u[0] + sw * f.w[0]) * 0.5,
        (f.n[1] + su * f.u[1] + sw * f.w[1]) * 0.5,
        (f.n[2] + su * f.u[2] + sw * f.w[2]) * 0.5,
        f.n[0], f.n[1], f.n[2],
        uu, vv,
      );
    }
    idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  return { vertices: new Float32Array(v), indices: new Uint16Array(idx) };
}

/**
 * Unit cylinder: radius 1 in x/z, extent -0.5..0.5 along y, with caps.
 * Wheels use this, scaled by radius and width.
 * @param {number} segments
 */
export function cylinderMesh(segments = 24) {
  const v = [];
  const idx = [];

  // Side wall.
  for (let i = 0; i <= segments; i++) {
    const a = (i / segments) * Math.PI * 2;
    const c = Math.cos(a);
    const s = Math.sin(a);
    v.push(c, -0.5, s, c, 0, s, i / segments, 0);
    v.push(c, 0.5, s, c, 0, s, i / segments, 1);
  }
  for (let i = 0; i < segments; i++) {
    const a = i * 2;
    idx.push(a, a + 1, a + 3, a, a + 3, a + 2);
  }

  // Caps.
  for (const [y, ny] of [[-0.5, -1], [0.5, 1]]) {
    const centre = v.length / 8;
    v.push(0, y, 0, 0, ny, 0, 0.5, 0.5);
    for (let i = 0; i <= segments; i++) {
      const a = (i / segments) * Math.PI * 2;
      v.push(Math.cos(a), y, Math.sin(a), 0, ny, 0, 0.5 + Math.cos(a) * 0.5, 0.5 + Math.sin(a) * 0.5);
    }
    for (let i = 0; i < segments; i++) {
      if (ny > 0) idx.push(centre, centre + 1 + i, centre + 2 + i);
      else idx.push(centre, centre + 2 + i, centre + 1 + i);
    }
  }

  return { vertices: new Float32Array(v), indices: new Uint16Array(idx) };
}

/** Unit plane in the xy ground plane, 1x1 centred, facing +z. */
export function planeMesh(uvScale = 1) {
  return {
    vertices: new Float32Array([
      -0.5, -0.5, 0, 0, 0, 1, 0, 0,
      0.5, -0.5, 0, 0, 0, 1, uvScale, 0,
      0.5, 0.5, 0, 0, 0, 1, uvScale, uvScale,
      -0.5, 0.5, 0, 0, 0, 1, 0, uvScale,
    ]),
    indices: new Uint16Array([0, 1, 2, 0, 2, 3]),
  };
}

/** Flat arrow in the ground plane, pointing along +x, unit length. */
export function arrowMesh() {
  const w = 0.13;
  const headLength = 0.32;
  const headWidth = 0.3;
  const v = [];
  const idx = [];
  const push = (x, y) => {
    v.push(x, y, 0, 0, 0, 1, 0, 0);
    return v.length / 8 - 1;
  };
  const a = push(0, -w);
  const b = push(1 - headLength, -w);
  const c = push(1 - headLength, w);
  const d = push(0, w);
  idx.push(a, b, c, a, c, d);
  const e = push(1 - headLength, -headWidth);
  const f = push(1, 0);
  const g = push(1 - headLength, headWidth);
  idx.push(e, f, g);
  return { vertices: new Float32Array(v), indices: new Uint16Array(idx) };
}

/** Filled circle in the ground plane, radius 1. Used for the blob shadow. */
export function discMesh(segments = 32) {
  const v = [0, 0, 0, 0, 0, 1, 0.5, 0.5];
  const idx = [];
  for (let i = 0; i <= segments; i++) {
    const a = (i / segments) * Math.PI * 2;
    v.push(Math.cos(a), Math.sin(a), 0, 0, 0, 1, 0.5 + Math.cos(a) * 0.5, 0.5 + Math.sin(a) * 0.5);
  }
  for (let i = 0; i < segments; i++) idx.push(0, 1 + i, 2 + i);
  return { vertices: new Float32Array(v), indices: new Uint16Array(idx) };
}

/**
 * Unit sphere of radius 1, for POLLEN and NECTAR.
 *
 * Latitude/longitude tessellation, which is the cheapest thing that shades
 * smoothly -- on a unit sphere the normal at a vertex is just its position.
 *
 * @param {number} [segments] divisions around the equator
 * @param {number} [rings] divisions from pole to pole
 */
export function sphereMesh(segments = 16, rings = 10) {
  const v = [];
  const idx = [];
  for (let r = 0; r <= rings; r++) {
    const phi = (r / rings) * Math.PI;
    const z = Math.cos(phi);
    const ringRadius = Math.sin(phi);
    for (let s = 0; s <= segments; s++) {
      const theta = (s / segments) * Math.PI * 2;
      const x = ringRadius * Math.cos(theta);
      const y = ringRadius * Math.sin(theta);
      v.push(x, y, z, x, y, z, s / segments, r / rings);
    }
  }
  const stride = segments + 1;
  for (let r = 0; r < rings; r++) {
    for (let s = 0; s < segments; s++) {
      const a = r * stride + s;
      const b = a + stride;
      idx.push(a, b, a + 1, a + 1, b, b + 1);
    }
  }
  return { vertices: new Float32Array(v), indices: new Uint16Array(idx) };
}

/**
 * The BIOBUZZ CELL: a pentagonal prism, open on one end face.
 *
 * Figure 9-11 gives the rib as a 20 in base, straight sides to a shoulder, then
 * a taper to an apex. Built as a unit shape -- x across the 2 wide base, y along
 * the prism (the arm), z from 0 at the base to 1 at the apex -- so the caller
 * scales it by the real width, depth and height.
 *
 * **Two-sided**, and that is the whole reason this comment exists. A CELL is a
 * box you look *into*, so some of its walls always face away from the camera --
 * and with back-face culling on, a single-sided wall simply is not drawn from
 * that side. The result was a HIVE that looked solid from one angle and open
 * from another, changing as the camera moved, which reads as broken
 * transparency rather than as a basket. Every wall carries both windings with
 * flipped normals, so exactly one face of each pair survives culling from any
 * angle and the CELL is consistent from all of them.
 *
 * @param {number} shoulder shoulder height as a fraction of the full height
 */
export function cellMesh(shoulder = 0.54) {
  // Rib outline, counter-clockwise in the x-z plane of the opening.
  const outline = [
    [-1, 0],
    [1, 0],
    [1, shoulder],
    [0, 1],
    [-1, shoulder],
  ];
  const v = [];
  const idx = [];
  const push = (x, y, z, nx, ny, nz, u, w) => {
    v.push(x, y, z, nx, ny, nz, u, w);
    return v.length / 8 - 1;
  };

  // Walls: one quad per outline edge, spanning the prism's depth.
  for (let i = 0; i < outline.length; i++) {
    const [ax, az] = outline[i];
    const [bx, bz] = outline[(i + 1) % outline.length];
    let nx = az - bz;
    let nz = bx - ax;
    const n = Math.hypot(nx, nz) || 1;
    nx /= n;
    nz /= n;
    const a = push(ax, 0, az, nx, 0, nz, 0, 0);
    const b = push(bx, 0, bz, nx, 0, nz, 1, 0);
    const c = push(bx, 1, bz, nx, 0, nz, 1, 1);
    const d = push(ax, 1, az, nx, 0, nz, 0, 1);
    idx.push(a, b, c, a, c, d);
    // The same wall from inside: reversed winding, reversed normal.
    const ia = push(ax, 0, az, -nx, 0, -nz, 0, 0);
    const ib = push(bx, 0, bz, -nx, 0, -nz, 1, 0);
    const ic = push(bx, 1, bz, -nx, 0, -nz, 1, 1);
    const id = push(ax, 1, az, -nx, 0, -nz, 0, 1);
    idx.push(ia, ic, ib, ia, id, ic);
  }

  // Back face only -- the opening end is left open so a shot can get in.
  const centre = push(0, 1, shoulder * 0.6, 0, 1, 0, 0.5, 0.5);
  const inner = push(0, 1, shoulder * 0.6, 0, -1, 0, 0.5, 0.5);
  for (let i = 0; i < outline.length; i++) {
    const [ax, az] = outline[i];
    const [bx, bz] = outline[(i + 1) % outline.length];
    const a = push(ax, 1, az, 0, 1, 0, 0, 0);
    const b = push(bx, 1, bz, 0, 1, 0, 1, 0);
    idx.push(centre, b, a);
    const ia = push(ax, 1, az, 0, -1, 0, 0, 0);
    const ib = push(bx, 1, bz, 0, -1, 0, 1, 0);
    idx.push(inner, ia, ib);
  }

  return { vertices: new Float32Array(v), indices: new Uint16Array(idx) };
}
