import { obbOverlap } from '../../physics/collision.js';
import { MAX_CONTROLLED } from './constants.js';
import { foulPoints, rule } from './rules.js';

/**
 * The officiating half of a MATCH: watches the FIELD and calls the rules a
 * simulator can actually see.
 *
 * ## Why bother
 *
 * Because the fouls are where the points are. A MAJOR FOUL is 20 points and
 * the whole CELL column of the score table is 2 points an element -- so one
 * NECTAR put in a FLOWER at 1:30 undoes ten good shots, and a three-second PIN
 * costs more than an AUTO. Drivers who have never been called for anything
 * learn to drive in a way that gets called for everything, and the only way to
 * practise *not* doing that is for something to say so at the moment it
 * happens. That is this class.
 *
 * ## What it will and will not call
 *
 * `rules.js` is the full audit -- all forty Game Rules, each marked with what
 * the sim does about it. Eleven are `live` and handled here. The rest are
 * either impossible here, checked at setup, about humans, or about damage the
 * physics does not model, and every one of those says which in its own note.
 *
 * Nothing in here tries to read intent. Where the manual says "if STRATEGIC",
 * the model is Section 10.6's own test -- repetition inside one MATCH -- and
 * where even that is not available (G411, hoarding) the finding is reported to
 * the driver and never scored. A heuristic that costs 20 points teaches people
 * to avoid the heuristic.
 *
 * ## Which ALLIANCE the points go to
 *
 * Table 10-4 is careful about this and so is `Match.score`: a foul is "a credit
 * of N points towards the **opponent's** MATCH point total". Fouls are counted
 * against the ALLIANCE that committed them and the points appear on the other
 * side's score, which is not the same as a deduction -- a MAJOR FOUL cannot
 * take you below what you earned.
 *
 * @module
 */

/** Commanded duty above which a MECHANISM counts as powered (G403/G404). */
const POWERED_EFFORT = 0.05;
/**
 * How many times a "per MATCH" rule is written into the list before it stops
 * repeating itself. The count behind it keeps going; only the display stops.
 */
const REPEAT_CITATIONS = 3;
/** How long a continuous violation runs before the first citation. */
const FIRST_INSTANCE = 0.25;
/** And how much longer for each one after that. */
const SUSTAINED_INSTANCE = 2;
/** How long after the buzzer G404 is watched, before nobody cares any more. */
const BUZZER_WINDOW = 5;

/** Slack on a box-to-box test, so "touching" does not need exact contact. */
const CONTACT_MARGIN = 0.02;

/** G421: the 3-count, and the 2 ft (~61 cm) both escape clauses use. */
const PIN_SECONDS = 3;
const PIN_ESCAPE = 0.61;
/** Below this the pinned ROBOT counts as "prevented from moving". */
const PIN_HELD_SPEED = 0.18;

/**
 * G417: how hard you have to drive into the HIVE frame for it to be "ramming".
 *
 * Example A is "ramming into the HIVE frame at high-speed", which is a
 * violation, and example G is "a ROBOT accidentally bumping into a HIVE frame
 * while attempting to pick up POLLEN", which is not. So the line has to sit
 * above what a ROBOT crossing the FIELD and braking a moment late arrives at,
 * and 1.5 m/s is about two thirds of what these drivetrains will do -- clearly
 * driving *into* it rather than finding it on the way past.
 */
const RAM_SPEED = 1.5;

/** G411, advisory: what a corral looks like, and how long it has to last. */
const HOARD_COUNT = 5;
const HOARD_RADIUS = 0.55;
const HOARD_SECONDS = 5;

/**
 * How long a ROBOT's fingerprints stay on an element, in seconds (G405).
 *
 * An element that leaves the FIELD two seconds after anything last touched it
 * did not leave because of that touch. In practice the only way out is over a
 * 12 in wall, so the gap between the contact and the departure is a fraction
 * of a second -- this is here so a ROBOT that brushed a POLLEN at the start of
 * TELEOP does not still own it a minute later.
 */
const TOUCH_STALE = 2;

