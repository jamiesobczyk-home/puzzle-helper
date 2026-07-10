import { segmentPieces, extractPatch } from './segmentation.js';
import { estimateGrid, gridPosition } from './matching.js';

const MARKER_COLORS = ['#e6194b', '#3cb44b', '#4363d8', '#f58231', '#911eb4',
  '#46f0f0', '#f032e6', '#bcf60c', '#008080', '#9a6324', '#800000', '#000075'];

const state = {
  ref: null,          // { imageData } full downscaled box photo
  crop: null,         // { x0, y0, x1, y1 } in ref imageData coords
  pieces: [],         // [{ patch, thumb, included }]
  results: null,
  worker: null,
};

const $ = (id) => document.getElementById(id);
const refCanvas = $('ref-canvas');
const resultCanvas = $('result-canvas');

// ---------- image loading ----------

async function decodeImageFile(file) {
  // Prefer createImageBitmap with EXIF orientation applied (phone photos are
  // often stored rotated); fall back for browsers that reject the options
  // bag or the file format.
  try {
    return await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch { /* fall through */ }
  try {
    return await createImageBitmap(file);
  } catch { /* fall through */ }
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('unsupported image format'));
    };
    img.src = url;
  });
}

async function fileToImageData(file, maxDim) {
  const bmp = await decodeImageFile(file);
  const bw = bmp.width || bmp.naturalWidth;
  const bh = bmp.height || bmp.naturalHeight;
  const scale = Math.min(1, maxDim / Math.max(bw, bh));
  const w = Math.max(1, Math.round(bw * scale));
  const h = Math.max(1, Math.round(bh * scale));
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d');
  ctx.drawImage(bmp, 0, 0, w, h);
  if (bmp.close) bmp.close();
  return ctx.getImageData(0, 0, w, h);
}

function imageDataToFloat(img, region, maxDim) {
  const x0 = region ? region.x0 : 0;
  const y0 = region ? region.y0 : 0;
  const rw = region ? region.x1 - region.x0 + 1 : img.width;
  const rh = region ? region.y1 - region.y0 + 1 : img.height;
  const scale = Math.min(1, maxDim / Math.max(rw, rh));
  const w = Math.max(1, Math.round(rw * scale));
  const h = Math.max(1, Math.round(rh * scale));
  const data = new Float32Array(w * h * 3);
  for (let y = 0; y < h; y++) {
    const sy = y0 + Math.min(rh - 1, Math.floor(y / scale));
    for (let x = 0; x < w; x++) {
      const sx = x0 + Math.min(rw - 1, Math.floor(x / scale));
      const si = (sy * img.width + sx) * 4;
      const di = (y * w + x) * 3;
      data[di] = img.data[si] / 255;
      data[di + 1] = img.data[si + 1] / 255;
      data[di + 2] = img.data[si + 2] / 255;
    }
  }
  return { width: w, height: h, data };
}

// ---------- reference photo + crop ----------

function setReference(imageData) {
  state.ref = { imageData };
  state.crop = null;
  state.results = null;
  refCanvas.hidden = false;
  $('ref-hint').hidden = false;
  $('ref-reset-crop').disabled = false;
  drawReference();
  updateGridHint();
  updateMatchButton();
}

function cropRect() {
  return state.crop || {
    x0: 0, y0: 0,
    x1: state.ref.imageData.width - 1,
    y1: state.ref.imageData.height - 1,
  };
}

function drawReference(dragRect) {
  const img = state.ref.imageData;
  refCanvas.width = img.width;
  refCanvas.height = img.height;
  const ctx = refCanvas.getContext('2d');
  ctx.putImageData(img, 0, 0);
  const r = dragRect || state.crop;
  if (r) {
    ctx.fillStyle = 'rgba(0,0,0,0.45)';
    ctx.fillRect(0, 0, img.width, img.height);
    // redraw only the kept region undimmed (putImageData ignores clip,
    // but supports a dirty rectangle)
    ctx.putImageData(img, 0, 0, r.x0, r.y0, r.x1 - r.x0 + 1, r.y1 - r.y0 + 1);
    ctx.strokeStyle = '#ffcc00';
    ctx.lineWidth = Math.max(2, img.width / 300);
    ctx.strokeRect(r.x0 + 0.5, r.y0 + 0.5, r.x1 - r.x0, r.y1 - r.y0);
  }
}

