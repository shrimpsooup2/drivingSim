# BIOBUZZ in the simulator

This is how the 2026 game is modelled, where every number came from, and the
handful of things the geometry turns out to imply that are not obvious from
reading the manual.

BIOBUZZ is what the simulator opens on. **G** puts it away and brings it back,
**M** restarts the match. With it off you get a bare field, which is what the
drills and free driving use — and selecting a drill switches the game off for
you and turns it back on when you clear the drill, so you can dip into a drill
and come back to the match.

## Where the numbers come from

Two sources, and the code says which for every value in
`src/field/biobuzz/constants.js`:

- **MANUAL** — quoted from the *BIOBUZZ Competition Manual V1*, with the
  section it came from.
- **FIGURE** — dimensioned directly in a manual figure
  (`BIOBUZZ_Competition_Manual_V1.pdf` in the repo). These beat everything else:
  where a figure calls out a number, that is the number.
- **CAD** — measured from the official field CAD, an Onshape STEP AP242 export
  of `am-5850 BIOBUZZ` (`field-cad-step.zip` in the repo), 832 part occurrences.
  Good for positions and for anything no figure dimensions — but a part's
  bounding box picks up whatever is bolted through it, which is exactly how I
  got the flower's retrieval opening wrong at 3.19 in when the figure says 3.55.

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

A bi-stable see-saw per alliance, pivots 43.95 in up at x = ±12.75 in, resting
at 30°. Fill the upward CELL until it tips (20 points), the contents spill, and
the opposite CELL arrives empty ready to fill again.

### What you actually shoot at

Figure 9‑9 dimensions this outright, and it is the thing to get right:

| | |
| --- | --- |
| Bottom of the CELL opening | **53.5 in** |
| Top of the CELL opening | **65.6 in** |
| HIVE centre to centre | 25.5 in, so each pivot is 12.75 in off the middle |
| Bottom of the HIVE structure | 25.5 in — you drive underneath it |

The opening is **20 in wide by 14 in tall and perpendicular to the arm**, so it
faces straight out along the arm, 30° above horizontal. The proof is in those
two heights: 65.6 − 53.5 = 12.1 in, and 14·cos30° = 12.12.

And it is a **pentagon**, not a rectangle (Figure 9‑11): 20 in across the base,
straight sides up to a shoulder at 7.61 in, then a taper to the apex at 14 in.
The top corners are tighter than the base, so a high shot has less room than the
20 in suggests.

The CAD stages three NECTAR at **9.4 in out and 50.2 in up** — but that is where
contents *rest*, on the sloping floor 12 in back along the arm and about nine
inches below the opening. Aiming there instead of at the opening puts the ball
into the outside of the CELL wall. `Hive.cellOpening()` gives the aperture,
`Hive.cellRest()` the floor, and `target` is the aperture.

