import { FtcGamepad } from './FtcGamepad.js';

/**
 * Reads a physical controller through the browser Gamepad API and maps it onto
 * FTC gamepad semantics.
 *
 * Uses the "standard" mapping, which is what an Xbox controller and a Logitech
 * F310 both report **provided the F310's rear switch is set to X (XInput)**. In
 * D mode the F310 enumerates as a generic device with a different axis order
 * and the mapping below will be wrong; that case is detected and reported so it
 * is obvious rather than mysterious.
 *
 * Browsers only expose gamepads after a button has been pressed on them, so a
 * controller that is plugged in but idle will not appear until it is used.
 */
export class GamepadSource {
  constructor() {
    this.index = -1;
    this.id = '';
    this.mapping = '';
    /** Set when a connected pad does not report the standard mapping. */
    this.nonStandard = false;
    this.state = new FtcGamepad();
    /** Raw axis and button values, for the controller test view. */
    this.raw = { axes: /** @type {number[]} */ ([]), buttons: /** @type {number[]} */ ([]) };
  }

  get available() {
    return typeof navigator !== 'undefined' && typeof navigator.getGamepads === 'function';
  }

  /** @returns {Gamepad|null} */
  _findPad() {
    if (!this.available) return null;
    const pads = navigator.getGamepads();
    if (!pads) return null;
    // Prefer the pad we already latched onto, so a second controller plugged in
    // mid-session does not steal control.
    if (this.index >= 0 && pads[this.index]) return pads[this.index];
    for (const pad of pads) {
      if (pad && pad.connected) {
        this.index = pad.index;
        this.id = pad.id;
        this.mapping = pad.mapping;
        this.nonStandard = pad.mapping !== 'standard';
        return pad;
      }
    }
    this.index = -1;
    return null;
  }

  /**
   * Poll the controller.
   * @returns {FtcGamepad}
   */
  poll() {
    const pad = this._findPad();
    const s = this.state;
    if (!pad) {
      s.connected = false;
      this.id = '';
      return s;
    }

    s.connected = true;
    s.source = 'gamepad';
    this.id = pad.id;
    this.mapping = pad.mapping;
    this.nonStandard = pad.mapping !== 'standard';
    this.raw.axes = Array.from(pad.axes);
    this.raw.buttons = pad.buttons.map((b) => b.value);

    const axis = (i) => (Number.isFinite(pad.axes[i]) ? pad.axes[i] : 0);
    const button = (i) => Boolean(pad.buttons[i]?.pressed);
    const analog = (i) => pad.buttons[i]?.value ?? 0;

    s.left_stick_x = axis(0);
    // The Gamepad API reports stick Y as positive-down; the FTC SDK reports it
    // the same way, so this passes through unchanged and stays negative-forward.
    s.left_stick_y = axis(1);
    s.right_stick_x = axis(2);
    s.right_stick_y = axis(3);

    s.a = button(0);
    s.b = button(1);
    s.x = button(2);
    s.y = button(3);
    s.left_bumper = button(4);
    s.right_bumper = button(5);
    s.left_trigger = analog(6);
    s.right_trigger = analog(7);
    s.back = button(8);
    s.start = button(9);
    s.left_stick_button = button(10);
    s.right_stick_button = button(11);
    s.dpad_up = button(12);
    s.dpad_down = button(13);
    s.dpad_left = button(14);
    s.dpad_right = button(15);
    s.guide = button(16);

    return s;
  }
}
