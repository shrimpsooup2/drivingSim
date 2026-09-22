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
| X | Toggle field centric |
| A | Reset the IMU heading to the current pose |
| B | Burst: bypass the acceleration ramp for full power |
| Back | Reset the robot to its starting position |

The driver aids keep off **Y**, the bumpers and the right trigger, because
those belong to the game. That was not always true and the collisions were
invisible rather than loud: sharing the right trigger between *fire* and
*burst* meant every shot came with a wheelspin, and sharing **Y** between
*flywheel* and *field centric* meant field centric toggled twice per press and
looked dead.

### Keyboard

One key, one job. Each pad-emulation key is the single source of truth in
`src/input/KeyboardSource.js`, and registering an app shortcut on one of them
throws at startup — because when a key does two things, it does the second one
silently.

| Key | Action |
| --- | --- |
| `W` / `S` | Drive forward / back |
| `A` / `D` | Strafe left / right |
| `Q` / `E` | Rotate left / right |
| Arrow keys | Drive and rotate (alternative) |
| `Shift` | Precision mode (left trigger) |
| `H` | Run the intake (right bumper) |
| `U` | Eject / place in a FLOWER (left bumper) |
| `Y` | Spin the flywheel up or down |
| `Space` | **Fire** (right trigger) |
| `I` / `K` | Trim the hood or release angle (d-pad up/down) |
| `J` / `L` | Trim the target RPM (d-pad left/right) |
| `V` | Burst: bypass the acceleration ramp (B) |
| `X` | Toggle field centric |
| `Z` | Reset the IMU heading |
| `Backspace` | Reset the robot to its start |
| `R` | Restart the drill, or reset the robot |
| `N` | Driving drills |
| `T` | Shot trajectory guide |
| `C` | Cycle camera |
| `B` | Reset the camera framing |
| `M` | Restart the match from setup |
| `G` | Toggle the BIOBUZZ game (on by default) |
| `P` | Pause |
| `` ` `` | Hardware inspector |
| `.` | Step one op-mode loop |
| `,` | Step one millisecond |
| `Tab` | Show / hide settings |
| `?` | Help |

The right hand gets the whole right side of a controller: `I K J L` is the
d-pad, `H` the right bumper (home row, index finger — it is the key you hold
longest), `U` the left bumper, `Y` the Y button. `O` is deliberately unused:
in the panel's monospace font, "O hold to intake" reads as a zero.

The on-screen prompt names whichever one you are actually holding, so it reads
`H hold to intake` on a keyboard and `RIGHT BUMPER hold to intake` on a pad.

### Playing BIOBUZZ

BIOBUZZ is what the simulator opens on, and the robot comes with an intake and
a launcher:

| Control | Action |
| --- | --- |
| Right bumper | Run the intake |
| Left bumper | Place into a FLOWER if lined up, otherwise eject onto the tiles |
| `Y` | Toggle the flywheel (a catapult has nothing to spin, so it does nothing) |
| Right trigger | Fire |
| D-pad up / down | Trim the hood or release angle |
| D-pad left / right | Trim the target RPM (nothing to trim on a thrower) |

**Your launch system is a setting.** A CELL is 53.5 in up and has to be
launched into, and how you launch changes what you are practising more than
almost anything else on the robot — so *Match → Your launch system* offers a
single flywheel, twin flywheels, a heavy flywheel, a catapult or a linear
puncher. A flywheel makes you wait for the wheel and punishes firing early; a
catapult has no early to fire at, but a fixed reset and a hard maximum range;
a puncher only reaches from one narrow band. Drilling the wrong one is worse
than not drilling.

**FLOWERS take a lift, not a shot.** G419.A only lets a robot "enter POLLEN and
NECTAR into the top of a FLOWER", and the top ring is 21.25 in up with 0.6 in
of clearance for a POLLEN — you cannot shoot into it. Line the front of the
robot up with a tube, hold the eject, and the lift cycle takes most of a
second. Move off part-way and the cycle aborts with the element still held.

### The trajectory guide (`T`)

Draws the arc a shot would actually fly from where you are standing, green when
it scores and amber when it does not, with a ground shadow and a marker where it
crosses the CELL's opening. The ball world integrates flight under gravity
alone, so the launcher's closed form *is* the trajectory rather than an
approximation of it, and the hit test is the HIVE's own — the colour is a
prediction, not a hint.

*Overlays → Trajectory shows → Both* also draws the solved shot as a dashed
line: the gap between the arc you would get and the arc you want is exactly
what firing early and shooting on the move cost you.

The match panel shows the clock, the score split by achievement, and the
shooter's recovery bar. Watch that bar: the shot leaves at whatever speed the
wheel is actually doing, so firing before it comes back throws the ball short.
See [BIOBUZZ.md](BIOBUZZ.md) for what the geometry of the game implies — in
particular that a CELL only accepts a *descending* ball, which means there is a
minimum range inside which no hood angle can score.

A key is on or off, so keyboard input is a square wave. The acceleration ramp
smooths it, which makes the keyboard fine for learning the field and useless for
learning throttle control. There is no substitute for a real controller there.

## The hardware inspector

Backquote (`` ` ``) opens it. Two jobs:

