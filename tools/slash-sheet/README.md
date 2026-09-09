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

## Use the plist if there is one

A packed sheet normally ships with a `.plist` beside it, and it settles by
itself everything the pixels only hint at:

```
node tools/slash-sheet/build.js PlayerExplosion_03-uhd.png \
  --plist PlayerExplosion_03-uhd.plist --repack
```

It names every frame (so their order is the packer's counter, not a guess),
gives each one's rectangle, and records two things no amount of looking at the
PNG will tell you:

- **Rotation.** To save space the packer stores some sprites turned 90 degrees
  clockwise, flagged `textureRotated`, and the engine turns them back when it
  draws. A frame's `spriteSize` is always the upright size, so a rotated frame
  occupies *height by width* in the texture. Art written into one of those
  slots without being turned clockwise on the way in comes out on its side in
  game — half the frames of `PlayerExplosion_03-uhd` are packed this way.
- **Trimming.** Each sprite was cropped to its own drawn pixels, so the frames
  are different sizes; `spriteSourceSize` is the untrimmed size they share and
  `spriteOffset` says where the crop sat inside it. That untrimmed canvas, not
  the texture, is the space the animation plays in, so it is the space to lay
  art out in.

`--repack` rewrites the plist as well as the sheet: it lays every frame out
fresh, upright and trimmed to the slash instead of to the blast it replaces.
That is worth doing on both counts. Nothing is rotated, so there is no rotation
left to get the wrong way round; and the art is no longer capped by the
smallest of the old crops, which on this sheet is a 254x250 rectangle that
would have held the art to 16px pixels. Repacked, they are 25px.

What `--repack` does not change is what the engine keys off: the frame names,
their order, the untrimmed canvas size and the sheet's dimensions. Each frame's
`spriteOffset` is recomputed so it still lands where it should.

Without `--repack` the existing rectangles and rotation flags are honoured
exactly, which is the safer choice if something else depends on the current
layout.

### Checking it

```
--verify out/ingame.png
```

writes a filmstrip of the frames rebuilt the way the engine will rebuild them:
rotation undone, each dropped back onto its untrimmed canvas. It is the only
view in which a frame stored the wrong way round, or clipped by its own crop,
is obvious. Run it against the *original* sheet and you should get a clean
animation — on `PlayerExplosion_03-uhd` a green ball that bursts, throws debris
and fades. If that comes out right, the geometry is right.

## Finding the frames without a plist

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
| `--plist FILE` | Take frame order, rectangles and rotation from the sheet's plist |
| `--repack` | Rewrite the plist too: frames laid out fresh, upright, trimmed to the art |
| `--verify PATH` | Write a filmstrip of the frames as the engine will rebuild them |
| `--seeds LIST` | Split by nearest frame centre: `"x,y x,y ..."` or a file of the same |
| `--grid CxR` | Split by a plain C x R grid of frame centres |
| `--preview PATH` | Also write a contact sheet of the five frames alone |
| `--dry-run` | Report what was found without writing the sheet |

If two blobs are merged into one frame, lower `--gap` or switch to `--seeds`;
if one blob is split into two, raise `--gap`.
