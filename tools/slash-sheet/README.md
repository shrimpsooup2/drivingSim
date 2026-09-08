# Slash sheet

Rebuilds an explosion sprite sheet with the slash animation in place of the
explosion, keeping the sheet's filename, dimensions and frame layout so it can
be dropped straight back in.

```
node tools/slash-sheet/build.js path/to/explosion.png
```

The rebuilt sheet lands in `out/` under the same filename. Add `--in-place` to
overwrite the original instead (keep a copy first), or `--out DIR` to send it
somewhere else.

## The art

The reference screenshot is a filmstrip: five red strokes side by side, one per
frame, playing left to right. The stroke stabs in short, draws out longer over
the next two frames, curls into a hook, then breaks apart into specks.

Those strokes were traced out of the screenshot first, and `slash.js` was then
redrawn from the traces by hand on a 6x25 grid, a sixth of their resolution.
The trace itself could not be used as art on two counts: the screenshot is a
resized JPEG, so its edges carry a pixel of wobble that reads as fuzz, and its
resolution is far finer than pixel art wants. Redrawing on a coarse grid fixes
both — every frame is a stack of solid rectangles, so every edge is a clean
step and every run is deliberate — while keeping each stroke's silhouette, its
steps and its gaps.

At this size a stroke is one or two pixels wide and a speck is a single pixel,
which is the point: on a sheet frame around 530px across, one art pixel lands
about 19px square.

`npm test` pins the per-frame ink counts, so an edit to the rectangles cannot
silently drop or duplicate part of a frame; pins how many pixels stand alone
(frame 5 breaks into specks and two are meant to be single pixels, so a stray
elsewhere shows up as a change); and checks the grid stays coarse enough for
blocks this size.

Colour is `#fd6481`, sampled from the middle of the strokes.

To look at the frames on their own:

```
node tools/slash-sheet/build.js explosion.png --preview out/frames.png --dry-run
```

## Finding the sheet's frames

By default the tool clusters the drawn pixels, widening the bridge between them
until the island count settles on a plateau — no grid assumption, which suits a
sheet whose blobs sit at irregular spacings with empty cells between them.

That only works when the blobs are actually separated. On a tightly packed
atlas they are not: a late frame's dust reaches into its neighbour, and the gaps
*inside* a threadbare ring are as wide as the gaps between frames, so no
bridging distance splits them. The tool says so when it comes back with one
frame. Give it the frame centres instead and it hands every drawn pixel to the
nearest one:

```
node tools/slash-sheet/build.js explosion.png --seeds "300,290 930,290 ..."
node tools/slash-sheet/build.js explosion.png --grid 3x4
```

Centres only need to be closer to their own frame than to any other, so reading
them off the sheet by eye is enough. Each frame's box then clips the outermost
0.5% of its ink, so a few of a neighbour's chunks landing on the wrong side of
the split cannot stretch the box.

### PlayerExplosion_03-uhd.png

That sheet is 1860x1728 and holds ten frames: a 3x3 grid of 620x576 cells for
the top two rows, and four sprites packed across the bottom. Its blobs touch,
so it needs its centres:

```
node tools/slash-sheet/build.js PlayerExplosion_03-uhd.png --seeds \
  "300,290 930,290 1550,290 300,865 930,865 1550,865 230,1470 650,1450 960,1390 1560,1460"
```

## Play order

A blast starts small and solid and ends wide and threadbare, so frames are
sorted by `radius x (1 - density)`: the tight bright ball first, the faint
scattered ring last. On the sheet above that puts the clean green sphere first
and the barely-there ring last, which is the order the explosion plays in.

`--order grid` falls back to plain reading order, `--order grid-reverse`
reverses it, and `--order 3,1,2,...` sets it by hand.

The five slash frames are then spread over however many frames the sheet has —
held for a beat or more when there are more, dropped evenly when there are
fewer — and each is stamped on the blob it replaces, nearest-neighbour scaled.

Every frame lands on one grid. The scale is a whole number of output pixels per
art pixel and is the same for all frames, so the animation does not pulse as it
plays; and each frame's corner is snapped to a whole number of art pixels from
the sheet's origin, so the frames share a phase as well as a block size.
Without that snap a frame is centred exactly on its blob and lands on a lattice
of its own — blocks the right size, but offset from its neighbours' by part of
a block, which is enough to stop the sheet reading as pixel art. Snapping moves
a frame by less than half a block, nothing against a frame ~500px across.
`npm test` checks it: on a rebuilt sheet every run of ink both starts and ends
on the grid.

Nothing is guessed silently: the run prints every frame it found, with its box,
centre, ink count and density, and which slash frame was assigned to it. Check
that table before trusting the output; `--dry-run` prints it without writing.

## Options

| Option | Meaning |
| --- | --- |
| `--out DIR` | Where to write, keeping the source filename (default `out`) |
| `--in-place` | Overwrite the source sheet |
| `--order MODE` | `stage` (default), `grid`, `grid-reverse`, or `3,1,2,...` |
| `--fit FRACTION` | Slash size as a fraction of a frame's box (default `0.9`) |
| `--scale N` | Force N output pixels per art pixel, ignoring `--fit` |
| `--gap FRACTION` | Force the blob bridging distance (default: worked out from the sheet) |
| `--seeds LIST` | Split by nearest frame centre: `"x,y x,y ..."` or a file of the same |
| `--grid CxR` | Split by a plain C x R grid of frame centres |
| `--preview PATH` | Also write a contact sheet of the five frames alone |
| `--dry-run` | Report what was found without writing the sheet |

If two blobs are merged into one frame, lower `--gap` or switch to `--seeds`;
if one blob is split into two, raise `--gap`.
