import { Vec2 } from '../math/Vec2.js';
import { headingError } from './zones.js';
import { clamp } from '../math/MathUtil.js';

/**
 * @typedef {'ready'|'running'|'complete'|'failed'} ChallengeState
 * @typedef {'basic'|'intermediate'|'advanced'} Tier
 */

/**
 * @typedef {object} Objective
 * @property {'gate'|'zone'|'park'} kind
 * @property {string} [label]
 * @property {import('./zones.js').Gate} [gate]
 * @property {import('./zones.js').CircleZone} [zone]
 * @property {number} [dwellSeconds]     how long to hold still, for 'park'
 * @property {number} [speedLimit]       m/s, counts as stopped below this
 * @property {number} [headingTarget]    radians; omit to ignore heading
 * @property {number} [headingTolerance] radians
 * @property {boolean} [requireReverse]  must arrive travelling backwards
 * @property {number} [approachSpeedLimit] m/s cap while within `approachRadius`
 * @property {number} [approachRadius]   m
 */

/**
 * A timed driving drill.
 *
 * Drills are game-agnostic on purpose: the season's game is unknown, so they
 * train what sits underneath any game rather than a scoring pattern that will
 * be obsolete in a month.
 *
 * Three things make a drill actually demanding, and all three are supported
 * here rather than left to convention:
 *
 *  - **Physical obstacles.** A course is only "tight" if something stops you
 *    cutting the corner. Obstacles are solid, and clipping one spins you.
 *  - **Constraints beyond position.** Arriving is easy; arriving *backwards*,
 *    *square*, or *under a speed limit* is the part that takes practice.
 *  - **Opponents.** A defender that denies your route is a different problem
 *    from an empty field, and it is the one an actual match presents.
 */
export class Challenge {
  /**
   * @param {{
   *   id: string,
   *   name: string,
   *   description: string,
   *   tip?: string,
   *   tier?: Tier,
   *   holonomicOnly?: boolean,
   *   wallPenalty?: number,
   *   obstaclePenalty?: number,
   *   speedPenaltyPerSecond?: number,
   *   timeLimit?: number,
   *   scoreMode?: 'time'|'count',
   *   duration?: number,
   *   par?: {gold:number, silver:number, bronze:number},
   * }} def
   */
  constructor(def) {
    this.id = def.id;
    this.name = def.name;
    this.description = def.description;
    this.tip = def.tip ?? '';
    this.tier = def.tier ?? 'basic';
    this.holonomicOnly = def.holonomicOnly ?? false;

    this.wallPenalty = def.wallPenalty ?? 2;
    /** Seconds charged for being shoved by an opponent. */
    this.opponentPenalty = def.opponentPenalty ?? 2;
    /** Clipping a solid obstacle usually costs more than brushing a wall. */
    this.obstaclePenalty = def.obstaclePenalty ?? 3;
    this.speedPenaltyPerSecond = def.speedPenaltyPerSecond ?? 4;
    this.timeLimit = def.timeLimit ?? 0;

    /**
     * 'time': finish the course, lowest total wins.
     * 'count': a fixed window, most objectives completed wins. Count mode is
     * how a real match works, and it rewards sustainable pace over one hot lap.
     */
    this.scoreMode = def.scoreMode ?? 'time';
    this.duration = def.duration ?? 0;
    /** Medal thresholds. For count mode these are objective counts, not seconds. */
    this.par = def.par ?? null;

    /** @type {Objective[]} */
    this.objectives = [];
    this.startPose = { x: 0, y: 0, heading: 0 };
    /** Extra shapes that are not objectives, e.g. a corridor to stay inside. */
    this.decorations = [];
    /** Solid boxes the runner places on the field. */
    this.obstacles = /** @type {{position:Vec2,size:Vec2,heading?:number,height?:number}[]} */ ([]);
    /** AI robots the runner spawns. */
    this.opponents = /** @type {any[]} */ ([]);

    this.reset();
  }

