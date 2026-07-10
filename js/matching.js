// Core matching logic. DOM-free so it runs in a Web Worker and in Node tests.
//
// Image  = { width, height, data: Float32Array(w*h*3) }  RGB interleaved, 0..1
// Patch  = Image + { mask: Uint8Array(w*h) }  1 = piece pixel, 0 = background

export function estimateGrid(pieceCount, aspect) {
  // aspect = reference width / height
  const cols = Math.max(1, Math.round(Math.sqrt(pieceCount * aspect)));
  const rows = Math.max(1, Math.round(pieceCount / cols));
  return { cols, rows };
}

export function resizeImage(img, newW, newH) {
  newW = Math.max(1, Math.round(newW));
  newH = Math.max(1, Math.round(newH));
  const out = new Float32Array(newW * newH * 3);
  const mask = img.mask ? new Uint8Array(newW * newH) : null;
  const sx = img.width / newW;
  const sy = img.height / newH;
  for (let y = 0; y < newH; y++) {
    const srcY = Math.min(img.height - 1, (y + 0.5) * sy - 0.5);
    const y0 = Math.max(0, Math.floor(srcY));
    const y1 = Math.min(img.height - 1, y0 + 1);
    const fy = srcY - y0;
    for (let x = 0; x < newW; x++) {
      const srcX = Math.min(img.width - 1, (x + 0.5) * sx - 0.5);
      const x0 = Math.max(0, Math.floor(srcX));
      const x1 = Math.min(img.width - 1, x0 + 1);
      const fx = srcX - x0;
      const o = (y * newW + x) * 3;
      for (let c = 0; c < 3; c++) {
        const p00 = img.data[(y0 * img.width + x0) * 3 + c];
        const p01 = img.data[(y0 * img.width + x1) * 3 + c];
        const p10 = img.data[(y1 * img.width + x0) * 3 + c];
        const p11 = img.data[(y1 * img.width + x1) * 3 + c];
        out[o + c] =
          p00 * (1 - fx) * (1 - fy) +
          p01 * fx * (1 - fy) +
          p10 * (1 - fx) * fy +
          p11 * fx * fy;
      }
      if (mask) {
        // nearest-neighbour for the mask, slightly eroded by requiring the
        // nearest source pixel to be inside the piece
        const nx = Math.min(img.width - 1, Math.round(srcX));
        const ny = Math.min(img.height - 1, Math.round(srcY));
        mask[y * newW + x] = img.mask[ny * img.width + nx];
      }
    }
  }
  const res = { width: newW, height: newH, data: out };
  if (mask) res.mask = mask;
  return res;
}

export function rotatePatch(patch, angleRad) {
  const cos = Math.cos(angleRad);
  const sin = Math.sin(angleRad);
  const w = patch.width;
  const h = patch.height;
  const newW = Math.max(1, Math.ceil(Math.abs(w * cos) + Math.abs(h * sin) - 1e-6));
  const newH = Math.max(1, Math.ceil(Math.abs(w * sin) + Math.abs(h * cos) - 1e-6));
  const out = new Float32Array(newW * newH * 3);
  const mask = new Uint8Array(newW * newH);
  const cxNew = newW / 2;
  const cyNew = newH / 2;
  const cxOld = w / 2;
  const cyOld = h / 2;
  for (let y = 0; y < newH; y++) {
    for (let x = 0; x < newW; x++) {
      // inverse rotation to sample source
      const dx = x + 0.5 - cxNew;
      const dy = y + 0.5 - cyNew;
      const sx = cos * dx + sin * dy + cxOld - 0.5;
      const sy = -sin * dx + cos * dy + cyOld - 0.5;
      const ix = Math.round(sx);
      const iy = Math.round(sy);
      if (ix < 0 || iy < 0 || ix >= w || iy >= h) continue;
      const si = iy * w + ix;
      if (patch.mask && !patch.mask[si]) continue;
      const o = (y * newW + x) * 3;
      out[o] = patch.data[si * 3];
      out[o + 1] = patch.data[si * 3 + 1];
      out[o + 2] = patch.data[si * 3 + 2];
      mask[y * newW + x] = 1;
    }
  }
  return { width: newW, height: newH, data: out, mask };
}

