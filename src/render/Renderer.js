import * as mat4 from './mat4.js';
import { arrowMesh, boxMesh, cylinderMesh, discMesh, planeMesh } from './geometry.js';
import { createCanvasTexture, createLineBatch, createMesh, createProgram, createWhiteTexture } from './gl.js';
import { LINE_FRAGMENT, LINE_VERTEX, LIT_FRAGMENT, LIT_VERTEX } from './shaders.js';
import { drawMecanumTread, drawPlate, drawTile, drawTractionTread } from './textures.js';
import { CameraRig } from './Camera.js';
import { clamp } from '../math/MathUtil.js';

const LIGHT_DIR = [0.45, 0.35, 0.82];
const SKY = [0.42, 0.46, 0.54];
const GROUND = [0.10, 0.11, 0.13];

/**
 * WebGL2 renderer for the field and robot.
 *
 * Draws the parallel-plate chassis as what it actually is -- two side plates,
 * cross members and a top plate -- rather than as a featureless box, because
 * seeing the real geometry makes the wheel positions and the robot's facing
 * readable at a glance, which matters when you are learning to judge a turn.
 *
 * Debug overlays (per-wheel force vectors, slip markers, load rings) draw in
 * world space alongside the robot so the physics is visible while you drive,
 * not just afterwards in a graph.
 */
export class Renderer {
  /** @param {HTMLCanvasElement} canvas */
  constructor(canvas) {
    this.canvas = canvas;
    const gl = canvas.getContext('webgl2', {
      antialias: true,
      alpha: false,
      powerPreference: 'high-performance',
    });
    if (!gl) throw new Error('WebGL2 is not available in this browser.');
    /** @type {WebGL2RenderingContext} */
    this.gl = gl;

    this.lit = createProgram(gl, LIT_VERTEX, LIT_FRAGMENT);
    this.lineProgram = createProgram(gl, LINE_VERTEX, LINE_FRAGMENT);

    this.meshes = {
      box: createMesh(gl, boxMesh(), this.lit.attributes),
      cylinder: createMesh(gl, cylinderMesh(28), this.lit.attributes),
      plane: createMesh(gl, planeMesh(1), this.lit.attributes),
      tiles: createMesh(gl, planeMesh(6), this.lit.attributes),
      arrow: createMesh(gl, arrowMesh(), this.lit.attributes),
      disc: createMesh(gl, discMesh(40), this.lit.attributes),
    };

    this.textures = {
      white: createWhiteTexture(gl),
      tile: createCanvasTexture(gl, 256, drawTile),
      plate: createCanvasTexture(gl, 256, drawPlate),
      mecanumLeft: createCanvasTexture(gl, 256, drawMecanumTread(1)),
      mecanumRight: createCanvasTexture(gl, 256, drawMecanumTread(-1)),
      traction: createCanvasTexture(gl, 256, drawTractionTread),
    };

    this.lines = createLineBatch(gl, this.lineProgram.attributes, 24576);
    this.camera = new CameraRig();

    this._model = mat4.create();
    this._normal = new Float32Array(9);
    this.pixelRatio = 1;
    this.width = 1;
    this.height = 1;

    gl.enable(gl.DEPTH_TEST);
    gl.enable(gl.CULL_FACE);
    gl.cullFace(gl.BACK);
    gl.clearColor(0.06, 0.07, 0.09, 1);
  }

