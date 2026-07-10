// Piece detection in a photo/scan. DOM-free: operates on ImageData-shaped
// objects { width, height, data: Uint8ClampedArray|Uint8Array (RGBA) }.
//
// Assumes pieces are photographed on a reasonably plain, contrasting
// background (a table, a sheet of paper). Background colour is estimated
// from the image border.

function medianOf(arr) {
  const s = Array.from(arr).sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

export function estimateBackground(img) {
  const w = img.width, h = img.height, d = img.data;
  const frame = Math.max(2, Math.round(Math.min(w, h) * 0.02));
  const rs = [], gs = [], bs = [];
  const push = (x, y) => {
    const i = (y * w + x) * 4;
    rs.push(d[i]); gs.push(d[i + 1]); bs.push(d[i + 2]);
  };
  const step = Math.max(1, Math.floor(Math.max(w, h) / 200));
  for (let y = 0; y < h; y += step) {
    for (let f = 0; f < frame; f++) { push(f, y); push(w - 1 - f, y); }
  }
  for (let x = 0; x < w; x += step) {
    for (let f = 0; f < frame; f++) { push(x, f); push(x, h - 1 - f); }
  }
  const bg = [medianOf(rs), medianOf(gs), medianOf(bs)];
  // spread of the border around its median -> adaptive threshold
  const dists = [];
  for (let k = 0; k < rs.length; k++) {
    const dr = rs[k] - bg[0], dg = gs[k] - bg[1], db = bs[k] - bg[2];
    dists.push(Math.sqrt(dr * dr + dg * dg + db * db));
  }
  dists.sort((a, b) => a - b);
  const p90 = dists[Math.floor(dists.length * 0.9)] || 0;
  // Capped: a busy border (wood grain, clutter at the photo edge) must not
  // push the threshold so high that real pieces never clear it.
  const threshold = Math.max(26, Math.min(p90 * 1.8 + 12, 78));
  return { color: bg, threshold };
}

function buildMask(img, bg) {
  const w = img.width, h = img.height, d = img.data;
  const mask = new Uint8Array(w * h);
  const [br, bgc, bb] = bg.color;
  const t2 = bg.threshold * bg.threshold;
  for (let i = 0; i < w * h; i++) {
    const dr = d[i * 4] - br;
    const dg = d[i * 4 + 1] - bgc;
    const db = d[i * 4 + 2] - bb;
    if (dr * dr + dg * dg + db * db > t2) mask[i] = 1;
  }
  return mask;
}

function morph(mask, w, h, erode) {
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let hit = erode ? 1 : 0;
      for (let dy = -1; dy <= 1 && hit === (erode ? 1 : 0); dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const ny = y + dy, nx = x + dx;
          const v = ny < 0 || nx < 0 || ny >= h || nx >= w ? 0 : mask[ny * w + nx];
          if (erode) { if (!v) { hit = 0; break; } }
          else if (v) { hit = 1; break; }
        }
      }
      out[y * w + x] = hit;
    }
  }
  return out;
}

// Find connected components of the foreground mask, largest first.
// Returns [{ x0, y0, x1, y1, area, mask }] where mask is local to the bbox.
//
// If nothing clears the border-derived threshold (pieces whose colours sit
// close to the background, e.g. muted art on a grey table), one retry runs
// at a lower threshold before giving up.
export function segmentPieces(img, opts = {}) {
  const bg = opts.background || estimateBackground(img);
  const first = segmentAtThreshold(img, bg.color, bg.threshold, opts);
  if (first.length > 0) return first;
  const retryT = Math.max(18, bg.threshold * 0.6);
  if (retryT >= bg.threshold) return first;
  return segmentAtThreshold(img, bg.color, retryT, opts);
}