Three numbers from three places reconcile to three figures here, which is why it
is worth building rather than guessing: take the CAD's staged NECTAR, go 12 in
out along the arm (the manual's CELL depth), lift to the middle of the figure's
53.5 and 65.6 — and the lower edge lands on 53.5 and the apex on 65.6 exactly.

### How the tip works

The HIVE is a rigid body rotating about its pivot, not a mass compared against
a threshold. Its centre of gravity sits **above** the pivot, which makes level
an *unstable* equilibrium: the arm runs to whichever stop it is nearest and
latches there. That over-centre latch is the bi-stability the manual describes,
and weight in the raised CELL fights it:

```
structure torque = +M*g*h*sin(t)          holds the arm on its stop
element torque   = -m*g*(u*cos t - v*sin t)   u is the element's lever arm
```

Three things follow that a threshold cannot give you:

- **Where a ball lands matters.** `u` is the lever arm, so an element that
  settles deep in the CELL tips the HIVE more readily than one resting near the
  lip. Accurate shooting is worth something beyond just landing it.
- **The rotation takes real time** — about 0.9 s for a full CELL and 2.3 s for a
  marginal load, because an over-centre mechanism is slowest just off its latch.
  You can launch into a CELL that is already going over.
- **Elements fall out because the CELL rolls past horizontal**, leaving with the
  speed that point of the arm is actually doing.

`M*h` cannot be measured — a STEP file carries no density — so it is
parameterised by `holdMass`: the load in the raised CELL the latch will just
hold. That is directly interpretable and pinned at one end by the manual, since
three NECTAR are staged there and must not tip it. At 0.28 kg the HIVE holds
exactly those three and goes over on the next element.

The four Blumotion soft-close dampers in the CAD are modelled as engaging over
the last part of the travel rather than as a constant dashpot, which is what a
soft-close damper is — as a constant one it made the tip crawl for nearly three
seconds through the middle of its stroke.

### Only the first TIP is cheap

The CELL starts with three NECTAR in it, so one more element carries it over.
After that the CELL arrives **empty** and needs a full load again — about seven
POLLEN. With 40 POLLEN on the field, reaching the 7-TIP POLLINATOR 2 ranking
point means re-collecting your own spillage.

### There is a corridor through the middle, but only front to back

The A-frame is two open trusses at x = ±24.3 in, each 38.9 in deep, joined by
a crossbar at 43.95 in. Nothing hangs below the CELLS, so the middle of the
field looks wide open — and front to back it is. A **corridor about 38 in wide
runs the full depth of the field under the HIVE**, open at both ends.

Side to side it is not open, which I had wrong at first. Each frame side sits on
a **continuous foot bar**: 2.00 in thick, the full 38.94 in depth, 2.15 in tall.
A bumper stops dead against it. So crossing from the red half to the blue half
means going *around* the frame, past the end of it at |y| > 19.5 in.

Above the foot bar the struts lean up and inward, so their collider is clipped
to the part below the 18 in robot limit — past that the strut is overhead and
you drive underneath it.

### Two things the CELL geometry got wrong

**Elements hung in mid-air beside the hive.** Each of the six plates was
resolved independently as a two-sided slab, pushing the ball "to whichever side
it is already on" — right for one plate, wrong at a corner. An element resting
against the *outside* of the bottom-back corner is within a radius of both the
floor plate and the back panel, and those two normals are 60° apart with upward
components: each push shoved it into the other's slab, and the pair held it
against gravity for the rest of the match. It did not merely fail to fall, it
crept upward.

A pentagonal prism is convex, so from outside there is exactly one contact — the
direction from the closest point of the solid to the ball's centre. Faces, ribs
and corners all fall out of that one expression, and one contact cannot wedge.
Inside the box both walls at once is still correct, because the inside of a
corner really is concave: an element in the bottom corner of a cell is held by
the floor and the side.

**The hive looked solid from one angle and open from another.** Not
transparency — back-face culling. A cell is a box you look *into*, so some of
its walls always face away from the camera, and a single-sided wall is simply
not drawn from that side. `cellMesh` now carries both windings, so exactly one
face of each wall survives culling from any angle.

Two-sided and opaque would be consistent but useless: you could never see how
full your own cell is, which is the one thing a driver watching for a tip needs.
The panels are clear polycarbonate, so they are drawn clear — blended over the
finished opaque scene with depth writes off, which is what keeps the far wall
from being occluded by the near one.

## The FLOWER

A vertical tube on each wall holding a single-file stack. Elements go in the
top; only POLLEN comes out the bottom.

The **scoring volume is 4.25 in to 21.25 in** — not a derivation, but the exact
span of the four HDPE pipes, which run from the middle ring to the top ring and
so *are* the volume.

The pipes are what actually hold an element, so the tube's clear radius follows
from them rather than from the manual's "approximately 4 in" opening: axes on a
square at ±1.725 in with a 1.05 in outside diameter give

```
clear radius = 1.725*sqrt(2) - 0.525 = 1.9146 in
```

A NECTAR is 1.81 in in radius, so it goes in with **0.105 in to spare** — which
is why NECTAR barely fits and why a stack of it sits almost dead straight while
POLLEN zig-zags. The gap between two adjacent pipes is 2.40 in, and a 2.8 in
POLLEN cannot squeeze out sideways through it.

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
4. **G418 is enforced by the geometry.** The retrieval opening is 3.55 in
   (Figure 9‑12), so POLLEN at 2.80 in comes out and NECTAR at 3.62 in cannot.
   The two square supports sit on the *wall* side of that opening, which is why
   a robot collects from the field side.

## Shooting

The launcher is a flywheel. What limits it is not top speed but **recovery**:
every shot takes angular momentum out of the wheel,

```
J*w0 = J*w1 + m*v*R,    v = k*w1*R    =>    w1 = J*w0 / (J + k*m*R^2)
```

so the next shot is slower until the motor puts it back. NECTAR costs nearly
twice what POLLEN does. More inertia bites less per shot but spins up slower,
which is the real trade when a team adds a heavier wheel.

The wheel also has to be spun up *past* the speed the shot needs, because the
ball takes its share on the way out. A POLLEN leaves at about 94 percent of the
wheel's pre-shot surface speed, and range goes as the square of speed, so
ignoring that puts the shot 13 percent short — six inches at CELL range. The
aiming solver divides by that droop factor and takes the element's mass, so
NECTAR correctly asks for more RPM than POLLEN for the same target.

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

because the apex has to fall before the target. The opening is 59.6 in up at its
centre, so from 1.3 m that is a steep shot, and **inside about a metre it cannot
be made at any RPM** — the panel says "no shot from here". A flat shot from point blank never scores however the speed is
trimmed. `Launcher.aimFor` solves this and picks the shallowest hood that
works, which is the tuning table a team would work out on a practice field.

Shooting on the move misses, because the ball keeps the robot's velocity. The
opening is 20 in wide, so it is forgiving up to a point and then not at all:
0.4 m/s of sideways drift still goes in, 0.8 m/s does not.

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

## What the elements look like

Section 9.8 names them: "Gopher ResisDent polyethylene balls", 2.8 in yellow
POLLEN and 3.6 in red and blue NECTAR. Figures 9-13 and 9-14 show what that
means — moulded perforated playground balls, round holes about a sixth of the
diameter across, in latitude bands with a moulding seam running round the
equator in a lane of its own.

So that is how they are drawn, and the holes are real rather than painted. Each
element is two shells: an outer one carrying a white alpha mask, and an inner one
at 0.88 of the radius in a darker shade of the same colour. The shader discards
any fragment whose mask alpha is below the cut, and a discarded fragment writes
no depth, so the inner shell shows through — which is what a hole in a hollow
ball looks like. A single sphere with dark circles painted on it went flat the
moment the camera got close.

The mask is generated once, from the hole axes, by turning each texel back into a
direction on the sphere and measuring the angle to every hole. That is the only
way to get holes that are round *on the ball*: circles drawn in UV space come out
as lozenges at the equator and smears at the poles.

The other half of this is that the elements now have an **orientation**. Spin was
already modelled — it is what makes a landing scrub into a roll — but nothing
read it, so a ball rolling across the tiles kept a fixed pattern of holes and
looked like a decal sliding along the floor. `Ball.integrateSpin` carries a unit
quaternion through the same integration the velocities get, and the renderer
composes it into the model matrix.

## Fouls, and the rules audit

A MAJOR FOUL is 20 points — ten elements in a CELL — so the fouls are where the
points are, and a driver who has never been called for anything learns to drive
in a way that gets called for everything. So the match has a referee.

Eleven of the forty Game Rules are officiated live: G401 and G403/G404 (powered
movement when there should be none), G402 (interfering during AUTO), G405
(elements out of bounds), G407 and G408 (what you are holding), G409 (catching
off a TIPPED HIVE), G410, G417 (meddling with the HIVE) and G421 (the 3-count on
pins). Calls appear on the match panel, newest first, colour-coded by tier, and
the PENALTY row of the breakdown shows the points each alliance has *gained* from
the other side's fouls — which is how Table 10-4 defines a foul, and why a foul
can never take you below the points you earned.

Where the manual says "if STRATEGIC", the model is Section 10.6's own test:
repetition inside one match. G411 (hoarding) has no warning tier at all, so it is
detected and reported and never scored — putting 20 points on a heuristic would
teach people to avoid the heuristic.

[docs/RULES.md](RULES.md) is the full audit, generated from
`src/field/biobuzz/rules.js` by `node tools/rules-doc.js`, with a note on every
rule the simulator does *not* enforce and why. The gaps are the point: a rule
marked "cannot be violated here" is a known limit, and a rule missing from a list
is a surprise at an event.

### Elements that leave the field come back (Section 10.8.2)

They used to be gone for good, which quietly made a long match easier: 56
elements minus the ones you shot over the wall. The manual says otherwise —
"POLLEN that exits the FIELD will be reintroduced into the FIELD at the earliest
safe opportunity by FIELD STAFF in the nearest convenient location. NECTAR that
exits the FIELD will be returned to that ALLIANCE'S DRIVE TEAM for
reintroduction."

So both come back, by different routes and not instantly. A POLLEN reappears six
seconds later just inside the wall near where it went over, in the nearest spot
clear of the structures and the other elements. A NECTAR goes back to its own
drive team and has to be entered through the LOADING ZONE again, which puts it
back on your own side rather than where it left. Either way the element is out of
your cycle for several seconds, which is the real cost of overshooting and the
reason to aim properly.

Whether it was also a *foul* depends on how it left, and G405 exempts two of the
three ways by name: a launched element is a scoring attempt, and one squeezed out
between two robots is a robot-to-robot interaction. What is left — carried,
shoved or spat over the wall — is a MAJOR FOUL per element. Every element
therefore carries a note of which robot last touched it and how, which is what
`Ball.lastTouch` is for.

## Pasting in an autonomous routine

AUTO was half the practice and none of it practisable: the sticks were live
during the AUTO period, which is a G401 violation and not what happens at an
event. A real auto is code, it runs the same way every time, and the thing a
team iterates on is that code.

Press **F** (or the *Auto* button) and paste it in. It runs during the 30-second
AUTO period on the same physics you drive — the same battery sag, the same
encoder quantisation, the same flywheel recovery — and the sticks do nothing
while it does, which is both G401 and the point.

Two shapes, because autos are written both ways:

```js
function* auto(robot) {          // sequential: yield waits
  robot.drive(0.6, 0, 0);
  yield 1.2;                     //   a number of seconds
  robot.stop();
  robot.shooter.spinUp();
  yield () => robot.shooter.ready;  //   or until a condition holds
  robot.shooter.fire();
  yield;                         //   or one op-mode cycle
  yield* helper(robot);          //   or another generator, to completion
}

function loop(robot, dt) { ... } // a state machine, called every cycle
```

A generator is what makes a *linear* op-mode possible without real time. An FTC
`LinearOpMode` blocks on `sleep()`; a simulator cannot block, it has to return
so the world can advance. `yield` is the same idea with the waiting handed back
to the caller, so the routine reads top to bottom and still steps on the
simulated clock. No `async`: a promise resolves on the microtask queue, which
does not line up with a synchronous physics step, and an auto that is one frame
behind behaves differently every run. Timed waits carry their overshoot into the
next one, so ten `yield 0.1`s take a second rather than up to 1.2.

`robot` is a façade, not the robot. Everything on it is either a command a
Control Hub can issue or a reading a sensor can take: the IMU with its drift and
latency, the encoders quantised to whole ticks, the bus voltage, how many
elements the intake reports. `robot.truth` is the exact pose, clearly labelled
and separate — useful for working out why a routine drifted, and steering by it
means the routine will not survive the trip to a real field.

The editor starts with a worked example, because the useful thing to hand
somebody is a routine that already scores. It drives until a shot exists (the
cell's opening is tilted and faces one way, so from the starting wall there is no
arc at any speed), empties the pre-load into the cell, and parks: 32 points,
including a tip, with no fouls.

It is compiled with `new Function` and runs with the page's own privileges.
There is no sandbox and no attempt at one — it is a tool for running *your* auto.
A routine that loops forever without yielding will hang the tab exactly as it
would in any other JavaScript; what the runner can do is notice afterwards and
stop it, so it does not happen again on every frame.

## Driving against each other over the network

Four people, four robots, one match. One machine runs it:

```
npm run lan
```

That binds every interface instead of just localhost and prints the
`http://192.168...` address to read out to everybody else. Then press **O**,
hit **Host a match**, and read out the four-character code as well. Everyone
else opens that address, presses **O**, types the code and their name, and
clicks **Join**.

A joiner does not get a new robot. It takes over one of the three that are
already on the field — an AI opponent, with its own chassis, its own mechanisms
and its own entry in the match. Nothing about the field changes when somebody
joins or leaves; only who is deciding what that robot does. So there is no
"add a robot mid-match" path to get wrong, the referee and the scoring never
see a difference, and somebody whose Wi-Fi drops leaves an AI driving their
robot rather than a dead weight parked on the tiles. Half a second of silence
is enough to hand it back, and their seat is still theirs when they return.

A remote driver goes through *exactly* the host's own control path: a
`TeleOpDrive` bound to that robot, then `robot.updateControl(dt, pad)`. Same
driver processor, same acceleration ramp, same field-centric toggle, same
voltage sag. A second, simpler control path for remote seats would have made a
joiner's robot subtly better or worse than the host's, which is the one thing a
practice tool cannot afford.

### Why one machine simulates everything

The tempting design is lockstep: everybody runs the same physics on the same
inputs and only inputs cross the network. It does not work here, and not for a
subtle reason. The physics calls `Math.sin`, `Math.cos` and `Math.exp` on every
substep, and ECMA-262 does not specify their results — an implementation is
allowed to return an approximation. Two browsers, or two versions of one
browser, may differ in the last bit, and at 2000 substeps a second a last-bit
difference is a visibly different match inside a minute. There would be no way
to tell that from a bug.

So the host simulates and the joiners mirror. A joiner still *builds* the whole
game — the same field, the same hive meshes, the same fifty-six elements — and
then stops stepping the physics and writes each snapshot over the top instead.
Nothing in the renderer, the HUD or the match panel has to know it is looking
at a mirror. The alternative, a lightweight "what to draw" structure, sounds
cheaper and is not: it means a second description of every object on the field,
and every time the real one changes the mirror silently stops matching it.

The cost is latency. A joiner draws the state *between* the last two snapshots
rather than guessing past the newest one, so it is about 50 ms behind the host
plus whatever the network adds. That is deliberate: every frame drawn is a
state that really happened. Extrapolating would hide the delay and pay for it
with elements going through hive walls whenever a packet was late, then
snapping back — a bad trade for something people are using to learn where
things are. There is no client-side prediction of your own robot either;
prediction without rollback jitters when it guesses wrong, and rollback needs
the determinism the first paragraph just ruled out. The upshot is a consistent
frame or two of lag, which is in the same range as a real Control Hub's own
command latency and is a thing a driver adapts to within a match.

### What actually crosses the wire

Two channels. The binary one carries what moves every frame — robot poses,
element positions and spins, hive angles, flower contents — at about a kilobyte
a snapshot, twenty times a second, which is 20 kB/s. The JSON one carries what
a human reads: the score breakdown, the phase, referee citations. That is
`match.status()` and `match.score()` passed through verbatim, so there is
exactly one description of what a score is and a joiner's panel cannot disagree
with the host's about who is winning.

Elements are matched by array index, with no id, which saves about 350 bytes a
packet. That works because both sides build their elements in the same order
from the same constants and never reorder the array. The joiner checks the
count and refuses a mismatch rather than writing nectar positions onto pollen —
that failure would look like broken physics rather than two different builds.

Node ships a WebSocket client and no server, and this project has no
dependencies, so `tools/websocket.js` is an RFC 6455 server written out: a
SHA-1 handshake and a frame header. The handshake is the easy half. What makes
hand-rolled implementations fail is framing, and specifically the three things
a localhost test never shows you — that TCP is a stream, so a frame can arrive
in two chunks and two frames in one chunk; that client frames are masked and
server frames must not be; and that one message can arrive as a run of
continuation frames with pings interleaved. There is a test for each.

`tools/relay.js` is the rendezvous, and is deliberately the least clever thing
here: it knows about rooms, roles and who is connected, and forwards every byte
unopened. If it understood the game it would be tempting to let it arbitrate,
and then the rules would have a second implementation that is not tested
against the manual. Routing needs no header because role decides it — snapshots
go host to everyone, inputs go joiner to host.

Room codes have no vowels, so a code cannot spell anything, and no `I`, `O`,
`0` or `1`, because the whole job of a room code is that somebody reads it off
one screen and types it on another, and those four are what get mixed up when
they do.

### Limits worth knowing

- **It is one LAN, not the internet.** There is no NAT traversal, no STUN and
  no TURN — the relay is the machine one of you is sitting at. Over the
  internet you would need a public host or a hole punched through, and neither
  is something this should do by default.
- **Nothing is authenticated.** Anybody who can reach the port and guess a
  four-character code can join. On a team's own Wi-Fi that is the right
  trade; on a public network, do not host.
- **The host's machine does all the work.** Four robots' physics, four sets of
  mechanisms and the snapshot encoding all land on one browser, so the host
  should be the fastest laptop in the room.
- **Autonomous is the host's.** A pasted routine runs on the host's robot.
  Joiners drive in teleop; their robots are AI-driven during auto.

## Controls

| Key | Does |
| --- | --- |
| **G** | Toggle BIOBUZZ on/off |
| **M** | Restart the match from setup |
| **F** | Autonomous editor |
| **O** | Multiplayer |
| **T** | Shot trajectory guide |
| Right bumper (`H`) | Run the intake |
| Left bumper (`U`) | Place into a FLOWER if lined up, otherwise eject |
| **Y** | Toggle the flywheel |
| Right trigger (`Space`) | Fire |
| D-pad up/down (`I`/`K`) | Trim the hood or release angle |
| D-pad left/right (`J`/`L`) | Trim the target RPM |

The rest of the controls are in [CONTROLS.md](CONTROLS.md).

## The two scoring routes need two different mechanisms

This is the most consequential thing the manual says about robot design, and it
is easy to miss because the two rules are in different sections.

A **CELL** is 53.5 in above the tiles and Section 1 says robots "LAUNCH them
into their CELLS". So a CELL needs a thrower: a flywheel, a catapult, a
puncher. Nothing that lifts is going to reach 53 in and still be a legal robot.

A **FLOWER** is the opposite. G419.A permits a robot "only [to] enter POLLEN and
NECTAR into the top of a FLOWER", the top ring is 21.25 in up, and the tube's
clearance for a 2.8 in POLLEN is **0.6 in** — you cannot shoot into that, and
the simulator will not let you. A FLOWER needs a lift or an arm that raises one
element over the rim and lets go.

So a robot built for one cannot score in the other, and that is modelled: the
intake's eject is context-sensitive (lined up with a tube it runs a lift cycle
taking most of a second; anywhere else it spits on the floor), and a robot with
no launcher has no way into a CELL at all.

