/**
 * Thin WebGL2 helpers: shader compilation, meshes and procedural textures.
 *
 * The simulator ships with no dependencies, so this is a small purpose-built
 * layer rather than a general renderer. It does exactly what this scene needs.
 * @module
 */

/**
 * @param {WebGL2RenderingContext} gl
 * @param {number} type
 * @param {string} source
 */
function compileShader(gl, type, source) {
  const shader = gl.createShader(type);
  if (!shader) throw new Error('could not create shader');
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error(`shader compile failed: ${log}\n${source}`);
  }
  return shader;
}

/**
 * Link a program and cache every uniform and attribute location up front, so
 * the draw loop never calls getUniformLocation.
 * @param {WebGL2RenderingContext} gl
 * @param {string} vertexSource
 * @param {string} fragmentSource
 */
export function createProgram(gl, vertexSource, fragmentSource) {
  const vs = compileShader(gl, gl.VERTEX_SHADER, vertexSource);
  const fs = compileShader(gl, gl.FRAGMENT_SHADER, fragmentSource);
  const program = gl.createProgram();
  if (!program) throw new Error('could not create program');
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    throw new Error(`program link failed: ${gl.getProgramInfoLog(program)}`);
  }
  gl.deleteShader(vs);
  gl.deleteShader(fs);

  /** @type {Record<string, WebGLUniformLocation>} */
  const uniforms = {};
  const uniformCount = gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS);
  for (let i = 0; i < uniformCount; i++) {
    const info = gl.getActiveUniform(program, i);
    if (!info) continue;
    const name = info.name.replace(/\[0\]$/, '');
    const loc = gl.getUniformLocation(program, name);
    if (loc) uniforms[name] = loc;
  }

  /** @type {Record<string, number>} */
  const attributes = {};
  const attribCount = gl.getProgramParameter(program, gl.ACTIVE_ATTRIBUTES);
  for (let i = 0; i < attribCount; i++) {
    const info = gl.getActiveAttrib(program, i);
    if (!info) continue;
    attributes[info.name] = gl.getAttribLocation(program, info.name);
  }

  return { program, uniforms, attributes };
}

/**
 * Upload an interleaved mesh (position 3, normal 3, uv 2) into a VAO.
 * @param {WebGL2RenderingContext} gl
 * @param {import('./geometry.js').MeshData} data
 * @param {Record<string, number>} attributes
 */
export function createMesh(gl, data, attributes) {
  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);

  const vbo = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
  gl.bufferData(gl.ARRAY_BUFFER, data.vertices, gl.STATIC_DRAW);

  const stride = 8 * 4;
  if (attributes.aPosition !== undefined && attributes.aPosition >= 0) {
    gl.enableVertexAttribArray(attributes.aPosition);
    gl.vertexAttribPointer(attributes.aPosition, 3, gl.FLOAT, false, stride, 0);
  }
  if (attributes.aNormal !== undefined && attributes.aNormal >= 0) {
    gl.enableVertexAttribArray(attributes.aNormal);
    gl.vertexAttribPointer(attributes.aNormal, 3, gl.FLOAT, false, stride, 12);
  }
  if (attributes.aUv !== undefined && attributes.aUv >= 0) {
    gl.enableVertexAttribArray(attributes.aUv);
    gl.vertexAttribPointer(attributes.aUv, 2, gl.FLOAT, false, stride, 24);
  }

  const ibo = gl.createBuffer();
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);
  gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, data.indices, gl.STATIC_DRAW);

  gl.bindVertexArray(null);
  return { vao, count: data.indices.length };
}

/**
 * Dynamic line buffer for debug overlays: force vectors, the path trail, slip
 * markers. Rewritten every frame with `gl.DYNAMIC_DRAW`.
 * @param {WebGL2RenderingContext} gl
 * @param {Record<string, number>} attributes
 * @param {number} maxVertices
 */
export function createLineBatch(gl, attributes, maxVertices = 8192) {
  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);
  const vbo = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
  // position (3) + colour (4)
  const data = new Float32Array(maxVertices * 7);
  gl.bufferData(gl.ARRAY_BUFFER, data.byteLength, gl.DYNAMIC_DRAW);
  const stride = 7 * 4;
  gl.enableVertexAttribArray(attributes.aPosition);
  gl.vertexAttribPointer(attributes.aPosition, 3, gl.FLOAT, false, stride, 0);
  gl.enableVertexAttribArray(attributes.aColor);
  gl.vertexAttribPointer(attributes.aColor, 4, gl.FLOAT, false, stride, 12);
  gl.bindVertexArray(null);

  let used = 0;
  return {
    vao,
    vbo,
    data,
    maxVertices,
    reset() {
      used = 0;
    },
    get count() {
      return used;
    },
    /** Append one line segment. Silently drops segments past capacity. */
    line(x1, y1, z1, x2, y2, z2, r, g, b, a = 1) {
      if (used + 2 > maxVertices) return;
      let o = used * 7;
      data[o++] = x1; data[o++] = y1; data[o++] = z1;
      data[o++] = r; data[o++] = g; data[o++] = b; data[o++] = a;
      data[o++] = x2; data[o++] = y2; data[o++] = z2;
      data[o++] = r; data[o++] = g; data[o++] = b; data[o++] = a;
      used += 2;
    },
    upload() {
      if (used === 0) return;
      gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, data, 0, used * 7);
    },
  };
}

/**
 * Build a texture from a 2D canvas drawn by `draw`.
 * @param {WebGL2RenderingContext} gl
 * @param {number} size
 * @param {(ctx: CanvasRenderingContext2D, size: number) => void} draw
 */
export function createCanvasTexture(gl, size, draw) {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2d context unavailable');
  draw(ctx, size);

  const texture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, canvas);
  gl.generateMipmap(gl.TEXTURE_2D);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);

  // Anisotropic filtering keeps the tile grid from turning to mush at the far
  // end of the field, which is exactly where a driver needs to judge distance.
  const ext =
    gl.getExtension('EXT_texture_filter_anisotropic') ||
    gl.getExtension('WEBKIT_EXT_texture_filter_anisotropic');
  if (ext) {
    const max = gl.getParameter(ext.MAX_TEXTURE_MAX_ANISOTROPY_EXT);
    gl.texParameterf(gl.TEXTURE_2D, ext.TEXTURE_MAX_ANISOTROPY_EXT, Math.min(8, max));
  }
  gl.bindTexture(gl.TEXTURE_2D, null);
  return texture;
}

/** Single-pixel white texture, so untextured draws can share one shader path. */
export function createWhiteTexture(gl) {
  const texture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([255, 255, 255, 255]));
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.bindTexture(gl.TEXTURE_2D, null);
  return texture;
}
