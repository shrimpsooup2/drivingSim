import { Vec2 } from '../math/Vec2.js';
import { clamp } from '../math/MathUtil.js';
import { axialSlipForce, axialStiffness, combinedSlipForce, effectiveSlipReference } from './friction.js';

/** @typedef {'traction'|'omni'|'mecanum'} WheelKind */

/**
 * One wheel's contact with the field.
 *
 * ## The model
 *
 * A wheel sits at `position` in the chassis frame and rolls along the unit
 * vector `u` (its steer direction); `n` is the axle direction, 90 degrees left
 * of `u`.
 *
 * **Traction wheels** (tank drive, drop-centre six-wheel) use the classic tyre
 * model: longitudinal slip is the difference between how fast the contact
 * patch is travelling and how fast the wheel is spinning; lateral slip is the
 * sideways contact velocity. Both feed a shared friction ellipse.
 *
 * **Roller wheels** (mecanum, omni) need a different treatment, because the
 * ground touches a *roller*, not the rim. A roller spins freely about its own
 * axis `p`, so it cannot sustain a force along the direction it rolls in.
 * Everything follows from that one fact:
 *
 *   - `p = cos(g)*u + sin(g)*n`, where `g` is the roller angle: 0 for an omni
 *     wheel (rollers roll sideways, wheel drives along u), +/-45 degrees for
 *     mecanum, and a traction wheel is the degenerate rigid case.
 *   - Ground force can only act along `p`. The free direction `q = perp(p)`
 *     carries only roller bearing drag.
 *   - The no-slip condition along `p` is `v_contact . p = omega * R * cos(g)`,
 *     so slip is `v_contact . p - omega * R * cos(g)`.
 *   - The reaction torque on the wheel is `-R * (F . u)` for every wheel kind,
 *     which falls straight out of taking moments at the roller bearing.
 *
 * Two well-known mecanum behaviours emerge from this rather than being
 * hard-coded, which is a good sign the model is right:
 *
 *   1. Forward force per wheel is `torque / R`, the same as a traction wheel --
 *      the 45 degree geometry cancels out when all four wheels drive together.
 *   2. Available traction is only `mu * N * cos(45) = 0.71 * mu * N` in the
 *      forward direction, because the force must act along the roller axis.
 *      That is the ~30% grip penalty mecanum drivers know about, and it is why
 *      a mecanum robot loses a pushing match to an otherwise identical tank
 *      robot.
 */
export class Wheel {
  /**
   * @param {{
   *   name?: string,
   *   position?: Vec2,
   *   steerAngle?: number,
   *   rollerAngle?: number,
   *   kind?: WheelKind,
   *   radius?: number,
   *   rotationalInertia?: number,
   *   rollingResistance?: number,
   *   rollerDrag?: number,
   *   driven?: boolean,
   * }} [cfg]
   */
  constructor(cfg = {}) {
    this.name = cfg.name ?? 'wheel';
    /** Contact point in the chassis frame (metres). */
    this.position = cfg.position ?? new Vec2();
    /** Direction the wheel rolls, radians from chassis +x. */
    this.steerAngle = cfg.steerAngle ?? 0;
    /** Roller axis angle from the rolling direction. Ignored for traction wheels. */
    this.rollerAngle = cfg.rollerAngle ?? 0;
    this.kind = cfg.kind ?? 'mecanum';
    this.radius = cfg.radius ?? 0.048;
    /**
     * Spin inertia at the wheel, kg*m^2. Must already include the motor rotor
     * inertia reflected through the gearbox (x gearRatio^2), which for a 20:1
     * FTC gearbox dominates the wheel's own inertia by an order of magnitude.
     */
    this.rotationalInertia = cfg.rotationalInertia ?? 0.006;
    /** Coefficient of rolling resistance (dimensionless). Foam tiles: 0.015-0.03. */
    this.rollingResistance = cfg.rollingResistance ?? 0.02;
    /**
     * Drag along a roller wheel's free direction, as a fraction of normal
     * force. Captures roller bearing friction and foam deformation, and is the
     * reason strafing is measurably slower and less efficient than driving.
     */
    this.rollerDrag = cfg.rollerDrag ?? 0.09;
    this.driven = cfg.driven ?? true;

    // --- state ---
    /** rad/s. Positive spins the wheel so it drives the chassis along +u. */
    this.angularVelocity = 0;
    /** Accumulated wheel rotation in radians; the encoder reads this. */
    this.angle = 0;

    // --- diagnostics, refreshed every substep for the HUD and debug overlay ---
    /** Ground force on the chassis from this wheel, chassis frame (N). */
    this.force = new Vec2();
    this.normalForce = 0;
    this.slipLongitudinal = 0;
    this.slipLateral = 0;
    /** True sliding speed at the contact patch: the part that dissipates energy. */
    this.slipSpeed = 0;
    /**
     * Speed at which a roller wheel's rollers are freely rolling. This is
     * normal rolling, not slip -- a mecanum wheel driving straight forward has
     * its rollers turning at v*sin(45 deg) with no loss beyond bearing drag.
     * Zero for traction wheels.
     */
    this.rollerSpeed = 0;
    /** |F| / (mu*N): 1 means this wheel is at the limit of grip. */
    this.gripUsage = 0;
    this.motorTorque = 0;

    this._u = new Vec2(1, 0);
    this._n = new Vec2(0, 1);
    this._scratch = { x: 0, y: 0 };
    this.updateGeometry();
  }

