# Slash sheet

Rebuilds an explosion sprite sheet with the slash effect in place of the
explosion, keeping the sheet's filename, dimensions and frame layout so it can
be dropped straight back in.

```
node tools/slash-sheet/build.js path/to/explosion.png
```

The rebuilt sheet lands in `out/` under the same filename. Add `--in-place` to
overwrite the original instead (keep a copy first), or `--out DIR` to send it
somewhere else.

## What it does

1. **Finds the frames.** The sheet is not a tidy grid — the blobs sit at
   irregular spacings, some cells are empty, and each blob is a scatter of
   chunks and specks. So rather than assuming a grid it clusters the drawn
   pixels, widening the bridge between them until the island count settles on
   a plateau. That plateau is the frame count.
2. **Works out the play order.** A blast starts small and solid and ends wide
   and threadbare, so frames are sorted by `radius x (1 - density)`: the tight
   bright ball first, the faint scattered ring last. `--order grid` falls back
   to plain reading order, and `--order 3,1,2,...` sets it by hand.
3. **Spreads the slash over those frames.** The slash has eight authored
   stages; sheets usually have more frames than that, so stages are held for a
   frame or more (and dropped evenly if a sheet has fewer). The first frame is
   always stage 1 and the last is always the final stage.
4. **Stamps each stage** centred on the blob it replaces, nearest-neighbour
   scaled so the art stays crisp. One fixed scale is used for every frame, so
   the effect does not pulse as it plays — only its position follows the sheet.

Nothing is guessed silently: the run prints every frame it found, with its box,
centre, ink count and density, and which stage was assigned to it. Check that
table before trusting the output; `--dry-run` prints it without writing.

## Checking the art

```
node tools/slash-sheet/build.js explosion.png --preview out/stages.png --dry-run
```

writes a contact sheet of the eight stages on their own.

## Options

| Option | Meaning |
| --- | --- |
| `--out DIR` | Where to write, keeping the source filename (default `out`) |
| `--in-place` | Overwrite the source sheet |
| `--order MODE` | `stage` (default), `grid`, `grid-reverse`, or `3,1,2,...` |
| `--fit FRACTION` | Slash width as a fraction of a frame's width (default `0.9`) |
| `--scale N` | Force N output pixels per art pixel, ignoring `--fit` |
| `--gap FRACTION` | Force the blob bridging distance (default: worked out from the sheet) |
| `--preview PATH` | Also write a contact sheet of the stages alone |
| `--dry-run` | Report what was found without writing the sheet |

If two blobs are merged into one frame, lower `--gap`; if one blob is split
into two, raise it.

## The art

`slash.js` holds the effect as vertical runs on a 28x22 grid, one list per
stage, in a single flat rose-pink. Stage 4 is the pose from the reference
screenshot — four streaks of increasing length, a hook curling right, a chevron
of specks trailing off. The stages before it draw that pose in; the stages
after it let the curtain drop and eat it away from the top. Edit the run lists
to change the art; `npm test` checks the stages stay on the grid and that the
ordering never runs backwards.
