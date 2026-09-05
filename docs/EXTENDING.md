# Extending the simulator

The season has not started, so nothing here is game-specific. This document
covers the four extension points, each with a worked example you can paste and
run. None of them require changing core code.

1. [Adding a parameter](#adding-a-parameter)
2. [Adding a mechanism (Subsystem)](#adding-a-mechanism-subsystem)
3. [Adding a game element (FieldElement)](#adding-a-game-element-fieldelement)
4. [Adding an op-mode](#adding-an-op-mode)
5. [Adding a drivetrain layout](#adding-a-drivetrain-layout)
6. [Testing what you add](#testing-what-you-add)

---

## Adding a parameter

One entry in `src/config/schema.js`. The settings panel, unit conversion,
clamping, reset, search, export and import all follow automatically — there is
no UI code to write.

```js
// in the group you want it to appear under
{
  path: 'intake.rollerSpeed',
  label: 'Intake roller speed',
  type: 'number',
  default: 0.8,
  min: 0,
  max: 1,
  step: 0.01,
  help: 'Fraction of full power the intake runs at when triggered.',
}
```

Read it anywhere with `config.intake.rollerSpeed`.

Three rules worth knowing:

- **Store SI.** Use `unit` for the SI unit the value is kept in and `display`
  for what the user should see (`unit: 'm', display: 'in'`). If a value must be
  kept in non-SI form because its consumer expects that — RPM, milliseconds —
  use `suffix` instead, which shows the label without converting. A test
  enforces this distinction, because tagging a value already in RPM with
  `unit: 'rpm'` would display 57296 for a 6000 RPM motor.
- **Mark `rebuild: true`** if changing it requires rebuilding the drivetrain
  (geometry, motor spec). Otherwise the change is applied live.
- **Mark `advanced: true`** for parameters most people should not touch; they
  hide behind the "Show advanced" toggle.

## Adding a mechanism (Subsystem)

`Subsystem` gets the same two-rate treatment the drivetrain does — control at
the op-mode rate, forces at the physics rate — so an arm that shifts the centre
of gravity or a flywheel that draws current is modelled correctly.

```js
import { Subsystem } from './src/robot/Subsystem.js';
import { clamp } from './src/math/MathUtil.js';

/** A single-jointed arm that carries mass and draws current. */
export class Arm extends Subsystem {
  constructor() {
    super({ name: 'arm' });
    this.angle = 0;        // radians from stowed
    this.target = 0;
    this.length = 0.40;    // metres from pivot to payload
    this.mass = 1.8;       // kg
  }

  // Op-mode rate: read the gamepad and set a target.
  updateControl(dt, gamepad) {
    if (gamepad.dpad_up) this.target = 1.2;
    if (gamepad.dpad_down) this.target = 0;
    // A crude rate-limited move; a real one would use PIDF from src/math.
    const step = 2.0 * dt;
    this.angle += clamp(this.target - this.angle, -step, step);
  }

  // Physics rate: report the current this mechanism draws so the pack sags.
  applyForces(dt, busVoltage) {
    const moving = Math.abs(this.target - this.angle) > 1e-3;
    return moving ? 4.5 : 0.3;   // amps
  }

  // Mass and where it sits. The robot folds this into its total mass and CG,
  // so extending the arm really does make the robot tippy -- there is nothing
  // extra to remember to update.
  massContribution() {
    return {
      mass: this.mass,
      x: Math.cos(this.angle) * this.length,
      y: 0,
      z: 0.20 + Math.sin(this.angle) * this.length,
    };
  }

  telemetry() {
    return { 'Arm angle': `${((this.angle * 180) / Math.PI).toFixed(0)} deg` };
  }

  reset() {
    this.angle = 0;
    this.target = 0;
  }
}
```

Attach it:

```js
const arm = sim.robot.addSubsystem(new Arm());
```

`addSubsystem` recomputes the robot's mass properties immediately. Call
`robot.updateMassProperties()` yourself if a subsystem's mass moves and you want
the change reflected before the next control cycle.

To apply a real force or torque to the chassis (a shooter's recoil, a hook
pulling on a bar), use `this.robot.body.applyForceAtBodyPoint(force, point)`
inside `applyForces`.

## Adding a game element (FieldElement)

```js
import { FieldElement } from './src/field/FieldElement.js';
import { Vec2 } from './src/math/Vec2.js';

/** A scoring goal the robot can collide with. */
export class Goal extends FieldElement {
  constructor(position) {
    super({ id: 'goal', position, collidable: true });
    this.size = new Vec2(0.30, 0.30);
    this.height = 0.60;
  }

  // Static collision geometry contributed to the robot collision pass.
  // Return [] for a logical-only element such as a scoring zone.
  halfPlanes() {
    const h = this.size.x / 2;
    return [
      { normal: new Vec2(-1, 0), offset: -(this.position.x + h), id: 'goal-x+' },
      { normal: new Vec2(1, 0), offset: this.position.x - h, id: 'goal-x-' },
    ];
  }

  // How the renderer should draw it. Return null to draw nothing.
  describe() {
    return {
      kind: 'box',
      position: this.position,
      heading: this.heading,
      size: this.size,
      height: this.height,
      color: [0.85, 0.55, 0.15, 1],
    };
  }

  update(dt) { /* animate, score, whatever the game needs */ }
  reset() { /* restore starting state */ }
}
```

Register it:

```js
sim.field.addElement(new Goal(sim.field.tileCenter(2, 5)));
```

`Field.tileCenter(col, row)` gives the centre of a foam tile, which is how FTC
field drawings specify positions.

For a free-moving game piece rather than static geometry, give the element its
own `RigidBody2d` and step it in `update` — the physics classes are not
drivetrain-specific.

## Adding an op-mode

`OpMode` deliberately mirrors the FTC SDK's shape, so logic prototyped here
ports across with the gamepad reads and motor calls unchanged. Autonomous
routines, path followers and driver-assist experiments are all subclasses.

```js
import { OpMode } from './src/teleop/OpMode.js';

/** Drive forward one tile, then turn 90 degrees. */
export class AutoTest extends OpMode {
  constructor() {
    super({ name: 'Auto: square' });
    this.stage = 0;
  }

  init() {
    this.startX = this.robot.body.position.x;
  }

  loop(dt, gamepad1) {
    this.runtime += dt;
    const travelled = this.robot.body.position.x - this.startX;

    if (this.stage === 0) {
      this.robot.drivetrain.driveNormalized(0.5, 0, 0);
      if (travelled > 0.6) this.stage = 1;
    } else {
      this.robot.drivetrain.driveNormalized(0, 0, 0.4);
      if (Math.abs(this.robot.imu.heading) > Math.PI / 2) {
        this.robot.drivetrain.driveNormalized(0, 0, 0);
      }
    }

    this.addData('Stage', this.stage);
    this.addData('Travelled', travelled.toFixed(2));
  }
}
```

Swap it in at runtime:

```js
sim.setOpMode(new AutoTest());
```

Inside an op-mode:

- `this.robot.drivetrain.driveNormalized(forward, strafe, turn)` takes −1..1 and
  works for every layout, including tank (where strafe is ignored).
- `this.robot.drivetrain.driveVelocity(vx, vy, omega, busVoltage)` takes real
  units.
- `this.robot.imu.heading` is the *sensor* reading, with drift — the same value
  your real op-mode would get. `this.robot.body.rotation.radians` is ground
  truth, which no real robot has.
- `gamepad1` is the **delayed** state, matching what the Control Hub actually
  sees.

## Adding a drivetrain layout

Add a builder to `src/drivetrain/layouts.js` that returns `Wheel` instances. The
generic kinematics and physics pick it up with no further changes:

```js
export function swerveModuleLayout(o) {
  // ... return Wheel[] with per-wheel position, steerAngle, rollerAngle, kind
}

LAYOUT_BUILDERS.swerve = swerveModuleLayout;
LAYOUT_LABELS.swerve = 'Swerve (4 module)';
```

Then add `swerve` to the `drivetrain.type` enum options in `schema.js`.

Each wheel needs:

- `position` — contact point in the chassis frame
- `steerAngle` — the direction it rolls, from chassis +x
- `rollerAngle` — 0 for an omni wheel, ±45° for mecanum; ignored for `traction`
- `kind` — `'traction' | 'omni' | 'mecanum'`

Be careful with roller and steer angles: an X-drive laid out with radial rather
than tangential wheels translates perfectly and cannot turn, and it is not
obvious from the code. Add a kinematics test asserting the moment arms.

## Testing what you add

The simulation is headless — it runs in Node with no canvas — so anything you
add is testable without a browser:

```js
import { Config } from '../src/config/Config.js';
import { Simulation } from '../src/app/Simulation.js';

const config = new Config();
config.set('field.collisionsEnabled', false);   // open runway
const sim = new Simulation(config);
sim.setOpMode(new AutoTest());
for (let i = 0; i < 300; i++) sim.step(1 / 60);
assert.ok(sim.robot.body.position.x > 0.5);
```

`npm test` runs the suite; `npm run check` loads the real page in headless
Chromium, drives it, fails on any console error, and writes screenshots to
`screenshots/`. Run both before pushing.
