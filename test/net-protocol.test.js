import test from 'node:test';
import assert from 'node:assert/strict';
import {
  encodeInput,
  decodeInput,
  encodeSnapshot,
  decodeSnapshot,
  snapshotBytes,
  PROTOCOL_VERSION,
  INPUT_BUTTONS,
  CONTAINERS,
  MSG,
} from '../src/net/protocol.js';
import { FtcGamepad } from '../src/input/FtcGamepad.js';

test('a gamepad survives the round trip within its own resolution', () => {
  const pad = new FtcGamepad();
  pad.left_stick_x = -0.3751;
  pad.left_stick_y = 0.9;
  pad.right_stick_x = 1;
  pad.right_stick_y = -1;
  pad.left_trigger = 0.25;
  pad.right_trigger = 1;
  pad.a = true;
  pad.dpad_left = true;
  pad.start = true;

  const decoded = decodeInput(encodeInput(pad, 1234));
  assert.ok(decoded);
  assert.equal(decoded.seq, 1234);

  // 16 bits over [-1, 1] is 3e-5 a step, which is well under a real stick's
  // own noise -- so this is a tolerance on the format, not on the physics.
  for (const axis of ['left_stick_x', 'left_stick_y', 'right_stick_x', 'right_stick_y']) {
    assert.ok(
      Math.abs(decoded.pad[axis] - pad[axis]) < 1e-4,
      `${axis}: ${decoded.pad[axis]} vs ${pad[axis]}`,
    );
  }
  assert.ok(Math.abs(decoded.pad.left_trigger - 0.25) < 1e-4);
  assert.equal(decoded.pad.right_trigger, 1);

  assert.equal(decoded.pad.a, true);
  assert.equal(decoded.pad.dpad_left, true);
  assert.equal(decoded.pad.start, true);
  assert.equal(decoded.pad.b, false);
  assert.equal(decoded.pad.right_bumper, false);
});

test('every button has its own bit', () => {
  // The bug this catches is two buttons sharing a bit, which looks like a
  // sticky control rather than a protocol error.
  for (const button of INPUT_BUTTONS) {
    const pad = new FtcGamepad();
    pad[button] = true;
    const decoded = decodeInput(encodeInput(pad, 0));
    assert.ok(decoded);
    const on = INPUT_BUTTONS.filter((b) => decoded.pad[b]);
    assert.deepEqual(on, [button], `${button} should be the only one set`);
  }
});

test('an input packet is small enough to send every cycle', () => {
  const bytes = encodeInput(new FtcGamepad(), 0).byteLength;
  // 50 Hz x this has to be nothing on a home network. 19 bytes is 950 B/s.
  assert.ok(bytes <= 24, `${bytes} bytes per cycle`);
});

function sampleSnapshot() {
  return {
    tick: 4242,
    clock: 87.25,
    phase: 3,
    robots: [
      {
        slot: 0,
        x: -1.2345,
        y: 0.5,
        heading: 1.5,
        rpm: 3125.5,
        hood: (62 * Math.PI) / 180,
        held: 3,
        alliance: 'red',
        driverControlled: true,
      },
      {
        slot: 1,
        x: 1.6,
        y: -0.75,
        heading: -2.9,
        rpm: 0,
        hood: 0,
        held: 0,
        alliance: 'blue',
        driverControlled: false,
      },
    ],
    balls: [
      {
        x: 0.25,
        y: -0.5,
        z: 0.036,
        ox: 0,
        oy: 0,
        oz: 0,
        ow: 1,
        kind: 'pollen',
        alliance: null,
        container: 'none',
        outOfBounds: false,
      },
      {
        x: -1,
        y: 1,
        z: 0.9,
        ox: 0.5,
        oy: -0.5,
        oz: 0.5,
        ow: 0.5,
        kind: 'nectar',
        alliance: 'blue',
        container: 'cell',
        outOfBounds: false,
      },
      {
        x: 2,
        y: 2,
        z: 0,
        ox: 0,
        oy: 0,
        oz: 0,
        ow: 1,
        kind: 'nectar',
        alliance: 'red',
        container: 'none',
        outOfBounds: true,
      },
    ],
    hives: [
      { angle: 0.35, up: 0 },
      { angle: -0.35, up: 1 },
    ],
    flowers: [
      { count: 4, owner: 1, bottom: 2 },
      { count: 0, owner: 0, bottom: 0 },
    ],
  };
}

