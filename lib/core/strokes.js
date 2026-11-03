// The stroke record: the one home of a free-form stroke's shape (annotation
// engine tranche 4, plan 4F.1, U561; DECISIONS.md N.1 AD2 (a), AD3 (b), AD5
// (a); rulings U561@stroke-keys-and-window (a), U513-U561@derived-fields-home
// (a), STREAM@4F AF1 (a)). Read by the chrome's stroke pipeline
// (public/app/target-frame.js), the daemon's describe and change picture, and
// every strokes type a pack ships — so no reader keeps a second copy of the
// shape, the bound or the grouping rule. Generic to any strokes type: it names
// no tool, no colour and no pack.
//
// THE RECORD. A stroke is one element, one pen-down to pen-up. Its anchor is
// the ELEMENT record of the fixed-aspect target it was drawn on (an img, a
// canvas, the outermost svg or an element carrying data-fixed-aspect;
// lib/core/anchors.js targetFrame), so re-anchoring is the resolver's. Its
// payload keys are STROKE_KEYS ∪ DESCRIBE_KEYS, top level, and a strokes
// type's element.json declares all of them in its `payload.keys` (a key it
// does not declare is the route's refusal, which the commit shows as its
// hint):
//   anchor      the target's element record
//   shared      true or false, as the TYPE passed it (PRIVATE@create: the
//               default lives in the type's create; nothing here defaults it)
//   tool        a short string (≤ STROKE_NAME_MAX), the type's own vocabulary
//   width       the stroke's width as a fraction of the frame's width, so a
//               resize rescales a dry stroke with no redraw
//   colour      a short string (≤ STROKE_NAME_MAX), the type's own vocabulary
//   points      ONE flat array of numbers [x0, y0, p0, t0, x1, …]: x and y in
//               the target frame's 0..1 box units, clamped to [0, 1] (ink
//               never leaves its target); p the pressure 0..1 (0.5 when the
//               pointer reports none); t integer ms since pen-down. Flat
//               because the plug-in value grammar (lib/core/element-log.js)
//               admits strings, numbers, booleans and arrays of numbers.
//   stride      STROKE_STRIDE (4), the numbers per sample
//   aspect      the frame's w ÷ h at pen-down
//   text_under, bbox, text_box   DESCRIBE_KEYS: the engine's derived fields,
//               reserved here for the describe deriver (plugged in through
//               target-frame.js registerStrokeDerive); never under `meta`.
//
// THE BOUND. At most STROKE_POINTS_MAX samples after decimate() (Ramer–
// Douglas–Peucker in frame units at the smallest tolerance that keeps the
// count under the bound, both endpoints kept) and roundPoints() (x, y to
// 1e-4, p to 1e-3, t to an integer): a 240 Hz stroke never grows the log, the
// node copies or an export past what one version may hold (element-log's
// PLUGIN_ARRAY_MAX numbers, PLUGIN_PAYLOAD_MAX bytes).
//
// THE STROKE GROUP (strokeGroups). A READ-TIME grouping only — same target
// (sameTarget: mount, at.path, at.sib; never fp text), same tool, each member
// created within GROUP_WINDOW_MS of the member before it (chained) — never a
// stored parent or field, so a delete or an undo works stroke by stroke.
// Callers filter rows before grouping (the daemon's describe and picture group
// SHARED rows only).
//
// STROKE_ID_ATTR is the attribute a strokes type's draw puts on each stroke's
// node, its value the element's id (the change picture greys earlier strokes
// by it).
//
// AUTHORING RULE: this file requires and imports nothing. Every name the
// browser copy needs is a top-level constant or function declared here, and
// browserModuleSource() emits each from its own source, so the chrome runs the
// same code (served at /app/strokes.js by lib/server/routes/page.js; to the
// jsdom tests by test-support/served-modules.js). Memoised per process: an
// edit here needs a daemon restart AND a browser refresh.

const STROKE_STRIDE = 4;
const STROKE_KEYS = Object.freeze(['anchor', 'shared', 'tool', 'width', 'colour', 'points', 'stride', 'aspect']);
const DESCRIBE_KEYS = Object.freeze(['text_under', 'bbox', 'text_box']);
const STROKE_POINTS_MAX = 1024;
const STROKE_NAME_MAX = 40;
const GROUP_WINDOW_MS = 4000;
const STROKE_ID_ATTR = 'data-el-id';

