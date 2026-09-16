import * as mat4 from './mat4.js';
import {
  arrowMesh,
  boxMesh,
  cellMesh,
  cylinderMesh,
  discMesh,
  planeMesh,
  sphereMesh,
} from './geometry.js';
import { createCanvasTexture, createLineBatch, createMesh, createProgram, createWhiteTexture } from './gl.js';
import { LINE_FRAGMENT, LINE_VERTEX, LIT_FRAGMENT, LIT_VERTEX } from './shaders.js';
import {
  drawMecanumTread,
  drawPlate,
  drawTile,
  drawTractionTread,
  drawWiffleBall,
} from './textures.js';
import { CameraRig } from './Camera.js';
import { clamp } from '../math/MathUtil.js';
import {
  CELL_DEPTH,
  CELL_OPENING_HEIGHT,
  CELL_OPENING_WIDTH,
  CELL_SHOULDER_HEIGHT,
  FLOWER_BACKSTOP_HEIGHT,
  FLOWER_PIPE_OFFSET,
  FLOWER_PIPE_RADIUS,
  FRAME_FOOT_HALF_DEPTH,
  FRAME_FOOT_HEIGHT,
  FRAME_FOOT_INNER,
  FRAME_FOOT_OUTER,
  FRAME_STRUT_BASE,
  FRAME_STRUT_TOP,
  HIVE_PIVOT_HEIGHT,
  TILE_THICKNESS,
} from '../field/biobuzz/constants.js';

const ACCENT = [0.16, 0.62, 0.86, 1];
const GATE_POST_HEIGHT = 0.34;

/** Grey for not yet reached, cyan for the one you want, green for cleared. */
const STATUS_COLOURS = {
  pending: [0.52, 0.56, 0.63, 1],
  active: [0.20, 0.82, 0.98, 1],
  done: [0.28, 0.78, 0.45, 1],
};

/**
 * How far in the inner shell of a SCORING ELEMENT sits, as a fraction of the
 * radius.
 *
 * A real moulded ball's wall is about a twentieth of its radius, but drawn at
 * that it is a hairline: the eye reads depth through a hole from the *step*
 * between the two shells, and it needs a few pixels of it at the size these
 * render. An eighth is what makes the holes read as holes from the driver
 * station without looking like they go to the centre.
 */