/**
 * @typedef {object} Citation
 * @property {string} rule
 * @property {string} title
 * @property {'red'|'blue'} alliance the ALLIANCE that committed it
 * @property {string} [robotId]
 * @property {'warning'|'strategic'|'minor'|'major'|'advisory'} penalty
 *   `strategic` is an assessed instance of a rule whose penalty is a card and
 *   no points -- G408 and G409 are the two.
 * @property {'yellow'|'red'} [card]
 * @property {number} points credited to the opposing ALLIANCE
 * @property {string} detail  what happened, in a driver's words
 * @property {number} t       MATCH clock, seconds
 */

export class Referee {
  /**
   * @param {{field: import('./BiobuzzField.js').BiobuzzField}} opts
   */
  constructor(opts) {
    this.field = opts.field;
    this.reset();
  }

  reset() {
    /** @type {Citation[]} */
    this.citations = [];
    /** Instances of each rule per ALLIANCE, `alliance:rule` -> count. */
    this._instances = new Map();
    /** Assessed (non-warning) instances, same key. */
    this._assessed = new Map();
    /** Fouls committed by each ALLIANCE. */
    this.fouls = { red: { minor: 0, major: 0 }, blue: { minor: 0, major: 0 } };
    /** @type {{red: {rule: string, card: string}[], blue: {rule: string, card: string}[]}} */
    this.cards = { red: [], blue: [] };

    this.clock = 0;
    /** Seconds since TELEOP ended, for G404's window. */
    this._sinceBuzzer = 0;
    /** Accumulators for the continuous rules, `key` -> {accum, cited}. */
    this._timers = new Map();
    /** Live PIN counts, `pinner>pinned` -> state. */
    this._pins = new Map();
    /** Robot ids currently over the control limit, so one breach is one instance. */
    this._overControl = new Set();
    /** `robotId:ballId` pairs already cited for G408. */
    this._heldOpponentNectar = new Set();
    /** Robot ids currently touching the HIVE frame, so one drive-in is one ram. */
    this._onHive = new Set();
    /**
     * Robot ids currently interfering across the centre line in AUTO, so one
     * episode of it is one instance.
     *
     * Without this the detector fired every step it stayed true: a blue ROBOT
     * leaning on a red one for eight seconds of AUTO produced five hundred
     * citations of a rule whose penalty is "MAJOR FOUL per MATCH". The score
     * was right -- charged once -- and the list was unreadable.
     */
    this._interfering = new Set();
    /** Last cumulative early-FLOWER-NECTAR counts seen, so only the delta is new. */
    this._earlySeen = { red: 0, blue: 0 };
    /** Advisory findings already reported, so each is said once. */
    this._noted = new Set();
    return this;
  }

  // ------------------------------------------------------------- assessment

  /**
   * Record one instance of a rule against an ALLIANCE, and work out what it
   * costs.
   *
   * The tiering is `rules.js`'s `assess` block and nothing else, so the penalty
   * a driver sees is the manual's own Violation line rather than a judgement
   * made here.
   *
   * @param {string} id
   * @param {'red'|'blue'} alliance
   * @param {string} detail
   * @param {{robotId?: string}} [opts]
   * @returns {Citation}
   */
  cite(id, alliance, detail, opts = {}) {
    const r = rule(id);
    const a = r.assess ?? {};
    const key = `${alliance}:${id}`;
    const n = (this._instances.get(key) ?? 0) + 1;
    this._instances.set(key, n);

    const forgiven = a.warnings ?? 0;
    /** @type {Citation} */
    const citation = {
      rule: id,
      title: r.title,
      alliance,
      robotId: opts.robotId,
      penalty: 'warning',
      points: 0,
      detail,
      t: this.clock,
    };

    if (n <= forgiven) {
      // A VERBAL WARNING costs nothing and is the point of the tier: it is the
      // sim telling you the thing you just did is the thing that gets called.
      this.citations.push(citation);
      return citation;
    }

    const assessedBefore = this._assessed.get(key) ?? 0;
    const assessed = assessedBefore + 1;
    this._assessed.set(key, assessed);

    // `per: 'match'` rules are charged once however many times they recur --
    // "MAJOR FOUL per MATCH" in the manual's own words. The later instances
    // still show up in the list, because seeing that you did it six times is
    // the useful part even when the score does not move again.
    const charge = a.per !== 'match' || assessed === 1;
    if (a.foul && charge) {
      citation.penalty = a.foul;
      citation.points = foulPoints(a.foul);
      this.fouls[alliance][a.foul] += 1;
    } else if (a.foul) {
      citation.penalty = a.foul;
      citation.detail = `${detail} (already charged this MATCH)`;
      // Seeing that you did it again is useful; seeing it thirteen times is
      // not, and the score stopped moving after the first. So the list keeps a
      // few and the instance count -- which is what decides STRATEGIC -- keeps
      // all of them.
      if (assessed > REPEAT_CITATIONS) return citation;
    } else {
      // A rule whose Violation line is a card and nothing else -- G408 and
      // G409. Past the warnings it is being read as STRATEGIC, which is worth
      // saying even on the instances that add neither points nor a second card.
      citation.penalty = 'strategic';
    }

    if (a.card && assessed > (a.cardAfter ?? 0) && !this.cards[alliance].some((c) => c.rule === id)) {
      citation.card = a.card;
      this.cards[alliance].push({ rule: id, card: a.card });
    }

    this.citations.push(citation);
    return citation;
  }

