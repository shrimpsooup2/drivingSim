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
 * The two things a ROBOT can actually hit in the middle of the FIELD, as
 * centre-of-robot keep-out boxes.
 *
 * **Two boxes, not one.** This was a single box spanning `|x| < 0.78`, which is
 * wrong in the expensive direction: it declared the whole middle of the FIELD
 * blocked, including the corridor *between* the A-frames that a ROBOT really
 * can drive through. Worse, anything inside it was unroutable -- the segment
 * test reports a crossing whenever an endpoint is inside the box -- so every
 * element the HIVE dropped when it TIPPED landed in a region the AI would
 * circle forever without ever reaching. A cycler spent 100 seconds of a
 * 120-second TELEOP "collecting" without picking anything up.
 *
 * The real geometry (`BiobuzzField._buildObstacles`) is a foot bar at
 * `|x|` 0.578 to 0.629 running from y -0.495 to +0.495, plus the reachable
 * shadow of each strut leaning in to `|x|` 0.483. Inflated by a robot's
 * half-extent, that is a box a foot wide either side of centre, with 0.53 m of
 * clear corridor down the middle and the whole FIELD open beyond `|y| > 0.71`.
 */
const FRAME_HALF_X = 0.073 + 0.216;
const FRAME_HALF_Y = 0.495 + 0.216;
const FRAME_CENTRE_X = 0.556;
const HIVE_FRAMES = [
  { centreX: -FRAME_CENTRE_X, halfX: FRAME_HALF_X, halfY: FRAME_HALF_Y },
  { centreX: FRAME_CENTRE_X, halfX: FRAME_HALF_X, halfY: FRAME_HALF_Y },
];
/** The y a ROBOT runs along to pass the frames: clear of both, inside the wall. */
const FRAME_LANE = FRAME_HALF_Y + 0.14;
/**
 * How far outside a frame box a point gets pushed.
 *
 * `FRAME_NUDGE` moves a *destination* just clear, because an element resting
 * against a foot bar still has to be reachable and an intake reaches four to
 * six inches. `FRAME_ESCAPE` moves a *ROBOT* clear, and has to be bigger than
 * the distance at which the drive controller bothers to move at all.
 */
