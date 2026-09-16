/**
 * What goes over the wire between a hosting browser and a joining one.
 *
 * ## Why an authoritative host rather than lockstep
 *
 * The tempting design for a deterministic simulator is lockstep: everybody
 * runs the same physics on the same inputs and nothing but inputs crosses the
 * network. It is wrong here, and not for a subtle reason. The physics calls
 * `Math.sin`, `Math.cos` and `Math.exp` on every substep, and ECMA-262 does
 * not specify their results -- it allows an implementation-approximated value.
 * Two browsers, or two versions of one browser, may differ in the last bit,
 * and at 2000 substeps a second a last-bit difference is a visibly different
 * MATCH inside a minute. There would be no way to tell that from a bug.
 *
 * So one browser is authoritative. It runs the whole simulation, the AI and
 * the REFEREE; the others send their gamepad and draw what they are told. That
 * costs input latency -- a joiner sees its own robot respond a snapshot late --
 * and buys a MATCH that is the same MATCH for everyone, which is the point of
 * practising together.
 *
 * ## Two channels, on purpose
 *
 * The hot path is binary and the rest is JSON.
 *
 *   - **Binary** carries the things that move every frame: robot poses, ball
 *     positions and spins, HIVE angles, FLOWER contents. It is packed by hand
 *     because it goes 20 times a second and there are forty-odd balls.
 *   - **JSON** carries everything a human would want to read: the score
 *     breakdown, the phase, REFEREE citations, who is in which slot. It goes
 *     four times a second and is `match.status()` and `match.score()` passed
 *     straight through, so there is no second copy of the scoring schema to
 *     drift out of step with the first.
 *
 * The split is also the reason the snapshot does not need a version-tolerant
 * encoder: anything whose shape is still moving lives in the JSON half.
 *
 * @module
 */

/**
 * Bumped whenever the binary layout changes.
 *
 * Checked on join, because the failure it prevents is the worst kind: a joiner
 * on an older build reads a snapshot with the fields at different offsets,
 * gets plausible-looking garbage, and reports it as a physics bug.
 */
export const PROTOCOL_VERSION = 1;

export const MSG = {
  input: 1,
  snapshot: 2,
};

/** Match phases, as a byte. Order is the order they happen in. */
export const PHASES = ['setup', 'auto', 'transition', 'teleop', 'ended'];

/** Gamepad buttons, in the bit order the input packet uses. */
export const INPUT_BUTTONS = [
  'a',
  'b',
  'x',
  'y',
  'left_bumper',
  'right_bumper',
  'dpad_up',
  'dpad_down',
  'dpad_left',
  'dpad_right',
  'back',
  'start',
];

/**
 * Type, sender, sequence, buttons, four axes, two triggers.
 *
 * The sender byte is reserved here rather than added by the relay. An input
 * packet carries no name -- there is no room for one at 50 Hz per joiner -- so
 * the relay has to say who sent it, and the cheap way to do that is to write
 * one byte in place. Bolting it on instead means reallocating every packet and,
 * worse, shifting every offset below it, so the decoder and the encoder
 * disagree by one byte and the sticks read as button presses.
 */
const INPUT_BYTES = 1 + 1 + 4 + 2 + 8 + 4;
/** Where the relay writes the sender. Zero means "straight from a client". */
export const INPUT_SENDER_OFFSET = 1;

/**
 * Pack one cycle of a joiner's gamepad.
 *
 * Axes go as signed 16-bit, which is about 3e-5 of stick travel -- far finer
 * than a real stick's own noise floor, and half the bytes of a float. The
 * sequence number is what lets the host ignore a packet that arrives after a
 * newer one, which happens whenever two packets take different routes.
 *
 * @param {import('../input/FtcGamepad.js').FtcGamepad} pad
 * @param {number} seq
 * @returns {ArrayBuffer}
 */
