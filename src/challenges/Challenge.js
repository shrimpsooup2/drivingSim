import { Vec2 } from '../math/Vec2.js';
import { headingError } from './zones.js';

/**
 * @typedef {'ready'|'running'|'complete'|'failed'} ChallengeState
 */

/**
 * @typedef {object} Objective
 * @property {'gate'|'zone'|'park'} kind
 * @property {string} [label]
 * @property {import('./zones.js').Gate} [gate]
 * @property {import('./zones.js').CircleZone} [zone]
 * @property {number} [dwellSeconds]   how long to hold still inside, for 'park'
 * @property {number} [speedLimit]     m/s, counts as stopped below this
 * @property {number} [headingTarget]  radians; omit to ignore heading
 * @property {number} [headingTolerance] radians
 */

/**
 * A timed driving drill.
 *
 * Drills are deliberately game-agnostic. None of them score game pieces,
 * because the season's game is not known -- they train the underlying skills
 * that transfer to any game: judging distance from the driver station, stopping
 * accurately, turning smoothly, and keeping the wheels hooked up.
 *
 * The clock starts when the robot first moves rather than on a countdown, so a
 * driver can settle before beginning, and a run is directly comparable with the
 * next one.
 *
 * Subclasses implement `build(field)`. Everything else -- ordering, timing,
 * penalties, records -- is handled here.
 */
export class Challenge {
  /**
   * @param {{
   *   id: string,
   *   name: string,
   *   description: string,
   *   tip?: string,
   *   holonomicOnly?: boolean,
   *   wallPenalty?: number,
   *   timeLimit?: number,
   * }} def
   */
  constructor(def) {
    this.id = def.id;
    this.name = def.name;
    this.description = def.description;
    /** One line of coaching shown while the drill is running. */
    this.tip = def.tip ?? '';
    /** Drills that need strafing are hidden for tank drivetrains. */
    this.holonomicOnly = def.holonomicOnly ?? false;
    /** Seconds added to the clock for each wall hit. */
    this.wallPenalty = def.wallPenalty ?? 2;
    this.timeLimit = def.timeLimit ?? 0;

    /** @type {Objective[]} */
    this.objectives = [];
    /** Where the robot is placed when the drill is loaded. */
    this.startPose = { x: 0, y: 0, heading: 0 };
    /** Extra shapes to draw that are not objectives, e.g. a corridor. */
    this.decorations = [];

    this.reset();
  }

  /**
   * Build the course. Subclasses set `this.objectives`, `this.startPose` and
   * optionally `this.decorations`.
   * @param {import('../field/Field.js').Field} _field
   */
  build(_field) {
    throw new Error(`${this.id}: build() not implemented`);
  }

  reset() {
    /** @type {ChallengeState} */
    this.state = 'ready';
    this.index = 0;
    this.elapsed = 0;
    this.penaltySeconds = 0;
    this.wallHits = 0;
    this._dwell = 0;
    this._previousPosition = null;
    this._wallCooldown = 0;
    this.message = '';
    /** Set when the run finishes, so the UI can show the result. */
    this.result = null;
    return this;
  }

  get total() {
    return this.objectives.length;
  }

  /** Clock plus penalties: the number that actually gets compared. */
  get score() {
    return this.elapsed + this.penaltySeconds;
  }

  get current() {
    return this.objectives[this.index] ?? null;
  }

  /**
   * Advance the drill.
   * @param {number} dt seconds
   * @param {import('../app/Simulation.js').Simulation} sim
   */
  update(dt, sim) {
    if (this.state === 'complete' || this.state === 'failed') return;

    const body = sim.robot.body;
    const position = new Vec2(body.position.x, body.position.y);

    if (this.state === 'ready') {
      // The clock starts the moment the robot actually moves, so the driver
      // can take their time lining up without it counting against them.
      if (body.speed > 0.05) {
        this.state = 'running';
        this._previousPosition = position.clone();
      } else {
        this._previousPosition = position.clone();
        return;
      }
    }

    this.elapsed += dt;
    this._wallCooldown = Math.max(0, this._wallCooldown - dt);

    // Wall contact costs time. Rate-limited, because resting against a wall
    // produces a contact every physics substep and would otherwise run the
    // penalty up without bound.
    if (sim.field.lastContacts.length > 0 && this._wallCooldown <= 0) {
      this.wallHits++;
      this.penaltySeconds += this.wallPenalty;
      this._wallCooldown = 1.0;
      this.message = `Wall contact  +${this.wallPenalty.toFixed(0)}s`;
    }

    this._updateDecorations(dt, position);

    const objective = this.current;
    if (objective && this._satisfied(objective, dt, position, body)) {
      this.index++;
      this._dwell = 0;
      this.message = '';
      if (this.index >= this.objectives.length) this._finish(sim);
    }

    this._previousPosition = position;

    if (this.timeLimit > 0 && this.elapsed > this.timeLimit && this.state === 'running') {
      this.state = 'failed';
      this.message = 'Out of time';
    }
  }