  /**
   * A finding the sim is confident enough to show and not confident enough to
   * score. Said once per MATCH per key -- see G411 in `rules.js`.
   */
  note(id, alliance, detail, key = id) {
    const tag = `${alliance}:${key}`;
    if (this._noted.has(tag)) return null;
    this._noted.add(tag);
    const r = rule(id);
    /** @type {Citation} */
    const citation = {
      rule: id,
      title: r.title,
      alliance,
      penalty: 'advisory',
      points: 0,
      detail,
      t: this.clock,
    };
    this.citations.push(citation);
    return citation;
  }

  /**
   * Points credited *to* `alliance` -- that is, the fouls the other side
   * committed. Table 10-4 defines a foul this way round, and it matters: your
   * own fouls never reduce your score, they raise theirs.
   * @param {'red'|'blue'} alliance
   */
  penaltyPoints(alliance) {
    const other = alliance === 'red' ? 'blue' : 'red';
    const f = this.fouls[other];
    return f.minor * foulPoints('minor') + f.major * foulPoints('major');
  }

  /** The last few citations, newest first, for the panel. */
  recent(limit = 6) {
    return this.citations.slice(-limit).reverse();
  }

  /**
   * The longest PIN this ROBOT is currently committing: how many seconds, and
   * on whom.
   *
   * Public because a driver can see the REFEREE counting and peels off at two,
   * and an AI that cannot is not modelling a driver -- it is modelling somebody
   * who has never been called for anything. Without it a single AI robot leaned
   * on a stationary ROBOT for half a MATCH and handed the other ALLIANCE 240
   * points, which is more than either side scored and makes the opposition
   * useless to practise against.
   *
   * @param {string} robotId
   * @returns {{seconds: number, pinned: string|null}}
   */
  worstPin(robotId) {
    let seconds = 0;
    let pinned = null;
    for (const [key, state] of this._pins) {
      if (!key.startsWith(`${robotId}>`)) continue;
      if (state.count <= seconds) continue;
      seconds = state.count;
      pinned = key.slice(robotId.length + 1);
    }
    return { seconds, pinned };
  }

  // ----------------------------------------------------------------- observe

  /**
   * Officiate one step.
   *
   * Called *before* the FIELD steps, so the ROBOT-to-ROBOT contact state it
   * works out is on the body metadata the ball physics is about to stamp onto
   * whatever it touches. Consequences of the previous step -- elements that
   * left the FIELD, catches, HIVE strikes -- are drained here, one step behind,
   * which is far finer than anything being measured.
   *
   * @param {number} dt
   * @param {{
   *   phase: string,
   *   entries: {robot: any, alliance: 'red'|'blue', id: string,
   *             driverControlled?: boolean, meta?: any}[],
   *   earlyFlowerNectar?: {red: number, blue: number},
   * }} ctx
   */
  observe(dt, ctx) {
    if (dt <= 0) return this;
    const entries = ctx.entries ?? [];
    const phase = ctx.phase;
    if (phase === 'auto' || phase === 'transition' || phase === 'teleop') this.clock += dt;
    this._sinceBuzzer = phase === 'ended' ? this._sinceBuzzer + dt : 0;

    this._markContact(entries);
    // Pre-MATCH setup is not officiated: the ROBOTS are being staged, a
    // DRIVE TEAM is loading them, and nothing that happens is a violation of
    // anything. Contact marking still runs above, so the ball world always has
    // somebody to attribute a touch to.
    if (phase === 'setup') return this;

    this._checkPowered(dt, phase, entries);
    this._checkAutoInterference(dt, phase, entries);
    this._checkControl(entries);
    this._checkDepartures();
    this._checkCatches(entries);
    this._checkEarlyNectar(ctx.earlyFlowerNectar);
    this._checkHive(entries);
    this._checkPins(dt, phase, entries);
    this._checkHoarding(dt, phase, entries);
    return this;
  }