  /** Recompute cached direction vectors after steerAngle changes. */
  updateGeometry() {
    const c = Math.cos(this.steerAngle);
    const s = Math.sin(this.steerAngle);
    this._u.set(c, s);
    this._n.set(-s, c);
    this._cosRoller = this.kind === 'traction' ? 1 : Math.cos(this.rollerAngle);
    this._sinRoller = this.kind === 'traction' ? 0 : Math.sin(this.rollerAngle);
    return this;
  }

  reset() {
    this.angularVelocity = 0;
    this.angle = 0;
    this.force.set(0, 0);
    this.normalForce = 0;
    this.slipLongitudinal = 0;
    this.slipLateral = 0;
    /** True sliding speed at the contact patch: the part that dissipates energy. */
    this.slipSpeed = 0;
    /**
     * Speed at which a roller wheel's rollers are freely rolling. This is
     * normal rolling, not slip -- a mecanum wheel driving straight forward has
     * its rollers turning at v*sin(45 deg) with no loss beyond bearing drag.
     * Zero for traction wheels.
     */
    this.rollerSpeed = 0;
    this.gripUsage = 0;
    this.motorTorque = 0;
    return this;
  }

  /** Surface speed of the wheel: how fast it would travel if it were not slipping. */
  get surfaceSpeed() {
    return this.angularVelocity * this.radius;
  }

