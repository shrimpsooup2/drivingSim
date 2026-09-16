/**
 * The hosting browser: it owns the MATCH and hands out the other three seats.
 *
 * A joiner does not get a new robot. It takes over one that is already on the
 * FIELD -- an AI opponent, with its own `Robot`, its own mechanisms and its own
 * entry in the MATCH. Nothing about the FIELD changes when somebody joins or
 * leaves; only who is deciding what that robot does.
 *
 * That is what makes the whole thing small. There is no "add a robot mid-match"
 * path to get wrong, the REFEREE and the scoring never see a difference, and a
 * joiner who drops out leaves an AI driving its robot rather than a corpse
 * parked on the tiles.
 *
 * A remote driver goes through *exactly* the player's path: a `TeleOpDrive`
 * bound to that robot, then `robot.updateControl(dt, pad)`. Same driver
 * processor, same acceleration ramp, same field-centric toggle, same voltage
 * sag. Writing a second, simpler control path for remote seats would have made
 * a joiner's robot subtly better or worse than the host's, which is the one
 * thing a practice tool cannot afford.
 *
 * @module
 */
import { TeleOpDrive } from '../teleop/TeleOpDrive.js';
import { FtcGamepad } from '../input/FtcGamepad.js';
import { decodeInput, encodeSnapshot } from './protocol.js';
import { buildSnapshot } from './snapshot.js';

/** Snapshots a second. Twenty is smooth once the joiner interpolates. */
export const SNAPSHOT_HZ = 20;
/** Score and citation updates a second, over JSON. */
export const STATE_HZ = 4;
/**
 * How long a seat keeps driving on no input before it is handed back to the AI.
 *
 * Short enough that a closed laptop lid does not leave a robot coasting for
 * the rest of the MATCH, long enough to ride out a Wi-Fi hiccup -- a joiner
 * sends 50 packets a second, so half a second of silence is 25 missed in a row
 * and is not congestion.
 */
export const INPUT_TIMEOUT = 0.5;

export class NetHost {
  /**
   * @param {{link: any, sim: any}} opts
   */
  constructor(opts) {
    this.role = 'host';
    this.link = opts.link;
    this.sim = opts.sim;
    /**
     * Read off the simulation rather than passed in.
     *
     * `TeleOpDrive` wants the *resolved* config (`Config.values`), not the
     * store, and taking it from the sim is the only way a remote seat cannot
     * end up on different driver settings from the host's own robot -- which
     * would be invisible until somebody noticed their robot accelerated
     * differently from the person sitting next to them.
     */
    this.config = opts.sim.config;

    /** @type {Map<string, {id: string, name: string, sender: number, opponent: any,
     *   pad: FtcGamepad, opMode: TeleOpDrive, seq: number, silentFor: number,
     *   slot: number, alliance: string, packets: number}>} */
    this.seats = new Map();
    /** Seat lookup by the one byte an input packet carries. */
    this._bySender = new Map();

    this.tick = 0;
    this._snapshotTimer = 0;
    this._stateTimer = 0;
    /** Everything that has happened, for the panel. */
    this.log = [];

    this.link.onJson = (msg) => this._onJson(msg);
    this.link.onBinary = (data) => this._onBinary(data);
  }

  get connected() {
    return this.link.open;
  }

  get room() {
    return this.link.room;
  }

  /** What the panel shows: who is here and whether their input is arriving. */
  status() {
    return {
      role: 'host',
      state: this.link.state,
      room: this.link.room,
      error: this.link.error,
      tick: this.tick,
      seats: [...this.seats.values()].map((seat) => ({
        id: seat.id,
        name: seat.name,
        slot: seat.slot,
        alliance: seat.alliance,
        driving: seat.silentFor < INPUT_TIMEOUT,
        packets: seat.packets,
      })),
      bytesOut: this.link.stats.sent,
      bytesIn: this.link.stats.received,
    };
  }

  // ------------------------------------------------------------------ joining

  _onJson(msg) {
    if (msg.t === 'peer') {
      if (msg.joined) this._seat(msg.id, msg.name ?? '');
      else this._unseat(msg.id);
      return;
    }
    if (msg.t === 'welcome') {
      this._note(`hosting room ${msg.room}`);
    }
  }

