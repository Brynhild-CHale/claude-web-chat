// lib/core/icon.js — the one image pipeline a project's logo and favicon go
// through, and the dark variant of one (spec §9.6, D11).
//
// Bytes in, bytes out. It never touches the filesystem: the identity CLI reads
// the user's file and writes the results (through lib/core/project-identity or
// the daemon); this module only decides what those results are. It imports only
// lib/core/png (the one decoder and encoder), lib/core/brand-image (validate,
// MAX_BYTES, sniff — every variant it returns passes validate) and
// lib/core/image-file (imageSize, for an SVG's viewBox), and no fs.
//
//   loadImage(bytes)            → { format:'png', image } | { format:'svg', bytes, width, height }
//   prepare(bytes, { kind, mode, tile, pad, crop })
//                               → the variants a logo or favicon is stored as (below)
//   darkVariant(image, { cell }) → { image, hues:{ major, minor} } | null
//   detectCell(image)           → the run-length GCD: an exact integer upscale's cell
//   resample(src, sw, sh, dw, dh) → the one area-average resampler (make-icons uses it too)
//   encode(image)               → lib/core/png encodePng's bytes
//
// THE REFERENCE is web-chat-dev's own icon: a 32×29-cell pixel-art sprite at
// 5 px a cell (design/assets/make-icon.js made it from a noisy 1302×1208 source).
// prepare() reproduces its transparent, tile and touch variants pixel for pixel
// from it, and darkVariant() reproduces design/assets/glint.js's variant A —
// the dark logo the maintainer picked — on the icon, its tile and the favicon.
//
// PREPARE, for a PNG:
//   0. crop (optional, `crop: {x, y, w, h}`, integers in source pixels): the
//      source is cut to that box first, which must lie inside the image (else
//      IconError 'bad-crop', its hint naming the image's size); the box then
//      runs every step below as any image would — a crop still too wide for a
//      favicon is refused at step 6, or padded when `pad` is asked too.
//   1. background: transparent when the four corners are all alpha 0; flat when
//      the four corners agree within CORNER_TOLERANCE (their mean); else none.
//   2. content box: the pixels with alpha > 0 (transparent ground), or the ones
//      further than INK_DISTANCE from a flat ground (Chebyshev, over RGB).
//   3. pixel art, in mode auto, when any of: (a) detectCell() > 1, an exact
//      integer upscale at phase 0; (b) a grid found from the colour edges — the
//      pitch and phase whose lines the edges sit on, scored per axis and the two
//      scores multiplied — whose re-rendered sprite reproduces the content box
//      within RECONSTRUCT_MAX_ERROR per channel; (c) an image at most
//      NATIVE_SPRITE_MAX_SIDE px on its longer side (a native sprite, one cell a
//      pixel). Mode pixel forces the grid ((a), else (b) without the error
//      bound, else cell 1); mode smooth forces the area-average path.
//   4. pixel path (make-icon.js's): sample each cell's centre by the median of a
//      small patch, trim empty border cells, key the background cells out (flat
//      ground), centre on a canvas with a margin of 1 / 3 / 2 cells
//      (transparent / tile / touch), and upscale nearest-neighbour by
//      ceil(PIXEL_MIN_SIDE / side) — the touch icon by floor(TOUCH_SIDE / side)
//      on an exact TOUCH_SIDE square.
//   5. smooth path: crop to the content box, key a flat ground softly
//      (KEY_RAMP_LOW..KEY_RAMP_HIGH, the colour un-mixed from the ground), margins
//      of 1/32, 3/32 and 2/32 of the content's longer side, every variant's
//      longer side within MIN_SIDE..SMOOTH_MAX_SIDE (upscaling smaller art, with
//      a note saying so), stepped down by SIZE_STEP while an encoding is over
//      brand-image's MAX_BYTES. The touch icon fits the content in a
//      TOUCH_CONTENT_SIDE box on its tile.
//   6. shape: content within NEAR_SQUARE (1.25:1) is padded to an exact square;
//      a wider logo keeps its aspect (a wordmark); a wider favicon is refused
//      ('not-square') — unless `pad: true` (a favicon only: a logo keeps its
//      aspect, so pad on a logo is a TypeError), which pads it to an exact
//      square instead: transparent margins on the transparent variant, the tile
//      colour on the tile and touch variants, and a note naming the padding.
//      When the padded content's shorter side would be under TAB_TEXT_MIN_PX
//      device pixels in the TAB_ICON_SIDE px tab, a second note warns that text
//      in it will be unreadable at 16 px.
//   7. tile colour: the caller's, else the flat ground (the artist's), else
//      black (iOS fills a home-screen icon's transparency with black, and the
//      reference tile is black). The touch icon is always opaque.
// An SVG is validated and handed back byte for byte, never rasterised: it gets
// no tile, touch or dark variant, and it takes neither pad nor crop (IconError
// 'svg-as-is': padding or cropping one would mean rasterising it).
// Without pad or crop, prepare is exactly what it was before they existed.

const { decodePng, encodePng, pngSize, PngError } = require('./png');
const { validate, MAX_BYTES, sniff } = require('./brand-image');
const { imageSize } = require('./image-file');

// ── thresholds — every one a named constant, each cheap to change ───────────

const PIXEL_MIN_SIDE = 160;          // pixel art's integer upscale target (the reference's 170 / 190)
const MIN_SIDE = 128;                // §9.6's floor for a stored image
const SMOOTH_MAX_SIDE = 512;         // smooth art is area-averaged down to this
const TOUCH_SIDE = 180;              // the home-screen icon
const TOUCH_CONTENT_SIDE = 160;      // smooth art fits this box on the touch tile
const NEAR_SQUARE = 1.25;            // content this close to square is padded to a square
const SQUARE_TOLERANCE = 0.02;       // an SVG counts as square within 2 % (project-identity's rule)
const MAX_INPUT_BYTES = 32 * 1024 * 1024;
const MAX_INPUT_PIXELS = 25000000;
const CORNER_TOLERANCE = 24;         // four corners this alike are a flat ground
const INK_DISTANCE = 48;             // make-icon.js's ink threshold: further than this from the ground is art
const KEY_RAMP_LOW = 16;             // the soft key: alpha 0 at this distance from the ground …
const KEY_RAMP_HIGH = 48;            // … and 1 at this one
const EDGE_THRESHOLD = 90;           // make-icon.js: a colour edge is a |ΔR|+|ΔG|+|ΔB| over this
const EDGE_SAMPLE_EVERY = 3;         // make-icon.js: edges read on every third row / column
const PITCH_MIN = 2;
const PITCH_MAX = 64;
const PITCH_STEP = 0.02;
const PITCH_BINS = 24;               // make-icon.js's phase histogram
const MIN_EDGES = 8;                 // per axis, before a grid is looked for at all
const GRID_MIN_SCORE = 0.5;          // the joint score a pitch needs before its sprite is even tried
const PITCH_TRIES = 16;              // how many of the best-scoring pitches are reconstructed
const RECONSTRUCT_MAX_ERROR = 12;    // mean |error| per channel a re-rendered sprite may show
const NATIVE_SPRITE_MAX_SIDE = 64;   // an image this small is a sprite at one pixel a cell
const PIXEL_MARGINS = Object.freeze({ transparent: 1, tile: 3, touch: 2 }); // in cells
const SMOOTH_MARGINS = Object.freeze({ transparent: 1 / 32, tile: 3 / 32 }); // of the content's longer side
const SIZE_STEP = 0.8;               // the smooth path's step down while over MAX_BYTES
const DEFAULT_TILE = Object.freeze([0, 0, 0]);

