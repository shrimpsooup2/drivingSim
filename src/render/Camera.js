import * as mat4 from './mat4.js';
import { clamp, DEG, lerp } from '../math/MathUtil.js';

/**
 * Camera rig.
 *
 * Every mode is fully adjustable, and the adjustments live in the config rather
 * than in the rig, so they persist, appear in the settings panel, and travel
 * with an exported config.
 *
 * **Driver station** is the important mode. In a real match you stand behind
 * the wall at one end of the field, low down and off to one side, and judging
 * distance to the far end is genuinely hard. It is adjustable precisely so a
 * team can match where they actually stand: eye height, how far back the wall
 * puts you, and which side of the field you are on all change what the driver
 * can see. An overhead view makes the field trivially readable and teaches
 * habits that fall apart at competition, which is why this is the default.
 *
 * Mouse control is live in every mode. The rig never writes to the config
 * itself; it hands changes to a setter supplied by the app, so clamping,
 * persistence and the settings panel all stay in step.
 */
export class CameraRig {
  constructor() {
    this.mode = 'driverStation';
    this.projection = mat4.create();
    this.view = mat4.create();
    /** projection * view, for projecting world points onto the screen. */
    this.viewProjection = mat4.create();

    this.eye = [0, 0, 1];
    this.target = [0, 0, 0];
    this.up = [0, 0, 1];

    // Smoothed follow state for the chase camera.
    this._followX = 0;
    this._followY = 0;
    this._followHeading = 0;
    this._initialised = false;

    /** Point the orbit camera revolves around, in field coordinates. */
    this.orbitTarget = [0, 0, 0.1];

    this.near = 0.05;
    this.far = 80;
    /** Set when a control changes the camera, so the HUD can flash a readout. */
    this.lastAdjustment = 0;
  }

  /**
   * @param {number} aspect
   * @param {{
   *   view: any,
   *   robotX: number, robotY: number, robotHeading: number,
   *   fieldSize: number, dt: number, time: number,
   * }} s
   */
  update(aspect, s) {
    const v = s.view;
    this.mode = v.camera;
    mat4.perspective(this.projection, v.fov * DEG, Math.max(aspect, 0.05), this.near, this.far);

    if (!this._initialised) {
      this._followX = s.robotX;
      this._followY = s.robotY;
      this._followHeading = s.robotHeading;
      this._initialised = true;
    }

    const half = s.fieldSize / 2;

    switch (v.camera) {
      case 'overhead': {
        // Zoom 1 frames the whole field; higher values move in.
        const height = (s.fieldSize * 1.05) / clamp(v.overheadZoom, 0.3, 4);
        const cx = v.overheadFollow ? s.robotX : 0;
        const cy = v.overheadFollow ? s.robotY : 0;
        this.eye = [cx, cy, height];
        this.target = [cx, cy, 0];
        // Looking straight down, "up" cannot be the z axis. Pointing it toward
        // the far wall keeps the view aligned with the driver's mental map.
        this.up = [1, 0, 0];
        break;
      }

      case 'chase': {
        // Smooth the follow so the camera does not snap when the robot spins.
        const k = 1 - Math.exp(-clamp(v.chaseSmoothing, 0.5, 30) * s.dt);
        this._followX = lerp(this._followX, s.robotX, k);
        this._followY = lerp(this._followY, s.robotY, k);
        this._followHeading = smoothAngle(this._followHeading, s.robotHeading, k * 0.7);
        const yaw = this._followHeading + v.chaseYaw * DEG;
        this.eye = [
          this._followX - Math.cos(yaw) * v.chaseDistance,
          this._followY - Math.sin(yaw) * v.chaseDistance,
          v.chaseHeight,
        ];
        this.target = [s.robotX, s.robotY, v.chaseAimHeight];
        this.up = [0, 0, 1];
        break;
      }

      case 'orbit': {
        if (v.orbitFollow) {
          const k = 1 - Math.exp(-6 * s.dt);
          this.orbitTarget[0] = lerp(this.orbitTarget[0], s.robotX, k);
          this.orbitTarget[1] = lerp(this.orbitTarget[1], s.robotY, k);
          this.orbitTarget[2] = lerp(this.orbitTarget[2], 0.1, k);
        }
        const pitch = clamp(v.orbitPitch * DEG, 0.03, Math.PI / 2 - 0.02);
        const yaw = v.orbitYaw * DEG;
        const cp = Math.cos(pitch);
        this.eye = [
          this.orbitTarget[0] + Math.cos(yaw) * cp * v.orbitDistance,
          this.orbitTarget[1] + Math.sin(yaw) * cp * v.orbitDistance,
          this.orbitTarget[2] + Math.sin(pitch) * v.orbitDistance,
        ];
        this.target = [...this.orbitTarget];
        this.up = [0, 0, 1];
        break;
      }

      case 'driverStation':
      default: {
        // Standing behind the wall at the -x end. The offset moves you along
        // the wall: real driver stations put you off to one side, which is why
        // the far corner on your own side is the hardest place to judge.
        this.eye = [-half - v.driverSetback, v.driverOffset, v.driverHeight];
        this.target = [
          -half + v.driverAimDistance,
          v.driverOffset * (1 - clamp(v.driverAimCentring, 0, 1)),
          v.driverAimHeight,
        ];
        this.up = [0, 0, 1];
        break;
      }
    }

    mat4.lookAt(this.view, this.eye, this.target, this.up);
    mat4.multiply(this.viewProjection, this.projection, this.view);
    return this;
  }