test('a snapshot round trips every field it carries', () => {
  const snap = sampleSnapshot();
  const decoded = decodeSnapshot(encodeSnapshot(snap));
  assert.ok(decoded);

  assert.equal(decoded.tick, snap.tick);
  assert.equal(decoded.clock, snap.clock);
  assert.equal(decoded.phase, snap.phase);
  assert.equal(decoded.robots.length, 2);
  assert.equal(decoded.balls.length, 3);
  assert.equal(decoded.hives.length, 2);
  assert.equal(decoded.flowers.length, 2);

  const [r0, r1] = decoded.robots;
  assert.ok(Math.abs(r0.x - -1.2345) < 1e-5, `x ${r0.x}`);
  assert.ok(Math.abs(r0.heading - 1.5) < 1e-6);
  assert.equal(r0.rpm, 3125.5, 'quarter-rpm resolution is exact here');
  assert.ok(Math.abs((r0.hood * 180) / Math.PI - 62) < 0.5);
  assert.equal(r0.held, 3);
  assert.equal(r0.alliance, 'red');
  assert.equal(r0.driverControlled, true);
  assert.equal(r1.alliance, 'blue');
  assert.equal(r1.driverControlled, false);

  const [b0, b1, b2] = decoded.balls;
  assert.equal(b0.kind, 'pollen');
  assert.equal(b0.alliance, null);
  assert.equal(b0.container, 'none');
  assert.equal(b0.outOfBounds, false);
  assert.ok(Math.abs(b0.z - 0.036) < 1e-6);

  assert.equal(b1.kind, 'nectar');
  assert.equal(b1.alliance, 'blue');
  assert.equal(b1.container, 'cell');
  for (const [axis, want] of [['ox', 0.5], ['oy', -0.5], ['oz', 0.5], ['ow', 0.5]]) {
    assert.ok(Math.abs(b1[axis] - want) < 1e-4, `${axis} ${b1[axis]}`);
  }

  assert.equal(b2.alliance, 'red');
  assert.equal(b2.outOfBounds, true, 'an element off the FIELD still has to be reported');

  assert.ok(Math.abs(decoded.hives[0].angle - 0.35) < 1e-6);
  assert.equal(decoded.hives[1].up, 1);
  assert.deepEqual(decoded.flowers[0], { count: 4, owner: 1, bottom: 2 });
});

test('every container kind survives the flags byte', () => {
  // Container shares its byte with kind, alliance and the out-of-bounds bit,
  // so a shift that is one bit out only shows up on the later kinds.
  for (const container of CONTAINERS) {
    const snap = sampleSnapshot();
    snap.balls = [{ ...snap.balls[0], container, kind: 'nectar', alliance: 'blue', outOfBounds: true }];
    const decoded = decodeSnapshot(encodeSnapshot(snap));
    assert.ok(decoded);
    assert.equal(decoded.balls[0].container, container);
    assert.equal(decoded.balls[0].kind, 'nectar', `kind survived alongside ${container}`);
    assert.equal(decoded.balls[0].alliance, 'blue');
    assert.equal(decoded.balls[0].outOfBounds, true);
  }
});

test('a full field is a kilobyte or so', () => {
  const bytes = snapshotBytes(4, 44);
  assert.ok(bytes > 400 && bytes < 2048, `${bytes} bytes`);
  // 20 Hz of that, which is what the host sends, in kB/s.
  assert.ok((bytes * 20) / 1024 < 32, `${((bytes * 20) / 1024).toFixed(1)} kB/s`);
});

test('a snapshot from a different build is refused rather than misread', () => {
  const buffer = encodeSnapshot(sampleSnapshot());
  assert.ok(decodeSnapshot(buffer), 'this build reads its own');

  const wrong = new Uint8Array(buffer.slice(0));
  wrong[1] = PROTOCOL_VERSION + 1;
  assert.equal(
    decodeSnapshot(wrong.buffer),
    null,
    'a newer layout must not be read at this build’s offsets',
  );
});

test('a truncated or foreign packet decodes to null, not to garbage', () => {
  const buffer = encodeSnapshot(sampleSnapshot());
  assert.equal(decodeSnapshot(buffer.slice(0, 10)), null, 'cut short');
  assert.equal(decodeSnapshot(new ArrayBuffer(0)), null, 'empty');

  const input = encodeInput(new FtcGamepad(), 1);
  assert.equal(decodeSnapshot(input), null, 'an input packet is not a snapshot');
  assert.equal(decodeInput(buffer), null, 'and a snapshot is not an input packet');

  // And the two type tags really are different, which is what makes the two
  // checks above more than a coincidence.
  assert.notEqual(MSG.input, MSG.snapshot);
});

test('an empty field encodes and decodes', () => {
  const decoded = decodeSnapshot(
    encodeSnapshot({ tick: 0, clock: 0, phase: 0, robots: [], balls: [], hives: [], flowers: [] }),
  );
  assert.ok(decoded);
  assert.deepEqual(decoded.robots, []);
  assert.deepEqual(decoded.balls, []);
});