// The dark variant (glint.js, variant A).
const SAT_MIN = 0.25;                // a pixel this saturated has a hue worth swapping
const HUE_BINS = 36;                 // 10° bins
const HUE_SEPARATION = 60;           // the second hue is at least this far from the first; a pixel joins a hue within it
const HUE_MIN_SHARE = 0.05;          // each hue holds at least this share of the saturated weight
const GLINT_MAX_SAT = 0.25;          // a glint pixel is greyer than this …
const GLINT_MIN_VALUE = 0.5;         // … and brighter than this, near the accent
const GLINT_SAT = 0.55;              // the glint takes the major hue at this saturation
const GLINT_VALUE_FLOOR = 0.6;       // and at least this value
const SPARK_SAT = 0.12;              // the whitest glint cells stay a cool white
const SPARK_CELLS = 2;

// Padding a wide favicon (pad: true).
const TAB_ICON_SIDE = 16;            // the tab draws the favicon this many device pixels a side (at 1×)
const TAB_TEXT_MIN_PX = 6;           // padded content shorter than this in the tab: text in it is unreadable

const CONVERT_HINT = 'convert it first — on macOS: sips -s format png <in> --out <out.png>';

class IconError extends Error {
  constructor(code, message, hint) {
    super(message);
    this.name = 'IconError';
    this.code = code;
    this.hint = hint;
  }
}

const unreadable = (why) => new IconError('unreadable', `the image cannot be read: ${why}`, CONVERT_HINT);
const tooLarge = (why) => new IconError('too-large', `the image is too large: ${why}`,
  'scale it down first (a logo needs no more than 512 px a side) — on macOS: sips -Z 512 <in> --out <out.png>');
const notSquare = (why) => new IconError('not-square', `a favicon must be square: ${why}`,
  'a favicon is square: crop the artwork to its mark, or set it as the logo');
const badCrop = (why, W, H) => new IconError('bad-crop', `the crop is not inside the image: ${why}`,
  `the image is ${W}×${H} px: a crop is x,y,w,h in its pixels, with w and h at least 1, x + w ≤ ${W} and y + h ≤ ${H}`);
const svgAsIs = (what) => new IconError('svg-as-is', `an SVG cannot be ${what}: it is stored as it is and never rasterised`,
  'bring a PNG of the artwork to pad or crop it, or a square SVG');
const outputTooLarge = (why) => new IconError('output-too-large', why,
  `a stored image is at most ${MAX_BYTES} bytes: simplify the artwork, or bring a smaller PNG`);

// ── resampling and encoding ─────────────────────────────────────────────────

// Area-average resample. Handles non-integer ratios (512 -> 48), which is why
// this isn't a plain every-Nth-pixel decimation.
function resample(src, sw, sh, dw, dh) {
  const out = Buffer.alloc(dw * dh * 4);
  const fx = sw / dw;
  const fy = sh / dh;
  for (let y = 0; y < dh; y++) {
    const sy0 = Math.floor(y * fy);
    const sy1 = Math.min(sh, Math.ceil((y + 1) * fy));
    for (let x = 0; x < dw; x++) {
      const sx0 = Math.floor(x * fx);
      const sx1 = Math.min(sw, Math.ceil((x + 1) * fx));
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      for (let yy = sy0; yy < sy1; yy++) {
        for (let xx = sx0; xx < sx1; xx++) {
          const i = (yy * sw + xx) * 4;
          const sa = src[i + 3] / 255;
          // Premultiply so transparent pixels don't drag colour into the edges.
          r += src[i] * sa; g += src[i + 1] * sa; b += src[i + 2] * sa; a += sa;
          n++;
        }
      }
      const o = (y * dw + x) * 4;
      if (a > 0) {
        out[o] = Math.round(r / a);
        out[o + 1] = Math.round(g / a);
        out[o + 2] = Math.round(b / a);
      }
      out[o + 3] = Math.round((a / n) * 255);
    }
  }
  return out;
}

// encode(image) → PNG bytes (8-bit RGBA, lib/core/png's one encoder).
function encode(image) {
  return encodePng(image.data, image.width, image.height);
}

// ── loading ─────────────────────────────────────────────────────────────────

// loadImage(bytes) → { format:'png', image:{width,height,data} } or
// { format:'svg', bytes, width, height } (width/height null without a
// viewBox). The size caps are decided before anything is inflated: the byte
// count first, then the PNG's IHDR.
function loadImage(bytes) {
  if (!(bytes instanceof Uint8Array)) throw new TypeError('loadImage takes the image bytes (a Buffer)');
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (buf.length > MAX_INPUT_BYTES) throw tooLarge(`${buf.length} bytes; the limit is ${MAX_INPUT_BYTES}`);
  const format = sniff(buf);
  if (format === 'svg') {
    const size = imageSize(buf);
    return { format: 'svg', bytes: buf, width: size ? size.width : null, height: size ? size.height : null };
  }
  if (format !== 'png') throw unreadable('it is not a PNG or an SVG');
  let size;
  try { size = pngSize(buf); } catch (e) { throw unreadable(e.message); }
  if (size.width * size.height > MAX_INPUT_PIXELS) {
    throw tooLarge(`${size.width}×${size.height} is over ${MAX_INPUT_PIXELS} pixels`);
  }
  try {
    return { format: 'png', image: decodePng(buf) };
  } catch (e) {
    if (e instanceof PngError) throw unreadable(e.message);
    throw e;
  }
}

