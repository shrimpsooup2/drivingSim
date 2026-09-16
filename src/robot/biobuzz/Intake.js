import { Subsystem } from '../Subsystem.js';
import { DcMotor } from '../../hardware/DcMotor.js';
import { MOTOR_PRESETS } from '../../config/presets/motors.js';
import { INCH } from '../../math/MathUtil.js';
import { MAX_CONTROLLED } from '../../field/biobuzz/constants.js';

/**
 * A roller intake across the front of the ROBOT.
 *
 * Modelled as a capture wedge rather than as geometry: anything loose inside a
 * cone in front of the bumper, below the roller height, gets swept up while the
 * roller is running. That is close enough to how a compliant-wheel intake
 * behaves and it keeps the thing a driver has to learn honest -- you must point
 * the front of the ROBOT at the element and drive over it, and you cannot
 * collect while retreating from it faster than the roller pulls.
 *
 * Running it costs current, so hammering the intake while pushing a pile of
 * POLLEN sags the battery and slows the drivetrain. That coupling is the
 * reason it draws from the same bus rather than being free.
 */
export class Intake extends Subsystem {
  /**
   * @param {{
   *   name?: string,
   *   capacity?: number,
   *   reach?: number,
   *   halfAngle?: number,
   *   maxHeight?: number,
   *   captureSpeed?: number,
   *   motor?: import('../../hardware/DcMotor.js').DcMotor,
   *   gearRatio?: number,
   *   rollerRadius?: number,
   *   spinUpTime?: number,
   *   grabber?: boolean,
   *   graspSpeed?: number,
   *   canPlace?: boolean,
   *   placeOnly?: boolean,
   *   placeReach?: number,
   *   placeTolerance?: number,
   *   placeSeconds?: number,
   * }} [opts]
   */
  constructor(opts = {}) {
    super({ name: opts.name ?? 'intake' });

    /** How many SCORING ELEMENTS the ROBOT can hold at once. */
    /**
     * How many elements it can hold, capped at G407's limit of 4.
     *
     * Clamped rather than trusted: a mechanism that holds five is illegal, and
     * a few archetypes had been given six on the grounds that a big hopper is
     * a real design. It is not a legal one, and now that the MATCH has a
     * REFEREE it showed up as a MAJOR FOUL and a YELLOW CARD every MATCH.
     */
    this.capacity = Math.min(MAX_CONTROLLED, opts.capacity ?? 3);
    /** How far in front of the bumper the roller can reach. */
    this.reach = opts.reach ?? 4 * INCH;
    /** Half-width of the capture cone. */
    this.halfAngle = opts.halfAngle ?? 0.6;
    /** Nothing above this is swept up -- the roller is low. */
    this.maxHeight = opts.maxHeight ?? 6 * INCH;
    /**
     * How fast the ROBOT may be moving *away* from an element and still take
     * it. Drive backwards off a POLLEN and the intake loses it.
     */
    this.captureSpeed = opts.captureSpeed ?? 0.35;

    this.motor = opts.motor ?? new DcMotor(MOTOR_PRESETS.gobilda5203);
    this.gearRatio = opts.gearRatio ?? 3;
    this.rollerRadius = opts.rollerRadius ?? 1 * INCH;
    /** Roller inertia reflected to the motor; small, so it spins up fast. */
    this.spinUpTime = opts.spinUpTime ?? 0.15;

    /**
     * Whether this ROBOT has a lift that can put an element into a FLOWER.
     *
     * Section 9.7 and G419: "The FLOWERS are designed and intended to only
     * allow POLLEN and NECTAR to enter through the top of the top ring", and
     * G419.A permits a ROBOT only to "enter POLLEN and NECTAR into the top of
     * a FLOWER". The top ring is 21.25 in up, so scoring in a FLOWER needs
     * something that lifts an element over that rim and lets go -- a shot
     * cannot do it, because the tube's clearance for a POLLEN is 0.6 in.
     *
     * Modelled as a cost rather than as geometry: line the front of the ROBOT
     * up with the tube, hold the eject, and the lift cycle takes
     * `placeSeconds`. That is the trade a real one makes -- a FLOWER pays 2 per
     * element and cannot be tipped away, but filling one means stopping still
     * next to it for a second at a time.
     */
    /**
     * A jaw rather than a roller.
     *
     * A claw has to close on one element, which means the ROBOT has to be
     * nearly stopped and pointed at it -- you cannot sweep a pile with a
     * gripper. Everything else about it is the same interaction, so it is a
     * flag on the intake rather than a class of its own; what makes a clawbot
     * play differently is the standing still, and this is where that lives.
     */
    this.grabber = opts.grabber ?? false;
    /** How fast a grabber may be moving and still close on something. */
    this.graspSpeed = opts.graspSpeed ?? 0.18;

    this.canPlace = opts.canPlace ?? true;
    /**
     * Never spit onto the tiles -- eject means "place into a FLOWER" and
     * nothing else.
     *
     * For a human, one button that puts the element wherever it can go is the
     * right control. For an automated routine it is not: an AI that drifts an
     * inch out of alignment part-way through a lift would drop the element on
     * the floor and go and fetch another, and a FLOWER robot spent its MATCH
     * moving POLLEN from a tube onto the tiles.
     */
    this.placeOnly = opts.placeOnly ?? false;
    /** How far ahead of the bumper the lift can reach a tube axis. */
    this.placeReach = opts.placeReach ?? 9 * INCH;
    /** How far off the tube axis the ROBOT may be and still drop it in. */
    this.placeTolerance = opts.placeTolerance ?? 2.5 * INCH;
    /** One lift-and-release cycle. */
    this.placeSeconds = opts.placeSeconds ?? 0.9;

    /**
     * Whether this intake refuses the opponent's NECTAR.
     *
     * G408: "A ROBOT may not CONTROL the opponent's NECTAR." An element of the
     * wrong colour is worth nothing to you -- a NECTAR only scores for its own
     * ALLIANCE -- so a team has every reason to sense the colour and reject it,
     * and colour sensing is standard kit. Modelling that as the default is
     * what stops a mechanism committing a rule violation its team has no way
     * to prevent: without it a wide intake driven across a stray NECTAR swept
     * it up, and an AI robot collected a YELLOW CARD in a MATCH for something
     * no real robot does.
     *
     * Off is a real robot too, and a real hazard to drill: then steering
     * around the other colour is the driver's job.
     */
    this.sortByAlliance = opts.sortByAlliance ?? true;

    /** -1 eject, 0 off, +1 intake. */
    this.command = 0;
    /** Ramped version of `command`, so the roller is not instantly at speed. */
    this.power = 0;
    /** @type {import('../../physics/Ball.js').Ball[]} */
    this.held = [];
    this.current = 0;
    /** Set by the app so the intake can see loose elements. */
    this.ballWorld = null;
    /** Set by the app so the intake can pull POLLEN out of a FLOWER. */
    this.flowers = [];

    this._ejectCooldown = 0;
    /** Seconds into the current FLOWER lift cycle. */
    this._placeTimer = 0;
    /** @type {import('../../field/biobuzz/Flower.js').Flower|null} */
    this._placingInto = null;
  }