Both routes are also *worth* different things. A CELL pays 2 an element and
20 for a TIP, but a TIP empties it — anything in there at the buzzer is gone if
the arm goes over at 0:01. A FLOWER pays 2 for **every** element in it to
whoever owns it, and cannot be tipped away. Ownership is the top-most NECTAR of
your colour, so a tube full of your POLLEN pays the other alliance if their
NECTAR lands on top of it last.

## The other three robots

A match is four robots: you, an alliance partner, and two opponents. Each of the
other three is configured independently along three axes, in
*Settings → The other three robots*:

- **Robot** — the archetype, which is really the scoring system. Single
  flywheel, twin flywheel, heavy flywheel, catapult, three-ball lobber, linear
  puncher, a wide intake with a lift, a single-element jaw on an arm, a heavy
  defender, or a stock pushbot. This decides what it can even attempt.
- **Build** — thrown together, competition ready, or worlds calibre. Motors on
  the flywheel, how repeatable the hood is, magazine size, winding time, and
  how often the intake jams. The same robot at two build standards is a
  different robot.
- **Driver** — rookie, competent or veteran: reaction time, precision, how much
  power they dare use, how often they commit to something unhelpful.

Any of the three can be **Random**, so "three random robots" is a different
match every time. The axes are deliberately separate because they are separate
at a real event: practising against a rookie on an excellent robot and a
veteran on a rough one are different exercises, and you meet both.