  /** Match the drawing buffer to the CSS size, capped for very high-DPI screens. */
  resize() {
    const gl = this.gl;
    const ratio = Math.min(globalThis.devicePixelRatio || 1, 2);
    const width = Math.max(1, Math.floor(this.canvas.clientWidth * ratio));
    const height = Math.max(1, Math.floor(this.canvas.clientHeight * ratio));
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
    }
    this.pixelRatio = ratio;
    this.width = width;
    this.height = height;
    gl.viewport(0, 0, width, height);
    return this;
  }

  /**
   * @param {import('../app/Simulation.js').Simulation} sim
   * @param {number} dt seconds since the last frame
   */
  render(sim, dt) {
    const gl = this.gl;
    const config = sim.config;
    const body = sim.robot.body;

    this.resize();
    this.camera.update(this.width / this.height, {
      mode: config.view.camera,
      robotX: body.position.x,
      robotY: body.position.y,
      robotHeading: body.rotation.radians,
      fieldSize: sim.field.size,
      dt,
    });

    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.useProgram(this.lit.program);
    gl.uniformMatrix4fv(this.lit.uniforms.uProjection, false, this.camera.projection);
    gl.uniformMatrix4fv(this.lit.uniforms.uView, false, this.camera.view);
    gl.uniform3fv(this.lit.uniforms.uLightDir, LIGHT_DIR);
    gl.uniform3fv(this.lit.uniforms.uSkyColor, SKY);
    gl.uniform3fv(this.lit.uniforms.uGroundColor, GROUND);
    gl.uniform1i(this.lit.uniforms.uTexture, 0);
    gl.activeTexture(gl.TEXTURE0);

    this._drawField(sim);
    this._drawRobot(sim);

    this.lines.reset();
    this._buildOverlays(sim);
    this._drawLines();
  }

  /**
   * Issue one draw call.
   * @param {{vao:WebGLVertexArrayObject|null, count:number}} mesh
   */
  _draw(mesh, model, color, texture = this.textures.white, emissive = 0) {
    const gl = this.gl;
    mat4.normalMatrix(this._normal, model);
    gl.uniformMatrix4fv(this.lit.uniforms.uModel, false, model);
    gl.uniformMatrix3fv(this.lit.uniforms.uNormalMatrix, false, this._normal);
    gl.uniform4fv(this.lit.uniforms.uColor, color);
    gl.uniform1f(this.lit.uniforms.uUseTexture, texture === this.textures.white ? 0 : 1);
    gl.uniform1f(this.lit.uniforms.uEmissive, emissive);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.bindVertexArray(mesh.vao);
    gl.drawElements(gl.TRIANGLES, mesh.count, gl.UNSIGNED_SHORT, 0);
  }

  _drawField(sim) {
    const field = sim.field;
    const m = this._model;
    const tileSpan = field.tileSize * field.tilesPerSide;

    // Tiled foam floor.
    mat4.composeZ(m, 0, 0, 0, 1, 0, tileSpan, tileSpan, 1);
    this._draw(this.meshes.tiles, m, [1, 1, 1, 1], this.textures.tile);

    // Perimeter walls, sitting just outside the tile area.
    const half = field.halfSize;
    const t = field.wallThickness;
    const h = field.wallHeight;
    const wallColor = [0.72, 0.74, 0.78, 1];
    const specs = [
      [half + t / 2, 0, t, field.size + t * 2],
      [-half - t / 2, 0, t, field.size + t * 2],
      [0, half + t / 2, field.size + t * 2, t],
      [0, -half - t / 2, field.size + t * 2, t],
    ];
    for (const [x, y, sx, sy] of specs) {
      mat4.composeZ(m, x, y, h / 2, 1, 0, sx, sy, h);
      this._draw(this.meshes.box, m, wallColor, this.textures.white);
    }

    // A coloured strip marks the driver-station end, so the field has a
    // consistent orientation cue no matter which camera you are using.
    mat4.composeZ(m, -half - t / 2, 0, h * 0.86, 1, 0, t * 1.1, field.size * 0.55, h * 0.16);
    this._draw(this.meshes.box, m, [0.24, 0.52, 0.92, 1], this.textures.white, 0.35);

    for (const element of field.elements) {
      const d = element.describe?.();
      if (!d) continue;
      const c = Math.cos(d.heading ?? 0);
      const s = Math.sin(d.heading ?? 0);
      const size = d.size ?? { x: 0.1, y: 0.1 };
      const height = d.height ?? 0.1;
      mat4.composeZ(m, d.position.x, d.position.y, height / 2, c, s, size.x, size.y, height);
      this._draw(this.meshes.box, m, d.color ?? [0.8, 0.6, 0.2, 1], this.textures.white);
    }
  }

  _drawRobot(sim) {
    const gl = this.gl;
    const robot = sim.robot;
    const config = sim.config;
    const body = robot.body;
    const m = this._model;
    const cosT = body.rotation.cos;
    const sinT = body.rotation.sin;
    const px = body.position.x;
    const py = body.position.y;

    const wheelRadius = config.drivetrain.wheelRadius;
    const wheelWidth = wheelRadius * 0.8;
    const frameLength = config.chassis.length;
    const trackWidth = config.drivetrain.trackWidth;
    const wheelbase = config.drivetrain.wheelbase;

    const plateThickness = 0.006;
    const plateHeight = clamp(config.chassis.height * 0.55, 0.07, 0.15);
    const plateZ = wheelRadius + plateHeight * 0.22;
    // Side plates sit just inboard of the wheels, which is what makes this a
    // parallel-plate chassis rather than a box with wheels attached.
    const plateY = Math.max(0.025, trackWidth / 2 - wheelWidth / 2 - plateThickness / 2 - 0.004);
    const deckZ = plateZ + plateHeight / 2;

    // Body-frame -> world helper. Every part is positioned in the chassis frame
    // and transformed once here, so the whole robot stays rigid by construction.
    const toWorld = (bx, by) => [px + cosT * bx - sinT * by, py + sinT * bx + cosT * by];

    // Soft contact shadow, so the robot reads as sitting on the tiles rather
    // than floating above them.
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.depthMask(false);
    mat4.composeZ(m, px, py, 0.0025, cosT, sinT, frameLength * 0.5, trackWidth * 0.62, 1);
    this._draw(this.meshes.disc, m, [0, 0, 0, 0.28], this.textures.white, 1);
    gl.depthMask(true);
    gl.disable(gl.BLEND);

    const plateColor = [0.80, 0.83, 0.88, 1];
    const darkMetal = [0.40, 0.43, 0.48, 1];
    const accent = [0.16, 0.62, 0.86, 1];

    // The two parallel side plates the chassis style is named for.
    for (const side of [1, -1]) {
      const [x, y] = toWorld(0, plateY * side);
      mat4.composeZ(m, x, y, plateZ, cosT, sinT, frameLength, plateThickness, plateHeight);
      this._draw(this.meshes.box, m, plateColor, this.textures.plate);
    }

    // Cross members tying the plates together at each end.
    const crossSpan = plateY * 2 - plateThickness;
    for (const sx of [1, -1]) {
      const [x, y] = toWorld(frameLength * 0.45 * sx, 0);
      mat4.composeZ(m, x, y, plateZ, cosT, sinT, 0.016, crossSpan, plateHeight * 0.72);
      this._draw(this.meshes.box, m, darkMetal, this.textures.white);
    }

    const wheels = robot.drivetrain.wheels;

    // Drive motors, mounted inboard of each wheel along its axle. Drawing these
    // is not decoration: seeing where the motors sit is half of understanding
    // why the centre of gravity is where it is.
    for (const wheel of wheels) {
      const heading = body.rotation.radians + wheel.steerAngle;
      const wc = Math.cos(heading);
      const ws = Math.sin(heading);
      // Axle direction in the chassis frame, pointing inboard.
      const inboard = wheel.position.y >= 0 ? -1 : 1;
      const axleX = -Math.sin(wheel.steerAngle) * inboard;
      const axleY = Math.cos(wheel.steerAngle) * inboard;
      const offset = wheelWidth / 2 + 0.048;
      const [mx, my] = toWorld(
        wheel.position.x + axleX * offset,
        wheel.position.y + axleY * offset,
      );
      mat4.composeWheel(m, mx, my, wheelRadius, wc, ws, 0, 0.019, 0.086);
      this._draw(this.meshes.cylinder, m, [0.22, 0.24, 0.27, 1], this.textures.white);
    }

    // Top deck. Kept inside the wheelbase deliberately: a full-length cover
    // would hide the wheels from above, and watching the wheels -- especially
    // the mecanum roller pattern and which one is slipping -- is most of the
    // point of looking at the robot at all.
    mat4.composeZ(m, px, py, deckZ + 0.004, cosT, sinT, wheelbase * 0.82, crossSpan, 0.007);
    this._draw(this.meshes.box, m, plateColor, this.textures.plate);

    // Battery pack, sitting where a real one does: low and toward the back.
    {
      const [bx, by] = toWorld(-wheelbase * 0.2, 0);
      mat4.composeZ(m, bx, by, deckZ + 0.036, cosT, sinT, 0.135, 0.072, 0.056);
      this._draw(this.meshes.box, m, [0.14, 0.15, 0.18, 1], this.textures.white);
    }

    // Control Hub, forward of the battery.
    {
      const [hx, hy] = toWorld(wheelbase * 0.14, 0);
      mat4.composeZ(m, hx, hy, deckZ + 0.020, cosT, sinT, 0.095, 0.09, 0.026);
      this._draw(this.meshes.box, m, [0.18, 0.2, 0.24, 1], this.textures.white);
    }

    // Facing arrow. Without it, telling a square robot's front from its back at
    // the far end of the field is genuinely hard -- which is true in real
    // matches too, and why teams put markers on their robots.
    {
      const [ax, ay] = toWorld(wheelbase * 0.34, 0);
      mat4.composeZ(m, ax, ay, deckZ + 0.012, cosT, sinT, frameLength * 0.3, frameLength * 0.3, 1);
      this._draw(this.meshes.arrow, m, accent, this.textures.white, 0.5);
    }

    // Wheels last, so they draw over the shadow cleanly.
    for (const wheel of wheels) {
      const [wx, wy] = toWorld(wheel.position.x, wheel.position.y);
      const heading = body.rotation.radians + wheel.steerAngle;
      const wc = Math.cos(heading);
      const ws = Math.sin(heading);
      const texture =
        wheel.kind === 'traction'
          ? this.textures.traction
          : wheel.rollerAngle >= 0
            ? this.textures.mecanumLeft
            : this.textures.mecanumRight;
      mat4.composeWheel(m, wx, wy, wheelRadius, wc, ws, wheel.angle, wheelRadius, wheelWidth);
      this._draw(this.meshes.cylinder, m, [0.95, 0.95, 0.97, 1], texture);
    }
  }

  _buildOverlays(sim) {
    const config = sim.config;
    const robot = sim.robot;
    const body = robot.body;
    const cosT = body.rotation.cos;
    const sinT = body.rotation.sin;
    const px = body.position.x;
    const py = body.position.y;
    const z = 0.012;

    if (config.view.showTrail && sim.trail.length > 1) {
      const n = sim.trail.length;
      for (let i = 1; i < n; i++) {
        const a = sim.trail[i - 1];
        const b = sim.trail[i];
        // Fade the tail so the recent path stands out.
        const alpha = (i / n) * 0.85;
        this.lines.line(a[0], a[1], z, b[0], b[1], z, 0.35, 0.85, 1.0, alpha);
      }
    }

    const weight = robot.body.mass * 9.80665;

    for (const wheel of robot.drivetrain.wheels) {
      const wx = px + cosT * wheel.position.x - sinT * wheel.position.y;
      const wy = py + sinT * wheel.position.x + cosT * wheel.position.y;

      if (config.view.showForceVectors) {
        // Scale so one robot weight of force is about 30 cm of arrow.
        const scale = 0.3 / Math.max(weight * 0.25, 1);
        const fx = cosT * wheel.force.x - sinT * wheel.force.y;
        const fy = sinT * wheel.force.x + cosT * wheel.force.y;
        // Green with grip in reserve, red at the limit of adhesion.
        const usage = clamp(wheel.gripUsage, 0, 1);
        const r = usage;
        const g = 1 - usage * 0.85;
        this.lines.line(wx, wy, z, wx + fx * scale, wy + fy * scale, z, r, g, 0.18, 0.95);
      }

      if (config.view.showLoads) {
        // Ring radius proportional to the share of weight on this wheel.
        const share = weight > 0 ? wheel.normalForce / weight : 0;
        this._circle(wx, wy, z, 0.28 * Math.sqrt(Math.max(share, 0)), 0.95, 0.8, 0.25, 0.8);
      }

      if (config.view.showSlip && wheel.slipSpeed > config.surface.slipAtPeakGrip * 0.6) {
        const s = 0.045;
        this.lines.line(wx - s, wy - s, z + 0.002, wx + s, wy + s, z + 0.002, 1, 0.25, 0.15, 1);
        this.lines.line(wx - s, wy + s, z + 0.002, wx + s, wy - s, z + 0.002, 1, 0.25, 0.15, 1);
      }
    }

    if (config.view.showForceVectors) {
      // Chassis velocity, from the centre of mass.
      const vScale = 0.35;
      this.lines.line(px, py, z + 0.004, px + body.velocity.x * vScale, py + body.velocity.y * vScale, z + 0.004, 0.3, 0.6, 1, 0.95);
    }
  }

  _circle(x, y, z, radius, r, g, b, a, segments = 24) {
    let prevX = x + radius;
    let prevY = y;
    for (let i = 1; i <= segments; i++) {
      const ang = (i / segments) * Math.PI * 2;
      const nx = x + Math.cos(ang) * radius;
      const ny = y + Math.sin(ang) * radius;
      this.lines.line(prevX, prevY, z, nx, ny, z, r, g, b, a);
      prevX = nx;
      prevY = ny;
    }
  }

  _drawLines() {
    const gl = this.gl;
    if (this.lines.count === 0) return;
    this.lines.upload();
    gl.useProgram(this.lineProgram.program);
    gl.uniformMatrix4fv(this.lineProgram.uniforms.uProjection, false, this.camera.projection);
    gl.uniformMatrix4fv(this.lineProgram.uniforms.uView, false, this.camera.view);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.disable(gl.DEPTH_TEST);
    gl.bindVertexArray(this.lines.vao);
    gl.drawArrays(gl.LINES, 0, this.lines.count);
    gl.enable(gl.DEPTH_TEST);
    gl.disable(gl.BLEND);
    gl.bindVertexArray(null);
  }
}
