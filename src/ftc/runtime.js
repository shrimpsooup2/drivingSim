/**
 * The runtime a compiled op-mode runs against: `OpMode`, `telemetry`, the
 * clock, the gamepads, vision, and the table that resolves an SDK name.
 *
 * ## What `__rt` is
 *
 * The emitter does not try to guess what `Math`, `DcMotor.Direction.REVERSE` or
 * `new ElapsedTime()` mean. It emits `__rt.ref('Math')`,
 * `__rt.ref('DcMotor.Direction.REVERSE')` and `__rt.construct('ElapsedTime')`,
 * and this module answers. So the set of SDK names that work is a table in one
 * place, an unknown one fails by name with the line it came from, and adding a
 * class is one entry rather than a change to the compiler.
 *
 * ## The clock
 *
 * `ElapsedTime` and `getRuntime()` read the *simulated* clock. Getting this
 * wrong would be the single worst bug available here: an op-mode timing a
 * movement against wall-clock time while the world runs on a paused or
 * stepped clock would behave differently every run, and the whole point is
 * that an AUTO is repeatable.
 *
 * ## Before START
 *
 * A `LinearOpMode` does its `hardwareMap` lookups and its telemetry *before*
 * `waitForStart()`, so the routine begins running during INIT, exactly as on a
 * field. Motors are held at zero until START, which is what the hub does -- so
 * an op-mode that sets a power in its init sequence does not move the robot,
 * here or there.
 *
 * @module
 */
import {
  ArrayList,
  Arrays,
  Boolean_,
  Collections,
  Double,
  Float,
  HashMap,
  Integer,
  JMath,
  JString,
  Long,
  Range,
  bool,
  caught,
  format,
  isA,
  iterate,
  javaError,
  javaString,
  key,
  makeEnum,
  newArray,
} from './lang.js';
import {
  AngleUnit,
  BulkCachingMode,
  CRServo,
  CurrentUnit,
  DcMotor,
  DcMotorEx,
  DcMotorSimple,
  Direction,
  DistanceUnit,
  HardwareMap,
  RunMode,
  Servo,
  UnnormalizedAngleUnit,
  ZeroPowerBehavior,
} from './hardware.js';

/** `RevHubOrientationOnRobot`, whose constants every IMU setup names. */
const LogoFacingDirection = makeEnum('LogoFacingDirection', ['UP', 'DOWN', 'FORWARD', 'BACKWARD', 'LEFT', 'RIGHT']);
const UsbFacingDirection = makeEnum('UsbFacingDirection', ['UP', 'DOWN', 'FORWARD', 'BACKWARD', 'LEFT', 'RIGHT']);

/**
 * Build the runtime for one op-mode run.
 *
 * @param {{
 *   robot: import('../robot/Robot.js').Robot,
 *   sim: any,
 *   telemetry: Record<string, string|number>,
 *   log: (message: string) => void,
 *   clock: () => number,
 *   runtime: () => number,
 *   phase: () => {started: boolean, stopping: boolean},
 *   gamepads: () => {gamepad1: any, gamepad2: any},
 *   warn: (message: string) => void,
 * }} deps
 */