**Seeing.** A Driver Station tells you what your op-mode chose to print. This
tells you what the hardware is doing: the duty each port ended up at, what its
encoder reads, what the pack is delivering, the loop time and what the hubs cost
this cycle, the odometry pose and how far it has drifted, the flywheel. When a
robot behaves oddly the answer is usually in one of those numbers, and usually
in the one nobody printed.

**Breaking.** Every sensor row has a fault selector — *working*, *dead* (reads
zero), *stuck* (holds its last value) — on each drive encoder, the IMU, and each
odometry pod. The IMU also takes a drift figure directly, in degrees.

That half is the point. An encoder cable comes unplugged, a pod's arm lifts, an
I2C bus stops answering, and none of those look like hardware failures from
inside an op-mode: they look like a routine that drives into a wall, or a
field-centric drive that slowly rotates its own frame, or a pose that walks
sideways across the field. You cannot practise for that on a working robot and
you cannot easily break a real one on purpose. Here it is a dropdown, and
**Repair everything** puts it all back.

The stuck IMU is the one worth trying first: the heading simply stops changing,
your code gets a number that looks perfectly reasonable, and everything built on
it goes wrong at once.

## Moving the robot by hand

Ctrl-drag (Cmd-drag on a Mac) on the field picks the robot up and puts it
wherever the pointer is. Plain left-drag still looks around and right-drag still
pans, so nothing the camera did has moved.

