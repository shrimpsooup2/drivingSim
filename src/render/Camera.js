import * as mat4 from './mat4.js';
import { clamp, lerp } from '../math/MathUtil.js';

/**
 * Camera rig with the views a driver actually needs.
 *
 * **Driver station** is the important one. In a real match you stand behind the
 * wall at one end of the field, low down, and judging distance to the far side
 * is genuinely hard. An overhead view makes the field trivially readable and
 * teaches habits that fall apart at competition, so this is the default.
 */
export class CameraRig {
  constructor() {
    this.mode = 'driverStation';
    this.projection = mat4.create();
    this.view = mat4.create();

    this.eye = [0, 0, 1];
    this.target = [0, 0, 0];
    this.up = [0, 0, 1];

    // Smoothed follow state for the chase camera.
    this._followX = 0;
    this._followY = 0;
    this._followHeading = 0;
    this._initialised = false;

    // Free-orbit controls.
    this.orbitYaw = -Math.PI / 2;
    this.orbitPitch = 0.85;
    this.orbitDistance = 5.5;
    this.orbitTarget = [0, 0, 0];

    this.fov = (55 * Math.PI) / 180;
    this.near = 0.05;
    this.far = 60;
  }

  /**
   * @param {number} aspect
   * @param {{mode:string, robotX:number, robotY:number, robotHeading:number, fieldSize:number, dt:number}} s
   */
  update(aspect, s) {
    this.mode = s.mode;
    mat4.perspective(this.projection, this.fov, Math.max(aspect, 0.05), this.near, this.far);

    if (!this._initialised) {
      this._followX = s.robotX;
      this._followY = s.robotY;
      this._followHeading = s.robotHeading;
      this._initialised = true;
    }

    const half = s.fieldSize / 2;
    switch (s.mode) {
      case 'overhead': {
        this.eye = [0, 0, s.fieldSize * 1.02];
        this.target = [0, 0, 0];
        // Looking straight down, "up" cannot be the z axis. Point it toward the
        // far wall so the view matches the driver's mental map of the field.
        this.up = [1, 0, 0];
        break;
      }
      case 'chase': {
        // Smooth the follow so the camera does not snap when the robot spins.
        const k = 1 - Math.exp(-8 * s.dt);
        this._followX = lerp(this._followX, s.robotX, k);
        this._followY = lerp(this._followY, s.robotY, k);
        this._followHeading = smoothAngle(this._followHeading, s.robotHeading, 1 - Math.exp(-5 * s.dt));
        const back = 1.5;
        const height = 0.95;
        this.eye = [
          this._followX - Math.cos(this._followHeading) * back,
          this._followY - Math.sin(this._followHeading) * back,
          height,
        ];
        this.target = [s.robotX, s.robotY, 0.15];
        this.up = [0, 0, 1];
        break;
      }
      case 'orbit': {
        const cp = Math.cos(this.orbitPitch);
        this.eye = [
          this.orbitTarget[0] + Math.cos(this.orbitYaw) * cp * this.orbitDistance,
          this.orbitTarget[1] + Math.sin(this.orbitYaw) * cp * this.orbitDistance,
          this.orbitTarget[2] + Math.sin(this.orbitPitch) * this.orbitDistance,
        ];
        this.target = [...this.orbitTarget];
        this.up = [0, 0, 1];
        break;
      }
      case 'driverStation':
      default: {
        // Standing behind the wall at the -x end, eye height about 1.5 m.
        this.eye = [-half - 1.1, 0, 1.55];
        this.target = [half * 0.28, 0, 0.12];
        this.up = [0, 0, 1];
        break;
      }
    }

    mat4.lookAt(this.view, this.eye, this.target, this.up);
    return this;
  }

  /** Mouse drag in orbit mode. */
  orbitDrag(dx, dy) {
    this.orbitYaw -= dx * 0.006;
    this.orbitPitch = clamp(this.orbitPitch + dy * 0.006, 0.08, 1.5);
  }

  /** Mouse wheel in orbit mode. */
  orbitZoom(delta) {
    this.orbitDistance = clamp(this.orbitDistance * Math.exp(delta * 0.0012), 1.0, 25);
  }

  /** Pan the orbit target, for inspecting a corner of the field. */
  orbitPan(dx, dy) {
    const cosYaw = Math.cos(this.orbitYaw);
    const sinYaw = Math.sin(this.orbitYaw);
    const scale = this.orbitDistance * 0.0016;
    this.orbitTarget[0] += (sinYaw * dx + cosYaw * dy) * scale;
    this.orbitTarget[1] += (-cosYaw * dx + sinYaw * dy) * scale;
  }
}

function smoothAngle(from, to, t) {
  let delta = to - from;
  while (delta > Math.PI) delta -= Math.PI * 2;
  while (delta < -Math.PI) delta += Math.PI * 2;
  return from + delta * t;
}
