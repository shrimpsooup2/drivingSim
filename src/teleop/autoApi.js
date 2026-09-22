import { clamp } from '../math/MathUtil.js';
import {
  FIELD_FRAMES,
  angleInFrame,
  fromFrame,
  isFieldFrame,
  lengthFromFrame,
  lengthInFrame,
  toFrame,
} from '../math/fieldFrames.js';

/**
 * The `robot` object a pasted AUTO routine is handed.
 *
 * ## Why a façade rather than the robot itself
 *
 * Because what a real AUTO can *know* is not what a simulator can see. Handing
 * over `sim.robot` would let a routine read the body's exact pose out of the
 * physics and drive to coordinates no real robot has -- and then the same code
 * on the real machine would be a completely different routine. Everything here
 * is either a command a Control Hub can issue or a reading a sensor can take:
 * the IMU (with its drift and its latency), the wheel encoders (quantised to
 * whole ticks), the battery, and how many elements the intake reports holding.
 *
 * The exact pose is exposed too, as `robot.truth`, clearly labelled and
 * separate. It is genuinely useful for working out *why* a routine went wrong,
 * and hiding it would only mean people reached for `sim` instead.
 *
 * ## Coordinates in the frame your routine already uses
 *
 * `robot.frame = 'ftc'` switches every pose, point, bearing and distance below
 * to inches and degrees from the field centre; `'pedro'` switches them to Pedro
 * Pathing's corner-origin frame. The default is `'sim'` -- metres and radians
 * -- so nothing changes until a routine asks. Set it once in `init` and paste
 * your real coordinates in. See `math/fieldFrames.js` for exactly what each
 * frame's axes mean.
 *
 * ## Reading things is not free
 *
 * Every accessor here that stands for a hardware reading is charged to the hub
 * bus, and the bus decides how long your loop takes -- so a routine that reads
 * the IMU three times a cycle really does run slower than one that reads it
 * once and keeps the value. `robot.hub` exposes the loop time and the
 * transaction count so you can see it happening, and `robot.hub.clearBulkCache()`
 * is there for MANUAL caching. See `HardwareBus`.
 *
 * ## Shape
 *
 * Named after the FTC SDK where the SDK has a name for it -- `drive`,
 * `telemetry.addData`, `getRuntime` as `robot.time` -- and named plainly where
 * it does not. The point is that a routine written here reads like a routine,
 * not like a simulator script.
 *
 * @module
 */

/** Degrees per radian, because a routine thinks in degrees. */
const DEG = 180 / Math.PI;

/**
 * @param {{
 *   robot: import('../robot/Robot.js').Robot,
 *   game?: any,
 *   telemetry: Record<string, string|number>,
 *   log: (message: string) => void,
 *   runtime: () => number,
 *   loopSeconds?: () => number,
 *   drawing?: import('./FieldDrawing.js').FieldDrawing,
 * }} deps
 */