The AUTO panel (**F**) has a pose row for typing one instead, in metres from the
field centre, FTC inches, or Pedro Pathing's corner-origin inches — whichever
frame your routine is written in. See
[BIOBUZZ](BIOBUZZ.md#putting-the-robot-somewhere).

## Stepping through time

The bar at the bottom of the screen pauses the world and walks it forward.
`Pause` freezes everything — the physics, the match clock, and your op-mode,
which are one thing here because the op-mode is called from the step. Then:

| Button | What it advances |
| --- | --- |
| `1 ms` | Inside a single contact: a wheel going from gripping to sliding |
| `5 ms` | About as long as a ball is touching the flywheel |
| `20 ms` | Roughly one control cycle |
| `100 ms` | A movement |
| `cycle` | Exactly one op-mode loop, whatever that currently costs |

The reason for a millisecond is that the interesting events are shorter than a
frame. A NECTAR is in contact with the flywheel for about 8 ms; the HIVE's first
touch on the floor, which decides where its load scatters, is over in a handful
of milliseconds. At 60 frames a second you see the before and the after and
nothing in between, and that is where the bugs are.

`cycle` is the one for debugging code rather than physics: it advances exactly
one op-mode loop, so a pasted AUTO can be walked a line at a time. With hub
latency on (see [PHYSICS](PHYSICS.md#the-loop-rate-is-earned-not-set)) the step
length is the loop time, so stepping a cycle at a time also shows what each
cycle is costing.

`.` and `,` are the same two on the keyboard, and a step button works whether
the simulation is running or already paused — it pauses first.

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

Press `N`, or click **Drills**. Fifteen courses in three tiers, none
game-specific — they train what sits underneath any game.

### Basic — learn the machine

| Drill | What it trains |
| --- | --- |
| **Sprint and stop** | Braking distance. Start here. |
| **Shuttle run** | Four repeatable cycles — the simplest match-like drill |
| **Slalom** | Carrying speed through turns instead of stopping to rotate |
| **Precision parking** | Stopping dead and square, as at a scoring position |

### Intermediate — real manoeuvres

| Drill | What it trains |
| --- | --- |
| **Figure eight** | Three laps; both turn directions equally. Find your weak one |
| **Barrel course** | Route planning around pillars, not just car control |
| **Threading the needle** | Four gaps barely wider than the robot. Arrive crooked and you do not fit |
| **Reverse docking** | Backing blind into three slots, facing away |
| **Strafe gauntlet** | Lateral movement through narrowed lanes (holonomic only) |
| **Delicate approach** | Speed limits on the way in; decide when the penalty is worth it |

### Advanced — long and contested

| Drill | What it trains |
| --- | --- |
| **The maze** | A serpentine through four full-width barriers |
| **The gauntlet** | The long one: sprint, pinches, a reversed gate, a corner park, a return leg |
| **Under defence** | Three cycles with a heavy Pusher denying your route |
| **Evasion** | Six waypoints while a fast Scout hunts you |
| **Match simulation** | Two minutes, two opponents, obstacles. Most cycles wins |

### How they work

- **The clock starts when the robot first moves**, so lining up costs nothing.
- **Objectives run in order.** Gates only count crossed in the direction the
  arrow shows, so you cannot farm one by rocking back and forth through it.
- **Obstacles are solid.** Clipping a pillar spins the robot and costs three
  seconds — a course is only tight if something stops you cutting the corner.
- **Penalties**: walls and obstacles cost a flat charge (rate-limited, so
  resting against something does not bill forever); straying out of a lane and
  speeding through a limited approach are charged per second; being shoved by
  an opponent costs time, which is what makes evading one worth the detour.
- **Medals.** Gold, silver and bronze par times are shown on each card. They
  are a first calibration against a clean run with no input latency, so treat
  them as provisional and edit `src/challenges/library.js` if your team finds
  them wrong.
- **Press `R`** to run it again from the start line.

Best times are saved in your browser, **separately for each drivetrain type**.
A time set on a 435 RPM mecanum robot says nothing about the same driver on a
geared-down tank, so mixing them would be actively misleading.

## Driving against opponents

Three of the advanced drills put AI robots on the field. Each one is a **fully
simulated robot** — same motor curve, battery, traction and mass as yours — so
it accelerates, breaks traction, and can be pushed. You can out-drive it,
which is the whole point.

### The builds

| Robot | Mass | Top speed | Character |
| --- | --- | --- | --- |
| **Scout** | 8.5 kg | 7.2 ft/s | Small and quick. You will not out-run it; you can shove it anywhere |
| **Rival** | 14 kg | 5.2 ft/s | A mirror of a standard competition robot. Whoever drives better wins |
| **Pusher** | 19 kg | 3.7 ft/s | Heavy tank on traction wheels. Slow, but it moves you and you do not move it |
| **Brick** | 21 kg | 1.9 ft/s | Barely moves, nothing shifts it. A rolling roadblock |

### The skill levels

Skill is modelled where it actually lives on a drive team, not as better
physics: how stale the driver's picture of the field is (reaction time), how
precisely they place the robot, how much power they dare use, how often they
re-plan, and how often they commit to something unhelpful.

| Level | Reaction | Character |
| --- | --- | --- |
| **Rookie** | 450 ms | Imprecise, hesitant, frequently caught out |
| **Competent** | 220 ms | Solid, occasionally makes a mistake |
| **Veteran** | 100 ms | Fast, precise, leads your motion |

### What they do

- **Blocker** — sits between you and your next objective. It does not chase, it
  *denies*, which is far more annoying and much closer to real defence.
- **Chaser** — pursues and pushes.
- **Camper** — parks on your objective, so you must wait it out or shove it off.
- **Shadow** — mirrors you across the field centre.
- **Patroller** — drives a fixed loop, ignoring you: a moving obstacle with
  predictable timing.

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