const FRAME_NUDGE = 0.02;
const FRAME_ESCAPE = 0.3;

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

  // PARK is 5 points and it is only judged where the ROBOT is when the buzzer
  // goes (Section 10.5.4), so there is no reason to be anywhere else at the
  // end -- and no AI robot was ever collecting it. Long enough before the
  // buzzer to cross the FIELD, short enough not to give up a cycle.
  const remaining = game.match?.teleopRemaining ?? Infinity;

  let intent;
  if (game.match?.driverControl && remaining <= PARK_SECONDS) {
    // Not an early return: a PARK has to get round the HIVE like anything else.
    // It used to return straight out of here, above the routing below, so a
    // ROBOT on the far side of an A-frame from its own LOADING ZONE drove into
    // the frame and ground against it until the buzzer. That was most of the
    // AI PARKS that never happened.
    intent = parkInLoadingZone(ctx);
  } else {
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
  // A ROBOT that has been shoved into a frame gets itself out first; from
  // inside, every route "crosses" and nothing else can be decided.
  //
  // By a good margin, not by the hair's breadth a destination gets nudged: an
  // escape has to be far enough away to read as a command to move. At 2 cm it
  // was not. A ROBOT resting exactly on the frame boundary was told to go 2 cm
  // clear, which is inside the drive controller's deadband, so it crept, fell
  // back inside, and was told the same thing again -- for the rest of the
  // MATCH. `_avoidWedging` does not rescue it either, because it only counts a
  // ROBOT as wanting to move when its target is more than 22 cm away.
  const escape = nudgeClearOfFrames(from, FRAME_ESCAPE);
  if (escape) return escape;

  // A destination inside a frame is not a destination -- an element resting
  // against a foot bar cannot be driven onto. Stand at the edge instead and let
  // the intake reach the rest of the way; it reaches four to six inches, which
  // is more than the nudge moves.
  const target = nudgeClearOfFrames(to) ?? to;

  if (!HIVE_FRAMES.some((f) => segmentCrossesFrame(from, target, f))) return target;

  // Round the end of the frames. Which end is forced whenever the ROBOT is
  // already past them in y: the lane on the *other* side is on the far side of
  // the frame, so routing to it is a command to drive through the thing being
  // avoided. That is what used to happen to a ROBOT above the frames heading
  // for a LOADING ZONE below them -- it was sent to the lane at -y, pressed
  // into the A-frame at the corner, and spent the rest of the MATCH there
  // alternating between the escape nudge and the route that caused it.
  //
  // Otherwise -- in the corridor between the frames, or out beyond their ends
  // in x -- either lane is reachable, so prefer the target's own side when it
  // is past them, else the shorter way round.
  let yLane;
  const fromSide = Math.abs(from.y) > FRAME_HALF_Y ? Math.sign(from.y) : 0;
  if (fromSide !== 0) {
    yLane = fromSide * FRAME_LANE;
  } else if (Math.abs(target.y) > FRAME_HALF_Y) {
    yLane = Math.sign(target.y) * FRAME_LANE;
  } else {
    const viaPlus = Math.abs(from.y - FRAME_LANE) + Math.abs(target.y - FRAME_LANE);
    const viaMinus = Math.abs(from.y + FRAME_LANE) + Math.abs(target.y + FRAME_LANE);
    yLane = viaPlus <= viaMinus ? FRAME_LANE : -FRAME_LANE;
  }

  // Not in the lane yet: get into it without changing x, which is a straight
  // sideways move for a mecanum and a short turn-and-go for a tank.
  if (Math.abs(from.y - yLane) > 0.16) return new Vec2(from.x, yLane);

  // In the lane and clear of both frames in y, so running along it to the
  // target's own x is always safe. From there the last leg is a straight line
  // at an x the frames do not occupy, because `target` was nudged out of them.
  return new Vec2(target.x, yLane);
}

/**
 * The nearest point outside every frame box, or null if the point is already
 * clear.
 *
 * Pushed out along whichever face is closest, which for an element in the
 * corridor beside a foot bar means stepping inward into the corridor rather
 * than all the way round the frame.
 *
 * @param {Vec2} p
 */
function nudgeClearOfFrames(p, margin = FRAME_NUDGE) {
  for (const frame of HIVE_FRAMES) {
    const dx = p.x - frame.centreX;
    if (Math.abs(dx) > frame.halfX || Math.abs(p.y) > frame.halfY) continue;
    const outX = frame.halfX - Math.abs(dx);
    const outY = frame.halfY - Math.abs(p.y);
    if (outX <= outY) {
      const side = Math.sign(dx) || (frame.centreX < 0 ? 1 : -1);
      return new Vec2(frame.centreX + side * (frame.halfX + margin), p.y);
    }
    const side = Math.sign(p.y) || 1;
    return new Vec2(p.x, side * (frame.halfY + margin));
  }
  return null;
}

