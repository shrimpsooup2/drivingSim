import { Vec2 } from '../math/Vec2.js';
import { blocker } from './behaviors.js';

/**
 * What an AI does when BIOBUZZ is actually running.
 *
 * The drill behaviours in `behaviors.js` are about the *player*: chase them,
 * block them, mirror them. That is the right thing for a manoeuvring exercise
 * and the wrong thing for a match, where three other robots have their own
 * jobs and mostly are not thinking about you at all. What makes a match feel
 * like a match is that the field empties while you are busy, your partner
 * either helps or does not, and the opposing HIVE tips whether or not you
 * noticed.
 *
 * So the plan here is driven by the robot's own mechanism. A robot with a
 * flywheel or a catapult cycles POLLEN into its CELL; one with only a lift or
 * a jaw fills FLOWERS, because G419 makes those two different mechanisms; one
 * with neither plays defence, because that is all it can do. Skill and build
 * quality then decide how *well* it does its job -- they never change what the
 * job is, the same way a good driver on a pushbot is still on a pushbot.
 *
 * Every plan returns an `AiIntent`, which `intentToCommand` turns into drive
 * commands and `Opponent` applies to the mechanisms. So an AI is always
 * driving the same robot the player drives, through the same subsystems, with
 * no privileged access to the field.
 *
 * @module
 */

/**
 * @typedef {object} AgentView what the AI knows about its own machine
 * @property {'red'|'blue'} alliance
 * @property {'cycler'|'flowerFiller'|'defender'|'tipper'} role
 * @property {import('../robot/biobuzz/Intake.js').Intake|null} intake
 * @property {import('../robot/biobuzz/Launcher.js').Launcher|import('../robot/biobuzz/Thrower.js').Thrower|null} launcher
 * @property {number} preferredRange
 * @property {boolean} jammed
 */

/** How slow the robot has to be before it will take a shot. */
const SHOT_SPEED = 0.18;
/** How closely it has to be pointed at the CELL. */
const SHOT_HEADING = 0.06;
/**
 * Clearance from the perimeter when picking somewhere to stand.
 *
 * Small on purpose. A CELL faces along the HIVE's arm and the only side a shot
 * can come from is outside its opening plane, which for the raised CELL is
 * within about half a metre of the far wall -- so a generous margin here does
 * not make the AI safer, it makes the shot impossible and the robot stands
 * around holding a full magazine.
 */
const WALL_MARGIN = 0.06;

/**
 * Half-extents of the keep-out box around the HIVE assembly, plus a robot's
 * worth of clearance.
 *
 * The two A-frames sit at x = +/-0.60 with their feet running from y = -0.49 to
 * +0.49 and their struts leaning inward, so the whole middle of the FIELD is
 * blocked in a band. A straight line from one side to the other goes through a
 * strut leg, and a robot driving it simply stops -- one pressed itself against
 * a strut for a whole MATCH at 0.7 power with four POLLEN aboard and a clear
 * shot two metres away. Going round is not an optimisation, it is the only way
 * across.
 */
const HIVE_KEEP_OUT = { halfX: 0.78, halfY: 0.66 };

/**
 * Pick a plan for this robot, or null if it has no business in the game (no
 * game running, or nothing to work with) and the caller should fall back to a
 * drill behaviour.
 *
 * @param {import('./behaviors.js').AiContext & {game: any, agent: AgentView}} ctx
 * @param {Record<string, any>} state per-opponent scratch space
 */
export function biobuzzPlan(ctx, state) {
  const { game, agent } = ctx;
  if (!game || !agent) return null;

  let intent;
  switch (agent.role) {
    case 'flowerFiller':
      intent = fillFlowers(ctx, state);
      break;
    case 'tipper':
      intent = cycleToCell(ctx, state, true);
      break;
    case 'defender':
      intent = defend(ctx, state);
      break;
    default:
      intent = cycleToCell(ctx, state, false);
  }

  // Every plan names a place to be and leaves the driving to someone else, so
  // the HIVE frame is dealt with once, here, rather than in each of them.
  const routed = routeAroundHive(ctx.selfPosition, intent.point);
  if (routed !== intent.point) {
    intent.point = routed;
    // On a detour it is going somewhere it does not mean to end up, so it
    // should not be settling, aiming or firing on arrival.
    intent.arrive = false;
    intent.faceHeading = undefined;
    intent.fire = false;
  }
  return intent;
}

