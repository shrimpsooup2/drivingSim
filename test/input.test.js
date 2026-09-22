import test from 'node:test';
import assert from 'node:assert/strict';
import { Config } from '../src/config/Config.js';
import { Simulation } from '../src/app/Simulation.js';
import { InputManager } from '../src/input/InputManager.js';
import {
  APP_SHORTCUTS,
  BUTTON_KEYS,
  AXIS_KEYS,
  PAD_KEY_CODES,
  KEYBOARD_HELP,
  KeyboardSource,
  assertNoKeyboardCollisions,
  keyFor,
} from '../src/input/KeyboardSource.js';
import { nextStep } from '../src/ui/MatchPanel.js';

/**
 * Every key the app binds as a one-shot action.
 *
 * Kept in the test rather than imported because `App` needs a DOM. If a
 * shortcut is added to `App._bindKeys`, it goes here too -- and `on()` throws
 * at startup if it collides, so the app cannot ship a collision either way.
 */
function rig() {
  const config = new Config();
  const input = new InputManager({ latencySeconds: 0.04, target: new EventTarget() });
  const sim = new Simulation(config, { input });
  input.keyboardSource.active = true;
  return { sim, input, keys: input.keyboardSource.keys };
}

test('no app shortcut lands on a key the gamepad emulation uses', () => {
  // This is the whole bug class. A collision does not fail loudly; it does
  // something else as well, which is worse. Four controls were unusable from
  // the keyboard because G was both eject and "put the game away", F was both
  // Y and field centric, H was both intake and the IMU reset, and Space was
  // both fire and the drive burst.
  assertNoKeyboardCollisions(APP_SHORTCUTS);
});

test('the pad emulation claims each key exactly once', () => {
  const codes = [...Object.values(BUTTON_KEYS), ...Object.values(AXIS_KEYS).flat()];
  assert.equal(new Set(codes).size, codes.length, 'a key stands in for two controls');
  assert.equal(PAD_KEY_CODES.size, codes.length);
});

test('KeyboardSource refuses a colliding shortcut outright', () => {
  const keyboard = new KeyboardSource(new EventTarget());
  assert.throws(() => keyboard.on('KeyY', () => {}), /collision/i);
  assert.throws(() => keyboard.on('Space', () => {}), /collision/i);
  // And accepts one that is free.
  keyboard.on('KeyM', () => {});
  assert.ok(keyboard.actions.has('KeyM'));
});

test('every key in the help overlay is a key that does something', () => {
  const described = new Set();
  for (const [label] of KEYBOARD_HELP) {
    for (const part of label.split('/')) described.add(part.trim());
  }
  const bound = new Set([
    ...APP_SHORTCUTS.map(codeLabel),
    ...[...PAD_KEY_CODES.keys()].map(codeLabel),
    'Arrow keys',
  ]);
  for (const key of described) {
    assert.ok(bound.has(key), `the help lists "${key}" but nothing is bound to it`);
  }
});

test('the whole shooting sequence works from the keyboard', () => {
  // The user-facing bug was "you cannot shoot on keyboard". This is that
  // sequence, driven through key codes rather than through the gamepad object,
  // so it exercises the mapping and not just the launcher.
  const { sim, keys } = rig();
  const game = sim.enableGame({ alliance: 'red' }).start();
  const held = game.intake.count;
  assert.ok(held > 0, 'starts with pre-loads to shoot');

  const tap = (code, frames = 4) => {
    keys.add(code);
    for (let i = 0; i < frames; i++) sim.step(1 / 60);
    keys.delete(code);
    sim.step(1 / 60);
  };

  // Spin the flywheel up.
  assert.equal(game.launcher.spinning, false);
  tap(BUTTON_KEYS.y);
  assert.equal(game.launcher.spinning, true, 'Y spins the flywheel up');

  // It is a toggle, so it also switches off, and back on.
  tap(BUTTON_KEYS.y);
  assert.equal(game.launcher.spinning, false);
  tap(BUTTON_KEYS.y);
  assert.equal(game.launcher.spinning, true);

  for (let i = 0; i < 240; i++) sim.step(1 / 60);
  assert.ok(game.launcher.ready, `wheel reached ${game.launcher.rpm.toFixed(0)} rpm`);

  tap('Space', 6);
  assert.equal(game.launcher.shots, 1, 'Space fires');
  assert.equal(game.intake.count, held - 1);
});