// ── small helpers ───────────────────────────────────────────────────────────

const gcd = (a, b) => { while (b) [a, b] = [b, a % b]; return a; };
const clamp255 = (v) => (v < 0 ? 0 : v > 255 ? 255 : Math.round(v));
const cheb = (data, i, c) => Math.max(Math.abs(data[i] - c[0]), Math.abs(data[i + 1] - c[1]), Math.abs(data[i + 2] - c[2]));

// detectCell(image) → the GCD of the lengths of every run of identical RGBA
// pixels along every row and every column: the cell of an exact integer
// upscale at phase 0 (5 for the reference icon), else 1.
function detectCell(image) {
  const { width: W, height: H, data } = image;
  const px = new Uint32Array(new Uint8Array(data.subarray(0, W * H * 4)).buffer);
  let g = 0;
  for (let y = 0; y < H; y++) {
    let run = 1;
    for (let x = 1, i = y * W + 1; x < W; x++, i++) {
      if (px[i] === px[i - 1]) { run++; continue; }
      g = gcd(g, run); run = 1;
      if (g === 1) return 1;
    }
    g = gcd(g, run);
    if (g === 1) return 1;
  }
  for (let x = 0; x < W; x++) {
    let run = 1;
    for (let y = 1, i = W + x; y < H; y++, i += W) {
      if (px[i] === px[i - W]) { run++; continue; }
      g = gcd(g, run); run = 1;
      if (g === 1) return 1;
    }
    g = gcd(g, run);
    if (g === 1) return 1;
  }
  return g || 1;
}

// Step 1: 'transparent', { flat: [r,g,b] } or null (none).
function detectBackground({ width: W, height: H, data }) {
  const corners = [0, W - 1, (H - 1) * W, (H - 1) * W + W - 1].map((p) => p * 4);
  if (corners.every((i) => data[i + 3] === 0)) return 'transparent';
  for (let c = 0; c < 4; c++) {
    const vals = corners.map((i) => data[i + c]);
    if (Math.max(...vals) - Math.min(...vals) > CORNER_TOLERANCE) return null;
  }
  return { flat: [0, 1, 2].map((c) => Math.round(corners.reduce((s, i) => s + data[i + c], 0) / 4)) };
}

// Step 2: the content box { x0, y0, x1, y1 } (inclusive), or null when there is
// no content at all.
function contentBox(image, bg) {
  const { width: W, height: H, data } = image;
  if (bg === null) return { x0: 0, y0: 0, x1: W - 1, y1: H - 1 };
  let x0 = W, y0 = H, x1 = -1, y1 = -1;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      if (!data[i + 3]) continue;
      if (bg !== 'transparent' && cheb(data, i, bg.flat) <= INK_DISTANCE) continue;
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
  }
  return x1 < 0 ? null : { x0, y0, x1, y1 };
}

// ── the grid (pixel-art detection) ──────────────────────────────────────────

// Where colour changes sharply along rows (axis 'x') or columns (axis 'y'),
// read on every third line (make-icon.js) — as counts per position. A pixel's
// colour is taken over black, so a transparent ground reads as black.
function edgeCounts({ width: W, height: H, data }, axis) {
  const [len, other] = axis === 'x' ? [W, H] : [H, W];
  const counts = new Float64Array(len);
  let total = 0;
  const col = (i, c) => (data[i + c] * data[i + 3]) / 255;
  for (let o = 0; o < other; o += EDGE_SAMPLE_EVERY) {
    for (let t = 1; t < len; t++) {
      const i = axis === 'x' ? (o * W + t) * 4 : (t * W + o) * 4;
      const j = axis === 'x' ? i - 4 : i - W * 4;
      const d = Math.abs(col(i, 0) - col(j, 0)) + Math.abs(col(i, 1) - col(j, 1)) + Math.abs(col(i, 2) - col(j, 2));
      if (d > EDGE_THRESHOLD) { counts[t]++; total++; }
    }
  }
  const ts = []; const ns = [];
  for (let t = 0; t < len; t++) if (counts[t]) { ts.push(t); ns.push(counts[t]); }
  return { ts, ns, total };
}

// One axis at one pitch: the phase (where the grid lines sit: the mean
// position, modulo the pitch, of the edges in make-icon.js's peak histogram
// bin) and a concentration score in 0..1 — 1 when every edge is on a grid
// line, about 0 for edges spread at random — from the edges' mean distance to
// the nearest line, relative to the pitch.
function axisScore({ ts, ns, total }, p) {
  const hist = new Float64Array(PITCH_BINS);
  const res = new Float64Array(ts.length);
  for (let k = 0; k < ts.length; k++) {
    const r = ts[k] % p;
    res[k] = r;
    hist[Math.floor((r / p) * PITCH_BINS) % PITCH_BINS] += ns[k];
  }
  let peak = 0;
  for (let b = 1; b < PITCH_BINS; b++) if (hist[b] > hist[peak]) peak = b;
  let sum = 0; let n = 0;
  for (let k = 0; k < ts.length; k++) {
    if (Math.floor((res[k] / p) * PITCH_BINS) % PITCH_BINS === peak) { sum += res[k] * ns[k]; n += ns[k]; }
  }
  const phase = sum / n;
  let dist = 0;
  for (let k = 0; k < ts.length; k++) {
    const d = Math.abs(res[k] - phase);
    dist += Math.min(d, p - d) * ns[k];
  }
  const score = Math.max(0, 1 - (4 * dist) / (total * p));
  return { phase, score };
}

// The candidate grids, best first: every pitch PITCH_MIN..PITCH_MAX in steps
// of PITCH_STEP, the two axes' scores multiplied (scoring an axis alone locks
// onto harmonics), ties to the larger pitch — a pitch's divisors fit its edges
// exactly as well, and the coarsest grid that fits is the art's.
function gridCandidates(image) {
  const ex = edgeCounts(image, 'x');
  const ey = edgeCounts(image, 'y');
  if (ex.total < MIN_EDGES || ey.total < MIN_EDGES) return [];
  const out = [];
  const steps = Math.round((PITCH_MAX - PITCH_MIN) / PITCH_STEP);
  for (let s = 0; s <= steps; s++) {
    const p = Math.round((PITCH_MIN + s * PITCH_STEP) * 100) / 100;
    const ax = axisScore(ex, p);
    const ay = axisScore(ey, p);
    const score = ax.score * ay.score;
    if (score >= GRID_MIN_SCORE) out.push({ pitch: p, startX: ax.phase, startY: ay.phase, score });
  }
  out.sort((a, b) => (Math.abs(b.score - a.score) > 1e-9 ? b.score - a.score : b.pitch - a.pitch));
  return out.slice(0, PITCH_TRIES);
}

