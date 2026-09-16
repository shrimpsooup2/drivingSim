import { BiobuzzField } from '../field/biobuzz/BiobuzzField.js';
import { Match } from '../field/biobuzz/Match.js';
import { Intake } from '../robot/biobuzz/Intake.js';
import { Launcher } from '../robot/biobuzz/Launcher.js';
import { Thrower } from '../robot/biobuzz/Thrower.js';
import { FIELD_INNER_HALF, POLLEN_RADIUS } from '../field/biobuzz/constants.js';
import { INCH } from '../math/MathUtil.js';
import { buildRoster } from '../ai/roster.js';
import { playerLaunchOptions } from '../robot/biobuzz/launchSystems.js';
import { defaultConfig } from '../config/schema.js';

/** The mechanism classes, handed to `Opponent` so the AI layer stays game-free. */
const MECHANISMS = { Intake, Launcher, Thrower };

const INCH_TO_M = INCH;

/**
 * Candidate distances along an ALLIANCE wall to stage a ROBOT, in inches,
 * signed outward from the field centre toward the audience. Red's LOADING ZONE
 * sits on the rear half of its wall and the wall's FLOWER at 23.39 in on the
 * audience half, so the gap between them and the far corner are the openings.
 */
const STAGING_OFFSETS = [0, -48, -12, 12, 58];

/** Pause at the buzzer before an auto-restart, so the final score is readable. */
const RESTART_DELAY = 3;

/** How often an AI DRIVE TEAM rolls another NECTAR onto the FIELD. */
const NECTAR_ENTRY_INTERVAL = 4;

/**
 * Schema defaults, read once. `playerLaunchOptions` compares against these to
 * decide which shooter settings are overrides and which to leave to the chosen
 * launch system.
 */
const SCHEMA_DEFAULTS = defaultConfig();

/**
 * A stable fingerprint of the roster settings.
 *
 * The *settings*, not the resolved line-up: a slot left on Random must compare
 * equal to itself, or every unrelated settings change would re-roll it and the
 * ROBOTS would swap identity mid-MATCH.
 */
function rosterSignature(ai) {
  if (!ai) return 'none';
  if (!ai.enabled) return 'off';
  return ['partner', 'opponent1', 'opponent2']
    .map((slot) => {
      const s = ai[slot] ?? {};
      return `${slot}:${s.enabled === false ? 'off' : `${s.archetype}/${s.quality}/${s.skill}`}`;
    })
    .join('|');
}

/**
 * Used when there is no config store -- a bare `new BiobuzzGame(sim)` in a
 * test. The numbers are the manual's, so a game built without settings is the
 * game the manual describes.
 */
const DEFAULT_MATCH_SETTINGS = {
  alliance: 'red',
  launchSystem: 'flywheel',
  startPhase: 'auto',
  autoRestart: false,
  aiDriveTeam: true,
  sortElements: true,
  autoSeconds: undefined,
  transitionSeconds: undefined,
  teleopSeconds: undefined,
  flowerUnlockRemaining: undefined,
  moveTolerance: 0.35,
};

/**
 * Puts BIOBUZZ on the simulator: the field, a MATCH, and a mechanism set on
 * every ROBOT taking part.
 *
 * Kept separate from `Simulation` on purpose. The simulator existed before the
 * game did and still has to work without it -- the drills, the free-driving
 * mode and the AI opponents all run on a bare field. So this attaches to a
 * running simulation and detaches cleanly, rather than the game becoming a
 * thing the simulator cannot be built without.
 */