  // -------------------------------------------------------------- detectors

  /**
   * Which ROBOTS are touching an opponent right now.
   *
   * Written onto each entry's `meta.contested`, which is the same object the
   * ball world stamps onto elements it touches -- so an element squeezed out
   * of the FIELD between two ROBOTS carries the fact that two ROBOTS were
   * involved, and G405's ROBOT-to-ROBOT exemption applies without anything
   * having to reconstruct the moment afterwards.
   */
  _markContact(entries) {
    /** @type {Map<string, Set<string>>} */
    const touching = new Map();
    for (const e of entries) {
      touching.set(e.id, new Set());
      if (e.meta) e.meta.contested = false;
    }
    for (let i = 0; i < entries.length; i++) {
      for (let j = i + 1; j < entries.length; j++) {
        const a = entries[i];
        const b = entries[j];
        if (a.alliance === b.alliance) continue;
        if (!obbOverlap(boxOf(a.robot, CONTACT_MARGIN), boxOf(b.robot))) continue;
        touching.get(a.id).add(b.id);
        touching.get(b.id).add(a.id);
        if (a.meta) a.meta.contested = true;
        if (b.meta) b.meta.contested = true;
      }
    }
    this._touching = touching;
  }

  /**
   * G401, G403, G404: the three "nobody should be driving right now" rules.
   *
   * All three test the *command*, not the motion, because all three excuse
   * movement "due to inertia, gravity, or de-energizing of actuators". A
   * ROBOT still rolling when the buzzer goes has not violated G404; one whose
   * flywheel is still commanded has.
   */
  _checkPowered(dt, phase, entries) {
    for (const entry of entries) {
      const effort = poweredEffort(entry.robot);
      const powered = effort > POWERED_EFFORT;

      // G401 is about a DRIVE TEAM touching the controls during AUTO, so it
      // only applies to a ROBOT a human is driving. An AI opponent running its
      // AUTO routine is doing exactly what it should.
      if (phase === 'auto' && entry.driverControlled) {
        for (let i = 0; i < this._sustain(`${entry.id}:G401`, dt, powered); i++) {
          this.cite('G401', entry.alliance, 'driving during AUTO', { robotId: entry.id });
        }
      }
      if (phase === 'transition') {
        for (let i = 0; i < this._sustain(`${entry.id}:G403`, dt, powered); i++) {
          this.cite('G403', entry.alliance, 'powered movement during the transition', {
            robotId: entry.id,
          });
        }
      }
      if (phase === 'ended' && this._sinceBuzzer <= BUZZER_WINDOW) {
        for (let i = 0; i < this._sustain(`${entry.id}:G404`, dt, powered); i++) {
          this.cite('G404', entry.alliance, 'powered movement after the buzzer', {
            robotId: entry.id,
          });
        }
      }
    }
  }