// Sample each cell of `grid` over the content box at its centre: the median,
// by R+G+B, of a small centre patch (make-icon.js). → { cells, cols, rows, cx0, cy0 }
// with cells[r][c] = [r,g,b,a] or null where the centre is off the image.
function sampleGrid(image, box, grid) {
  const { width: W, height: H, data } = image;
  const { pitch, startX, startY } = grid;
  const cx0 = Math.floor((box.x0 - startX) / pitch);
  const cy0 = Math.floor((box.y0 - startY) / pitch);
  const cols = Math.floor((box.x1 - startX) / pitch) + 1 - cx0;
  const rows = Math.floor((box.y1 - startY) / pitch) + 1 - cy0;
  // make-icon.js's patch around the rounded centre, for a cell of 4 px or
  // more; under that a 3×3 patch would reach into the next cell (at one pixel
  // a cell it is a median filter), so the sample is the one pixel the centre
  // point falls in.
  const k = pitch >= 4 ? Math.max(1, Math.floor(pitch / 5)) : 0;
  const centre = k ? Math.round : Math.floor;
  const cells = [];
  for (let r = 0; r < rows; r++) {
    const row = [];
    for (let c = 0; c < cols; c++) {
      const mx = centre(startX + (cx0 + c + 0.5) * pitch);
      const my = centre(startY + (cy0 + r + 0.5) * pitch);
      const samples = [];
      for (let dy = -k; dy <= k; dy++) {
        for (let dx = -k; dx <= k; dx++) {
          const x = mx + dx; const y = my + dy;
          if (x >= 0 && y >= 0 && x < W && y < H) {
            const i = (y * W + x) * 4;
            samples.push([data[i], data[i + 1], data[i + 2], data[i + 3]]);
          }
        }
      }
      samples.sort((a, b) => (a[0] + a[1] + a[2]) - (b[0] + b[1] + b[2]));
      row.push(samples[Math.floor(samples.length / 2)] || null);
    }
    cells.push(row);
  }
  return { cells, cols, rows, cx0, cy0 };
}

// How far the sampled sprite, drawn back at its grid, is from the content box:
// the mean |error| of the worst channel. Stops counting once it is over `limit`.
function gridError(image, box, grid, sampled, limit = Infinity) {
  const { width: W, data } = image;
  const { pitch, startX, startY } = grid;
  const n = (box.x1 - box.x0 + 1) * (box.y1 - box.y0 + 1);
  const sums = [0, 0, 0, 0];
  const cap = limit * n;
  const none = [0, 0, 0, 0];
  for (let y = box.y0; y <= box.y1; y++) {
    const row = sampled.cells[Math.floor((y - startY) / pitch) - sampled.cy0] || [];
    for (let x = box.x0; x <= box.x1; x++) {
      const c = row[Math.floor((x - startX) / pitch) - sampled.cx0] || none;
      const i = (y * W + x) * 4;
      for (let ch = 0; ch < 4; ch++) sums[ch] += Math.abs(data[i + ch] - c[ch]);
    }
    if (Math.max(...sums) > cap) return Infinity;
  }
  return Math.max(...sums) / n;
}

// Step 3: the grid the art sits on, or null (smooth art).
// → { pitch, startX, startY, sampled, how } where `how` is 'exact', 'grid' or 'native'.
function findGrid(image, box, mode) {
  const cell = detectCell(image);
  if (cell > 1) {
    const grid = { pitch: cell, startX: 0, startY: 0 };
    return { ...grid, sampled: sampleGrid(image, box, grid), how: 'exact' };
  }
  for (const grid of gridCandidates(image)) {
    const sampled = sampleGrid(image, box, grid);
    if (mode === 'pixel' || gridError(image, box, grid, sampled, RECONSTRUCT_MAX_ERROR) < RECONSTRUCT_MAX_ERROR) {
      return { pitch: grid.pitch, startX: grid.startX, startY: grid.startY, sampled, how: 'grid' };
    }
  }
  if (mode === 'pixel' || Math.max(image.width, image.height) <= NATIVE_SPRITE_MAX_SIDE) {
    const grid = { pitch: 1, startX: 0, startY: 0 };
    return { ...grid, sampled: sampleGrid(image, box, grid), how: 'native' };
  }
  return null;
}

// ── pixel path ──────────────────────────────────────────────────────────────

// Key and trim the sampled cells (make-icon.js): a cell is art when it is not
// transparent and, on a flat ground, further than INK_DISTANCE from it; empty
// border rows and columns go. → { w, h, cells } with null for an empty cell.
function trimSprite(sampled, bg) {
  const art = (c) => Boolean(c) && c[3] > 0 && !(bg && bg.flat && Math.max(
    Math.abs(c[0] - bg.flat[0]), Math.abs(c[1] - bg.flat[1]), Math.abs(c[2] - bg.flat[2])) <= INK_DISTANCE);
  const { cells, rows, cols } = sampled;
  let t0 = 0, t1 = rows - 1, l0 = 0, l1 = cols - 1;
  const rowEmpty = (r) => cells[r].every((c) => !art(c));
  const colEmpty = (c) => cells.every((row) => !art(row[c]));
  while (t0 < t1 && rowEmpty(t0)) t0++;
  while (t1 > t0 && rowEmpty(t1)) t1--;
  while (l0 < l1 && colEmpty(l0)) l0++;
  while (l1 > l0 && colEmpty(l1)) l1--;
  const out = [];
  let any = false;
  for (let r = t0; r <= t1; r++) {
    const row = [];
    for (let c = l0; c <= l1; c++) { const v = art(cells[r][c]) ? cells[r][c] : null; any = any || Boolean(v); row.push(v); }
    out.push(row);
  }
  return any ? { w: l1 - l0 + 1, h: t1 - t0 + 1, cells: out } : null;
}