/**
 * A waypoint that gets from `from` to `to` without driving into the HIVE.
 *
 * Two legs: get out into a clear lane past the end of the frame, run along it
 * until the frame is behind you, then the straight line works. Returns `to`
 * itself when the direct line is already clear, so the common case costs one
 * segment-box test.
 *
 * @param {Vec2} from
 * @param {Vec2} to
 */
export function routeAroundHive(from, to) {
  if (!segmentCrossesBox(from, to, HIVE_KEEP_OUT)) return to;

  // Whichever end of the frame makes the shorter way round.
  const lane = HIVE_KEEP_OUT.halfY + 0.14;
  const viaPlus = Math.abs(from.y - lane) + Math.abs(to.y - lane);
  const viaMinus = Math.abs(from.y + lane) + Math.abs(to.y + lane);
  const yLane = viaPlus <= viaMinus ? lane : -lane;

  // Not in the lane yet: get into it without changing x, which is a straight
  // sideways move for a mecanum and a short turn-and-go for a tank.
  if (Math.abs(from.y - yLane) > 0.16) return new Vec2(from.x, yLane);

  // In the lane: run along it until the frame is behind, then hand back over.
  const heading = Math.sign(to.x - from.x) || 1;
  const exit = heading * (HIVE_KEEP_OUT.halfX + 0.14);
  if (from.x * heading < exit * heading) return new Vec2(exit, yLane);
  return to;
}

/** Does the segment from `a` to `b` pass through an origin-centred box? */
function segmentCrossesBox(a, b, box) {
  // Cheap rejects first: both ends clear on the same side.
  if (Math.max(a.x, b.x) < -box.halfX || Math.min(a.x, b.x) > box.halfX) return false;
  if (Math.max(a.y, b.y) < -box.halfY || Math.min(a.y, b.y) > box.halfY) return false;

  const inside = (p) => Math.abs(p.x) <= box.halfX && Math.abs(p.y) <= box.halfY;
  if (inside(a) || inside(b)) return true;

  // Slab test along the segment.
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  let t0 = 0;
  let t1 = 1;
  for (const [origin, delta, half] of [
    [a.x, dx, box.halfX],
    [a.y, dy, box.halfY],
  ]) {
    if (Math.abs(delta) < 1e-9) {
      if (Math.abs(origin) > half) return false;
      continue;
    }
    let near = (-half - origin) / delta;
    let far = (half - origin) / delta;
    if (near > far) [near, far] = [far, near];
    t0 = Math.max(t0, near);
    t1 = Math.min(t1, far);
    if (t0 > t1) return false;
  }
  return true;
}

/**
 * Collect POLLEN and put it in your own raised CELL.
 *
 * `volley` is the tipper's variant: fill the magazine right up, then empty the
 * whole thing into the CELL in one go. Seven POLLEN in a raised CELL is what
 * takes the arm over, so trickling them in one at a time never tips anything
 * -- the HIVE just sits at its stop holding three. Going in bulk is the
 * strategy, and it is why a big magazine is worth carrying.
 *
 * @param {import('./behaviors.js').AiContext & {game: any, agent: AgentView}} ctx
 * @param {Record<string, any>} state
 * @param {boolean} volley
 */
export function cycleToCell(ctx, state, volley) {
  const { game, agent } = ctx;
  const { intake, launcher } = agent;
  // No launcher means no way into a CELL at all -- see G419 and Section 9.6.
  if (!launcher || !intake) return defend(ctx, state);

  const target = game.field.hiveTarget(agent.alliance);
  const wanted = volley ? intake.capacity : 1;

  // Commit, so it does not dither one element short of a volley or turn back
  // for another POLLEN with a loaded magazine.
  if (state.phase !== 'shooting' && intake.count >= wanted) state.phase = 'shooting';
  if (state.phase === 'shooting' && intake.count === 0) state.phase = 'collecting';
  if (!state.phase) state.phase = 'collecting';

  if (state.phase === 'collecting') return collect(ctx, state);

  // Can the shot be made from where it is standing? If so, stop and take it.
  const hive = game.field.hives[agent.alliance];
  const solution = launcher.aimFor(target);
  const depth = hive.openingDepth(hive.up, ctx.selfPosition.x, ctx.selfPosition.y, launcher.exitHeight);
  if (solution && depth > 0.05) {
    launcher.aimAt(target);
    const heading = Math.atan2(target.y - ctx.selfPosition.y, target.x - ctx.selfPosition.x);
    const aimed = Math.abs(wrapTo(heading - ctx.selfHeading)) < SHOT_HEADING;
    const still = ctx.selfSpeed < SHOT_SPEED;
    return {
      point: ctx.selfPosition.clone(),
      arrive: true,
      faceHeading: heading,
      aggression: 0.3,
      // Spinning up early is free on a flywheel and meaningless on a thrower,
      // so ask for it as soon as it is heading for a shot.
      spin: true,
      fire: aimed && still && launcher.ready,
    };
  }

  const spot = shootingSpot(ctx, state);
  return {
    point: spot,
    arrive: true,
    faceTarget: true,
    aggression: 0.8,
    spin: true,
  };
}

