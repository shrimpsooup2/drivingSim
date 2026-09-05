# Controls and driver tuning

## Setting up a controller

Plug it in and **press a button on it**. Browsers hide gamepads until they are
used, so an idle controller will not appear.

**Logitech F310**: the rear switch must be on **X** (XInput). In **D** mode it
enumerates as a generic device with a different axis order, and the simulator
shows a `CONTROLLER NOT IN XINPUT MODE` warning rather than misbehaving
silently. Xbox controllers work as-is.

A physical controller takes priority whenever it is being used; the keyboard
takes over after two seconds of stick inactivity, so you can pick up a
controller mid-session without touching a setting.

## Bindings

These match what most FTC teams use, so muscle memory built here transfers.

| Control | Action |
| --- | --- |
| Left stick | Drive and strafe |
| Right stick X | Rotate |
| Left trigger | Precision mode — analogue, so partial pressure gives partial slowdown |
| Right trigger | Bypass the acceleration ramp for a burst of full power |
| Y | Toggle field centric |
| B | Reset the IMU heading to the current pose |
| Back | Reset the robot to its starting position |

### Keyboard

| Key | Action |
| --- | --- |
| `W` / `S` | Drive forward / back |
| `A` / `D` | Strafe left / right |
| `Q` / `E` | Rotate left / right |
| Arrow keys | Drive and rotate (alternative) |
| `Shift` | Precision mode |
| `Space` | Boost / full power |
| `R` | Restart the drill, or reset the robot |
| `N` | Driving drills |
| `F` | Toggle field centric |
| `H` | Reset IMU heading |
| `C` | Cycle camera |
| `B` | Reset the camera framing |
| `P` | Pause |
| `Tab` | Show / hide settings |
| `?` | Help |

A key is on or off, so keyboard input is a square wave. The acceleration ramp
smooths it, which makes the keyboard fine for learning the field and useless for
learning throttle control. There is no substitute for a real controller there.

## Reading the field

- **Arrows at each wheel** show the ground force it is producing. Green means
  grip in reserve; red means that wheel is at the limit and about to slide.
- **Red crosses** mark a wheel that *is* sliding. Watch them on a hard launch.
- **Yellow rings** (optional) size with how much weight each wheel is carrying —
  turn them on and accelerate hard to see the front wheels unload.
- The **blue line** from the robot's centre is its velocity vector, which is not
  the same as where it is pointing once you are sliding.

The **driver station** camera is the default on purpose. It is the view you
actually have in a match: low, from one end, with the far side hard to judge.
Overhead makes the field trivially readable and teaches habits that fall apart
at competition.

## Moving the camera

The mouse works in every view, and every adjustment is saved with your config,
so a framing you like comes back next session and travels to your teammates
when you export.

| Input | What it does |
| --- | --- |
| **Drag** | Look around. From the driver station this moves where you are *standing*: along the wall, and up or down for eye height. |
| **Right-drag** (or `Shift`+drag) | Pan |
| **Scroll** | Zoom |
| **Double-click** | Reset this view's framing |
| `C` | Cycle through the four views |
| `B` | Reset this view's framing |

Zoom means different things depending on where you are, because it should. From
the driver station you cannot walk onto the field, so scrolling narrows the
field of view — the same thing as leaning in and squinting. Everywhere else it
moves the camera closer.

### Matching your real driver station

Every camera parameter is in the **Camera** group of the settings panel. The
three worth setting honestly:

- **Driver eye height** — how tall you are, standing. Shorter drivers really do
  find the far side of the field harder to read, and this reproduces it rather
  than pretending everyone is 1.8 m.
- **Distance behind wall** — how far back the alliance station puts you.
- **Position along the wall** — real stations put you off to one side, which is
  why the far corner on your own side is the hardest place on the field to judge
  distance. Set this to where you actually stand.

The other views are adjustable too: chase distance, height and angle (swing it
round to watch from the side while driving), overhead zoom and follow, and full
orbit control with an option to keep the robot centred.

## Driving drills

Press `N`, or click **Drills**. Eight timed courses, none of them game-specific,
because the season's game is not known — they train the skills underneath any
game.