  /**
   * Project a world point to normalised screen coordinates.
   * @param {number} x
   * @param {number} y
   * @param {number} z
   * @returns {{x:number, y:number, depth:number, visible:boolean}}
   *   x and y are 0..1 across the viewport, y measured downward.
   */
  project(x, y, z) {
    const m = this.viewProjection;
    const cx = m[0] * x + m[4] * y + m[8] * z + m[12];
    const cy = m[1] * x + m[5] * y + m[9] * z + m[13];
    const cw = m[3] * x + m[7] * y + m[11] * z + m[15];
    if (cw <= 1e-6) return { x: 0, y: 0, depth: cw, visible: false };
    const ndcX = cx / cw;
    const ndcY = cy / cw;
    return {
      x: (ndcX + 1) / 2,
      y: (1 - ndcY) / 2,
      depth: cw,
      // A small margin keeps labels from popping at the exact screen edge.
      visible: ndcX > -1.15 && ndcX < 1.15 && ndcY > -1.15 && ndcY < 1.15,
    };
  }

  // ------------------------------------------------------------------
  // Controls. Each takes the live view config and a `set(path, value)`
  // function, so every adjustment goes through the config store and shows up
  // in the settings panel rather than silently diverging from it.
  // ------------------------------------------------------------------

  /**
   * Primary drag: look around.
   * @param {any} v config.view
   * @param {(path:string, value:number)=>void} set
   */
  drag(v, set, dx, dy) {
    this.lastAdjustment = Date.now();
    switch (v.camera) {
      case 'orbit':
        set('view.orbitYaw', wrapDegrees(v.orbitYaw - dx * 0.35));
        set('view.orbitPitch', clamp(v.orbitPitch + dy * 0.35, 2, 88));
        break;
      case 'chase':
        set('view.chaseYaw', wrapDegrees(v.chaseYaw - dx * 0.4));
        set('view.chaseHeight', clamp(v.chaseHeight + dy * 0.004, 0.15, 4));
        break;
      case 'overhead':
        // Nothing sensible to rotate looking straight down; treat it as pan.
        this.pan(v, set, dx, dy);
        break;
      case 'driverStation':
      default:
        // Move along the wall and change eye height: literally shifting where
        // the driver is standing.
        set('view.driverOffset', clamp(v.driverOffset - dx * 0.006, -2.2, 2.2));
        set('view.driverHeight', clamp(v.driverHeight + dy * 0.004, 0.4, 3.5));
        break;
    }
  }

