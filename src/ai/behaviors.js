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
 * @typedef {{point: Vec2, faceTarget?: boolean, aggression?: number}} AiIntent
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
  const gain = 2.4;
  const cap = skill.maxPower * clamp(distance * 1.8, 0.25, 1);
  forward = clamp(forward * gain, -cap, cap);
  strafe = canStrafe ? clamp(strafe * gain, -cap, cap) : 0;

  let turn = 0;
  const bearing = Math.atan2(dy, dx);
  if (!canStrafe) {
    // A tank opponent has to point where it is going.
    const error = wrapAngle(bearing - ctx.selfHeading);
    turn = clamp(error * 1.8, -skill.maxPower, skill.maxPower);
    if (Math.abs(error) > 1.0) forward = 0;
  } else if (intent.faceTarget) {
    const error = wrapAngle(bearing - ctx.selfHeading);
    turn = clamp(error * 1.5, -skill.maxPower * 0.8, skill.maxPower * 0.8);
  }

  // Skill noise: a rookie's commands are visibly imprecise.
  forward += noise * skill.aimNoise;
  strafe += noise * skill.aimNoise * 0.6;

  return {
    forward: clamp(forward, -1, 1),
    strafe: clamp(strafe, -1, 1),
    turn: clamp(turn, -1, 1),
  };
}