export function createRuntime(deps) {
  const robot = deps.robot;
  const bus = robot.bus;
  const started = () => deps.phase().started;

  /**
   * How much simulated time the op-mode has spent, other than on the hubs.
   *
   * Only the clock, really: `ElapsedTime.seconds()`, `getRuntime()`,
   * `System.currentTimeMillis()`. The scheduler needs it because
   * `while (timer.seconds() < 3)` does no hardware I/O and would otherwise look
   * like a loop that takes no time at all -- and then it would never finish.
   */
  let progress = 0;
  const tick = () => {
    progress += 1e-9;
    return progress;
  };

  const warnings = [];
  const hardwareMap = new HardwareMap({
    robot,
    bus,
    enabled: started,
    warn: (message) => {
      warnings.push(message);
      deps.warn?.(message);
    },
  });
  hardwareMap.warnings = warnings;

  const telemetry = new Telemetry(deps);

  /** Every `ElapsedTime` handed out, so they all read the simulated clock. */
  const timers = [];

  class JavaOpMode {
    constructor() {
      this.hardwareMap = hardwareMap;
      this.telemetry = telemetry;
      this.time = 0;
      this.msStuckDetectInit = 5000;
      this.msStuckDetectInitLoop = 5000;
      this.msStuckDetectStart = 5000;
      this.msStuckDetectLoop = 5000;
      this.msStuckDetectStop = 900;
    }

    get gamepad1() {
      return deps.gamepads().gamepad1;
    }

    get gamepad2() {
      return deps.gamepads().gamepad2;
    }

    getRuntime() {
      tick();
      return deps.runtime();
    }

    resetRuntime() {
      deps.resetRuntime?.();
    }

    isStarted() {
      return started();
    }

    isStopRequested() {
      return deps.phase().stopping;
    }

    opModeIsActive() {
      return started() && !this.isStopRequested();
    }

    opModeInInit() {
      return !started() && !this.isStopRequested();
    }

    requestOpModeStop() {
      deps.requestStop?.();
    }

    terminateOpModeNow() {
      throw stopSignal();
    }

    updateTelemetry(t) {
      (t ?? telemetry).update();
    }

    /**
     * `idle()` -- hand the thread back.
     *
     * A generator, like everything that blocks, so the simulator gets a turn.
     */
    *idle() {
      yield 0;
    }

    /** `sleep(ms)`, on the simulated clock. */
    *sleep(millis) {
      const seconds = Math.max(0, Number(millis) || 0) / 1000;
      if (seconds > 0) yield { sleep: seconds };
      else yield 0;
    }

    /**
     * `waitForStart()`.
     *
     * Really waits: the routine runs its init sequence during the INIT period
     * and stops here until the match starts, which is what makes a `LinearOpMode`
     * written for a field work unchanged.
     */
    *waitForStart() {
      while (!started() && !this.isStopRequested()) yield { waitForStart: true };
    }

    /** `waitForNextHardwareCycle()`, from the very old API. */
    *waitForNextHardwareCycle() {
      yield 0;
    }

    // The iterative OpMode hooks. Empty here so a subclass overriding only
    // some of them works, which is what the SDK does too.
    init() {}
    init_loop() {}
    start() {}
    loop() {}
    stop() {}
  }

  class LinearOpMode extends JavaOpMode {
    *runOpMode() {}
  }

  /** `ElapsedTime`, on the simulated clock. */
  class ElapsedTime {
    constructor(startOrResolution) {
      this.javaClass = 'ElapsedTime';
      this.startedAt = deps.clock();
      if (typeof startOrResolution === 'number' && startOrResolution > 1e6) {
        // The `new ElapsedTime(nanoseconds)` form. Nobody's simulated clock has
        // a meaningful nanosecond origin, so it starts now either way.
        this.startedAt = deps.clock();
      }
      timers.push(this);
    }

    reset() {
      this.startedAt = deps.clock();
      return this;
    }

    time(unit) {
      tick();
      const seconds = deps.clock() - this.startedAt;
      if (!unit) return seconds;
      switch (unit.__name) {
        case 'MILLISECONDS': return seconds * 1000;
        case 'MICROSECONDS': return seconds * 1e6;
        case 'NANOSECONDS': return seconds * 1e9;
        case 'MINUTES': return seconds / 60;
        default: return seconds;
      }
    }

    seconds() {
      tick();
      return deps.clock() - this.startedAt;
    }

    milliseconds() {
      return this.seconds() * 1000;
    }

    nanoseconds() {
      return this.seconds() * 1e9;
    }

    startTime() {
      return this.startedAt;
    }

    toString() {
      return this.seconds().toFixed(3);
    }
  }

  const TimeUnit = makeEnum('TimeUnit', [
    'NANOSECONDS', 'MICROSECONDS', 'MILLISECONDS', 'SECONDS', 'MINUTES',
  ]);

  const vision = createVision(robot, deps);

  /** Everything `__rt.ref` can resolve, as a nested table. */
  const TABLE = {
    Math: JMath,
    String: JString,
    Range,
    Double, Integer, Long, Float,
    Boolean: Boolean_,
    Arrays, Collections,
    TimeUnit,
    Direction,
    RunMode,
    ZeroPowerBehavior,
    AngleUnit,
    UnnormalizedAngleUnit,
    DistanceUnit,
    CurrentUnit,
    BulkCachingMode,
    DcMotor: { Direction, RunMode, ZeroPowerBehavior },
    DcMotorEx: { Direction, RunMode, ZeroPowerBehavior },
    DcMotorSimple: { Direction },
    Servo: { Direction, MIN_POSITION: 0, MAX_POSITION: 1 },
    CRServo: { Direction },
    LynxModule: { BulkCachingMode },
    RevHubOrientationOnRobot: { LogoFacingDirection, UsbFacingDirection },
    IMU: {},
    Thread: {},
    System: {
      out: {
        println: (value) => deps.log(javaString(value ?? '')),
        print: (value) => deps.log(javaString(value ?? '')),
        printf: (pattern, ...args) => deps.log(format(pattern, ...args)),
      },
      err: {
        println: (value) => deps.log(`error: ${javaString(value ?? '')}`),
        print: (value) => deps.log(`error: ${javaString(value ?? '')}`),
      },
      // Milliseconds of *simulated* time. A routine measuring its own loop time
      // with this gets the simulated loop time, which is the useful answer.
      currentTimeMillis: () => {
        tick();
        return deps.clock() * 1000;
      },
      nanoTime: () => {
        tick();
        return deps.clock() * 1e9;
      },
      exit: () => {
        throw stopSignal();
      },
    },
    ...vision.table,
  };

  /** Classes `new` can build. */
  const CONSTRUCTORS = {
    ElapsedTime,
    ArrayList,
    HashMap,
    List: ArrayList,
    Map: HashMap,
    // `new IMU.Parameters(new RevHubOrientationOnRobot(...))` is configuration
    // this simulator has no use for, so it is accepted and ignored.
    'IMU.Parameters': class Parameters {},
    Parameters: class Parameters {},
    RevHubOrientationOnRobot: class RevHubOrientationOnRobot {},
    Orientation: class Orientation {},
    ...vision.constructors,
  };

  const EXCEPTIONS = new Set([
    'Exception', 'RuntimeException', 'IllegalArgumentException', 'IllegalStateException',
    'InterruptedException', 'NullPointerException', 'IndexOutOfBoundsException',
    'ArithmeticException', 'UnsupportedOperationException', 'Error', 'Throwable',
  ]);

  const runtime = {
    OpMode: JavaOpMode,
    LinearOpMode,
    Object: class JavaObject {},

    /** Resolve a dotted SDK name. */
    ref(path) {
      const parts = String(path).split('.');
      let value = TABLE[parts[0]];
      if (value === undefined) {
        // A bare class name used as a value, e.g. passing `DcMotor` around.
        if (CONSTRUCTORS[parts[0]] || EXCEPTIONS.has(parts[0])) return { __class: parts[0] };
        throw javaError(
          'NoClassDefFoundError',
          `${parts[0]} is not something this simulator provides. ` +
            'Supported classes are listed in docs/JAVA.md.',
        );
      }
      for (let i = 1; i < parts.length; i++) {
        if (value === null || value === undefined) {
          throw javaError('NoSuchFieldError', `${parts.slice(0, i).join('.')} has no ${parts[i]}`);
        }
        value = value[parts[i]];
      }
      if (value === undefined) {
        throw javaError('NoSuchFieldError', `${path} is not provided by this simulator`);
      }
      return value;
    },

    /** A static call: `Math.abs(x)`, `String.format(...)`, `Range.clip(...)`. */
    callStatic(path, method, args) {
      const owner = runtime.ref(path);
      const fn = owner?.[method];
      if (typeof fn !== 'function') {
        throw javaError('NoSuchMethodError', `${path}.${method}() is not provided by this simulator`);
      }
      return fn.apply(owner, args);
    },

    /** `new Foo(...)`. */
    construct(name, args) {
      const simple = String(name).split('.').pop();
      const Ctor = CONSTRUCTORS[name] ?? CONSTRUCTORS[simple];
      if (Ctor) return new Ctor(...args);
      if (EXCEPTIONS.has(simple)) return javaError(simple, args[0] ? javaString(args[0]) : simple);
      throw javaError(
        'NoClassDefFoundError',
        `this simulator cannot build a ${simple}. Supported classes are listed in docs/JAVA.md.`,
      );
    },

    /** `Foo.class`, which only ever gets handed to `hardwareMap.get`. */
    classOf(name) {
      return { __class: String(name).split('.').pop() };
    },

    makeEnum,
    iterate,
    newArray,
    bool,
    key,
    isA,
    caught,

    // What the runner needs.
    hardwareMap,
    telemetry,
    vision,
    /** Simulated time spent off the hubs. See the scheduler in `JavaProgram`. */
    progress: () => progress,
    /** Called once a cycle: releases motors at START and moves the servos. */
    tick(dt) {
      for (const device of hardwareMap.getAll()) {
        device.refresh?.();
        device.step?.(dt);
      }
      vision.tick();
    },
  };

  return runtime;
}