function canvasPoint(ev) {
  const rect = refCanvas.getBoundingClientRect();
  const x = ((ev.clientX - rect.left) / rect.width) * refCanvas.width;
  const y = ((ev.clientY - rect.top) / rect.height) * refCanvas.height;
  return {
    x: Math.max(0, Math.min(refCanvas.width - 1, Math.round(x))),
    y: Math.max(0, Math.min(refCanvas.height - 1, Math.round(y))),
  };
}

let dragStart = null;
refCanvas.addEventListener('pointerdown', (ev) => {
  if (!state.ref) return;
  dragStart = canvasPoint(ev);
  refCanvas.setPointerCapture(ev.pointerId);
});
refCanvas.addEventListener('pointermove', (ev) => {
  if (!dragStart) return;
  const p = canvasPoint(ev);
  drawReference(normRect(dragStart, p));
});
refCanvas.addEventListener('pointerup', (ev) => {
  if (!dragStart) return;
  const p = canvasPoint(ev);
  const r = normRect(dragStart, p);
  dragStart = null;
  // ignore accidental taps
  if (r.x1 - r.x0 > 15 && r.y1 - r.y0 > 15) state.crop = r;
  drawReference();
  updateGridHint();
});

function normRect(a, b) {
  return {
    x0: Math.min(a.x, b.x), y0: Math.min(a.y, b.y),
    x1: Math.max(a.x, b.x), y1: Math.max(a.y, b.y),
  };
}

$('ref-reset-crop').addEventListener('click', () => {
  state.crop = null;
  drawReference();
  updateGridHint();
});

$('ref-input').addEventListener('change', async (ev) => {
  const file = ev.target.files[0];
  if (!file) return;
  try {
    setReference(await fileToImageData(file, 1000));
  } catch {
    addStatus('Could not read that photo — the format may be unsupported by this browser. Try another photo.');
  }
});

function currentGrid() {
  const r = cropRect();
  const count = Math.max(4, parseInt($('piece-count').value, 10) || 500);
  return estimateGrid(count, (r.x1 - r.x0 + 1) / (r.y1 - r.y0 + 1));
}

function updateGridHint() {
  if (!state.ref) return;
  const { cols, rows } = currentGrid();
  $('grid-hint').textContent =
    `Assuming roughly ${cols} columns x ${rows} rows.`;
}
$('piece-count').addEventListener('input', updateGridHint);

// ---------- pieces ----------

$('pieces-input').addEventListener('change', async (ev) => {
  for (const file of ev.target.files) {
    let img;
    try {
      img = await fileToImageData(file, 1200);
    } catch {
      addStatus('Could not read a pieces photo — the format may be unsupported by this browser. Try another photo.');
      continue;
    }
    const found = segmentPieces(img);
    if (found.length === 0) {
      addStatus('No pieces detected in that photo. Try a plainer background or better lighting.');
      continue;
    }
    for (const piece of found) {
      const patch = extractPatch(img, piece);
      state.pieces.push({ patch, thumb: makeThumb(patch), included: true });
    }
  }
  ev.target.value = '';
  renderPieceList();
  updateMatchButton();
});

$('pieces-clear').addEventListener('click', () => {
  state.pieces = [];
  renderPieceList();
  updateMatchButton();
});

function makeThumb(patch, size = 96) {
  const c = document.createElement('canvas');
  const f = size / Math.max(patch.width, patch.height);
  c.width = Math.max(1, Math.round(patch.width * f));
  c.height = Math.max(1, Math.round(patch.height * f));
  const ctx = c.getContext('2d');
  const out = ctx.createImageData(c.width, c.height);
  for (let y = 0; y < c.height; y++) {
    for (let x = 0; x < c.width; x++) {
      const sx = Math.min(patch.width - 1, Math.floor(x / f));
      const sy = Math.min(patch.height - 1, Math.floor(y / f));
      const si = sy * patch.width + sx;
      const di = (y * c.width + x) * 4;
      if (patch.mask && !patch.mask[si]) { out.data[di + 3] = 0; continue; }
      out.data[di] = patch.data[si * 3] * 255;
      out.data[di + 1] = patch.data[si * 3 + 1] * 255;
      out.data[di + 2] = patch.data[si * 3 + 2] * 255;
      out.data[di + 3] = 255;
    }
  }
  ctx.putImageData(out, 0, 0);
  return c;
}