// decimate(points, {max, stride, report}) → a new plain array of whole
// samples, at most `max` of them (default STROKE_POINTS_MAX), the first and
// the last always kept. A stroke already within the bound comes back as a
// copy, unchanged. Otherwise the kept set is exactly Ramer–Douglas–Peucker's
// at the smallest tolerance (in frame units, over x and y; the distance to the
// segment) that keeps the count within the bound — the stepped-up tolerance,
// found in one pass: each interior sample's significance is its split distance
// capped by its parent split's, and RDP at tolerance τ keeps exactly the
// samples whose significance exceeds τ. `report`, when an object, is given
// {tolerance, kept}: every dropped sample lies within `tolerance` of the kept
// polyline's segment that spans it. Iterative (no recursion depth on a long
// stroke). A trailing partial sample is dropped.
function decimate(points, opts) {
  const o = opts || {};
  const S = Number.isInteger(o.stride) && o.stride >= 2 ? o.stride : STROKE_STRIDE;
  const max = Number.isInteger(o.max) && o.max >= 2 ? o.max : STROKE_POINTS_MAX;
  const n = points && points.length >= 0 ? Math.floor(points.length / S) : 0;
  const copy = (keep) => {
    const out = [];
    for (let i = 0; i < n; i++) {
      if (keep && !keep[i]) continue;
      for (let k = 0; k < S; k++) out.push(points[i * S + k]);
    }
    return out;
  };
  if (n <= max) {
    if (o.report && typeof o.report === 'object') { o.report.tolerance = 0; o.report.kept = n; }
    return copy(null);
  }
  const sig = new Float64Array(n);
  sig[0] = Infinity;
  sig[n - 1] = Infinity;
  // A stack of [first, last, cap] spans.
  const stack = [0, n - 1, Infinity];
  while (stack.length) {
    const cap = stack.pop();
    const b = stack.pop();
    const a = stack.pop();
    if (b - a < 2) continue;
    const ax = points[a * S];
    const ay = points[a * S + 1];
    const dx = points[b * S] - ax;
    const dy = points[b * S + 1] - ay;
    const len2 = dx * dx + dy * dy;
    let best = -1;
    let at = -1;
    for (let i = a + 1; i < b; i++) {
      const px = points[i * S] - ax;
      const py = points[i * S + 1] - ay;
      let u = len2 > 0 ? (px * dx + py * dy) / len2 : 0;
      if (u < 0) u = 0; else if (u > 1) u = 1;
      const ex = px - u * dx;
      const ey = py - u * dy;
      const d = Math.sqrt(ex * ex + ey * ey);
      if (d > best) { best = d; at = i; }
    }
    const s = best < cap ? best : cap;
    sig[at] = s;
    stack.push(a, at, s, at, b, s);
  }
  // The tolerance: the (max - 1)th largest interior significance, so at most
  // max - 2 interior samples exceed it.
  const inner = Array.prototype.slice.call(sig, 1, n - 1).sort((x, y) => y - x);
  const tolerance = inner[max - 2];
  const keep = new Uint8Array(n);
  let kept = 0;
  for (let i = 0; i < n; i++) if (sig[i] > tolerance) { keep[i] = 1; kept++; }
  if (o.report && typeof o.report === 'object') { o.report.tolerance = tolerance; o.report.kept = kept; }
  return copy(keep);
}

// roundPoints(points, {stride}) → a new plain array: x and y to 1e-4, p to
// 1e-3, t to an integer (a stride past 4 keeps its extra numbers as given).
function roundPoints(points, opts) {
  const S = opts && Number.isInteger(opts.stride) && opts.stride >= 2 ? opts.stride : STROKE_STRIDE;
  const out = [];
  const n = points ? Math.floor(points.length / S) * S : 0;
  for (let i = 0; i < n; i++) {
    const v = Number(points[i]);
    const k = i % S;
    out.push(k < 2 ? Math.round(v * 1e4) / 1e4 : k === 2 ? Math.round(v * 1e3) / 1e3 : k === 3 ? Math.round(v) : v);
  }
  return out;
}

// bboxOf(points, {stride}) → [x, y, w, h] in frame units over every sample's
// x and y; null for no sample.
function bboxOf(points, opts) {
  const S = opts && Number.isInteger(opts.stride) && opts.stride >= 2 ? opts.stride : STROKE_STRIDE;
  const n = points ? Math.floor(points.length / S) : 0;
  if (!n) return null;
  let x0 = Infinity; let y0 = Infinity; let x1 = -Infinity; let y1 = -Infinity;
  for (let i = 0; i < n; i++) {
    const x = points[i * S];
    const y = points[i * S + 1];
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (y < y0) y0 = y;
    if (y > y1) y1 = y;
  }
  return [x0, y0, x1 - x0, y1 - y0];
}