export class BiobuzzGame {
  /**
   * @param {import('./Simulation.js').Simulation} sim
   * @param {{alliance?: 'red'|'blue'}} [opts]
   */
  constructor(sim, opts = {}) {
    this.sim = sim;
    /**
     * Match settings, read from the config store so the settings panel drives
     * them. `opts` still wins, because tests and the drills want to say
     * "red, full match" without touching the user's saved config.
     */
    this.settings = { ...DEFAULT_MATCH_SETTINGS, ...(sim.config?.match ?? {}), ...opts };
    this.alliance = this.settings.alliance === 'blue' ? 'blue' : 'red';

    /** Seconds since the MATCH ended, for the optional auto-restart. */
    this._endedFor = 0;
    /** Countdown to the opposing DRIVE TEAM handing in their next NECTAR. */
    this._nectarTimer = NECTAR_ENTRY_INTERVAL;

    this.field = new BiobuzzField({ field: sim.field });

    /**
     * Mechanisms on the player's robot.
     *
     * The launch system is a setting, because a team practising with a
     * catapult should be practising with a catapult -- the rhythm of a fixed
     * reset is nothing like the rhythm of waiting for a wheel, and drilling the
     * wrong one is worse than not drilling.
     */
    const launch = playerLaunchOptions(sim.config, SCHEMA_DEFAULTS);
    this.intake = sim.robot.addSubsystem(new Intake());
    this.launcher = sim.robot.addSubsystem(
      launch.thrower ? new Thrower(launch.options) : new Launcher(launch.options),
    );
    /** The launcher signature, so a changed shooter setting rebuilds it. */
    this._launchSignature = JSON.stringify(launch);
    this.intake.ballWorld = this.field.ballWorld;
    this.intake.flowers = this.field.flowers;
    this.launcher.ballWorld = this.field.ballWorld;
    this.launcher.intake = this.intake;

    /** Opponents this game put on the FIELD, and will take back off. */
    this.rosterOpponents = [];

    /** @type {{robot: any, alliance: 'red'|'blue', id: string, intake: Intake, opponent?: any}[]} */
    this.participants = [
      { robot: sim.robot, alliance: this.alliance, id: 'player', intake: this.intake },
    ];
    // Filled in below, once the MATCH exists to hand out identities.
    /** @type {any} */
    this._playerEntry = this.participants[0];

    this.match = new Match({
      field: this.field,
      robots: [
        { robot: sim.robot, alliance: this.alliance, id: 'player', driverControlled: true },
      ],
      autoSeconds: this.settings.autoSeconds,
      transitionSeconds: this.settings.transitionSeconds,
      teleopSeconds: this.settings.teleopSeconds,
      flowerUnlockRemaining: this.settings.flowerUnlockRemaining,
    });

    // The player's mechanisms need their rules identity too, so a LAUNCHED
    // element carries "this was a scoring attempt by the red ROBOT" and G405
    // can exempt it.
    this._playerEntry.meta = this.match.robotMeta('player');
    this.intake.owner = this._playerEntry.meta;
    this.intake.sortByAlliance = this.settings.sortElements !== false;
    this.launcher.owner = this._playerEntry.meta;

    this.fillRoster();
    this.attachOpponents();
    this.stageRobots();
  }

  /**
   * Put the other three ROBOTS on the FIELD, as the roster settings describe
   * them.
   *
   * Only ones this game created are tracked as its own, so switching the game
   * off puts the FIELD back exactly as it was -- opponents somebody added by
   * hand, or a drill placed, are theirs and stay.
   */
  fillRoster() {
    this._rosterSignature = rosterSignature(this.sim.config?.ai);
    if (!this.sim.config?.ai?.enabled) return this;
    const roster = buildRoster(
      this.sim.config.ai,
      this.alliance,
      this.sim.random ?? undefined,
    );
    for (const entry of roster) {
      const opponent = this.sim.addOpponent({
        id: entry.id,
        archetypeId: entry.archetypeId,
        qualityId: entry.qualityId,
        skillId: entry.skillId,
        alliance: entry.alliance,
        behavior: entry.behavior,
        // Staged properly by `stageRobots` once it is in `participants`; this
        // is only somewhere legal to exist until then.
        start: { x: 0, y: 0, heading: 0 },
      });
      opponent._rosterSlot = entry.slot;
      this.rosterOpponents.push(opponent);
    }
    return this;
  }

