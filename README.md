# FTC Driving Simulator

A physics-accurate FTC drivetrain simulator for driver practice, built to be used
before kickoff — when you have a chassis but no game, no mechanisms, and not
enough field time.

It simulates one thing properly: **a parallel-plate drivetrain on FTC foam
tiles**, with a real motor curve, a real battery, real traction limits and real
command latency. Everything else is scaffolding for the mechanisms and game
elements you will add once the season starts.

## Running it

**If you just want to drive**, see **[QUICKSTART.md](QUICKSTART.md)** — written
for people who have never opened a terminal.

The short version, easiest first:

| | How | Who it's for |
| --- | --- | --- |
| **1** | Open **`https://shrimpsooup2.github.io/drivingSim/`** | Drivers. Nothing to install. Works on a Chromebook. |
| **2** | Download the ZIP, double-click **`Start Simulator (Mac).command`** or **`(Windows).bat`** | Offline practice |
| **3** | `npm start` | People editing the code |

Option 1 needs [one-time setup](QUICKSTART.md#setting-up-the-link-one-time-30-seconds)
by a repo admin (Settings → Pages → Source: GitHub Actions). About 30 seconds.

For development:

```
npm start      # serves locally and opens your browser
npm test       # 157 unit and integration tests
npm run check  # headless browser smoke test + screenshots
```

There is **no build step and no dependencies**. It is native ES modules and a
hand-written WebGL2 renderer, so a clone and a static server is the whole setup.
Nothing to install, nothing to keep up to date, and it will still run in four
years when this season's students have graduated.

---

## Why bother simulating it properly

A driving simulator is only useful if the habits it teaches survive contact with
a real field. Most of the things that make a real robot hard to drive are
absent from a naive simulator, so this one models them explicitly:

| What real drivers fight | How it is modelled |
| --- | --- |
| The robot does not react instantly | ~40 ms of gamepad → Driver Station → wifi → Control Hub latency, plus a 50 Hz op-mode loop that caps how often commands can change |
| Wheels break loose if you slam the stick | Pacejka friction curve with a real static-to-kinetic drop, so spinning wheels genuinely produce less force |
| The robot is quicker on a fresh battery | Motor torque and free speed both scale with bus voltage, which sags under current draw and drains over a session |
| Mecanum loses pushing matches | Force can only act along the 45° roller axis, so forward grip is cos(45°) ≈ 71% of a traction wheel's — derived from geometry, not hard-coded |
| Front wheels lose bite under acceleration | Weight transfer from CG height, computed by shifting the effective CG; wheels can unload to zero and lift |
| Field-centric drifts during a match | IMU drift, noise and read latency, on by default |

The physics is validated against known figures where they exist: a goBILDA
Yellow Jacket at 19.2:1 on 96 mm wheels tops out at **5.08 ft/s** in the sim,
against goBILDA's quoted 5.0–5.2 ft/s for that exact configuration.

---

## Once it is open

Plug in a controller and **press a button on it** — browsers hide gamepads until
they are used, so an idle controller looks disconnected. A Logitech F310 must
have its rear switch on **X** (XInput); in **D** mode the axis mapping is
different and the simulator will say so.

Or drive with the keyboard: `WASD` to translate, `Q`/`E` to rotate.

Press `?` for the full control list, `Tab` for the settings panel.

### Making it match *your* robot

The defaults describe a goBILDA Strafer-style chassis. The four numbers worth
setting accurately, in order of how much they matter:

1. **Robot mass** — weigh it.
2. **Gear ratio** — read it off the motor part number.
3. **CG height** — estimate it; this alone controls weight transfer.
4. **Rotor inertia** — the one number no vendor publishes. Time your real robot
   from a standstill to top speed and adjust until the simulator agrees.
   Everything else in the acceleration model is pinned to published figures, so
   this is the honest knob.

Then `Export` the config and commit it, so the whole team practises on the same
robot. `Import` loads it back.

---

## What is in the box

- **Drivetrains**: mecanum, tank (4 and 6 wheel drop-centre), plus-omni and
  X-drive. All from one generic wheel model — no per-layout physics code.
- **110 parameters** across 12 groups, every one with a range, a unit and an
  explanation of what it changes. The settings panel is generated from the
  schema, so adding a tunable is one entry in `src/config/schema.js`.
- **Presets** for common chassis, including a deliberately tippy one for
  training and a "last match of the day" tired-battery setup.
- **Fifteen timed driving drills in three tiers** — from sprint-and-stop up to a
  two-minute match simulation. Solid obstacles you can crash into, gates that
  must be taken in the right direction, slots you have to reverse into blind,
  and speed-limited approaches. None are game-specific; they train the skills
  underneath any game. Medal par times, and best times kept per drivetrain,
  because a mecanum time says nothing about the same driver on tank.
- **The other three robots in the match, built the way you want them.** A
  partner and two opponents, each chosen along three separate axes: the
  *scoring system* (single flywheel, twin flywheel, heavy flywheel, catapult,
  three-ball lobber, linear puncher, a wide intake with a lift, a jaw on an
  arm, a heavy defender, a stock pushbot), the *build quality* (thrown
  together, competition ready, worlds calibre) and the *driver* (rookie,
  competent, veteran). Any of them can be Random, so it is a different match
  every time. The axes are separate because they are separate at a real event:
  a rookie on an excellent robot and a veteran on a rough one are different
  problems, and you meet both.

  Each one drives a *fully simulated robot* through the same subsystems you do
  — same motor curves, same battery, same traction, same `Launcher.fire()`. No
  shortcuts into the ball world, so beating one is a driving result rather than
  a difficulty setting. They also play the actual game: the field empties while
  you are busy, your partner helps or does not, and the opposing HIVE tips
  whether or not you noticed.
- **AI opponents for the drills** — four chassis builds from an 8.5 kg Scout to
  a 21 kg Brick and five behaviours, including a blocker that denies your route
  rather than chasing you.
- **Live telemetry**: speed, bus voltage, current draw, per-wheel grip usage and
  slip, with strip charts.
- **Debug overlays**: per-wheel force vectors coloured by how much grip is left,
  slip markers, wheel load rings and a path trail.
- **Fully adjustable cameras**: driver station (the default, and the one that
  actually builds useful skill), chase, overhead and free orbit. Drag and scroll
  in any view; the driver-station camera can be set to your real eye height and
  where you actually stand along the wall.

## BIOBUZZ

The 2026 game is in, built from the Competition Manual V1 and measured against
the official field CAD. **It is what the simulator opens on** -- press **G** to
put it away and get a bare field back for the drills.

- **The field**: the HIVE on its A-frame, four FLOWERS, the taped zones, and all
  56 SCORING ELEMENTS staged exactly where Section 10.3.1 puts them.
- **3D ball physics** for POLLEN and NECTAR — they bounce off the tiles, the
  walls and the robots, using the robot's *surface* velocity at the contact, so
  a spinning robot flicks them.
- **The scoring loop**: fill the upward CELL until the HIVE tips, the contents
  spill, the opposite CELL arrives empty. FLOWERS keep an ordered stack, because
  the top-most NECTAR owns the tube and the bottom-most takes the bonus — so one
  late NECTAR can take a FLOWER the other alliance spent the match filling.
- **A flywheel launcher** where recovery is the real limit, with an aiming solver
  that knows a CELL only accepts a descending ball.
- **Full match flow and scoring**: 30 s AUTO, 8 s transition, 2:00 TELEOP, the
  whole point table, the four ranking points, the G410 NECTAR lock, and a G304
  check that tells you which clause your start position breaks.

Every dimension is marked with where it came from — quoted from the manual with
its section, or measured from the CAD. See
**[docs/BIOBUZZ.md](docs/BIOBUZZ.md)**, which also records the four things the
manual's prose alone led me to get wrong before the CAD arrived.

## What is deliberately *not* in the box

No autonomous routines, and no attempt to model any *particular* robot's
mechanisms — the intake and launcher are a plausible robot with every number
exposed as an option, not a copy of yours. The drills and the opponents remain
game-agnostic: they train the skills underneath any game, and they still run on
a bare field with the game switched off. The extension points are documented in
[docs/EXTENDING.md](docs/EXTENDING.md); adding a mechanism should not require
touching the core, and the game itself is built entirely on those seams.

---

## Documentation

- **[QUICKSTART.md](QUICKSTART.md)** — getting it running, written for
  people who have never used a terminal. Start here if you are a driver.
- **[docs/PHYSICS.md](docs/PHYSICS.md)** — the model, the derivations, the
  assumptions and their limits, and how to calibrate against your robot.
- **[docs/EXTENDING.md](docs/EXTENDING.md)** — adding subsystems, game
  elements, op-modes and parameters, with worked examples.
- **[docs/CONTROLS.md](docs/CONTROLS.md)** — controller setup and a guide to
  tuning the driver-feel parameters.
- **[docs/BIOBUZZ.md](docs/BIOBUZZ.md)** — how the game is modelled, where every
  dimension came from, and what the field geometry turns out to imply.

## Layout

```
src/
  math/        Vec2, Rotation2d, Pose2d, PIDF, filters
  physics/     rigid body, wheel contact model, friction, load transfer, collision
  hardware/    DC motor, gearbox, battery, encoder, IMU, FTC-style motor controller
  drivetrain/  wheel layouts, generic kinematics, drivetrain assembly
  robot/       robot assembly, Subsystem extension point
    biobuzz/   roller intake, flywheel launcher
  field/       FTC field, FieldElement extension point
    biobuzz/   HIVE, FLOWER, zones, field assembly, match and scoring
  ai/          the other three robots: scoring systems, builds, skill, plans
  challenges/  timed driving drills: geometry, state machine, records
  input/       Gamepad API with FTC semantics, keyboard, latency model
  teleop/      OpMode extension point, drive schemes, driver-feel processing
  render/      WebGL2 renderer, cameras, procedural geometry and textures
  ui/          schema-driven settings panel, HUD, telemetry graphs
  config/      parameter schema, config store, motor and robot presets
  app/         simulation loop, application wiring, BIOBUZZ coordinator
test/          281 tests: unit, physics validation, drills, AI, the game, end-to-end
tools/         static server, headless browser check
```

Everything below `src/app/` is headless: the simulation runs in Node with no
canvas, which is how the physics is regression-tested.

## Requirements

A browser with WebGL2 — any current Chrome, Firefox, Edge or Safari. That is all
you need for the hosted version.

To run it locally you also need something that can serve static files. The
double-click launchers use Node, Python, Ruby or PHP, whichever your computer
already has. Node 18+ is required for `npm test` and `npm run check`.

## Licence

MIT.