### How they play, and four things that were wrong with it

An AI robot goes through the same subsystem calls a driver's buttons make —
there is no shortcut into the ball world, so its shots are subject to the same
recovery, droop and aperture as yours. What it *decides* is a plan per role:
collect, fill up, drive to somewhere the mechanism can make the shot, stop,
aim, fire; or collect and lift into a flower; or get between you and your own
cell.

A full teleop used to produce about 55 points a side. It now produces 90 to
130, and the difference was four bugs rather than any cleverness:

- **The keep-out box was one box over the whole middle of the field.** The real
  geometry is two A-frames a foot wide with a clear corridor between them, and
  a routing box that covers a target makes it unroutable — the segment test
  reports a crossing whenever an endpoint is inside. So every element the hive
  dropped when it tipped landed in a region the AI would circle forever without
  reaching. One cycler spent 100 seconds of a 120-second teleop "collecting"
  and picked up nothing.
- **A coasting flywheel counted as ready.** `ready` tested `rpm >= target`, and
  a flywheel has no brake, so after one long shot it sits above the next
  shot's target for seconds. Exit speed goes with RPM and range with its
  square, so a wheel 14% fast puts the element a third of a metre past a 20 in
  aperture. Two thirds of every AI robot's shots were fired over the commanded
  speed and sailed straight over the cell.