  /**
   * Give every AI opponent the mechanisms its archetype has, and enter it in
   * the MATCH.
   *
   * An opponent that cannot touch a SCORING ELEMENT is not an opponent in this
   * game, only an obstacle -- so even one without an archetype (a drill's
   * chassis-only robot) gets a plain intake, which is enough for it to shove
   * POLLEN around and be in the way.
   */
  attachOpponents() {
    for (const opponent of this.sim.opponents) {
      if (opponent._biobuzz) continue;
      // Opponents carry no alliance of their own, so anything without one is
      // put on the other side -- which is what an opponent is for.
      const alliance = opponent.alliance ?? (this.alliance === 'red' ? 'blue' : 'red');
      opponent.alliance = alliance;

      let intake = null;
      let launcher = null;
      const hasArchetype = Boolean(opponent.archetype);
      if (opponent.buildMechanisms) {
        ({ intake, launcher } = opponent.buildMechanisms(MECHANISMS));
      }
      if (!intake && !hasArchetype) {
        // A drill's chassis-only robot: give it a plain intake so it can at
        // least shove POLLEN around. An *archetype* with no intake is a
        // pushbot, and giving that one anyway would quietly undo the choice.
        intake = opponent.robot.addSubsystem(new Intake());
        opponent.intake = intake;
      }
      if (intake) {
        intake.ballWorld = this.field.ballWorld;
        intake.flowers = this.field.flowers;
        // An automated placing routine must not dump on the tiles when it
        // slips out of alignment: it aborts the lift and keeps the element.
        intake.placeOnly = opponent.role === 'flowerFiller';
      }
      if (launcher) launcher.ballWorld = this.field.ballWorld;

      opponent._biobuzz = { intake, launcher };
      const id = this.match.addRobot({ robot: opponent.robot, alliance });
      const meta = this.match.robotMeta(id);
      // The MATCH assigns its own ids, and they are what the REFEREE's records
      // are keyed on -- so an AI that wants to know whether it is being counted
      // for a PIN needs the one the MATCH gave it, not the one it was created
      // with.
      opponent.matchId = id;
      if (intake) {
        intake.owner = meta;
        intake.sortByAlliance = this.settings.sortElements !== false;
      }
      if (launcher) launcher.owner = meta;
      this.participants.push({ robot: opponent.robot, alliance, id, intake, opponent, meta });
    }
    return this;
  }

  /**
   * Put each ROBOT in a legal G304 start: on its own side, against a wall,
   * clear of the FLOWERS and out of the LOADING ZONE.
   */
  stageRobots() {
    const perAlliance = { red: 0, blue: 0 };
    for (const entry of this.participants) {
      const robot = entry.robot;
      const sign = entry.alliance === 'red' ? -1 : 1;
      const heading = entry.alliance === 'red' ? 0 : Math.PI;
      const x = sign * (FIELD_INNER_HALF - robot.halfLength - 1e-4);
      const slot = perAlliance[entry.alliance]++;

      // Along its own wall there are only a few legal spots: clear of the
      // LOADING ZONE, clear of that wall's FLOWER, and inside the perimeter.
      // Try the candidates in order and keep the first G304 says is legal,
      // rather than hard-coding a number that a geometry change would break.
      const candidates = STAGING_OFFSETS.map((v) => sign * v * INCH_TO_M);
      let placed = false;
      for (let i = 0; i < candidates.length && !placed; i++) {
        const y = candidates[(slot + i) % candidates.length];
        robot.reset(x, y, heading);
        robot.body.velocity.set(0, 0);
        robot.body.angularVelocity = 0;
        placed = this.match.checkStartingPosition(robot, entry.alliance).legal;
      }
      if (!placed) {
        // Nothing legal: leave it on the wall anyway rather than nowhere, and
        // let the caller see the violation through checkStartingPosition.
        robot.reset(x, candidates[0], heading);
        robot.body.velocity.set(0, 0);
        robot.body.angularVelocity = 0;
      }
    }
    return this;
  }

  /**
   * Hand each ROBOT its four pre-load POLLEN (Section 10.3.1).
   *
   * A ROBOT with no intake -- a pushbot -- cannot hold them, so its four stay
   * where they are. Section 10.3.1.A.iv allows a pre-load, it does not require
   * one, and a kit chassis with nothing on it has nowhere to put a POLLEN.
   */
  loadPreloads() {
    const groups = this.field.preloadGroups;
    const taken = new Set();
    this.participants.forEach((entry, i) => {
      const group = groups[i];
      if (!group || !entry.intake) return;
      taken.add(i);
      entry.intake.held.length = 0;
      entry.intake.capacity = Math.max(entry.intake.capacity, group.length);
      for (const ball of group) entry.intake.give(ball);
    });

    // Every group that has no ROBOT to sit in still belongs on the FIELD.
    //
    // Section 10.3.1: "ROBOTS that are not present for their MATCH will have
    // their pre-load POLLEN placed in approximately the center of the LOADING
    // ZONE against the perimeter wall." They were simply left in limbo
    // instead, which quietly removed them from play -- and since the roster is
    // off by default, that was *twelve* of the forty POLLEN missing from every
    // practice session. A pushbot's four go the same way: it is present, but
    // it has nowhere to put them.
    groups.forEach((group, i) => {
      if (taken.has(i)) return;
      const alliance = i % 2 === 0 ? this.alliance : this.alliance === 'red' ? 'blue' : 'red';
      this.field.placeInLoadingZone(group, alliance);
    });
    return this;
  }

