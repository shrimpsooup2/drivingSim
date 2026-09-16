/**
 * The joining browser: it sends a gamepad and draws what it is told.
 *
 * It still builds the whole game. The physics just never runs -- `Simulation`
 * skips it while a client is attached -- and each snapshot is written over the
 * top instead. So the renderer, the HUD and the match panel all work without
 * knowing they are looking at a mirror.
 *
 * ## One snapshot behind, on purpose
 *
 * A client draws the state *between* the last two snapshots rather than
 * guessing past the newest one. That costs a snapshot interval of latency --
 * 50 ms at 20 Hz, on top of the network -- and buys the guarantee that every
 * frame drawn is a state that really happened on the host.
 *
 * Extrapolation would hide the delay and pay for it with elements that go
 * through HIVE walls whenever a packet is late, then snap back. For a tool
 * people are using to learn where things are on a FIELD, a consistent 50 ms
 * behind is much the better trade -- and it is in the same range as a real
 * Control Hub's own command latency, so the feel is not unrealistic.
 *
 * There is no client-side prediction of the local robot. Prediction without
 * rollback jitters whenever it is wrong, rollback needs the physics to be
 * deterministic across browsers, and it is not (see `protocol.js`). So a
 * joiner's own robot answers the sticks a frame or two late, consistently,
 * which is a thing a driver adapts to within a match.
 *
 * @module
 */
import { encodeInput, decodeSnapshot, PHASES } from './protocol.js';
import { applySnapshot, blendSnapshots } from './snapshot.js';

/** Snapshot interval, as the client assumes it. Only used to pace the blend. */
const ASSUMED_SNAPSHOT_PERIOD = 1 / 20;
/**
 * How far the blend may run past the newer snapshot before it just holds.
 *
 * Without a ceiling, a gap in delivery lets the blend parameter grow without
 * bound and the FIELD keeps sliding in the direction it last moved -- which is
 * extrapolation by accident, and looks like the physics has gone wrong.
 */
const MAX_BLEND = 1;

export class NetClient {
  /** @param {{link: any, sim: any}} opts */
  constructor(opts) {
    this.role = 'client';
    this.link = opts.link;
    this.sim = opts.sim;

    /** Which MATCH entry this browser is driving, once the host says. */
    this.slot = -1;
    this.alliance = null;
    this.label = '';
    /** Set when the host had no robot to give us. */
    this.refused = '';

    /** The two most recent snapshots: [older, newer]. */
    this._older = null;
    this._newer = null;
    this._blend = 0;
    this._seq = 0;
    this.snapshots = 0;
    this.applied = 0;
    /** Non-empty when a snapshot could not be used, e.g. a build mismatch. */
    this.mismatch = '';
    /** The host's own score and status, passed through verbatim. */
    this.matchState = null;
    this.hostGone = false;
    this.log = [];

    this.link.onJson = (msg) => this._onJson(msg);
    this.link.onBinary = (data) => this._onBinary(data);
  }

  get connected() {
    return this.link.open;
  }

  get seated() {
    return this.slot >= 0;
  }

  status() {
    return {
      role: 'client',
      state: this.link.state,
      room: this.link.room,
      error: this.link.error || this.refused || this.mismatch,
      slot: this.slot,
      alliance: this.alliance,
      label: this.label,
      snapshots: this.snapshots,
      applied: this.applied,
      hostGone: this.hostGone,
      phase: this._newer ? PHASES[this._newer.phase] ?? 'setup' : null,
      bytesOut: this.link.stats.sent,
      bytesIn: this.link.stats.received,
    };
  }

  _onJson(msg) {
    switch (msg.t) {
      case 'assign':
        this.slot = msg.slot ?? -1;
        this.alliance = msg.alliance ?? null;
        this.label = msg.label ?? '';
        this.refused = '';
        this._note(`driving ${this.label || `slot ${this.slot}`} for ${this.alliance}`);
        break;
      case 'noSeat':
        this.refused = msg.message ?? 'no robot available';
        this._note(this.refused);
        break;
      case 'match':
        this.matchState = { status: msg.status, score: msg.score };
        break;
      case 'reset':
        this._older = null;
        this._newer = null;
        this._blend = 0;
        this._note('the host restarted the match');
        break;
      case 'hostGone':
        this.hostGone = true;
        this._note('the host disconnected');
        break;
      case 'welcome':
        this._note(`joined room ${msg.room} as ${msg.id}`);
        break;
      default:
        break;
    }
  }

  _onBinary(data) {
    const snap = decodeSnapshot(data);
    if (!snap) {
      // Either a foreign packet or a host on a different build. The version
      // byte is checked inside `decodeSnapshot` precisely so this is a clear
      // message rather than a field full of nonsense.
      this.mismatch = 'the host is running a different build of the simulator';
      return;
    }
    this.snapshots++;
    // Out of order: keep the newer one and throw the straggler away rather
    // than stepping backwards.
    if (this._newer && snap.tick <= this._newer.tick) return;
    this._older = this._newer ?? snap;
    this._newer = snap;
    this._blend = 0;
  }

  /**
   * Send this browser's gamepad. Called from the control cycle, so it goes at
   * the op-mode rate and carries the same state the local op-mode would see.
   * @param {import('../input/FtcGamepad.js').FtcGamepad} pad
   */
  sendInput(pad) {
    if (!this.link.open || !this.seated) return false;
    return this.link.sendBinary(encodeInput(pad, ++this._seq));
  }

  /**
   * Draw one frame's worth: advance the blend and write it onto the mirror.
   * @param {number} dt seconds of real time since the last frame
   */
  update(dt) {
    if (!this._newer) return this;
    const game = this.sim.game;
    if (!game) return this;

    this._blend = Math.min(MAX_BLEND, this._blend + dt / ASSUMED_SNAPSHOT_PERIOD);
    const state =
      this._older && this._older !== this._newer
        ? blendSnapshots(this._older, this._newer, this._blend)
        : this._newer;

    const result = applySnapshot(game, state);
    if (!result.applied) {
      this.mismatch = result.reason ?? 'the snapshot did not fit this field';
      return this;
    }
    this.mismatch = '';
    this.applied++;
    return this;
  }

  close() {
    this.link.close();
    return this;
  }

  _note(line) {
    this.log.push(line);
    if (this.log.length > 40) this.log.shift();
  }
}