- **Cyclers left as soon as they had one element.** The drive is the expensive
  part of a cycle; the magazine is what it is for. They now fill up first, and
  spin the wheel up for the spot they are driving to rather than the one they
  cannot shoot from — with patience, because late in a match there may be
  nothing left to fill up with.
- **Nobody parked.** Park is 5 points and it is judged purely on where the
  robot is at the buzzer, so there is no reason to be anywhere else at the end.

Then a flaky test turned up three more, all in the same family: something was
allowed to disturb the AI's driving and nothing checked that the disturbance
made sense.

- **A jam sent the robot back to the drill behaviour.** `jammed ? null :
  biobuzzPlan(...)` meant a robot whose intake seized stopped playing BIOBUZZ
  and started *chasing the player*, which is what the drills do. A seized
  intake is a mechanism failure, not a change of plan, and the guard was
  redundant anyway — the plans already read `agent.jammed` and stop asking for
  intake and shots. A jam in the last second drove a robot that had been
  sitting in its own loading zone 0.85 m out of it and gave up the park.
- **A driver mistake displaced the target a flat 1.2 m**, including for a robot
  already sitting where it meant to be — so a fumble at the buzzer could also
  un-park it. A mistake is a mistake in a *commanded motion*; it now scales
  with how far the robot is being asked to go, so there is nothing to fumble
  when the drive is over.
