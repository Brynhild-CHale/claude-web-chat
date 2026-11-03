// The stroke group's description: what Claude reads about a stroke (annotation
// engine tranche 4, plan 4F.2, U562; DECISIONS.md N.1 AD3, AD5; K.5 J2; D2;
// rulings STREAM@4F AF1 (a), EXCERPT@switch-kept AF6 (a), DESCRIBE@where).
//
// PURE: this file requires and imports nothing, reads no clock and holds no
// state. Generic to any strokes type (a `place: 'box'` type whose records carry
// lib/core/strokes' STROKE_KEYS): it names no tool, no colour and no pack, so a
// pack's type needs only its draw and a thin create (AD3).
//
//   classify(strokes, {textBox, textBoxes, aspect}) → {shape, confidence}
//     strokes    an array of flat point arrays [x0, y0, p0, t0, x1, …] in the
//                target frame's 0..1 units (lib/core/strokes' stride, STRIDE)
//     textBox    the union of the members' text boxes [x, y, w, h] (frame
//                units), or null
//     textBoxes  optional, per stroke: a stroke's own text box, preferred to
//                the union when it is one (so three underlines under three
//                lines each read against their own line)
//     aspect     optional, the frame's w ÷ h (default 1), so an angle and a
//                closure are measured on the target's real proportions
//   shape is one word of SHAPES — the closed list, the only text this module
//   ever emits — from point features alone: the closure (end-to-start
//   distance over the path length), the straightness (the same chord over the
//   length, for an open stroke), the dominant angle, the corners of the
//   stroke simplified at CORNER_TOL of its size, the total turning, and the
//   stroke count. A near-flat horizontal stroke reads against its text box:
//   its mean height in or below the box's lower UNDERLINE_BAND → 'underline',
//   in the middle band from STRIKE_TOP → 'strike', above that → 'other'; with
//   no text box, a flat stroke reads 'underline'. confidence is 0..1 (two
//   decimals); anything under CONFIDENCE_MIN answers 'other'. Every threshold
//   is an exported constant.
//
//   describeOf(records) → {shape, confidence, count, bbox, text_under}
//     records: the SHARED members of ONE stroke group (the caller filters: a
//     private stroke is never passed, K.5 J2), each a stroke record {points,
//     stride, aspect?, text_under?, text_box?}. count is the members that carry
//     a stroke; bbox the union of their points' boxes (frame units, 1e-4);
//     text_under the members' own text_under, de-duplicated in member order,
//     joined with ' … ' and cut at TEXT_UNDER_MAX (with …). The text is the
//     caller's to gate (the excerpt switch, the redactor, excerptText): it is
//     never part of the shape.

const STRIDE = 4;
const SHAPES = Object.freeze(['circle', 'underline', 'strike', 'arrow', 'check', 'cross', 'other']);
const CONFIDENCE_MIN = 0.5;
const TEXT_UNDER_MAX = 300;
const TEXT_JOIN = ' … ';