  /** Corridor penalties and anything else a subclass wants to track per frame. */
  _updateDecorations(dt, position) {
    for (const decoration of this.decorations) {
      if (decoration.kind !== 'corridor') continue;
      const stray = decoration.corridor.strayDistance(position);
      decoration.straying = stray > 0;
      if (stray > 0) {
        // Charged per second outside rather than as a one-off, so a brief
        // clip of the edge is cheap and a sustained excursion is not.
        this.penaltySeconds += decoration.penaltyPerSecond * dt;
        this.message = 'Out of the lane';
      }
    }
  }

  /**
   * @param {Objective} objective
   * @param {number} dt
   * @param {Vec2} position
   * @param {import('../physics/RigidBody2d.js').RigidBody2d} body
   */
  _satisfied(objective, dt, position, body) {
    switch (objective.kind) {
      case 'gate':
        return Boolean(
          this._previousPosition && objective.gate.crossed(this._previousPosition, position),
        );

      case 'zone':
        return objective.zone.contains(position);

      case 'park': {
        const inside = objective.zone.contains(position);
        const stopped = body.speed <= (objective.speedLimit ?? 0.08);
        const aimed =
          objective.headingTarget === undefined ||
          headingError(body.rotation.radians, objective.headingTarget) <=
            (objective.headingTolerance ?? Math.PI);

        if (inside && stopped && aimed) {
          this._dwell += dt;
          const needed = objective.dwellSeconds ?? 1;
          this.message = `Hold still  ${(needed - this._dwell).toFixed(1)}s`;
          if (this._dwell >= needed) return true;
        } else {
          this._dwell = 0;
          if (!inside) this.message = 'Get inside the target';
          else if (!stopped) this.message = 'Come to a complete stop';
          else this.message = 'Square up to the target';
        }
        return false;
      }

      default:
        return false;
    }
  }

  _finish(sim) {
    this.state = 'complete';
    this.result = {
      time: this.elapsed,
      penalties: this.penaltySeconds,
      score: this.score,
      wallHits: this.wallHits,
    };
    this.message = '';
    sim?.events.emit('challengeComplete', this);
  }

  /**
   * Shapes for the renderer, tagged with progress so the next objective can be
   * highlighted and completed ones dimmed.
   */
  describe() {
    const shapes = [];
    for (const decoration of this.decorations) {
      if (decoration.kind === 'corridor') {
        shapes.push({
          kind: 'corridor',
          points: decoration.corridor.points,
          halfWidth: decoration.corridor.halfWidth,
          straying: Boolean(decoration.straying),
        });
      }
    }
    this.objectives.forEach((objective, i) => {
      const status = i < this.index ? 'done' : i === this.index ? 'active' : 'pending';
      if (objective.kind === 'gate') {
        shapes.push({
          kind: 'gate',
          center: objective.gate.center,
          heading: objective.gate.heading,
          width: objective.gate.width,
          label: objective.label ?? String(i + 1),
          status,
        });
      } else {
        shapes.push({
          kind: 'zone',
          center: objective.zone.center,
          radius: objective.zone.radius,
          label: objective.label ?? String(i + 1),
          heading: objective.headingTarget,
          status,
        });
      }
    });
    return shapes;
  }

  /** Compact state for the HUD. */
  hud() {
    const objective = this.current;
    return {
      name: this.name,
      state: this.state,
      elapsed: this.elapsed,
      score: this.score,
      penalties: this.penaltySeconds,
      index: this.index,
      total: this.total,
      objectiveLabel: objective?.label ?? '',
      message: this.message,
      tip: this.tip,
    };
  }
}
