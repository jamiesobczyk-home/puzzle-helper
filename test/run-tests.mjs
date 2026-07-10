// Node test suite for the DOM-free core (matching + segmentation).
// Run with:  node test/run-tests.mjs
import assert from 'node:assert/strict';
import { estimateGrid, matchPiece, gridPosition, rotatePatch } from '../js/matching.js';
import { segmentPieces, extractPatch } from '../js/segmentation.js';

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`ok - ${name}`);
  } catch (err) {
    console.error(`FAIL - ${name}`);
    console.error(err);
    process.exitCode = 1;
  }
}

function mulberry32(seed) {
  return () => {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// A busy synthetic "box art": smooth gradients plus random blobs, so every
// region is visually distinct (like a real puzzle picture).
function makeRef(w, h, seed) {
  const rand = mulberry32(seed);
  const data = new Float32Array(w * h * 3);
  const blobs = [];
  for (let i = 0; i < 90; i++) {
    blobs.push({
      x: rand() * w, y: rand() * h, r: 4 + rand() * 20,
      c: [rand(), rand(), rand()],
    });
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 3;
      data[i] = 0.2 + 0.6 * (x / w);
      data[i + 1] = 0.2 + 0.6 * (y / h);
      data[i + 2] = 0.5 + 0.4 * Math.sin((x + y) / 23);
      for (const b of blobs) {
        const dx = x - b.x, dy = y - b.y;
        if (dx * dx + dy * dy < b.r * b.r) {
          data[i] = b.c[0]; data[i + 1] = b.c[1]; data[i + 2] = b.c[2];
        }
      }
    }
  }
  return { width: w, height: h, data };
}

// Cut a round-masked patch out of the reference, optionally upscaled with
// noise, mimicking a photographed piece.
function cutPatch(ref, cx, cy, radius, upscale, noise, seed) {
  const rand = mulberry32(seed);
  const size = Math.round(radius * 2 * upscale);
  const data = new Float32Array(size * size * 3);
  const mask = new Uint8Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (x + 0.5) / upscale - radius;
      const dy = (y + 0.5) / upscale - radius;
      if (dx * dx + dy * dy > radius * radius) continue;
      const sx = Math.max(0, Math.min(ref.width - 1, Math.round(cx + dx)));
      const sy = Math.max(0, Math.min(ref.height - 1, Math.round(cy + dy)));
      const si = (sy * ref.width + sx) * 3;
      const di = (y * size + x) * 3;
      for (let c = 0; c < 3; c++) {
        data[di + c] = Math.max(0, Math.min(1,
          ref.data[si + c] + (rand() - 0.5) * noise));
      }
      mask[y * size + x] = 1;
    }
  }
  return { width: size, height: size, data, mask };
}

test('estimateGrid gives sensible dimensions', () => {
  const g = estimateGrid(500, 4 / 3);
  assert.ok(g.cols >= 22 && g.cols <= 30, `cols=${g.cols}`);
  assert.ok(Math.abs(g.cols * g.rows - 500) < 60, `total=${g.cols * g.rows}`);
  const sq = estimateGrid(100, 1);
  assert.equal(sq.cols, 10);
  assert.equal(sq.rows, 10);
});

test('gridPosition maps centres to rows/columns', () => {
  assert.deepEqual(gridPosition(5, 5, 100, 80, 10, 8), { row: 1, col: 1 });
  assert.deepEqual(gridPosition(95, 75, 100, 80, 10, 8), { row: 8, col: 10 });
  assert.deepEqual(gridPosition(55, 45, 100, 80, 10, 8), { row: 5, col: 6 });
});

test('rotatePatch by 90 degrees preserves content', () => {
  const p = {
    width: 2, height: 1,
    data: new Float32Array([1, 0, 0, /**/ 0, 1, 0]),
    mask: new Uint8Array([1, 1]),
  };
  const r = rotatePatch(p, Math.PI / 2);
  assert.equal(r.width, 1);
  assert.equal(r.height, 2);
  const px = [];
  for (let i = 0; i < r.width * r.height; i++) {
    if (r.mask[i]) px.push([r.data[i * 3], r.data[i * 3 + 1], r.data[i * 3 + 2]]);
  }
  assert.equal(px.length, 2);
  // both original colours survive the rotation
  assert.ok(px.some((c) => c[0] === 1 && c[1] === 0));
  assert.ok(px.some((c) => c[0] === 0 && c[1] === 1));
});