// A line: chord ÷ length at least LINE_STRAIGHT; flat when its angle is
// within FLAT_DEG of horizontal.
const LINE_STRAIGHT = 0.9;
const FLAT_DEG = 20;
// A cross's or an arrow shaft's line may be a little less straight.
const CROSS_STRAIGHT = 0.85;
// The text band: the stroke's mean height relative to the text box (0 the
// top, 1 the bottom). At or past UNDERLINE_BAND (the lower 30 %) → underline;
// from STRIKE_TOP to UNDERLINE_BAND → strike; above STRIKE_TOP → other.
const UNDERLINE_BAND = 0.7;
const STRIKE_TOP = 0.2;
// A closed loop: closure at most CLOSURE_MAX, its signed turning within
// [CIRCLE_TURN_MIN, CIRCLE_TURN_MAX] radians and its total turning at most
// LOOP_TURN_MAX (a scribble turns far more).
const CLOSURE_MAX = 0.2;
const CIRCLE_TURN_MIN = 1.5 * Math.PI;
const CIRCLE_TURN_MAX = 2.8 * Math.PI;
const LOOP_TURN_MAX = 3.6 * Math.PI;
// Corners: the stroke simplified (Ramer–Douglas–Peucker) at CORNER_TOL of its
// box's diagonal; turning measured at SMOOTH_TOL (jitter below it is ignored).
const CORNER_TOL = 0.12;
const SMOOTH_TOL = 0.03;
// A check: two segments, down then up in the same horizontal direction, the
// second at least CHECK_RATIO times the first, the corner turning between
// CHECK_TURN_MIN and CHECK_TURN_MAX degrees.
const CHECK_RATIO = 1.2;
const CHECK_TURN_MIN = 50;
const CHECK_TURN_MAX = 160;
// An arrow in one stroke: the first segment the shaft, at least ARROW_SHAFT_MIN
// of the length; at most ARROW_SEGMENTS_MAX segments; every head segment at
// most ARROW_HEAD_MAX of the shaft; the turn at the shaft's end at least
// ARROW_TURN_MIN degrees (a barb drawn back). In two strokes: a line and a
// head with one corner (its interior angle between HEAD_ANGLE_MIN and
// HEAD_ANGLE_MAX degrees, its size at most ARROW_HEAD_MAX × 1.5 of the shaft),
// the corner within HEAD_NEAR of the shaft's length from one end.
const ARROW_SHAFT_MIN = 0.4;
const ARROW_SEGMENTS_MAX = 5;
const ARROW_HEAD_MAX = 0.5;
const ARROW_TURN_MIN = 110;
const HEAD_ANGLE_MIN = 20;
const HEAD_ANGLE_MAX = 130;
const HEAD_NEAR = 0.25;
// A cross: two lines meeting between CROSS_MIDDLE and 1 − CROSS_MIDDLE along
// each, at least CROSS_ANGLE_MIN degrees apart.
const CROSS_MIDDLE = 0.2;
const CROSS_ANGLE_MIN = 40;
// Several strokes of one shape: at least AGREE_MIN of them must agree.
const AGREE_MIN = 2 / 3;

const DEG = 180 / Math.PI;
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const round2 = (v) => Math.round(clamp01(v) * 100) / 100;
const round4 = (v) => Math.round(v * 1e4) / 1e4;
const OTHER = Object.freeze({ shape: 'other', confidence: 0 });

function isBox(b) {
  return Array.isArray(b) && b.length === 4 && b.every((v) => typeof v === 'number' && Number.isFinite(v)) && b[2] >= 0 && b[3] >= 0;
}

// A flat array → [[x, y], …] with x scaled by the aspect (height units).
function pointsOf(flat, aspect) {
  const out = [];
  if (!Array.isArray(flat)) return out;
  const n = Math.floor(flat.length / STRIDE);
  for (let i = 0; i < n; i++) {
    const x = flat[i * STRIDE];
    const y = flat[i * STRIDE + 1];
    if (typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(x) || !Number.isFinite(y)) continue;
    const last = out[out.length - 1];
    if (last && last[0] === x * aspect && last[1] === y) continue;
    out.push([x * aspect, y]);
  }
  return out;
}

function lengthOf(p) {
  let L = 0;
  for (let i = 1; i < p.length; i++) L += Math.hypot(p[i][0] - p[i - 1][0], p[i][1] - p[i - 1][1]);
  return L;
}

function extentOf(p) {
  let x0 = Infinity; let y0 = Infinity; let x1 = -Infinity; let y1 = -Infinity;
  for (const [x, y] of p) {
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (y < y0) y0 = y;
    if (y > y1) y1 = y;
  }
  return { x0, y0, x1, y1, w: x1 - x0, h: y1 - y0, diag: Math.hypot(x1 - x0, y1 - y0) };
}

// Ramer–Douglas–Peucker at tolerance tol, iterative; both ends kept.
function simplify(p, tol) {
  const n = p.length;
  if (n < 3) return p.slice();
  const keep = new Uint8Array(n);
  keep[0] = 1;
  keep[n - 1] = 1;
  const stack = [0, n - 1];
  while (stack.length) {
    const b = stack.pop();
    const a = stack.pop();
    if (b - a < 2) continue;
    const [ax, ay] = p[a];
    const dx = p[b][0] - ax;
    const dy = p[b][1] - ay;
    const len2 = dx * dx + dy * dy;
    let best = -1;
    let at = -1;
    for (let i = a + 1; i < b; i++) {
      const px = p[i][0] - ax;
      const py = p[i][1] - ay;
      let u = len2 > 0 ? (px * dx + py * dy) / len2 : 0;
      if (u < 0) u = 0; else if (u > 1) u = 1;
      const d = Math.hypot(px - u * dx, py - u * dy);
      if (d > best) { best = d; at = i; }
    }
    if (best > tol) {
      keep[at] = 1;
      stack.push(a, at, at, b);
    }
  }
  const out = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(p[i]);
  return out;
}