/**
 * Collect POLLEN and drop it into the top of a FLOWER.
 *
 * Worth 2 an element to whoever owns the FLOWER and, unlike a CELL, it cannot
 * be tipped back onto the floor -- which is the case for building a robot that
 * cannot shoot at all. The cost is that it is one element at a time, stopped,
 * beside a structure in a corner where it is easy to get pinned.
 *
 * @param {import('./behaviors.js').AiContext & {game: any, agent: AgentView}} ctx
 * @param {Record<string, any>} state
 */
export function fillFlowers(ctx, state) {
  const { game, agent } = ctx;
  const intake = agent.intake;
  if (!intake) return defend(ctx, state);

  if (intake.count === 0) return collect(ctx, state);

  // Holding a NECTAR before the FLOWERS open: G410 makes putting it in a
  // violation, so hold on to it and go and find POLLEN to be holding as well.
  const flowersOpen = Boolean(ctx.game?.match?.flowerUnlocked);
  if (!flowersOpen && intake.held[0]?.kind === 'nectar' && !intake.full) {
    return collect(ctx, state);
  }

  // Already lined up: stand still and run the lift.
  if (intake.alignedFlower()) {
    return {
      point: ctx.selfPosition.clone(),
      arrive: true,
      aggression: 0.2,
      intake: agent.jammed ? 0 : -1,
    };
  }

  const flower = nearestFlower(ctx, intake);
  if (!flower) return collect(ctx, state);

  // Stand off along the line from the FIELD centre, because every FLOWER is
  // against a wall and the only clear approach is from inside.
  const len = Math.hypot(flower.x, flower.y) || 1;
  const standoff = intake.robot.halfLength + intake.placeReach * 0.45;
  const point = new Vec2(
    flower.x - (flower.x / len) * standoff,
    flower.y - (flower.y / len) * standoff,
  );
  return {
    point: clampToField(point, ctx.fieldHalfSize, intake.robot.halfLength),
    arrive: true,
    faceHeading: Math.atan2(flower.y - ctx.selfPosition.y, flower.x - ctx.selfPosition.x),
    aggression: 0.7,
  };
}

/**
 * Get between the player and their own HIVE.
 *
 * The same blocker the drills use, given a real objective: in a match the
 * thing the player keeps going back to is their own CELL, so standing on that
 * line is what an actual defender does. A robot with no mechanism has nothing
 * else to offer, and that is most of a pushbot's match too -- it is in the way
 * whether it means to be or not.
 *
 * @param {import('./behaviors.js').AiContext & {game: any, agent: AgentView}} ctx
 * @param {Record<string, any>} state
 */
export function defend(ctx, state) {
  const { game, agent } = ctx;
  const enemy = agent.alliance === 'red' ? 'blue' : 'red';
  const target = game?.field?.hiveTarget?.(enemy);
  const objective = target ? new Vec2(target.x, target.y) : ctx.playerTarget;
  const intent = blocker({ ...ctx, playerTarget: objective }, state);
  intent.point = clampToField(intent.point, ctx.fieldHalfSize, 0.25);
  return intent;
}