  /**
   * G402: "During AUTO, a team may not disrupt AUTO for the opposing ALLIANCE."
   *
   * Called on the half of it that is unambiguous: contacting an opponent ROBOT
   * while on their side of the FIELD. Crossing the centre line on its own only
   * "may be seen as STRATEGIC" by the manual's own wording, so that gets an
   * advisory note and no points.
   */
  _checkAutoInterference(dt, phase, entries) {
    if (phase !== 'auto') return;
    for (const entry of entries) {
      const x = entry.robot.body.position.x;
      // Red owns FIELD columns A-C, which is the negative-x half, so a red
      // ROBOT has crossed when x is positive. Well past the line rather than
      // touching it: straddling the middle while reaching for centre POLLEN is
      // not "navigating into the opposing ALLIANCE'S side".
      const crossed = -ownSideSign(entry.alliance) * x > entry.robot.halfLength;
      const contact = crossed && Boolean(this._touching?.get(entry.id)?.size);
      if (contact) {
        // One citation per episode: it is cited on the step the contact starts
        // and stays quiet until the ROBOTS come apart or it goes back to its
        // own side.
        if (!this._interfering.has(entry.id)) {
          this._interfering.add(entry.id);
          this.cite('G402', entry.alliance, 'contacted an opponent on their side during AUTO', {
            robotId: entry.id,
          });
        }
      } else {
        this._interfering.delete(entry.id);
        if (crossed) {
          this.note(
            'G402',
            entry.alliance,
            'crossed onto the opponent side during AUTO -- risky, and a REFEREE may read it as STRATEGIC',
            'crossed',
          );
        }
      }
    }
  }

  /**
   * G407 and G408: what a ROBOT is holding.
   *
   * CONTROL is read as ownership -- what the intake or grabber has taken -- and
   * deliberately not as contact. G407 lists bulldozing and deflecting as things
   * that are *not* CONTROL, so a ROBOT shoving a pile of POLLEN across the
   * FIELD is not controlling five of them.
   */
  _checkControl(entries) {
    for (const entry of entries) {
      const held = this._heldBy(entry.robot);

      if (held.length > MAX_CONTROLLED) {
        if (!this._overControl.has(entry.id)) {
          this._overControl.add(entry.id);
          this.cite('G407', entry.alliance, `CONTROLLED ${held.length} SCORING ELEMENTS`, {
            robotId: entry.id,
          });
        }
      } else {
        this._overControl.delete(entry.id);
      }

      for (const ball of held) {
        if (ball.kind !== 'nectar' || ball.alliance === entry.alliance) continue;
        const tag = `${entry.id}:${ball.id}`;
        if (this._heldOpponentNectar.has(tag)) continue;
        this._heldOpponentNectar.add(tag);
        this.cite('G408', entry.alliance, `CONTROLLED ${ball.alliance} NECTAR`, {
          robotId: entry.id,
        });
      }
    }
  }

  /**
   * G405: elements that left the FIELD, and whose fault that was.
   *
   * The rule exempts two of the three ways it can happen, by name -- "SCORING
   * ELEMENTS that leave the FIELD during scoring attempts or as the result of
   * ROBOT-to-ROBOT interactions are not considered deliberate ejections" -- so
   * most departures cost nothing but the element, which comes back anyway. What
   * is left is a ROBOT that carried, shoved or spat one over the wall.
   */
  _checkDepartures() {
    // `lastTouch.t` is stamped from the ball world's own clock, so the
    // staleness test has to read that clock and not the MATCH clock -- the two
    // start at different moments (the ball world runs during setup as well)
    // and comparing across them silently made this check dead.
    const now = this.field.ballWorld.clock;
    for (const ball of this.field.takeDepartures?.() ?? []) {
      const touch = ball.lastTouch;
      const label = ball.kind === 'nectar' ? `${ball.alliance} NECTAR` : 'POLLEN';
      if (!touch || now - touch.t > TOUCH_STALE) continue;
      if (touch.kind === 'launch' || touch.kind === 'launched') continue; // scoring attempt
      if (touch.contested) continue; // ROBOT-to-ROBOT
      const alliance = touch.alliance === 'red' || touch.alliance === 'blue' ? touch.alliance : null;
      if (!alliance) continue;
      this.cite('G405', alliance, `ejected a ${label} out of the FIELD`, { robotId: touch.id });
    }
  }