test('matchPiece finds an unrotated piece', () => {
  const ref = makeRef(240, 180, 7);
  const truth = { x: 171, y: 62 };
  const patch = cutPatch(ref, truth.x, truth.y, 11, 3, 0.06, 42);
  const cands = matchPiece(ref, patch, { pieceSizePx: 24, angleStepDeg: 90, topK: 3 });
  assert.ok(cands.length > 0, 'no candidates');
  const best = cands[0];
  const dist = Math.hypot(best.cx - truth.x, best.cy - truth.y);
  assert.ok(dist < 6, `off by ${dist.toFixed(1)}px (got ${best.cx},${best.cy})`);
  assert.equal(best.angleDeg, 0);
  assert.ok(best.score > 0.7, `weak score ${best.score.toFixed(2)}`);
});

test('matchPiece finds a rotated piece and reports the rotation', () => {
  const ref = makeRef(240, 180, 7);
  const truth = { x: 60, y: 120 };
  let patch = cutPatch(ref, truth.x, truth.y, 11, 3, 0.05, 43);
  patch = rotatePatch(patch, Math.PI / 2); // piece lies rotated 90° CCW
  const cands = matchPiece(ref, patch, { pieceSizePx: 24, angleStepDeg: 90, topK: 3 });
  assert.ok(cands.length > 0, 'no candidates');
  const best = cands[0];
  const dist = Math.hypot(best.cx - truth.x, best.cy - truth.y);
  assert.ok(dist < 6, `off by ${dist.toFixed(1)}px (got ${best.cx},${best.cy})`);
  assert.equal(best.angleDeg, 270, `angle ${best.angleDeg}`);
  assert.ok(best.score > 0.7, `weak score ${best.score.toFixed(2)}`);
});

test('matchPiece handles size mismatch via scale search', () => {
  const ref = makeRef(240, 180, 9);
  const truth = { x: 120, y: 90 };
  const patch = cutPatch(ref, truth.x, truth.y, 13, 3, 0.05, 44);
  // tell the matcher the piece is ~20px when it is really ~26px
  const cands = matchPiece(ref, patch, { pieceSizePx: 20, angleStepDeg: 90, topK: 3 });
  const best = cands[0];
  const dist = Math.hypot(best.cx - truth.x, best.cy - truth.y);
  assert.ok(dist < 8, `off by ${dist.toFixed(1)}px`);
});

test('segmentPieces detects pieces on a plain background', () => {
  const w = 200, h = 120;
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    data[i * 4] = 210; data[i * 4 + 1] = 205; data[i * 4 + 2] = 198; data[i * 4 + 3] = 255;
  }
  const paint = (x0, y0, x1, y1, r, g, b) => {
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const i = (y * w + x) * 4;
        data[i] = r; data[i + 1] = g; data[i + 2] = b;
      }
    }
  };
  paint(20, 20, 55, 60, 40, 90, 160);   // piece 1
  paint(120, 50, 170, 95, 160, 60, 40); // piece 2
  const img = { width: w, height: h, data };
  const pieces = segmentPieces(img);
  assert.equal(pieces.length, 2, `found ${pieces.length}`);
  // largest first
  assert.ok(pieces[0].area >= pieces[1].area);
  const p2 = pieces.find((p) => p.x0 > 100);
  assert.ok(p2, 'right-hand piece missing');
  assert.ok(Math.abs(p2.x0 - 120) <= 2 && Math.abs(p2.y1 - 95) <= 2,
    `bbox ${p2.x0},${p2.y0}-${p2.x1},${p2.y1}`);
  const patch = extractPatch(img, p2);
  assert.equal(patch.width, p2.x1 - p2.x0 + 1);
  // a masked pixel should carry the painted colour
  const mid = (Math.floor(patch.height / 2) * patch.width + Math.floor(patch.width / 2));
  assert.ok(patch.mask[mid] === 1);
  assert.ok(Math.abs(patch.data[mid * 3] - 160 / 255) < 0.02);
});

