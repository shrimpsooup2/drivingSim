import { Robot } from '../robot/Robot.js';
import { Vec2 } from '../math/Vec2.js';
import { DelayLine } from '../math/filters.js';
import { BEHAVIORS, intentToCommand } from './behaviors.js';
import { PROFILE_BY_ID, SKILL_BY_ID } from './profiles.js';

/**
 * An AI-driven opponent robot.
 *
 * Wraps a full `Robot`, so it obeys exactly the same physics the player does.
 * Skill is modelled where it actually lives on a real drive team: how stale the
 * driver's picture of the field is, how precisely they can put the robot where
 * they meant to, how much of the available power they dare use, and how often
 * they change their mind. A "hard" opponent is not one with better physics --
 * it is one that reacts sooner and wastes less.
 */
export class Opponent {
  /**
   * @param {{
   *   id?: string,
   *   profileId: string,
   *   skillId: string,
   *   behavior: keyof typeof BEHAVIORS,
   *   start: {x:number, y:number, heading:number},
   *   waypoints?: Vec2[],
   *   baseConfig: import('../config/schema.js').SimConfig,
   *   random?: () => number,
   * }} opts
   */
  constructor(opts) {
    /**
     * Source of the driver's imprecision. Injectable so tests can seed it and
     * get a repeatable opponent -- otherwise an AI drill is impossible to
     * regression-test, because every run differs.
     */
    this.random = opts.random ?? Math.random;
    this.profile = PROFILE_BY_ID[opts.profileId] ?? PROFILE_BY_ID.rival;
    this.skill = SKILL_BY_ID[opts.skillId] ?? SKILL_BY_ID.competent;
    this.behaviorName = opts.behavior;
    this.id = opts.id ?? `${this.profile.id}-${this.behaviorName}`;
    this.start = opts.start;
    this.state = { waypoints: opts.waypoints ?? [], waypointIndex: 0 };

    this.config = buildConfig(opts.baseConfig, this.profile.config);
    this.robot = new Robot(this.config);
    this.robot.reset(this.start.x, this.start.y, this.start.heading);

    // The opponent only ever sees a delayed picture of the player.
    this.perception = new DelayLine(this.skill.reactionSeconds);
    this._command = { forward: 0, strafe: 0, turn: 0 };
    this._replanTimer = 0;
    this._noise = 0;
    this._mistakeUntil = 0;
    this.time = 0;
  }

  get color() {
    return this.profile.color;
  }

  get halfLength() {
    return this.robot.halfLength;
  }

  get halfWidth() {
    return this.robot.halfWidth;
  }

  /**
   * Re-apply shared settings (surface, battery, solver) while keeping this
   * opponent's own chassis and gearing.
   *
   * `rebuild` is only needed when something structural changed; a tweak to tile
   * friction should not tear down and rebuild four drivetrains.
   *
   * @param {import('../config/schema.js').SimConfig} baseConfig
   * @param {boolean} [rebuild]
   */
  applyBaseConfig(baseConfig, rebuild = true) {
    this.config = buildConfig(baseConfig, this.profile.config);
    this.robot.applySettings(this.config, rebuild);
  }

  reset() {
    this.robot.reset(this.start.x, this.start.y, this.start.heading);
    this.perception.reset();
    this._command = { forward: 0, strafe: 0, turn: 0 };
    this._replanTimer = 0;
    this._mistakeUntil = 0;
    this.time = 0;
    this.state.waypointIndex = 0;
  }

  /**
   * Control-rate update.
   * @param {number} dt
   * @param {{position: Vec2, velocity: Vec2, heading: number, target: Vec2|null, fieldHalfSize: number}} world
   */
  updateControl(dt, world) {
    this.time += dt;

    // What this driver currently believes about the player, which is a little
    // behind reality by their reaction time.
    const seen = this.perception.update(
      { x: world.position.x, y: world.position.y, vx: world.velocity.x, vy: world.velocity.y, heading: world.heading },
      dt,
    );

    this._replanTimer -= dt;
    if (this._replanTimer <= 0) {
      this._replanTimer = 1 / this.skill.replanHz;
      this._noise = this.random() * 2 - 1;
      // A worse driver periodically commits to something unhelpful and has to
      // recover, which is what actually separates skill levels in a match.
      if (this.random() < this.skill.mistakeChance) {
        this._mistakeUntil = this.time + 0.4 + this.random() * 0.8;
      }
    }

    const lead = this.skill.prediction;
    const predicted = new Vec2(seen.x + seen.vx * lead, seen.y + seen.vy * lead);

    const ctx = {
      playerPosition: predicted,
      playerVelocity: new Vec2(seen.vx, seen.vy),
      playerHeading: seen.heading,
      playerTarget: world.target,
      selfPosition: new Vec2(this.robot.body.position.x, this.robot.body.position.y),
      selfHeading: this.robot.body.rotation.radians,
      fieldHalfSize: world.fieldHalfSize,
      time: this.time,
    };

    const behavior = BEHAVIORS[this.behaviorName] ?? BEHAVIORS.chaser;
    const intent = behavior(ctx, this.state);

    if (this.time < this._mistakeUntil) {
      // Mid-mistake: drive somewhere unhelpful rather than freezing, because a
      // frozen robot is easy to read and a committed wrong move is not.
      intent.point = new Vec2(
        intent.point.x + this._noise * 1.2,
        intent.point.y - this._noise * 1.2,
      );
    }

    this._command = intentToCommand(
      intent,
      ctx,
      this.skill,
      this.robot.drivetrain.canStrafe,
      this._noise,
    );

    this.robot.drivetrain.driveNormalized(
      this._command.forward,
      this._command.strafe,
      this._command.turn,
    );
    this.robot.updateControl(dt);
  }

  /** Physics-rate update. */
  stepPhysics(dt) {
    this.robot.stepPhysics(dt);
  }

  get command() {
    return this._command;
  }
}

/**
 * Deep-clone the shared config and apply the profile's build overrides.
 *
 * Cloning rather than sharing means an opponent keeps its own chassis and
 * gearing while still picking up global changes (tile friction, battery, solver
 * rate) the next time settings change.
 */
function buildConfig(baseConfig, overrides) {
  const clone = structuredClone(baseConfig);
  for (const [path, value] of Object.entries(overrides)) {
    const parts = path.split('.');
    let node = clone;
    for (let i = 0; i < parts.length - 1; i++) {
      node[parts[i]] ??= {};
      node = node[parts[i]];
    }
    node[parts[parts.length - 1]] = value;
  }
  return clone;
}

export { buildConfig };