// Precompute the sparse list of masked pixels of a patch, with per-channel
// mean subtracted, so the NCC inner loop touches only piece pixels.
function preparePatch(patch) {
  const idx = [];
  const w = patch.width;
  for (let i = 0; i < w * patch.height; i++) {
    if (!patch.mask || patch.mask[i]) idx.push(i);
  }
  const n = idx.length;
  const offX = new Int32Array(n);
  const offY = new Int32Array(n);
  const vals = new Float32Array(n * 3);
  const mean = [0, 0, 0];
  for (let k = 0; k < n; k++) {
    for (let c = 0; c < 3; c++) mean[c] += patch.data[idx[k] * 3 + c];
  }
  for (let c = 0; c < 3; c++) mean[c] /= n;
  let varSum = 0;
  for (let k = 0; k < n; k++) {
    offX[k] = idx[k] % w;
    offY[k] = (idx[k] - offX[k]) / w;
    for (let c = 0; c < 3; c++) {
      const v = patch.data[idx[k] * 3 + c] - mean[c];
      vals[k * 3 + c] = v;
      varSum += v * v;
    }
  }
  const norm = Math.sqrt(varSum);
  return { n, offX, offY, vals, norm, width: patch.width, height: patch.height };
}

// Masked, mean-normalized cross-correlation of a prepared patch against the
// reference at every (strided) position inside `region`. Returns candidates
// sorted by score, best first.
function nccSearch(ref, prep, stride, region, maxResults) {
  const { n, offX, offY, vals } = prep;
  if (n < 8 || prep.norm < 1e-6) return [];
  const x0 = Math.max(0, region ? region.x0 : 0);
  const y0 = Math.max(0, region ? region.y0 : 0);
  const x1 = Math.min(ref.width - prep.width, region ? region.x1 : ref.width);
  const y1 = Math.min(ref.height - prep.height, region ? region.y1 : ref.height);
  const results = [];
  const rd = ref.data;
  const rw = ref.width;
  for (let py = y0; py <= y1; py += stride) {
    for (let px = x0; px <= x1; px += stride) {
      let sr = 0, sg = 0, sb = 0;
      for (let k = 0; k < n; k++) {
        const ri = ((py + offY[k]) * rw + (px + offX[k])) * 3;
        sr += rd[ri];
        sg += rd[ri + 1];
        sb += rd[ri + 2];
      }
      const mr = sr / n, mg = sg / n, mb = sb / n;
      let cross = 0, refVar = 0;
      for (let k = 0; k < n; k++) {
        const ri = ((py + offY[k]) * rw + (px + offX[k])) * 3;
        const dr = rd[ri] - mr;
        const dg = rd[ri + 1] - mg;
        const db = rd[ri + 2] - mb;
        cross += dr * vals[k * 3] + dg * vals[k * 3 + 1] + db * vals[k * 3 + 2];
        refVar += dr * dr + dg * dg + db * db;
      }
      const denom = prep.norm * Math.sqrt(refVar);
      const score = denom > 1e-6 ? cross / denom : 0;
      results.push({ x: px, y: py, score });
    }
  }
  results.sort((a, b) => b.score - a.score);
  return maxResults ? results.slice(0, maxResults) : results;
}

function nonMaxSuppress(cands, minDist, topK) {
  const kept = [];
  for (const c of cands) {
    let clash = false;
    for (const k of kept) {
      const dx = c.cx - k.cx;
      const dy = c.cy - k.cy;
      if (dx * dx + dy * dy < minDist * minDist) { clash = true; break; }
    }
    if (!clash) kept.push(c);
    if (kept.length >= topK) break;
  }
  return kept;
}