export function encodeInput(pad, seq) {
  const buffer = new ArrayBuffer(INPUT_BYTES);
  const view = new DataView(buffer);
  view.setUint8(0, MSG.input);
  view.setUint8(INPUT_SENDER_OFFSET, 0);
  view.setUint32(2, seq >>> 0, true);

  let bits = 0;
  for (let i = 0; i < INPUT_BUTTONS.length; i++) {
    if (pad[INPUT_BUTTONS[i]]) bits |= 1 << i;
  }
  view.setUint16(6, bits, true);

  view.setInt16(8, unitToInt16(pad.left_stick_x), true);
  view.setInt16(10, unitToInt16(pad.left_stick_y), true);
  view.setInt16(12, unitToInt16(pad.right_stick_x), true);
  view.setInt16(14, unitToInt16(pad.right_stick_y), true);
  view.setUint16(16, triggerToUint16(pad.left_trigger), true);
  view.setUint16(18, triggerToUint16(pad.right_trigger), true);
  return buffer;
}

/**
 * @param {ArrayBuffer|ArrayBufferView} data
 * @returns {{sender: number, seq: number, pad: Record<string, any>}|null}
 */
export function decodeInput(data) {
  const view = asView(data);
  if (view.byteLength < INPUT_BYTES || view.getUint8(0) !== MSG.input) return null;
  const sender = view.getUint8(INPUT_SENDER_OFFSET);
  const seq = view.getUint32(2, true);
  const bits = view.getUint16(6, true);
  /** @type {any} */
  const pad = { source: 'network', connected: true };
  for (let i = 0; i < INPUT_BUTTONS.length; i++) {
    pad[INPUT_BUTTONS[i]] = (bits & (1 << i)) !== 0;
  }
  pad.left_stick_x = int16ToUnit(view.getInt16(8, true));
  pad.left_stick_y = int16ToUnit(view.getInt16(10, true));
  pad.right_stick_x = int16ToUnit(view.getInt16(12, true));
  pad.right_stick_y = int16ToUnit(view.getInt16(14, true));
  pad.left_trigger = uint16ToTrigger(view.getUint16(16, true));
  pad.right_trigger = uint16ToTrigger(view.getUint16(18, true));
  return { sender, seq, pad };
}

// --------------------------------------------------------------- the snapshot

const HEADER_BYTES = 1 + 1 + 4 + 4 + 1 + 2 + 1 + 1;
const ROBOT_BYTES = 4 * 3 + 2 + 1 + 1 + 1;
/**
 * A ball is a position, a spin and a byte of state.
 *
 * Positions stay `f32`. Quantising them to `i16` over the FIELD would halve
 * the ball section and cost 0.06 mm of resolution, which nobody would see --
 * but a snapshot is about a kilobyte either way and that is nothing on the
 * network this runs on, so the simpler encoder wins until there is a reason.
 * The orientation *is* quantised, because it is a unit quaternion and 16 bits
 * per component is far more than a rolling ball needs.
 */
const BALL_BYTES = 4 * 3 + 2 * 4 + 1;
const HIVE_BYTES = 4 + 1;
const FLOWER_BYTES = 3;

/** Ball container kinds, as a byte. `none` means loose on the FIELD. */
export const CONTAINERS = ['none', 'cell', 'flower', 'garden', 'allianceArea', 'intake'];

/**
 * @typedef {object} SnapshotRobot
 * @property {number} x @property {number} y @property {number} heading
 * @property {number} rpm @property {number} hood @property {number} held
 * @property {'red'|'blue'} alliance @property {boolean} driverControlled
 * @property {number} slot
 */

/**
 * @typedef {object} SnapshotBall
 * @property {number} x @property {number} y @property {number} z
 * @property {number} ox @property {number} oy @property {number} oz @property {number} ow
 * @property {'pollen'|'nectar'} kind
 * @property {'red'|'blue'|null} alliance
 * @property {string} container
 * @property {boolean} outOfBounds
 */

/**
 * @typedef {object} Snapshot
 * @property {number} tick @property {number} clock @property {number} phase
 * @property {SnapshotRobot[]} robots @property {SnapshotBall[]} balls
 * @property {{angle: number, up: number}[]} hives
 * @property {{count: number, owner: number, bottom: number}[]} flowers
 */

