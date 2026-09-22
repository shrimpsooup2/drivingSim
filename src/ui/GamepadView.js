/**
 * The gamepad, on screen, as the simulator sees it.
 *
 * ## Why look at your own hands
 *
 * Three things a driver cannot see and needs to:
 *
 *  - **The deadband.** A worn stick that never returns to centre shows up here
 *    as a dot that sits off the middle while your thumb is nowhere near it.
 *  - **The delay.** Two dots are drawn: a faint one for what the controller is
 *    reporting right now, and a solid one for what the op-mode is being given,
 *    40 ms later. The gap between them is the latency, and seeing it is the
 *    fastest way to understand why a real robot feels less immediate than a
 *    naive simulator.
 *  - **Whether the pad is on the right mode at all.** A Logitech F310 with its
 *    rear switch on D rather than X reports nothing here, and "the controller
 *    does not work" stops being a mystery.
 *
 * Ported from the JVM simulator's two on-screen gamepads. There is one here
 * rather than two because this simulator models one: `gamepad1` and `gamepad2`
 * are handed the same state, since nothing in a driving trainer needs a second
 * driver's controls. If a second pad is ever wired up, this draws it.
 *
 * @module
 */
import { keyFor } from '../input/KeyboardSource.js';

/** Buttons, in the order they are drawn, with the label each one gets. */
const FACE = [
  ['y', 'Y'],
  ['x', 'X'],
  ['b', 'B'],
  ['a', 'A'],
];
const SHOULDERS = [
  ['left_bumper', 'LB'],
  ['right_bumper', 'RB'],
];
const DPAD = [
  ['dpad_up', '↑'],
  ['dpad_left', '←'],
  ['dpad_down', '↓'],
  ['dpad_right', '→'],
];
const SYSTEM = [
  ['back', 'BACK'],
  ['start', 'START'],
];

export class GamepadView {
  /**
   * @param {HTMLElement} viewport
   */
  constructor(viewport) {
    this.root = el('div', 'pad-view hidden');
    viewport.append(this.root);

    const head = el('div', 'pad-head');
    this.title = el('span', 'pad-title', 'gamepad1');
    this.source = el('span', 'pad-source', 'no input');
    head.append(this.title, this.source);
    this.root.append(head);

    const sticks = el('div', 'pad-sticks');
    this.left = stick('left stick');
    this.right = stick('right stick');
    sticks.append(this.left.node, this.right.node);
    this.root.append(sticks);

    const triggers = el('div', 'pad-triggers');
    this.leftTrigger = triggerBar('LT');
    this.rightTrigger = triggerBar('RT');
    triggers.append(this.leftTrigger.node, this.rightTrigger.node);
    this.root.append(triggers);

    this.buttons = new Map();
    for (const group of [SHOULDERS, FACE, DPAD, SYSTEM]) {
      const row = el('div', 'pad-buttons');
      for (const [name, label] of group) {
        const node = el('span', 'pad-button', label);
        const key = keyFor(name);
        if (key) node.title = `${name} (${key})`;
        row.append(node);
        this.buttons.set(name, node);
      }
      this.root.append(row);
    }
  }

  setVisible(visible) {
    this.root.classList.toggle('hidden', !visible);
    return this;
  }

  get visible() {
    return !this.root.classList.contains('hidden');
  }

  /**
   * @param {import('../input/InputManager.js').InputManager} input
   */
  update(input) {
    if (!this.visible) return this;
    const pad = input.gamepad;
    const raw = input.rawGamepad;

    const source = input.activeSource;
    this.source.textContent =
      source === 'gamepad' ? 'controller' : source === 'keyboard' ? 'keyboard' : 'no input';
    this.source.dataset.tone = source === 'none' ? 'idle' : 'good';

    // The delayed dot is the one an op-mode acts on; the faint one is the
    // controller right now. The gap is `control.inputLatencyMs`.
    this.left.set(pad.left_stick_x, pad.left_stick_y, raw.left_stick_x, raw.left_stick_y);
    this.right.set(pad.right_stick_x, pad.right_stick_y, raw.right_stick_x, raw.right_stick_y);
    this.leftTrigger.set(pad.left_trigger);
    this.rightTrigger.set(pad.right_trigger);

    for (const [name, node] of this.buttons) {
      node.classList.toggle('on', Boolean(pad[name]));
    }
    return this;
  }
}

/**
 * One stick: a box, a crosshair, and two dots.
 *
 * Drawn with positioned elements rather than a canvas because it is four moving
 * dots at 60 Hz and a third canvas to size, clear and scale for device pixels
 * would be more code than the thing it draws.
 */
function stick(label) {
  const node = el('div', 'pad-stick');
  const well = el('div', 'pad-well');
  const crossX = el('div', 'pad-cross-x');
  const crossY = el('div', 'pad-cross-y');
  const ghost = el('div', 'pad-dot ghost');
  const dot = el('div', 'pad-dot');
  well.append(crossX, crossY, ghost, dot);
  node.append(well, el('div', 'pad-stick-label', label));

  const place = (target, x, y) => {
    // `left_stick_y` is negative forward, as the SDK reports it, so pushing the
    // stick away from you has to move the dot up the screen.
    target.style.left = `${50 + clampUnit(x) * 42}%`;
    target.style.top = `${50 + clampUnit(y) * 42}%`;
  };

  return {
    node,
    set(x, y, rawX, rawY) {
      place(dot, x, y);
      place(ghost, rawX, rawY);
      const moved = Math.hypot(x, y) > 0.02;
      dot.classList.toggle('live', moved);
      // Hidden when it agrees with the delayed one, so a still stick is one dot
      // rather than two overlapping ones with a rounding error between them.
      ghost.classList.toggle('hidden', Math.hypot(rawX - x, rawY - y) < 0.02);
    },
  };
}

function triggerBar(label) {
  const node = el('div', 'pad-trigger');
  node.append(el('span', 'pad-trigger-label', label));
  const track = el('div', 'pad-trigger-track');
  const fill = el('div', 'pad-trigger-fill');
  track.append(fill);
  node.append(track);
  const readout = el('span', 'pad-trigger-value', '0.00');
  node.append(readout);
  return {
    node,
    set(value) {
      const v = clampUnit(value);
      fill.style.width = `${Math.abs(v) * 100}%`;
      readout.textContent = v.toFixed(2);
      node.classList.toggle('on', Math.abs(v) > 0.02);
    },
  };
}

function clampUnit(v) {
  return Number.isFinite(v) ? Math.max(-1, Math.min(1, v)) : 0;
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
