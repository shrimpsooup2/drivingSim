import { Subsystem } from '../Subsystem.js';
import { DcMotor } from '../../hardware/DcMotor.js';
import { MOTOR_PRESETS } from '../../config/presets/motors.js';
import { INCH } from '../../math/MathUtil.js';

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
   * }} [opts]
   */
  constructor(opts = {}) {
    super({ name: opts.name ?? 'intake' });

    /** How many SCORING ELEMENTS the ROBOT can hold at once. */
    this.capacity = opts.capacity ?? 3;
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
  }

  get full() {
    return this.held.length >= this.capacity;
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

    if (this.power > 0.4) this._collect();
    else if (this.power < -0.4) this._eject();

    return this.current;
  }

  _collect() {
    if (this.full || !this.robot) return;
    let changed = false;
    const { x, y, cos, sin, vx, vy } = this.pose;
    const mouthX = x + cos * this.robot.halfLength;
    const mouthY = y + sin * this.robot.halfLength;

    if (this.ballWorld) {
      for (const ball of this.ballWorld.balls) {
        if (!ball.free || this.full) continue;
        if (ball.z - ball.radius > this.maxHeight) continue;

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
    for (const flower of this.flowers) {
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

  /** Spit the front element out onto the tiles, one at a time. */
  _eject() {
    if (this.held.length === 0 || this._ejectCooldown > 0 || !this.robot) return;
    const ball = this.held.shift();
    const { x, y, cos, sin, vx, vy } = this.pose;
    const d = this.robot.halfLength + ball.radius + 1 * INCH;
    ball.setPosition(x + cos * d, y + sin * d, ball.radius);
    ball.release(vx + cos * 1.2, vy + sin * 1.2, 0);
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
    return {
      'Intake held': `${this.held.length}/${this.capacity}`,
      'Intake power': this.power.toFixed(2),
      'Intake current': `${this.current.toFixed(1)} A`,
    };
  }

  reset() {
    // release() asks this intake to drop each ball, so take a copy first.
    for (const ball of this.held.slice()) ball.release();
    this.held.length = 0;
    this.command = 0;
    this.power = 0;
    this.current = 0;
    this._ejectCooldown = 0;
    this._contentsChanged();
  }
}