  /**
   * G409: catching what a TIPPED HIVE let go of.
   *
   * The flag is set by `Hive` when it releases a load and cleared by the first
   * contact with anything that is not a ROBOT, so a ROBOT touching an element
   * that still carries it is the catch. Two are forgiven, which is the rule's
   * own line: "A ROBOT drives under the HIVE and has one or two POLLEN land on
   * a flat surface of their ROBOT while driving by" is not a violation.
   */
  _checkCatches(entries) {
    const byId = new Map(entries.map((e) => [e.id, e]));
    for (const ball of this.field.ballWorld.balls) {
      const caught = ball.caughtFromTip;
      if (!caught) continue;
      ball.caughtFromTip = null;
      // One catch per element. The window stays open until the element touches
      // something that is not a ROBOT, so without this the ROBOT still holding
      // it would be cited again on every step it kept hold of it.
      ball.fromTip = null;
      const entry = byId.get(caught.id);
      const alliance = entry?.alliance ?? caught.alliance;
      if (alliance !== 'red' && alliance !== 'blue') continue;
      this.cite('G409', alliance, 'caught an element released by a TIPPED HIVE', {
        robotId: caught.id,
      });
    }
  }

  /**
   * G410: a NECTAR in a FLOWER before the last 60 seconds.
   *
   * `Match` does the detecting, because it owns the clock and the unlock; this
   * only turns its running count into MAJOR FOULS, one per NECTAR.
   */
  _checkEarlyNectar(counts) {
    if (!counts) return;
    for (const alliance of /** @type {const} */ (['red', 'blue'])) {
      const seen = counts[alliance] ?? 0;
      while (this._earlySeen[alliance] < seen) {
        this._earlySeen[alliance] += 1;
        this.cite('G410', alliance, 'entered NECTAR into a FLOWER before the last 60 seconds');
      }
    }
  }

  /**
   * G417: meddling with the HIVE.
   *
   * Two detectors, both taken straight from the rule's examples. Driving into
   * the frame above a walking pace is A and B; a LAUNCHED element from the
   * other ALLIANCE striking a HIVE is D. Missing your own CELL and clipping its
   * outside is H, which the rule says is *not* a violation, so `Hive` only
   * records hostile shots and nothing here calls it.
   */
  _checkHive(entries) {
    const frames = this.field.obstacles.filter((o) => o.id.startsWith('hive'));
    for (const entry of entries) {
      const box = boxOf(entry.robot, CONTACT_MARGIN);
      let ram = 0;
      for (const frame of frames) {
        const hit = obbOverlap(box, frame.collider());
        if (!hit) continue;
        // Closing speed along the contact normal: `obbOverlap` points it from
        // the first box toward the second, so this is speed *into* the frame.
        const v = entry.robot.body.velocity;
        ram = Math.max(ram, v.x * hit.normal.x + v.y * hit.normal.y);
      }
      if (ram > 0 || this._onHive.has(entry.id)) {
        if (ram >= RAM_SPEED && !this._onHive.has(entry.id)) {
          this.cite('G417', entry.alliance, `rammed the HIVE frame at ${ram.toFixed(1)} m/s`, {
            robotId: entry.id,
          });
        }
        if (ram > 0) this._onHive.add(entry.id);
        else this._onHive.delete(entry.id);
      }
    }

    for (const alliance of /** @type {const} */ (['red', 'blue'])) {
      for (const strike of this.field.hives[alliance].takeLaunchStrikes()) {
        const shooter =
          strike.alliance === 'red' || strike.alliance === 'blue' ? strike.alliance : null;
        if (!shooter || shooter === alliance) continue;
        this.cite('G417', shooter, `LAUNCHED an element at the ${alliance} HIVE`, {
          robotId: strike.robotId,
        });
      }
    }
  }

