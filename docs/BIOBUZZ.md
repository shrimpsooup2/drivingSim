# BIOBUZZ in the simulator

This is how the 2026 game is modelled, where every number came from, and the
handful of things the geometry turns out to imply that are not obvious from
reading the manual.

Press **G** to switch the game on, **M** to restart the match. Off, you get a
bare field, which is what the drills and free driving use.

## Where the numbers come from

Two sources, and the code says which for every value in
`src/field/biobuzz/constants.js`:

- **MANUAL** — quoted from the *BIOBUZZ Competition Manual V1*, with the
  section it came from.
- **CAD** — measured from the official field CAD, an Onshape STEP AP242 export
  of `am-5850 BIOBUZZ` (`field-cad-step.zip` in the repo), 832 part occurrences.

Where the two disagree the CAD wins, because the manual rounds: NECTAR is
"3.6 in" in the text and 3.62 in the model.

Before the CAD arrived, everything that only appears in a figure had to be
inferred from the prose. Four of those inferences were wrong, and each one
changes how the game is played — worth recording, because they are the sort of
thing a team reading only the manual would also get wrong:

| Inferred from the text | What the CAD says |
| --- | --- |
| Two FLOWERS per alliance side, aligned with the HIVES | **One FLOWER per wall**, 68.04 in out and 23.39 in off that wall's centre line |
| HIVE rests at ~35° | **30.0°**, read off four collinear goal-rib origins |
| Red starts with its rear CELL up | Red starts with its **audience-side** CELL up |
| LOADING ZONE in a corner | **Against the middle of each alliance wall**, offset toward the rear |

The coordinate mapping from the CAD is pinned by two facts in the model: the
red NECTAR staging tray sits outside the `cadX = -72` wall, and the CELL named
"Red Cell (Audience)" is the one on `cadZ > 0`. Together those put red on the
audience's left, exactly as Section 9.5 requires. In simulator coordinates
that is `simX = cadX`, `simY = -cadZ`, `simZ = cadY`.

## Coordinates

Origin at the field centre. **+x** runs from the red ALLIANCE AREA toward the
blue one, **+y** from the audience wall toward the rear wall, headings
counter-clockwise. Red is FIELD columns A–C and blue D–F, per G304.

Measured extents: perimeter inner face at ±71.61 in, tiles at ±70.72 in, tile
surface at z = 0, wall top at 11.3 in.

## The HIVE

A bi-stable see-saw per alliance, pivots 43.95 in up at x = ±12.7 in, resting
at 30°. Fill the upward CELL until it tips (20 points), the contents spill, and
the opposite CELL arrives empty ready to fill again.

The CAD stages three NECTAR in each upward CELL and they must not tip it, which
is the only hard constraint the manual gives on the tip threshold — so the
threshold is modelled as a mass and calibrated against it (0.300 kg against
0.255 kg of staged NECTAR). The real mechanism is a bi-stable balance, so mass
is the right thing for it to respond to; the exact figure is not published.

Elements come to rest **9.4 in from the pivot, 50.2 in above the tiles**. That
is the point a launcher has to put a ball on, measured straight off the three
staged NECTAR, and it is the single most important number for a shooter.

### Only the first TIP is cheap

The CELL starts with three NECTAR in it, so one more element carries it over.
After that the CELL arrives **empty** and needs a full load again — about seven
POLLEN. With 40 POLLEN on the field, reaching the 7-TIP POLLINATOR 2 ranking
point means re-collecting your own spillage.

### A robot drives straight through the HIVE structure

The A-frame is two open triangles at x = ±24.3 in, each 38.1 in deep at the
tiles, joined by a crossbar at 43.95 in. Between them there is nothing below
the hanging CELLs, so a robot crosses the middle of the field straight through
the frame. The collider is the two leg footprints only, and the renderer draws
the frame open rather than drawing its collider — a solid box there would both
look wrong and teach the wrong routes.

## The FLOWER

A vertical tube on each wall holding a single-file stack. Elements go in the
top; only POLLEN comes out the bottom.

The **scoring volume is 4.25 in to 21.25 in** — not a derivation, but the exact
span of the four HDPE pipes in the CAD, which run from the middle ring to the
top ring and so *are* the volume.

Two rules read the stack by position (Section 10.5.2), which is why the stack is
ordered rather than counted:

- the **top-most NECTAR** owns the FLOWER and earns 2 for *every* element in it,
  whoever put them there;
- the **bottom-most NECTAR** earns the 5-point bonus.

So going in early buys the bonus and going in last buys the tube. A FLOWER one
alliance spent the match filling can be taken whole by one late NECTAR.

### Three consequences of the geometry

1. **The four staged POLLEN are not all scoring.** They sit at 1.40, 4.29, 7.18
   and 10.07 in. The bottom one tops out at 2.80 in, below the 4.25 in floor —
   so it does not score, and it is the one a robot pulls from the retrieval
   opening. The three above it do. Collecting from a FLOWER costs the owner
   nothing until the stack drops.
2. **A NECTAR placed first is wasted and plugs the tube.** Resting on the tile
   its top is at 3.62 in, still under the scoring floor, so it claims nothing —
   and G418 only lets POLLEN out of the bottom, which the geometry enforces
   (NECTAR is 3.62 in, the retrieval opening 3.55 in). Everything above it is
   stuck there for the rest of the match.
3. **Aim long.** The backstop is on the wall side only, so an overshot comes off
   it and drops in while the same error short of the tube misses entirely.

## Shooting

The launcher is a flywheel. What limits it is not top speed but **recovery**:
every shot takes angular momentum out of the wheel,

```
J*w0 = J*w1 + m*v*R,    v = k*w1*R    =>    w1 = J*w0 / (J + k*m*R^2)
```

