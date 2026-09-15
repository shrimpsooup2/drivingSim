import { Vec2 } from '../math/Vec2.js';
import { clamp, wrapAngle } from '../math/MathUtil.js';

/**
 * What an opponent is trying to do.
 *
 * Each behaviour only decides *where it wants to be*; converting that into
 * drive commands is shared, so behaviours stay small and comparable and a new
 * one is a few lines.
 *
 * @typedef {object} AiContext
 * @property {Vec2} playerPosition   as the opponent believes it to be (delayed)
 * @property {Vec2} playerVelocity
 * @property {number} playerHeading
 * @property {Vec2|null} playerTarget the objective the player is heading for
 * @property {Vec2} selfPosition
 * @property {number} selfHeading
 * @property {number} fieldHalfSize
 * @property {number} time
 *
 * @property {number} [selfSpeed]     how fast it is going, m/s
 * @property {number} [selfOmega]     and how fast it is turning, rad/s
 * @property {object} [game]           the BIOBUZZ game, when one is running
 * @property {object} [agent]          its own mechanisms; see `gamePlan.js`
 *
 * @typedef {object} AiIntent
 * @property {Vec2} point         where it wants to be
 * @property {boolean} [faceTarget] point at `point` while driving to it
 * @property {number} [faceHeading] hold this absolute heading instead, which is
 *   what aiming needs: a shot leaves along the ROBOT's nose, not along its path
 * @property {boolean} [arrive]   stop on the point rather than pushing through
 * @property {number} [aggression]
 * @property {-1|0|1} [intake]    run the intake in, out, or not at all
 * @property {boolean} [spin]     bring the launcher up to speed
 * @property {boolean} [fire]     take the shot now
 */

/**
 * Get between the player and where they are going.
 *
 * The genuinely annoying defender: it does not chase, it *denies*. Standing on
 * the line between the player and their objective is far more effective than
 * pursuit, and learning to go around it is the skill this trains.
 */
export function blocker(ctx) {
  const target = ctx.playerTarget;
  if (!target) return { point: ctx.playerPosition.clone(), aggression: 0.6 };

  const toTarget = Vec2.sub(target, ctx.playerPosition);
  const distance = toTarget.length();
  if (distance < 1e-3) return { point: target.clone(), aggression: 0.8 };

  // Sit a third of the way along the player's path, favouring the target end so
  // it arrives before the player does.
  const t = clamp(0.55, 0, 1);
  const point = new Vec2(
    ctx.playerPosition.x + toTarget.x * t,
    ctx.playerPosition.y + toTarget.y * t,
  );
  return { point, faceTarget: true, aggression: 0.85 };
}

/** Straightforward pursuit: drive at the player and push. */
export function chaser(ctx) {
  return { point: ctx.playerPosition.clone(), faceTarget: true, aggression: 1 };
}

/**
 * Mirror the player across the field centre.
 *
 * Produces an opponent that is always roughly opposite you, so the field stays
 * contested without it ever committing to a chase.
 */
export function shadow(ctx) {
  return {
    point: new Vec2(-ctx.playerPosition.x, -ctx.playerPosition.y),
    aggression: 0.5,
  };
}

/**
 * Drive a fixed loop regardless of the player: a moving obstacle with
 * predictable timing, which is what makes it a *timing* exercise rather than a
 * reaction one.
 */
export function patroller(ctx, state) {
  const waypoints = state.waypoints ?? [];
  if (waypoints.length === 0) return { point: ctx.selfPosition.clone() };
  const current = waypoints[state.waypointIndex % waypoints.length];
  if (Vec2.distance(ctx.selfPosition, current) < 0.28) state.waypointIndex++;
  return { point: current.clone(), aggression: 0.4 };
}

/**
 * Park on the player's objective and sit there.
 * Forces the player to either wait it out or shove it off.
 */
export function camper(ctx) {
  const target = ctx.playerTarget ?? ctx.playerPosition;
  return { point: target.clone(), aggression: 0.9 };
}

export const BEHAVIORS = { blocker, chaser, shadow, patroller, camper };

/**
 * Turn an intent into drive commands.
 *
 * Shared by every behaviour so they differ only in where they want to be, and
 * so skill level applies uniformly: a rookie and a veteran running the same
 * behaviour differ in reaction, precision and commitment, not in tactics.
 *
 * @param {AiIntent} intent
 * @param {AiContext} ctx
 * @param {import('./profiles.js').SkillLevel} skill
 * @param {boolean} canStrafe
 * @param {number} noise deterministic-ish jitter in [-1, 1]
 */