/**
 * Drive at the nearest thing it can pick up, with the intake running.
 *
 * Loose POLLEN on the tiles first. With none left, the FLOWERS are the supply:
 * G418 allows POLLEN to be taken from the bottom of one, and the intake
 * already does it when the ROBOT drives up to a tube. That keeps the field
 * alive late in the MATCH, when everything loose has already been scored.
 *
 * @param {import('./behaviors.js').AiContext & {game: any, agent: AgentView}} ctx
 * @param {Record<string, any>} state
 */
export function collect(ctx, state) {
  const { game, agent } = ctx;
  const intake = agent.intake;
  const command = agent.jammed ? 0 : 1;

  // A FLOWER robot only wants NECTAR once the FLOWERS are open, and then it
  // wants it badly: ownership is the top-most NECTAR, and an owned FLOWER pays
  // 2 for *every* element in it, including all the POLLEN somebody else put
  // there. Before the unlock, carrying one there is a G410 violation, so it
  // leaves them alone. A CELL robot will take either -- a NECTAR is heavier,
  // which is worth knowing when a TIP is a few elements away.
  const flowersOpen = Boolean(ctx.game?.match?.flowerUnlocked);
  const wanted =
    agent.role === 'flowerFiller' && !flowersOpen ? ['pollen'] : ['pollen', 'nectar'];
  const prefer = agent.role === 'flowerFiller' && flowersOpen ? 'nectar' : null;

  const ball = nearestLooseElement(ctx, wanted, prefer);
  if (ball) {
    const point = new Vec2(ball.x, ball.y);
    return {
      point,
      faceHeading: Math.atan2(ball.y - ctx.selfPosition.y, ball.x - ctx.selfPosition.x),
      aggression: 0.9,
      intake: command,
    };
  }

  // Nothing loose. A CELL robot can pull POLLEN out of the bottom of a FLOWER
  // (G418) and put it up in its own HIVE, which is a real way to keep scoring
  // once the tiles are clear. A FLOWER robot obviously must not: taking an
  // element out of a FLOWER to put it back in another one is a loop that
  // scores nothing and empties a tube it had already filled.
  const flower = agent.role === 'flowerFiller' ? null : nearestFlower(ctx, intake, true);
  if (!flower) {
    return { point: ctx.selfPosition.clone(), arrive: true, aggression: 0.2, intake: 0 };
  }
  const len = Math.hypot(flower.x, flower.y) || 1;
  const standoff = (intake?.robot?.halfLength ?? 0.22) + 0.1;
  const point = new Vec2(
    flower.x - (flower.x / len) * standoff,
    flower.y - (flower.y / len) * standoff,
  );
  return {
    point: clampToField(point, ctx.fieldHalfSize, standoff),
    faceHeading: Math.atan2(flower.y - ctx.selfPosition.y, flower.x - ctx.selfPosition.x),
    aggression: 0.7,
    intake: command,
  };
}

/**
 * Somewhere to stand that has a shot.
 *
 * A CELL faces up and out along the HIVE's arm, so a shot can only arrive from
 * the outside of its opening plane -- and straight out along that normal at
 * shooting range is past the perimeter wall. So the search is over azimuths
 * around the target at the robot's preferred range: keep the ones that are on
 * the tiles and on the right side of the plane, and take whichever is closest
 * to where the robot already is.
 *
 * Cached per re-plan, because it only changes when the HIVE tips.
 *
 * @param {import('./behaviors.js').AiContext & {game: any, agent: AgentView}} ctx
 * @param {Record<string, any>} state
 */