  /**
   * G421, the 3-count on PINS -- the longest detector here, because the rule
   * is the longest rule.
   *
   * A PIN is one ROBOT "preventing the movement of an opponent ROBOT by
   * contact", so it needs contact and a pinned ROBOT that is not going
   * anywhere. The three ways it ends and the two ways it pauses are all in the
   * rule and all here: separation of 2 ft pauses the count and ends the PIN
   * after 3 seconds of it, either ROBOT moving 2 ft from where the PIN started
   * does the same, and the pinner getting pinned ends it outright.
   */
  _checkPins(dt, phase, entries) {
    if (phase !== 'auto' && phase !== 'teleop') {
      this._pins.clear();
      return;
    }
    const byId = new Map(entries.map((e) => [e.id, e]));
    const live = new Set();

    for (const pinner of entries) {
      for (const pinnedId of this._touching?.get(pinner.id) ?? []) {
        const pinned = byId.get(pinnedId);
        if (!pinned) continue;
        const key = `${pinner.id}>${pinnedId}`;
        const holding = speedOf(pinned.robot) < PIN_HELD_SPEED;
        let state = this._pins.get(key);
        if (!state) {
          if (!holding) continue;
          state = {
            count: 0,
            separated: 0,
            displaced: 0,
            fouls: 0,
            origin: { pinner: positionOf(pinner.robot), pinned: positionOf(pinned.robot) },
          };
          this._pins.set(key, state);
        }
        live.add(key);
      }
    }

    for (const [key, state] of [...this._pins]) {
      const [pinnerId, pinnedId] = key.split('>');
      const pinner = byId.get(pinnerId);
      const pinned = byId.get(pinnedId);
      if (!pinner || !pinned) {
        this._pins.delete(key);
        continue;
      }

      // C: the PINNING ROBOT gets PINNED. Ends this count outright -- and it
      // takes a *running* count the other way round, not merely contact, or
      // every mutual shove would cancel both sides.
      if ((this._pins.get(`${pinnedId}>${pinnerId}`)?.count ?? 0) > 0) {
        this._pins.delete(key);
        continue;
      }

      const gap = boxGap(boxOf(pinner.robot), boxOf(pinned.robot));
      const movedPinner = distance(positionOf(pinner.robot), state.origin.pinner);
      const movedPinned = distance(positionOf(pinned.robot), state.origin.pinned);

      // A: the count pauses at 2 ft of separation, and the PIN ends after 3
      // seconds of it. Closing back inside 2 ft resumes the count.
      state.separated = gap >= PIN_ESCAPE ? state.separated + dt : 0;
      // B: and the same for either ROBOT having travelled 2 ft from where the
      // PIN began -- which is the clause that makes pushing somebody across
      // the FIELD legal, as long as they are going somewhere.
      const displaced = movedPinner >= PIN_ESCAPE || movedPinned >= PIN_ESCAPE;
      state.displaced = displaced ? state.displaced + dt : 0;

      if (state.separated > PIN_SECONDS || state.displaced > PIN_SECONDS) {
        this._pins.delete(key);
        continue;
      }

      const contact = live.has(key);
      const holding = speedOf(pinned.robot) < PIN_HELD_SPEED;
      const paused = gap >= PIN_ESCAPE || displaced || !contact || !holding;
      if (paused) continue;

      state.count += dt;
      // "MAJOR FOUL per instance and an additional MAJOR FOUL for every 3
      // seconds in which the situation is not corrected."
      const due = Math.floor(state.count / PIN_SECONDS);
      while (state.fouls < due) {
        state.fouls += 1;
        this.cite(
          'G421',
          pinner.alliance,
          `PINNED ${pinned.id} for ${(state.fouls * PIN_SECONDS).toFixed(0)} seconds`,
          { robotId: pinner.id },
        );
      }
    }
  }

  /**
   * G411, advisory: a ROBOT parked on a pile.
   *
   * Never scored -- see the rule's note in `rules.js`. The detector wants a
   * ROBOT that is *stopped* with a cluster around it for several seconds,
   * because collecting from a GARDEN means driving through a legitimate cluster
   * and this has to stay quiet for that.
   */
  _checkHoarding(dt, phase, entries) {
    if (phase !== 'teleop') return;
    for (const entry of entries) {
      const key = `${entry.id}:G411`;
      const at = positionOf(entry.robot);
      let near = 0;
      for (const ball of this.field.ballWorld.balls) {
        if (!ball.free || ball.outOfBounds) continue;
        if (Math.hypot(ball.x - at.x, ball.y - at.y) <= HOARD_RADIUS) near += 1;
      }
      const parked = speedOf(entry.robot) < PIN_HELD_SPEED;
      const active = parked && near >= HOARD_COUNT;
      let timer = this._timers.get(key);
      if (!timer) {
        timer = { accum: 0, cited: 0 };
        this._timers.set(key, timer);
      }
      timer.accum = active ? timer.accum + dt : 0;
      if (timer.accum >= HOARD_SECONDS) {
        timer.accum = 0;
        this.note(
          'G411',
          entry.alliance,
          `sat on ${near} SCORING ELEMENTS for ${HOARD_SECONDS} seconds -- a REFEREE may call this corralling`,
          entry.id,
        );
      }
    }
  }