// The signed turn (radians, −π..π) from segment a→b to segment b→c.
function turnAt(a, b, c) {
  const t1 = Math.atan2(b[1] - a[1], b[0] - a[0]);
  const t2 = Math.atan2(c[1] - b[1], c[0] - b[0]);
  let d = t2 - t1;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  return d;
}

function turning(v) {
  let signed = 0;
  let total = 0;
  for (let i = 1; i < v.length - 1; i++) {
    const d = turnAt(v[i - 1], v[i], v[i + 1]);
    signed += d;
    total += Math.abs(d);
  }
  return { signed, total };
}

// A segment's angle folded to [0, 180) degrees.
function foldedAngle(a, b) {
  let deg = Math.atan2(b[1] - a[1], b[0] - a[0]) * DEG;
  if (deg < 0) deg += 180;
  if (deg >= 180) deg -= 180;
  return deg;
}
const fromFlat = (deg) => Math.min(deg, 180 - deg);

// Every feature of one stroke the rules read.
// The length is the smoothed path's, so a digitiser's sample-to-sample noise
// does not read as a crooked line.
function featuresOf(p) {
  const ext = extentOf(p);
  const first = p[0];
  const last = p[p.length - 1];
  const chord = Math.hypot(last[0] - first[0], last[1] - first[1]);
  const corners = simplify(p, CORNER_TOL * ext.diag);
  const smooth = simplify(p, SMOOTH_TOL * ext.diag);
  const L = lengthOf(smooth);
  const ratio = L > 0 ? chord / L : 0;
  let meanY = 0;
  for (const q of p) meanY += q[1];
  meanY /= p.length;
  return { p, L, ext, first, last, chord, ratio, corners, turn: turning(smooth), angle: foldedAngle(first, last), meanY };
}

// A flat line against its text box → underline | strike | other.
function lineShape(f, box) {
  const flat = fromFlat(f.angle);
  const c = 0.6 + 0.25 * clamp01((f.ratio - LINE_STRAIGHT) / (1 - LINE_STRAIGHT)) + 0.15 * clamp01(1 - flat / FLAT_DEG);
  if (!isBox(box) || box[3] <= 0) return { shape: 'underline', confidence: c };
  const rel = (f.meanY - box[1]) / box[3];
  if (rel >= UNDERLINE_BAND) return { shape: 'underline', confidence: c };
  if (rel >= STRIKE_TOP) return { shape: 'strike', confidence: c };
  return { shape: 'other', confidence: 0 };
}

// One stroke's shape, before the confidence floor.
function single(f, box) {
  if (f.p.length < 2 || !(f.L > 0) || !(f.ext.diag > 0)) return OTHER;
  // A line.
  if (f.ratio >= LINE_STRAIGHT) {
    if (fromFlat(f.angle) <= FLAT_DEG) return lineShape(f, box);
    return { shape: 'other', confidence: 0 };
  }
  // A closed loop.
  const closure = f.ratio;
  const signed = Math.abs(f.turn.signed);
  if (closure <= CLOSURE_MAX && signed >= CIRCLE_TURN_MIN && signed <= CIRCLE_TURN_MAX && f.turn.total <= LOOP_TURN_MAX) {
    const fit = clamp01(1 - Math.abs(signed - 2 * Math.PI) / Math.PI);
    return { shape: 'circle', confidence: 0.55 + 0.25 * clamp01(1 - closure / CLOSURE_MAX) + 0.2 * fit };
  }
  const v = f.corners;
  // A check: two segments, down then up, the second the longer.
  if (v.length === 3) {
    const [a, b, c] = v;
    const l1 = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const l2 = Math.hypot(c[0] - b[0], c[1] - b[1]);
    const t = Math.abs(turnAt(a, b, c)) * DEG;
    const dx1 = b[0] - a[0];
    const dx2 = c[0] - b[0];
    if (b[1] > a[1] && c[1] < b[1] && dx1 * dx2 >= 0 && l1 > 0 && l2 >= CHECK_RATIO * l1
      && t >= CHECK_TURN_MIN && t <= CHECK_TURN_MAX) {
      return { shape: 'check', confidence: 0.6 + 0.4 * clamp01((l2 / l1 - CHECK_RATIO) / 1.5) };
    }
  }
  // An arrow in one stroke: a shaft, then a barb drawn back from its end.
  if (v.length >= 3 && v.length - 1 <= ARROW_SEGMENTS_MAX) {
    const segs = [];
    for (let i = 1; i < v.length; i++) segs.push(Math.hypot(v[i][0] - v[i - 1][0], v[i][1] - v[i - 1][1]));
    const shaft = segs[0];
    const t = Math.abs(turnAt(v[0], v[1], v[2])) * DEG;
    if (shaft >= ARROW_SHAFT_MIN * f.L && segs.slice(1).every((s) => s <= ARROW_HEAD_MAX * shaft) && t >= ARROW_TURN_MIN) {
      return { shape: 'arrow', confidence: 0.6 + 0.4 * clamp01((shaft / f.L - ARROW_SHAFT_MIN) / (1 - ARROW_SHAFT_MIN)) };
    }
  }
  return OTHER;
}