export function shootingSpot(ctx, state) {
  const { game, agent } = ctx;
  const hive = game.field.hives[agent.alliance];
  const target = game.field.hiveTarget(agent.alliance);
  const launcher = agent.launcher;
  const clearance = (launcher?.robot?.halfLength ?? 0.22) + WALL_MARGIN;
  const limit = ctx.fieldHalfSize - clearance;

  let best = null;
  let bestScore = Infinity;
  // Every range the FIELD allows, ordered by how close it is to the one this
  // robot would rather shoot from.
  //
  // A ladder rather than a couple of multiples of the preference, because
  // whether a shot exists at a given range is the mechanism's business and not
  // something to encode twice. A catapult's arm stops at 72 degrees, so it
  // *cannot* shoot from 1.9 m even though its energy easily reaches -- the
  // lofted solution there wants 76. Hand-picking a preferred range and trying
  // a few multiples of it left it standing in the open holding four POLLEN. So
  // the preference orders the search and the launcher decides what is possible.
  const ranges = [];
  for (let r = 0.9; r <= 3.3; r += 0.15) ranges.push(r);
  ranges.sort((a, b) => Math.abs(a - agent.preferredRange) - Math.abs(b - agent.preferredRange));
  for (const range of ranges) {
    for (let i = 0; i < 36; i++) {
      const azimuth = (i / 36) * Math.PI * 2;
      const x = target.x + Math.cos(azimuth) * range;
      const y = target.y + Math.sin(azimuth) * range;
      if (Math.abs(x) > limit || Math.abs(y) > limit) continue;
      // Outside the opening plane, measured at the muzzle: inside it there is
      // no shot at any angle, however the hood is trimmed.
      if (hive.openingDepth(hive.up, x, y, launcher.exitHeight) <= 0) continue;
      // And the mechanism has to be able to make the shot from there. This is
      // the launcher's own solver evaluated at a hypothetical position rather
      // than a distance rule of thumb, so a catapult's hard maximum range and
      // a flywheel's "too close to drop in" both fall out of it for free.
      if (!launcher.aimFor(target, undefined, { x, y })) continue;
      const cost = Vec2.distance(ctx.selfPosition, new Vec2(x, y));
      if (cost < bestScore) {
        bestScore = cost;
        best = new Vec2(x, y);
      }
    }
    if (best) break;
  }
  if (best) state.shootingSpot = best;
  // Nothing found is possible mid-tip, when the raised CELL is rolling through
  // horizontal and faces nowhere useful. Hold the last spot rather than
  // stopping dead.
  return (state.shootingSpot ?? ctx.selfPosition).clone();
}

/**
 * The closest free element on the tiles of an acceptable kind, or null.
 *
 * `prefer` names a kind worth crossing the FIELD for: anything of that kind
 * beats anything else regardless of distance, which is the right call for a
 * FLOWER robot and a loose NECTAR.
 *
 * @param {import('./behaviors.js').AiContext & {game: any}} ctx
 * @param {string[]} kinds
 * @param {string|null} [prefer]
 */
function nearestLooseElement(ctx, kinds, prefer = null) {
  const balls = ctx.game?.field?.ballWorld?.balls;
  if (!balls) return null;
  let best = null;
  let bestDistance = Infinity;
  let bestPreferred = false;
  for (const ball of balls) {
    if (!ball.free || ball.outOfBounds) continue;
    if (!kinds.includes(ball.kind)) continue;
    // Anything still in the air is somebody else's shot, not a pickup.
    if (ball.z > 0.25) continue;
    const preferred = prefer !== null && ball.kind === prefer;
    if (bestPreferred && !preferred) continue;
    const d = Math.hypot(ball.x - ctx.selfPosition.x, ball.y - ctx.selfPosition.y);
    if (preferred && !bestPreferred) {
      bestPreferred = true;
      bestDistance = d;
      best = ball;
      continue;
    }
    if (d < bestDistance) {
      bestDistance = d;
      best = ball;
    }
  }
  return best;
}

/**
 * The closest FLOWER worth driving to.
 * @param {boolean} [forRetrieval] wanting one out of the bottom, not one in
 */
function nearestFlower(ctx, intake, forRetrieval = false) {
  const flowers = ctx.game?.field?.flowers ?? [];
  let best = null;
  let bestDistance = Infinity;
  for (const flower of flowers) {
    if (forRetrieval) {
      // G418 is POLLEN only, and a NECTAR at the bottom physically plugs the
      // FLOWER, so one that cannot give anything back is not a supply.
      const bottom = flower.stack[0];
      if (!bottom || bottom.kind !== 'pollen') continue;
    } else if (intake?.held?.length) {
      if (flower.restHeightFor(intake.held[0].radius) === null) continue;
    }
    const d = Math.hypot(flower.x - ctx.selfPosition.x, flower.y - ctx.selfPosition.y);
    if (d < bestDistance) {
      bestDistance = d;
      best = flower;
    }
  }
  return best;
}

function clampToField(point, halfSize, clearance) {
  const limit = halfSize - clearance - 0.02;
  return new Vec2(
    Math.max(-limit, Math.min(limit, point.x)),
    Math.max(-limit, Math.min(limit, point.y)),
  );
}

function wrapTo(angle) {
  let a = angle;
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
}
