# Puzzle Piece Finder

A small web app that helps you put jigsaw puzzles together. Show it a photo
of the box art (or the example page from inside the box), then photograph one
or more loose pieces, and it tells you where each piece belongs — row and
column from the top-left corner, plus how much to rotate it.

Everything runs client-side in the browser. No server, no build step, and no
photos ever leave the device, so it works fine from a phone at the puzzle
table.

## Using it

Serve the folder with any static file server and open it in a browser:

```
python3 -m http.server 8000
# then open http://localhost:8000/
```

(A plain `file://` open won't work because the app uses a module Web Worker.)

1. **Box picture** — take/choose a photo of the puzzle image. Drag on it to
   crop away everything that isn't the puzzle picture; tight crops matter.
   Enter the piece count printed on the box (used to estimate the grid).
2. **Pieces** — lay pieces picture-side up on a plain, contrasting background
   (a sheet of paper works well) and take a photo. The app finds each piece
   automatically; tap a detection to exclude it. You can add several photos.
3. **Find placements** — each piece gets a numbered, colour-coded marker on
   the box picture and a text answer like
   *"Row 3 from the top, column 5 from the left. Rotate about 90° clockwise."*
   Lower-confidence alternatives are listed too.

There's a **Try a demo instead** button that generates a synthetic box
picture and three cut-out pieces so you can see the whole flow without
photographing anything.

## Tips for good matches

- Crop the box photo to exactly the puzzle image, square-on if possible.
- Photograph pieces on a plain background with even light and no shadows.
- Enter the real piece count from the box — it sets the expected piece size.
- Pieces from busy, colourful areas match reliably; pieces from large flat
  areas (plain sky, solid colours) are genuinely ambiguous and will come back
  with low confidence and several alternatives.

## How it works

- `js/segmentation.js` — estimates the background colour from the photo
  border, thresholds it away, cleans the mask with morphological open/close,
  and extracts each connected component as a piece with its own mask.
- `js/matching.js` — masked, mean-normalised cross-correlation of each piece
  against the box image, searched over 12 rotations and 3 scales,
  coarse-to-fine (half-resolution scan, then full-resolution refinement).
  NCC is invariant to per-channel brightness/contrast shifts, which absorbs
  most of the lighting difference between the box photo and the piece photo.
- `js/worker.js` — runs matching in a module Web Worker so the UI stays
  responsive; a progress bar tracks the search.
- `js/app.js` — the UI: image loading, crop tool, piece thumbnails, result
  rendering with grid overlay and markers.

The core (`matching.js`, `segmentation.js`) is DOM-free and shared between
the browser and the Node test suite.

## Tests

```
node test/run-tests.mjs
```

Covers grid estimation, rotation, segmentation, and end-to-end
synthetic-image matching (including rotated pieces and wrong-size-estimate
recovery).

## Limitations

- Matching is appearance-based, not shape-based: it compares the picture on
  the piece with the box art. Uniform regions (sky, solid borders) can't be
  localised from appearance alone.
- The grid answer ("row 3, column 5") assumes a roughly regular grid-cut
  puzzle; for irregular cuts, use the visual marker instead.
- Piece photos should have the piece picture-side up and reasonably flat.
