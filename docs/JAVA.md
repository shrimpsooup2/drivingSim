# Running your own Java op-modes

Paste a real `LinearOpMode` out of your team's repository, or load the whole
repository, and it runs here — against this simulator's physics, its battery
sag, its encoder quantisation and its hub latency.

This is the thing a teammate's JVM simulator does properly: it runs unmodified
op-modes against the real FTC SDK jars, which needs a JVM. This page has no JVM
and no dependencies, so it reads the Java itself — a tokenizer, a
recursive-descent parser and an emitter for the slice of Java that FTC op-modes
are written in, plus a shim of the SDK.

That means **the subset below is what works**. Anything outside it is refused by
name and line rather than mistranslated, because a compiler that silently gets
something wrong is worse than one that says no.

## Loading it

Press **F** for the autonomous panel. Four ways in:

| | |
| --- | --- |
| **From this machine** | A checkout served alongside the page. Start it with `npm run repo -- ../your-FtcRobotController`, or just `npm start` — it looks for a sibling checkout. Closest to `-Prepo`: no network, no sign-in, and editing a file in your IDE and pressing the button again picks it up. |
| **From GitHub** | Type `owner/repo`, or `owner/repo#branch`, or paste a github.com link. Public repositories, no token, 60 requests an hour. |
| **Pick a folder** | Chromium can hand a page a directory. No server flag, no network. |
| **Pick files** / drag and drop | One `.java` file, or a folder dropped onto the panel. |

Everything under the tree is compiled **together**, because your op-mode
references your own helper classes. Build output, `.git`, the `FtcRobotController`
app itself and the SDK's own 40 samples are left out — the samples would bury
your four op-modes. Up to 200 files and 4 MB.

Then the **op-mode chooser** lists what it found, exactly as a Driver Station
does: `@Autonomous` and `@TeleOp`, grouped, with `@Disabled` hidden. An
`@Autonomous` runs during AUTO. A `@TeleOp` runs during TELEOP **instead of the
built-in driving**, so your own driver code has the robot.

## What happens when you load one

The init sequence runs immediately — the `hardwareMap` lookups, the run modes,
the "Initialised" telemetry — because that is what pressing INIT does. So before
the match starts you can already see:

- **what each name resolved to.** `hardwareMap.get(DcMotor.class, "leftFront")`
  has to find something, and your configuration does not match ours. Names are
  matched loosely: case, separators and word order are ignored, and `lf`,
  `left_front`, `frontLeft` and `leftFrontMotor` all land on the same port. A
  name that matches nothing gets a device that is modelled but drives nothing,
  and the panel says so in red rather than crashing on line one.
- **anything the compiler wants to say**, such as a method that does not exist.

Motors are held at zero until START, which is what the hub does — so an op-mode
that sets a power in its init sequence does not move the robot, here or on a
field.

## The one thing to get right: which way your motors are bolted on

On a real robot the two sides of a drivetrain face opposite ways, so positive
power turns the left wheels backwards. That is why every team's code contains

```java
leftFront.setDirection(DcMotor.Direction.REVERSE);
leftBack.setDirection(DcMotor.Direction.REVERSE);
```

and why the robot spins on the spot without it.

This simulator models that. A drive port has a **mount sign** —
`drivetrain.mirroredSide`, `left` by default because that is how nearly every
FTC drivetrain is built — and `setDirection(REVERSE)` multiplies on top of it.
The built-in driving divides it back out, so both are right at once: **your
op-mode drives straight *because* it reverses the mirrored side**, and it spins
if it forgets, exactly as on your robot.

If your robot is built the other way round, or has a bevel on every corner,
change `drivetrain.mirroredSide` in the settings panel.

## How a blocking op-mode runs without a thread

A `LinearOpMode` blocks: `waitForStart()` sits there until the match starts,
`sleep(500)` for half a second, `while (opModeIsActive())` until stop. On a
Control Hub that is fine, because the op-mode has its own thread.

Nothing in a browser can block, so every place the Java would have blocked is
compiled into a `yield`, and every method that can reach one becomes a
generator. Which methods those are is worked out by a fixpoint over the call
graph, so `a()` calling `b()` calling `sleep()` all become generators and the
call sites get `yield*`.

