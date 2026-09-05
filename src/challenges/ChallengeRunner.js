import { createChallenges } from './library.js';
import { EventBus } from '../util/events.js';

const STORAGE_KEY = 'ftc-sim-records-v1';

/**
 * Owns the drill library, the active drill, and the record book.
 *
 * Records are stored per drill *and per drivetrain type*, because a time set on
 * a 435 RPM mecanum robot says nothing about the same driver on a geared-down
 * tank. Comparing across configurations would make the leaderboard actively
 * misleading, so they are kept apart.
 *
 * Emits:
 *   'select'   (challenge | null)
 *   'start'    (challenge)
 *   'complete' (challenge, {isRecord, previousBest})
 */
export class ChallengeRunner {
  /** @param {import('../app/Simulation.js').Simulation} sim */
  constructor(sim) {
    this.sim = sim;
    this.events = new EventBus();
    this.challenges = createChallenges();
    /** @type {import('./Challenge.js').Challenge|null} */
    this.active = null;
    this.records = this._loadRecords();
  }

  /** Drills that make sense for the current drivetrain. */
  available() {
    const holonomic = this.sim.robot.drivetrain.canStrafe;
    return this.challenges.filter((c) => !c.holonomicOnly || holonomic);
  }

  /** @param {string} id */
  select(id) {
    const challenge = this.challenges.find((c) => c.id === id);
    if (!challenge) return null;
    this.active = challenge;
    challenge.build(this.sim.field);
    challenge.reset();
    this.sim.setStartPose(challenge.startPose.x, challenge.startPose.y, challenge.startPose.heading);
    this.sim.resetRobot();
    this.events.emit('select', challenge);
    return challenge;
  }

  /** Put the robot back on the line and clear the clock. */
  restart() {
    if (!this.active) return;
    this.active.reset();
    this.sim.setStartPose(
      this.active.startPose.x,
      this.active.startPose.y,
      this.active.startPose.heading,
    );
    this.sim.resetRobot();
    this.events.emit('select', this.active);
  }

  /** Leave drill mode and go back to free driving. */
  clear() {
    this.active = null;
    this.events.emit('select', null);
  }

  /**
   * Advance the active drill. Called once per rendered frame with simulated
   * time, not wall time, so slow motion and a stuttering browser both keep the
   * clock honest.
   * @param {number} dt
   */
  update(dt) {
    if (!this.active) return;
    const before = this.active.state;
    this.active.update(dt, this.sim);
    const after = this.active.state;

    if (before === 'ready' && after === 'running') this.events.emit('start', this.active);
    if (before === 'running' && after === 'complete') this._record(this.active);
  }

  _record(challenge) {
    const key = this._recordKey(challenge.id);
    const previousBest = this.records[key]?.score ?? null;
    const isRecord = previousBest === null || challenge.score < previousBest;
    if (isRecord) {
      this.records[key] = {
        score: challenge.score,
        time: challenge.elapsed,
        penalties: challenge.penaltySeconds,
        at: new Date().toISOString(),
      };
      this._saveRecords();
    }
    this.events.emit('complete', challenge, { isRecord, previousBest });
  }

  /** @param {string} id */
  bestFor(id) {
    return this.records[this._recordKey(id)] ?? null;
  }

  clearRecords() {
    this.records = {};
    this._saveRecords();
  }

  _recordKey(id) {
    return `${id}|${this.sim.config.drivetrain.type}`;
  }

  _loadRecords() {
    try {
      const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
      return raw ? JSON.parse(raw) : {};
    } catch {
      return {};
    }
  }

  _saveRecords() {
    try {
      globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(this.records));
    } catch {
      /* private browsing; records just will not persist */
    }
  }

  on(event, handler) {
    return this.events.on(event, handler);
  }
}