  get full() {
    return this.held.length >= this.capacity;
  }

  /**
   * G403/G404: whether the roller is being *told* to run.
   *
   * The command, not `power`. `power` is the ramped version, and it takes most
   * of half a second to decay below anything -- so reading it counted a roller
   * spinning down as powered movement, which is exactly what the rule excuses:
   * "movement due to inertia, gravity, or de-energizing of actuators".
   */
  get commandedEffort() {
    return Math.abs(this.command);
  }

  /**
   * Fold the carried elements back into the robot's mass and centre of gravity.
   *
   * `massContribution` is only read when the robot recomputes, and nothing else
   * knows the intake's contents just changed -- so without this a full magazine
   * weighed nothing and shifted nothing. Four POLLEN is only 0.18 kg on an 18 kg
   * robot, but it sits forward of centre, and that is where a tippy robot
   * notices it.
   */
  _contentsChanged() {
    this.robot?.updateMassProperties();
  }

  get count() {
    return this.held.length;
  }

  /** Free speed of the roller surface at the current bus voltage, m/s. */
  surfaceSpeed(busVoltage = 12) {
    return (
      (this.motor.freeSpeedAt(busVoltage) / this.gearRatio) * this.rollerRadius
    );
  }

  /**
   * @param {number} dt
   * @param {import('../../input/FtcGamepad.js').FtcGamepad} gamepad
   */
  updateControl(dt, gamepad) {
    if (!gamepad) return;
    const intake = gamepad.right_bumper;
    const eject = gamepad.left_bumper;
    this.command = intake ? 1 : eject ? -1 : 0;
  }