- **Nothing routed a park around the A-frame.** The park plan returned early,
  above the routing every other plan goes through, so a robot on the far side
  of a frame from its own loading zone drove into the frame and ground there
  until the buzzer.

Fixing the first of those exposed the real one. None of the plans know about
the other three robots — they name a place to be, and the driving is somebody
else's problem — so a robot standing between here and there got *pushed*, for
as long as the plan held. That is a G421 major foul every three seconds, and it
was running at four majors a match, 20 points each. Backing off once the
referee has started counting treats the symptom; the count only pauses when the
robots separate, so anything still counting at three seconds is a foul however
fast the retreat. `Opponent._yieldToTraffic` steers around a robot in the
intended path instead, aiming *past* it rather than out to the side, and
committing to a side for a moment — without either of those it slid out of its
own corridor, found the way clear, re-aimed, and slid back, netting 30 cm
backwards in 13 seconds. A robot that *is* the destination is exempt, which is
what a defender blocking you is doing.

Two bugs in `routeAroundHive` fell out of the same investigation, both of which
could park a robot against a frame for the rest of the match:

- The escape for a robot *inside* a keep-out box moved it 2 cm, which is inside
  the drive controller's deadband, so it crept, fell back in, and was told the
  same thing again. A destination still gets nudged 2 cm — an element resting
  against a foot bar has to stay reachable — but a robot gets 30 cm.
