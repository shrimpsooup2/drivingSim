import { Robot } from '../robot/Robot.js';
import { Vec2 } from '../math/Vec2.js';
import { DelayLine } from '../math/filters.js';
import { BEHAVIORS, intentToCommand } from './behaviors.js';
import { PROFILE_BY_ID, SKILL_BY_ID } from './profiles.js';
import {
  ARCHETYPE_BY_ID,
  QUALITY_BY_ID,
  chassisConfig,
  intakeOptions,
  launcherOptions,
  throwerOptions,
} from './archetypes.js';
import { biobuzzPlan } from './gamePlan.js';

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
/**
 * When an AI lets go of a PIN, and for how long.
 *
 * One of G421's three seconds, which is earlier than a driver watching the
 * REFEREE'S hand would peel off, and deliberately so: the REFEREE's count only
 * *pauses* when the ROBOTS separate, so anything still counting at three
 * seconds is a MAJOR FOUL however fast the retreat was. Reacting at two left
 * one second to open 2 ft, which the controller's own deceleration into the
 * backoff target did not manage, and the foul landed anyway.
 *
 * Then 3.2 seconds clear, because both of the rule's escape clauses need the
 * separation to hold for more than three seconds before the count ends, and
 * 2 ft (~61 cm) is the distance either of them asks for. The hold renews
 * itself while the REFEREE still has a count on this ROBOT, so in practice the
 * retreat lasts exactly as long as the PIN is on the books.
 */
const PIN_BACKOFF_AT = 1;
const PIN_BACKOFF_SECONDS = 3.2;
const PIN_BACKOFF_DISTANCE = 1;

/**
 * How far a driver's mistake throws the robot off, and the distance over which
 * it reaches full strength.
 *
 * Scaled by how far the robot is being asked to go, because a mistake is a
 * mistake in a *commanded motion* -- there is nothing to fumble when you are
 * already sitting where you meant to be. Flat, it produced the one thing no
 * driver of any skill does: a ROBOT that had settled into its own LOADING ZONE
 * with a second left would drive 0.85 m back out of it and give up the 5 PARK
 * points, because the re-plan that rolled the mistake did not care that the
 * drive was over.
 */
const MISTAKE_DISPLACEMENT = 1.2;
const MISTAKE_FULL_REACH = 1.2;

/**
 * How two ROBOTS get past each other.
 *
 * `TRAFFIC_CLEARANCE` is a little over the half-width of two 18 in ROBOTS side
 * by side, so it is the centre-to-centre distance at which they are about to
 * touch; `TRAFFIC_LOOKAHEAD` is how far down the intended line it is worth
 * caring about one.
 *
 * This exists because none of the plans know about the other three ROBOTS.
 * They name a place to be, and `intentToCommand` drives straight at it -- so a
 * ROBOT standing between here and there got pushed, for as long as the plan
 * held, which is a G421 MAJOR FOUL every three seconds. Backing off after the
 * REFEREE has started counting (`_avoidPinning`) treats the symptom and still
 * gave up 20 points a go; steering around traffic in the first place is what a
 * driver actually does, and it is the difference between four MAJOR FOULS a
 * MATCH and none.
 */
const TRAFFIC_CLEARANCE = 0.56;
const TRAFFIC_LOOKAHEAD = 0.9;
/**
 * How far *past* the other ROBOT the passing waypoint sits, and how long a
 * choice of side is committed for.
 *
 * Both exist because the first version had neither, and it went backwards. A
 * waypoint straight out to the side is a command to drive sideways, so the
 * ROBOT slid out of its own corridor, found the way clear, re-aimed at the
 * target, put the other ROBOT back in the corridor and slid back -- 13 seconds
 * of that netted 30 cm in the wrong direction. Aiming past the obstacle keeps
 * the forward component, and holding the side for a moment stops the two
 * states fighting each other at the re-plan rate.
 */
const TRAFFIC_PASS_AHEAD = 0.45;
const TRAFFIC_COMMIT_SECONDS = 1;