  /** Reset to pre-MATCH setup. */
  reset() {
    this.match.reset();
    this._nectarTimer = NECTAR_ENTRY_INTERVAL;
    this.stageRobots();
    for (const entry of this.participants) entry.intake?.reset();
    this.launcher.reset();
    this.loadPreloads();
    return this;
  }

  /**
   * Take new match settings from the config store.
   *
   * The periods apply to the MATCH already running -- see `Match.setPeriods`.
   * The ALLIANCE cannot be changed in place, because which HIVE and which
   * GARDEN are yours is baked into every participant; `Simulation` rebuilds the
   * game for that, and `allianceChanged` is how it knows to.
   *
   * @param {import('../config/schema.js').SimConfig} config
   */
  applySettings(config) {
    const next = { ...this.settings, ...(config?.match ?? {}) };
    this.settings = next;
    this.match.setPeriods(next);
    // Colour sorting takes effect immediately on every ROBOT: it is a property
    // of the mechanism, not of the MATCH, so there is nothing to rebuild.
    for (const entry of this.participants) {
      if (entry.intake) entry.intake.sortByAlliance = next.sortElements !== false;
    }
    return this;
  }

  /** Whether the config now asks for an ALLIANCE this game cannot become. */
  allianceChanged(config) {
    const wanted = config?.match?.alliance;
    return Boolean(wanted) && wanted !== this.alliance;
  }

  /**
   * Whether the roster settings no longer describe the ROBOTS on the FIELD.
   *
   * Compared as a signature rather than by re-resolving `random`, which would
   * roll new values and report a change every time it was asked. That means a
   * roster left on Random is *not* re-rolled by an unrelated settings change --
   * you get a new line-up when you restart the MATCH, which is when you would
   * expect one.
   *
   * @param {import('../config/schema.js').SimConfig} config
   */
  rosterChanged(config) {
    return rosterSignature(config?.ai) !== this._rosterSignature;
  }

  /** Whether the shooter settings no longer describe the launcher on the robot. */
  launcherChanged(config) {
    return JSON.stringify(playerLaunchOptions(config, SCHEMA_DEFAULTS)) !== this._launchSignature;
  }

  /** Whether this game has to be rebuilt to match the settings. */
  needsRebuild(config) {
    return (
      this.allianceChanged(config) || this.rosterChanged(config) || this.launcherChanged(config)
    );
  }

  start() {
    this.reset();
    this._endedFor = 0;
    this.match.start({ phase: this.settings.startPhase });
    return this;
  }

  /**
   * Advance the game by the simulated time the physics actually covered.
   * @param {number} dt seconds
   */
  update(dt) {
    if (dt <= 0) return this;

    // Robots are solid to the balls, so the ball world needs their bodies each
    // step -- a spinning robot flicks POLLEN, which is how a pile gets moved.
    const bodies = this.participants.map((entry) => ({
      body: entry.robot.body,
      halfLength: entry.robot.halfLength,
      halfWidth: entry.robot.halfWidth,
      height: entry.robot.config?.chassis?.height ?? 0.35,
      meta: entry.meta ?? this.match.robotMeta(entry.id),
    }));

    this.match.update(dt, { bodies });
    this._runAiDriveTeam(dt);
    for (const entry of this.participants) entry.intake?.syncCarried();

    // Optional loop: a practice session is one match after another, and having
    // to reach for a key between them is the part that makes people stop.
    if (this.match.phase === 'ended') {
      this._endedFor += dt;
      if (this.settings.autoRestart && this._endedFor >= RESTART_DELAY) this.start();
    } else {
      this._endedFor = 0;
    }
    return this;
  }

