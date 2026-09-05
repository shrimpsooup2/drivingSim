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