- When the target was past the frames in y, the route took the lane on the
  *target's* side even if the robot was past them on the other side, which is a
  command to drive through the frame being avoided. The lane is now forced to
  the robot's own side whenever it is already clear in y.

Measured over six seeded full matches, that trade is 340 foul points conceded
down to 40, G421 from seven to none, and 7 of 18 robot-slots parking up to 12 —
for about 13% less *earned* scoring, because going around traffic and around
the A-frame costs cycle time that barging through did not. The earned figure is
the honest one to watch: most of the apparent scoring gain from the jam fix
alone was foul credits, since a foul is a credit to the opponent's total.

A flower robot also used to empty the flower it was filling: parked against the
tube with its roller running, `Intake._collect` pulled POLLEN back out of the
bottom. And with fewer than four robots on the field, the unclaimed pre-load
groups were left in limbo — twelve of the forty POLLEN missing from every
practice session, since the roster is off by default. Section 10.3.1 says where
they go: the centre of the loading zone, against the wall.

Every AI drives a full `Robot` through the same subsystems you do — the same
motor curves, the same battery, the same traction, the same `Intake.command`
and `Launcher.fire()`. None of them has a shortcut into the ball world, so an
opponent's shot is subject to the same recovery, droop and aperture as yours,
and beating one is a driving result rather than a difficulty setting.

Two things about the AI are worth knowing because they are physics, not
tuning:

- **The A-frame blocks the middle of the field.** The straight line from one
  side to the other goes through a strut leg, so the AI routes around the frame,
  steers around the other robots, and has a wedge detector for when it gets
  stuck anyway. It is not being
  clever; without it a robot presses itself against a strut at half power for
  the whole match with a full magazine and a clear shot two metres away.
- **There is only a narrow band of legal shooting positions.** A CELL faces
  along the arm and only accepts a *descending* element, so the shot must come
  from outside its opening plane — which puts the furthest usable stand-off at
  about 2.15 m, near the far wall. "Long range" on this field means the far
  corner, not the far wall. A test asserts that every shooting archetype has at
  least one legal spot on both alliances; the catapult failed it once, and not
  for lack of energy — its arm stopped at 72° and the lofted solution at those
  ranges wants 76.

### The opposing alliance's NECTAR

Entering NECTAR is a human action — Section 10.1 gives an alliance one more
each time its HIVE tips, and all of them in the last 60 seconds. Without
somebody doing that for the other side, a third of the point table never
happens in a match against AI: no NECTAR on the field means no FLOWER can be
owned, so a robot built to fill FLOWERS scores nothing and the bottom-NECTAR
bonus never exists. *Match → Other side enters its NECTAR* has their drive team
roll one in every few seconds when they have one available.