  /**
   * Secondary drag: pan.
   */
  pan(v, set, dx, dy) {
    this.lastAdjustment = Date.now();
    if (v.camera === 'orbit') {
      const yaw = v.orbitYaw * DEG;
      const scale = v.orbitDistance * 0.0016;
      this.orbitTarget[0] += (Math.sin(yaw) * dx + Math.cos(yaw) * dy) * scale;
      this.orbitTarget[1] += (-Math.cos(yaw) * dx + Math.sin(yaw) * dy) * scale;
      // Panning by hand means you no longer want it glued to the robot.
      if (v.orbitFollow) set('view.orbitFollow', false);
    } else if (v.camera === 'driverStation') {
      set('view.driverAimDistance', clamp(v.driverAimDistance - dy * 0.01, 0.2, 8));
      set('view.driverOffset', clamp(v.driverOffset - dx * 0.006, -2.2, 2.2));
    }
  }

  /**
   * Wheel: zoom.
   *
   * What "zoom" means depends on the view. From the driver station you cannot
   * walk onto the field, so zooming narrows the field of view -- the same thing
   * as leaning in and squinting. Everywhere else it moves the camera.
   */
  zoom(v, set, delta) {
    this.lastAdjustment = Date.now();
    const factor = Math.exp(delta * 0.0011);
    switch (v.camera) {
      case 'orbit':
        set('view.orbitDistance', clamp(v.orbitDistance * factor, 0.6, 30));
        break;
      case 'chase':
        set('view.chaseDistance', clamp(v.chaseDistance * factor, 0.5, 8));
        break;
      case 'overhead':
        set('view.overheadZoom', clamp(v.overheadZoom / factor, 0.3, 4));
        break;
      case 'driverStation':
      default:
        set('view.fov', clamp(v.fov * factor, 18, 95));
        break;
    }
  }

  /** Restore the current mode's framing to its defaults. */
  resetMode(v, set, defaults) {
    this.lastAdjustment = Date.now();
    const groups = {
      driverStation: ['fov', 'driverHeight', 'driverSetback', 'driverOffset', 'driverAimDistance', 'driverAimHeight'],
      chase: ['chaseDistance', 'chaseHeight', 'chaseYaw', 'chaseAimHeight'],
      overhead: ['overheadZoom'],
      orbit: ['orbitDistance', 'orbitPitch', 'orbitYaw'],
    };
    for (const key of groups[v.camera] ?? []) set(`view.${key}`, defaults[key]);
    if (v.camera === 'orbit') this.orbitTarget = [0, 0, 0.1];
  }

  /** A short human-readable summary of the current framing, for the HUD. */
  describe(v) {
    switch (v.camera) {
      case 'orbit':
        return `orbit  ${v.orbitDistance.toFixed(1)} m  ${Math.round(v.orbitPitch)}° up`;
      case 'chase':
        return `chase  ${v.chaseDistance.toFixed(1)} m back  ${v.chaseHeight.toFixed(2)} m up`;
      case 'overhead':
        return `overhead  ${v.overheadZoom.toFixed(2)}x`;
      case 'driverStation':
      default:
        return `driver  ${v.driverHeight.toFixed(2)} m eye  ${Math.round(v.fov)}° fov`;
    }
  }
}

function smoothAngle(from, to, t) {
  let delta = to - from;
  while (delta > Math.PI) delta -= Math.PI * 2;
  while (delta < -Math.PI) delta += Math.PI * 2;
  return from + delta * t;
}

function wrapDegrees(deg) {
  let d = deg % 360;
  if (d > 180) d -= 360;
  if (d < -180) d += 360;
  return d;
}