export class Opponent {
  /**
   * Two ways to specify the machine, because two different callers need them.
   *
   * `profileId` is the drills' way: a chassis build and nothing else, because a
   * manoeuvring exercise wants a shape to get around, not a robot with a
   * scoring plan. `archetypeId` plus `qualityId` is the match roster's way: a
   * scoring system, a build standard, and a role in the game.
   *
   * An archetype wins when both are given.
   *
   * @param {{
   *   id?: string,
   *   profileId?: string,
   *   archetypeId?: string,
   *   qualityId?: string,
   *   alliance?: 'red'|'blue',
   *   skillId: string,
   *   behavior?: keyof typeof BEHAVIORS,
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
    this.skill = SKILL_BY_ID[opts.skillId] ?? SKILL_BY_ID.competent;
    this.behaviorName = opts.behavior ?? 'chaser';

    /** @type {import('./archetypes.js').RobotArchetype|null} */
    this.archetype = opts.archetypeId ? ARCHETYPE_BY_ID[opts.archetypeId] ?? null : null;
    /** @type {import('./archetypes.js').BuildQuality|null} */
    this.quality = this.archetype
      ? QUALITY_BY_ID[opts.qualityId] ?? QUALITY_BY_ID.solid
      : null;
    this.profile = this.archetype ? null : PROFILE_BY_ID[opts.profileId] ?? PROFILE_BY_ID.rival;

    /** Which side it is on, when it is playing a MATCH rather than a drill. */
    this.alliance = opts.alliance ?? null;

    this.id = opts.id ?? `${(this.archetype ?? this.profile).id}-${this.behaviorName}`;
    /**
     * The id a MATCH knows this ROBOT by, once it has been entered in one.
     * Set by `BiobuzzGame.attachOpponents`; null on a bare field.
     * @type {string|null}
     */
    this.matchId = null;
    this.start = opts.start;
    this.state = { waypoints: opts.waypoints ?? [], waypointIndex: 0 };

    const overrides = this.archetype
      ? chassisConfig(this.archetype, this.quality)
      : this.profile.config;
    this.config = buildConfig(opts.baseConfig, overrides);
    this.robot = new Robot(this.config);
    this.robot.reset(this.start.x, this.start.y, this.start.heading);

    /**
     * Mechanisms, attached by `BiobuzzGame` when a MATCH starts -- the drills
     * run on a bare field and an opponent there has none.
     * @type {import('../robot/biobuzz/Intake.js').Intake|null}
     */
    this.intake = null;
    /** @type {import('../robot/biobuzz/Launcher.js').Launcher|import('../robot/biobuzz/Thrower.js').Thrower|null} */
    this.launcher = null;
    /** Set while a jam is costing it a cycle. */
    this._jammedUntil = 0;
    /** How many times its intake has seized this MATCH. */
    this.jams = 0;

    /** Wedged-detector state. See `_avoidWedging`. */
    this._stuckTimer = 0;
    this._detourUntil = 0;
    this._detourSign = 1;

    /** Which way it is going round traffic, and until when. See `_yieldToTraffic`. */
    this._passSide = 0;
    this._passUntil = 0;

