import { clamp } from '../math/MathUtil.js';

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
 * }} deps
 */
export function buildAutoApi(deps) {
  const { robot, telemetry, log } = deps;
  const game = () => deps.game ?? null;
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
      return total / motors.length / perMetre;
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
      return {
        x: robot.body.position.x,
        y: robot.body.position.y,
        heading: robot.body.rotation.radians * DEG,
        speed: robot.body.speed,
      };
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
      return g.field.hiveTarget(g.alliance);
    },

    /** The middle of this ALLIANCE'S own LOADING ZONE, where PARK is scored. */
    get loadingZone() {
      const g = game();
      const zones = g?.field?.zones;
      const zone = g?.alliance === 'blue' ? zones?.blueLoading : zones?.redLoading;
      if (!zone) return { x: 0, y: 0 };
      // A little in from the wall, so a ROBOT driving to it does not grind
      // along the perimeter to get there.
      const inward = zone.centerX < 0 ? 1 : -1;
      return { x: zone.centerX + inward * zone.width * 0.4, y: zone.centerY };
    },

    /** Absolute field heading from the ROBOT to a point, in degrees. */
    bearingTo(point) {
      const p = robot.body.position;
      return Math.atan2(point.y - p.y, point.x - p.x) * DEG;
    },

    /** Straight-line distance from the ROBOT to a point, in metres. */
    distanceTo(point) {
      const p = robot.body.position;
      return Math.hypot(point.x - p.x, point.y - p.y);
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
