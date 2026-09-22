import { FtcGamepad } from './FtcGamepad.js';

/**
 * Keyboard fallback, presented as a gamepad so everything downstream is
 * identical whether you are on sticks or keys.
 *
 * A key is on or off, so keyboard input is inherently a square wave. The
 * driver-side acceleration ramp smooths that out, which is also why practising
 * on the keyboard is useful for learning the field but not for learning throttle
 * control -- there is no substitute for a real controller there.
 *
 * ## One key, one job
 *
 * The mapping below is the single source of truth, and the app's own shortcuts
 * are checked against it by `assertNoKeyboardCollisions`. That check exists
 * because the first version of this file did not have it, and the result was
 * that four game controls were unusable from the keyboard:
 *
 *   - `G` was both LEFT BUMPER (eject) and the app's "put the game away", so
 *     trying to spit an element out switched BIOBUZZ off;
 *   - `F` was both Y (flywheel) and the app's field-centric toggle, and the
 *     op-mode *also* toggled field centric on Y, so pressing it toggled twice
 *     and appeared to do nothing;
 *   - `H` was both RIGHT BUMPER (intake) and "reset the IMU heading", so every
 *     intake press quietly re-zeroed the gyro;
 *   - `Space` was both RIGHT TRIGGER (fire) and the drive burst.
 *
 * A collision does not fail loudly. It does something else as well, which is
 * worse, so the table is data and the collisions are a test.
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
    if (PAD_KEY_CODES.has(code)) {
      // Loud, because the failure mode when this slips through is a control
      // that silently does two things at once.
      throw new Error(
        `keyboard collision: ${code} already emulates the gamepad's ${PAD_KEY_CODES.get(code)}`,
      );
    }
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
    if (HELD_KEYS.has(event.code)) event.preventDefault();
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

    for (const [button, code] of Object.entries(BUTTON_KEYS)) s[button] = k.has(code);

    s.connected = this.keys.size > 0 || this.active;
    return s;
  }
}

/**
 * Which key stands in for which gamepad button.
 *
 * The right hand gets the whole right side of a controller: `I K J L` is the
 * d-pad, `H` is the right bumper (home row, index finger -- it is the key you
 * hold longest, running the intake), `U` is the left bumper above it, and `Y`
 * is the Y button. The left hand stays on `WASD` and reaches `Z X V` for the
 * driver aids and `Shift` / `Space` for the two triggers.
 *
 * `O` is deliberately not a *pad* key. It was the right bumper for one commit,
 * and in the panel's monospace font "O hold to intake" reads as a zero. It is
 * an app shortcut (the multiplayer panel), where it appears in a labelled table
 * rather than inline in a sentence, and the ambiguity does not arise.
 */
export const BUTTON_KEYS = {
  a: 'KeyZ',
  b: 'KeyV',
  x: 'KeyX',
  y: 'KeyY',
  left_bumper: 'KeyU',
  right_bumper: 'KeyH',
  dpad_up: 'KeyI',
  dpad_down: 'KeyK',
  dpad_left: 'KeyJ',
  dpad_right: 'KeyL',
  back: 'Backspace',
  start: 'Enter',
};

/** Axis and trigger keys, for the collision check and the help text. */
export const AXIS_KEYS = {
  left_stick_y: ['KeyW', 'KeyS', 'ArrowUp', 'ArrowDown'],
  left_stick_x: ['KeyA', 'KeyD'],
  right_stick_x: ['KeyQ', 'KeyE', 'ArrowLeft', 'ArrowRight'],
  left_trigger: ['ShiftLeft', 'ShiftRight'],
  right_trigger: ['Space'],
};

/**
 * The app's own shortcuts, as key codes.
 *
 * Here rather than in `App.js` because this module owns the question "which
 * key means what", and because the list needs to be readable by something
 * other than a running app: the help overlay is checked against it, and so is
 * the collision test. It used to be declared twice -- once in `App` as a set
 * of `on()` calls and once in the test as a literal -- and adding a shortcut
 * to one and not the other is exactly the mistake that got made.
 *
 * `App` asserts that what it actually registered matches this, so the list
 * cannot drift from the bindings either.
 */
