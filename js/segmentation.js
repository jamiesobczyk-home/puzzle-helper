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
    let local = new Uint8Array(bw * bh);
    let filled = area;
    for (const i of members) {
      const x = i % w, y = (i - x) / w;
      local[(y - y0) * bw + (x - x0)] = 1;
    }
    // Printed areas that happen to match the background colour punch false
    // holes in the piece; fill anything not reachable from outside, then
    // shave the rim, which tends to carry the piece's cast shadow.
    filled += fillHoles(local, bw, bh);
    local = erodeRim(local, bw, bh, Math.max(1, Math.round(Math.min(bw, bh) * 0.02)));
    pieces.push({ x0, y0, x1, y1, area: filled, mask: local });
  }
  pieces.sort((a, b) => b.area - a.area);
  return pieces.slice(0, opts.maxPieces || 24);
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