export function intentToCommand(intent, ctx, skill, canStrafe, noise) {
  const dx = intent.point.x - ctx.selfPosition.x;
  const dy = intent.point.y - ctx.selfPosition.y;
  const distance = Math.hypot(dx, dy);

  const cos = Math.cos(-ctx.selfHeading);
  const sin = Math.sin(-ctx.selfHeading);
  let forward = dx * cos - dy * sin;
  let strafe = dx * sin + dy * cos;

  // Ease off close in, so it settles instead of oscillating on the spot.
  // `arrive` is for a robot that means to *stand* somewhere -- lined up on a
  // CELL, or beside a FLOWER with a lift running. Without it the approach caps
  // out at a quarter power and keeps nudging, which is fine for a blocker
  // leaning on you and useless for anything that has to hold still and aim.
  const gain = intent.arrive ? 3.2 : 2.4;
  const floor = intent.arrive ? 0 : 0.25;
  const cap = skill.maxPower * clamp(distance * 1.8 * (intent.aggression ?? 1), floor, 1);

  // Scale the pair together rather than clamping each axis.
  //
  // Clamping them separately loses the direction: past about 300 mm both axes
  // saturate at the cap and the robot drives at 45 degrees to wherever it was
  // actually going, whatever the bearing. An opponent crossing the FIELD
  // crabbed sideways at 0.15 m/s and took twenty seconds to reach a shooting
  // spot two metres away.
  const magnitude = Math.hypot(forward, canStrafe ? strafe : 0) || 1;
  const wanted = Math.min(cap, magnitude * gain);
  forward = (forward / magnitude) * wanted;
  strafe = canStrafe ? (strafe / magnitude) * wanted : 0;

  let turn = 0;
  const bearing = Math.atan2(dy, dx);
  // Proportional on heading error, damped on the rate. Without the damping term
  // it is a pure P loop at the control rate against a chassis with plenty of
  // rotational authority, so it overshoots, comes back, overshoots again -- and
  // because translation and rotation share the same actuator budget, a robot
  // oscillating about its heading also stops going anywhere. One crossed the
  // FIELD at 0.05 m/s doing exactly this.
  const damping = (ctx.selfOmega ?? 0) * 0.22;
  const aim = (error, kP, cap) => clamp(error * kP - damping, -cap, cap);
  if (intent.faceHeading !== undefined) {
    // Holding an absolute heading, because a shot leaves along the nose.
    const error = wrapAngle(intent.faceHeading - ctx.selfHeading);
    turn = aim(error, 2.2, skill.maxPower);
    // A tank has to choose between pointing and going; pointing wins, because
    // it cannot shoot sideways at all.
    if (!canStrafe && Math.abs(error) > 0.35) forward = 0;
  } else if (!canStrafe) {
    // A tank opponent has to point where it is going.
    const error = wrapAngle(bearing - ctx.selfHeading);
    turn = aim(error, 1.8, skill.maxPower);
    if (Math.abs(error) > 1.0) forward = 0;
  } else if (intent.faceTarget) {
    const error = wrapAngle(bearing - ctx.selfHeading);
    // Deliberately gentle: a mecanum does not need to point where it is going,
    // so facing the objective is a preference and must not cost it the drive.
    turn = aim(error, 1.1, skill.maxPower * 0.45);
  }

  // Skill noise: a rookie's commands are visibly imprecise. Held back while
  // arriving, or a rookie could never line up on anything at all -- their
  // imprecision should cost them time, not make a mechanism unusable.
  const imprecision = intent.arrive ? skill.aimNoise * 0.35 : skill.aimNoise;
  forward += noise * imprecision;
  strafe += noise * imprecision * 0.6;

  // Share the available authority between driving and turning the way a real
  // op-mode does. `driveNormalized` would otherwise desaturate the wheels for
  // us, but it does that *after* the three terms have been mixed, so a
  // saturated turn eats most of the translation and the robot spends its match
  // spinning slowly across the tiles.
  const sum = Math.abs(forward) + Math.abs(strafe) + Math.abs(turn);
  const scale = sum > 1 ? 1 / sum : 1;

  return {
    forward: clamp(forward * scale, -1, 1),
    strafe: clamp(strafe * scale, -1, 1),
    turn: clamp(turn * scale, -1, 1),
  };
}