  /**
   * Build the course. Subclasses set `objectives`, `startPose` and optionally
   * `decorations`, `obstacles` and `opponents`.
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
    this.obstacleHits = 0;
    this.opponentHits = 0;
    /** Objectives cleared in total, which is the score in count mode. */
    this.completions = 0;
    this.laps = 0;
    this._dwell = 0;
    this._previousPosition = null;
    this._insideZone = false;
    this._enteredReversing = false;
    this._wallCooldown = 0;
    this._obstacleCooldown = 0;
    this._opponentCooldown = 0;
    this.message = '';
    this.result = null;
    for (const decoration of this.decorations) decoration.straying = false;
    return this;
  }

  get total() {
    return this.objectives.length;
  }

  /** Lower is better in time mode; higher is better in count mode. */
  get score() {
    return this.scoreMode === 'count' ? this.completions : this.elapsed + this.penaltySeconds;
  }

  get current() {
    return this.objectives[this.index] ?? null;
  }

  /** Seconds left, for count-mode drills that run against a match clock. */
  get remaining() {
    return this.scoreMode === 'count' ? Math.max(0, this.duration - this.elapsed) : 0;
  }

  /**
   * Medal for a score, or null if the drill has no par times.
   * @param {number} [score]
   */
  grade(score = this.score) {
    if (!this.par) return null;
    if (this.scoreMode === 'count') {
      if (score >= this.par.gold) return 'gold';
      if (score >= this.par.silver) return 'silver';
      if (score >= this.par.bronze) return 'bronze';
      return null;
    }
    if (score <= this.par.gold) return 'gold';
    if (score <= this.par.silver) return 'silver';
    if (score <= this.par.bronze) return 'bronze';
    return null;
  }

  /** Is a higher score better? Used by the record book and the UI. */
  get higherIsBetter() {
    return this.scoreMode === 'count';
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
      // The clock starts the moment the robot moves, so lining up is free.
      this._previousPosition = position.clone();
      if (body.speed <= 0.05) return;
      this.state = 'running';
    }

    this.elapsed += dt;
    this._wallCooldown = Math.max(0, this._wallCooldown - dt);
    this._obstacleCooldown = Math.max(0, this._obstacleCooldown - dt);
    this._opponentCooldown = Math.max(0, this._opponentCooldown - dt);

    this._chargeContacts(sim);
    this._updateDecorations(dt, position);
    this._chargeSpeedLimits(dt, position, body);

    const objective = this.current;
    if (objective && this._satisfied(objective, dt, position, body)) {
      this.index++;
      this.completions++;
      this._dwell = 0;
      this._insideZone = false;
      this._enteredReversing = false;
      this.message = '';
      if (this.index >= this.objectives.length) {
        if (this.scoreMode === 'count') {
          // Count mode loops the course until the clock runs out.
          this.index = 0;
          this.laps++;
        } else {
          this._finish(sim);
          return;
        }
      }
    }

    this._previousPosition = position;

    if (this.scoreMode === 'count' && this.elapsed >= this.duration) {
      this._finish(sim);
    } else if (this.timeLimit > 0 && this.elapsed > this.timeLimit) {
      this.state = 'failed';
      this.message = 'Out of time';
    }
  }

  /**
   * Wall and obstacle contact both cost time. Rate-limited, because resting
   * against something produces a contact every physics substep and would
   * otherwise run the penalty up without bound.
   */
  _chargeContacts(sim) {
    if (sim.field.lastContacts.length > 0 && this._wallCooldown <= 0) {
      this.wallHits++;
      this.penaltySeconds += this.wallPenalty;
      this._wallCooldown = 1.0;
      this.message = `Wall  +${this.wallPenalty.toFixed(0)}s`;
    }
    if (sim.field.lastObstacleContacts.length > 0 && this._obstacleCooldown <= 0) {
      this.obstacleHits++;
      this.penaltySeconds += this.obstaclePenalty;
      this._obstacleCooldown = 1.0;
      this.message = `Obstacle  +${this.obstaclePenalty.toFixed(0)}s`;
    }
    // Letting a defender get to you costs time, which is what makes evading one
    // worth the detour rather than just barging through.
    if (sim.robotContact && this._opponentCooldown <= 0) {
      this.opponentHits++;
      this.penaltySeconds += this.opponentPenalty;
      this._opponentCooldown = 1.5;
      this.message = `Contact  +${this.opponentPenalty.toFixed(0)}s`;
    }
  }

  /** Corridor penalties, charged per second outside rather than as a one-off. */
  _updateDecorations(dt, position) {
    for (const decoration of this.decorations) {
      if (decoration.kind !== 'corridor') continue;
      const stray = decoration.corridor.strayDistance(position);
      decoration.straying = stray > 0;
      if (stray > 0) {
        this.penaltySeconds += decoration.penaltyPerSecond * dt;
        this.message = 'Out of the lane';
      }
    }
  }

  /**
   * Speed limits near delicate objectives.
   *
   * Charging per second over the limit, rather than failing the run, makes the
   * drill about judgement: barrelling in and eating the penalty is sometimes
   * genuinely the right call, and deciding that is the skill.
   */
  _chargeSpeedLimits(dt, position, body) {
    const objective = this.current;
    if (!objective?.approachSpeedLimit || !objective.zone) return;
    const radius = objective.approachRadius ?? objective.zone.radius * 3;
    const distance = objective.zone.distanceFrom(position);
    if (distance > radius) return;
    const excess = body.speed - objective.approachSpeedLimit;
    if (excess > 0) {
      this.penaltySeconds += this.speedPenaltyPerSecond * dt * clamp(excess, 0, 2);
      this.message = 'Too fast in the approach';
    }
  }

  /**
   * @param {Objective} objective
   * @param {number} dt
   * @param {Vec2} position
   * @param {import('../physics/RigidBody2d.js').RigidBody2d} body
   */
  _satisfied(objective, dt, position, body) {
    // Reversing is checked in the body frame: it is about which way the robot
    // is *facing* relative to its travel, not which way it is moving on the field.
    const bodyVelocity = body.bodyVelocity;
    const reversing = bodyVelocity.x < -0.08;

    // For a zone, remember how the robot was travelling as it crossed the
    // boundary. A park objective ends with the robot stopped, so asking
    // "is it reversing now" would always be false -- the question that actually
    // matters is whether it *backed in*.
    if (objective.zone) {
      const inside = objective.zone.contains(position);
      if (inside && !this._insideZone) this._enteredReversing = reversing;
      this._insideZone = inside;
    }

    switch (objective.kind) {
      case 'gate': {
        const crossed = Boolean(
          this._previousPosition && objective.gate.crossed(this._previousPosition, position),
        );
        if (!crossed) return false;
        if (objective.requireReverse && !reversing) {
          this.message = 'That gate must be taken in reverse';
          return false;
        }
        if (
          objective.headingTarget !== undefined &&
          headingError(body.rotation.radians, objective.headingTarget) >
            (objective.headingTolerance ?? Math.PI)
        ) {
          this.message = 'Wrong heading through the gate';
          return false;
        }
        return true;
      }

      case 'zone':
        if (!objective.zone.contains(position)) return false;
        if (objective.requireReverse && !this._enteredReversing) {
          this.message = 'Back into it';
          return false;
        }
        return true;

      case 'park': {
        const inside = objective.zone.contains(position);
        const stopped = body.speed <= (objective.speedLimit ?? 0.08);
        const aimed =
          objective.headingTarget === undefined ||
          headingError(body.rotation.radians, objective.headingTarget) <=
            (objective.headingTolerance ?? Math.PI);

        if (objective.requireReverse && inside && !this._enteredReversing) {
          this._dwell = 0;
          this.message = 'Back in - you drove in nose first';
          return false;
        }

        if (inside && stopped && aimed) {
          this._dwell += dt;
          const needed = objective.dwellSeconds ?? 1;
          this.message = `Hold still  ${Math.max(0, needed - this._dwell).toFixed(1)}s`;
          if (this._dwell >= needed) return true;
        } else {
          this._dwell = 0;
          if (!inside) this.message = 'Get inside the target';
          else if (!stopped) this.message = 'Come to a complete stop';
          else this.message = 'Square up';
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
      score: this.score,
      time: this.elapsed,
      penalties: this.penaltySeconds,
      wallHits: this.wallHits,
      obstacleHits: this.obstacleHits,
      opponentHits: this.opponentHits,
      completions: this.completions,
      grade: this.grade(),
    };
    this.message = '';
    sim?.events.emit('challengeComplete', this);
  }

  /**
   * Shapes for the renderer, tagged with progress so the next objective can be
   * highlighted and cleared ones dimmed.
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
      const label = objective.label ?? String(i + 1);
      if (objective.kind === 'gate') {
        shapes.push({
          kind: 'gate',
          center: objective.gate.center,
          heading: objective.gate.heading,
          width: objective.gate.width,
          label,
          status,
          reverse: Boolean(objective.requireReverse),
        });
      } else {
        shapes.push({
          kind: 'zone',
          center: objective.zone.center,
          radius: objective.zone.radius,
          label,
          heading: objective.headingTarget,
          status,
          reverse: Boolean(objective.requireReverse),
          slow: Boolean(objective.approachSpeedLimit),
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
      tier: this.tier,
      state: this.state,
      scoreMode: this.scoreMode,
      elapsed: this.elapsed,
      remaining: this.remaining,
      score: this.score,
      penalties: this.penaltySeconds,
      index: this.index,
      total: this.total,
      completions: this.completions,
      laps: this.laps,
      objectiveLabel: objective?.label ?? '',
      message: this.message,
      tip: this.tip,
      grade: this.state === 'complete' ? this.grade() : null,
    };
  }
}