const BALL_SHELL = 0.88;

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
      sphere: createMesh(gl, sphereMesh(16, 10), this.lit.attributes),
      /**
       * A SCORING ELEMENT's outer shell, tessellated finer than the plain
       * sphere.
       *
       * The holes themselves are cut per pixel by the alpha mask, so they stay
       * round however coarse this is -- but the ball's *silhouette* is
       * geometry, and at 16 segments a POLLEN filling the screen in the zoomed
       * camera is visibly a polygon.
       */
      ball: createMesh(gl, sphereMesh(28, 18), this.lit.attributes),
      cell: createMesh(gl, cellMesh(CELL_SHOULDER_HEIGHT / CELL_OPENING_HEIGHT), this.lit.attributes),
    };

    this.textures = {
      white: createWhiteTexture(gl),
      tile: createCanvasTexture(gl, 256, drawTile),
      plate: createCanvasTexture(gl, 256, drawPlate),
      mecanumLeft: createCanvasTexture(gl, 256, drawMecanumTread(1)),
      mecanumRight: createCanvasTexture(gl, 256, drawMecanumTread(-1)),
      traction: createCanvasTexture(gl, 256, drawTractionTread),
      // One mask for all three element colours: it is white, and the shader
      // multiplies it by the ball's own colour. 512 puts about 28 texels
      // across a hole, which holds up zoomed in.
      wiffle: createCanvasTexture(gl, 512, drawWiffleBall),
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
      view: config.view,
      robotX: body.position.x,
      robotY: body.position.y,
      robotHeading: body.rotation.radians,
      fieldSize: sim.field.size,
      time: sim.time,
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
    this._drawChallengeSolids(sim);
    if (sim.game) this._drawGame(sim.game);
    this._drawRobot(sim);

    this.lines.reset();
    this._buildChallengeLines(sim);
    if (sim.game) this._buildGameLines(sim.game, config.view);
    this._buildOverlays(sim);
    this._drawLines();
  }

  /**
   * World-anchored labels for the active drill, returned for the 2D overlay to
   * draw. Kept here because this is where the camera projection lives.
   * @param {import('../app/Simulation.js').Simulation} sim
   * @returns {{x:number,y:number,visible:boolean,text:string,status:string}[]}
   */
  challengeLabels(sim) {
    const challenge = sim.challenges?.active;
    if (!challenge || !sim.config.view.showChallengeLabels) return [];
    const out = [];
    for (const shape of challenge.describe()) {
      if (!shape.label || shape.kind === 'corridor') continue;
      const height = shape.kind === 'gate' ? GATE_POST_HEIGHT + 0.04 : 0.06;
      const p = this.camera.project(shape.center.x, shape.center.y, height);
      out.push({ ...p, text: shape.label, status: shape.status });
    }
    return out;
  }

  /** Posts and other solid geometry belonging to the active drill. */
  _drawChallengeSolids(sim) {
    const challenge = sim.challenges?.active;
    if (!challenge) return;
    const m = this._model;

    for (const shape of challenge.describe()) {
      if (shape.kind !== 'gate') continue;
      const colour = STATUS_COLOURS[shape.status] ?? STATUS_COLOURS.pending;
      const c = Math.cos(shape.heading);
      const s = Math.sin(shape.heading);
      // Posts sit at the ends of the gate, perpendicular to its heading.
      const nx = -s;
      const ny = c;
      const h = shape.width / 2;
      for (const side of [1, -1]) {
        mat4.composeZ(
          m,
          shape.center.x + nx * h * side,
          shape.center.y + ny * h * side,
          GATE_POST_HEIGHT / 2,
          c,
          s,
          0.035,
          0.035,
          GATE_POST_HEIGHT,
        );
        this._draw(this.meshes.box, m, colour, this.textures.white, 0.5);
      }
    }
  }

  /**
   * Floor markings for the active drill: gate bars, target rings and lane
   * edges. Drawn as lines so they read clearly from the low driver-station
   * camera, where a flat filled shape almost disappears.
   */
  _buildChallengeLines(sim) {
    const challenge = sim.challenges?.active;
    if (!challenge) return;
    const z = 0.008;
    // Pulse the active objective so the eye finds it without reading labels.
    const pulse = 0.55 + 0.45 * Math.sin(sim.time * 4);

    for (const shape of challenge.describe()) {
      const base = STATUS_COLOURS[shape.status] ?? STATUS_COLOURS.pending;
      const alpha = shape.status === 'active' ? pulse : shape.status === 'done' ? 0.4 : 0.55;

      if (shape.kind === 'gate') {
        const nx = -Math.sin(shape.heading);
        const ny = Math.cos(shape.heading);
        const h = shape.width / 2;
        const x1 = shape.center.x + nx * h;
        const y1 = shape.center.y + ny * h;
        const x2 = shape.center.x - nx * h;
        const y2 = shape.center.y - ny * h;
        this.lines.line(x1, y1, z, x2, y2, z, base[0], base[1], base[2], alpha);
        // A short arrow through the gate showing which way counts.
        if (shape.status === 'active') {
          const dx = Math.cos(shape.heading) * 0.22;
          const dy = Math.sin(shape.heading) * 0.22;
          this.lines.line(
            shape.center.x - dx, shape.center.y - dy, z,
            shape.center.x + dx, shape.center.y + dy, z,
            base[0], base[1], base[2], alpha,
          );
        }
      } else if (shape.kind === 'zone') {
        this._circle(shape.center.x, shape.center.y, z, shape.radius, base[0], base[1], base[2], alpha, 36);
        if (shape.status === 'active') {
          this._circle(shape.center.x, shape.center.y, z, shape.radius * 0.55, base[0], base[1], base[2], alpha * 0.7, 28);
        }
        // A tick showing the heading the robot must hold, where one is required.
        if (shape.heading !== undefined && shape.status !== 'done') {
          const dx = Math.cos(shape.heading) * shape.radius;
          const dy = Math.sin(shape.heading) * shape.radius;
          this.lines.line(shape.center.x, shape.center.y, z, shape.center.x + dx, shape.center.y + dy, z, base[0], base[1], base[2], alpha);
        }
      } else if (shape.kind === 'corridor') {
        // Both edges of the lane, red while the robot is outside it.
        const colour = shape.straying ? [1.0, 0.3, 0.2] : [0.55, 0.6, 0.7];
        for (const side of [1, -1]) {
          for (let i = 1; i < shape.points.length; i++) {
            const a = shape.points[i - 1];
            const b = shape.points[i];
            const dx = b.x - a.x;
            const dy = b.y - a.y;
            const len = Math.hypot(dx, dy) || 1;
            const nx = (-dy / len) * shape.halfWidth * side;
            const ny = (dx / len) * shape.halfWidth * side;
            this.lines.line(a.x + nx, a.y + ny, z, b.x + nx, b.y + ny, z, colour[0], colour[1], colour[2], 0.85);
          }
        }
      }
    }
  }

  /**
   * Issue one draw call.
   * @param {{vao:WebGLVertexArrayObject|null, count:number}} mesh
   */
  /**
   * @param {number} [alphaCut] discard fragments whose texture alpha is below
   *   this, for the perforated SCORING ELEMENTS. See `uAlphaCut`.
   */
  _draw(mesh, model, color, texture = this.textures.white, emissive = 0, alphaCut = 0) {
    const gl = this.gl;
    mat4.normalMatrix(this._normal, model);
    gl.uniformMatrix4fv(this.lit.uniforms.uModel, false, model);
    gl.uniformMatrix3fv(this.lit.uniforms.uNormalMatrix, false, this._normal);
    gl.uniform4fv(this.lit.uniforms.uColor, color);
    gl.uniform1f(this.lit.uniforms.uUseTexture, texture === this.textures.white ? 0 : 1);
    gl.uniform1f(this.lit.uniforms.uEmissive, emissive);
    gl.uniform1f(this.lit.uniforms.uAlphaCut, alphaCut);
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
      if (element.visible === false) continue;
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

  /**
   * The BIOBUZZ game: the HIVE, the FLOWERS and every SCORING ELEMENT.
   *
   * Everything here is drawn from the same state the physics reads, so what a
   * driver sees is what the scorer sees -- a ball rendered inside a CELL really
   * is in that CELL as far as the score is concerned.
   *
   * @param {import('../app/BiobuzzGame.js').BiobuzzGame} game
   */
  _drawGame(game) {
    const m = this._model;

    // --- The A-frame: a foot bar on the tiles at each end and two struts per
    // side running up and inward to the pivot. Drawn from the measured strut
    // endpoints, and drawn open, because the collider is deliberately only the
    // parts a ROBOT can reach and a solid box here would hide half the field.
    const frameMetal = [0.44, 0.46, 0.5, 1];
    const footMetal = [0.34, 0.35, 0.39, 1];
    for (const sx of [-1, 1]) {
      const footX = (sx * (FRAME_FOOT_OUTER + FRAME_FOOT_INNER)) / 2;
      mat4.composeZ(
        m,
        footX,
        0,
        FRAME_FOOT_HEIGHT / 2,
        1,
        0,
        FRAME_FOOT_OUTER - FRAME_FOOT_INNER,
        FRAME_FOOT_HALF_DEPTH * 2,
        FRAME_FOOT_HEIGHT,
      );
      this._draw(this.meshes.box, m, footMetal, this.textures.white);

      for (const sy of [-1, 1]) {
        const ax = sx * FRAME_STRUT_BASE.x;
        const ay = sy * FRAME_STRUT_BASE.y;
        const az = FRAME_STRUT_BASE.z;
        const bx = sx * FRAME_STRUT_TOP.x;
        const by = FRAME_STRUT_TOP.y;
        const bz = FRAME_STRUT_TOP.z;
        this._strutMatrix(m, ax, ay, az, bx, by, bz, 0.04);
        this._draw(this.meshes.box, m, frameMetal, this.textures.white);
      }
    }
    // Crossbar joining the two tops, carrying both pivots.
    mat4.composeZ(m, 0, 0, HIVE_PIVOT_HEIGHT, 1, 0, FRAME_STRUT_TOP.x * 2, 0.05, 0.05);
    this._draw(this.meshes.box, m, frameMetal, this.textures.white);

    // --- HIVE: two arms on a shared crossbar, each with a CELL at both ends.
    for (const alliance of ['red', 'blue']) {
      const hive = game.field.hives[alliance];
      const tint = alliance === 'red' ? [0.82, 0.24, 0.26, 1] : [0.2, 0.42, 0.85, 1];
      const tilt = hive.currentTilt;

      // Pivot hub, and an arm tube running out to each CELL. The CAD has these
      // as two separate 16.76 in tubes rather than one bar through the pivot.
      mat4.composeZ(m, hive.pivotX, 0, HIVE_PIVOT_HEIGHT, 1, 0, 0.06, 0.06, 0.06);
      this._draw(this.meshes.box, m, [0.3, 0.32, 0.36, 1], this.textures.white);
      for (const side of ['fore', 'aft']) {
        const rest = hive.cellRest(side);
        this._strutMatrix(
          m,
          hive.pivotX,
          0,
          HIVE_PIVOT_HEIGHT,
          hive.pivotX,
          rest.y,
          rest.z,
          0.028,
        );
        this._draw(this.meshes.box, m, [0.34, 0.36, 0.4, 1], this.textures.white);
      }

      for (const side of ['fore', 'aft']) {
        const opening = hive.cellOpening(side);
        const n = hive.openingNormal(side);
        const up = hive.up === side;
        // The prism runs from the opening inward along the arm, so its own
        // axes are the opening's normal and the in-plane up.
        // Pale panels inside a bright frame, the way the real CELL looks: it is
        // clear polycarbonate on an alliance-coloured rib. A solid slab in the
        // alliance colour reads as a wall rather than a basket you can aim into.
        this._cellMatrix(m, opening.x, opening.y, opening.z, n, hive.openingUp(side));
        const panel = up ? [0.82, 0.84, 0.88, 1] : [0.5, 0.52, 0.56, 1];
        this._draw(this.meshes.cell, m, panel, this.textures.plate, up ? 0.14 : 0.02);
      }
    }

    // --- FLOWERS: four pipes between the middle and top rings, plus the rings
    // and the backstop. The gap between middle and top *is* the scoring volume.
    for (const flower of game.field.flowers) {
      const c = Math.cos(flower.facing);
      const s = Math.sin(flower.facing);
      const volume = flower.scoringTop - flower.scoringBottom;
      for (const [ox, oy] of [
        [-FLOWER_PIPE_OFFSET, -FLOWER_PIPE_OFFSET],
        [FLOWER_PIPE_OFFSET, -FLOWER_PIPE_OFFSET],
        [-FLOWER_PIPE_OFFSET, FLOWER_PIPE_OFFSET],
        [FLOWER_PIPE_OFFSET, FLOWER_PIPE_OFFSET],
      ]) {
        this._uprightCylinder(
          m,
          flower.x + ox,
          flower.y + oy,
          flower.scoringBottom + volume / 2,
          FLOWER_PIPE_RADIUS,
          volume,
        );
        this._draw(this.meshes.cylinder, m, [0.55, 0.78, 0.4, 1], this.textures.white);
      }
      // The rings sit on the pipe square, so they are barely wider than it --
      // drawing them much wider turns a slim tube into a stack of plates.
      const ringRadius = FLOWER_PIPE_OFFSET + FLOWER_PIPE_RADIUS * 1.6;
      for (const [z, radius, thickness, colour] of [
        [flower.scoringBottom, ringRadius, 0.03, [0.2, 0.2, 0.22, 1]],
        [flower.scoringTop, ringRadius, 0.035, [0.92, 0.66, 0.16, 1]],
        [0.012, ringRadius * 1.15, 0.024, [0.24, 0.25, 0.28, 1]],
      ]) {
        this._uprightCylinder(m, flower.x, flower.y, z, radius, thickness);
        this._draw(this.meshes.cylinder, m, colour, this.textures.white);
      }
      // Backstop, on the wall side -- the thing that makes a long shot forgiving.
      mat4.composeZ(
        m,
        flower.x - c * (FLOWER_PIPE_OFFSET + 0.012),
        flower.y - s * (FLOWER_PIPE_OFFSET + 0.012),
        flower.backstopTop - FLOWER_BACKSTOP_HEIGHT / 2,
        c,
        s,
        0.012,
        FLOWER_PIPE_OFFSET * 2.4,
        FLOWER_BACKSTOP_HEIGHT,
      );
      this._draw(this.meshes.box, m, [0.95, 0.78, 0.22, 1], this.textures.white, 0.1);
    }

    // --- ALLIANCE AREAS, on the venue floor outside the perimeter. They carry
    // no game function, but the manual's own field figure shows them and they
    // are what tells you at a glance which end you are driving from.
    for (const zone of [game.field.zones.redAllianceArea, game.field.zones.blueAllianceArea]) {
      const colour =
        zone.alliance === 'red' ? [0.62, 0.13, 0.15, 1] : [0.12, 0.24, 0.6, 1];
      mat4.composeZ(
        m,
        zone.centerX,
        zone.centerY,
        -TILE_THICKNESS,
        1,
        0,
        zone.width,
        zone.depth,
        1,
      );
      this._draw(this.meshes.plane, m, colour, this.textures.white);
    }

    // --- SCORING ELEMENTS.
    //
    // Two shells each. The outer one carries the perforation mask and has its
    // holes discarded, which writes no depth, so the inner one shows through
    // them -- the darker inside of the far wall, which is what the holes read
    // as in Figures 9-13 and 9-14. A single solid sphere with the holes painted
    // on looked flat the moment the camera got close.
    //
    // Both are turned by the element's own orientation, which is the part that
    // matters most: a pattern of holes that does not rotate with a rolling ball
    // looks like a sticker on the floor.
    for (const ball of game.field.allBalls) {
      if (ball.container?.kind === 'preload' || ball.container?.kind === 'allianceArea') continue;
      // An element that has left the FIELD is frozen where it crossed the wall,
      // which is out in the air over the venue floor. It is in FIELD STAFF's
      // hands until they roll it back (Section 10.8.2), so it is not drawn.
      if (ball.outOfBounds) continue;
      const colour =
        ball.kind === 'pollen'
          ? [0.97, 0.79, 0.18, 1]
          : ball.alliance === 'red'
            ? [0.88, 0.22, 0.24, 1]
            : [0.22, 0.45, 0.9, 1];

      mat4.composeQuat(m, ball.x, ball.y, ball.z, ball, ball.radius);
      this._draw(this.meshes.ball, m, colour, this.textures.wiffle, 0.08, 0.5);

      // The inside, a shell thickness in and much darker. Untextured, so no
      // second set of holes lines up behind the first and lets you see the
      // FIELD straight through the ball.
      const inner = [colour[0] * 0.38, colour[1] * 0.38, colour[2] * 0.38, 1];
      mat4.composeQuat(m, ball.x, ball.y, ball.z, ball, ball.radius * BALL_SHELL);
      this._draw(this.meshes.sphere, m, inner, this.textures.white, 0);
    }
  }

  /**
   * Model matrix for a cylinder standing on its end.
   *
   * `cylinderMesh` is built with its axis along **mesh Y** because the wheels
   * want it that way, so composing it with a plain scale lays it on its side.
   * This swaps the axes so the length runs up world Z.
   */
  _uprightCylinder(out, x, y, z, radius, height) {
    out[0] = radius; out[1] = 0; out[2] = 0; out[3] = 0;
    out[4] = 0; out[5] = 0; out[6] = height; out[7] = 0;
    out[8] = 0; out[9] = radius; out[10] = 0; out[11] = 0;
    out[12] = x; out[13] = y; out[14] = z; out[15] = 1;
    return out;
  }

  /**
   * Model matrix for a CELL: the unit `cellMesh` scaled to the real opening and
   * planted on the opening plane, with its prism axis running inward along the
   * arm.
   *
   * @param {{y:number,z:number}} normal outward unit normal of the opening
   * @param {{y:number,z:number}} up in-plane up, toward the pentagon's apex
   */
  _cellMatrix(out, x, y, z, normal, up) {
    const halfWidth = CELL_OPENING_WIDTH / 2;
    const upY = up.y;
    const upZ = up.z;

    // Mesh x -> field x (across the field, the opening's width).
    out[0] = halfWidth; out[1] = 0; out[2] = 0; out[3] = 0;
    // Mesh y -> inward along the arm, over the CELL's depth.
    out[4] = 0; out[5] = -normal.y * CELL_DEPTH; out[6] = -normal.z * CELL_DEPTH; out[7] = 0;
    // Mesh z -> up the opening's own face.
    out[8] = 0; out[9] = upY * CELL_OPENING_HEIGHT; out[10] = upZ * CELL_OPENING_HEIGHT; out[11] = 0;
    // Mesh origin sits at the middle of the opening's lower edge.
    out[12] = x;
    out[13] = y - upY * (CELL_OPENING_HEIGHT / 2);
    out[14] = z - upZ * (CELL_OPENING_HEIGHT / 2);
    out[15] = 1;
    return out;
  }

  /**
   * Model matrix for a square strut spanning two arbitrary points in space.
   *
   * Builds an orthonormal frame around the strut's own axis, picking whichever
   * world axis is least parallel to it as the seed so the cross products never
   * collapse.
   */
  _strutMatrix(out, ax, ay, az, bx, by, bz, thickness) {
    let dx = bx - ax;
    let dy = by - ay;
    let dz = bz - az;
    const length = Math.hypot(dx, dy, dz) || 1;
    dx /= length;
    dy /= length;
    dz /= length;

    const seed =
      Math.abs(dz) < 0.9 ? [0, 0, 1] : [1, 0, 0];
    let ux = seed[1] * dz - seed[2] * dy;
    let uy = seed[2] * dx - seed[0] * dz;
    let uz = seed[0] * dy - seed[1] * dx;
    const un = Math.hypot(ux, uy, uz) || 1;
    ux /= un;
    uy /= un;
    uz /= un;
    const vx = dy * uz - dz * uy;
    const vy = dz * ux - dx * uz;
    const vz = dx * uy - dy * ux;

    out[0] = ux * thickness; out[1] = uy * thickness; out[2] = uz * thickness; out[3] = 0;
    out[4] = dx * length; out[5] = dy * length; out[6] = dz * length; out[7] = 0;
    out[8] = vx * thickness; out[9] = vy * thickness; out[10] = vz * thickness; out[11] = 0;
    out[12] = (ax + bx) / 2; out[13] = (ay + by) / 2; out[14] = (az + bz) / 2; out[15] = 1;
    return out;
  }

  /**
   * Taped zones and the shooting hint, as lines on the floor.
   * @param {import('../app/BiobuzzGame.js').BiobuzzGame} game
   * @param {import('../config/schema.js').SimConfig['view']} view
   */
  _buildGameLines(game, view) {
    for (const zone of game.field.zones.all) {
      const colour = zone.alliance === 'red' ? [0.92, 0.28, 0.3] : [0.28, 0.5, 0.95];
      const [r, g, b] = colour;
      const z = 0.004;
      const corners = [
        [zone.minX, zone.minY],
        [zone.maxX, zone.minY],
        [zone.maxX, zone.maxY],
        [zone.minX, zone.maxY],
      ];
      for (let i = 0; i < 4; i++) {
        const [ax, ay] = corners[i];
        const [bx, by] = corners[(i + 1) % 4];
        this.lines.line(ax, ay, z, bx, by, z, r, g, b, 1);
      }
    }

    // Rib outlines on every CELL, so the pentagon reads as an open basket and
    // you can see which way its mouth faces from any angle.
    for (const alliance of ['red', 'blue']) {
      const hive = game.field.hives[alliance];
      const [r, g, b] = alliance === 'red' ? [0.95, 0.3, 0.32] : [0.35, 0.58, 1];
      for (const side of ['fore', 'aft']) {
        const o = hive.cellOpening(side);
        const n = hive.openingNormal(side);
        const u = hive.openingUp(side);
        const shoulder = CELL_SHOULDER_HEIGHT;
        const apex = CELL_OPENING_HEIGHT;
        const hw = CELL_OPENING_WIDTH / 2;
        // Pentagon corners, in the opening's own plane.
        const rib = [
          [-hw, 0],
          [hw, 0],
          [hw, shoulder],
          [0, apex],
          [-hw, shoulder],
        ];
        // Both rib planes: the opening itself and the back of the CELL. The
        // normal points *out* of the CELL, so stepping back into it subtracts.
        for (const depth of [0, CELL_DEPTH]) {
          const at = (across, along) => ({
            x: o.x + across,
            y: o.y + u.y * (along - apex / 2) - n.y * depth,
            z: o.z + u.z * (along - apex / 2) - n.z * depth,
          });
          for (let i = 0; i < rib.length; i++) {
            const a = at(rib[i][0], rib[i][1]);
            const c = at(rib[(i + 1) % rib.length][0], rib[(i + 1) % rib.length][1]);
            this.lines.line(a.x, a.y, a.z, c.x, c.y, c.z, r, g, b, 1);
          }
        }
      }
    }

    if (view?.showTrajectory) this._buildTrajectory(game, view.trajectoryMode);

    // A ring under the HIVE the player is shooting at, so the target is
    // findable from any camera angle.
    const target = game.field.hiveTarget(game.alliance);
    const ready = game.launcher.ready;
    this._circle(
      target.x,
      target.y,
      0.006,
      0.35,
      ready ? 0.3 : 0.95,
      ready ? 0.9 : 0.75,
      ready ? 0.4 : 0.2,
      0.9,
      32,
    );
  }

  /**
   * The aiming guide: the arc a shot would fly, and where it would arrive.
   *
   * Drawn from `game.shotPreview`, which runs the launcher's own closed-form
   * trajectory and then asks the HIVE the same aperture question the capture
   * test asks -- so the colour is a real prediction, not a hint. Green means
   * this shot scores; amber means it does not, and the arc shows you why.
   *
   * @param {import('../app/BiobuzzGame.js').BiobuzzGame} game
   * @param {'live'|'solution'|'both'} [mode]
   */
  _buildTrajectory(game, mode = 'live') {
    for (const arc of game.shotPreview(mode)) {
      const points = arc.points;
      if (points.length < 2) continue;
      const live = arc.kind === 'live';
      const [r, g, b] = live
        ? arc.hit
          ? [0.28, 0.92, 0.5]
          : [0.98, 0.62, 0.2]
        : [0.34, 0.7, 1];

      for (let i = 1; i < points.length; i++) {
        // The solved arc is dashed, so when both are on you can tell which is
        // the shot you would get and which is the shot you want.
        if (!live && i % 2 === 0) continue;
        const a = points[i - 1];
        const c = points[i];
        this.lines.line(a.x, a.y, a.z, c.x, c.y, c.z, r, g, b, live ? 0.95 : 0.55);
      }

      if (live) {
        // Ground track. Height in a perspective view reads as distance, so
        // without a shadow on the tiles an arc that falls short looks the same
        // as one that goes long.
        for (let i = 1; i < points.length; i += 2) {
          const a = points[i - 1];
          const c = points[i];
          this.lines.line(a.x, a.y, 0.004, c.x, c.y, 0.004, r, g, b, 0.28);
        }
      }

      if (arc.entry) {
        this._crossMarker(arc.entry.x, arc.entry.y, arc.entry.z, 0.09, r, g, b, 1);
      } else if (live) {
        // Where it lands instead, which is the useful number when it misses.
        const last = points[points.length - 1];
        this._circle(last.x, last.y, 0.005, 0.1, r, g, b, 0.8, 18);
      }
    }
  }

  /** A small three-axis cross in space, for marking a point. */
  _crossMarker(x, y, z, size, r, g, b, a) {
    this.lines.line(x - size, y, z, x + size, y, z, r, g, b, a);
    this.lines.line(x, y - size, z, x, y + size, z, r, g, b, a);
    this.lines.line(x, y, z - size, x, y, z + size, r, g, b, a);
    return this;
  }

  _drawRobot(sim) {
    this._drawRobotBody(sim.robot, sim.config, ACCENT, true);
    for (const opponent of sim.opponents) {
      this._drawRobotBody(opponent.robot, opponent.config, opponent.color, false);
    }
  }

  /**
   * Draw one robot. Shared between the player and every AI opponent, so an
   * opponent is visibly the same kind of machine -- the plates, the wheels and
   * the motors all read at a glance, which is how you judge whether the thing
   * blocking you is a light scout you can shove or a heavy pusher you cannot.
   *
   * @param {import('../robot/Robot.js').Robot} robot
   * @param {import('../config/schema.js').SimConfig} config that robot's own build
   * @param {number[]} accent
   * @param {boolean} isPlayer
   */
  _drawRobotBody(robot, config, accent, isPlayer) {
    const gl = this.gl;
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

    // Opponents are tinted toward their own colour so they are instantly
    // distinguishable from the player's robot at driver-station distance.
    const plateColor = isPlayer
      ? [0.80, 0.83, 0.88, 1]
      : [0.30 + accent[0] * 0.55, 0.32 + accent[1] * 0.55, 0.35 + accent[2] * 0.55, 1];
    const darkMetal = [0.40, 0.43, 0.48, 1];

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

    // A ring under each opponent in its own colour, so it stays findable when
    // the robots overlap or the view is crowded.
    for (const opponent of sim.opponents) {
      const p = opponent.robot.body.position;
      const c = opponent.color;
      const radius = Math.max(opponent.halfLength, opponent.halfWidth) * 1.15;
      this._circle(p.x, p.y, 0.006, radius, c[0], c[1], c[2], 0.75, 28);
    }
  }

  /** Draw a horizontal circle into the line batch. */
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
