/**
 * Minimal 4x4 matrix and 3-vector maths for the renderer.
 *
 * Column-major, matching what WebGL's uniformMatrix4fv expects with
 * `transpose = false`. Only what the scene actually needs is here.
 * @module
 */

export function create() {
  const m = new Float32Array(16);
  m[0] = m[5] = m[10] = m[15] = 1;
  return m;
}

export function identity(out) {
  out.fill(0);
  out[0] = out[5] = out[10] = out[15] = 1;
  return out;
}

/** out = a * b */
export function multiply(out, a, b) {
  const a00 = a[0], a01 = a[1], a02 = a[2], a03 = a[3];
  const a10 = a[4], a11 = a[5], a12 = a[6], a13 = a[7];
  const a20 = a[8], a21 = a[9], a22 = a[10], a23 = a[11];
  const a30 = a[12], a31 = a[13], a32 = a[14], a33 = a[15];
  for (let i = 0; i < 4; i++) {
    const b0 = b[i * 4], b1 = b[i * 4 + 1], b2 = b[i * 4 + 2], b3 = b[i * 4 + 3];
    out[i * 4] = b0 * a00 + b1 * a10 + b2 * a20 + b3 * a30;
    out[i * 4 + 1] = b0 * a01 + b1 * a11 + b2 * a21 + b3 * a31;
    out[i * 4 + 2] = b0 * a02 + b1 * a12 + b2 * a22 + b3 * a32;
    out[i * 4 + 3] = b0 * a03 + b1 * a13 + b2 * a23 + b3 * a33;
  }
  return out;
}

export function perspective(out, fovyRadians, aspect, near, far) {
  const f = 1 / Math.tan(fovyRadians / 2);
  out.fill(0);
  out[0] = f / aspect;
  out[5] = f;
  out[11] = -1;
  const nf = 1 / (near - far);
  out[10] = (far + near) * nf;
  out[14] = 2 * far * near * nf;
  return out;
}

export function lookAt(out, eye, center, up) {
  let zx = eye[0] - center[0];
  let zy = eye[1] - center[1];
  let zz = eye[2] - center[2];
  let len = Math.hypot(zx, zy, zz);
  if (len < 1e-9) {
    return identity(out);
  }
  zx /= len; zy /= len; zz /= len;

  let xx = up[1] * zz - up[2] * zy;
  let xy = up[2] * zx - up[0] * zz;
  let xz = up[0] * zy - up[1] * zx;
  len = Math.hypot(xx, xy, xz);
  if (len < 1e-9) {
    xx = 1; xy = 0; xz = 0;
  } else {
    xx /= len; xy /= len; xz /= len;
  }

  const yx = zy * xz - zz * xy;
  const yy = zz * xx - zx * xz;
  const yz = zx * xy - zy * xx;

  out[0] = xx; out[1] = yx; out[2] = zx; out[3] = 0;
  out[4] = xy; out[5] = yy; out[6] = zy; out[7] = 0;
  out[8] = xz; out[9] = yz; out[10] = zz; out[11] = 0;
  out[12] = -(xx * eye[0] + xy * eye[1] + xz * eye[2]);
  out[13] = -(yx * eye[0] + yy * eye[1] + yz * eye[2]);
  out[14] = -(zx * eye[0] + zy * eye[1] + zz * eye[2]);
  out[15] = 1;
  return out;
}

/**
 * Build a model matrix for the common case: translate, rotate about the
 * vertical (world z) axis, then scale. Every object in this scene sits flat on
 * the field, so no other rotation is needed.
 */
export function composeZ(out, x, y, z, cosT, sinT, sx, sy, sz) {
  out[0] = cosT * sx; out[1] = sinT * sx; out[2] = 0; out[3] = 0;
  out[4] = -sinT * sy; out[5] = cosT * sy; out[6] = 0; out[7] = 0;
  out[8] = 0; out[9] = 0; out[10] = sz; out[11] = 0;
  out[12] = x; out[13] = y; out[14] = z; out[15] = 1;
  return out;
}

/**
 * Model matrix that also spins about the object's local y axis, used for
 * wheels so they visibly roll.
 */
export function composeWheel(out, x, y, z, cosT, sinT, spin, radius, width) {
  // Local: cylinder along y, spinning about y.
  const cs = Math.cos(spin);
  const ss = Math.sin(spin);
  // Local rotation about y by `spin`, then about z by theta.
  const m00 = cs, m02 = ss;
  const m20 = -ss, m22 = cs;
  out[0] = cosT * m00 * radius;
  out[1] = sinT * m00 * radius;
  out[2] = m20 * radius;
  out[3] = 0;
  out[4] = -sinT * width;
  out[5] = cosT * width;
  out[6] = 0;
  out[7] = 0;
  out[8] = cosT * m02 * radius;
  out[9] = sinT * m02 * radius;
  out[10] = m22 * radius;
  out[11] = 0;
  out[12] = x; out[13] = y; out[14] = z; out[15] = 1;
  return out;
}

/** out = transpose(inverse(m)), as a 3x3 packed into a 9-float array. */
export function normalMatrix(out, m) {
  const a00 = m[0], a01 = m[1], a02 = m[2];
  const a10 = m[4], a11 = m[5], a12 = m[6];
  const a20 = m[8], a21 = m[9], a22 = m[10];

  const b01 = a22 * a11 - a12 * a21;
  const b11 = -a22 * a10 + a12 * a20;
  const b21 = a21 * a10 - a11 * a20;

  let det = a00 * b01 + a01 * b11 + a02 * b21;
  if (Math.abs(det) < 1e-12) {
    out.set([1, 0, 0, 0, 1, 0, 0, 0, 1]);
    return out;
  }
  det = 1 / det;

  out[0] = b01 * det;
  out[1] = (-a22 * a01 + a02 * a21) * det;
  out[2] = (a12 * a01 - a02 * a11) * det;
  out[3] = b11 * det;
  out[4] = (a22 * a00 - a02 * a20) * det;
  out[5] = (-a12 * a00 + a02 * a10) * det;
  out[6] = b21 * det;
  out[7] = (-a21 * a00 + a01 * a20) * det;
  out[8] = (a11 * a00 - a01 * a10) * det;
  return out;
}