// sameTarget(a, b) → true when two element records name the same target:
// equal mount, at.path and at.sib. Never the fingerprint's text.
function sameTarget(a, b) {
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
  if (!a.at || !b.at || typeof a.at !== 'object' || typeof b.at !== 'object') return false;
  if ((a.mount == null ? null : a.mount) !== (b.mount == null ? null : b.mount)) return false;
  if (a.at.sib !== b.at.sib) return false;
  const p = a.at.path;
  const q = b.at.path;
  if (!Array.isArray(p) || !Array.isArray(q) || p.length !== q.length) return false;
  for (let i = 0; i < p.length; i++) if (p[i] !== q[i]) return false;
  return true;
}

// strokeGroups(rows, {windowMs}) → [{key, tool, members: [ids, oldest first]}],
// the groups in the order their oldest member was created. rows: records with
// {id, created_at (ms, or a date string), tool, anchor}. A row joins the open
// group of its target (sameTarget) and tool whose newest member was created at
// most windowMs (default GROUP_WINDOW_MS) before it — chained, so a run of
// strokes each within the window of the last is one group however long it
// runs; anything else starts a group. A row with no element anchor is a group
// of its own. key is the oldest member's id. Read-time only: nothing stored.
function strokeGroups(rows, opts) {
  const w = opts && Number.isFinite(opts.windowMs) && opts.windowMs >= 0 ? opts.windowMs : GROUP_WINDOW_MS;
  const timeOf = (r) => {
    const c = r.created_at;
    if (typeof c === 'number' && Number.isFinite(c)) return c;
    if (typeof c === 'string') { const t = Date.parse(c); if (Number.isFinite(t)) return t; }
    return NaN;
  };
  const list = [];
  for (const r of Array.isArray(rows) ? rows : []) {
    if (!r || typeof r !== 'object' || r.id == null) continue;
    list.push({ r, t: timeOf(r), i: list.length });
  }
  list.sort((a, b) => {
    const ta = Number.isNaN(a.t) ? Infinity : a.t;
    const tb = Number.isNaN(b.t) ? Infinity : b.t;
    return ta !== tb ? ta - tb : a.i - b.i;
  });
  const groups = [];
  const open = [];   // {anchor, tool, last, group}
  for (const { r, t } of list) {
    const tool = r.tool == null ? null : r.tool;
    const a = r.anchor && typeof r.anchor === 'object' && r.anchor.at ? r.anchor : null;
    let into = null;
    if (a && Number.isFinite(t)) {
      for (let k = open.length - 1; k >= 0; k--) {
        const g = open[k];
        if (g.tool === tool && t - g.last <= w && sameTarget(g.anchor, a)) { into = g; break; }
      }
    }
    if (into) {
      into.group.members.push(String(r.id));
      into.last = t;
      continue;
    }
    const group = { key: String(r.id), tool, members: [String(r.id)] };
    groups.push(group);
    if (a && Number.isFinite(t)) open.push({ anchor: a, tool, last: t, group });
  }
  return groups;
}

// isStrokePayload(p) → true when p carries a stroke: points an array of
// finite numbers, whole samples of stride STROKE_STRIDE.
function isStrokePayload(p) {
  if (!p || typeof p !== 'object' || p.stride !== STROKE_STRIDE || !Array.isArray(p.points)) return false;
  if (p.points.length % STROKE_STRIDE !== 0) return false;
  for (const v of p.points) if (typeof v !== 'number' || !Number.isFinite(v)) return false;
  return true;
}

const CONSTANTS = { STROKE_STRIDE, STROKE_KEYS, DESCRIBE_KEYS, STROKE_POINTS_MAX, STROKE_NAME_MAX, GROUP_WINDOW_MS, STROKE_ID_ATTR };
const FUNCTIONS = { decimate, roundPoints, bboxOf, sameTarget, strokeGroups, isStrokePayload };

// The browser copy: an ES module of the constants (as literals) and the
// functions' own source, on lib/core/tier-merge's precedent — no second
// implementation. Served at /app/strokes.js.
let browserSrc = null;
function browserModuleSource() {
  if (browserSrc == null) {
    const lit = (v) => (Array.isArray(v) ? `Object.freeze(${JSON.stringify(v)})` : JSON.stringify(v));
    browserSrc = [
      '// Generated from lib/core/strokes.js — do not edit; see that file.',
      ...Object.entries(CONSTANTS).map(([k, v]) => `export const ${k} = ${lit(v)};`),
      ...Object.values(FUNCTIONS).map((f) => `export ${f.toString()}`),
      '',
    ].join('\n');
  }
  return browserSrc;
}

module.exports = { ...CONSTANTS, ...FUNCTIONS, browserModuleSource };