function segmentAtThreshold(img, color, threshold, opts) {
  const w = img.width, h = img.height;
  let mask = buildMask(img, { color, threshold });
  mask = morph(morph(mask, w, h, true), w, h, false);   // open: kill speckle
  mask = morph(morph(mask, w, h, false), w, h, true);   // close: fill pinholes

  const minArea = opts.minArea || Math.max(64, Math.round(w * h * 0.001));
  const labels = new Int32Array(w * h);
  const pieces = [];
  const stack = new Int32Array(w * h);
  let next = 1;
  for (let start = 0; start < w * h; start++) {
    if (!mask[start] || labels[start]) continue;
    let sp = 0;
    stack[sp++] = start;
    labels[start] = next;
    let area = 0;
    let x0 = w, y0 = h, x1 = 0, y1 = 0;
    const members = [];
    while (sp > 0) {
      const i = stack[--sp];
      members.push(i);
      area++;
      const x = i % w, y = (i - x) / w;
      if (x < x0) x0 = x; if (x > x1) x1 = x;
      if (y < y0) y0 = y; if (y > y1) y1 = y;
      if (x > 0 && mask[i - 1] && !labels[i - 1]) { labels[i - 1] = next; stack[sp++] = i - 1; }
      if (x < w - 1 && mask[i + 1] && !labels[i + 1]) { labels[i + 1] = next; stack[sp++] = i + 1; }
      if (y > 0 && mask[i - w] && !labels[i - w]) { labels[i - w] = next; stack[sp++] = i - w; }
      if (y < h - 1 && mask[i + w] && !labels[i + w]) { labels[i + w] = next; stack[sp++] = i + w; }
    }
    next++;
    if (area < minArea) continue;
    const bw = x1 - x0 + 1, bh = y1 - y0 + 1;
    // Background clutter reaching across the frame (a mat or table edge in
    // shot) is not a piece: skip long, thin components pinned to the image
    // border. Real pieces stay chunky — aspect well under 4 even with tabs.
    const touchesEdge = x0 <= 1 || y0 <= 1 || x1 >= w - 2 || y1 >= h - 2;
    if (touchesEdge && Math.max(bw / bh, bh / bw) > 4) continue;
    const local = new Uint8Array(bw * bh);
    for (const i of members) {
      const x = i % w, y = (i - x) / w;
      local[(y - y0) * bw + (x - x0)] = 1;
    }
    // Printed areas that happen to match the background colour punch false
    // holes in the piece; fill anything not reachable from outside.
    fillHoles(local, bw, bh);
    // Snap the outline to the piece's physical edge; if that fails, keep
    // the colour mask with its shadow rim shaved.
    const piece = refineMask(img, x0, y0, x1, y1, local)
      || finishColorMask(x0, y0, x1, y1, local);
    pieces.push(piece);
  }
  pieces.sort((a, b) => b.area - a.area);
  return pieces.slice(0, opts.maxPieces || 24);
}

// Previous behaviour, used when watershed refinement is skipped or fails:
// colour mask with the rim (which tends to carry the cast shadow) shaved.
function finishColorMask(x0, y0, x1, y1, local) {
  const bw = x1 - x0 + 1, bh = y1 - y0 + 1;
  const mask = erodeRim(local, bw, bh, Math.max(1, Math.round(Math.min(bw, bh) * 0.02)));
  let area = 0;
  for (let i = 0; i < bw * bh; i++) area += mask[i];
  return { x0, y0, x1, y1, area, mask };
}

