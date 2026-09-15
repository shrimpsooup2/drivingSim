import { BiobuzzField } from '../field/biobuzz/BiobuzzField.js';
import { Match } from '../field/biobuzz/Match.js';
import { Intake } from '../robot/biobuzz/Intake.js';
import { Launcher } from '../robot/biobuzz/Launcher.js';
import { FIELD_INNER_HALF, POLLEN_RADIUS } from '../field/biobuzz/constants.js';
import { INCH } from '../math/MathUtil.js';

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

/**
 * Used when there is no config store -- a bare `new BiobuzzGame(sim)` in a
 * test. The numbers are the manual's, so a game built without settings is the
 * game the manual describes.
 */
const DEFAULT_MATCH_SETTINGS = {
  alliance: 'red',
  startPhase: 'auto',
  autoRestart: false,
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

    this.field = new BiobuzzField({ field: sim.field });

    /** Mechanisms on the player's robot. */
    this.intake = sim.robot.addSubsystem(new Intake());
    this.launcher = sim.robot.addSubsystem(new Launcher());
    this.intake.ballWorld = this.field.ballWorld;
    this.intake.flowers = this.field.flowers;
    this.launcher.ballWorld = this.field.ballWorld;
    this.launcher.intake = this.intake;

    /** @type {{robot: any, alliance: 'red'|'blue', id: string, intake: Intake}[]} */
    this.participants = [
      { robot: sim.robot, alliance: this.alliance, id: 'player', intake: this.intake },
    ];

    this.match = new Match({
      field: this.field,
      robots: [{ robot: sim.robot, alliance: this.alliance, id: 'player' }],
      autoSeconds: this.settings.autoSeconds,
      transitionSeconds: this.settings.transitionSeconds,
      teleopSeconds: this.settings.teleopSeconds,
      flowerUnlockRemaining: this.settings.flowerUnlockRemaining,
    });

    this.attachOpponents();
    this.stageRobots();
  }

  /**
   * Give every AI opponent an intake too, and enter it in the MATCH. An
   * opponent that cannot touch a SCORING ELEMENT is not an opponent in this
   * game, only an obstacle.
   */
  attachOpponents() {
    for (const opponent of this.sim.opponents) {
      if (opponent._biobuzz) continue;
      // Opponents carry no alliance of their own, so anything without one is
      // put on the other side -- which is what an opponent is for.
      const alliance = opponent.alliance ?? (this.alliance === 'red' ? 'blue' : 'red');
      opponent.alliance = alliance;
      const intake = opponent.robot.addSubsystem(new Intake());
      intake.ballWorld = this.field.ballWorld;
      intake.flowers = this.field.flowers;
      opponent._biobuzz = { intake };
      const id = this.match.addRobot({ robot: opponent.robot, alliance });
      this.participants.push({ robot: opponent.robot, alliance, id, intake });
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

  /** Hand each ROBOT its four pre-load POLLEN (Section 10.3.1). */
  loadPreloads() {
    const groups = this.field.preloadGroups;
    this.participants.forEach((entry, i) => {
      const group = groups[i];
      if (!group) return;
      entry.intake.held.length = 0;
      entry.intake.capacity = Math.max(entry.intake.capacity, group.length);
      for (const ball of group) entry.intake.give(ball);
    });
    return this;
  }

  /** Reset to pre-MATCH setup. */
  reset() {
    this.match.reset();
    this.stageRobots();
    for (const entry of this.participants) entry.intake.reset();
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
    return this;
  }

  /** Whether the config now asks for an ALLIANCE this game cannot become. */
  allianceChanged(config) {
    const wanted = config?.match?.alliance;
    return Boolean(wanted) && wanted !== this.alliance;
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
    }));

    this.match.update(dt, { bodies });
    for (const entry of this.participants) entry.intake.syncCarried();

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
      solution: this.launcher.aimFor(this.field.hiveTarget(this.alliance)),
    };
  }

  /** Take the game back off the simulation, leaving it as it was. */
  dispose() {
    this.field.dispose();
    for (const entry of this.participants) {
      const robot = entry.robot;
      robot.subsystems = robot.subsystems.filter(
        (s) => !(s instanceof Intake) && !(s instanceof Launcher),
      );
      robot.updateMassProperties();
    }
    for (const opponent of this.sim.opponents) delete opponent._biobuzz;
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