test('the intake key runs the intake and nothing else', () => {
  // It used to also re-zero the gyro, because the same key did both.
  const { sim, keys } = rig();
  const game = sim.enableGame({ alliance: 'red' }).start();

  keys.add(BUTTON_KEYS.right_bumper);
  for (let i = 0; i < 6; i++) sim.step(1 / 60);
  assert.ok(game.intake.command > 0, 'the roller is running in');
  keys.delete(BUTTON_KEYS.right_bumper);

  keys.add(BUTTON_KEYS.left_bumper);
  for (let i = 0; i < 6; i++) sim.step(1 / 60);
  assert.ok(game.intake.command < 0, 'and the other bumper spits back out');
  keys.delete(BUTTON_KEYS.left_bumper);
});

test('field centric and the heading reset are on their own keys', () => {
  const { sim, keys } = rig();
  const opMode = /** @type {any} */ (sim.opMode);
  const before = opMode.driver.fieldCentric;

  keys.add(BUTTON_KEYS.x);
  for (let i = 0; i < 5; i++) sim.step(1 / 60);
  keys.delete(BUTTON_KEYS.x);
  assert.equal(opMode.driver.fieldCentric, !before, 'X toggles it, once, not twice');

  // Turn the robot, let the IMU catch up through its own latency and filter,
  // then reset the heading and check it followed.
  sim.robot.body.rotation.setRadians(1.1);
  for (let i = 0; i < 6; i++) sim.step(1 / 60);
  assert.ok(sim.robot.imu.heading > 1, 'the IMU sees the rotation first');
  keys.add(BUTTON_KEYS.a);
  for (let i = 0; i < 6; i++) sim.step(1 / 60);
  keys.delete(BUTTON_KEYS.a);
  // Not exactly zero: the IMU is modelled with bias and noise, so "re-zeroed"
  // means within its own error, not within floating point.
  assert.ok(Math.abs(sim.robot.imu.heading) < 0.02, `Z re-zeroes the IMU, got ${sim.robot.imu.heading}`);
});

test('the burst key is not the fire key', () => {
  // Sharing the right trigger meant every shot came with a wheelspin.
  const { sim, keys } = rig();
  const game = sim.enableGame({ alliance: 'red' }).start();
  game.launcher.spinning = true;
  for (let i = 0; i < 240; i++) sim.step(1 / 60);

  keys.add(BUTTON_KEYS.b);
  for (let i = 0; i < 6; i++) sim.step(1 / 60);
  keys.delete(BUTTON_KEYS.b);
  assert.equal(game.launcher.shots, 0, 'the burst key did not fire the launcher');
});

test('the next-step prompt names a key when the driver is on the keyboard', () => {
  const state = {
    phase: 'teleop',
    held: 0,
    shooter: { spinning: false, ready: false },
    solution: { rpm: 2400, angle: 0.9 },
    moving: false,
  };
  assert.match(nextStep(state, 'gamepad').text, /RIGHT BUMPER/);
  assert.match(nextStep(state, 'keyboard').text, new RegExp(`^${keyFor('right_bumper')}\\b`));

  const spun = { ...state, held: 2 };
  assert.match(nextStep(spun, 'gamepad').text, /^Y\b/);
  assert.match(nextStep(spun, 'keyboard').text, new RegExp(`^${keyFor('y')}\\b`));

  const ready = { ...spun, shooter: { spinning: true, ready: true } };
  assert.match(nextStep(ready, 'gamepad').text, /RIGHT TRIGGER/);
  assert.match(nextStep(ready, 'keyboard').text, /^Space\b/i);
});

function codeLabel(code) {
  if (code === 'Slash') return '?';
  if (code === 'Space') return 'Space';
  if (code === 'ShiftLeft' || code === 'ShiftRight') return 'Shift';
  if (code === 'Period') return '.';
  if (code === 'Comma') return ',';
  if (code === 'Backquote') return '`';
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Arrow')) return 'Arrow keys';
  return code;
}