// Two lines crossing within their middles.
function crossOf(f, g) {
  if (f.ratio < CROSS_STRAIGHT || g.ratio < CROSS_STRAIGHT) return null;
  const apart = fromFlat(Math.abs(f.angle - g.angle));
  if (apart < CROSS_ANGLE_MIN) return null;
  const [p1, p2] = [f.first, f.last];
  const [q1, q2] = [g.first, g.last];
  const rx = p2[0] - p1[0]; const ry = p2[1] - p1[1];
  const sx = q2[0] - q1[0]; const sy = q2[1] - q1[1];
  const den = rx * sy - ry * sx;
  if (Math.abs(den) < 1e-12) return null;
  const t = ((q1[0] - p1[0]) * sy - (q1[1] - p1[1]) * sx) / den;
  const u = ((q1[0] - p1[0]) * ry - (q1[1] - p1[1]) * rx) / den;
  const lo = CROSS_MIDDLE; const hi = 1 - CROSS_MIDDLE;
  if (t < lo || t > hi || u < lo || u > hi) return null;
  const mid = 1 - (Math.abs(t - 0.5) + Math.abs(u - 0.5));
  return { shape: 'cross', confidence: 0.55 + 0.25 * clamp01((apart - CROSS_ANGLE_MIN) / (90 - CROSS_ANGLE_MIN)) + 0.2 * clamp01(mid) };
}

// A shaft and a head with one corner at one of its ends.
function arrowOf(shaft, head) {
  if (shaft.ratio < CROSS_STRAIGHT) return null;
  const v = head.corners;
  if (v.length !== 3) return null;
  const [a, b, c] = v;
  const inner = 180 - Math.abs(turnAt(a, b, c)) * DEG;
  if (inner < HEAD_ANGLE_MIN || inner > HEAD_ANGLE_MAX) return null;
  if (head.ext.diag > ARROW_HEAD_MAX * 1.5 * shaft.chord) return null;
  const near = HEAD_NEAR * shaft.chord;
  const dEnd = Math.min(Math.hypot(b[0] - shaft.last[0], b[1] - shaft.last[1]), Math.hypot(b[0] - shaft.first[0], b[1] - shaft.first[1]));
  if (dEnd > near) return null;
  return { shape: 'arrow', confidence: 0.6 + 0.4 * clamp01(1 - dEnd / near) };
}

function classify(strokes, opts) {
  const o = opts && typeof opts === 'object' ? opts : {};
  const aspect = typeof o.aspect === 'number' && Number.isFinite(o.aspect) && o.aspect > 0 ? o.aspect : 1;
  const union = isBox(o.textBox) ? o.textBox : null;
  const own = Array.isArray(o.textBoxes) ? o.textBoxes : [];
  const fs = [];
  const boxes = [];
  (Array.isArray(strokes) ? strokes : []).forEach((s, i) => {
    const p = pointsOf(s, aspect);
    if (p.length < 2) return;
    fs.push(featuresOf(p));
    boxes.push(isBox(own[i]) ? own[i] : union);
  });
  if (!fs.length) return { ...OTHER };
  let best = null;
  if (fs.length === 1) best = single(fs[0], boxes[0]);
  else {
    if (fs.length === 2) best = crossOf(fs[0], fs[1]) || arrowOf(fs[0], fs[1]) || arrowOf(fs[1], fs[0]);
    if (!best) {
      // Strokes of one shape (three underlines, two circles): the agreeing
      // share at least AGREE_MIN, the confidence their mean times the share.
      const each = fs.map((f, i) => single(f, boxes[i]));
      const tally = new Map();
      for (const r of each) {
        if (r.shape === 'other' || r.confidence < CONFIDENCE_MIN) continue;
        const t = tally.get(r.shape) || { n: 0, c: 0 };
        t.n += 1;
        t.c += r.confidence;
        tally.set(r.shape, t);
      }
      let top = null;
      for (const [shape, t] of tally) if (!top || t.n > top.n) top = { shape, ...t };
      const share = top ? top.n / fs.length : 0;
      best = top && share >= AGREE_MIN ? { shape: top.shape, confidence: (top.c / top.n) * share } : OTHER;
    }
  }
  if (!best || !SHAPES.includes(best.shape) || best.shape === 'other' || !(best.confidence >= CONFIDENCE_MIN)) return { ...OTHER };
  return { shape: best.shape, confidence: round2(best.confidence) };
}

