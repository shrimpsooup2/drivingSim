/**
 * The SDK's device classes, wired to this simulator's robot.
 *
 * ## The one thing that has to be right
 *
 * On a real robot the two sides of a drivetrain are bolted on facing opposite
 * ways, so positive power turns the left wheels backwards. Every team's code
 * therefore contains `leftDrive.setDirection(DcMotor.Direction.REVERSE)`, and
 * without it the robot spins on the spot.
 *
 * This simulator's own kinematics works in *wheel* terms -- it computes the
 * torque each wheel needs and asks for it -- so if the motors were all
 * "positive is forward" then a team's code, with its REVERSE calls, would spin.
 * Their code would be wrong here and right on the robot, which is the worst
 * possible outcome for a practice tool.
 *
 * So a port has a **mount sign**: which way the motor is physically bolted on.
 * A `setPower` is multiplied by it, an encoder reading is multiplied by it, and
 * `setDirection(REVERSE)` multiplies again on top -- the same
 * `mountSign * orientationSign` the JVM simulator uses. Our own drive code
 * divides it back out, so both paths are correct at once: the built-in teleop
 * drives straight, and your op-mode drives straight *because* it reverses the
 * side that is mirrored.
 *
 * ## Names
 *
 * `hardwareMap.get(DcMotor.class, "leftFront")` has to find something. Nobody's
 * configuration matches ours, so names are matched loosely: case, separators
 * and word order are ignored, and the usual synonyms (`lf`, `left_front`,
 * `frontLeft`, `leftDrive`) all land on the same port. What resolved to what is
 * reported rather than assumed, because a silent mismatch is a robot that does
 * not move for no visible reason.
 *
 * A name that matches nothing gets a device that is modelled but attached to
 * nothing -- so the op-mode runs, the telemetry works, and the panel says which
 * ones are floating. Better than a crash on line one.
 *
 * @module
 */
import { javaError, makeEnum } from './lang.js';
import { radPerSecToRpm } from '../math/MathUtil.js';

/** `DcMotorSimple.Direction`, `Servo.Direction`. */
export const Direction = makeEnum('Direction', ['FORWARD', 'REVERSE']);
/** `DcMotor.RunMode`. */
export const RunMode = makeEnum('RunMode', [
  'RUN_WITHOUT_ENCODER', 'RUN_USING_ENCODER', 'RUN_TO_POSITION', 'STOP_AND_RESET_ENCODER',
]);
/** `DcMotor.ZeroPowerBehavior`. */
export const ZeroPowerBehavior = makeEnum('ZeroPowerBehavior', ['UNKNOWN', 'BRAKE', 'FLOAT']);
/** `LynxModule.BulkCachingMode`. */
export const BulkCachingMode = makeEnum('BulkCachingMode', ['OFF', 'AUTO', 'MANUAL']);

/**
 * Turning a configuration name into a drive port.
 *
 * `hardwareMap.get(DcMotor.class, "leftFront")` has to find something, and
 * nobody's configuration matches ours. So a name is broken into words -- on
 * separators, on camel case, and by pulling known words out of a run-together
 * one like `leftback` -- and each word is mapped to a side or an end. One of
 * {front, back} plus one of {left, right} is a port.
 *
 * Single letters are only read as letters once the long words are gone, which
 * is the trap this is written around: `leftback` contains an `f` (in "left"),
 * and an earlier version matched it as *front*-left. Two devices then drove the
 * same port, one wheel got nothing, and the robot drove in a curve -- from code
 * that was perfectly correct.
 */
const LONG_WORDS = [
  ['front', 'F'], ['fwd', 'F'], ['forward', 'F'],
  ['back', 'B'], ['rear', 'B'],
  ['left', 'L'],
  ['right', 'R'],
];

/** Words that say nothing about which wheel it is. */
const FILLER = /^(drive|motor|wheel|dt|drivetrain|mtr|m)$/;

const LETTERS = { f: 'F', b: 'B', r: 'R', l: 'L' };

/** Split on separators and camel-case humps. */
function words(name) {
  return String(name)
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((w) => w.toLowerCase());
}

/**
 * The side and end letters a name mentions, in the order they appear.
 * @returns {string[]}
 */
function letterCodes(name) {
  const out = [];
  for (const word of words(name)) {
    if (FILLER.test(word)) continue;
    let rest = word;
    // Long words first, so `left` is consumed before its `f` can be read as
    // `front`.
    let matched = true;
    while (matched && rest) {
      matched = false;
      for (const [text, code] of LONG_WORDS) {
        const at = rest.indexOf(text);
        if (at >= 0) {
          out.push(code);
          rest = rest.slice(0, at) + rest.slice(at + text.length);
          matched = true;
          break;
        }
      }
    }
    // Whatever is left is only read as letters if it is short enough to be an
    // abbreviation: `fl`, `br`, `l`. A longer leftover is somebody's own word.
    if (rest.length > 0 && rest.length <= 2) {
      for (const ch of rest) if (LETTERS[ch]) out.push(LETTERS[ch]);
    }
  }
  return out;
}