Your own alliance's NECTAR stays yours to enter. When to hand it in is a real
decision — early is a G410 violation — and taking it away would be taking away
part of the game.

## What is still a simulation choice

Almost nothing is left inferred, but these are modelling decisions rather than
measurements, and they are the places to look first if something feels wrong:

- **Ball masses** (POLLEN 0.045 kg, NECTAR 0.085 kg) are not published. They
  only affect how far a robot shoves a pile and how the flywheel behaves, not
  scoring.
- **The HIVE's `holdMass`**, and through it `M*h`, calibrated as above, plus its
  structure mass for the inertia. The CELL opening's angle used to be a third
  guess here; Figure 9‑9's two heights removed it, since the opening turns out to
  be perpendicular to the arm.
- **The CELL capture margin** (1.5 in), because the manual defines scoring by
  what is in the CELL at rest, not by a capture volume.
- **Flower stack pitch.** A column of balls in a tube wider than the balls
  zig-zags, giving 2.60 in for POLLEN against their 2.80 in diameter. The CAD
  lays its staged POLLEN out at a flat 2.89 in, which is *wider* than a POLLEN,
  so those balls are not touching — a drawing layout rather than a settled
  stack. It makes no difference to scoring.
- **Intake and launcher geometry** is a plausible robot, not any particular
  robot. Every number is a constructor option so you can put your own in.
- **The FLOWER lift.** G419 says elements enter through the top of the top ring
  and the geometry says a shot cannot, so *something* has to raise one over a
  21.25 in rim. The alignment window (2.5 in), the reach (9 in from the bumper)
  and the cycle time (0.9 s) are a plausible mechanism, not a measured one.
- **The AI's archetypes and build qualities** are the shapes of robot you meet
  at an event, with numbers chosen to make each play differently rather than
  copied from any particular team. The *physics* underneath them is not a
  choice: a catapult really does put speed as `sqrt(2*eta*E/m)`, which is why a
  NECTAR leaves a third slower than a POLLEN, and a twin flywheel really does
  get most of the surface speed into the ball where a single wheel against a
  backplate gets about half.

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
src/field/biobuzz/rules.js       all forty Game Rules, and what the sim does
src/field/biobuzz/Referee.js     the detectors for the eleven live rules
src/robot/biobuzz/Intake.js      roller intake or jaw, and the FLOWER lift
src/robot/biobuzz/Launcher.js    flywheel launcher and the aiming solver
src/robot/biobuzz/Thrower.js     catapult and puncher: energy, not speed
src/robot/biobuzz/launchSystems.js  the launch systems you can be built with
src/ai/archetypes.js             the other robots: scoring systems and builds
src/ai/roster.js                 the three seats, and Random
src/ai/gamePlan.js               what an AI does with the mechanism it has
src/app/BiobuzzGame.js           attaches the game to a running simulation
src/render/textures.js           the perforation mask, generated from hole axes
src/teleop/AutoRunner.js         compiles and steps a pasted AUTO routine
src/teleop/autoApi.js            the `robot` object a routine is handed
src/teleop/autoExample.js        the worked example the editor starts with
src/ui/AutoPanel.js              the editor, its errors and its log
src/net/protocol.js              the wire format, and why it is host-authoritative
src/net/snapshot.js              a live game to a snapshot, and back to a mirror
src/net/NetLink.js               one connection, and a loopback pair for tests
src/net/NetHost.js               seats a joiner on a robot already on the field
src/net/NetClient.js             sends a gamepad, draws what it is told
src/net/roomCode.js              the code alphabet, shared with the relay
src/ui/NetPanel.js               host, join, and is-it-me-or-the-network
tools/websocket.js               an RFC 6455 server, by hand
tools/relay.js                   rooms and roles; forwards every byte unopened
src/ui/MatchPanel.js             clock, score breakdown, shooter readout, line-up
```

Tests: `test/biobuzz.test.js` (field structures), `biobuzz-robot.test.js`
(mechanisms), `biobuzz-match.test.js` (flow and scoring), `biobuzz-game.test.js`
(integration), `biobuzz-rules.test.js` (the audit and every detector),
`ai-roster.test.js` (the other three robots),
`ballphysics.test.js` (contact resolution), `input.test.js` (the bindings). `node tools/check.js` drives the whole thing in headless
Chromium, including firing a shot into the cell through the real physics loop.