function textOf(s) {
  return typeof s === 'string' ? s.replace(/\s+/g, ' ').trim() : '';
}

function cut(s, max) {
  if (s.length <= max) return s;
  let kept = s.slice(0, max - 1);
  if (/[\ud800-\udbff]$/.test(kept)) kept = kept.slice(0, -1);
  return `${kept.trimEnd()}…`;
}

function isStroke(r) {
  if (!r || typeof r !== 'object' || r.stride !== STRIDE || !Array.isArray(r.points) || !r.points.length) return false;
  if (r.points.length % STRIDE !== 0) return false;
  for (const v of r.points) if (typeof v !== 'number' || !Number.isFinite(v)) return false;
  return true;
}

function describeOf(records) {
  const members = (Array.isArray(records) ? records : []).filter(isStroke);
  if (!members.length) return { shape: 'other', confidence: 0, count: 0, bbox: null, text_under: '' };
  const first = members.find((r) => typeof r.aspect === 'number' && Number.isFinite(r.aspect) && r.aspect > 0);
  const aspect = first ? first.aspect : 1;
  let x0 = Infinity; let y0 = Infinity; let x1 = -Infinity; let y1 = -Infinity;
  let tb = null;
  const texts = [];
  for (const r of members) {
    for (let i = 0; i < r.points.length; i += STRIDE) {
      const x = r.points[i];
      const y = r.points[i + 1];
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
    if (isBox(r.text_box)) {
      const b = r.text_box;
      tb = tb
        ? [Math.min(tb[0], b[0]), Math.min(tb[1], b[1]), Math.max(tb[0] + tb[2], b[0] + b[2]), Math.max(tb[1] + tb[3], b[1] + b[3])]
        : [b[0], b[1], b[0] + b[2], b[1] + b[3]];
    }
    const t = textOf(r.text_under);
    if (t && !texts.includes(t)) texts.push(t);
  }
  const textBox = tb ? [tb[0], tb[1], tb[2] - tb[0], tb[3] - tb[1]] : null;
  const { shape, confidence } = classify(members.map((r) => r.points), {
    textBox, textBoxes: members.map((r) => (isBox(r.text_box) ? r.text_box : null)), aspect,
  });
  return {
    shape,
    confidence,
    count: members.length,
    bbox: [round4(x0), round4(y0), round4(x1 - x0), round4(y1 - y0)],
    text_under: cut(texts.join(TEXT_JOIN), TEXT_UNDER_MAX),
  };
}

module.exports = {
  SHAPES, CONFIDENCE_MIN, TEXT_UNDER_MAX, TEXT_JOIN,
  LINE_STRAIGHT, FLAT_DEG, CROSS_STRAIGHT, UNDERLINE_BAND, STRIKE_TOP,
  CLOSURE_MAX, CIRCLE_TURN_MIN, CIRCLE_TURN_MAX, LOOP_TURN_MAX, CORNER_TOL, SMOOTH_TOL,
  CHECK_RATIO, CHECK_TURN_MIN, CHECK_TURN_MAX,
  ARROW_SHAFT_MIN, ARROW_SEGMENTS_MAX, ARROW_HEAD_MAX, ARROW_TURN_MIN, HEAD_ANGLE_MIN, HEAD_ANGLE_MAX, HEAD_NEAR,
  CROSS_MIDDLE, CROSS_ANGLE_MIN, AGREE_MIN,
  classify, describeOf,
};
