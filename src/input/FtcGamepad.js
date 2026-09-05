/**
 * Gamepad state using the FTC SDK's field names and sign conventions.
 *
 * The conventions are kept deliberately, quirks included:
 *
 *   **`left_stick_y` is negative when you push the stick forward.** That is how
 *   the FTC SDK reports it, and it is why almost every team's mecanum code
 *   starts with `double y = -gamepad1.left_stick_y;`. Reproducing it here means
 *   drive code you write against this simulator transfers to your op-mode
 *   unchanged, and a sign error here is the same sign error you would have had
 *   on the robot.
 *
 * `justPressed` is tracked per button so op-modes can do edge-triggered actions
 * (toggle field centric, reset heading) without each one reinventing it.
 */
export class FtcGamepad {
  constructor() {
    this.left_stick_x = 0;
    this.left_stick_y = 0;
    this.right_stick_x = 0;
    this.right_stick_y = 0;
    this.left_trigger = 0;
    this.right_trigger = 0;

    this.a = false;
    this.b = false;
    this.x = false;
    this.y = false;
    this.left_bumper = false;
    this.right_bumper = false;
    this.dpad_up = false;
    this.dpad_down = false;
    this.dpad_left = false;
    this.dpad_right = false;
    this.back = false;
    this.start = false;
    this.guide = false;
    this.left_stick_button = false;
    this.right_stick_button = false;

    /** True only on the frame a button went down. */
    this.pressed = /** @type {Record<string, boolean>} */ ({});
    /** True only on the frame a button came up. */
    this.released = /** @type {Record<string, boolean>} */ ({});
    this._previous = /** @type {Record<string, boolean>} */ ({});

    /** True while a physical controller is connected and reporting. */
    this.connected = false;
    /** 'gamepad' | 'keyboard' | 'none' */
    this.source = 'none';
  }

  static get BUTTONS() {
    return [
      'a', 'b', 'x', 'y',
      'left_bumper', 'right_bumper',
      'dpad_up', 'dpad_down', 'dpad_left', 'dpad_right',
      'back', 'start', 'guide',
      'left_stick_button', 'right_stick_button',
    ];
  }

  /** Recompute edge-trigger tables. Call once per control cycle. */
  updateEdges() {
    for (const name of FtcGamepad.BUTTONS) {
      const now = Boolean(this[name]);
      const before = Boolean(this._previous[name]);
      this.pressed[name] = now && !before;
      this.released[name] = !now && before;
      this._previous[name] = now;
    }
  }

  /** Was this button pushed down since the last control cycle? */
  justPressed(name) {
    return Boolean(this.pressed[name]);
  }

  /** Copy another gamepad's state into this one. */
  copyFrom(other) {
    this.left_stick_x = other.left_stick_x;
    this.left_stick_y = other.left_stick_y;
    this.right_stick_x = other.right_stick_x;
    this.right_stick_y = other.right_stick_y;
    this.left_trigger = other.left_trigger;
    this.right_trigger = other.right_trigger;
    for (const name of FtcGamepad.BUTTONS) this[name] = other[name];
    this.connected = other.connected;
    this.source = other.source;
    return this;
  }

  /** Plain snapshot, used by the latency delay line. */
  snapshot() {
    const s = {
      left_stick_x: this.left_stick_x,
      left_stick_y: this.left_stick_y,
      right_stick_x: this.right_stick_x,
      right_stick_y: this.right_stick_y,
      left_trigger: this.left_trigger,
      right_trigger: this.right_trigger,
      connected: this.connected,
      source: this.source,
    };
    for (const name of FtcGamepad.BUTTONS) s[name] = this[name];
    return s;
  }

  clear() {
    this.left_stick_x = 0;
    this.left_stick_y = 0;
    this.right_stick_x = 0;
    this.right_stick_y = 0;
    this.left_trigger = 0;
    this.right_trigger = 0;
    for (const name of FtcGamepad.BUTTONS) this[name] = false;
    return this;
  }
}
