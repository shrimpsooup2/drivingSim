import {
  AUTO_SECONDS,
  FIELD_INNER_HALF,
  FLOWER_SCORING_BOTTOM,
  FLOWER_SCORING_TOP,
  FLOWER_UNLOCK_REMAINING,
  POINTS,
  RP_THRESHOLDS,
  TELEOP_SECONDS,
  TRANSITION_SECONDS,
} from './constants.js';

/** @typedef {'setup'|'auto'|'transition'|'teleop'|'ended'} Phase */

/** How close a robot must be to a wall to count as contacting it. */
const WALL_TOUCH_EPSILON = 0.01;

/**
 * One BIOBUZZ MATCH: the clock, the phase, and the whole score.
 *
 * Section 10.1: "pre-MATCH setup, a 30-second AUTO period, an 8-second
 * transition period between AUTO and TELEOP, and a 2-minute TELEOP period,
 * followed by the post-MATCH reset."
 *
 * ## What is worth knowing as a driver
 *
 * Two things in the point table only resolve at the buzzer, and both can be
 * taken off you in the last seconds:
 *
 *  - elements left in an upward CELL score 2 each, so a HIVE that tips at
 *    0:01 hands its contents back to the floor;
 *  - a FLOWER pays its owner 2 for *every* element in it, and the owner is
 *    whoever's NECTAR is top-most. A tube one ALLIANCE spent the MATCH filling
 *    goes to whoever drops the last NECTAR in it.
 *
 * So the running score during TELEOP is not the final score, and this class
 * reports both.
 */
export class Match {
  /**
   * @param {{
   *   field: import('./BiobuzzField.js').BiobuzzField,
   *   robots?: {robot: import('../../robot/Robot.js').Robot, alliance: 'red'|'blue', id?: string}[],
   *   autoSeconds?: number,
   *   transitionSeconds?: number,
   *   teleopSeconds?: number,
   *   flowerUnlockRemaining?: number,
   * }} opts
   */
  constructor(opts) {
    this.field = opts.field;
    this.autoSeconds = opts.autoSeconds ?? AUTO_SECONDS;
    this.transitionSeconds = opts.transitionSeconds ?? TRANSITION_SECONDS;
    this.teleopSeconds = opts.teleopSeconds ?? TELEOP_SECONDS;
    /** When G410 lifts, in seconds left in TELEOP. */
    this.flowerUnlockRemaining = opts.flowerUnlockRemaining ?? FLOWER_UNLOCK_REMAINING;

    /** @type {{robot: any, alliance: 'red'|'blue', id: string}[]} */
    this.entries = [];
    for (const entry of opts.robots ?? []) this.addRobot(entry);

    this.reset();
  }

  /**
   * @param {{robot: any, alliance: 'red'|'blue', id?: string}} entry
   */
  addRobot(entry) {
    const id = entry.id ?? `${entry.alliance}${this.entries.length + 1}`;
    this.entries.push({ robot: entry.robot, alliance: entry.alliance, id });
    this._robotState ??= new Map();
    this._robotState.set(id, {
      left: false,
      startedOnWall: false,
      parkedAuto: false,
      parkedTeleop: false,
    });
    return id;
  }

  reset() {
    /** @type {Phase} */
    this.phase = 'setup';
    /** Seconds elapsed in the current phase. */
    this.phaseClock = 0;
    /** Seconds elapsed since AUTO began. */
    this.matchClock = 0;

    this.tips = { red: 0, blue: 0 };
    this.autoTips = { red: 0, blue: 0 };
    this.flowerUnlocked = false;
    /**
     * G410: NECTAR may not enter a FLOWER's scoring volume before the last 60
     * seconds. An early one still scores but is a violation, so it is recorded
     * rather than prevented -- the same way a REFEREE would handle it.
     */
    this.earlyFlowerNectar = { red: 0, blue: 0 };
    this._seenInFlower = new Set();

    this._robotState ??= new Map();
    for (const entry of this.entries) {
      this._robotState.set(entry.id, {
        left: false,
        startedOnWall: false,
        parkedAuto: false,
        parkedTeleop: false,
      });
    }

    this.field.setup();
    return this;
  }