// Refine a piece's colour-threshold mask so its outline follows the piece's
// PHYSICAL edge rather than colour changes in the printed picture.
//
// Marker-based watershed (Meyer flooding) on the gradient image: the eroded
// colour mask seeds "piece", the window frame seeds "background", and both
// flood in order of ascending gradient. The fronts meet on the strongest
// gradient ridge between them — the cut-cardboard/contact-shadow line — so
// printed regions that happen to match the table colour are claimed for the
// piece, because they sit inside that ridge.
function refineMask(img, x0, y0, x1, y1, local) {
  const bw = x1 - x0 + 1, bh = y1 - y0 + 1;
  if (Math.min(bw, bh) < 32) return null; // too small for a meaningful edge
  // The detected bbox may be missing camouflaged parts of the piece, so the
  // window (whose frame seeds "background") must be padded generously enough
  // to contain the whole physical piece.
  const pad = Math.min(500, Math.round(Math.max(bw, bh) * 0.75) + 4);
  const wx0 = Math.max(0, x0 - pad), wy0 = Math.max(0, y0 - pad);
  const wx1 = Math.min(img.width - 1, x1 + pad), wy1 = Math.min(img.height - 1, y1 + pad);
  const ww = wx1 - wx0 + 1, wh = wy1 - wy0 + 1;

  // gradient magnitude, max over channels, quantised to 0..255
  const grad = new Uint8Array(ww * wh);
  const iw = img.width, d = img.data;
  for (let y = 0; y < wh; y++) {
    const sy = wy0 + y;
    const ym = Math.max(0, sy - 1), yp = Math.min(img.height - 1, sy + 1);
    for (let x = 0; x < ww; x++) {
      const sx = wx0 + x;
      const xm = Math.max(0, sx - 1), xp = Math.min(iw - 1, sx + 1);
      let g = 0;
      for (let c = 0; c < 3; c++) {
        const gx = d[(sy * iw + xp) * 4 + c] - d[(sy * iw + xm) * 4 + c];
        const gy = d[(yp * iw + sx) * 4 + c] - d[(ym * iw + sx) * 4 + c];
        const m = Math.abs(gx) + Math.abs(gy);
        if (m > g) g = m;
      }
      grad[y * ww + x] = Math.min(255, g >> 1);
    }
  }

  // markers: 1 = piece (eroded colour mask), 2 = background (window frame)
  const label = new Uint8Array(ww * wh);
  const seed = erodeRim(local, bw, bh, Math.max(3, Math.round(Math.min(bw, bh) * 0.06)));
  let seedCount = 0;
  for (let y = 0; y < bh; y++) {
    for (let x = 0; x < bw; x++) {
      if (seed[y * bw + x]) { label[(y + y0 - wy0) * ww + (x + x0 - wx0)] = 1; seedCount++; }
    }
  }
  if (seedCount < 16) return null;
  for (let x = 0; x < ww; x++) {
    if (!label[x]) label[x] = 2;
    if (!label[(wh - 1) * ww + x]) label[(wh - 1) * ww + x] = 2;
  }
  for (let y = 0; y < wh; y++) {
    if (!label[y * ww]) label[y * ww] = 2;
    if (!label[y * ww + ww - 1]) label[y * ww + ww - 1] = 2;
  }

  // Meyer flooding with a bucket queue over gradient levels
  const buckets = new Array(256);
  for (let b = 0; b < 256; b++) buckets[b] = [];
  const pendLab = new Uint8Array(ww * wh); // 0 = not queued
  const enqueue = (j, lab, level) => {
    if (label[j] || pendLab[j]) return;
    pendLab[j] = lab;
    buckets[Math.max(level, grad[j])].push(j);
  };
  const nbrs = (i, fn) => {
    const x = i % ww;
    if (x > 0) fn(i - 1);
    if (x < ww - 1) fn(i + 1);
    if (i >= ww) fn(i - ww);
    if (i < ww * (wh - 1)) fn(i + ww);
  };
  for (let i = 0; i < ww * wh; i++) {
    if (label[i]) nbrs(i, (j) => enqueue(j, label[i], grad[j]));
  }
  for (let b = 0; b < 256; b++) {
    const q = buckets[b];
    for (let k = 0; k < q.length; k++) { // q may grow while iterating
      const i = q[k];
      if (label[i]) continue;
      label[i] = pendLab[i];
      nbrs(i, (j) => enqueue(j, label[i], b));
    }
  }

  // keep only the seed-connected piece region, fill holes, light rim shave
  const refined = new Uint8Array(ww * wh);
  const stack = [];
  for (let y = 0; y < bh; y++) {
    for (let x = 0; x < bw; x++) {
      if (!seed[y * bw + x]) continue;
      const i = (y + y0 - wy0) * ww + (x + x0 - wx0);
      if (!refined[i]) { refined[i] = 1; stack.push(i); }
    }
  }
  while (stack.length) {
    const i = stack.pop();
    nbrs(i, (j) => { if (label[j] === 1 && !refined[j]) { refined[j] = 1; stack.push(j); } });
  }
  // Shape prior: pieces are solid, so narrow ragged bays (print edges the
  // flood couldn't cross) are impossible — a wide closing fills them while
  // leaving the broader, legitimate tab/blank indentations alone.
  closeMask(refined, ww, wh, Math.max(3, Math.round(Math.min(bw, bh) * 0.06)));
  fillHoles(refined, ww, wh);
  const shaved = erodeRim(refined, ww, wh, Math.max(1, Math.round(Math.min(bw, bh) * 0.015)));

  // tight bbox + area of the result
  let rx0 = ww, ry0 = wh, rx1 = -1, ry1 = -1, area = 0;
  for (let y = 0; y < wh; y++) {
    for (let x = 0; x < ww; x++) {
      if (!shaved[y * ww + x]) continue;
      area++;
      if (x < rx0) rx0 = x; if (x > rx1) rx1 = x;
      if (y < ry0) ry0 = y; if (y > ry1) ry1 = y;
    }
  }
  // sanity: a leak or collapse means the edge wasn't findable — fall back
  let colorArea = 0;
  for (let i = 0; i < bw * bh; i++) colorArea += local[i];
  if (rx1 < 0 || area < colorArea * 0.6 || area > colorArea * 1.8) return null;

  const nw = rx1 - rx0 + 1, nh = ry1 - ry0 + 1;
  const mask = new Uint8Array(nw * nh);
  for (let y = 0; y < nh; y++) {
    for (let x = 0; x < nw; x++) {
      mask[y * nw + x] = shaved[(y + ry0) * ww + (x + rx0)];
    }
  }
  return { x0: wx0 + rx0, y0: wy0 + ry0, x1: wx0 + rx1, y1: wy0 + ry1, area, mask };
}