so the next shot is slower until the motor puts it back. NECTAR costs nearly
twice what POLLEN does. More inertia bites less per shot but spins up slower,
which is the real trade when a team adds a heavier wheel.

At the stock settings the robot is **feeder-limited, not wheel-limited** — the
wheel is back inside about 0.25 s and the feeder needs 0.35 s — so you cannot
outrun your own flywheel until you speed the feeder past recovery.

### A CELL only accepts a descending ball

The CELL faces upward, so the hive refuses anything still climbing through the
opening, the way a real basket would bounce it back out. Arriving on the way
down requires

```
tan(hood) > 2 * rise / range
```

because the apex has to fall before the target. The CELL is 50.2 in up, so from
1.3 m that is steeper than 57°, and **inside about 0.9 m the shot cannot be made
at any RPM**. A flat shot from point blank never scores however the speed is
trimmed. `Launcher.aimFor` solves this and picks the shallowest hood that
works, which is the tuning table a team would work out on a practice field.

Shooting on the move misses, because the ball keeps the robot's velocity — and
the two HIVES are 25.4 in apart on the same crossbar, so a shot that drifts far
enough lands in the *other* alliance's CELL and tips their hive for them.

## Match flow and scoring

30 s AUTO, 8 s transition, 2:00 TELEOP (Section 10.1). `Match` owns the clock,
the phase, LEAVE and PARK, the NECTAR release schedule, the point table and the
four ranking points, and it checks a starting position against G304 clause by
clause.

| Achievement | AUTO | TELEOP |
| --- | --- | --- |
| LEAVE (off the perimeter wall) | 3 | — |
| PARK (partly in your LOADING ZONE) | 5 | 5 |
| HIVE TIP | 20 | 20 |
| Element left in an upward CELL | — | 2 |
| Bottom NECTAR bonus | — | 5 |
| Element in an owned FLOWER | — | 2 |
| Element in a GARDEN | — | 1 |

Ranking points: SWARM (LEAVE + PARK ≥ 16), POLLINATOR 1 (≥ 4 TIPS),
POLLINATOR 2 (≥ 7 TIPS), WIN 3 / TIE 1.

**PARK is judged where the robot is when each period ends**, so the AUTO park is
banked and the TELEOP one is not settled until the buzzer. LEAVE requires having
started on the wall — a robot staged illegally off it has not left anything.

### The score during TELEOP is not the final score

Two lines only resolve at rest, and both can be taken off you in the last
seconds: elements in an upward CELL score 2 each, so a HIVE that tips at 0:01
hands its contents back to the floor; and a FLOWER pays its owner for
everything in it, and the owner is whoever's NECTAR is top-most.

### NECTAR release and G410

Each TIP releases one of the five NECTAR staged in the ALLIANCE AREA, and all
remaining ones are released with 60 seconds left (Section 10.1). G410 forbids
NECTAR entering a FLOWER's scoring volume before that mark; an early one still
scores, so the simulator counts it as a violation rather than preventing it —
the same way a referee would. The count shows on the match panel as `G410 xN`.

## Controls

| Key | Does |
| --- | --- |
| **G** | Toggle BIOBUZZ on/off |
| **M** | Restart the match from setup |
| Right bumper | Run the intake |
| Left bumper | Eject the front element |
| **Y** | Toggle the flywheel |
| Right trigger | Fire |
| D-pad up/down | Trim the hood angle |
| D-pad left/right | Trim the target RPM |

The rest of the controls are in [CONTROLS.md](CONTROLS.md).

## What is still a simulation choice

Almost nothing is left inferred, but these are modelling decisions rather than
measurements, and they are the places to look first if something feels wrong:

- **Ball masses** (POLLEN 0.045 kg, NECTAR 0.085 kg) are not published. They
  only affect how far a robot shoves a pile and how the flywheel behaves, not
  scoring.
- **The HIVE tip threshold**, calibrated as described above.
- **The CELL capture margin** (1.5 in), because the manual defines scoring by
  what is in the CELL at rest, not by a capture volume.
- **Flower stack pitch.** A column of balls in a tube wider than the balls
  zig-zags, giving 2.53 in for POLLEN rather than 2.80 in. The CAD lays its
  staged POLLEN out at a flat 2.89 in, which is wider than a POLLEN — those
  balls are not touching, so that is a drawing layout rather than a settled
  stack. It makes no difference to scoring either way.
- **Intake and launcher geometry** is a plausible robot, not any particular
  robot. Every number is a constructor option so you can put your own in.

## Files

```
src/physics/Ball.js              one SCORING ELEMENT
src/physics/BallWorld.js         3D ball physics, own rate, grid broadphase
src/field/biobuzz/constants.js   every dimension, with its provenance
src/field/biobuzz/Hive.js        the bi-stable see-saw
src/field/biobuzz/Flower.js      the ordered stack
src/field/biobuzz/zones.js       LOADING ZONE, GARDEN, ALLIANCE AREA
src/field/biobuzz/BiobuzzField.js  assembly and Section 10.3.1 staging
src/field/biobuzz/Match.js       clock, phases, scoring, ranking points, G304
src/robot/biobuzz/Intake.js      roller intake
src/robot/biobuzz/Launcher.js    flywheel launcher and the aiming solver
src/app/BiobuzzGame.js           attaches the game to a running simulation
src/ui/MatchPanel.js             clock, score breakdown, shooter readout
```

Tests: `test/biobuzz.test.js` (field structures), `biobuzz-robot.test.js`
(mechanisms), `biobuzz-match.test.js` (flow and scoring), `biobuzz-game.test.js`
(integration). `node tools/check.js` drives the whole thing in headless
Chromium, including firing a shot into the cell through the real physics loop.