  /**
   * Hand in the opposing ALLIANCE's NECTAR for them.
   *
   * Entering NECTAR is a *human* action -- Section 10.1 gives an ALLIANCE one
   * more each time its HIVE TIPS, and all of them in the last 60 seconds -- so
   * without somebody doing it for the other side, a third of the point table
   * never happens in a MATCH against AI. No NECTAR on the FIELD means no
   * FLOWER can be owned (ownership is the top-most NECTAR, and POLLEN confers
   * none), so a robot built to fill FLOWERS scores nothing at all and the
   * bottom-NECTAR bonus never exists.
   *
   * Only the other side. Your own ALLIANCE's NECTAR is yours to enter, which
   * is a real decision with real timing -- handing it in early is a G410
   * violation -- and taking it away would be taking away part of the game.
   *
   * @param {number} dt
   */
  _runAiDriveTeam(dt) {
    if (!this.settings.aiDriveTeam) return this;
    if (!this.match.running) return this;
    const alliance = this.alliance === 'red' ? 'blue' : 'red';
    this._nectarTimer -= dt;
    if (this._nectarTimer > 0) return this;
    // Paced, because a real drive team rolls them in one at a time through a
    // gap in the wall, not all five at once.
    this._nectarTimer = NECTAR_ENTRY_INTERVAL;
    if (this.field.nectarAvailable(alliance) > 0) this.field.introduceNectar(alliance);
    return this;
  }

  /** Aim the player's launcher at their own HIVE, if the shot can be made. */
  aimAtHive() {
    return this.launcher.aimAt(this.field.hiveTarget(this.alliance));
  }

  /**
   * The arc or arcs an aiming guide should draw, with the same pass/fail the
   * HIVE itself will apply when the ball arrives.
   *
   * `live` is the shot you would get by firing now -- current hood angle,
   * current wheel speed, current ROBOT velocity. `solution` is the shot a
   * correct setup would fly. Drawing both is the teaching version: the gap
   * between them is exactly what waiting for the wheel buys you.
   *
   * @param {'live'|'solution'|'both'} [mode]
   * @returns {{kind: 'live'|'solution', points: {x:number,y:number,z:number}[],
   *            hit: boolean, entry: {x:number,y:number,z:number}|null}[]}
   */
  shotPreview(mode = 'live') {
    const launcher = this.launcher;
    const hive = this.field.hives[this.alliance];
    const side = hive.up;
    const arcs = [];

    const add = (kind, opts) => {
      const arc = launcher.trajectory(opts);
      if (!arc) return;
      const entry = apertureEntry(arc, hive, side);
      arcs.push({ kind, points: arc.points, hit: Boolean(entry), entry });
    };

    if (mode !== 'solution') add('live', {});
    if (mode !== 'live') {
      const solved = launcher.aimFor(this.field.hiveTarget(this.alliance));
      if (solved) add('solution', { angle: solved.angle, speed: solved.speed });
    }
    return arcs;
  }

  /**
   * The other three ROBOTS, for the panel.
   *
   * Worth showing. Knowing that the robot in front of you is a pushbot you can
   * shove and the one behind it is an elite twin-wheel shooter is most of what
   * a scouting sheet is for, and at a real event you would have read it before
   * the MATCH started.
   */
  lineup() {
    const out = [];
    for (const entry of this.participants) {
      const opponent = entry.opponent;
      if (!opponent) continue;
      out.push({
        slot: opponent._rosterSlot ?? 'added',
        alliance: entry.alliance,
        ally: entry.alliance === this.alliance,
        name: opponent.archetype?.name ?? opponent.profile?.name ?? 'robot',
        system: opponent.archetype?.system ?? null,
        quality: opponent.quality?.name ?? null,
        skill: opponent.skill?.name ?? null,
        shots: opponent.launcher?.shots ?? 0,
        held: opponent.intake?.count ?? 0,
      });
    }
    return out;
  }