  /**
   * Compute the ground force and advance the wheel's spin by one substep.
   *
   * @param {Vec2} contactVelocity velocity of the contact point, chassis frame (m/s)
   * @param {number} normalForce newtons
   * @param {number} motorTorque torque delivered at the wheel by the gearbox (N*m)
   * @param {import('./friction.js').CompiledFriction} friction
   * @param {number} dt substep, seconds
   * @param {number} effectiveMass kg carried by this wheel, for the impulse limiter
   * @returns {Vec2} force on the chassis in the chassis frame (also stored on `this.force`)
   */
  step(contactVelocity, normalForce, motorTorque, friction, dt, effectiveMass) {
    const u = this._u;
    const n = this._n;
    const R = this.radius;
    const N = normalForce > 0 ? normalForce : 0;

    this.normalForce = N;
    this.motorTorque = motorTorque;

    const vu = contactVelocity.x * u.x + contactVelocity.y * u.y;
    const vn = contactVelocity.x * n.x + contactVelocity.y * n.y;
    // Reference speed for the slip-ratio scaling: whichever of ground speed or
    // wheel surface speed is larger.
    const rollingSpeed = Math.max(Math.abs(vu), Math.abs(this.angularVelocity * R));

    let fx = 0; // chassis-frame force
    let fy = 0;
    let forceAlongU = 0; // for the spin reaction torque
    let spinStiffness = 0; // d(force along u)/d(omega), for the implicit step
    let gripLimit = 1e-9;

    if (this.kind === 'traction') {
      const slipLong = vu - this.angularVelocity * R;
      const slipLat = vn;
      const f = combinedSlipForce(slipLong, slipLat, N, friction, rollingSpeed, this._scratch);

      let fLong = f.x;
      let fLat = f.y;

      // Impulse limiter: friction can bring slip to zero but must never reverse
      // it within a substep. Without this a stiff contact overshoots and the
      // robot buzzes. `|s| * m / dt` is exactly the impulse that stops the slip.
      if (effectiveMass > 0 && dt > 0) {
        const maxLat = (Math.abs(slipLat) * effectiveMass) / dt;
        if (Math.abs(fLat) > maxLat) fLat = Math.sign(fLat) * maxLat;
      }

      fx = fLong * u.x + fLat * n.x;
      fy = fLong * u.y + fLat * n.y;
      forceAlongU = fLong;

      spinStiffness = axialStiffness(slipLong, N, friction.muLongitudinal, friction, rollingSpeed) * R;

      this.slipLongitudinal = slipLong;
      this.slipLateral = slipLat;
      this.rollerSpeed = 0;
      // Both channels of a traction wheel are genuine sliding.
      this.slipSpeed = Math.hypot(slipLong, slipLat);
      gripLimit = Math.max(friction.muLongitudinal, friction.muLateral) * N;
    } else {
      // Roller wheel (mecanum or omni).
      const cg = this._cosRoller;
      const sg = this._sinRoller;
      // p = roller axis (force can only act here); q = roller rolling direction (free).
      const px = cg * u.x + sg * n.x;
      const py = cg * u.y + sg * n.y;
      const qx = -sg * u.x + cg * n.x;
      const qy = -sg * u.y + cg * n.y;

      const vp = contactVelocity.x * px + contactVelocity.y * py;
      const vq = contactVelocity.x * qx + contactVelocity.y * qy;

      const slipP = vp - this.angularVelocity * R * cg;
      let fP = axialSlipForce(slipP, N, friction.muLongitudinal, friction, rollingSpeed);

      if (effectiveMass > 0 && dt > 0) {
        const maxP = (Math.abs(slipP) * effectiveMass) / dt;
        if (Math.abs(fP) > maxP) fP = Math.sign(fP) * maxP;
      }

      // The free direction carries only roller bearing drag and foam
      // deformation loss -- small, but it is what makes strafing cost more
      // than driving straight.
      const ref = effectiveSlipReference(friction, rollingSpeed);
      const fQ = -Math.tanh(vq / Math.max(ref, 1e-6)) * this.rollerDrag * N;

      fx = fP * px + fQ * qx;
      fy = fP * py + fQ * qy;
      forceAlongU = fx * u.x + fy * u.y;

      // d(F.u)/d(omega) = k * R * cos^2(g): the cos(g) appears once from the
      // slip definition and once from projecting the force back onto u.
      spinStiffness =
        axialStiffness(slipP, N, friction.muLongitudinal, friction, rollingSpeed) * R * cg * cg;

      this.slipLongitudinal = slipP;
      this.slipLateral = 0;
      this.rollerSpeed = vq;
      // Only the roller-axis channel slides. The free direction is the rollers
      // doing their job, so counting it as slip would mark a perfectly gripping
      // mecanum wheel as spinning out the moment the robot moves at all.
      this.slipSpeed = Math.abs(slipP);
      gripLimit = friction.muLongitudinal * N;
    }

    this.force.set(fx, fy);
    this.gripUsage = gripLimit > 1e-9 ? Math.hypot(fx, fy) / gripLimit : 0;

    // Rolling resistance: a torque opposing rotation, proportional to load.
    // Modelled at the wheel rather than as a body drag force so it correctly
    // does nothing to a wheel that is not turning.
    const rrTorque =
      -Math.tanh(this.angularVelocity / 0.5) * this.rollingResistance * N * R;

    // Semi-implicit spin update. Treating the contact force as constant over
    // the substep would require dt well under 0.5 ms; folding in its slope
    // makes this mode stable at any dt.
    const netTorque = motorTorque + rrTorque - R * forceAlongU;
    const effectiveInertia = this.rotationalInertia + dt * R * spinStiffness;
    const dOmega = (netTorque * dt) / Math.max(effectiveInertia, 1e-9);

    this.angularVelocity += dOmega;
    if (!Number.isFinite(this.angularVelocity)) this.angularVelocity = 0;
    this.angle += this.angularVelocity * dt;

    return this.force;
  }

  /**
   * Maximum tractive force this wheel can put down along the chassis +x axis at
   * its current load. Diagnostic only -- the simulation never uses it.
   * For mecanum this is reduced by cos(rollerAngle), which is the grip penalty
   * that comes with holonomic movement.
   */
  maxForwardForce(mu) {
    const projection = this.kind === 'traction' ? 1 : Math.abs(this._cosRoller);
    return mu * this.normalForce * projection;
  }

  /** Serialise the geometry (not the state) for config export. */
  toJSON() {
    return {
      name: this.name,
      position: { x: this.position.x, y: this.position.y },
      steerAngle: this.steerAngle,
      rollerAngle: this.rollerAngle,
      kind: this.kind,
      radius: this.radius,
      rotationalInertia: this.rotationalInertia,
      rollingResistance: this.rollingResistance,
      rollerDrag: this.rollerDrag,
      driven: this.driven,
    };
  }
}

/** Clamp helper re-exported for layout code that shapes wheel parameters. */
export { clamp };