// Morphological closing with an (approximately) disc-shaped element of
// radius r, in place: dilate then erode, both via two-pass 3-4 chamfer
// distance transforms so large radii stay cheap.
function closeMask(mask, w, h, r) {
  const INF = 1 << 28;
  const dist = new Int32Array(w * h);
  const chamfer = (isSet) => {
    for (let i = 0; i < w * h; i++) dist[i] = isSet(i) ? 0 : INF;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        let v = dist[i];
        if (x > 0 && dist[i - 1] + 3 < v) v = dist[i - 1] + 3;
        if (y > 0) {
          if (dist[i - w] + 3 < v) v = dist[i - w] + 3;
          if (x > 0 && dist[i - w - 1] + 4 < v) v = dist[i - w - 1] + 4;
          if (x < w - 1 && dist[i - w + 1] + 4 < v) v = dist[i - w + 1] + 4;
        }
        dist[i] = v;
      }
    }
    for (let y = h - 1; y >= 0; y--) {
      for (let x = w - 1; x >= 0; x--) {
        const i = y * w + x;
        let v = dist[i];
        if (x < w - 1 && dist[i + 1] + 3 < v) v = dist[i + 1] + 3;
        if (y < h - 1) {
          if (dist[i + w] + 3 < v) v = dist[i + w] + 3;
          if (x < w - 1 && dist[i + w + 1] + 4 < v) v = dist[i + w + 1] + 4;
          if (x > 0 && dist[i + w - 1] + 4 < v) v = dist[i + w - 1] + 4;
        }
        dist[i] = v;
      }
    }
  };
  const r3 = r * 3;
  chamfer((i) => mask[i] === 1);            // distance to the piece
  for (let i = 0; i < w * h; i++) mask[i] = dist[i] <= r3 ? 1 : 0; // dilate
  chamfer((i) => mask[i] === 0);            // distance to the background
  for (let i = 0; i < w * h; i++) mask[i] = dist[i] > r3 ? 1 : 0;  // erode
}

// Set every background pixel not reachable from the bbox border (an
// enclosed hole) to foreground. Returns the number of pixels filled.
function fillHoles(mask, w, h) {
  const reach = new Uint8Array(w * h);
  const stack = [];
  const push = (i) => { if (!mask[i] && !reach[i]) { reach[i] = 1; stack.push(i); } };
  for (let x = 0; x < w; x++) { push(x); push((h - 1) * w + x); }
  for (let y = 0; y < h; y++) { push(y * w); push(y * w + w - 1); }
  while (stack.length) {
    const i = stack.pop();
    const x = i % w, y = (i - x) / w;
    if (x > 0) push(i - 1);
    if (x < w - 1) push(i + 1);
    if (y > 0) push(i - w);
    if (y < h - 1) push(i + w);
  }
  let filled = 0;
  for (let i = 0; i < w * h; i++) {
    if (!mask[i] && !reach[i]) { mask[i] = 1; filled++; }
  }
  return filled;
}

function erodeRim(mask, w, h, iters) {
  let cur = mask;
  for (let k = 0; k < iters; k++) {
    const out = new Uint8Array(w * h);
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const i = y * w + x;
        if (cur[i] && cur[i - 1] && cur[i + 1] && cur[i - w] && cur[i + w]) out[i] = 1;
      }
    }
    cur = out;
  }
  return cur;
}

// Cut a piece out of the source photo as a matcher Patch
// ({ width, height, data: Float32Array RGB 0..1, mask }).
export function extractPatch(img, piece) {
  const bw = piece.x1 - piece.x0 + 1;
  const bh = piece.y1 - piece.y0 + 1;
  const data = new Float32Array(bw * bh * 3);
  for (let y = 0; y < bh; y++) {
    for (let x = 0; x < bw; x++) {
      const si = ((y + piece.y0) * img.width + (x + piece.x0)) * 4;
      const di = (y * bw + x) * 3;
      data[di] = img.data[si] / 255;
      data[di + 1] = img.data[si + 1] / 255;
      data[di + 2] = img.data[si + 2] / 255;
    }
  }
  return { width: bw, height: bh, data, mask: piece.mask };
}