The scheduler then asks one question at each of those points: **has the op-mode
done anything that takes time since the last one?** Hub transactions count,
because the [hardware bus](PHYSICS.md#the-loop-rate-is-earned-not-set) charges
them; reading the clock counts, because time passes whether you look at it or
not. If either has happened, the world advances. If neither has — you are doing
arithmetic — it keeps going, because arithmetic is instantaneous on a real robot
too.

What falls out of that is the right thing without anybody arranging it:

- a `while (opModeIsActive())` loop that writes four motor powers runs once per
  cycle, and the cycle is 15 ms long;
- the same loop reading its four encoders one at a time instead of in a bulk
  read runs slower — 23 ms with caching off;
- a `for` loop summing twenty thousand numbers does not cost a frame.

`sleep()` and `ElapsedTime` run on the **simulated** clock, so pausing the world
pauses your op-mode with it and a step of 1 ms steps both.

## The Java that works

Everything an op-mode is made of:

- **Classes** and **enums**, fields, methods, constructors, static and instance
  initialiser blocks, nested classes, `abstract` bases (an `AutoBase extends
  LinearOpMode` with your real autos under it is fine).
- **Statements**: `if`/`else`, `while`, `do`/`while`, `for`, for-each,
  `switch` (both the classic falling-through form and `case X ->`), `break`,
  `continue`, labels, `return`, `throw`, `try`/`catch`/`finally` with multi-catch,
  `synchronized` (there is one thread, so it is a plain block). `assert` is
  stripped, which is what happens on a Control Hub.
- **Expressions**: the full precedence table, compound assignment, the ternary,
  `instanceof` with a pattern variable, casts, array creation and initialisers,
  lambdas, `Foo.class`, all the literal forms including hex, binary,
  underscores and the type suffixes.
- **Generics** are parsed and erased, which is what the JVM does to them.

### What is deliberately different

| | |
| --- | --- |
| Integer division | Truncates, as Java does — worked out from the declared types of fields, parameters and locals. Where the type cannot be known the division is left alone. |
| `char` | A number, as in Java, so `'A' + 1` is 66 and not `"A1"`. |
| Integer overflow | **Not** modelled. A value that would wrap at 32 bits keeps growing. |
| `==` on objects | Value equality. Nobody who wrote `s == "x"` meant reference identity. |
| Doubles in telemetry | Printed as JavaScript prints them, so `1.0` may read as `1`. |

### What is refused

Anonymous inner classes, method references (`::`), interfaces and records,
try-with-resources, text blocks (`"""`), streams, and threads other than the
op-mode's own. Each is reported by name with its line.

## The SDK that is shimmed

| | |
| --- | --- |
| Op-modes | `LinearOpMode`, `OpMode`, `waitForStart`, `opModeIsActive`, `opModeInInit`, `isStarted`, `isStopRequested`, `idle`, `sleep`, `getRuntime`, `resetRuntime`, `requestOpModeStop`, `terminateOpModeNow` |
| Hardware | `HardwareMap` (`get`, `tryGet`, the typed collections, `voltageSensor`), `DcMotor`, `DcMotorEx`, `DcMotorSimple`, `Servo`, `CRServo`, `IMU` (and the older `getAngularOrientation`), `VoltageSensor`, `TouchSensor`, `DistanceSensor`, `ColorSensor`, `LynxModule` |
| Motors | `setPower`, `setDirection`, `setMode` (including `STOP_AND_RESET_ENCODER`), `setZeroPowerBehavior`, `setTargetPosition`, `isBusy`, `getCurrentPosition`, `setVelocity`, `getVelocity`, `getCurrent`, `setPIDFCoefficients`, `setVelocityPIDFCoefficients` |
| Telemetry | `addData` (including the format form), `addLine`, `update`, `clear`, `setAutoClear`, `speak`, `log()`. An iterative `OpMode`'s telemetry is transmitted after every `loop()` without being asked, as the SDK does |
| Units | `AngleUnit`, `UnnormalizedAngleUnit`, `DistanceUnit`, `CurrentUnit`, `TimeUnit`, `RevHubOrientationOnRobot` |
| Vision | `VisionPortal` and `AprilTagProcessor` with their builders, `getDetections`, `ftcPose`, `robotPose`, `metadata` — onto [the simulated camera](BIOBUZZ.md#apriltags-and-a-camera) |
| Utilities | `ElapsedTime`, `Range`, `Math` (including `toRadians`, `toDegrees`, `signum`, `floorMod`), `String.format`, `ArrayList`, `HashMap`, `Arrays`, `Collections`, `Double`, `Integer`, `System.out` |

`LynxModule.setBulkCachingMode` really changes the caching mode, and
`clearBulkCache` really clears it — so the loop time moves when you change them,
which is the point.

Anything else is a `NoClassDefFoundError` naming what it could not find.

## When it goes wrong

- **A syntax error** names the file and the line.
- **An unsupported construct** names the construct and the line.
- **A missing device** is a red line in the wiring list, and the op-mode still
  runs.
- **A runtime error** stops the op-mode, shows the message in the panel, and
  leaves the simulator running.
- **A loop that never yields** is caught by the wall-clock budget and stopped,
  rather than hanging the tab.

It is compiled with `new Function` and runs with the page's own privileges.
There is no sandbox and no attempt at one — load code you wrote.