/**
 * The two-letter abbreviations that are genuinely ambiguous.
 *
 * `rr` is rear-right, not right-right, and `r` alone is right -- so the letter
 * cannot be resolved without knowing whether another one follows it. Spelling
 * the handful out is clearer than a rule that has to guess.
 */
const ABBREVIATIONS = {
  rr: 'backRight',
  rl: 'backLeft',
  ff: 'frontLeft',
};

const PORT_BY_CODE = {
  FL: 'frontLeft', LF: 'frontLeft',
  FR: 'frontRight', RF: 'frontRight',
  BL: 'backLeft', LB: 'backLeft',
  BR: 'backRight', RB: 'backRight',
};

/** Lowercase, letters and digits only, so `left_front` == `leftFront`. */
function normalise(name) {
  return String(name).toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Which port, or null.
 *
 * `also` carries the second port for a two-motor name: a team with
 * `leftDrive`/`rightDrive` has a two-motor robot, and driving half of a
 * four-wheel chassis here would be a robot that crawls for no reason visible
 * in their own code.
 */
function scoreWheel(name) {
  const flat = normalise(name);
  if (ABBREVIATIONS[flat]) return { port: ABBREVIATIONS[flat], also: [], strong: true };
  const codes = letterCodes(name);
  const end = codes.find((c) => c === 'F' || c === 'B');
  const side = codes.find((c) => c === 'L' || c === 'R');
  if (end && side) {
    const key = codes.filter((c) => c === end || c === side).slice(0, 2).join('');
    const port = PORT_BY_CODE[key] ?? PORT_BY_CODE[`${end}${side}`];
    if (port) return { port, also: [], strong: true };
  }
  if (side && !end) {
    return side === 'L'
      ? { port: 'frontLeft', also: ['backLeft'], strong: false }
      : { port: 'frontRight', also: ['backRight'], strong: false };
  }
  const numbered = /^(?:motor|m|drive)?([0-3])$/.exec(normalise(name));
  if (numbered) {
    const order = ['frontLeft', 'frontRight', 'backLeft', 'backRight'];
    return { port: order[Number(numbered[1])], also: [], strong: false };
  }
  return null;
}

// ---------------------------------------------------------------------------

/**
 * `DcMotor` and `DcMotorEx`, which are the same class here because every method
 * on `DcMotorEx` is one somebody's op-mode calls.
 */
export class DcMotor {
  /**
   * @param {{
   *   name: string,
   *   port?: import('../hardware/DriveMotor.js').DriveMotor|null,
   *   ports?: import('../hardware/DriveMotor.js').DriveMotor[],
   *   bus: import('../hardware/HardwareBus.js').HardwareBus,
   *   enabled: () => boolean,
   * }} opts
   */
  constructor(opts) {
    this.javaClass = 'DcMotorImplEx';
    this.deviceName = opts.name;
    /** Every simulator port this one device drives. Usually one. */
    this.ports = opts.ports ?? (opts.port ? [opts.port] : []);
    this.bus = opts.bus;
    this.enabled = opts.enabled;
    /** True when nothing on the robot answers to this name. */
    this.floating = this.ports.length === 0;

    this.direction = Direction.FORWARD;
    this.mode = RunMode.RUN_WITHOUT_ENCODER;
    this.zeroPower = ZeroPowerBehavior.BRAKE;
    this.power = 0;
    this.targetPosition = 0;
    this.targetTolerance = 20;
    /** Ticks reported when the encoder was last zeroed. */
    this.zeroOffset = 0;
    /** A motor with no port still has to have a position, so it gets a fake one. */
    this.virtualTicks = 0;
  }

  get primary() {
    return this.ports[0] ?? null;
  }

  /**
   * `Direction`, as a sign.
   *
   * Only the SDK's own flip lives here. Which way the motor is bolted on is the
   * port's business -- see `DriveMotor.mountSign` -- so the two multiply
   * naturally and a team reversing its mirrored side comes out driving forward.
   */
  get physicalSign() {
    return this.direction === Direction.REVERSE ? -1 : 1;
  }

  // ----------------------------------------------------------------- writes

  setDirection(direction) {
    this.bus.write();
    this.direction = direction ?? Direction.FORWARD;
    return this;
  }

  getDirection() {
    return this.direction;
  }

  /**
   * `setPower`.
   *
   * Held at zero until START, which is what the hub does: motors are disabled
   * between INIT and START, so an op-mode that sets power during its init
   * sequence does not move the robot -- here or on a field.
   */
  setPower(power) {
    this.bus.write();
    this.power = clampUnit(power);
    this._apply();
    return this;
  }

  getPower() {
    return this.power;
  }

  setMode(mode) {
    this.bus.write();
    if (mode === RunMode.STOP_AND_RESET_ENCODER) {
      this.zeroOffset = this._rawTicks();
      this.mode = RunMode.RUN_USING_ENCODER;
      for (const port of this.ports) port.controller.setPower(0);
      return this;
    }
    this.mode = mode ?? RunMode.RUN_WITHOUT_ENCODER;
    for (const port of this.ports) {
      port.controller.setMode(
        this.mode === RunMode.RUN_USING_ENCODER
          ? 'RUN_USING_ENCODER'
          : this.mode === RunMode.RUN_TO_POSITION
            ? 'RUN_TO_POSITION'
            : 'RUN_WITHOUT_ENCODER',
      );
    }
    this._apply();
    return this;
  }

  getMode() {
    return this.mode;
  }

  setZeroPowerBehavior(behaviour) {
    this.bus.write();
    this.zeroPower = behaviour ?? ZeroPowerBehavior.BRAKE;
    for (const port of this.ports) {
      port.controller.zeroPowerBehavior = this.zeroPower === ZeroPowerBehavior.FLOAT ? 'FLOAT' : 'BRAKE';
    }
    return this;
  }

  getZeroPowerBehavior() {
    return this.zeroPower;
  }

  setTargetPosition(ticks) {
    this.bus.write();
    this.targetPosition = Math.trunc(ticks);
    this._apply();
    return this;
  }

  getTargetPosition() {
    return this.targetPosition;
  }

  setTargetPositionTolerance(ticks) {
    this.bus.write();
    this.targetTolerance = Math.trunc(ticks);
    return this;
  }

  getTargetPositionTolerance() {
    return this.targetTolerance;
  }

  /** `DcMotorEx.setVelocity`, in ticks per second. */
  setVelocity(ticksPerSecond, unit) {
    this.bus.write();
    const perRev = this.primary?.encoder?.ticksPerOutputRev ?? 1;
    const value = unit && unit.__name === 'DEGREES' ? (ticksPerSecond / 360) * perRev : ticksPerSecond;
    this.mode = RunMode.RUN_USING_ENCODER;
    for (const port of this.ports) {
      port.controller.reversed = this.direction === Direction.REVERSE;
      port.controller.setMode('RUN_USING_ENCODER');
      port.controller.setVelocity((value * 2 * Math.PI) / (port.encoder?.ticksPerOutputRev ?? perRev));
    }
    return this;
  }

  setPIDFCoefficients(mode, coefficients) {
    this.bus.write();
    for (const port of this.ports) {
      port.controller.hubGains = {
        p: coefficients?.p ?? 0,
        i: coefficients?.i ?? 0,
        d: coefficients?.d ?? 0,
        f: coefficients?.f ?? 0,
      };
    }
    return this;
  }

  setVelocityPIDFCoefficients(p, i, d, f) {
    this.bus.write();
    for (const port of this.ports) port.controller.hubGains = { p, i, d, f };
    return this;
  }

  setPositionPIDFCoefficients(p) {
    this.bus.write();
    for (const port of this.ports) port.controller.positionP = p;
    return this;
  }

  resetDeviceConfigurationForOpMode() {
    this.bus.write();
    this.direction = Direction.FORWARD;
    this.mode = RunMode.RUN_WITHOUT_ENCODER;
    this.zeroPower = ZeroPowerBehavior.BRAKE;
    return this;
  }

  setMotorEnable() {
    return this;
  }

  setMotorDisable() {
    this.setPower(0);
    return this;
  }

  isMotorEnabled() {
    return true;
  }

  // ------------------------------------------------------------------ reads

  getCurrentPosition() {
    this.bus.cachedRead(`${this.deviceName}.position`);
    return Math.trunc(this._rawTicks() - this.zeroOffset);
  }

  /** `DcMotorEx.getVelocity`, ticks per second. */
  getVelocity(unit) {
    this.bus.cachedRead(`${this.deviceName}.velocity`);
    const port = this.primary;
    const raw = port ? this.physicalSign * port.encoder.velocityTicksPerSec : 0;
    if (unit && unit.__name === 'DEGREES') {
      return (raw / (port?.encoder?.ticksPerOutputRev ?? 1)) * 360;
    }
    return raw;
  }

  getCurrent(unit) {
    this.bus.cachedRead(`${this.deviceName}.current`);
    const amps = Math.abs(this.primary?.current ?? 0);
    return unit && unit.__name === 'MILLIAMPS' ? amps * 1000 : amps;
  }

  getCurrentAlert(unit) {
    return unit && unit.__name === 'MILLIAMPS' ? 20000 : 20;
  }

  setCurrentAlert() {
    this.bus.write();
    return this;
  }

  isOverCurrent() {
    this.bus.cachedRead(`${this.deviceName}.overcurrent`);
    return Math.abs(this.primary?.current ?? 0) > (this.primary?.controller.currentLimit ?? 20);
  }

  /** `isBusy`, which is only meaningful in RUN_TO_POSITION. */
  isBusy() {
    this.bus.cachedRead(`${this.deviceName}.position`);
    if (this.mode !== RunMode.RUN_TO_POSITION) return false;
    return Math.abs(this.getTargetPosition() - this.getCurrentPosition()) > this.targetTolerance;
  }

  getDeviceName() {
    return this.floating ? `${this.deviceName} (not on this robot)` : this.deviceName;
  }

  getPortNumber() {
    return 0;
  }

  getConnectionInfo() {
    return 'simulated';
  }

  toString() {
    return `DcMotor(${this.deviceName})`;
  }

  // ---------------------------------------------------------------- private

  _rawTicks() {
    const port = this.primary;
    if (!port) return this.virtualTicks;
    return this.physicalSign * port.encoder.ticks;
  }

  /**
   * Push the command down to the simulator's ports.
   *
   * `physicalSign` is applied here and nowhere else, so there is exactly one
   * place that decides which way a motor turns.
   */
  _apply() {
    const live = this.enabled();
    const reversed = this.direction === Direction.REVERSE;
    for (const port of this.ports) {
      // `Direction` is the SDK flipping the port, which is what our own
      // controller's `reversed` is. The mount sign is applied below it, in the
      // motor itself.
      port.controller.reversed = reversed;
      if (this.mode === RunMode.RUN_TO_POSITION) {
        port.controller.targetPosition =
          ((this.targetPosition + this.zeroOffset) / (port.encoder.ticksPerOutputRev || 1)) * 2 * Math.PI;
        port.controller.setPower(live ? Math.abs(this.power) : 0);
      } else {
        port.controller.setPower(live ? this.power : 0);
      }
    }
  }

  /** Called every cycle by the runtime, so START releases the motors. */
  refresh() {
    this._apply();
  }
}

/** `DcMotorEx` is the same object; the SDK's split is a compile-time thing. */
export const DcMotorEx = DcMotor;
/** `DcMotorSimple`, for `DcMotorSimple.Direction`. */
export const DcMotorSimple = { Direction };

// ---------------------------------------------------------------------------

/** A servo. Modelled as a position that moves at a finite rate. */
export class Servo {
  constructor(opts) {
    this.javaClass = 'ServoImpl';
    this.deviceName = opts.name;
    this.bus = opts.bus;
    this.subsystem = opts.subsystem ?? null;
    this.floating = !this.subsystem;
    this.direction = Direction.FORWARD;
    this.target = 0;
    this.position = 0;
    this.min = 0;
    this.max = 1;
    /** A full sweep in about 0.4 s, which is a typical hobby servo. */
    this.rate = 2.5;
  }

  setPosition(position) {
    this.bus.write();
    this.target = clamp01(position);
    this.subsystem?.setServo?.(this.deviceName, this.scaled);
    return this;
  }

  getPosition() {
    this.bus.read();
    return this.position;
  }

  get scaled() {
    const p = this.direction === Direction.REVERSE ? 1 - this.target : this.target;
    return this.min + p * (this.max - this.min);
  }

  setDirection(direction) {
    this.bus.write();
    this.direction = direction ?? Direction.FORWARD;
    return this;
  }

  getDirection() {
    return this.direction;
  }

  scaleRange(min, max) {
    this.min = clamp01(min);
    this.max = clamp01(max);
    return this;
  }

  getController() {
    return { pwmEnable: () => {}, pwmDisable: () => {} };
  }

  getPortNumber() {
    return 0;
  }

  getDeviceName() {
    return this.deviceName;
  }

  /** Advance toward the commanded position. Called by the runtime each cycle. */
  step(dt) {
    const target = this.target;
    const step = this.rate * dt;
    if (Math.abs(target - this.position) <= step) this.position = target;
    else this.position += Math.sign(target - this.position) * step;
  }
}

/** A continuous-rotation servo, which is a motor with a servo's interface. */
export class CRServo {
  constructor(opts) {
    this.javaClass = 'CRServoImpl';
    this.deviceName = opts.name;
    this.bus = opts.bus;
    this.subsystem = opts.subsystem ?? null;
    this.floating = !this.subsystem;
    this.direction = Direction.FORWARD;
    this.power = 0;
  }

  setPower(power) {
    this.bus.write();
    this.power = clampUnit(power) * (this.direction === Direction.REVERSE ? -1 : 1);
    this.subsystem?.setPower?.(this.power);
    return this;
  }

  getPower() {
    return this.power;
  }

  setDirection(direction) {
    this.bus.write();
    this.direction = direction ?? Direction.FORWARD;
    return this;
  }

  getDirection() {
    return this.direction;
  }

  getDeviceName() {
    return this.deviceName;
  }
}

// ---------------------------------------------------------------------------

/**
 * The hardware map: names in, devices out.
 *
 * Devices are created on first ask and kept, because an op-mode that calls
 * `hardwareMap.get` twice for the same name expects the same object -- and
 * because each creation is a configuration lookup that ought to happen once.
 */
export class HardwareMap {
  /**
   * @param {{
   *   robot: import('../robot/Robot.js').Robot,
   *   bus: import('../hardware/HardwareBus.js').HardwareBus,
   *   enabled: () => boolean,
   *   warn: (message: string) => void,
   * }} opts
   */
  constructor(opts) {
    this.robot = opts.robot;
    this.bus = opts.bus;
    this.enabled = opts.enabled;
    this.warn = opts.warn;
    /** @type {Map<string, any>} */
    this.devices = new Map();
    /** What resolved to what, for the panel. */
    this.resolutions = [];
    /** `hardwareMap.voltageSensor` is iterated, not `get`-ed. */
    this.voltageSensor = new VoltageSensorCollection(this);
    this.appContext = null;
  }

  /**
   * `hardwareMap.get(DcMotor.class, "name")`, and the one-argument form.
   *
   * The class is used only to decide what *kind* of device to make; the SDK
   * uses it to pick a driver and so do we.
   */
  get(classOrName, maybeName) {
    const name = maybeName === undefined ? classOrName : maybeName;
    const kind = maybeName === undefined ? null : classOrName;
    const key = `${kindName(kind)}:${name}`;
    if (this.devices.has(key)) return this.devices.get(key);
    const device = this.create(kindName(kind), String(name));
    this.devices.set(key, device);
    return device;
  }

  /** `hardwareMap.dcMotor.get("name")` and the other typed collections. */
  get dcMotor() {
    return this.collection('DcMotor');
  }

  get servo() {
    return this.collection('Servo');
  }

  get crservo() {
    return this.collection('CRServo');
  }

  collection(kind) {
    const map = this;
    return {
      get: (name) => map.get({ __class: kind }, name),
      iterator: () => [...map.devices.values()].filter((d) => d.javaClass?.includes(kind))[Symbol.iterator](),
      [Symbol.iterator]() {
        return this.iterator();
      },
    };
  }

  tryGet(classOrName, maybeName) {
    try {
      return this.get(classOrName, maybeName);
    } catch {
      return null;
    }
  }

  getAll() {
    return [...this.devices.values()];
  }

  /** @param {string} kind @param {string} name */
  create(kind, name) {
    if (kind === 'IMU' || kind === 'BNO055IMU' || normalise(name) === 'imu') {
      return new ImuDevice({ name, robot: this.robot, bus: this.bus });
    }
    if (kind === 'VoltageSensor') {
      return new VoltageSensor({ name, robot: this.robot, bus: this.bus });
    }
    if (kind === 'Servo') {
      const subsystem = this.matchSubsystem(name);
      this.record(name, 'Servo', subsystem ? subsystem.label : null);
      return new Servo({ name, bus: this.bus, subsystem: subsystem?.target ?? null });
    }
    if (kind === 'CRServo') {
      const subsystem = this.matchSubsystem(name);
      this.record(name, 'CRServo', subsystem ? subsystem.label : null);
      return new CRServo({ name, bus: this.bus, subsystem: subsystem?.target ?? null });
    }
    if (kind === 'WebcamName' || kind === 'CameraName') {
      return { javaClass: 'WebcamName', deviceName: name, getDeviceName: () => name };
    }
    if (kind === 'TouchSensor' || kind === 'DigitalChannel') {
      return new TouchSensor({ name, bus: this.bus });
    }
    if (kind === 'DistanceSensor' || kind === 'Rev2mDistanceSensor') {
      return new DistanceSensor({ name, bus: this.bus, robot: this.robot });
    }
    if (kind === 'ColorSensor' || kind === 'NormalizedColorSensor' || kind === 'RevColorSensorV3') {
      return new ColorSensor({ name, bus: this.bus });
    }
    if (kind === 'LynxModule') {
      return new LynxModule({ name, bus: this.bus });
    }
    // Anything else asked for by name is treated as a motor, which is what it
    // almost always is.
    return this.createMotor(name);
  }

  createMotor(name) {
    const wheel = scoreWheel(name);
    if (wheel) {
      const ports = [wheel.port, ...wheel.also]
        .map((port) => this.robot.drivetrain.motors.find((m) => m.name === port))
        .filter(Boolean);
      if (ports.length > 0) {
        this.record(name, 'DcMotor', ports.map((p) => p.name).join(' + '));
        return new DcMotor({ name, ports, bus: this.bus, enabled: this.enabled });
      }
    }
    const subsystem = this.matchSubsystem(name);
    if (subsystem) {
      this.record(name, 'DcMotor', subsystem.label);
      return new SubsystemMotor({
        name,
        bus: this.bus,
        enabled: this.enabled,
        subsystem: subsystem.target,
        role: subsystem.role,
      });
    }
    this.record(name, 'DcMotor', null);
    this.warn(
      `nothing on this robot answers to "${name}", so it is modelled but drives nothing. ` +
        'Name a drive port (leftFront, rightBack, ...) or a mechanism (shooter, intake, ...).',
    );
    return new DcMotor({ name, ports: [], bus: this.bus, enabled: this.enabled });
  }

  /** A mechanism, matched by what the name sounds like. */
  matchSubsystem(name) {
    const flat = normalise(name);
    const shooter = this.robot.subsystems.find((s) => typeof s.fire === 'function');
    const intake = this.robot.subsystems.find((s) => 'held' in s && 'capacity' in s);
    const SHOOTER_WORDS = ['shoot', 'shooter', 'flywheel', 'launch', 'launcher', 'fly', 'turret', 'catapult', 'throw'];
    const INTAKE_WORDS = ['intake', 'roller', 'collect', 'sweep', 'suck', 'feeder', 'hopper'];
    if (shooter && SHOOTER_WORDS.some((w) => flat.includes(w))) {
      return { target: shooter, label: 'the launcher', role: 'shooter' };
    }
    if (intake && INTAKE_WORDS.some((w) => flat.includes(w))) {
      return { target: intake, label: 'the intake', role: 'intake' };
    }
    return null;
  }

  record(name, kind, attachedTo) {
    this.resolutions.push({ name, kind, attachedTo });
  }
}

function kindName(kind) {
  if (!kind) return 'DcMotor';
  if (typeof kind === 'string') return kind.split('.').pop();
  if (kind.__class) return String(kind.__class).split('.').pop();
  return 'DcMotor';
}

/**
 * A motor that drives a mechanism rather than a wheel.
 *
 * The flywheel and the intake are modelled as subsystems with their own
 * controls, not as bare ports, so this translates a power command into what
 * that subsystem understands -- and reports an encoder position integrated from
 * its actual speed, so a team's RPM readout works.
 */
export class SubsystemMotor extends DcMotor {
  constructor(opts) {
    super({ ...opts, ports: [] });
    this.subsystem = opts.subsystem;
    this.role = opts.role;
    this.floating = false;
    this.accumulated = 0;
  }

  get physicalSign() {
    return this.direction === Direction.REVERSE ? -1 : 1;
  }

  _apply() {
    if (!this.subsystem) return;
    const live = this.enabled();
    const power = live ? this.power * this.physicalSign : 0;
    if (this.role === 'intake') {
      this.subsystem.command = power;
      return;
    }
    // A flywheel: a power command spins it toward that fraction of free speed,
    // and `setVelocity` has already been turned into one.
    if (typeof this.subsystem.setTargetRpm === 'function') {
      const max = this.subsystem.maxRpm ?? 3000;
      this.subsystem.spinning = Math.abs(power) > 0.02;
      if (this.subsystem.spinning) this.subsystem.setTargetRpm(Math.abs(power) * max);
    } else if ('command' in this.subsystem) {
      this.subsystem.command = power;
    }
  }

  _rawTicks() {
    return this.accumulated;
  }

  getVelocity(unit) {
    this.bus.cachedRead(`${this.deviceName}.velocity`);
    const rpm = this.subsystem?.rpm ?? 0;
    const perRev = 28;
    const tps = (rpm / 60) * perRev * this.physicalSign;
    return unit && unit.__name === 'DEGREES' ? (tps / perRev) * 360 : tps;
  }

  step(dt) {
    // Integrate the mechanism's own speed so `getCurrentPosition` moves.
    const rpm = this.subsystem?.rpm ?? (this.subsystem?.power ?? 0) * 1000;
    this.accumulated += (rpm / 60) * 28 * dt * this.physicalSign;
  }
}

// ---------------------------------------------------------------------------

/** `AngleUnit`, with the conversions op-modes actually call. */
export const AngleUnit = (() => {
  const unit = makeEnum('AngleUnit', ['DEGREES', 'RADIANS']);
  for (const name of ['DEGREES', 'RADIANS']) {
    const constant = unit[name];
    const toDeg = (v) => (name === 'DEGREES' ? v : (v * 180) / Math.PI);
    const toRad = (v) => (name === 'DEGREES' ? (v * Math.PI) / 180 : v);
    constant.toDegrees = toDeg;
    constant.toRadians = toRad;
    constant.fromDegrees = (v) => (name === 'DEGREES' ? v : (v * Math.PI) / 180);
    constant.fromRadians = (v) => (name === 'DEGREES' ? (v * 180) / Math.PI : v);
    constant.fromUnit = (from, value) => (from.__name === name ? value : name === 'DEGREES' ? (value * 180) / Math.PI : (value * Math.PI) / 180);
    constant.normalize = (v) => {
      const full = name === 'DEGREES' ? 360 : Math.PI * 2;
      const half = full / 2;
      return ((((v + half) % full) + full) % full) - half;
    };
  }
  return unit;
})();

/** `DistanceUnit`. Metres are the simulator's own, so they are the pivot. */
export const DistanceUnit = (() => {
  const unit = makeEnum('DistanceUnit', ['METER', 'CM', 'MM', 'INCH']);
  const PER_METRE = { METER: 1, CM: 100, MM: 1000, INCH: 1 / 0.0254 };
  for (const name of Object.keys(PER_METRE)) {
    const constant = unit[name];
    constant.fromMeters = (v) => v * PER_METRE[name];
    constant.toMeters = (v) => v / PER_METRE[name];
    constant.fromInches = (v) => (v / PER_METRE.INCH) * PER_METRE[name];
    constant.toInches = (v) => (v / PER_METRE[name]) * PER_METRE.INCH;
    constant.fromCm = (v) => (v / PER_METRE.CM) * PER_METRE[name];
    constant.toCm = (v) => (v / PER_METRE[name]) * PER_METRE.CM;
    constant.fromUnit = (from, value) => (value / PER_METRE[from.__name]) * PER_METRE[name];
  }
  unit.METERS = unit.METER;
  return unit;
})();

export const CurrentUnit = makeEnum('CurrentUnit', ['AMPS', 'MILLIAMPS']);
export const UnnormalizedAngleUnit = AngleUnit;

/** `IMU`, and the older `BNO055IMU` shape as well. */
export class ImuDevice {
  constructor(opts) {
    this.javaClass = 'IMU';
    this.deviceName = opts.name;
    this.robot = opts.robot;
    this.bus = opts.bus;
    this.floating = false;
  }

  initialize() {
    this.bus.i2c();
    return true;
  }

  resetYaw() {
    this.robot.resetHeading();
    return this;
  }

  /** `getRobotYawPitchRollAngles()`, the current API. */
  getRobotYawPitchRollAngles() {
    const yaw = this.robot.readHeading();
    return {
      javaClass: 'YawPitchRollAngles',
      getYaw: (unit) => convertAngle(yaw, unit),
      getPitch: (unit) => convertAngle(0, unit),
      getRoll: (unit) => convertAngle(0, unit),
      getAcquisitionTime: () => 0,
      toString: () => `yaw ${((yaw * 180) / Math.PI).toFixed(2)}`,
    };
  }

  /** `getRobotAngularVelocity()`. */
  getRobotAngularVelocity(unit) {
    this.bus.i2c();
    const rate = this.robot.imu.angularVelocity;
    return {
      javaClass: 'AngularVelocity',
      zRotationRate: convertAngle(rate, unit),
      xRotationRate: 0,
      yRotationRate: 0,
    };
  }

  /** The 2019-era API, which a lot of code still uses. */
  getAngularOrientation(order, firstUnit, secondUnit, thirdUnit) {
    const yaw = this.robot.readHeading();
    const unit = firstUnit ?? AngleUnit.RADIANS;
    return {
      javaClass: 'Orientation',
      firstAngle: convertAngle(yaw, unit),
      secondAngle: 0,
      thirdAngle: 0,
    };
  }

  getDeviceName() {
    return this.deviceName;
  }

  close() {}
}

function convertAngle(radians, unit) {
  return unit && unit.__name === 'DEGREES' ? (radians * 180) / Math.PI : radians;
}

/** `VoltageSensor`. */
export class VoltageSensor {
  constructor(opts) {
    this.javaClass = 'VoltageSensor';
    this.deviceName = opts.name;
    this.robot = opts.robot;
    this.bus = opts.bus;
    this.floating = false;
  }

  getVoltage() {
    return this.robot.readVoltage();
  }

  getDeviceName() {
    return this.deviceName;
  }
}

/** `hardwareMap.voltageSensor`, which op-modes iterate rather than `get`. */
class VoltageSensorCollection {
  constructor(map) {
    this.map = map;
  }

  get(name) {
    return this.map.get({ __class: 'VoltageSensor' }, name ?? 'Control Hub');
  }

  iterator() {
    return [this.get('Control Hub')][Symbol.iterator]();
  }

  [Symbol.iterator]() {
    return this.iterator();
  }
}

/** A touch sensor, which this simulator has nothing to attach to. */
export class TouchSensor {
  constructor(opts) {
    this.javaClass = 'TouchSensor';
    this.deviceName = opts.name;
    this.bus = opts.bus;
    this.floating = true;
    /** Editable from the inspector, so a limit switch can be poked. */
    this.pressed = false;
  }

  isPressed() {
    this.bus.cachedRead(`${this.deviceName}.pressed`);
    return this.pressed;
  }

  getState() {
    return !this.isPressed();
  }

  setMode() {
    return this;
  }

  getDeviceName() {
    return this.deviceName;
  }
}

/** A distance sensor, reading to the nearest wall. */
export class DistanceSensor {
  constructor(opts) {
    this.javaClass = 'DistanceSensor';
    this.deviceName = opts.name;
    this.bus = opts.bus;
    this.robot = opts.robot;
    this.floating = false;
  }

  getDistance(unit) {
    this.bus.i2c();
    // Straight ahead, to whichever wall the robot is pointing at. Crude, and
    // honest about it: the simulator has no ray cast against the structures.
    const body = this.robot.body;
    const half = 1.8161;
    const c = Math.cos(body.rotation.radians);
    const s = Math.sin(body.rotation.radians);
    const distances = [];
    if (c > 1e-6) distances.push((half - body.position.x) / c);
    if (c < -1e-6) distances.push((-half - body.position.x) / c);
    if (s > 1e-6) distances.push((half - body.position.y) / s);
    if (s < -1e-6) distances.push((-half - body.position.y) / s);
    const metres = Math.max(0, Math.min(...distances) - this.robot.halfLength);
    const capped = Math.min(metres, 2);
    return unit ? unit.fromMeters(capped) : capped * 100;
  }

  getDeviceName() {
    return this.deviceName;
  }
}

/** A colour sensor, which reports what the tile under the robot looks like. */
export class ColorSensor {
  constructor(opts) {
    this.javaClass = 'ColorSensor';
    this.deviceName = opts.name;
    this.bus = opts.bus;
    this.floating = true;
    this.rgb = { red: 40, green: 40, blue: 48, alpha: 128 };
  }

  red() {
    this.bus.i2c();
    return this.rgb.red;
  }

  green() {
    this.bus.i2c();
    return this.rgb.green;
  }

  blue() {
    this.bus.i2c();
    return this.rgb.blue;
  }

  alpha() {
    this.bus.i2c();
    return this.rgb.alpha;
  }

  argb() {
    return (this.rgb.alpha << 24) | (this.rgb.red << 16) | (this.rgb.green << 8) | this.rgb.blue;
  }

  enableLed() {
    return this;
  }

  getDeviceName() {
    return this.deviceName;
  }
}

/** `LynxModule`, for the bulk caching calls. */
export class LynxModule {
  constructor(opts) {
    this.javaClass = 'LynxModule';
    this.deviceName = opts.name;
    this.bus = opts.bus;
    this.floating = false;
  }

  setBulkCachingMode(mode) {
    this.bus.cachingMode = mode?.__name ?? 'AUTO';
    return this;
  }

  getBulkCachingMode() {
    return BulkCachingMode[this.bus.cachingMode] ?? BulkCachingMode.AUTO;
  }

  clearBulkCache() {
    this.bus.clearBulkCache();
    return this;
  }

  getDeviceName() {
    return this.deviceName;
  }

  isParent() {
    return true;
  }
}

function clampUnit(value) {
  const v = Number(value);
  if (!Number.isFinite(v)) throw javaError('IllegalArgumentException', 'power must be a number');
  return Math.max(-1, Math.min(1, v));
}

function clamp01(value) {
  const v = Number(value) || 0;
  return Math.max(0, Math.min(1, v));
}

export { normalise as normaliseDeviceName, scoreWheel as matchWheelName, radPerSecToRpm };
