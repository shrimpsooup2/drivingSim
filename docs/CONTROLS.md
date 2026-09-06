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