  /**
   * Change the periods without disturbing a MATCH in progress.
   *
   * Takes effect immediately, which is the useful behaviour: dragging TELEOP
   * down to 30 seconds mid-match ends it almost at once, and dragging the
   * FLOWER unlock up opens them there and then. The phase clock is left alone
   * -- rewinding it would be a different feature, and a confusing one.
   *
   * @param {{autoSeconds?: number, transitionSeconds?: number,
   *          teleopSeconds?: number, flowerUnlockRemaining?: number}} periods
   */
  setPeriods(periods = {}) {
    if (periods.autoSeconds !== undefined) this.autoSeconds = Math.max(0, periods.autoSeconds);
    if (periods.transitionSeconds !== undefined) {
      this.transitionSeconds = Math.max(0, periods.transitionSeconds);
    }
    if (periods.teleopSeconds !== undefined) {
      this.teleopSeconds = Math.max(0, periods.teleopSeconds);
    }
    if (periods.flowerUnlockRemaining !== undefined) {
      this.flowerUnlockRemaining = Math.max(0, periods.flowerUnlockRemaining);
    }
    return this;
  }

  /**
   * Begin the MATCH.
   *
   * @param {{phase?: 'auto'|'teleop'}} [opts] `phase: 'teleop'` starts on the
   *   sticks, skipping AUTO. The AUTO period is treated as having happened with
   *   nothing moving, so LEAVE and AUTO PARK go unscored rather than being
   *   silently awarded -- which is also what the score would read after a
   *   do-nothing AUTO.
   */
  start(opts = {}) {
    this.phase = opts.phase === 'teleop' ? 'teleop' : 'auto';
    this.phaseClock = 0;
    this.matchClock = this.phase === 'teleop' ? this.autoSeconds + this.transitionSeconds : 0;
    // LEAVE means moving off the wall, so note who was on it to begin with.
    // G304.C requires every ROBOT to start touching the perimeter; one staged
    // illegally off the wall has not "left" anything and earns nothing.
    for (const entry of this.entries) {
      this._robotState.get(entry.id).startedOnWall = this.touchingWall(entry.robot);
    }
    return this;
  }

  get running() {
    return this.phase === 'auto' || this.phase === 'transition' || this.phase === 'teleop';
  }

  get inAuto() {
    return this.phase === 'auto';
  }

  /** Whether ROBOTS are under driver control right now. */
  get driverControl() {
    return this.phase === 'teleop';
  }

  /** Length of the current period, or 0 outside one. */
  get phaseDuration() {
    if (this.phase === 'auto') return this.autoSeconds;
    if (this.phase === 'transition') return this.transitionSeconds;
    if (this.phase === 'teleop') return this.teleopSeconds;
    return 0;
  }

  /** Seconds left in the current period, never negative. */
  get phaseRemaining() {
    return Math.max(0, this.phaseDuration - this.phaseClock);
  }

  /**
   * Seconds left in TELEOP, which is the clock a DRIVE TEAM actually watches.
   * Before TELEOP it reads the full period.
   */
  get teleopRemaining() {
    if (this.phase === 'teleop') return Math.max(0, this.teleopSeconds - this.phaseClock);
    if (this.phase === 'ended') return 0;
    return this.teleopSeconds;
  }

  /** Total MATCH length, for a progress bar. */
  get totalSeconds() {
    return this.autoSeconds + this.transitionSeconds + this.teleopSeconds;
  }

  /**
   * Advance the MATCH.
   * @param {number} dt seconds
   * @param {{bodies?: any[]}} [opts] passed through to the field
   */
  update(dt, opts = {}) {
    if (!this.running) {
      this.field.update(dt, { inAuto: false, bodies: opts.bodies });
      return this;
    }

    this.phaseClock += dt;
    this.matchClock += dt;

    const tipped = this.field.update(dt, { inAuto: this.inAuto, bodies: opts.bodies });
    for (const alliance of ['red', 'blue']) {
      if (!tipped[alliance]) continue;
      this.tips[alliance] += tipped[alliance];
      if (this.inAuto) this.autoTips[alliance] += tipped[alliance];
      // Section 10.1: each TIP releases one NECTAR to the DRIVE TEAM.
      this.field.unlockNectar(alliance, tipped[alliance]);
    }

    this._trackRobots();
    this._checkFlowerLock();

    // Carry the overflow into the next period so a coarse dt cannot shorten
    // the MATCH by a fraction of a step each phase.
    while (this.running && this.phaseClock >= this.phaseDuration) {
      // `phaseRemaining` is clamped at zero, so take the overshoot from the
      // clock itself -- otherwise every period loses up to one step and a
      // coarse dt shortens the MATCH.
      const overflow = this.phaseClock - this.phaseDuration;
      this._advancePhase();
      if (this.running) this.phaseClock = overflow;
    }
    return this;
  }

