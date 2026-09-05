# The physics model

This document explains what the simulator computes, why it computes it that
way, and where it stops being accurate. If you are going to change the physics,
read this first; if you are going to trust the physics, read this too.

Everything is SI internally: metres, kilograms, seconds, radians, newtons,
volts, amps. Conversion to inches and feet per second happens only at the UI.

## Contents

1. [Coordinate frames](#coordinate-frames)
2. [Rates](#rates)
3. [The wheel contact model](#the-wheel-contact-model)
4. [Friction](#friction)
5. [Wheel load and weight transfer](#wheel-load-and-weight-transfer)
6. [Motors, gearboxes and the battery](#motors-gearboxes-and-the-battery)
7. [Kinematics](#kinematics)
8. [Numerical stability](#numerical-stability)
9. [Validation](#validation)
10. [Assumptions and known limits](#assumptions-and-known-limits)
11. [Calibrating against your robot](#calibrating-against-your-robot)

---

## Coordinate frames

The field frame follows the FTC convention: origin at the field centre, **+x**
toward the far wall, **+y** to the driver's left, headings counter-clockwise
positive. The chassis frame is the same, robot-relative: +x forward, +y left.

A pose read out of the simulator means the same thing it would in your op-mode.

## Rates

Three rates run concurrently, decoupled because they are decoupled on a real
robot:

| Rate | Default | What happens |
| --- | --- | --- |
| Render | display refresh | Draw a frame |
| **Op-mode loop** | 50 Hz | Read the gamepad, run drive logic, change motor commands, sample encoders |
| **Physics substep** | 2000 Hz | Evaluate motor torque, contact forces, integrate |

Collapsing these into one rate is the usual shortcut and it makes a simulated
robot feel unrealistically crisp. A real robot cannot change what it is doing
more than ~50 times a second, no matter how fast the driver's hands are.

On top of that sits an input **delay line** (default 40 ms) covering the gamepad
poll, the Driver Station app, the wifi hop to the Control Hub, and waiting for
the next loop cycle.

## The wheel contact model

Each wheel sits at a position in the chassis frame and rolls along a unit vector
`u` (its steer direction); `n` is the axle direction, 90° to the left of `u`.

### Traction wheels

The classic tyre model. Two slip components:

```
slip_longitudinal = v_contact · u  −  ω_wheel · R
slip_lateral      = v_contact · n
```

Both feed a shared friction ellipse (see below), so a wheel already using its
grip to accelerate has less left to resist a sideways push. The reaction on the
wheel is `−R · F_longitudinal`.

### Roller wheels (mecanum and omni)

These need different treatment, because the ground touches a **roller**, not the
rim. A roller spins freely about its own axis `p`, so it cannot sustain a force
along the direction it rolls in. Everything follows from that single fact.

With `g` the roller angle measured from the wheel's rolling direction:

```
p = cos(g)·u + sin(g)·n           the axis force can act along
q = perp(p)                        the free direction, carrying only drag
slip = v_contact · p  −  ω_wheel · R · cos(g)
F    = f(slip) · p  +  drag · q
```

and the reaction torque on the wheel is `−R · (F · u)` — the same expression as
for a traction wheel, which falls out of taking moments at the roller bearing.

`g = 0` gives an omni wheel (force along `u`, free sideways) and `g = ±45°`
gives mecanum. A traction wheel is the rigid limit, handled by the branch above.

**Two well-known mecanum behaviours emerge from this rather than being coded in**,
which is the main reason to trust the model:

1. Forward force per wheel is `torque / R` — the same as a traction wheel. The
   45° geometry cancels when all four wheels drive together.
2. Available forward traction is only `μ·N·cos(45°) = 0.71·μ·N`, because the
   force must act along the roller axis. That is the ~30% grip penalty mecanum
   drivers know about, and why an otherwise identical tank robot wins the
   pushing match.

The simulator measures 68% in a controlled traction-limited test
(`test/simulation.test.js`), against the theoretical 71% — the small shortfall
is the mecanum wheel sitting slightly further into the sliding region.

### Rolling resistance

Applied as a torque opposing wheel rotation, proportional to load:
`τ = −C_rr · N · R · tanh(ω/ω_ref)`. Modelled at the wheel rather than as a body
drag force so it correctly does nothing to a wheel that is not turning. Foam
tiles are much lossier than a hard floor, which is why an FTC robot coasts to a
stop so quickly.

Roller wheels get an additional drag term along their free direction, which is
what makes strafing measurably slower than driving straight — the simulator
gives 88% of forward speed with the default coefficient.

## Friction

Friction is a **function of slip velocity**, not a hard Coulomb switch. A hard
`F = μ·N·sign(slip)` model chatters at low speed: a stationary robot with brakes
applied oscillates between `+μN` and `−μN` every substep and visibly buzzes.

Three models are available. The default is a simplified **Pacejka Magic
Formula**:

```
y = sin(C · atan(B·x − E·(B·x − atan(B·x))))
```

Rather than exposing `B` and `C` — which nobody can reason about — they are
**derived from two interpretable numbers** you set in the panel:

- `slipAtPeakGrip`: the slip speed at which grip peaks (default 0.15 m/s)
- `kineticRatio`: sliding grip as a fraction of peak grip (default 0.8)

`C` comes from the large-slip asymptote `sin(C·π/2) = kineticRatio`, then `B` is
solved by bisection so the peak lands at exactly `x = 1`. This is done once and
cached, never in the physics loop.

The peak-then-drop shape is what makes wheel spin *cost* you: break the wheels
loose and you get 20% less force until they hook back up. That is why easing
into the throttle beats mashing it, and the simulator reproduces it rather than
asserting it.

### Slip velocity vs slip ratio

A pure slip-velocity model is stable at zero speed but over-predicts grip loss
at speed, because real tyres care about slip *ratio*. The effective reference is

```
ref = max(slipAtPeakGrip, peakSlipRatio · rollingSpeed)
```

giving slip-velocity behaviour near standstill and slip-ratio behaviour once
moving, with no singularity at v = 0.

### The friction ellipse

Longitudinal and lateral slip combine into one normalised magnitude before the
shape function is applied, then the force is distributed along an ellipse with
semi-axes `μ_long·N` and `μ_lat·N`. This gives the important coupling for free:
accelerate and turn hard at the same time and the robot washes out.

## Wheel load and weight transfer

Friction is proportional to normal force, so a wheel that unloads under
acceleration loses grip and spins. On a light, tall FTC robot this is not
subtle: a 15 kg robot with a 20 cm CG and a 35 cm wheelbase moves roughly 30% of
the front axle load to the rear under hard acceleration.

**Any chassis with more than three wheels is statically indeterminate** — the
three equilibrium equations do not pin down four unknowns without knowing frame
and tyre stiffnesses. The simulator uses the **minimum-norm (pseudo-inverse)
solution**, which is the standard resolution and, for rectangular layouts,
reproduces the textbook answer exactly: a CG sitting `e` ahead of centre on
wheelbase `L` puts `1/2 + e/L` of the weight on the front axle. This is asserted
in `test/load.test.js`.

Weight transfer is applied by **shifting the effective centre of gravity** by
`−h·a/g` rather than by adding per-axle correction terms. Taking moments about
the CG, the inertial force acting at the contact plane a distance `h` below it is
exactly equivalent to moving the CG. One formula handles longitudinal, lateral
and combined transfer, for any wheel layout — not just a rectangle.

A wheel that would carry negative load has lifted; it is clamped to zero and the
remainder rescaled. The robot has begun to tip at that point, which a 3-DOF
planar model cannot follow further.

## Motors, gearboxes and the battery

### The motor

The standard linear brushed-DC model, accurate for the small motors FTC uses:

```
current = (V − ω/kV) / R          torque = kT · current
```

with `R`, `kT` and `kV` derived from the four published catalogue numbers (free
speed, stall torque, stall current, free current). Each preset reproduces its
own spec sheet exactly — asserted for every motor in `test/hardware.test.js`.

`BRAKE` at zero power shorts the terminals, so back-EMF produces a braking
torque proportional to speed. `FLOAT` opens the circuit and the robot coasts.
The simulator measures a 0.35 m stop from 5 ft/s under BRAKE against 2.4 m
coasting — which is the difference between stopping where you release the stick
and drifting past your target.

### Bus current is not winding current

The H-bridge acts as a buck converter, so bus power equals motor power:

```
V_bus · I_bus = (duty · V_bus) · I_motor      hence   I_bus = duty · I_motor
```

Three correct consequences fall out: a motor driven in reverse still *draws*
positive current; a stalled motor at low duty pulls far less from the pack than
its winding current suggests; and braking regeneration appears as negative bus
current. Summing raw winding current instead makes a strafing mecanum robot
appear to draw nothing at all, because the two wheel pairs cancel.

### The battery

`V_bus = V_resting(charge) − I_total · R_internal`, with `V_resting` following a
NiMH curve: a flat plateau down to about 20%, then a knee. Charge is integrated
in amp-hours, so a session genuinely drains the pack.

Because both free speed and stall torque scale with bus voltage, a sagging pack
makes the robot **slower and weaker at the same time**. Internal resistance is
the main knob for pack health: a new pack is around 0.02 Ω, a well-used one
0.05 Ω or worse, which is several volts of sag at full current.

### Run modes

- **RUN_WITHOUT_ENCODER** sends the stick value straight out as duty cycle. Speed
  then depends on battery voltage and load. This is the FTC default and what
  most teams are actually driving.
- **RUN_USING_ENCODER** closes a velocity loop per motor. `setPower(0.5)` targets
  half the motor's *rated* free speed — a fixed target that does not sag with
  the pack — and the feedforward is voltage-compensated, so the loop asks for
  more duty as the battery droops. That is the entire point of running closed
  loop, and getting it wrong (scaling the target with bus voltage) silently
  defeats it.

### Encoders

Position is quantised to whole ticks and velocity is a *difference of quantised
positions*, so it is far noisier than position. At 28 ticks per motor rev
through 19.2:1 that is 537.6 ticks per wheel revolution, and a 20 ms sample of a
slow wheel contains only a handful of ticks. That quantisation noise is why
velocity PID on an FTC drivetrain needs filtering, and the simulator reproduces
it (switchable, so you can see how much of your noise it accounts for).

## Kinematics

Rather than hard-coding the four familiar mecanum equations, each wheel
contributes one row built from its position, steer angle and roller angle:

```
ω_wheel · R = a·vx + b·vy + c·ω
a = cos(θ+g)/cos(g)
b = sin(θ+g)/cos(g)
c = (x·sin(θ+g) − y·cos(θ+g))/cos(g)
```

Mecanum, tank, omni and X-drive all fall out of this, so a new layout needs no
new kinematics code. For a front-left mecanum wheel this reduces to the textbook
`vx − vy − ω(lx+ly)`, which `test/kinematics.test.js` asserts directly.

Forward kinematics (odometry) is a least-squares solve, so wheel speeds that are
not kinematically consistent — the normal state once anything is slipping — get
a best fit rather than a contradiction. This is exactly how drive-encoder
odometry behaves on a real robot, including its drift.

> **A bug this found:** the X-drive layout originally pointed its wheels
> radially instead of tangentially, collapsing every moment arm to
> `(lx − ly)/√2` — near zero for a square chassis. It translated fine and could
> barely turn. The least-squares conditioning gave it away.

## Numerical stability

Wheel contact is by far the stiffest part of the simulation: thousands of
newtons per m/s acting against a wheel inertia of a few thousandths of a kg·m².
An explicit step would need dt well under 0.5 ms. Three things keep it stable:

1. **Semi-implicit wheel spin.** The local slope of the friction curve is folded
   into the update: `I_eff = I + dt·R²·k`. This makes the stiffest mode
   unconditionally stable. Past the friction peak the true slope is negative —
   that is the physically real "it broke loose" instability and must *not* be
   damped away, so the stiffness is clamped to zero there and the step stays
   explicit, where the force is nearly constant anyway.
2. **An impulse limiter.** Friction may bring slip to zero but never reverse it
   within a substep; `|s|·m/dt` is exactly the impulse that stops the slip.
3. **Semi-implicit (symplectic) Euler** for the body, which does not
   artificially inject energy the way explicit Euler does.

Top speed varies by under 0.05 m/s across substep rates from 500 Hz to 4000 Hz
(`test/simulation.test.js`), which is the practical check that the solver has
converged.

## Validation

Measured in the simulator, against independently known figures:

| Quantity | Simulated | Reference |
| --- | --- | --- |
| Top speed, Yellow Jacket 19.2:1 on 96 mm wheels | 5.08 ft/s | goBILDA quote 5.0–5.2 ft/s |
| Time to 95% of top speed | 0.73 s | plausible for FTC mecanum (0.5–1.2 s) |
| Mecanum forward traction ÷ tank | 0.68 | cos(45°) = 0.71 theoretical |
| Strafe speed ÷ forward speed | 88% | typically 80–90% reported |
| Stall current, 4 motors | 35 A | 4 × 9.2 A + 1.2 A base, minus sag |
| Front axle load, CG offset `e` | `1/2 + e/L` | exact, to 1e-6 |
| Weight transfer under acceleration | `m·a·h/L` | exact, to 1e-6 |
| Peak acceleration | ≤ μ·g | friction bound respected |

## Assumptions and known limits

Worth knowing before you trust a number:

- **Three degrees of freedom.** No pitch or roll. Weight transfer is handled
  quasi-statically, so the robot never actually tips over — it reports lifted
  wheels and a load imbalance instead. Suspension travel does not exist, which
  is fine for a rigid FTC chassis.
- **The tiles are flat and uniform.** No seams catching wheels, no dust
  patches, no ramps.
- **Rotor inertia is estimated, not published.** No FTC vendor publishes it. The
  defaults come from motor can geometry. Reflected through a 19.2:1 gearbox,
  7e-6 kg·m² adds about 5 kg of apparent mass to a 15 kg robot, so it materially
  affects acceleration. See calibration below.
- **Averaged PWM.** Duty cycle is treated as an average terminal voltage rather
  than simulating the switching waveform. The distinction only matters at zero
  power, where BRAKE and FLOAT are modelled explicitly.
- **The 6-wheel drop centre is approximated.** All six wheels are on the ground
  and the load solver gives the centre pair the larger share, which is the
  practical effect of the drop, rather than modelling the geometry directly.
- **Collisions are robot-against-static-geometry.** No robot-on-robot. The SAT
  routine for oriented boxes is written and tested, ready for game elements.
- **Gearbox efficiency is a single constant** applied in both directions of
  power flow, rather than being load- and speed-dependent.

## Calibrating against your robot

Do these in order; each is cheap and each matters more than the last one you
skipped.

1. **Weigh the robot.** Set `chassis.mass`.
2. **Set the gear ratio** from your motor part number, and `motor.preset`.
3. **Measure top speed.** Drive a known distance on tiles at full power and time
   it. If the simulator is faster, lower `motor.efficiency` — 0.70–0.85 is
   realistic for a planetary plus a chain run, and assuming 1.0 is the most
   common reason a simulated robot out-accelerates the real one.
4. **Measure 0-to-top-speed time.** Adjust `motor.rotorInertia` until it agrees.
   Everything else in the acceleration model is pinned to published figures, so
   this is the right knob.
5. **Estimate CG height.** This alone controls weight transfer and how easily
   the robot tips. If your real robot spins its front wheels on launch and the
   simulated one does not, this is usually why.
6. **Check the friction.** If the real robot breaks traction more readily,
   lower `surface.muLongitudinal`. Dusty tiles are meaningfully worse than clean
   ones.

Then export the config and commit it, so everyone practises on the same robot.