    // The opponent only ever sees a delayed picture of the player.
    this.perception = new DelayLine(this.skill.reactionSeconds);
    this._command = { forward: 0, strafe: 0, turn: 0 };
    this._replanTimer = 0;
    this._noise = 0;
    this._mistakeUntil = 0;
    this.time = 0;
  }

  get color() {
    return (this.archetype ?? this.profile).color;
  }

  /** What this robot is, for the roster UI. */
  get label() {
    if (!this.archetype) return this.profile.name;
    return `${this.archetype.name} (${this.quality.name}, ${this.skill.name})`;
  }

  /** What it tries to do in a MATCH. */
  get role() {
    return this.archetype?.role ?? 'defender';
  }

  /**
   * Build the mechanisms this archetype has and hang them on the robot.
   *
   * Called by `BiobuzzGame`, which then wires them to the ball world -- the AI
   * gets exactly the subsystems the player gets, driven through exactly the
   * same methods. It has no way to score that the player does not have.
   *
   * @param {{Intake: any, Launcher: any, Thrower: any}} classes injected so the
   *   AI layer does not have to import the game's mechanisms and stay loadable
   *   without them
   */
  buildMechanisms(classes) {
    if (!this.archetype) return { intake: null, launcher: null };
    const random = this.random;

    const intakeOpts = intakeOptions(this.archetype, this.quality);
    if (intakeOpts && !this.intake) {
      this.intake = this.robot.addSubsystem(new classes.Intake(intakeOpts));
    }

    if (!this.launcher) {
      const flywheel = launcherOptions(this.archetype, this.quality);
      const thrower = throwerOptions(this.archetype, this.quality);
      if (flywheel) {
        this.launcher = this.robot.addSubsystem(new classes.Launcher({ ...flywheel, random }));
      } else if (thrower) {
        this.launcher = this.robot.addSubsystem(new classes.Thrower({ ...thrower, random }));
      }
    }
    if (this.launcher) this.launcher.intake = this.intake;
    return { intake: this.intake, launcher: this.launcher };
  }

  /** Take the mechanisms back off, so a drill gets a bare robot again. */
  removeMechanisms() {
    if (!this.intake && !this.launcher) return this;
    this.robot.subsystems = this.robot.subsystems.filter(
      (s) => s !== this.intake && s !== this.launcher,
    );
    this.intake = null;
    this.launcher = null;
    this.robot.updateMassProperties();
    return this;
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
    const overrides = this.archetype
      ? chassisConfig(this.archetype, this.quality)
      : this.profile.config;
    this.config = buildConfig(baseConfig, overrides);
    this.robot.applySettings(this.config, rebuild);
  }

  reset() {
    this.robot.reset(this.start.x, this.start.y, this.start.heading);
    this.perception.reset();
    this._command = { forward: 0, strafe: 0, turn: 0 };
    this._replanTimer = 0;
    this._mistakeUntil = 0;
    this._jammedUntil = 0;
    this._stuckTimer = 0;
    this._detourUntil = 0;
    this.jams = 0;
    this.time = 0;
    this.state.waypointIndex = 0;
    this.state.phase = undefined;
    this.state.shootingSpot = undefined;
  }

  /**
   * Control-rate update.
   * @param {number} dt
   * @param {{position: Vec2, velocity: Vec2, heading: number, target: Vec2|null, fieldHalfSize: number}} world
   */
  updateControl(dt, world) {
    this.time += dt;

    // G403 and G404: "ROBOTS are motionless between AUTO and TELEOP" and "at
    // the end of TELEOP". For a real ROBOT this is not a choice -- the AUTO
    // op-mode has stopped and nobody has started TELEOP yet -- and modelling it
    // matters now that the MATCH has a REFEREE: without it every AI robot took
    // a MAJOR FOUL and a YELLOW CARD in every MATCH it played, and the calls
    // list was mostly them.
    const phase = world.game?.match?.phase;
    if (phase === 'transition' || phase === 'ended') {
      this._standDown(dt);
      return;
    }

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

    // And a worse *robot* jams. That is the build, not the driver: an intake
    // that seizes on a POLLEN costs a cycle however well it is being driven.
    //
    // Rolled per second of elapsed time, not per re-plan. Per re-plan it was
    // scaled by the *driver's* skill, because a veteran re-plans at 12 Hz and a
    // rookie at 2.5 -- so a rough robot with a good driver jammed about once a
    // second and never scored at all, while the same robot with a poor driver
    // was mechanically reliable. Exactly backwards, and it made every rough
    // build take zero shots in a two-minute MATCH.
    const perMinute = this.quality?.jamsPerMinute ?? 0;
    if (perMinute > 0 && !this.jammed && this.random() < (perMinute / 60) * dt) {
      this._jammedUntil = this.time + 0.5 + this.random() * 1.2;
      this.jams += 1;
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
      selfSpeed: this.robot.body.speed,
      selfOmega: this.robot.body.angularVelocity,
      fieldHalfSize: world.fieldHalfSize,
      time: this.time,
      game: world.game ?? null,
      agent: this.agentView,
    };

    // With a MATCH running the robot plays the game; on a bare field it falls
    // back to the drill behaviour it was created with. Both go through the same
    // intent, so skill and imprecision apply the same way to either.
    //
    // A jam does *not* send it back to the drill behaviour, which is what
    // `this.jammed ? null : biobuzzPlan(...)` used to do here. A seized intake
    // is a mechanism failure, and the drill behaviours are about the player --
    // so a robot that jammed went from playing BIOBUZZ to chasing the player
    // across the FIELD, which is both nothing a real drive team does and, at
    // the buzzer, expensive: a jam in the last second drove a ROBOT that had
    // been sitting in its own LOADING ZONE 0.85 m out of it and gave up the 5
    // PARK points. The guard was belt-and-braces anyway -- `gamePlan` reads
    // `agent.jammed` and stops asking for intake and shots, and
    // `_applyMechanisms` holds the roller off and refuses to fire regardless.
    const planned = biobuzzPlan(ctx, this.state);
    const behavior = BEHAVIORS[this.behaviorName] ?? BEHAVIORS.chaser;
    const intent = planned ?? behavior(ctx, this.state);
    // Traffic first, because going around somebody is cheaper than either of
    // the recoveries below; then wedging, in case the detour itself jams; then
    // pinning, which is the most urgent and so gets the last word.
    this._yieldToTraffic(intent, ctx);
    this._avoidWedging(dt, intent, ctx);
    this._avoidPinning(dt, intent, ctx);

    // Driver mistakes are a TELEOP thing. AUTO is code: it does the same wrong
    // thing every time or the right one, and it does not lose concentration.
    // Modelling it here also had a rule consequence -- a 1.2 m displacement
    // during AUTO sent robots across the centre line into the opposing
    // ALLIANCE, which is a G402 MAJOR FOUL and a YELLOW CARD for something no
    // AUTO routine would do.
    if (this.time < this._mistakeUntil && phase !== 'auto') {
      // Mid-mistake: drive somewhere unhelpful rather than freezing, because a
      // frozen robot is easy to read and a committed wrong move is not.
      // Unhelpful in proportion to the drive, though -- see
      // MISTAKE_DISPLACEMENT.
      const reach = Math.hypot(
        intent.point.x - ctx.selfPosition.x,
        intent.point.y - ctx.selfPosition.y,
      );
      const scale = Math.min(1, reach / MISTAKE_FULL_REACH);
      const throwOff = this._noise * MISTAKE_DISPLACEMENT * scale;
      intent.point = new Vec2(intent.point.x + throwOff, intent.point.y - throwOff);
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
    this._applyMechanisms(intent);
    // No gamepad: the subsystems are driven by the intent above, not by a
    // controller, and passing one would have the intake read buttons that are
    // never pressed and switch itself off again every cycle.
    this.robot.updateControl(dt);
  }

  /**
   * Let go before the G421 3-count expires.
   *
   * "A ROBOT may not PIN an opponent's ROBOT for more than 3 seconds", and it
   * is a MAJOR FOUL and then another every three seconds it goes on -- the most
   * expensive thing an AI can do by accident, because it costs 20 points a go
   * and does not need any intent. A real driver watches the REFEREE'S hand and
   * peels off at two, which is what this does: it reads the same count the
   * REFEREE is keeping and drives away from whoever it is leaning on.
   *
   * Applied to every role, not just the defender, because the expensive case
   * was not a defender at all -- it was a cycler that found a stationary ROBOT
   * between it and its shooting spot and pushed into it for half a MATCH.
   *
   * @param {number} dt
   * @param {import('./behaviors.js').AiIntent} intent mutated in place
   * @param {import('./behaviors.js').AiContext} ctx
   */
  _avoidPinning(dt, intent, ctx) {
    const referee = ctx.game?.match?.referee;
    const id = this.matchId;
    if (!referee?.worstPin || !id) return;

    const { seconds, pinned } = referee.worstPin(id);
    if (seconds > PIN_BACKOFF_AT) {
      this._pinBackoffUntil = this.time + PIN_BACKOFF_SECONDS;
      this._backingOffFrom = pinned;
    }
    if (this.time >= (this._pinBackoffUntil ?? 0)) return;

    // Straight back from whoever is being leaned on, or straight back along the
    // robot's own heading if that ROBOT cannot be found -- a ROBOT pinning
    // somebody is pushing forward into them, so reversing is right either way.
    const target = this._pinnedPosition(ctx, this._backingOffFrom);
    const away = target
      ? Vec2.sub(ctx.selfPosition, target)
      : new Vec2(-Math.cos(ctx.selfHeading), -Math.sin(ctx.selfHeading));
    const len = away.length() || 1;
    intent.point = new Vec2(
      ctx.selfPosition.x + (away.x / len) * PIN_BACKOFF_DISTANCE,
      ctx.selfPosition.y + (away.y / len) * PIN_BACKOFF_DISTANCE,
    );
    intent.arrive = true;
    intent.faceHeading = undefined;
    intent.fire = false;
    intent.aggression = 0.8;
  }

  /** Where the ROBOT this one is pinning currently is, if the MATCH knows. */
  _pinnedPosition(ctx, pinnedId) {
    if (!pinnedId) return null;
    const entry = ctx.game?.match?.entries?.find((e) => e.id === pinnedId);
    if (!entry?.robot?.body) return null;
    return new Vec2(entry.robot.body.position.x, entry.robot.body.position.y);
  }

  /**
   * Stop commanding anything, between the periods and after the buzzer.
   *
   * De-energised rather than braked: the rule excuses "movement due to
   * inertia, gravity, or de-energizing of actuators", so a ROBOT still rolling
   * when the buzzer goes is fine and one holding itself still under power is
   * not.
   *
   * @param {number} dt
   */
  _standDown(dt) {
    this._command = { forward: 0, strafe: 0, turn: 0 };
    this.robot.drivetrain.driveNormalized(0, 0, 0);
    if (this.intake) this.intake.command = 0;
    if (this.launcher?.needsSpinUp) this.launcher.spinning = false;
    this.robot.updateControl(dt);
    return this;
  }

  /**
   * Steer around a ROBOT standing between here and where it is going.
   *
   * Only traffic gets steered around, not the destination: a ROBOT sitting at
   * the intent point is the thing being driven *to*, which is what a defender
   * blocking the player is doing, and swerving away from it would make the
   * whole role impossible.
   *
   * The detour is a single waypoint off to one side, recomputed every cycle, so
   * it behaves like a driver leaning on the stick to slide past rather than a
   * planned path. It picks the side the other ROBOT is not on, and when that is
   * ambiguous it goes toward open FIELD -- the same reasoning as `_avoidWedging`,
   * for the same reason: half the time a coin flip picks the wall.
   *
   * @param {import('./behaviors.js').AiIntent} intent mutated in place
   * @param {import('./behaviors.js').AiContext} ctx
   */
  _yieldToTraffic(intent, ctx) {
    const entries = ctx.game?.match?.entries;
    if (!entries || !this.matchId) return intent;

    const dx = intent.point.x - ctx.selfPosition.x;
    const dy = intent.point.y - ctx.selfPosition.y;
    const distance = Math.hypot(dx, dy);
    if (distance < 1e-6) return intent;
    const ux = dx / distance;
    const uy = dy / distance;

    let worst = null;
    for (const entry of entries) {
      if (!entry?.robot?.body || entry.id === this.matchId) continue;
      const px = entry.robot.body.position.x;
      const py = entry.robot.body.position.y;
      // The destination, not traffic.
      if (Math.hypot(px - intent.point.x, py - intent.point.y) < TRAFFIC_CLEARANCE) continue;

      const rx = px - ctx.selfPosition.x;
      const ry = py - ctx.selfPosition.y;
      const along = rx * ux + ry * uy;
      if (along <= 0 || along > Math.min(distance, TRAFFIC_LOOKAHEAD)) continue;
      const across = rx * -uy + ry * ux;
      if (Math.abs(across) >= TRAFFIC_CLEARANCE) continue;
      if (!worst || along < worst.along) worst = { along, across };
    }
    if (!worst) return intent;

    let side = this.time < this._passUntil ? this._passSide : 0;
    if (side === 0) {
      side = Math.abs(worst.across) > 1e-3 ? -Math.sign(worst.across) : 0;
      if (side === 0) {
        // Dead ahead: go the way that is not the nearest wall.
        const toCentre = -(ctx.selfPosition.x * -uy + ctx.selfPosition.y * ux);
        side = Math.abs(toCentre) > 1e-3 ? Math.sign(toCentre) : 1;
      }
    }
    this._passSide = side;
    this._passUntil = this.time + TRAFFIC_COMMIT_SECONDS;

    const shift = TRAFFIC_CLEARANCE + 0.12;
    const ahead = worst.along + TRAFFIC_PASS_AHEAD;
    intent.point = new Vec2(
      ctx.selfPosition.x + ux * ahead + -uy * side * shift,
      ctx.selfPosition.y + uy * ahead + ux * side * shift,
    );
    // Going somewhere it does not mean to end up, so it is not settling,
    // aiming or firing on arrival -- the same handling `routeAroundHive` gets.
    intent.arrive = false;
    intent.faceHeading = undefined;
    intent.faceTarget = false;
    intent.fire = false;
    return intent;
  }

  /**
   * Notice when it is wedged and go around.
   *
   * None of the behaviours know about the FIELD's furniture -- they name a
   * place to be and leave the driving to this. Drive straight at a point and
   * the HIVE's A-frame is squarely in the way of half the FIELD: one opponent
   * pressed itself against a strut at half power for the whole MATCH,
   * commanding 0.7 forward and travelling at 0.00 m/s, four POLLEN in the
   * magazine and a clear shot two metres away.
   *
   * So: if it is asking to move, is not moving, and has been like that for
   * most of a second, commit to a sidestep for a moment. Which side is
   * arbitrary, and that is fine -- it is what a driver does when they feel the
   * robot stop. Sliding perpendicular is also the right move specifically for
   * the A-frame, whose legs are narrow.
   *
   * Cheaper and more general than pathfinding, and it works on the other three
   * ROBOTS too, which no static map would.
   *
   * @param {number} dt
   * @param {import('./behaviors.js').AiIntent} intent mutated in place
   * @param {import('./behaviors.js').AiContext} ctx
   */
  _avoidWedging(dt, intent, ctx) {
    const dx = intent.point.x - ctx.selfPosition.x;
    const dy = intent.point.y - ctx.selfPosition.y;
    const distance = Math.hypot(dx, dy);
    const wants = distance > 0.22;
    const moving = ctx.selfSpeed > 0.12 || Math.abs(ctx.selfOmega ?? 0) > 0.5;

    if (wants && !moving) this._stuckTimer += dt;
    else this._stuckTimer = Math.max(0, this._stuckTimer - dt * 2);

    if (this._stuckTimer > 0.7 && this.time > this._detourUntil) {
      this._detourUntil = this.time + 1.4;
      // Sidestep toward open FIELD rather than to a coin-flip side. Half the
      // time a random sign pushes it further into the wall it is already on,
      // and it sits there grinding until the timer runs out and flips again.
      const nx = -dy / (distance || 1);
      const ny = dx / (distance || 1);
      const toCentre = -(ctx.selfPosition.x * nx + ctx.selfPosition.y * ny);
      this._detourSign =
        Math.abs(toCentre) > 0.2 ? Math.sign(toCentre) : this.random() < 0.5 ? 1 : -1;
      this._stuckTimer = 0;
    }

    if (this.time < this._detourUntil && distance > 1e-6) {
      // Perpendicular to where it was trying to go, by more than a robot
      // width, *and* a little backwards. Backing off first is what actually
      // unwedges it: sliding sideways while still leaning on the obstacle just
      // scrubs along it.
      const nx = -dy / distance;
      const ny = dx / distance;
      intent.point = new Vec2(
        ctx.selfPosition.x + nx * this._detourSign * 0.9 - (dx / distance) * 0.3,
        ctx.selfPosition.y + ny * this._detourSign * 0.9 - (dy / distance) * 0.3,
      );
      // Free to point wherever suits the detour: holding an aim while wedged is
      // how it stayed wedged.
      intent.faceHeading = undefined;
      intent.faceTarget = false;
      intent.arrive = false;
      intent.fire = false;
    }
    return intent;
  }

  /** Whether it is currently working its way out of being wedged. */
  get detouring() {
    return this.time < this._detourUntil;
  }

  /** Whether a jam is currently costing it a cycle. */
  get jammed() {
    return this.time < this._jammedUntil;
  }

  /** What `gamePlan` needs to know about this machine. */
  get agentView() {
    if (!this.archetype) return null;
    return {
      /** The MATCH's id for this ROBOT, which is what the REFEREE records. */
      id: this.matchId ?? this.id,
      alliance: this.alliance ?? 'blue',
      role: this.archetype.role,
      intake: this.intake,
      launcher: this.launcher,
      preferredRange: this.archetype.preferredRange ?? 1.7,
      jammed: this.jammed,
    };
  }

  /**
   * Hand the intent to the mechanisms.
   *
   * Exactly the calls a driver's buttons make: set the intake's command, ask
   * the launcher to spin, ask it to fire. The AI has no shortcut into the ball
   * world, so an opponent's shot is subject to the same recovery, the same
   * droop and the same aperture as the player's.
   *
   * @param {import('./behaviors.js').AiIntent} intent
   */
  _applyMechanisms(intent) {
    if (this.intake) {
      const jammed = this.jammed;
      this.intake.command = jammed ? 0 : (intent.intake ?? 0);
    }
    if (this.launcher) {
      if (this.launcher.needsSpinUp) this.launcher.spinning = Boolean(intent.spin);
      if (intent.fire && !this.jammed) this.launcher.fire();
    }
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