export function buildAutoApi(deps) {
  const { robot, telemetry, log } = deps;
  const game = () => deps.game ?? null;
  /** @type {import('../math/fieldFrames.js').FieldFrame} */
  let frame = 'sim';
  /** A point the routine handed us, in the simulator's metres. */
  const inward = (point) => fromFrame({ x: point?.x ?? 0, y: point?.y ?? 0 }, frame);
  /** A point of ours, in whatever frame the routine asked for. */
  const outward = (point) => {
    const out = toFrame({ x: point.x, y: point.y, heading: 0 }, frame);
    return { x: out.x, y: out.y };
  };
  const intake = () => robot.subsystems.find((s) => 'held' in s && 'capacity' in s) ?? null;
  const shooter = () =>
    robot.subsystems.find((s) => typeof s.fire === 'function') ?? null;

  const api = {
    /** Seconds since the routine started. FTC's `getRuntime()`. */
    get time() {
      return deps.runtime();
    },

    /**
     * Command the chassis, normalised, exactly as `driveNormalized` does:
     * +forward is ahead, +strafe is to the robot's left, +turn is
     * counter-clockwise. A drivetrain that cannot strafe ignores the middle one.
     */
    drive(forward = 0, strafe = 0, turn = 0) {
      robot.drivetrain.driveNormalized(
        clamp(forward, -1, 1),
        clamp(strafe, -1, 1),
        clamp(turn, -1, 1),
      );
      return api;
    },

    /** Stop everything that is commanded. Movement already under way coasts. */
    stop() {
      robot.drivetrain.driveNormalized(0, 0, 0);
      const i = intake();
      if (i) i.command = 0;
      const s = shooter();
      if (s && s.needsSpinUp !== false) s.spinning = false;
      return api;
    },

    /** Run the intake: +1 in, -1 out, 0 off. */
    intake(power = 1) {
      const i = intake();
      if (i) i.command = clamp(power, -1, 1);
      return api;
    },

    /**
     * How many SCORING ELEMENTS the intake is holding.
     *
     * Charged as an I2C reading, because on a real robot this is a colour or
     * distance sensor looking into the hopper and nothing else.
     */
    get held() {
      robot.bus.i2c();
      return intake()?.count ?? 0;
    },

    /** True when the intake is lined up to place into a FLOWER. */
    get alignedWithFlower() {
      return Boolean(intake()?.alignedFlower?.());
    },

    shooter: {
      /**
       * Spin the flywheel up to an RPM, or just switch it on at its current
       * target. A thrower has nothing to spin up and ignores this.
       */
      spinUp(rpm) {
        const s = shooter();
        if (!s) return api.shooter;
        if (rpm !== undefined && typeof s.setTargetRpm === 'function') s.setTargetRpm(rpm);
        if (s.needsSpinUp !== false) s.spinning = true;
        return api.shooter;
      },
      /** Let the wheel spin down. */
      spinDown() {
        const s = shooter();
        if (s && s.needsSpinUp !== false) s.spinning = false;
        return api.shooter;
      },
      /** Set the hood or release angle, in degrees. */
      angle(degrees) {
        const s = shooter();
        if (s && typeof s.setHoodAngle === 'function') s.setHoodAngle(degrees / DEG);
        return api.shooter;
      },
      /** Ask for a shot. It goes when the mechanism is able, not before. */
      fire() {
        shooter()?.fire?.();
        return api.shooter;
      },
      /**
       * Aim at this ALLIANCE'S own CELL from where the ROBOT is standing, and
       * report whether a shot exists at all.
       *
       * Two ways it can be false, and both matter for writing an AUTO. Too
       * close: inside about 0.9 m no angle arrives descending, and a CELL will
       * not take a climbing element. Or the wrong *side*: the opening is tilted
       * and faces one way, so from behind its plane there is no arc at any
       * speed or angle. The second is easy to miss, because the solver on its
       * own only knows about range and height -- ask it from behind the CELL
       * and it will happily hand back an RPM for a shot that cannot go in.
       */
      aimAtCell() {
        const g = game();
        const s = shooter();
        if (!g || !s?.aimAt) return false;
        const hive = g.field.hives[g.alliance];
        const pose = robot.body.position;
        if (hive.openingDepth(hive.up, pose.x, pose.y, s.exitHeight ?? 0.25) <= 0.05) {
          return false;
        }
        return s.aimAt(g.field.hiveTarget(g.alliance));
      },
      /** At the commanded speed, and not past it. */
      get ready() {
        return Boolean(shooter()?.ready);
      },
      get rpm() {
        return shooter()?.rpm ?? 0;
      },
      get targetRpm() {
        return shooter()?.targetRpm ?? 0;
      },
      /** Shots this mechanism has taken. */
      get shots() {
        return shooter()?.shots ?? 0;
      },
    },

    imu: {
      /**
       * Heading in degrees, from the modelled IMU: drift, noise and latency.
       *
       * One I2C transaction per read, so keep the value in a variable rather
       * than reading it four times in one cycle.
       */
      get heading() {
        return robot.readHeading() * DEG;
      },
      /** Zero the heading here, as `resetYaw()` does. */
      reset() {
        robot.resetHeading();
        return api.imu;
      },
    },

    /**
     * The pose the odometry board reports.
     *
     * This is the one an AUTO should steer by: the pods do not slip, so unlike
     * `travelled` it does not lie when a wheel scrubs. It does drift, because a
     * pose is an integral -- mostly through the heading, which comes from the
     * IMU on a two-pod setup. Compare it against `truth` to see by how much.
     *
     * One I2C transaction per read, and the board hands the whole pose back in
     * one go, so `const p = robot.odometry.pose` is one read and reading `.x`,
     * `.y` and `.heading` separately is three.
     */
    odometry: {
      /** Whether the robot has pods at all. */
      get fitted() {
        return robot.odometry.enabled;
      },
      /** x, y and heading in `robot.frame`. */
      get pose() {
        const p = robot.readOdometry();
        const out = toFrame(p, frame);
        return {
          x: out.x,
          y: out.y,
          heading: frame === 'sim' ? out.heading * DEG : out.heading,
        };
      },
      get x() {
        return api.odometry.pose.x;
      },
      get y() {
        return api.odometry.pose.y;
      },
      get heading() {
        return api.odometry.pose.heading;
      },
      /**
       * `setPosition`: tell it where it is.
       *
       * What a team does after squaring the robot up on a known tile, and what
       * a routine does if it ever gets a better fix -- from an AprilTag, or from
       * driving into a wall at a known place.
       */
      set(pose) {
        const next = fromFrame(
          {
            x: pose?.x ?? 0,
            y: pose?.y ?? 0,
            heading: frame === 'sim' ? (pose?.heading ?? 0) * DEG : pose?.heading ?? 0,
          },
          frame,
        );
        robot.bus.i2c();
        robot.odometry.reset(next);
        return api.odometry;
      },
    },

    /**
     * Wheel encoder positions in ticks, by wheel name, quantised as they are.
     *
     * One reading each, out of the bulk packet when the caching mode allows it
     * -- so this whole object costs a single 2 ms bulk read in AUTO, and four
     * separate 2 ms reads with caching OFF.
     */
    get encoders() {
      /** @type {Record<string, number>} */
      const out = {};
      for (const motor of robot.drivetrain.motors) {
        out[motor.name ?? `motor${Object.keys(out).length}`] = robot.readEncoder(motor);
      }
      return out;
    },

    /** Zero every wheel encoder, as `STOP_AND_RESET_ENCODER` does. */
    resetEncoders() {
      // A write per port: the SDK sends a run-mode change to each motor.
      robot.bus.write(robot.drivetrain.motors.length);
      for (const motor of robot.drivetrain.motors) motor.encoder?.reset?.();
      return api;
    },

    /**
     * Encoder ticks per metre of wheel travel: ticks per output revolution
     * over the wheel's circumference.
     *
     * A team works this out once from their gearing and it is the number every
     * encoder-driven AUTO is built on, so it is worth having rather than
     * worth re-deriving. It is the *wheel's* travel, not the chassis's --
     * strafing a mecanum moves the chassis about 0.7 of what the wheels turn,
     * and skidding moves it less than that, which is exactly the error a real
     * AUTO has to be tuned around.
     */
    get ticksPerMetre() {
      const motor = robot.drivetrain.motors[0];
      const encoder = motor?.encoder;
      const radius = robot.drivetrain.config?.drivetrain?.wheelRadius ?? 0.048;
      if (!encoder || !radius) return 0;
      return encoder.ticksPerOutputRev / (2 * Math.PI * radius);
    },

    /** Mean absolute encoder travel since the last reset, in metres. */
    get travelled() {
      const perMetre = api.ticksPerMetre;
      if (!perMetre) return 0;
      const motors = robot.drivetrain.motors;
      if (motors.length === 0) return 0;
      let total = 0;
      for (const motor of motors) total += Math.abs(robot.readEncoder(motor));
      return lengthInFrame(total / motors.length / perMetre, frame);
    },

    /**
     * Encoder ticks per unit of wheel travel in `robot.frame` -- per metre in
     * `sim`, per inch in the other two. The number a distance-based AUTO is
     * built on, in the units that AUTO is written in.
     */
    get ticksPerUnit() {
      return api.ticksPerMetre * (frame === 'sim' ? 1 : 0.0254);
    },

    /** Bus voltage, which sags under load and sets how fast you actually go. */
    get voltage() {
      return robot.readVoltage?.() ?? robot.battery?.busVoltage ?? 12;
    },

    /**
     * The hubs: what your loop is costing, and the one call that controls it.
     *
     * This is the readout that answers "why is my auto not repeatable?" --
     * a cycle that varies between 8 and 30 ms is a cycle whose timed waits
     * land in different places every run.
     */
    hub: {
      /** `LynxModule.clearBulkCache()`. Only does anything in MANUAL mode. */
      clearBulkCache() {
        robot.bus.clearBulkCache();
        return api.hub;
      },
      /** 'OFF', 'AUTO' or 'MANUAL'. Settable, as `setBulkCachingMode` is. */
      get cachingMode() {
        return robot.bus.cachingMode;
      },
      set cachingMode(mode) {
        if (mode === 'OFF' || mode === 'AUTO' || mode === 'MANUAL') robot.bus.cachingMode = mode;
      },
      /** How long the last complete cycle took, milliseconds. */
      get loopMs() {
        return (deps.loopSeconds?.() ?? 0) * 1000;
      },
      /** How much of that was spent waiting on the hubs. */
      get ioMs() {
        return robot.bus.lastSeconds * 1000;
      },
      /** Transactions the last complete cycle made. */
      get transactions() {
        return robot.bus.lastTransactions;
      },
    },

    /**
     * The MATCH, read-only: how long is left in AUTO, and whether the FLOWERS
     * have opened. A real DRIVE TEAM can see the FIELD timer, so this is fair.
     */
    get match() {
      const g = game();
      if (!g) return { phase: 'none', autoRemaining: 0, flowersOpen: false, alliance: null };
      const status = g.match.status();
      return {
        phase: status.phase,
        autoRemaining: status.phase === 'auto' ? status.phaseRemaining : 0,
        flowersOpen: status.flowerUnlocked,
        alliance: g.alliance,
      };
    },

    /**
     * Where the ROBOT actually is, which no real ROBOT knows this precisely.
     *
     * Labelled `truth` on purpose. Use it to work out why a routine drifted;
     * write the routine against the encoders and the IMU, or it will not
     * survive the trip to a real FIELD.
     */
    get truth() {
      const pose = toFrame(
        {
          x: robot.body.position.x,
          y: robot.body.position.y,
          heading: robot.body.rotation.radians,
        },
        frame,
      );
      return {
        x: pose.x,
        y: pose.y,
        heading: frame === 'sim' ? pose.heading * DEG : pose.heading,
        speed: lengthInFrame(robot.body.speed, frame),
      };
    },

    /**
     * Which frame the coordinates above and below are in.
     *
     * `'sim'` (metres and radians from the field centre), `'ftc'` (inches and
     * degrees from the field centre) or `'pedro'` (inches and degrees from a
     * corner). Set it in `init` and the rest of the routine can use the numbers
     * your team already wrote down.
     */
    get frame() {
      return frame;
    },
    set frame(next) {
      if (!isFieldFrame(next)) {
        throw new Error(`robot.frame must be one of ${FIELD_FRAMES.join(', ')}, not ${next}`);
      }
      frame = next;
    },

    /**
     * The conversions themselves, for a routine that has to mix frames --
     * a Pedro path whose waypoints came off a field drawing in inches, say.
     */
    frames: {
      /** A simulator point or pose, in `to`. */
      to(pose, to = frame) {
        return toFrame(pose, to);
      },
      /** A point or pose in `from`, in the simulator's metres and radians. */
      from(pose, from = frame) {
        return fromFrame(pose, from);
      },
    },

    /**
     * Where things are, and which way they are from here.
     *
     * A real AUTO has a field map -- it is in the manual, with dimensions --
     * and a pose from odometry, and it aims by combining the two. That is
     * exactly what these are, so a routine written against them is a routine.
     * They are only ever as good as the odometry behind them, which here is
     * exact and on a real robot is not; that difference is the main reason an
     * auto that works in a simulator still needs a practice field.
     */
    get cellTarget() {
      const g = game();
      if (!g) return { x: 0, y: 0, z: 0 };
      const target = g.field.hiveTarget(g.alliance);
      return { ...outward(target), z: lengthInFrame(target.z ?? 0, frame) };
    },

    /** The middle of this ALLIANCE'S own LOADING ZONE, where PARK is scored. */
    get loadingZone() {
      const g = game();
      const zones = g?.field?.zones;
      const zone = g?.alliance === 'blue' ? zones?.blueLoading : zones?.redLoading;
      if (!zone) return { x: 0, y: 0 };
      // A little in from the wall, so a ROBOT driving to it does not grind
      // along the perimeter to get there.
      const step = zone.centerX < 0 ? 1 : -1;
      return outward({ x: zone.centerX + step * zone.width * 0.4, y: zone.centerY });
    },

    /**
     * Absolute field heading from the ROBOT to a point.
     *
     * In `robot.frame`: degrees in `ftc` and `pedro`, degrees in `sim` too
     * (headings were always degrees here), and measured the way that frame
     * measures them -- which for `pedro` is 90 degrees off `ftc`.
     */
    bearingTo(point) {
      const target = inward(point);
      const p = robot.body.position;
      const radians = Math.atan2(target.y - p.y, target.x - p.x);
      return frame === 'sim' ? radians * DEG : angleInFrame(radians, frame);
    },

    /** Straight-line distance from the ROBOT to a point, in `robot.frame`. */
    distanceTo(point) {
      const target = inward(point);
      const p = robot.body.position;
      return lengthInFrame(Math.hypot(target.x - p.x, target.y - p.y), frame);
    },

    /**
     * The webcam, and the AprilTags it can see.
     *
     * Free to read and out of date, which is the real trade: vision runs on its
     * own thread, so reading it costs your loop nothing and the answer describes
     * where the robot was about 60 ms ago. `ageMs` on each detection says how
     * old, and at 1 m/s that is 6 cm -- so a fix is worth taking while stopped
     * or slow, and worth distrusting at speed.
     *
     * The BIOBUZZ clusters face *downward* off the underside of a CELL, so
     * whether you see anything at all depends mostly on the camera's pitch. If
     * `count` is always zero, that is the first thing to look at.
     */
    camera: {
      get fitted() {
        return robot.camera.enabled;
      },
      /** How many tags are in the latest frame. */
      get count() {
        return robot.camera.detections.length;
      },
      /**
       * The detections, biggest first. Range in `robot.frame`'s units, bearing
       * and elevation in degrees, positive left and up.
       */
      get tags() {
        return robot.camera.detections.map((d) => ({
          id: d.id,
          range: lengthInFrame(d.range, frame),
          bearing: d.bearing * DEG,
          elevation: d.elevation * DEG,
          incidence: d.incidence * DEG,
          pixels: d.pixels,
          ageMs: d.age * 1000,
        }));
      },
      /** One by id, or null. */
      tag(id) {
        return api.camera.tags.find((t) => t.id === id) ?? null;
      },
      /**
       * Where the biggest tag in frame says the robot was, in `robot.frame`.
       *
       * A heading is needed because a detection is a measurement rather than a
       * solved pose, and by default it uses the odometry's -- which is the one a
       * routine is steering by. Null when nothing is in frame.
       */
      pose(heading) {
        const h =
          heading === undefined
            ? robot.odometry.enabled
              ? robot.odometry.pose.heading
              : robot.imu.heading
            : frame === 'sim'
              ? heading / DEG
              : fromFrame({ x: 0, y: 0, heading }, frame).heading;
        const fix = robot.camera.bestPose(h);
        if (!fix) return null;
        const out = toFrame(fix, frame);
        return {
          x: out.x,
          y: out.y,
          heading: frame === 'sim' ? out.heading * DEG : out.heading,
          range: lengthInFrame(fix.range, frame),
          ageMs: fix.age * 1000,
        };
      },
      /**
       * Take the fix: hand the pose to the odometry, as `setPosition` does.
       *
       * Returns true if there was one to take. Worth doing when a tag is close
       * and square and the robot is slow; not worth doing every loop at speed,
       * because a 60 ms old fix applied to a moving robot is a 6 cm step
       * backwards in the estimate.
       */
      fix() {
        const heading = robot.odometry.enabled
          ? robot.odometry.pose.heading
          : robot.imu.heading;
        const pose = robot.camera.bestPose(heading);
        if (!pose) return false;
        robot.bus.i2c();
        robot.odometry.reset({ x: pose.x, y: pose.y, heading }, robot.imu.heading);
        return true;
      },
    },

    /**
     * Draw on the field, in `robot.frame`.
     *
     * For showing what the routine *believes*, which is the hard half of
     * debugging an AUTO -- where it thinks the target is, what path it planned,
     * which waypoint it is driving at. A cross on the tiles is a thing you see;
     * three decimals on a side panel is a thing you decode.
     *
     * ```js
     * function loop(robot) {
     *   robot.draw.clear();
     *   robot.draw.point(robot.cellTarget, 'amber');
     *   robot.draw.pose(robot.odometry.pose, 'cyan');
     * }
     * ```
     *
     * Whatever is drawn stays until `clear()`, so a path planned once can be
     * drawn once. Points are `{x, y}` or `[x, y]`; colours are a name
     * ('red', 'blue', 'green', 'amber', 'cyan', 'magenta', 'white', 'grey'),
     * a '#rrggbb', or an [r, g, b].
     */
    draw: {
      clear() {
        deps.drawing?.clear();
        return api.draw;
      },
      /** How many shapes are on the field. */
      get count() {
        return deps.drawing?.count ?? 0;
      },
      line(from, to, colour) {
        const a = inward(asPoint(from));
        const b = inward(asPoint(to));
        deps.drawing?.line(a.x, a.y, b.x, b.y, colour);
        return api.draw;
      },
      /** A polyline through the points: a planned path, a set of waypoints. */
      path(points, colour) {
        const mapped = (points ?? []).map((p) => {
          const q = inward(asPoint(p));
          return [q.x, q.y];
        });
        deps.drawing?.path(mapped, colour);
        return api.draw;
      },
      /** `radius` is in the frame's units too, so inches in 'ftc'. */
      circle(centre, radius, colour) {
        const c = inward(asPoint(centre));
        deps.drawing?.circle(c.x, c.y, lengthFromFrame(radius ?? 0, frame), colour);
        return api.draw;
      },
      /** A cross. What you want for a target or a waypoint. */
      point(at, colour) {
        const p = inward(asPoint(at));
        deps.drawing?.point(p.x, p.y, colour);
        return api.draw;
      },
      /** An arrow: where, and which way. Takes a heading in the frame's units. */
      pose(at, colour) {
        const source = asPoint(at);
        const p = fromFrame(
          {
            x: source.x,
            y: source.y,
            heading: frame === 'sim' ? (source.heading ?? 0) * DEG : source.heading ?? 0,
          },
          frame,
        );
        deps.drawing?.pose(p.x, p.y, p.heading, colour);
        return api.draw;
      },
      /** A word or two on the tiles. */
      text(at, text, colour) {
        const p = inward(asPoint(at));
        deps.drawing?.text(p.x, p.y, text, colour);
        return api.draw;
      },
    },

    /** FTC-style telemetry, shown in the panel. */
    telemetry: {
      addData(key, value) {
        telemetry[String(key)] = typeof value === 'number' ? value : String(value);
        return api.telemetry;
      },
      clear() {
        for (const key of Object.keys(telemetry)) delete telemetry[key];
        return api.telemetry;
      },
    },

    /** Goes to the panel's log, not to the browser console nobody has open. */
    log(...parts) {
      log(parts.map((p) => (typeof p === 'string' ? p : JSON.stringify(p))).join(' '));
      return api;
    },
  };

  return api;
}

/**
 * A point the routine handed us, however it wrote it.
 *
 * `{x, y}` is the shape everything here hands *back*, so it is the one people
 * pass in; `[x, y]` is what a list of waypoints tends to be written as. Taking
 * both costs four lines and saves everybody a `.map`.
 */
function asPoint(value) {
  if (Array.isArray(value)) return { x: value[0] ?? 0, y: value[1] ?? 0, heading: value[2] };
  return { x: value?.x ?? 0, y: value?.y ?? 0, heading: value?.heading };
}