// Match one piece patch against the reference image.
//
// ref          Image (already downscaled; ~400-600px max dim is a good size)
// patch        Patch at its source resolution
// opts.pieceSizePx  expected size (max dim) of the piece inside ref, in px
// opts.angleStepDeg rotation search step (default 30)
// opts.scaleSpread  relative scales to try around pieceSizePx (default [0.85, 1, 1.18])
// opts.topK         number of candidates to return (default 3)
// opts.onProgress   optional callback(fractionDone)
//
// Returns [{ x, y, cx, cy, score, angleDeg, sizePx, width, height }] best first;
// cx/cy are the centre of the matched window in ref pixel coordinates.
export function matchPiece(ref, patch, opts = {}) {
  const pieceSizePx = opts.pieceSizePx || Math.max(8, Math.round(ref.width / 12));
  const angleStep = opts.angleStepDeg || 30;
  const scales = opts.scaleSpread || [0.85, 1, 1.18];
  const topK = opts.topK || 3;
  const angles = [];
  for (let a = 0; a < 360; a += angleStep) angles.push(a);

  // Coarse-to-fine: scan a half-resolution reference first, then refine the
  // hits at full resolution. Skip the coarse level for tiny pieces, where
  // halving would destroy too much detail.
  const useCoarse = pieceSizePx >= 16;
  const refCoarse = useCoarse
    ? resizeImage(ref, ref.width / 2, ref.height / 2)
    : ref;

  const all = [];
  const total = scales.length * angles.length;
  let done = 0;
  for (const s of scales) {
    const target = Math.max(6, Math.round(pieceSizePx * s));
    const f = target / Math.max(patch.width, patch.height);
    const scaled = resizeImage(patch, patch.width * f, patch.height * f);
    for (const a of angles) {
      const rot = a === 0 ? scaled : rotatePatch(scaled, (a * Math.PI) / 180);
      if (rot.width >= ref.width || rot.height >= ref.height) { done++; continue; }
      const prep = preparePatch(rot);
      let coarse;
      if (useCoarse) {
        const half = resizeImage(rot, rot.width / 2, rot.height / 2);
        const prepHalf = preparePatch(half);
        const stride = Math.max(1, Math.round(target / 2 / 6));
        coarse = nccSearch(refCoarse, prepHalf, stride, null, 4)
          .map((c) => ({ x: c.x * 2, y: c.y * 2, score: c.score, pad: stride * 2 + 2 }));
      } else {
        const stride = Math.max(1, Math.round(target / 6));
        coarse = nccSearch(ref, prep, stride, null, 6)
          .map((c) => ({ ...c, pad: stride }));
      }
      // refine each coarse hit at full resolution: stride 3 across the
      // uncertainty window, then stride 1 around the best of those
      for (const c of coarse) {
        const mid = nccSearch(ref, prep, 3, {
          x0: c.x - c.pad, y0: c.y - c.pad,
          x1: c.x + c.pad, y1: c.y + c.pad,
        }, 1)[0] || c;
        const r = nccSearch(ref, prep, 1, {
          x0: mid.x - 2, y0: mid.y - 2,
          x1: mid.x + 2, y1: mid.y + 2,
        }, 1)[0] || mid;
        all.push({
          x: r.x, y: r.y,
          cx: r.x + rot.width / 2,
          cy: r.y + rot.height / 2,
          width: rot.width, height: rot.height,
          score: r.score, angleDeg: a, sizePx: target,
        });
      }
      done++;
      if (opts.onProgress) opts.onProgress(done / total);
    }
  }
  all.sort((a, b) => b.score - a.score);
  return nonMaxSuppress(all, pieceSizePx * 0.6, topK);
}

// Convert a match centre into human-friendly grid coordinates.
export function gridPosition(cx, cy, refW, refH, cols, rows) {
  const col = Math.min(cols, Math.max(1, Math.floor((cx / refW) * cols) + 1));
  const row = Math.min(rows, Math.max(1, Math.floor((cy / refH) * rows) + 1));
  return { row, col };
}