  _advancePhase() {
    if (this.phase === 'auto') {
      // PARK is judged where the ROBOT is when the period ends.
      this._scorePark('parkedAuto');
      this.phase = 'transition';
      this.phaseClock = 0;
    } else if (this.phase === 'transition') {
      this.phase = 'teleop';
      this.phaseClock = 0;
    } else if (this.phase === 'teleop') {
      this._scorePark('parkedTeleop');
      this.phase = 'ended';
      this.phaseClock = 0;
    }
  }

  /**
   * True when any part of the ROBOT is touching the perimeter wall.
   * Section 10.5.4: LEAVE is earned by no longer contacting it.
   */
  touchingWall(robot) {
    const { position, rotation } = robot.body;
    const c = Math.abs(rotation.cos);
    const s = Math.abs(rotation.sin);
    const ex = robot.halfLength * c + robot.halfWidth * s;
    const ey = robot.halfLength * s + robot.halfWidth * c;
    const limit = FIELD_INNER_HALF - WALL_TOUCH_EPSILON;
    return (
      position.x + ex >= limit ||
      position.x - ex <= -limit ||
      position.y + ey >= limit ||
      position.y - ey <= -limit
    );
  }

  /** Whether a ROBOT is at least partially in its own LOADING ZONE. */
  parked(robot, alliance) {
    const zone =
      alliance === 'red' ? this.field.zones.redLoading : this.field.zones.blueLoading;
    const { position, rotation } = robot.body;
    return zone.overlapsBox(
      position.x,
      position.y,
      Math.atan2(rotation.sin, rotation.cos),
      robot.halfLength,
      robot.halfWidth,
    );
  }

  _trackRobots() {
    // LEAVE is an AUTO achievement only (Table 10-2 has no TELEOP column for it).
    if (!this.inAuto) return;
    for (const entry of this.entries) {
      const state = this._robotState.get(entry.id);
      if (!state.left && state.startedOnWall && !this.touchingWall(entry.robot)) {
        state.left = true;
      }
    }
  }

  _scorePark(key) {
    for (const entry of this.entries) {
      const state = this._robotState.get(entry.id);
      state[key] = this.parked(entry.robot, entry.alliance);
    }
  }

  /**
   * G410: "ROBOTS may not cause NECTAR to enter the FLOWER scoring volume until
   * the last 60 seconds of the MATCH." Counted, not blocked -- the achievement
   * still scores and the ALLIANCE takes the violation.
   */
  _checkFlowerLock() {
    if (this.phase === 'teleop' && this.teleopRemaining <= this.flowerUnlockRemaining) {
      if (!this.flowerUnlocked) {
        this.flowerUnlocked = true;
        // Section 10.1: "With 60 seconds left in the MATCH, ALLIANCES can
        // enter all remaining NECTAR." The per-TIP release was wired up and
        // this half of the same sentence was not, so an ALLIANCE that never
        // TIPPED could not enter a single NECTAR all MATCH -- and with no
        // NECTAR on the FIELD no FLOWER can be owned, because ownership is the
        // top-most NECTAR and POLLEN confers none. A third of the point table
        // was unreachable.
        for (const alliance of ['red', 'blue']) this.field.unlockNectar(alliance, 'all');
      }
      return;
    }
    for (const flower of this.field.flowers) {
      for (const ball of flower.scoringElements()) {
        if (ball.kind !== 'nectar' || this._seenInFlower.has(ball.id)) continue;
        this._seenInFlower.add(ball.id);
        this.earlyFlowerNectar[ball.alliance] += 1;
      }
    }
  }

  /** Robot-derived points, per Section 10.5.4 and Table 10-2. */
  robotScore() {
    const out = {
      red: { leave: 0, parkAuto: 0, parkTeleop: 0, total: 0 },
      blue: { leave: 0, parkAuto: 0, parkTeleop: 0, total: 0 },
    };
    for (const entry of this.entries) {
      const state = this._robotState.get(entry.id);
      const side = out[entry.alliance];
      if (state.left) side.leave += POINTS.leaveAuto;
      if (state.parkedAuto) side.parkAuto += POINTS.parkAuto;
      if (state.parkedTeleop) side.parkTeleop += POINTS.parkTeleop;
    }
    for (const alliance of ['red', 'blue']) {
      const side = out[alliance];
      side.total = side.leave + side.parkAuto + side.parkTeleop;
    }
    return out;
  }

