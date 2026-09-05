import { FtcGamepad } from './FtcGamepad.js';

/**
 * Keyboard fallback, presented as a gamepad so everything downstream is
 * identical whether you are on sticks or keys.
 *
 * A key is on or off, so keyboard input is inherently a square wave. The
 * driver-side acceleration ramp smooths that out, which is also why practising
 * on the keyboard is useful for learning the field but not for learning throttle
 * control -- there is no substitute for a real controller there.
 */
export class KeyboardSource {
  /** @param {EventTarget} [target] */
  constructor(target = globalThis) {
    this.state = new FtcGamepad();
    this.state.source = 'keyboard';
    /** @type {Set<string>} */
    this.keys = new Set();
    this.active = false;
    this._target = target;
    this._onKeyDown = this._onKeyDown.bind(this);
    this._onKeyUp = this._onKeyUp.bind(this);
    this._onBlur = this._onBlur.bind(this);

    /** Extra handlers for non-driving keys, keyed by `event.code`. */
    this.actions = /** @type {Map<string, () => void>} */ (new Map());
  }

  attach() {
    this._target.addEventListener('keydown', this._onKeyDown);
    this._target.addEventListener('keyup', this._onKeyUp);
    this._target.addEventListener('blur', this._onBlur);
    return this;
  }

  detach() {
    this._target.removeEventListener('keydown', this._onKeyDown);
    this._target.removeEventListener('keyup', this._onKeyUp);
    this._target.removeEventListener('blur', this._onBlur);
    return this;
  }

  /** Register a one-shot action, e.g. `on('KeyR', () => sim.reset())`. */
  on(code, handler) {
    this.actions.set(code, handler);
    return this;
  }

  _isTypingTarget(event) {
    const el = /** @type {HTMLElement|null} */ (event.target);
    if (!el) return false;
    const tag = el.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
  }

  _onKeyDown(event) {
    if (this._isTypingTarget(event)) return;
    if (DRIVE_KEYS.has(event.code)) event.preventDefault();
    if (!event.repeat && this.actions.has(event.code)) {
      event.preventDefault();
      this.actions.get(event.code)?.();
    }
    this.keys.add(event.code);
    this.active = true;
  }

  _onKeyUp(event) {
    this.keys.delete(event.code);
  }

  _onBlur() {
    // Losing focus with a key held would otherwise leave the robot driving.
    this.keys.clear();
  }

  has(code) {
    return this.keys.has(code);
  }

  /** @returns {FtcGamepad} */
  poll() {
    const s = this.state;
    const k = this.keys;
    const axis = (neg, pos) => (k.has(neg) ? -1 : 0) + (k.has(pos) ? 1 : 0);

    // Forward is negative on left_stick_y, matching the FTC convention.
    const forward = axis('KeyS', 'KeyW') + axis('ArrowDown', 'ArrowUp');
    const strafe = axis('KeyA', 'KeyD');
    const turn = axis('KeyE', 'KeyQ') + axis('ArrowRight', 'ArrowLeft');

    s.left_stick_y = clampUnit(-forward);
    s.left_stick_x = clampUnit(strafe);
    s.right_stick_x = clampUnit(-turn);
    s.right_stick_y = 0;

    s.left_trigger = k.has('ShiftLeft') || k.has('ShiftRight') ? 1 : 0;
    s.right_trigger = k.has('Space') ? 1 : 0;

    s.a = k.has('KeyZ');
    s.b = k.has('KeyC');
    s.x = k.has('KeyV');
    s.y = k.has('KeyF');
    s.left_bumper = k.has('KeyG');
    s.right_bumper = k.has('KeyH');
    s.dpad_up = k.has('KeyI');
    s.dpad_down = k.has('KeyK');
    s.dpad_left = k.has('KeyJ');
    s.dpad_right = k.has('KeyL');
    s.back = k.has('Backspace');
    s.start = k.has('Enter');

    s.connected = this.keys.size > 0 || this.active;
    return s;
  }
}

const DRIVE_KEYS = new Set([
  'KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyQ', 'KeyE',
  'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
  'Space',
]);

function clampUnit(v) {
  return v < -1 ? -1 : v > 1 ? 1 : v;
}

/** Human-readable control list, shown in the help overlay. */
export const KEYBOARD_HELP = [
  ['W / S', 'Drive forward / back'],
  ['A / D', 'Strafe left / right'],
  ['Q / E', 'Rotate left / right'],
  ['Arrow keys', 'Drive and rotate (alternative)'],
  ['Shift', 'Precision mode'],
  ['Space', 'Boost / full power'],
  ['R', 'Reset robot to start'],
  ['F', 'Toggle field centric'],
  ['H', 'Reset IMU heading'],
  ['C', 'Cycle camera'],
  ['Tab', 'Show / hide settings'],
];