test('segmentPieces copes with a noisy, textured background', () => {
  // e.g. a wooden table: per-pixel noise everywhere, not clean paper
  const rand = mulberry32(77);
  const w = 220, h = 140;
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    const n = () => (rand() - 0.5) * 80;
    data[i * 4] = 168 + n(); data[i * 4 + 1] = 132 + n(); data[i * 4 + 2] = 96 + n();
    data[i * 4 + 3] = 255;
  }
  for (let y = 40; y <= 95; y++) {
    for (let x = 60; x <= 120; x++) {
      const i = (y * w + x) * 4;
      data[i] = 100; data[i + 1] = 90; data[i + 2] = 60; // darker wood-ish piece
    }
  }
  const pieces = segmentPieces({ width: w, height: h, data });
  assert.equal(pieces.length, 1, `found ${pieces.length}`);
  assert.ok(Math.abs(pieces[0].x0 - 60) <= 3 && Math.abs(pieces[0].y1 - 95) <= 3,
    `bbox ${pieces[0].x0},${pieces[0].y0}-${pieces[0].x1},${pieces[0].y1}`);
});

test('segmentPieces retries at a lower threshold for low-contrast pieces', () => {
  // piece colour sits close to the background: first pass finds nothing,
  // the retry pass should still pick it up
  const rand = mulberry32(78);
  const w = 200, h = 120;
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    const n = () => (rand() - 0.5) * 8;
    data[i * 4] = 210 + n(); data[i * 4 + 1] = 205 + n(); data[i * 4 + 2] = 198 + n();
    data[i * 4 + 3] = 255;
  }
  for (let y = 30; y <= 80; y++) {
    for (let x = 50; x <= 110; x++) {
      const i = (y * w + x) * 4;
      data[i] = 228; data[i + 1] = 193; data[i + 2] = 212; // subtle pink piece
    }
  }
  const pieces = segmentPieces({ width: w, height: h, data });
  assert.equal(pieces.length, 1, `found ${pieces.length}`);
  assert.ok(Math.abs(pieces[0].x0 - 50) <= 3 && Math.abs(pieces[0].y0 - 30) <= 3,
    `bbox ${pieces[0].x0},${pieces[0].y0}-${pieces[0].x1},${pieces[0].y1}`);
});

test('segmentPieces ignores a mat edge crossing the frame border', () => {
  // modelled on a real failure: cream piece on a brown board, with the blue
  // edge of the puzzle mat visible along the bottom of the photo
  const rand = mulberry32(79);
  const w = 240, h = 180;
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    const n = () => (rand() - 0.5) * 24;
    data[i * 4] = 128 + n(); data[i * 4 + 1] = 109 + n(); data[i * 4 + 2] = 101 + n();
    data[i * 4 + 3] = 255;
  }
  const paint = (x0, y0, x1, y1, r, g, b) => {
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const i = (y * w + x) * 4;
        data[i] = r; data[i + 1] = g; data[i + 2] = b;
      }
    }
  };
  paint(0, 160, w - 1, h - 1, 30, 90, 140);   // blue mat edge, full width
  paint(80, 50, 150, 110, 235, 228, 205);     // cream piece
  const pieces = segmentPieces({ width: w, height: h, data });
  assert.equal(pieces.length, 1, `found ${pieces.length}`);
  assert.ok(Math.abs(pieces[0].x0 - 80) <= 3 && Math.abs(pieces[0].y0 - 50) <= 3,
    `bbox ${pieces[0].x0},${pieces[0].y0}-${pieces[0].x1},${pieces[0].y1}`);
});

test('segmentPieces fills false holes where print matches the background', () => {
  const w = 200, h = 120;
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    data[i * 4] = 210; data[i * 4 + 1] = 205; data[i * 4 + 2] = 198; data[i * 4 + 3] = 255;
  }
  const paint = (x0, y0, x1, y1, r, g, b) => {
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const i = (y * w + x) * 4;
        data[i] = r; data[i + 1] = g; data[i + 2] = b;
      }
    }
  };
  paint(50, 30, 130, 90, 40, 90, 160);        // piece
  paint(75, 50, 105, 70, 210, 205, 198);      // printed area == background colour
  const pieces = segmentPieces({ width: w, height: h, data });
  assert.equal(pieces.length, 1, `found ${pieces.length}`);
  const p = pieces[0];
  const bw = p.x1 - p.x0 + 1;
  // the hole must be part of the mask (centre of the painted-over region)
  const hx = 90 - p.x0, hy = 60 - p.y0;
  assert.equal(p.mask[hy * bw + hx], 1, 'hole not filled');
});