// Write one RGBA colour at byte offset o: as it is, or over an opaque fill.
function put(out, o, c, fill) {
  if (!fill || c[3] === 255) { out[o] = c[0]; out[o + 1] = c[1]; out[o + 2] = c[2]; out[o + 3] = fill ? 255 : c[3]; return; }
  const a = c[3] / 255;
  out[o] = clamp255(c[0] * a + fill[0] * (1 - a));
  out[o + 1] = clamp255(c[1] * a + fill[1] * (1 - a));
  out[o + 2] = clamp255(c[2] * a + fill[2] * (1 - a));
  out[o + 3] = 255;
}

// The sprite centred on a canvas `margin` cells wider each side (square, or of
// the sprite's own aspect), upscaled nearest-neighbour by `scale`, on
// transparency or an opaque `fill`.
function renderSprite(sprite, { margin, scale, square, fill }) {
  const { w: sw, h: sh, cells } = sprite;
  const cw = (square ? Math.max(sw, sh) : sw) + margin * 2;
  const chh = (square ? Math.max(sw, sh) : sh) + margin * 2;
  const offX = Math.floor((cw - sw) / 2);
  const offY = Math.floor((chh - sh) / 2);
  const width = cw * scale; const height = chh * scale;
  const data = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    const row = cells[Math.floor(y / scale) - offY];
    for (let x = 0; x < width; x++) {
      const c = row && row[Math.floor(x / scale) - offX];
      const o = (y * width + x) * 4;
      if (c) put(data, o, c, fill);
      else if (fill) put(data, o, [fill[0], fill[1], fill[2], 255], null);
    }
  }
  return { width, height, data };
}

// An opaque `side`-square canvas of `fill` with `img` composited at its centre.
function onTile(img, side, fill) {
  const data = Buffer.alloc(side * side * 4);
  for (let i = 0; i < side * side; i++) put(data, i * 4, [fill[0], fill[1], fill[2], 255], null);
  const ox = Math.floor((side - img.width) / 2);
  const oy = Math.floor((side - img.height) / 2);
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      const s = (y * img.width + x) * 4;
      if (!img.data[s + 3]) continue;
      put(data, ((y + oy) * side + (x + ox)) * 4, [img.data[s], img.data[s + 1], img.data[s + 2], img.data[s + 3]], fill);
    }
  }
  return { width: side, height: side, data };
}

function pixelVariants(sprite, { square, tile }) {
  const side = (m) => Math.max(sprite.w, sprite.h) + m * 2;
  const scaleFor = (m) => Math.max(1, Math.ceil(PIXEL_MIN_SIDE / side(m)));
  const scale = scaleFor(PIXEL_MARGINS.transparent);
  const transparent = renderSprite(sprite, { margin: PIXEL_MARGINS.transparent, scale, square, fill: null });
  const tileImg = renderSprite(sprite, { margin: PIXEL_MARGINS.tile, scale: scaleFor(PIXEL_MARGINS.tile), square, fill: tile });
  const touchSide = side(PIXEL_MARGINS.touch);
  const touchScale = Math.floor(TOUCH_SIDE / touchSide);
  let touch;
  if (touchScale >= 1) {
    touch = onTile(renderSprite(sprite, { margin: PIXEL_MARGINS.touch, scale: touchScale, square: true, fill: tile }), TOUCH_SIDE, tile);
  } else {
    const big = renderSprite(sprite, { margin: PIXEL_MARGINS.touch, scale: 1, square: true, fill: tile });
    touch = { width: TOUCH_SIDE, height: TOUCH_SIDE, data: resample(big.data, big.width, big.height, TOUCH_SIDE, TOUCH_SIDE) };
  }
  return { scale, images: { transparent, tile: tileImg, touch } };
}

// ── smooth path ─────────────────────────────────────────────────────────────

function crop({ width: W, data }, box) {
  const width = box.x1 - box.x0 + 1; const height = box.y1 - box.y0 + 1;
  const out = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) data.copy(out, y * width * 4, ((box.y0 + y) * W + box.x0) * 4, ((box.y0 + y) * W + box.x1 + 1) * 4);
  return { width, height, data: out };
}

// The soft key: alpha ramps from 0 at KEY_RAMP_LOW to 1 at KEY_RAMP_HIGH
// (Chebyshev distance from the ground), and each channel is un-mixed from the
// ground so an antialiased edge keeps the art's colour, not a halo.
function keySoft(img, bgc) {
  const out = Buffer.alloc(img.data.length);
  const { data } = img;
  for (let i = 0; i < data.length; i += 4) {
    const k = Math.min(1, Math.max(0, (cheb(data, i, bgc) - KEY_RAMP_LOW) / (KEY_RAMP_HIGH - KEY_RAMP_LOW)));
    if (!k || !data[i + 3]) continue;
    for (let c = 0; c < 3; c++) out[i + c] = clamp255((data[i + c] - bgc[c] * (1 - k)) / k);
    out[i + 3] = Math.round(k * data[i + 3]);
  }
  return { width: img.width, height: img.height, data: out };
}

function scaled(img, w, h) {
  if (w === img.width && h === img.height) return img;
  return { width: w, height: h, data: resample(img.data, img.width, img.height, w, h) };
}

// `img` centred on a canvas of cw×ch, transparent or on an opaque fill.
function framed(img, cw, chh, fill) {
  const data = Buffer.alloc(cw * chh * 4);
  if (fill) for (let i = 0; i < cw * chh; i++) put(data, i * 4, [fill[0], fill[1], fill[2], 255], null);
  const ox = Math.floor((cw - img.width) / 2);
  const oy = Math.floor((chh - img.height) / 2);
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      const s = (y * img.width + x) * 4;
      if (!img.data[s + 3] && fill) continue;
      put(data, ((y + oy) * cw + (x + ox)) * 4, [img.data[s], img.data[s + 1], img.data[s + 2], img.data[s + 3]], fill);
    }
  }
  return { width: cw, height: chh, data };
}

const marginOf = (c, frac) => Math.round(c * frac);
// The content's longer side bounds that keep every variant within
// MIN_SIDE..SMOOTH_MAX_SIDE: the transparent one (the smallest margin) at least
// MIN_SIDE, the tile (the largest) at most SMOOTH_MAX_SIDE.
const SMOOTH_MIN_CONTENT = (() => { let c = 1; while (c + 2 * marginOf(c, SMOOTH_MARGINS.transparent) < MIN_SIDE) c++; return c; })();
const SMOOTH_MAX_CONTENT = (() => { let c = SMOOTH_MAX_SIDE; while (c + 2 * marginOf(c, SMOOTH_MARGINS.tile) > SMOOTH_MAX_SIDE) c--; return c; })();