  /**
   * Ramp the roller and pull in anything inside the capture wedge.
   * @param {number} dt
   * @param {number} busVoltage
   */
  applyForces(dt, busVoltage) {
    const tau = Math.max(1e-3, this.spinUpTime);
    this.power += (this.command - this.power) * Math.min(1, dt / tau);
    if (Math.abs(this.power) < 1e-3) this.power = 0;

    // A roller running free against nothing sits near free speed; each element
    // in the throat loads it down.
    const load = 1 + this.held.length * 0.25;
    const omega =
      this.motor.freeSpeedAt(busVoltage) * (1 - 0.25 * Math.min(1, load - 1));
    const result = this.motor.evaluate(
      busVoltage * this.power,
      omega * Math.sign(this.power || 1),
    );
    // Bus current is duty times winding current, as everywhere else.
    this.current = Math.abs(this.power * result.current);

    this._ejectCooldown = Math.max(0, this._ejectCooldown - dt);

    if (this.power > 0.4) {
      this._cancelPlace();
      this._collect();
    } else if (this.power < -0.4) {
      this._eject(dt);
    } else {
      this._cancelPlace();
    }

    return this.current;
  }

  /**
   * The FLOWER this ROBOT is lined up to place into, if any.
   *
   * Measured from the mouth of the intake to the tube axis: ahead of the
   * bumper, within reach, and within the alignment window across. Public
   * because the HUD says "LEFT BUMPER place in FLOWER" when it is non-null,
   * and because the AI uses the same test to decide it has arrived.
   */
  alignedFlower() {
    if (!this.canPlace || !this.robot || this.held.length === 0) return null;
    const { x, y, cos, sin } = this.pose;
    const mouthX = x + cos * this.robot.halfLength;
    const mouthY = y + sin * this.robot.halfLength;
    let best = null;
    let bestAhead = Infinity;
    for (const flower of this.flowers) {
      const dx = flower.x - mouthX;
      const dy = flower.y - mouthY;
      const ahead = dx * cos + dy * sin;
      const across = -dx * sin + dy * cos;
      if (ahead < -this.placeTolerance || ahead > this.placeReach) continue;
      if (Math.abs(across) > this.placeTolerance) continue;
      if (flower.restHeightFor(this.held[0].radius) === null) continue;
      if (ahead < bestAhead) {
        bestAhead = ahead;
        best = flower;
      }
    }
    return best;
  }

  /** Progress through the current FLOWER lift, 0 to 1, for a HUD bar. */
  get placeProgress() {
    if (!this._placingInto) return 0;
    return Math.min(1, this._placeTimer / Math.max(1e-3, this.placeSeconds));
  }

  _cancelPlace() {
    this._placingInto = null;
    this._placeTimer = 0;
  }

  _collect() {
    if (this.full || !this.robot) return;
    let changed = false;
    const { x, y, cos, sin, vx, vy } = this.pose;
    // A jaw has to be still to close on something. A roller does not, which is
    // most of why a roller robot cycles faster than a clawbot.
    if (this.grabber && Math.hypot(vx, vy) > this.graspSpeed) return;
    const mouthX = x + cos * this.robot.halfLength;
    const mouthY = y + sin * this.robot.halfLength;

    if (this.ballWorld) {
      for (const ball of this.ballWorld.balls) {
        if (!ball.free || this.full) continue;
        if (ball.z - ball.radius > this.maxHeight) continue;

        if (this._rejects(ball)) continue;

        const dx = ball.x - mouthX;
        const dy = ball.y - mouthY;
        const ahead = dx * cos + dy * sin;
        const lateral = -dx * sin + dy * cos;
        if (ahead < -this.robot.halfLength * 0.5) continue;
        const range = Math.hypot(ahead, lateral);
        if (range > this.reach + ball.radius) continue;
        if (Math.abs(Math.atan2(lateral, Math.max(ahead, 1e-6))) > this.halfAngle) {
          continue;
        }

        // Closing speed along the mouth axis. Backing away loses the element.
        const rel = (ball.vx - vx) * cos + (ball.vy - vy) * sin;
        if (rel > this.captureSpeed) continue;

        this.held.push(ball.attachTo('intake', this));
        changed = true;
      }
    }

    // Section 8: "ROBOTS can use sensors to collect POLLEN from FLOWERS". G418
    // allows removal from the bottom only, and only POLLEN fits.
    //
    // Not for a ROBOT built to fill them, though. A FLOWER robot spends its
    // MATCH parked against a tube with its intake running, and this pulled
    // POLLEN out of the bottom of the very FLOWER it had just filled -- a loop
    // that scores nothing and empties a tube it had already paid for. One left
    // a FLOWER on a single element after two minutes of work.
    for (const flower of this.placeOnly ? [] : this.flowers) {
      if (this.full) break;
      const dx = flower.x - mouthX;
      const dy = flower.y - mouthY;
      const ahead = dx * cos + dy * sin;
      const lateral = -dx * sin + dy * cos;
      if (ahead < 0 || ahead > this.reach + 3 * INCH) continue;
      if (Math.abs(lateral) > 3 * INCH) continue;
      const taken = flower.removeBottom();
      if (taken) {
        this.held.push(taken.attachTo('intake', this));
        changed = true;
      }
    }

    if (changed) this._contentsChanged();
  }