/**
 * @param {Snapshot} snap
 * @returns {ArrayBuffer}
 */
export function encodeSnapshot(snap) {
  const robots = snap.robots ?? [];
  const balls = snap.balls ?? [];
  const hives = snap.hives ?? [];
  const flowers = snap.flowers ?? [];
  const size =
    HEADER_BYTES +
    robots.length * ROBOT_BYTES +
    balls.length * BALL_BYTES +
    hives.length * HIVE_BYTES +
    flowers.length * FLOWER_BYTES;

  const buffer = new ArrayBuffer(size);
  const view = new DataView(buffer);
  let o = 0;
  view.setUint8(o++, MSG.snapshot);
  view.setUint8(o++, PROTOCOL_VERSION);
  view.setUint32(o, snap.tick >>> 0, true);
  o += 4;
  view.setFloat32(o, snap.clock ?? 0, true);
  o += 4;
  view.setUint8(o++, snap.phase ?? 0);
  view.setUint16(o, balls.length, true);
  o += 2;
  view.setUint8(o++, robots.length);
  view.setUint8(o++, (hives.length & 0x0f) | ((flowers.length & 0x0f) << 4));

  for (const r of robots) {
    view.setFloat32(o, r.x, true);
    o += 4;
    view.setFloat32(o, r.y, true);
    o += 4;
    view.setFloat32(o, r.heading, true);
    o += 4;
    // RPM to the nearest 1/4, which covers a 16000 rpm flywheel in 16 bits.
    view.setUint16(o, Math.max(0, Math.min(65535, Math.round((r.rpm ?? 0) * 4))), true);
    o += 2;
    view.setInt8(o++, Math.max(-128, Math.min(127, Math.round(((r.hood ?? 0) * 180) / Math.PI))));
    view.setUint8(o++, Math.min(255, r.held ?? 0));
    view.setUint8(o++, (r.alliance === 'blue' ? 1 : 0) | (r.driverControlled ? 2 : 0));
  }

  for (const b of balls) {
    view.setFloat32(o, b.x, true);
    o += 4;
    view.setFloat32(o, b.y, true);
    o += 4;
    view.setFloat32(o, b.z, true);
    o += 4;
    view.setInt16(o, unitToInt16(b.ox ?? 0), true);
    o += 2;
    view.setInt16(o, unitToInt16(b.oy ?? 0), true);
    o += 2;
    view.setInt16(o, unitToInt16(b.oz ?? 0), true);
    o += 2;
    view.setInt16(o, unitToInt16(b.ow ?? 1), true);
    o += 2;
    const container = Math.max(0, CONTAINERS.indexOf(b.container ?? 'none'));
    view.setUint8(
      o++,
      (b.kind === 'nectar' ? 1 : 0) |
        (b.alliance === 'red' ? 2 : b.alliance === 'blue' ? 4 : 0) |
        (b.outOfBounds ? 8 : 0) |
        (container << 4),
    );
  }

  for (const h of hives) {
    view.setFloat32(o, h.angle ?? 0, true);
    o += 4;
    view.setUint8(o++, h.up ?? 0);
  }

  for (const f of flowers) {
    view.setUint8(o++, Math.min(255, f.count ?? 0));
    view.setUint8(o++, f.owner ?? 0);
    view.setUint8(o++, f.bottom ?? 0);
  }
  return buffer;
}

/**
 * @param {ArrayBuffer|ArrayBufferView} data
 * @returns {Snapshot|null} null when it is not a snapshot, or not one this
 *   build can read -- the caller reports a version mismatch rather than
 *   drawing whatever the bytes happened to mean.
 */