function renderPieceList() {
  const list = $('piece-list');
  list.innerHTML = '';
  $('pieces-clear').disabled = state.pieces.length === 0;
  state.pieces.forEach((p, i) => {
    const div = document.createElement('div');
    div.className = 'piece' + (p.included ? '' : ' excluded');
    div.style.setProperty('--marker', MARKER_COLORS[i % MARKER_COLORS.length]);
    const label = document.createElement('span');
    label.className = 'piece-num';
    label.textContent = String(i + 1);
    div.appendChild(label);
    div.appendChild(p.thumb);
    div.title = 'Tap to include/exclude this detection';
    div.addEventListener('click', () => {
      p.included = !p.included;
      renderPieceList();
      updateMatchButton();
    });
    list.appendChild(div);
  });
}

// ---------- matching ----------

function updateMatchButton() {
  $('match-btn').disabled =
    !state.ref || !state.pieces.some((p) => p.included);
}

function addStatus(msg) {
  const el = document.createElement('p');
  el.className = 'status';
  el.textContent = msg;
  $('results').prepend(el);
}

$('match-btn').addEventListener('click', () => {
  const included = state.pieces
    .map((p, i) => ({ ...p, index: i }))
    .filter((p) => p.included);
  if (!state.ref || included.length === 0) return;

  const region = cropRect();
  const ref = imageDataToFloat(state.ref.imageData, region, 480);
  const { cols, rows } = currentGrid();
  // piece core is refW/cols; tabs stick out, so expect a bit larger
  const pieceSizePx = Math.max(8, Math.round((ref.width / cols) * 1.3));

  const btn = $('match-btn');
  btn.disabled = true;
  btn.textContent = 'Matching…';
  const bar = $('match-progress');
  bar.hidden = false;
  bar.value = 0;

  if (state.worker) state.worker.terminate();
  const worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
  state.worker = worker;
  worker.onmessage = (e) => {
    if (e.data.type === 'progress') {
      bar.value = e.data.done / e.data.total;
    } else if (e.data.type === 'result') {
      worker.terminate();
      state.worker = null;
      btn.disabled = false;
      btn.textContent = 'Find placements';
      bar.hidden = true;
      showResults(included, e.data.results, ref, cols, rows);
    }
  };
  worker.onerror = (err) => {
    worker.terminate();
    state.worker = null;
    btn.disabled = false;
    btn.textContent = 'Find placements';
    bar.hidden = true;
    addStatus('Matching failed: ' + err.message);
  };
  worker.postMessage({
    ref,
    patches: included.map((p) => p.patch),
    opts: { pieceSizePx, angleStepDeg: 30, topK: 3 },
  });
});

function confidence(score) {
  if (score >= 0.75) return 'high';
  if (score >= 0.55) return 'medium';
  return 'low';
}

function showResults(pieces, results, ref, cols, rows) {
  const region = cropRect();
  const img = state.ref.imageData;
  const rw = region.x1 - region.x0 + 1;
  const rh = region.y1 - region.y0 + 1;
  resultCanvas.hidden = false;
  resultCanvas.width = rw;
  resultCanvas.height = rh;
  const ctx = resultCanvas.getContext('2d');
  // draw the cropped reference
  const tmp = document.createElement('canvas');
  tmp.width = img.width; tmp.height = img.height;
  tmp.getContext('2d').putImageData(img, 0, 0);
  ctx.drawImage(tmp, region.x0, region.y0, rw, rh, 0, 0, rw, rh);

  // light grid overlay
  ctx.strokeStyle = 'rgba(255,255,255,0.35)';
  ctx.lineWidth = 1;
  for (let c = 1; c < cols; c++) {
    const x = (c / cols) * rw;
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, rh); ctx.stroke();
  }
  for (let r = 1; r < rows; r++) {
    const y = (r / rows) * rh;
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(rw, y); ctx.stroke();
  }

  const resultsEl = $('results');
  resultsEl.innerHTML = '';
  const scale = rw / ref.width; // ref-float coords -> displayed crop coords

  pieces.forEach((p, k) => {
    const cands = results[k];
    const color = MARKER_COLORS[p.index % MARKER_COLORS.length];
    const row = document.createElement('div');
    row.className = 'result-row';
    row.style.setProperty('--marker', color);
    const num = document.createElement('span');
    num.className = 'piece-num';
    num.textContent = String(p.index + 1);
    row.appendChild(num);
    row.appendChild(makeThumb(p.patch, 72));
    const text = document.createElement('div');
    if (!cands || cands.length === 0) {
      text.textContent = 'No confident match found.';
    } else {
      const best = cands[0];
      const pos = gridPosition(best.cx, best.cy, ref.width, ref.height, cols, rows);
      const main = document.createElement('p');
      main.innerHTML =
        `<strong>Row ${pos.row} from the top, column ${pos.col} from the left.</strong> ` +
        `Confidence: ${confidence(best.score)} (${best.score.toFixed(2)}). ` +
        `Rotate about ${best.angleDeg}&deg; clockwise to match the picture.`;
      text.appendChild(main);
      if (cands.length > 1) {
        const alts = cands.slice(1).map((c) => {
          const gp = gridPosition(c.cx, c.cy, ref.width, ref.height, cols, rows);
          return `row ${gp.row}, col ${gp.col} (${c.score.toFixed(2)})`;
        });
        const alt = document.createElement('p');
        alt.className = 'alts';
        alt.textContent = 'Other possibilities: ' + alts.join('; ');
        text.appendChild(alt);
      }
      // marker on the canvas for the best candidate
      const mx = best.cx * scale;
      const my = best.cy * scale;
      const mr = (best.sizePx / 2) * scale;
      ctx.strokeStyle = color;
      ctx.lineWidth = Math.max(2, rw / 250);
      ctx.strokeRect(mx - mr, my - mr, mr * 2, mr * 2);
      ctx.fillStyle = color;
      const fs = Math.max(14, rw / 30);
      ctx.font = `bold ${fs}px sans-serif`;
      ctx.fillText(String(p.index + 1), mx - mr + 3, my - mr - 4);
    }
    row.appendChild(text);
    resultsEl.appendChild(row);
  });
  resultCanvas.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