| Drill | What it trains |
| --- | --- |
| **Sprint and stop** | Braking distance. Start here. |
| **Shuttle run** | Repeatable cycles — the closest drill to a real match |
| **Slalom** | Carrying speed through turns instead of stopping to rotate |
| **Precision parking** | Stopping dead and square, as at a scoring position |
| **Figure eight** | Both turn directions equally; find your weak one |
| **Barrel course** | Route planning, not just car control |
| **Tight lane** | Staying smooth under pressure |
| **Strafe gauntlet** | Lateral movement (holonomic drivetrains only) |

How they work:

- **The clock starts when the robot first moves**, so you can line up in your
  own time without it counting against you.
- **Objectives must be taken in order.** Gates only count when crossed in the
  direction the arrow shows, so you cannot farm one gate by rocking back and
  forth through it.
- **Hitting a wall adds time.** So does straying out of the lane in the corridor
  drill, charged per second you are outside rather than as a one-off.
- **Press `R` to run it again** from the start line.

Best times are saved in your browser, **separately for each drivetrain type**. A
time set on a 435 RPM mecanum robot says nothing about the same driver on a
geared-down tank, so mixing them in one leaderboard would be actively
misleading.

Drills that need strafing are hidden when a tank drivetrain is selected.

## Tuning driver feel

Everything below is in the **Driver controls** group and costs nothing to
experiment with — no rebuild, no new parts. In rough order of impact:

### Turn power limit (`driver.turnScale`, default 0.8)

The fastest fix for a robot that feels twitchy. Rotation is the easiest axis to
overdrive; most drivers are better with it capped at 0.6–0.8.

### Acceleration ramp (`driver.slewRate`, default 6)

How fast commanded power may rise, in full-scale units per second. 6 means zero
to full in about 170 ms. Lower values stop the driver breaking the wheels loose
at the cost of responsiveness. The separate **deceleration ramp** is fast by
default, so the robot still stops promptly with a gentle acceleration ramp.

Hold the right trigger to bypass the ramp — a good way to feel exactly how much
it was protecting you from.

### Response curve (`driver.exponent` and `driver.curveBlend`)

Exponent 1 is linear; 2 or 3 gives fine control near centre with full power
still available at the ends. `curveBlend` mixes between linear and the full
curve; around 0.7 keeps low-speed precision without feeling dead off centre.

Most drivers who say a robot is "hard to line up" want this, not a lower speed.

### Precision mode (`driver.slowModeFactor`, default 0.35)

The multiplier while the left trigger is held. It is analogue, so it works as a
proportional brake rather than an on/off switch.

### Strafe power limit (`driver.strafeScale`)

Mecanum strafing is genuinely slower than driving — about 88% in this simulator.
Many teams push this above 1 to compensate; desaturation then scales everything
back down proportionally, so the robot still travels the direction you asked for.

### Heading hold (`driver.headingLockEnabled`)

When the driver is not commanding a turn, a PD loop holds the current heading.
Stops the robot being knocked off course and makes strafing track straight. It
engages only once rotation has nearly stopped, so it never fights an intentional
turn.

Worth trying, but note it depends on the IMU, so it inherits IMU drift.

### Field centric vs robot centric

Robot centric means forward is wherever the robot is pointing. Field centric
means forward is always away from the driver station, using the IMU.

Field centric is easier to learn and much easier to lose confidence in: the IMU
drifts, and by the end of a two and a half minute match at the default 0.05°/s a
heading is off by more than 7°. That is enough to notice while strafing, and it
is the usual reason field centric "stops working" mid-match. Practise resetting
the heading (`B` / `H`) when you are square to a wall.

Set `imu.enabled` to false for a perfect IMU when you want to tell an IMU
problem apart from a driving problem.

## Things worth practising here

- **Launching without spinning the wheels.** Turn on the force vectors, set the
  acceleration ramp high, and watch the wheels go red. Then find the ramp rate
  where they stay green.
- **Stopping accurately.** Compare `BRAKE` and `FLOAT` zero-power behaviour
  under Control Hub settings; the difference is over two metres of stopping
  distance from top speed.
- **Driving on a tired pack.** Load the "Last match of the day" preset. The
  robot is slower, weaker, and sags hard under acceleration.
- **Driving something tippy.** The "Tall and tippy" preset has a high CG and a
  narrow track. Turn on wheel load rings and feel what weight transfer does.
- **Judging distance from the driver station.** This is the skill the camera
  default exists to build. Resist switching to overhead.