  /**
   * The full score.
   *
   * `flower` and `cell` are only meaningful once everything has come to rest,
   * so during play they read as the score *if the MATCH ended now* -- which is
   * the number a driver wants during the endgame anyway.
   */
  score() {
    const fieldScore = this.field.fieldScore();
    const robots = this.robotScore();

    /** @type {any} */
    const out = { red: {}, blue: {} };
    for (const alliance of ['red', 'blue']) {
      const f = fieldScore[alliance];
      const r = robots[alliance];
      const tipPoints =
        this.autoTips[alliance] * POINTS.hiveTipAuto +
        (this.tips[alliance] - this.autoTips[alliance]) * POINTS.hiveTipTeleop;

      out[alliance] = {
        leave: r.leave,
        parkAuto: r.parkAuto,
        parkTeleop: r.parkTeleop,
        tips: this.tips[alliance],
        autoTips: this.autoTips[alliance],
        tipPoints,
        cell: f.cell,
        flower: f.flower,
        bottomNectar: f.bottomNectar,
        garden: f.garden,
        earlyFlowerNectar: this.earlyFlowerNectar[alliance],
        total: r.total + tipPoints + f.cell + f.flower + f.bottomNectar + f.garden,
      };
    }

    // RANKING POINTS, Table 10-2 and 10-3.
    for (const alliance of ['red', 'blue']) {
      const side = out[alliance];
      const other = alliance === 'red' ? out.blue : out.red;
      const swarmPoints = side.leave + side.parkAuto + side.parkTeleop;
      side.swarmPoints = swarmPoints;
      side.rp = {
        swarm: swarmPoints >= RP_THRESHOLDS.swarmPoints ? 1 : 0,
        pollinator1: side.tips >= RP_THRESHOLDS.pollinator1Tips ? 1 : 0,
        pollinator2: side.tips >= RP_THRESHOLDS.pollinator2Tips ? 1 : 0,
        result: 0,
      };
      if (this.phase === 'ended') {
        side.rp.result =
          side.total > other.total ? POINTS.win : side.total === other.total ? POINTS.tie : 0;
      }
      side.rp.total =
        side.rp.swarm + side.rp.pollinator1 + side.rp.pollinator2 + side.rp.result;
    }

    out.winner =
      this.phase !== 'ended'
        ? null
        : out.red.total > out.blue.total
          ? 'red'
          : out.blue.total > out.red.total
            ? 'blue'
            : 'tie';
    return out;
  }

  /**
   * Whether a ROBOT is legally staged per G304: on its own side, touching the
   * wall, clear of the FLOWERS and out of the LOADING ZONE.
   *
   * @param {any} robot
   * @param {'red'|'blue'} alliance
   * @returns {{legal: boolean, reasons: string[]}}
   */
  checkStartingPosition(robot, alliance) {
    const reasons = [];
    const { position, rotation } = robot.body;
    const c = Math.abs(rotation.cos);
    const s = Math.abs(rotation.sin);
    const ex = robot.halfLength * c + robot.halfWidth * s;
    const ey = robot.halfLength * s + robot.halfWidth * c;

    // A: fully on its own side (FIELD columns A-C for red, D-F for blue).
    const sign = alliance === 'red' ? -1 : 1;
    if (sign * (position.x - sign * ex) < 0) {
      reasons.push('G304.A: not fully on its own ALLIANCE side');
    }
    // A: and inside the perimeter, not overhanging it.
    if (
      Math.abs(position.x) + ex > FIELD_INNER_HALF ||
      Math.abs(position.y) + ey > FIELD_INNER_HALF
    ) {
      reasons.push('G304.A: overhanging the FIELD perimeter wall');
    }
    // C: touching the wall.
    if (!this.touchingWall(robot)) reasons.push('G304.C: not touching the perimeter wall');
    // D: clear of every FLOWER.
    for (const flower of this.field.flowers) {
      const dx = Math.abs(flower.x - position.x);
      const dy = Math.abs(flower.y - position.y);
      if (dx <= ex + flower.tubeRadius && dy <= ey + flower.tubeRadius) {
        reasons.push(`G304.D: contacting ${flower.id}`);
        break;
      }
    }
    // E: not in the LOADING ZONE.
    if (this.parked(robot, alliance)) reasons.push('G304.E: in the LOADING ZONE');

    return { legal: reasons.length === 0, reasons };
  }

  /** A compact summary for the HUD. */
  status() {
    return {
      phase: this.phase,
      phaseRemaining: this.phaseRemaining,
      teleopRemaining: this.teleopRemaining,
      matchClock: this.matchClock,
      flowerUnlocked: this.flowerUnlocked,
      nectarAvailable: {
        red: this.field.nectarAvailable('red'),
        blue: this.field.nectarAvailable('blue'),
      },
      scoringVolume: { bottom: FLOWER_SCORING_BOTTOM, top: FLOWER_SCORING_TOP },
    };
  }
}