function smoothVariants(content, { square, tile, longer }) {
  const L = Math.max(content.width, content.height);
  const img = scaled(content,
    Math.max(1, Math.round((content.width * longer) / L)),
    Math.max(1, Math.round((content.height * longer) / L)));
  const make = (frac, fill) => {
    const m = marginOf(longer, frac);
    const cw = (square ? Math.max(img.width, img.height) : img.width) + 2 * m;
    const chh = (square ? Math.max(img.width, img.height) : img.height) + 2 * m;
    return framed(img, cw, chh, fill);
  };
  const fit = TOUCH_CONTENT_SIDE / L;
  const touchContent = scaled(content, Math.max(1, Math.round(content.width * fit)), Math.max(1, Math.round(content.height * fit)));
  return {
    transparent: make(SMOOTH_MARGINS.transparent, null),
    tile: make(SMOOTH_MARGINS.tile, tile),
    touch: onTile(touchContent, TOUCH_SIDE, tile),
  };
}

// ── prepare ─────────────────────────────────────────────────────────────────

const KINDS = ['logo', 'favicon'];
const MODES = ['auto', 'pixel', 'smooth'];

function checkOptions({ kind, mode = 'auto', tile = null, pad = false, crop = null } = {}) {
  if (!KINDS.includes(kind)) throw new TypeError(`prepare: kind must be one of ${KINDS.join(', ')}`);
  if (!MODES.includes(mode)) throw new TypeError(`prepare: mode must be one of ${MODES.join(', ')}`);
  if (tile !== null && !(Array.isArray(tile) && tile.length === 3 && tile.every((v) => Number.isInteger(v) && v >= 0 && v <= 255))) {
    throw new TypeError('prepare: tile must be [r, g, b] (integers 0–255) or null');
  }
  if (typeof pad !== 'boolean') throw new TypeError('prepare: pad must be true or false');
  if (pad && kind !== 'favicon') throw new TypeError('prepare: pad is for a favicon only — a logo keeps its aspect');
  if (crop !== null && !(crop && typeof crop === 'object' && ['x', 'y', 'w', 'h'].every((k) => Number.isInteger(crop[k])))) {
    throw new TypeError('prepare: crop must be { x, y, w, h } (integers, in source pixels) or null');
  }
  return { kind, mode, tile, pad, crop: crop && { x: crop.x, y: crop.y, w: crop.w, h: crop.h } };
}

// Step 0: the source cut to the crop box, which must lie inside it.
function cropSource(image, { x, y, w, h }) {
  const { width: W, height: H } = image;
  if (w < 1 || h < 1) throw badCrop(`a ${w}×${h} box is empty`, W, H);
  if (x < 0 || y < 0 || x + w > W || y + h > H) throw badCrop(`${w}×${h} at ${x},${y} reaches past its ${W}×${H} px`, W, H);
  return crop(image, { x0: x, y0: y, x1: x + w - 1, y1: y + h - 1 });
}

// The notes a padded favicon carries: the padding, and — when the content's
// shorter side is under TAB_TEXT_MIN_PX in the tab — that text will not read.
// `short`/`long` are the content's sides in the transparent variant, whose
// side is `side`.
function padNotes(padded, short, side) {
  const across = padded.w >= padded.h ? 'above and below' : 'left and right';
  const notes = [`padded to a square: the ${padded.w}×${padded.h} ${padded.unit} artwork (${padded.ratio.toFixed(2)}:1) is centred, `
    + `with margins ${across} — transparent on the transparent variant, the tile colour on the tile and the home-screen icon`];
  const inTab = (TAB_ICON_SIDE * short) / side;
  if (inTab < TAB_TEXT_MIN_PX) {
    notes.push(`in the ${TAB_ICON_SIDE} px tab the padded artwork is only ${inTab.toFixed(1)} px ${padded.w >= padded.h ? 'tall' : 'wide'}: `
      + `text in it will be unreadable at ${TAB_ICON_SIDE} px`);
  }
  return notes;
}

// Encode each variant and check it the way the store will (brand-image
// validate). → { name: { image, bytes } } or null when one is over MAX_BYTES.
function encodeAll(images) {
  const out = {};
  for (const [name, image] of Object.entries(images)) {
    const bytes = encode(image);
    if (bytes.length > MAX_BYTES) return null;
    validate(bytes);
    out[name] = { image, bytes };
  }
  return out;
}

function prepareSvg(loaded, kind) {
  try { validate(loaded.bytes); } catch (e) {
    if (e.status === 422) {
      throw new IconError('svg-refused', e.message,
        'save it as a plain SVG (no script, event handler, link animation or foreign markup), or export a PNG');
    }
    if (e.status === 413) throw outputTooLarge(`an SVG is stored as it is, and this one is ${loaded.bytes.length} bytes`);
    throw unreadable(e.message);
  }
  const { width, height } = loaded;
  const sized = width > 0 && height > 0;
  const square = sized && Math.abs(width - height) <= SQUARE_TOLERANCE * Math.max(width, height);
  if (kind === 'favicon' && !square) {
    throw notSquare(sized ? `this SVG's viewBox is ${width}×${height}` : 'this SVG has no viewBox to tell its shape by');
  }
  const notes = ['an SVG is stored as it is, never rasterised: it has no tile, touch or dark variant'];
  if (!sized) notes.push('it has no viewBox, so its size and shape are unknown');
  return { format: 'svg', bytes: loaded.bytes, width: sized ? width : null, height: sized ? height : null, square, notes };
}