  /** Give a joiner a robot, or tell it there is nowhere to sit. */
  _seat(id, name) {
    if (this.seats.has(id)) return;
    const game = this.sim.game;
    const taken = new Set([...this.seats.values()].map((s) => s.opponent));
    const opponent = (this.sim.opponents ?? []).find((o) => !taken.has(o));
    if (!game || !opponent) {
      this.link.sendJson({
        t: 'noSeat',
        to: id,
        message: game
          ? 'every robot on the field is taken'
          : 'the host has not started a match yet',
      });
      this._note(`${name || id} could not be seated`);
      return;
    }

    const opMode = new TeleOpDrive({ config: this.config });
    opMode.robot = opponent.robot;
    opMode.sim = this.sim;
    opMode.reset();
    opMode.init();

    const slot = (game.match?.entries ?? []).findIndex((e) => e.id === opponent.matchId);
    const seat = {
      id,
      name,
      sender: Number(String(id).slice(1)) || 0,
      opponent,
      pad: new FtcGamepad(),
      opMode,
      seq: -1,
      silentFor: Infinity,
      slot,
      alliance: opponent.alliance,
      packets: 0,
    };
    seat.pad.source = 'network';
    this.seats.set(id, seat);
    if (seat.sender) this._bySender.set(seat.sender, seat);

    // A robot under a human is a DRIVER-controlled robot as far as the rules
    // are concerned, which is what G401 and the PARK tests key off.
    const entry = game.match?.entries?.[slot];
    if (entry) entry.driverControlled = true;

    this.link.sendJson({
      t: 'assign',
      to: id,
      slot,
      alliance: opponent.alliance,
      label: opponent.label,
      matchId: opponent.matchId,
    });
    this._note(`${name || id} is driving ${opponent.label} (${opponent.alliance})`);
  }

  _unseat(id) {
    const seat = this.seats.get(id);
    if (!seat) return;
    this.seats.delete(id);
    if (seat.sender) this._bySender.delete(seat.sender);
    // Back to the AI, rather than a robot standing still for the rest of the
    // MATCH. It is also the honest thing for the score: the seat is empty.
    const entry = this.sim.game?.match?.entries?.[seat.slot];
    if (entry) entry.driverControlled = false;
    this._note(`${seat.name || id} left; the AI has ${seat.opponent.label} back`);
  }

  _onBinary(data) {
    const decoded = decodeInput(data);
    if (!decoded) return;
    const seat = this._bySender.get(decoded.sender);
    if (!seat) return;
    // A packet older than one already applied is a packet that took a longer
    // route, and applying it would rewind the sticks by a frame.
    if (decoded.seq <= seat.seq && seat.seq - decoded.seq < 1000) return;
    seat.seq = decoded.seq;
    seat.silentFor = 0;
    seat.packets++;
    seat.pad.copyFrom(/** @type {any} */ (decoded.pad));
  }

  // ------------------------------------------------------------------ driving

  /** Whether this opponent's robot is currently under a human. */
  seatFor(opponent) {
    for (const seat of this.seats.values()) {
      if (seat.opponent === opponent) return seat.silentFor < INPUT_TIMEOUT ? seat : null;
    }
    return null;
  }

  /**
   * Run one control cycle for a remote seat, the same way the player's runs.
   * @param {number} dt
   */
  driveSeat(seat, dt) {
    seat.silentFor += dt;
    // Edges are recomputed here rather than on arrival: `justPressed` has to
    // mean "since the last control cycle", and input packets arrive at their
    // own rate, so doing it per packet makes a toggle fire twice on a frame
    // that happened to carry two.
    seat.pad.updateEdges();
    seat.opMode.loop(dt, seat.pad, seat.pad);
    seat.opponent.robot.updateControl(dt, seat.pad);
    return seat;
  }

  /** Called once per control cycle, before the seats are driven. */
  ageSeats(dt) {
    for (const seat of this.seats.values()) {
      if (seat.silentFor < INPUT_TIMEOUT && seat.silentFor + dt >= INPUT_TIMEOUT) {
        this._note(`${seat.name || seat.id} stopped sending; the AI is driving`);
      }
    }
    return this;
  }

  // ---------------------------------------------------------------- reporting

  /**
   * Send whatever is due. Called once per rendered frame, on simulated time.
   * @param {number} dt
   */
  update(dt) {
    if (!this.link.open || this.seats.size === 0) return this;
    const game = this.sim.game;
    if (!game) return this;

    this._snapshotTimer += dt;
    const snapshotPeriod = 1 / SNAPSHOT_HZ;
    if (this._snapshotTimer >= snapshotPeriod) {
      this._snapshotTimer %= snapshotPeriod;
      this.tick++;
      this.link.sendBinary(encodeSnapshot(buildSnapshot(game, this.tick)));
    }

    this._stateTimer += dt;
    const statePeriod = 1 / STATE_HZ;
    if (this._stateTimer >= statePeriod) {
      this._stateTimer %= statePeriod;
      // `status()` and `score()` verbatim, so there is exactly one description
      // of what a score is and the joiner's panel cannot disagree with the
      // host's about who is winning.
      this.link.sendJson({
        t: 'match',
        status: game.match.status(),
        score: game.match.score(),
      });
    }
    return this;
  }

  /** Tell the joiners the MATCH restarted, so they re-arm their own panels. */
  announceReset() {
    this.link.sendJson({ t: 'reset' });
    return this;
  }

  close() {
    this.link.close();
    for (const id of [...this.seats.keys()]) this._unseat(id);
    return this;
  }

  _note(line) {
    this.log.push(line);
    if (this.log.length > 40) this.log.shift();
  }
}