export const APP_SHORTCUTS = [
  'KeyR',
  'KeyN',
  'KeyF',
  'KeyO',
  'KeyG',
  'KeyM',
  'KeyB',
  'KeyC',
  'KeyT',
  'KeyP',
  'Period',
  'Comma',
  'Tab',
  'Slash',
  'Escape',
];

/** Every key the pad emulation claims, mapped to what it stands for. */
export const PAD_KEY_CODES = new Map();
for (const [button, code] of Object.entries(BUTTON_KEYS)) PAD_KEY_CODES.set(code, button);
for (const [axis, codes] of Object.entries(AXIS_KEYS)) {
  for (const code of codes) PAD_KEY_CODES.set(code, axis);
}

/**
 * Keys held rather than tapped, so the browser's own default (scrolling on
 * Space or the arrows) has to be suppressed.
 */
const HELD_KEYS = new Set([
  ...Object.values(AXIS_KEYS).flat(),
  ...Object.values(BUTTON_KEYS),
]);

/**
 * Throw if any of `codes` is already a pad-emulation key.
 *
 * Called by the app with its own shortcut list, and by the tests, so a new
 * shortcut cannot quietly land on top of a control.
 * @param {Iterable<string>} codes
 */
export function assertNoKeyboardCollisions(codes) {
  const clashes = [];
  for (const code of codes) {
    if (PAD_KEY_CODES.has(code)) clashes.push(`${code} (${PAD_KEY_CODES.get(code)})`);
  }
  if (clashes.length) {
    throw new Error(`app shortcuts collide with gamepad keys: ${clashes.join(', ')}`);
  }
  return true;
}

function clampUnit(v) {
  return v < -1 ? -1 : v > 1 ? 1 : v;
}

/** How to write a key code in the UI. */
export function keyLabel(code) {
  if (code === 'Space') return 'Space';
  if (code === 'ShiftLeft' || code === 'ShiftRight') return 'Shift';
  if (code === 'Period') return '.';
  if (code === 'Comma') return ',';
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  if (code.startsWith('Arrow')) return `${code.slice(5)} arrow`;
  return code;
}

/**
 * The key that stands in for a gamepad control, written for the UI.
 *
 * The on-screen prompts use this so that a driver on the keyboard is told to
 * press `O`, not "RIGHT BUMPER" -- naming a button they do not have is how
 * "it never says how to shoot" happens twice.
 * @param {string} control a gamepad field name, e.g. 'right_bumper'
 */
export function keyFor(control) {
  if (BUTTON_KEYS[control]) return keyLabel(BUTTON_KEYS[control]);
  const axis = AXIS_KEYS[control];
  return axis ? keyLabel(axis[0]) : null;
}

/** Human-readable control list, shown in the help overlay. */
export const KEYBOARD_HELP = [
  ['W / S', 'Drive forward / back'],
  ['A / D', 'Strafe left / right'],
  ['Q / E', 'Rotate left / right'],
  ['Arrow keys', 'Drive and rotate (alternative)'],
  ['Shift', 'Precision mode'],
  ['H', 'Run the intake (hold)'],
  ['U', 'Eject the front element'],
  ['Y', 'Spin the flywheel up / down'],
  ['Space', 'FIRE'],
  ['I / K', 'Trim the hood angle'],
  ['J / L', 'Trim the target RPM'],
  ['V', 'Burst: bypass the acceleration ramp (hold)'],
  ['X', 'Toggle field centric'],
  ['Z', 'Reset the IMU heading'],
  ['Backspace', 'Reset the robot to its start'],
  ['R', 'Restart drill, or reset the robot'],
  ['N', 'Driving drills'],
  ['F', 'Autonomous editor'],
  ['O', 'Multiplayer'],
  ['T', 'Shot trajectory guide'],
  ['C', 'Cycle camera'],
  ['B', 'Reset the camera framing'],
  ['M', 'Restart the match'],
  ['G', 'Put the game away / bring it back'],
  ['P', 'Pause'],
  ['.', 'Step one op-mode loop'],
  [',', 'Step one millisecond'],
  ['Tab', 'Show / hide settings'],
];
