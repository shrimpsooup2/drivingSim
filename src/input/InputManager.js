import { FtcGamepad } from './FtcGamepad.js';
import { GamepadSource } from './GamepadSource.js';
import { KeyboardSource } from './KeyboardSource.js';
import { DelayLine } from '../math/filters.js';

/**
 * Merges the physical controller and the keyboard into a single FTC gamepad,
 * then delays it to model real command latency.
 *
 * The latency is not cosmetic. Between a driver moving a stick and the wheels
 * responding sit the gamepad poll, the Driver Station app, the wifi link to the
 * Control Hub, and then waiting for the next op-mode loop -- around 40 ms all
 * told. Practising against a zero-latency simulator teaches timing that does
 * not transfer, so the delay is on by default and adjustable.
 */
export class InputManager {
  /**
   * @param {{latencySeconds?:number, target?:EventTarget}} [opts]
   */
  constructor(opts = {}) {
    this.gamepadSource = new GamepadSource();
    this.keyboardSource = new KeyboardSource(opts.target ?? globalThis);
    /** The delayed state op-modes read. */
    this.gamepad = new FtcGamepad();
    /** The undelayed state, for the controller test view. */
    this.rawGamepad = new FtcGamepad();

    this.delay = new DelayLine(opts.latencySeconds ?? 0.04);
    /** Which source last produced input: 'gamepad' | 'keyboard' | 'none'. */
    this.activeSource = 'none';
    this._lastGamepadActivity = 0;
    this._time = 0;
  }

  attach() {
    this.keyboardSource.attach();
    return this;
  }

  detach() {
    this.keyboardSource.detach();
    return this;
  }

  /** @param {number} seconds */
  setLatency(seconds) {
    if (Math.abs(this.delay.delaySeconds - seconds) > 1e-6) {
      this.delay.delaySeconds = seconds;
      this.delay.reset();
    }
    return this;
  }

  get controllerConnected() {
    return this.gamepadSource.state.connected;
  }

  get controllerName() {
    return this.gamepadSource.id;
  }

  get controllerNonStandard() {
    return this.gamepadSource.nonStandard;
  }

  /**
   * Poll all sources and produce the delayed gamepad. Call once per control cycle.
   * @param {number} dt seconds
   * @returns {FtcGamepad}
   */
  update(dt) {
    this._time += dt;
    const pad = this.gamepadSource.poll();
    const keys = this.keyboardSource.poll();

    // A physical controller wins whenever it is connected and being moved;
    // otherwise the keyboard drives. This lets someone pick up a controller
    // mid-session without touching a setting.
    const padActive = pad.connected && hasActivity(pad);
    if (padActive) this._lastGamepadActivity = this._time;
    const padRecentlyActive = pad.connected && this._time - this._lastGamepadActivity < 2.0;

    const source = padActive || padRecentlyActive ? pad : keys;
    this.activeSource = pad.connected ? 'gamepad' : keys.connected ? 'keyboard' : 'none';

    this.rawGamepad.copyFrom(source);
    this.rawGamepad.updateEdges();

    const delayed = this.delay.update(source.snapshot(), dt);
    Object.assign(this.gamepad, delayed);
    this.gamepad.updateEdges();
    return this.gamepad;
  }

  reset() {
    this.delay.reset();
    this.gamepad.clear();
    this.rawGamepad.clear();
    return this;
  }
}

const STICK_THRESHOLD = 0.12;

function hasActivity(pad) {
  if (
    Math.abs(pad.left_stick_x) > STICK_THRESHOLD ||
    Math.abs(pad.left_stick_y) > STICK_THRESHOLD ||
    Math.abs(pad.right_stick_x) > STICK_THRESHOLD ||
    Math.abs(pad.right_stick_y) > STICK_THRESHOLD ||
    pad.left_trigger > 0.15 ||
    pad.right_trigger > 0.15
  ) {
    return true;
  }
  return FtcGamepad.BUTTONS.some((name) => pad[name]);
}