  // ----------------------------------------------------------------- helpers

  /**
   * Accumulate a continuous violation and report how many fresh instances it
   * has earned: one at `FIRST_INSTANCE` and another every `SUSTAINED_INSTANCE`
   * after that.
   *
   * The accumulator is never reset, only paused, because these rules are per
   * MATCH: letting go of the sticks and grabbing them again during the same
   * transition period is not a clean slate.
   */
  _sustain(key, dt, active) {
    let timer = this._timers.get(key);
    if (!timer) {
      timer = { accum: 0, cited: 0 };
      this._timers.set(key, timer);
    }
    if (!active) return 0;
    timer.accum += dt;
    let fired = 0;
    while (timer.accum >= FIRST_INSTANCE + SUSTAINED_INSTANCE * timer.cited) {
      timer.cited += 1;
      fired += 1;
    }
    return fired;
  }

  /** Elements this ROBOT has taken ownership of. */
  _heldBy(robot) {
    const out = [];
    for (const ball of this.field.ballWorld.balls) {
      const ref = ball.container?.ref;
      if (ref && typeof ref === 'object' && ref.robot === robot) out.push(ball);
    }
    return out;
  }

  /** Everything called so far, for the panel and for tests. */
  summary() {
    return {
      fouls: { red: { ...this.fouls.red }, blue: { ...this.fouls.blue } },
      points: { red: this.penaltyPoints('red'), blue: this.penaltyPoints('blue') },
      cards: { red: [...this.cards.red], blue: [...this.cards.blue] },
      citations: this.citations.length,
    };
  }
}

// ------------------------------------------------------------------ geometry

/**
 * Which way its own half of the FIELD lies for an ALLIANCE: -1 for red, whose
 * columns A-C are the negative-x half, and +1 for blue.
 */
function ownSideSign(alliance) {
  return alliance === 'red' ? -1 : 1;
}

/** The oriented box the collision routines want, optionally grown by `margin`. */
function boxOf(robot, margin = 0) {
  const body = robot.body;
  return {
    centre: body.position,
    halfLength: robot.halfLength + margin,
    halfWidth: robot.halfWidth + margin,
    cos: body.rotation.cos,
    sin: body.rotation.sin,
  };
}

/** How far a box reaches along a unit direction. */
function support(box, ux, uy) {
  return (
    box.halfLength * Math.abs(ux * box.cos + uy * box.sin) +
    box.halfWidth * Math.abs(-ux * box.sin + uy * box.cos)
  );
}

/**
 * Gap between two boxes along the line of their centres, negative when they
 * overlap.
 *
 * G421's escape clauses are written in terms of how far apart the ROBOTS are,
 * and centre-to-centre would call two 18 in ROBOTS bumper to bumper "18 inches
 * apart" -- past half the 2 ft threshold before they have moved at all.
 */
function boxGap(a, b) {
  const dx = b.centre.x - a.centre.x;
  const dy = b.centre.y - a.centre.y;
  const d = Math.hypot(dx, dy);
  if (d < 1e-9) return -(a.halfLength + b.halfLength);
  return d - support(a, dx / d, dy / d) - support(b, dx / d, dy / d);
}

function positionOf(robot) {
  return { x: robot.body.position.x, y: robot.body.position.y };
}

function speedOf(robot) {
  const v = robot.body.velocity;
  return Math.hypot(v.x, v.y);
}

function distance(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/**
 * How hard a ROBOT is being commanded overall: the drivetrain, or any
 * mechanism on it.
 *
 * The maximum rather than the sum, because G403 and G404 ask whether there is
 * *any* powered movement, not how much.
 */
function poweredEffort(robot) {
  let out = robot.drivetrain?.commandedEffort ?? 0;
  for (const sub of robot.subsystems ?? []) {
    const effort = sub.commandedEffort ?? 0;
    if (effort > out) out = effort;
  }
  return out;
}