  /** Everything the HUD needs, in one object. */
  telemetry() {
    const score = this.match.score();
    const status = this.match.status();
    return {
      alliance: this.alliance,
      phase: status.phase,
      phaseRemaining: status.phaseRemaining,
      teleopRemaining: status.teleopRemaining,
      flowerUnlocked: status.flowerUnlocked,
      nectarAvailable: status.nectarAvailable[this.alliance],
      score,
      held: this.intake.count,
      capacity: this.intake.capacity,
      shooter: {
        rpm: this.launcher.rpm,
        target: this.launcher.targetRpm,
        ready: this.launcher.ready,
        spinning: this.launcher.spinning,
        recovery: this.launcher.recovery,
        hoodDegrees: (this.launcher.hoodAngle * 180) / Math.PI,
      },
      /**
       * Whether the robot is moving enough to throw a shot off. The opening is
       * 20 in wide, so a little drift survives; this is the point past which it
       * does not. Adjustable, because how much drift is survivable depends on
       * the range, and someone drilling close shots wants a tighter warning.
       */
      moving: this.sim.robot.body.speed > this.settings.moveTolerance,
      lineup: this.lineup(),
      launchSystem: this.launcher.kind ?? 'flywheel',
      needsSpinUp: this.launcher.needsSpinUp !== false,
      solution: this.launcher.aimFor(this.field.hiveTarget(this.alliance)),
      /**
       * What the REFEREE has called, newest first, and how many elements are
       * off the FIELD waiting for FIELD STAFF.
       *
       * A foul you were not told about is a foul you will commit again, and a
       * MAJOR FOUL is worth ten elements in a CELL -- so this belongs on the
       * panel next to the score, not in a log somewhere.
       */
      citations: status.citations,
      fouls: status.fouls,
      pendingReturns: status.pendingReturns,
    };
  }

  /** Take the game back off the simulation, leaving it as it was. */
  dispose() {
    this.field.dispose();
    for (const entry of this.participants) {
      const robot = entry.robot;
      robot.subsystems = robot.subsystems.filter(
        (s) => !(s instanceof Intake) && !(s instanceof Launcher) && !(s instanceof Thrower),
      );
      robot.updateMassProperties();
    }
    for (const opponent of this.sim.opponents) {
      delete opponent._biobuzz;
      opponent.intake = null;
      opponent.launcher = null;
    }
    // Only the ones this game created: the drills and the user own theirs.
    if (this.rosterOpponents.length) {
      const mine = new Set(this.rosterOpponents);
      this.sim.removeOpponents((o) => mine.has(o));
      this.rosterOpponents.length = 0;
    }
    this.participants.length = 0;
    return this;
  }
}

/**
 * Where an arc first enters a CELL's mouth, or null if it never does.
 *
 * Walks the sampled arc for a crossing of the opening plane from outside to
 * inside, refines it by bisection on the arc's own closed form -- the samples
 * are for drawing, and a 48-point polyline is far too coarse to decide a 20 in
 * aperture -- then asks the HIVE whether that point is actually inside the
 * pentagon. A parabola can cross an infinite plane twice, so every crossing is
 * tried rather than just the first.
 *
 * @param {{points: {x:number,y:number,z:number}[], at: (t:number) => {x:number,y:number,z:number}, flightTime: number}} arc
 * @param {import('../field/biobuzz/Hive.js').Hive} hive
 * @param {'fore'|'aft'} side
 */
function apertureEntry(arc, hive, side) {
  const depth = (p) => hive.openingDepth(side, p.x, p.y, p.z);
  const n = arc.points.length - 1;
  for (let i = 0; i < n; i++) {
    const a = depth(arc.points[i]);
    const b = depth(arc.points[i + 1]);
    if (a <= 0 || b > 0) continue;
    let lo = (arc.flightTime * i) / n;
    let hi = (arc.flightTime * (i + 1)) / n;
    for (let k = 0; k < 24; k++) {
      const mid = (lo + hi) / 2;
      if (depth(arc.at(mid)) > 0) lo = mid;
      else hi = mid;
    }
    const point = arc.at((lo + hi) / 2);
    // The ball counts as arriving when it touches the plane, and its centre has
    // to be inside the outline -- the same two allowances the capture test uses.
    if (hive.openingContains(side, point.x, point.y, point.z, { margin: 0, outward: POLLEN_RADIUS })) {
      return point;
    }
  }
  return null;
}