// prepare(bytes, { kind: 'logo'|'favicon', mode = 'auto', tile = null,
// pad = false, crop = null }) — see the header. Throws IconError ('unreadable',
// 'too-large', 'not-square', 'svg-refused', 'output-too-large', 'bad-crop',
// 'svg-as-is') or TypeError for a bad option (pad on a logo among them).
function prepare(bytes, options) {
  const { kind, mode, tile: tileOpt, pad, crop: cropBox } = checkOptions(options);
  const loaded = loadImage(bytes);
  if (loaded.format === 'svg') {
    if (pad || cropBox) throw svgAsIs([pad && 'padded', cropBox && 'cropped'].filter(Boolean).join(' or '));
    return prepareSvg(loaded, kind);
  }

  const notes = [];
  let { image } = loaded;
  if (cropBox) {
    const { width: W, height: H } = image;
    image = cropSource(image, cropBox);
    notes.push(`cropped to ${cropBox.w}×${cropBox.h} at ${cropBox.x},${cropBox.y} of the ${W}×${H} image`);
  }
  const bg = detectBackground(image);
  const box = contentBox(image, bg);
  if (!box) throw unreadable('it has no content — every pixel is its background');
  notes.push(bg === 'transparent' ? 'background: transparent, kept'
    : bg ? `background: flat rgb(${bg.flat.join(', ')}), keyed out`
      : 'background: none found (no keying), cropped to the whole image');
  const tile = tileOpt || (bg && bg.flat) || [...DEFAULT_TILE];

  const grid = mode === 'smooth' ? null : findGrid(image, box, mode);
  // A favicon wider than NEAR_SQUARE is padded (pad) or refused; `padded`
  // remembers it for the notes.
  let padded = null;
  const shapeOf = (w, h) => {
    const ratio = Math.max(w, h) / Math.min(w, h);
    if (ratio <= NEAR_SQUARE) return true;
    if (kind === 'favicon') {
      if (!pad) throw notSquare(`its artwork is ${w}×${h}${grid ? ' cells' : ' px'}, ${ratio.toFixed(2)}:1`);
      padded = { w, h, ratio, unit: grid ? 'cell' : 'px' };
      return true;
    }
    return false;
  };

  if (grid) {
    const sprite = trimSprite(grid.sampled, bg);
    if (!sprite) throw unreadable('it has no content once sampled on its pixel grid');
    const square = shapeOf(sprite.w, sprite.h);
    if (!square) notes.push(`a wordmark (${sprite.w}×${sprite.h} cells): its aspect is kept`);
    else if (sprite.w !== sprite.h && !padded) notes.push(`${sprite.w}×${sprite.h} cells, padded to a square`);
    const { scale, images } = pixelVariants(sprite, { square, tile });
    const encoded = encodeAll(images);
    if (!encoded) throw outputTooLarge(`the pixel-art variants encode over ${MAX_BYTES} bytes`);
    if (padded) notes.push(...padNotes(padded, Math.min(sprite.w, sprite.h) * scale, encoded.transparent.image.width));
    const pitch = Math.round(grid.pitch * 100) / 100;
    notes.unshift(grid.how === 'native'
      ? `pixel art: a native ${sprite.w}×${sprite.h} sprite (one pixel a cell), upscaled ×${scale}`
      : `pixel art: a ${pitch} px grid${grid.how === 'exact' ? ' (an exact upscale)' : ''}, ${sprite.w}×${sprite.h} cells, upscaled ×${scale}`);
    return {
      format: 'png',
      pixel_art: true,
      source_cell: pitch,
      scale,
      cell: scale,
      square: encoded.transparent.image.width === encoded.transparent.image.height,
      background: bg === 'transparent' ? 'transparent' : bg ? [...bg.flat] : null,
      variants: {
        transparent: encoded.transparent,
        tile: { ...encoded.tile, colour: [...tile] },
        touch: encoded.touch,
      },
      notes,
    };
  }

  // Smooth art.
  let content = crop(image, box);
  if (bg && bg.flat) content = keySoft(content, bg.flat);
  const square = shapeOf(content.width, content.height);
  if (!square) notes.push(`a wordmark (${content.width}×${content.height} px): its aspect is kept`);
  const L = Math.max(content.width, content.height);
  let longer = Math.min(Math.max(L, SMOOTH_MIN_CONTENT), SMOOTH_MAX_CONTENT);
  if (L < SMOOTH_MIN_CONTENT) notes.push(`upscaled from ${L} px — smooth art loses detail past its native size`);
  else if (L > SMOOTH_MAX_CONTENT) notes.push(`scaled down from ${L} px`);
  let encoded;
  for (;;) {
    encoded = encodeAll(smoothVariants(content, { square, tile, longer }));
    if (encoded) break;
    if (longer <= SMOOTH_MIN_CONTENT) throw outputTooLarge(`even at ${MIN_SIDE} px the image encodes over ${MAX_BYTES} bytes`);
    longer = Math.max(SMOOTH_MIN_CONTENT, Math.floor(longer * SIZE_STEP));
    notes.push(`stepped down to ${longer} px to stay under ${MAX_BYTES} bytes`);
  }
  if (padded) {
    const short = (Math.min(content.width, content.height) * longer) / L;
    notes.push(...padNotes(padded, short, encoded.transparent.image.width));
  }
  notes.unshift('smooth art: area-averaged');
  return {
    format: 'png',
    pixel_art: false,
    source_cell: null,
    scale: null,
    cell: 1,
    square: encoded.transparent.image.width === encoded.transparent.image.height,
    background: bg === 'transparent' ? 'transparent' : bg ? [...bg.flat] : null,
    variants: {
      transparent: encoded.transparent,
      tile: { ...encoded.tile, colour: [...tile] },
      touch: encoded.touch,
    },
    notes,
  };
}

// ── the dark variant (glint.js, variant A) ──────────────────────────────────

function rgb2hsv(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  let h = 0;
  if (d) { if (max === r) h = ((g - b) / d) % 6; else if (max === g) h = (b - r) / d + 2; else h = (r - g) / d + 4; h *= 60; if (h < 0) h += 360; }
  return [h, max ? d / max : 0, max];
}

function hsv2rgb(h, s, v) {
  const c = v * s, x = c * (1 - Math.abs(((h / 60) % 2) - 1)), m = v - c;
  let r = 0, g = 0, b = 0;
  if (h < 60) [r, g, b] = [c, x, 0]; else if (h < 120) [r, g, b] = [x, c, 0];
  else if (h < 180) [r, g, b] = [0, c, x]; else if (h < 240) [r, g, b] = [0, x, c];
  else if (h < 300) [r, g, b] = [x, 0, c]; else [r, g, b] = [c, 0, x];
  return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
}

const hueDist = (a, b) => { const d = Math.abs(a - b) % 360; return d > 180 ? 360 - d : d; };