  /**
   * Whether this intake should leave an element alone: G408's wrong-colour
   * NECTAR, when it is built to tell. See `sortByAlliance`.
   * @param {import('../../physics/Ball.js').Ball} ball
   */
  _rejects(ball) {
    if (!this.sortByAlliance || ball.kind !== 'nectar') return false;
    const mine = this.owner?.alliance;
    return Boolean(mine) && ball.alliance !== mine;
  }

  /** Spit the front element out onto the tiles, one at a time. */
  _eject(dt = 0) {
    if (this.held.length === 0 || !this.robot) {
      this._cancelPlace();
      return;
    }

    // Lined up with a FLOWER, the eject means "put it in there" instead of
    // "spit it on the floor". It takes a moment, and moving out of alignment
    // part-way through abandons the cycle with the element still held.
    const flower = this.alignedFlower();
    if (flower) {
      if (this._placingInto !== flower) {
        this._placingInto = flower;
        this._placeTimer = 0;
      }
      this._placeTimer += dt;
      if (this._placeTimer < this.placeSeconds) return;
      const ball = this.held.shift();
      // `add` rather than `interactBall`: the lift has carried it over the rim,
      // so the question was whether the ROBOT was lined up, and that is what
      // `alignedFlower` just answered. Dropping it from the floor could never
      // enter -- the tube's clearance for a POLLEN is 0.6 in.
      if (!flower.add(ball)) this.held.unshift(ball);
      this._cancelPlace();
      this._ejectCooldown = 0.25;
      this._contentsChanged();
      return;
    }
    this._cancelPlace();

    if (this.placeOnly) return;
    if (this._ejectCooldown > 0) return;
    const ball = this.held.shift();
    const { x, y, cos, sin, vx, vy } = this.pose;
    const d = this.robot.halfLength + ball.radius + 1 * INCH;
    ball.setPosition(x + cos * d, y + sin * d, ball.radius);
    ball.release(vx + cos * 1.2, vy + sin * 1.2, 0);
    // Spitting an element out is not a scoring attempt, so if it goes over the
    // wall it is a deliberate ejection and G405 costs 20 points. Which is the
    // right lesson: do not empty the magazine while parked on the perimeter.
    ball.touch('eject', this.owner, this.ballWorld?.clock ?? 0);
    this._ejectCooldown = 0.25;
    this._contentsChanged();
  }

  /**
   * Drop a ball, because something else has taken it.
   * @param {import('../../physics/Ball.js').Ball} ball
   */
  detachBall(ball) {
    const i = this.held.indexOf(ball);
    if (i >= 0) {
      this.held.splice(i, 1);
      this._contentsChanged();
    }
  }

  /**
   * Hand the front element to something else -- a launcher or a placer.
   * @returns {import('../../physics/Ball.js').Ball|null}
   */
  take() {
    const ball = this.held.shift() ?? null;
    if (ball) this._contentsChanged();
    return ball;
  }

  /** Put an element back at the front of the queue. */
  give(ball) {
    if (this.full) return false;
    this.held.unshift(ball.attachTo('intake', this));
    this._contentsChanged();
    return true;
  }

  massContribution() {
    if (this.held.length === 0 || !this.robot) return null;
    let mass = 0;
    for (const ball of this.held) mass += ball.mass;
    // Carried elements sit low and forward, which is where a real magazine is.
    return { mass, x: this.robot.halfLength * 0.4, y: 0, z: 5 * INCH };
  }

  /** Keep carried elements pinned to the robot so the renderer draws them. */
  syncCarried() {
    if (!this.robot) return;
    const { x, y, cos, sin } = this.pose;
    this.held.forEach((ball, i) => {
      const back = this.robot.halfLength * 0.4 - i * ball.radius * 1.8;
      ball.setPosition(x + cos * back, y + sin * back, 5 * INCH);
      ball.stop();
    });
  }

  telemetry() {
    const out = {
      'Intake held': `${this.held.length}/${this.capacity}`,
      'Intake power': this.power.toFixed(2),
      'Intake current': `${this.current.toFixed(1)} A`,
    };
    if (this.grabber) out['Intake type'] = 'jaw';
    if (this._placingInto) {
      out['Placing'] = `${(this.placeProgress * 100).toFixed(0)}% into FLOWER`;
    }
    return out;
  }

  reset() {
    // release() asks this intake to drop each ball, so take a copy first.
    for (const ball of this.held.slice()) ball.release();
    this.held.length = 0;
    this.command = 0;
    this.power = 0;
    this.current = 0;
    this._ejectCooldown = 0;
    this._cancelPlace();
    this._contentsChanged();
  }
}