/** The exception `terminateOpModeNow()` throws, which the runner recognises. */export function stopSignal() {
  const error = javaError('OpModeStopped', 'the op-mode asked to stop');
  error.opModeStop = true;
  return error;
}

/**
 * `Telemetry`.
 *
 * The SDK buffers items and sends them on `update()`, and `setAutoClear(true)`
 * -- the default -- clears the buffer afterwards. Op-modes rely on that: one
 * that calls `addData` in a loop without `update` shows nothing, and one that
 * turns auto-clear off expects its lines to persist. Both behave here as they
 * do there.
 */
class Telemetry {
  constructor(deps) {
    this.javaClass = 'Telemetry';
    this.deps = deps;
    this.autoClear = true;
    this.interval = 250;
    /** @type {Array<{caption: string, value: string}>} */
    this.pending = [];
    this.captionSeparator = ' : ';
    this.itemSeparator = ' | ';
  }

  addData(caption, value, ...args) {
    const text =
      args.length > 0 || (typeof value === 'string' && /%[-+ 0,#]*\d*(?:\.\d+)?[sdfbcxXoeE]/.test(value))
        ? format(value, ...args)
        : typeof value === 'function'
          ? javaString(value())
          : javaString(value);
    const item = { caption: javaString(caption), value: text };
    this.pending.push(item);
    return {
      setValue: (next, ...rest) => {
        item.value = rest.length > 0 ? format(next, ...rest) : javaString(next);
        return item;
      },
      setRetained: () => item,
      setCaption: (next) => {
        item.caption = javaString(next);
        return item;
      },
    };
  }

  addLine(text) {
    if (text === undefined) {
      this.pending.push({ caption: '', value: '' });
    } else {
      this.pending.push({ caption: '', value: javaString(text) });
    }
    return {
      addData: (caption, value, ...args) => this.addData(caption, value, ...args),
    };
  }

  /** `update()`: everything buffered goes to the panel. */
  update() {
    for (const item of this.pending) {
      if (item.caption) this.deps.telemetry[item.caption] = item.value;
      else if (item.value) this.deps.log(item.value);
    }
    if (this.autoClear) this.pending = [];
    return true;
  }

  clear() {
    this.pending = [];
    return this;
  }

  clearAll() {
    this.pending = [];
    for (const k of Object.keys(this.deps.telemetry)) delete this.deps.telemetry[k];
    return this;
  }

  setAutoClear(value) {
    this.autoClear = Boolean(value);
    return this;
  }

  isAutoClear() {
    return this.autoClear;
  }

  setMsTransmissionInterval(ms) {
    this.interval = ms;
    return this;
  }

  getMsTransmissionInterval() {
    return this.interval;
  }

  setCaptionValueSeparator(separator) {
    this.captionSeparator = separator;
    return this;
  }

  setItemSeparator(separator) {
    this.itemSeparator = separator;
    return this;
  }

  setDisplayFormat() {
    return this;
  }

  speak(text) {
    this.deps.log(`speak: ${javaString(text)}`);
    return this;
  }

  addAction(action) {
    return action;
  }

  removeAction() {
    return true;
  }

  removeItem() {
    return true;
  }

  log() {
    const deps = this.deps;
    return {
      add: (text, ...args) => deps.log(args.length ? format(text, ...args) : javaString(text)),
      clear: () => {},
      setCapacity: () => {},
      setDisplayOrder: () => {},
    };
  }
}

/**
 * `VisionPortal` and `AprilTagProcessor`, onto this simulator's camera.
 *
 * Builders, because that is the only way the SDK lets you make either, and an
 * op-mode's vision setup is six chained calls that have to not throw.
 */
function createVision(robot, deps) {
  const camera = robot.camera;

  class AprilTagProcessor {
    constructor() {
      this.javaClass = 'AprilTagProcessor';
    }

    /** `getDetections()` -- the whole point. */
    getDetections() {
      return new ArrayList(camera.detections.map((d) => detectionOf(d)));
    }

    getFreshDetections() {
      // Fresh means "new since you last asked", and a frame is published at the
      // camera's own rate, so this is the current frame or nothing.
      return this.getDetections();
    }

    setDecimation() {}
    setPoseSolver() {}
  }

  const AprilTagProcessorClass = Object.assign(AprilTagProcessor, {
    Builder: class Builder {
      constructor() {
        this.javaClass = 'AprilTagProcessor.Builder';
      }
      setDrawAxes() { return this; }
      setDrawCubeProjection() { return this; }
      setDrawTagOutline() { return this; }
      setDrawTagID() { return this; }
      setTagFamily() { return this; }
      setTagLibrary() { return this; }
      setOutputUnits() { return this; }
      setLensIntrinsics() { return this; }
      setNumThreads() { return this; }
      build() { return new AprilTagProcessor(); }
    },
    TagFamily: makeEnum('TagFamily', ['TAG_36h11', 'TAG_25h9', 'TAG_16h5', 'TAG_standard41h12']),
  });

  /** One detection, shaped like `AprilTagDetection`. */
  function detectionOf(d) {
    const inches = (metres) => metres / 0.0254;
    // `ftcPose` is camera-relative, which is what the SDK gives and what an
    // op-mode aligns on.
    const ftcPose = {
      javaClass: 'AprilTagPoseFtc',
      range: inches(d.range),
      bearing: (d.bearing * 180) / Math.PI,
      elevation: (d.elevation * 180) / Math.PI,
      // x to the right, y forward, z up, all in inches.
      x: inches(-d.range * Math.cos(d.elevation) * Math.sin(d.bearing)),
      y: inches(d.range * Math.cos(d.elevation) * Math.cos(d.bearing)),
      z: inches(d.range * Math.sin(d.elevation)),
      yaw: 0,
      pitch: 0,
      roll: 0,
    };
    const fix = camera.bestPose(robot.odometry.enabled ? robot.odometry.pose.heading : robot.imu.heading);
    return {
      javaClass: 'AprilTagDetection',
      id: d.id,
      hamming: 0,
      decisionMargin: d.pixels,
      ftcPose,
      metadata: {
        javaClass: 'AprilTagMetadata',
        id: d.id,
        name: `BIOBUZZ ${d.id}`,
        tagsize: inches(d.tag.size),
      },
      robotPose: fix
        ? {
            javaClass: 'Pose3D',
            getPosition: () => ({
              x: inches(fix.x),
              y: inches(fix.y),
              z: 0,
              unit: { __name: 'INCH' },
            }),
            getOrientation: () => ({
              getYaw: (unit) => (unit && unit.__name === 'RADIANS' ? fix.heading : (fix.heading * 180) / Math.PI),
              getPitch: () => 0,
              getRoll: () => 0,
            }),
          }
        : null,
      frameAcquisitionNanos: (deps.clock() - d.age) * 1e9,
    };
  }

  class VisionPortal {
    constructor() {
      this.javaClass = 'VisionPortal';
    }
    close() {}
    resumeStreaming() {}
    stopStreaming() {}
    resumeLiveView() {}
    stopLiveView() {}
    setProcessorEnabled() {}
    getProcessorEnabled() { return true; }
    getCameraState() { return VisionPortalClass.CameraState.STREAMING; }
    getFps() { return camera.frameRateHz; }
    saveNextFrameRaw() {}
    setActiveCamera() {}
  }

  const VisionPortalClass = Object.assign(VisionPortal, {
    Builder: class Builder {
      constructor() {
        this.javaClass = 'VisionPortal.Builder';
      }
      setCamera() { return this; }
      addProcessor() { return this; }
      addProcessors() { return this; }
      setCameraResolution() { return this; }
      setStreamFormat() { return this; }
      enableLiveView() { return this; }
      setAutoStopLiveView() { return this; }
      setShowStatsOverlay() { return this; }
      build() { return new VisionPortal(); }
    },
    CameraState: makeEnum('CameraState', ['STREAMING', 'CAMERA_DEVICE_READY', 'STOPPING_STREAM', 'CLOSED']),
    StreamFormat: makeEnum('StreamFormat', ['YUY2', 'MJPEG']),
    MultiPortalLayout: makeEnum('MultiPortalLayout', ['HORIZONTAL', 'VERTICAL']),
  });

  return {
    table: {
      AprilTagProcessor: AprilTagProcessorClass,
      VisionPortal: VisionPortalClass,
      AprilTagGameDatabase: {
        getCurrentGameTagLibrary: () => ({ javaClass: 'AprilTagLibrary' }),
        getCenterStageTagLibrary: () => ({ javaClass: 'AprilTagLibrary' }),
      },
      Size: {},
    },
    constructors: {
      Size: class Size {
        constructor(width, height) {
          this.width = width;
          this.height = height;
        }
      },
    },
    tick() {},
  };
}