export function decodeSnapshot(data) {
  const view = asView(data);
  if (view.byteLength < HEADER_BYTES) return null;
  if (view.getUint8(0) !== MSG.snapshot) return null;
  if (view.getUint8(1) !== PROTOCOL_VERSION) return null;

  let o = 2;
  const tick = view.getUint32(o, true);
  o += 4;
  const clock = view.getFloat32(o, true);
  o += 4;
  const phase = view.getUint8(o++);
  const ballCount = view.getUint16(o, true);
  o += 2;
  const robotCount = view.getUint8(o++);
  const packed = view.getUint8(o++);
  const hiveCount = packed & 0x0f;
  const flowerCount = (packed >> 4) & 0x0f;

  const expected =
    HEADER_BYTES +
    robotCount * ROBOT_BYTES +
    ballCount * BALL_BYTES +
    hiveCount * HIVE_BYTES +
    flowerCount * FLOWER_BYTES;
  if (view.byteLength < expected) return null;

  /** @type {SnapshotRobot[]} */
  const robots = [];
  for (let i = 0; i < robotCount; i++) {
    const x = view.getFloat32(o, true);
    o += 4;
    const y = view.getFloat32(o, true);
    o += 4;
    const heading = view.getFloat32(o, true);
    o += 4;
    const rpm = view.getUint16(o, true) / 4;
    o += 2;
    const hood = (view.getInt8(o++) * Math.PI) / 180;
    const held = view.getUint8(o++);
    const flags = view.getUint8(o++);
    robots.push({
      slot: i,
      x,
      y,
      heading,
      rpm,
      hood,
      held,
      alliance: flags & 1 ? 'blue' : 'red',
      driverControlled: (flags & 2) !== 0,
    });
  }

  /** @type {SnapshotBall[]} */
  const balls = [];
  for (let i = 0; i < ballCount; i++) {
    const x = view.getFloat32(o, true);
    o += 4;
    const y = view.getFloat32(o, true);
    o += 4;
    const z = view.getFloat32(o, true);
    o += 4;
    const ox = int16ToUnit(view.getInt16(o, true));
    o += 2;
    const oy = int16ToUnit(view.getInt16(o, true));
    o += 2;
    const oz = int16ToUnit(view.getInt16(o, true));
    o += 2;
    const ow = int16ToUnit(view.getInt16(o, true));
    o += 2;
    const flags = view.getUint8(o++);
    balls.push({
      x,
      y,
      z,
      ox,
      oy,
      oz,
      ow,
      kind: flags & 1 ? 'nectar' : 'pollen',
      alliance: flags & 2 ? 'red' : flags & 4 ? 'blue' : null,
      outOfBounds: (flags & 8) !== 0,
      container: CONTAINERS[(flags >> 4) & 0x0f] ?? 'none',
    });
  }

  const hives = [];
  for (let i = 0; i < hiveCount; i++) {
    const angle = view.getFloat32(o, true);
    o += 4;
    hives.push({ angle, up: view.getUint8(o++) });
  }

  const flowers = [];
  for (let i = 0; i < flowerCount; i++) {
    flowers.push({
      count: view.getUint8(o++),
      owner: view.getUint8(o++),
      bottom: view.getUint8(o++),
    });
  }

  return { tick, clock, phase, robots, balls, hives, flowers };
}

/** How big a snapshot of this shape will be, for the bandwidth readout. */
export function snapshotBytes(robots, balls, hives = 2, flowers = 6) {
  return (
    HEADER_BYTES +
    robots * ROBOT_BYTES +
    balls * BALL_BYTES +
    hives * HIVE_BYTES +
    flowers * FLOWER_BYTES
  );
}

// ------------------------------------------------------------------- helpers

function unitToInt16(v) {
  const clamped = v < -1 ? -1 : v > 1 ? 1 : v;
  return Math.round(clamped * 32767);
}

function int16ToUnit(v) {
  return v / 32767;
}

function triggerToUint16(v) {
  const clamped = v < 0 ? 0 : v > 1 ? 1 : v;
  return Math.round(clamped * 65535);
}

function uint16ToTrigger(v) {
  return v / 65535;
}

function asView(data) {
  if (data instanceof DataView) return data;
  if (data instanceof ArrayBuffer) return new DataView(data);
  if (ArrayBuffer.isView(data)) {
    return new DataView(data.buffer, data.byteOffset, data.byteLength);
  }
  throw new TypeError('expected an ArrayBuffer or a view over one');
}