// darkVariant(image, { cell }) → { image, hues: { major, minor } } or null when
// the artwork has no two dominant hues. Swaps the two hues (each pixel keeps
// its saturation and value), tints the glint — the grey highlight pixels within
// cell + 1 px of the accent — toward the major hue, and keeps the two whitest
// glint cells a cool white. Transparency and every other grey are untouched.
function darkVariant(image, { cell } = {}) {
  const { width: W, height: H, data: src } = image;
  if (cell === undefined || cell === null) cell = detectCell(image);
  const n = W * H;
  const hue = new Float64Array(n); const sat = new Float64Array(n); const val = new Float64Array(n);
  const weights = new Float64Array(HUE_BINS);
  let total = 0;
  for (let p = 0; p < n; p++) {
    const i = p * 4;
    if (!src[i + 3]) continue;
    const [h, s, v] = rgb2hsv(src[i], src[i + 1], src[i + 2]);
    hue[p] = h; sat[p] = s; val[p] = v;
    if (s >= SAT_MIN) { weights[Math.min(HUE_BINS - 1, Math.floor(h / (360 / HUE_BINS)))] += s * v; total += s * v; }
  }
  if (!total) return null;
  const binHue = (b) => (b + 0.5) * (360 / HUE_BINS);
  let first = 0;
  for (let b = 1; b < HUE_BINS; b++) if (weights[b] > weights[first]) first = b;
  let second = -1;
  for (let b = 0; b < HUE_BINS; b++) {
    if (hueDist(binHue(b), binHue(first)) < HUE_SEPARATION) continue;
    if (second < 0 || weights[b] > weights[second]) second = b;
  }
  if (second < 0 || weights[first] < HUE_MIN_SHARE * total || weights[second] < HUE_MIN_SHARE * total) return null;

  // Classify, and measure each class's hue as swap-hues.js did: the circular
  // mean weighted by s × v, to 0.1°.
  const cls = new Uint8Array(n); // 0 none, 1 first, 2 second
  const acc = [null, { x: 0, y: 0, w: 0 }, { x: 0, y: 0, w: 0 }];
  for (let p = 0; p < n; p++) {
    if (!src[p * 4 + 3] || sat[p] < SAT_MIN) continue;
    const d1 = hueDist(hue[p], binHue(first)); const d2 = hueDist(hue[p], binHue(second));
    if (Math.min(d1, d2) > HUE_SEPARATION) continue;
    const k = d1 <= d2 ? 1 : 2;
    cls[p] = k;
    const w = sat[p] * val[p];
    acc[k].x += Math.cos(hue[p] * Math.PI / 180) * w; acc[k].y += Math.sin(hue[p] * Math.PI / 180) * w; acc[k].w += w;
  }
  const meanHue = ({ x, y }) => { let h = Math.atan2(y, x) * 180 / Math.PI; if (h < 0) h += 360; return +h.toFixed(1); };
  const majorK = acc[1].w >= acc[2].w ? 1 : 2;
  const minorK = 3 - majorK;
  const major = meanHue(acc[majorK]);
  const minor = meanHue(acc[minorK]);

  // Accent (minor) neighbourhoods, by a summed-area table.
  const sum = new Int32Array((W + 1) * (H + 1));
  for (let y = 0; y < H; y++) {
    let run = 0;
    for (let x = 0; x < W; x++) {
      run += cls[y * W + x] === minorK ? 1 : 0;
      sum[(y + 1) * (W + 1) + x + 1] = sum[y * (W + 1) + x + 1] + run;
    }
  }
  const r = cell + 1;
  const accentNear = (x, y) => {
    const xa = Math.max(0, x - r), xb = Math.min(W - 1, x + r) + 1;
    const ya = Math.max(0, y - r), yb = Math.min(H - 1, y + r) + 1;
    return sum[yb * (W + 1) + xb] - sum[ya * (W + 1) + xb] - sum[yb * (W + 1) + xa] + sum[ya * (W + 1) + xa] > 0;
  };
  const keyOf = (x, y) => `${Math.floor(x / cell)},${Math.floor(y / cell)}`;
  const glint = [];
  const glintSet = new Set();
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const p = y * W + x;
      if (!src[p * 4 + 3]) continue;
      if (sat[p] < GLINT_MAX_SAT && val[p] > GLINT_MIN_VALUE && accentNear(x, y)) {
        glint.push({ s: sat[p], v: val[p], key: keyOf(x, y) });
        glintSet.add(p);
      }
    }
  }
  // glint.js's spark: per cell the last glint pixel (in the order cells first
  // appear), ranked whitest first (v − s) by a stable sort; the top two cells.
  const ranked = [...new Map(glint.map((g) => [g.key, g])).values()].sort((a, b) => (b.v - b.s) - (a.v - a.s));
  const spark = new Set(ranked.slice(0, SPARK_CELLS).map((g) => g.key));

  const out = Buffer.from(src.subarray(0, n * 4));
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const p = y * W + x; const i = p * 4;
      if (!src[i + 3]) continue;
      let rgb = null;
      if (cls[p] === majorK) rgb = hsv2rgb(minor, sat[p], val[p]);
      else if (cls[p] === minorK) rgb = hsv2rgb(major, sat[p], val[p]);
      else if (glintSet.has(p)) rgb = hsv2rgb(major, spark.has(keyOf(x, y)) ? SPARK_SAT : GLINT_SAT, Math.max(val[p], GLINT_VALUE_FLOOR));
      if (rgb) { out[i] = rgb[0]; out[i + 1] = rgb[1]; out[i + 2] = rgb[2]; }
    }
  }
  return { image: { width: W, height: H, data: out }, hues: { major, minor } };
}

module.exports = {
  // the thresholds
  PIXEL_MIN_SIDE, MIN_SIDE, SMOOTH_MAX_SIDE, TOUCH_SIDE, TOUCH_CONTENT_SIDE, NEAR_SQUARE, SQUARE_TOLERANCE,
  MAX_INPUT_BYTES, MAX_INPUT_PIXELS, CORNER_TOLERANCE, INK_DISTANCE, KEY_RAMP_LOW, KEY_RAMP_HIGH,
  EDGE_THRESHOLD, EDGE_SAMPLE_EVERY, PITCH_MIN, PITCH_MAX, PITCH_STEP, PITCH_BINS, MIN_EDGES, GRID_MIN_SCORE,
  PITCH_TRIES, RECONSTRUCT_MAX_ERROR, NATIVE_SPRITE_MAX_SIDE, PIXEL_MARGINS, SMOOTH_MARGINS, SIZE_STEP,
  DEFAULT_TILE, SAT_MIN, HUE_BINS, HUE_SEPARATION, HUE_MIN_SHARE, GLINT_MAX_SAT, GLINT_MIN_VALUE, GLINT_SAT,
  GLINT_VALUE_FLOOR, SPARK_SAT, SPARK_CELLS, TAB_ICON_SIDE, TAB_TEXT_MIN_PX, CONVERT_HINT,
  // the engine
  IconError, loadImage, prepare, darkVariant, detectCell, resample, encode,
};