test('watershed refinement recovers camouflaged piece regions', () => {
  // A piece whose right side is printed in the exact background colour.
  // The colour threshold can never keep it — the only cue is the faint
  // physical edge line (below threshold, but a gradient ridge) and the
  // fact that the printed transition inside the piece is soft.
  const w = 240, h = 140;
  const data = new Uint8ClampedArray(w * h * 4);
  const set = (x, y, r, g, b) => {
    const i = (y * w + x) * 4;
    data[i] = r; data[i + 1] = g; data[i + 2] = b; data[i + 3] = 255;
  };
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) set(x, y, 210, 205, 198);
  const px0 = 50, py0 = 30, px1 = 179, py1 = 109; // piece 130x80
  for (let y = py0; y <= py1; y++) {
    for (let x = px0; x <= px1; x++) {
      const t = Math.min(1, Math.max(0, (x - (px0 + 55)) / 30)); // soft blend
      set(x, y,
        Math.round(40 + (210 - 40) * t),
        Math.round(90 + (205 - 90) * t),
        Math.round(160 + (198 - 160) * t));
    }
  }
  // faint physical edge line: 2px ring, below the colour threshold
  for (let y = py0 - 2; y <= py1 + 2; y++) {
    for (let x = px0 - 2; x <= px1 + 2; x++) {
      if (x >= px0 && x <= px1 && y >= py0 && y <= py1) continue;
      set(x, y, 196, 191, 184);
    }
  }
  const pieces = segmentPieces({ width: w, height: h, data });
  assert.equal(pieces.length, 1, `found ${pieces.length}`);
  const p = pieces[0];
  const bw = p.x1 - p.x0 + 1;
  // centre of the camouflaged right side must be part of the mask
  const cx = 160 - p.x0, cy = 70 - p.y0;
  assert.ok(cx >= 0 && cx < bw, `bbox lost the right side: ${p.x0}-${p.x1}`);
  assert.equal(p.mask[cy * bw + cx], 1, 'camouflaged region not recovered');
});

test('segmentation + matching end to end', () => {
  // build a photo: grey background with one piece cut from the reference
  const ref = makeRef(240, 180, 11);
  const truth = { x: 90, y: 60 };
  const cut = cutPatch(ref, truth.x, truth.y, 12, 2, 0.04, 45);
  const w = 160, h = 120;
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    data[i * 4] = 215; data[i * 4 + 1] = 212; data[i * 4 + 2] = 205; data[i * 4 + 3] = 255;
  }
  const ox = 50, oy = 30;
  for (let y = 0; y < cut.height; y++) {
    for (let x = 0; x < cut.width; x++) {
      if (!cut.mask[y * cut.width + x]) continue;
      const i = ((y + oy) * w + (x + ox)) * 4;
      data[i] = cut.data[(y * cut.width + x) * 3] * 255;
      data[i + 1] = cut.data[(y * cut.width + x) * 3 + 1] * 255;
      data[i + 2] = cut.data[(y * cut.width + x) * 3 + 2] * 255;
    }
  }
  const photo = { width: w, height: h, data };
  const pieces = segmentPieces(photo);
  assert.equal(pieces.length, 1, `found ${pieces.length} pieces`);
  const patch = extractPatch(photo, pieces[0]);
  const cands = matchPiece(ref, patch, { pieceSizePx: 26, angleStepDeg: 90, topK: 3 });
  const best = cands[0];
  const dist = Math.hypot(best.cx - truth.x, best.cy - truth.y);
  assert.ok(dist < 8, `off by ${dist.toFixed(1)}px (got ${best.cx},${best.cy})`);
});

console.log(`\n${passed} test(s) passed${process.exitCode ? ', with failures' : ''}.`);