/** Does the segment from `a` to `b` pass through one frame's keep-out box? */
function segmentCrossesFrame(a, b, frame) {
  const ax = a.x - frame.centreX;
  const bx = b.x - frame.centreX;
  // Cheap rejects first: both ends clear on the same side.
  if (Math.max(ax, bx) < -frame.halfX || Math.min(ax, bx) > frame.halfX) return false;
  if (Math.max(a.y, b.y) < -frame.halfY || Math.min(a.y, b.y) > frame.halfY) return false;

  const inside = (x, y) => Math.abs(x) <= frame.halfX && Math.abs(y) <= frame.halfY;
  if (inside(ax, a.y) || inside(bx, b.y)) return true;

  // Slab test along the segment.
  const dx = bx - ax;
  const dy = b.y - a.y;
  let t0 = 0;
  let t1 = 1;
  for (const [origin, delta, half] of [
    [ax, dx, frame.halfX],
    [a.y, dy, frame.halfY],
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
  const wanted = Math.max(1, intake.capacity);

  // Fill up before driving anywhere.
  //
  // A cycler used to leave as soon as it had *one* element, which meant paying
  // the whole drive to a shooting spot and back for every single POLLEN: 100
  // seconds of a 120-second TELEOP spent collecting and 20 spent shooting. The
  // drive is the expensive part, so the magazine is what it is for.
  //
  // With patience, though -- late in a MATCH there may be nothing left to fill
  // up with, and a ROBOT holding two POLLEN and waiting for a third scores
  // nothing at all. `volley` waits longer, because a tipper needs a real load:
  // seven elements in a raised CELL is what takes the arm over, so trickling
  // them in never TIPS anything.
  if (!state.phase) state.phase = 'collecting';
  if (state.phase !== 'shooting') {
    if (state.fillCount !== intake.count) {
      state.fillCount = intake.count;
      state.fillSince = ctx.time;
    }
    const patience = volley ? FILL_PATIENCE * 2 : FILL_PATIENCE;
    const waited = ctx.time - (state.fillSince ?? ctx.time);
    if (intake.count >= wanted || (intake.count > 0 && waited > patience)) {
      state.phase = 'shooting';
    }
  }
  if (state.phase === 'shooting' && intake.count === 0) {
    state.phase = 'collecting';
    state.fillSince = ctx.time;
  }

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
  // Spin up for the shot it is *going* to take, not the one it cannot take
  // from here. A flywheel has no brake, so arriving 300 rpm fast means sitting
  // there for three seconds while it coasts down -- and arriving already at
  // the right speed is exactly what a driver does on the way to their spot.
  launcher.aimAt(target, undefined, spot);
  return {
    point: spot,
    arrive: true,
    faceTarget: true,
    aggression: 0.8,
    spin: true,
  };
}

/**
 * How long a ROBOT keeps trying to fill its magazine before going to shoot
 * with what it has.
 *
 * Two and a half seconds of nothing arriving means nothing is coming: either
 * everything nearby is gone or the thing it is driving at is not gettable.
 * Either way, what it is holding is worth more in a CELL than in the intake.
 */
const FILL_PATIENCE = 2.5;

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
/**
 * How long before the buzzer an AI heads for its LOADING ZONE.
 *
 * Six seconds crosses the FIELD with something in hand, which is all PARK
 * needs: it is judged on where the ROBOT is at the buzzer and nothing else.
 */
const PARK_SECONDS = 6;

/**
 * Drive into the middle of this ALLIANCE'S own LOADING ZONE.
 *
 * `Match.parked` wants the ROBOT's box overlapping the zone, so the middle of
 * it is comfortably enough, and it keeps clear of the perimeter wall.
 *
 * @param {import('./behaviors.js').AiContext & {game: any, agent: AgentView}} ctx
 */
function parkInLoadingZone(ctx) {
  const zones = ctx.game?.field?.zones;
  const zone = ctx.agent?.alliance === 'blue' ? zones?.blueLoading : zones?.redLoading;
  if (!zone) {
    return { point: ctx.selfPosition.clone(), arrive: true, aggression: 0.2, intake: 0 };
  }
  const inward = zone.centerX < 0 ? 1 : -1;
  const point = new Vec2(zone.centerX + inward * zone.width * 0.25, zone.centerY);
  return {
    point: clampToField(point, ctx.fieldHalfSize, 0.24),
    arrive: true,
    aggression: 0.85,
    // Still collecting on the way in: a POLLEN swept up en route is free, and
    // an element in the intake at the buzzer costs nothing.
    intake: ctx.agent?.jammed ? 0 : 1,
  };
}

/**
 * Whether a point is on this ALLIANCE'S own half of the FIELD, by at least
 * `margin`.
 *
 * G402: "During AUTO, FIELD columns A, B, C constitute the red side of the
 * FIELD, and columns D, E, F constitute the blue side. Each ALLIANCE has
 * priority over those FIELD and SCORING ELEMENTS on their side." Red owns the
 * negative-x half.
 */
function onOwnSide(x, alliance, margin = 0) {
  const sign = alliance === 'red' ? -1 : 1;
  return sign * x > margin;
}

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

  // G402: "Each ALLIANCE has priority over those FIELD and SCORING ELEMENTS on
  // their side of the FIELD." So in AUTO it takes what is on its own half and
  // only crosses when there is nothing there -- which is what the priority is
  // for, and it keeps the two ALLIANCES out of each other's way in the period
  // where contact is a MAJOR FOUL.
  const home = game.match?.inAuto ? agent.alliance : null;
  const ball =
    nearestLooseElement(ctx, wanted, prefer, home) ?? nearestLooseElement(ctx, wanted, prefer);
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
    // Genuinely nothing to fetch. Standing still was worth nothing; the
    // LOADING ZONE is worth 5 for PARK (Table 10-2) and is also where a human
    // rolls NECTAR in, so it is the right place to be waiting.
    return parkInLoadingZone(ctx);
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

  // G402 during AUTO: prefer a spot on its own half, and only cross if there
  // is no shot at all from home. The rule does not forbid crossing -- it
  // forbids *disrupting*, and says crossing "may be seen as STRATEGIC" -- so a
  // hard restriction was the wrong shape: a HIVE sits a foot off the centre
  // line and the shooting circle round it is mostly on the other side, which
  // left the AI with nowhere legal to shoot from and no AUTO at all.
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

  /** The nearest spot the mechanism can shoot from, or null. */
  const search = (ownSideOnly) => {
    let best = null;
    let bestScore = Infinity;
    for (const range of ranges) {
      for (let i = 0; i < 36; i++) {
        const azimuth = (i / 36) * Math.PI * 2;
        const x = target.x + Math.cos(azimuth) * range;
        const y = target.y + Math.sin(azimuth) * range;
        if (Math.abs(x) > limit || Math.abs(y) > limit) continue;
        // G402, first pass only: its own half of the FIELD.
        if (ownSideOnly && !onOwnSide(x, agent.alliance, clearance)) continue;
        // Outside the opening plane, measured at the muzzle: inside it there is
        // no shot at any angle, however the hood is trimmed.
        if (hive.openingDepth(hive.up, x, y, launcher.exitHeight) <= 0) continue;
        // And the mechanism has to be able to make the shot from there. The
        // launcher's own *screen* rather than its full solver: this runs over
        // hundreds of candidates and the real solve is a bisection over a drag
        // integration. The screen is drag-free and so slightly optimistic,
        // which is the right direction -- it never rules out a shot that is
        // possible, and the real solve runs once the robot is standing there.
        //
        // Either way a catapult's hard maximum range and a flywheel's "too
        // close to drop in" both fall out of the mechanism rather than out of a
        // distance rule of thumb here.
        if (!launcher.couldReach(target, undefined, { x, y })) continue;
        const cost = Vec2.distance(ctx.selfPosition, new Vec2(x, y));
        if (cost < bestScore) {
          bestScore = cost;
          best = new Vec2(x, y);
        }
      }
      if (best) return best;
    }
    return best;
  };

  // In AUTO, try home first and only cross if there is no shot from there.
  const best = game.match?.inAuto ? search(true) ?? search(false) : search(false);
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
 * @param {'red'|'blue'|null} [side] restrict to one ALLIANCE'S half of the
 *   FIELD, which is what G402's AUTO priority asks for
 */
function nearestLooseElement(ctx, kinds, prefer = null, side = null) {
  const balls = ctx.game?.field?.ballWorld?.balls;
  if (!balls) return null;
  let best = null;
  let bestDistance = Infinity;
  let bestPreferred = false;
  for (const ball of balls) {
    if (!ball.free || ball.outOfBounds) continue;
    if (!kinds.includes(ball.kind)) continue;
    // G408: "A ROBOT may not CONTROL the opponent's NECTAR." POLLEN is neutral
    // and anybody's to take; a NECTAR belongs to an ALLIANCE, and picking up
    // the wrong colour is a VERBAL WARNING and then a YELLOW CARD for nothing
    // in return -- it does not even score where this robot would put it.
    if (ball.kind === 'nectar' && ball.alliance !== ctx.agent?.alliance) continue;
    // Restricted to one half of the FIELD, when the caller asked for that.
    if (side && !onOwnSide(ball.x, side)) continue;
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