// ---------- demo mode ----------

function mulberry32(seed) {
  return () => {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeDemoArt(w, h, rand) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d');
  const grad = ctx.createLinearGradient(0, 0, w, h);
  grad.addColorStop(0, '#1a5276');
  grad.addColorStop(0.5, '#f4d03f');
  grad.addColorStop(1, '#922b21');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, w, h);
  for (let i = 0; i < 60; i++) {
    ctx.fillStyle = `hsl(${Math.floor(rand() * 360)}, ${50 + rand() * 40}%, ${30 + rand() * 45}%)`;
    const x = rand() * w, y = rand() * h;
    const s = 12 + rand() * 45;
    if (rand() < 0.5) {
      ctx.beginPath(); ctx.arc(x, y, s / 2, 0, Math.PI * 2); ctx.fill();
    } else {
      ctx.fillRect(x - s / 2, y - s / 2, s, s * (0.5 + rand()));
    }
  }
  return c;
}

$('demo-btn').addEventListener('click', () => {
  const rand = mulberry32(20260708);
  const art = makeDemoArt(480, 360, rand);
  setReference(art.getContext('2d').getImageData(0, 0, 480, 360));
  $('piece-count').value = 48; // 8 x 6 demo grid
  updateGridHint();

  // build a fake "pieces on the table" photo from three random cells
  const cols = 8, rows = 6, cw = 480 / cols, ch = 360 / rows;
  const photo = document.createElement('canvas');
  photo.width = 760; photo.height = 300;
  const pctx = photo.getContext('2d');
  pctx.fillStyle = '#d7d3cb';
  pctx.fillRect(0, 0, photo.width, photo.height);
  for (let k = 0; k < 3; k++) {
    const col = Math.floor(rand() * cols), row = Math.floor(rand() * rows);
    const angle = Math.floor(rand() * 4) * 90;
    pctx.save();
    pctx.translate(130 + k * 250, 150);
    pctx.rotate((angle * Math.PI) / 180);
    pctx.scale(2, 2);
    pctx.beginPath();
    pctx.arc(0, 0, Math.min(cw, ch) * 0.62, 0, Math.PI * 2);
    pctx.clip();
    pctx.drawImage(art, col * cw - cw * 0.15, row * ch - ch * 0.15,
      cw * 1.3, ch * 1.3, -cw * 0.65, -ch * 0.65, cw * 1.3, ch * 1.3);
    pctx.restore();
  }
  const img = pctx.getImageData(0, 0, photo.width, photo.height);
  state.pieces = [];
  for (const piece of segmentPieces(img)) {
    const patch = extractPatch(img, piece);
    state.pieces.push({ patch, thumb: makeThumb(patch), included: true });
  }
  renderPieceList();
  updateMatchButton();
  addStatus('Demo loaded: a synthetic box picture and 3 cut-out pieces. Press "Find placements".');
});
