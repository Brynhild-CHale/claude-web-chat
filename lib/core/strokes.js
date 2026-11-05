// The stroke record: the one home of a free-form stroke's shape (annotation
// engine tranche 4, plan 4F.1, U561; DECISIONS.md N.1 AD2 (a), AD3 (b), AD5
// (a); rulings U561@stroke-keys-and-window (a), U513-U561@derived-fields-home
// (a), STREAM@4F AF1 (a)), and the page stroke's record and its one mapping
// (tranche 5, plan 5A.1, U613; REQ@ink-scope-v2 (b+), DECISIONS.md K.2-259,
// which supersedes AD2 (a) for strokes; REQ@arrow-endpoints (a); RULED
// U613@log-admission H1 (a), U613-U621@doc-splice-set J1 (a),
// U613-U614-U621@rebox-duplicated J2 (a)). Read by the chrome's stroke pipeline
// (public/app/target-frame.js), the daemon's describe and change picture, and
// every strokes type a pack ships — so no reader keeps a second copy of the
// shape, the bound or the grouping rule. Generic to any strokes type: it names
// no tool, no colour and no pack.
//
// THE RECORD. A stroke is one element, one pen-down to pen-up, drawn in ONE
// FRAME of three kinds (frameKindOf): 'target', the fixed-aspect target it was
// drawn on (an img, a canvas, the outermost svg or an element carrying
// data-fixed-aspect; lib/core/anchors.js targetFrame); 'pane', a pane's
// element (the outermost element's record, widened to the pane at commit,
// FRAME@pane-element (c)); 'page', the page box (the margins, a markdown item,
// a stroke from one pane to the next). For a target or a pane its anchor is
// that element's ELEMENT record, so re-anchoring is the resolver's; for the
// page it is a PAGE RECORD (below). Its payload keys are STROKE_KEYS ∪
// DESCRIBE_KEYS, top level, whatever the frame (RECORD@page-kind: the page
// kind adds no payload key), and a strokes
// type's element.json declares all of them in its `payload.keys` (a key it
// does not declare is the route's refusal, which the commit shows as its
// hint):
//   anchor      the frame's element record, or a page record
//   shared      true or false, as the TYPE passed it (PRIVATE@create: the
//               default lives in the type's create; nothing here defaults it)
//   tool        a short string (≤ STROKE_NAME_MAX), the type's own vocabulary
//   width       the stroke's width as a fraction of the frame's width, so a
//               resize rescales a dry stroke with no redraw
//   colour      a short string (≤ STROKE_NAME_MAX), the type's own vocabulary
//   points      ONE flat array of numbers [x0, y0, p0, t0, x1, …]: x and y in
//               the frame's 0..1 box units, clamped to [0, 1] PER FRAME (the
//               target's box, the pane's element's, or the page box: a
//               stroke never leaves its frame, and the page's frame is the
//               whole well); p the pressure 0..1 (0.5 when the
//               pointer reports none); t integer ms since pen-down. Flat
//               because the plug-in value grammar (lib/core/element-log.js)
//               admits strings, numbers, booleans and arrays of numbers.
//   stride      STROKE_STRIDE (4), the numbers per sample
//   aspect      the frame's w ÷ h at pen-down
//   text_under, bbox, text_box   DESCRIBE_KEYS: the engine's derived fields,
//               reserved here for the describe deriver (plugged in through
//               target-frame.js registerStrokeDerive); never under `meta`.
//
// THE PAGE RECORD (isPageRecord, built by pageRecord; the chrome's page frame
// writes it, U612). A CLOSED shape, no other key anywhere:
//   {v: 1, kind: PAGE_KIND, item, frame: {w, h}, from: {item, x, y, w, h},
//    to: {item, x, y, w, h}}
// item the page item (a pane's mount id or a markdown item's id, at most
// PAGE_ITEM_MAX characters) nearest the pen-down, equal to from.item; frame
// the page box's size in CSS px at commit (integers); from / to the first and
// the last sample's item: x, y the sample's position in that item's box units,
// NOT clamped to [0, 1] (a margin endpoint lies outside its nearest item by
// definition) but bounded to |·| ≤ PAGE_END_MAX and rounded to 1e-4; w, h that
// item's box in CSS px (integers; the drift's base). A box grab's page anchor
// ({v, kind 'page', item, mount, rect, box, scroll, viewport}) is NOT one. Its
// shape (pageShape): 'between' (two items: an arrow), 'inside' (one item, both
// ends in its box) or 'beside' (one item, an end outside it: a margin
// stroke); pageLabel names it by ids only ('from A to B', 'inside A',
// 'beside A'), the one label the describe and the search both read.
//
// THE ONE MAPPING (mapPage; MAP@engine). 'page' stays outside KIND_SECTIONS
// (lib/core/anchors.js): the resolver never places a page record. A page
// stroke is placed by its ITEMS, and its state is theirs (DRIFT@beside; C5's
// honesty kept). mapPage takes the record, the payload and the endpoint items'
// current rects to the stroke's current box and points: a 'between' record
// by the similarity taking both recorded endpoints to the current ones (an
// arrow follows both ends and turns vertical when its items stack); any other
// by its item's movement (a margin stroke follows the item nearest its
// pen-down, MARGIN@nearest-item); one missing endpoint item → its guess; every
// item missing → null (orphaned, never drawn at a stale position). Its three
// placers are the overlay (public/app/overlay.js, U614), the document runtime
// (lib/server/runtime/elements-doc-src.js, U621) and the eraser's box through
// the overlay's markers; reboxPoints is the one member-box to union-box step
// the overlay and the document runtime both call. The drift (a width change's
// stretch) is reported beside, never a state (U531@aspect-drift (a)).
//
// THE DOC SPLICE (DOC_SPLICE, J1 (a)). The document runtime splices
// isPageRecord, pageShape, reboxPoints and mapPage BY NAME, IN ORDER, from
// this export, each by its own source. So each of the four references NO
// module binding: every constant it reads is inlined as a literal on a line
// `const NAME = <literal>; // <CONSTANTS entry>` (test/strokes-core.test.js
// holds each equal to its entry), and it calls only Math and the names listed
// before it — no Number, no Array, no Object.
//
// THE BOUND. At most STROKE_POINTS_MAX samples after decimate() (Ramer–
// Douglas–Peucker in frame units at the smallest tolerance that keeps the
// count under the bound, both endpoints kept) and roundPoints() (x, y to
// 1e-4, p to 1e-3, t to an integer): a 240 Hz stroke never grows the log, the
// node copies or an export past what one version may hold (element-log's
// PLUGIN_ARRAY_MAX numbers, PLUGIN_PAYLOAD_MAX bytes).
//
// THE STROKE GROUP (strokeGroups). A READ-TIME grouping only — same target
// (sameTarget: mount, at.path, at.sib for an element record, never fp text;
// from.item and to.item for a page record), same tool, each member
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
const PAGE_KIND = 'page';
const PAGE_ITEM_MAX = 256;
const PAGE_END_MAX = 8;
const PAGE_DEGENERATE_PX = 8;
const DOC_SPLICE = Object.freeze(['isPageRecord', 'pageShape', 'reboxPoints', 'mapPage']);

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
// equal mount, at.path and at.sib. Never the fingerprint's text. Two page
// records name the same target when their from.item and to.item are equal (a
// margin pair on one item, or two arrows between the same items); a page
// record and an element record never do.
function sameTarget(a, b) {
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
  const pa = isPageRecord(a);
  const pb = isPageRecord(b);
  if (pa || pb) return pa && pb && a.from.item === b.from.item && a.to.item === b.to.item;
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
// runs; anything else starts a group. A row whose anchor is neither an element
// record (one with `at`) nor a page record (isPageRecord) is a group of its
// own. key is the oldest member's id. Read-time only: nothing stored.
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
    const a = r.anchor && typeof r.anchor === 'object' && (r.anchor.at || isPageRecord(r.anchor)) ? r.anchor : null;
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

// ── the page record and its one mapping (U613) ─────────────────────────────
// The first four functions below are DOC_SPLICE's, in its order: each reads
// no module binding (its constants inlined, each beside its CONSTANTS entry)
// and calls only Math and the names listed before it.

// isPageRecord(a) → true when a is a page stroke's record, the closed shape
// above: v 1, kind PAGE_KIND, item, frame {w, h} positive finite, from and to
// each {item, x, y, w, h} (item a non-empty string ≤ PAGE_ITEM_MAX, x and y
// finite with |·| ≤ PAGE_END_MAX, w and h positive finite), from.item ===
// item, and no other key anywhere. A box grab's page anchor is refused.
function isPageRecord(a) {
  const KIND = 'page'; // PAGE_KIND
  const ITEM_MAX = 256; // PAGE_ITEM_MAX
  const END_MAX = 8; // PAGE_END_MAX
  const fin = (v) => typeof v === 'number' && v - v === 0;
  const pos = (v) => fin(v) && v > 0;
  const obj = (o) => !!o && typeof o === 'object';
  // Exactly these keys (own or inherited enumerable): no fewer, no other.
  const only = (o, keys) => {
    let n = 0;
    for (const k in o) { if (keys.indexOf(k) < 0) return false; n++; }
    return n === keys.length;
  };
  const isItem = (s) => typeof s === 'string' && s.length > 0 && s.length <= ITEM_MAX;
  const isEnd = (e) => obj(e) && only(e, ['item', 'x', 'y', 'w', 'h']) && isItem(e.item)
    && fin(e.x) && e.x >= -END_MAX && e.x <= END_MAX && fin(e.y) && e.y >= -END_MAX && e.y <= END_MAX
    && pos(e.w) && pos(e.h);
  if (!obj(a) || !only(a, ['v', 'kind', 'item', 'frame', 'from', 'to'])) return false;
  if (a.v !== 1 || a.kind !== KIND || !isItem(a.item)) return false;
  if (!obj(a.frame) || !only(a.frame, ['w', 'h']) || !pos(a.frame.w) || !pos(a.frame.h)) return false;
  return isEnd(a.from) && isEnd(a.to) && a.from.item === a.item;
}

// pageShape(a) → 'between' (from.item ≠ to.item: an arrow), 'inside' (one
// item, both endpoints in [0, 1]² of its box), 'beside' (one item, an endpoint
// outside it: a margin stroke), or null for anything isPageRecord refuses.
function pageShape(a) {
  if (!isPageRecord(a)) return null;
  if (a.from.item !== a.to.item) return 'between';
  const inBox = (e) => e.x >= 0 && e.x <= 1 && e.y >= 0 && e.y <= 1;
  return inBox(a.from) && inBox(a.to) ? 'inside' : 'beside';
}

// reboxPoints(points, fromBox, toBox) → a fresh plain flat array of whole
// samples (STROKE_STRIDE): each sample's x and y re-expressed from fromBox's
// 0..1 units into toBox's (boxes {left, top, w, h} in px; so each sample keeps
// its px position), p and t kept; null for a box that is not finite with a
// positive w and h (an equal box copies the samples exactly). The member-box
// to union-box step: the overlay's pageRecordView and the document runtime's
// record(id) call it, and neither writes the step itself (J2 (a)). A trailing
// partial sample is dropped.
function reboxPoints(points, fromBox, toBox) {
  const STRIDE = 4; // STROKE_STRIDE
  const fin = (v) => typeof v === 'number' && v - v === 0;
  const box = (b) => !!b && typeof b === 'object' && fin(b.left) && fin(b.top) && fin(b.w) && fin(b.h) && b.w > 0 && b.h > 0;
  if (!box(fromBox) || !box(toBox) || !points || typeof points.length !== 'number') return null;
  const n = Math.floor(points.length / STRIDE);
  const same = fromBox.left === toBox.left && fromBox.top === toBox.top && fromBox.w === toBox.w && fromBox.h === toBox.h;
  const out = [];
  for (let i = 0; i < n; i++) {
    const j = i * STRIDE;
    if (same) { for (let k = 0; k < STRIDE; k++) out.push(points[j + k]); continue; }
    out.push((fromBox.left + points[j] * fromBox.w - toBox.left) / toBox.w,
      (fromBox.top + points[j + 1] * fromBox.h - toBox.top) / toBox.h);
    for (let k = 2; k < STRIDE; k++) out.push(points[j + k]);
  }
  return out;
}

// mapPage(anchor, payload, fromRect, toRect) → where a page stroke lies now:
// {box: {left, top, w, h}, points, width, aspect, scale, angle, drift, guess},
// or null (orphaned: never drawn at a stale position).
//   fromRect / toRect  the from and the to item's current box ({left, top} and
//                      {w, h} or {width, height}, in the px space the box is
//                      wanted in; a missing or zero-size one is absent). A
//                      one-item record reads fromRect (toRect when it is the
//                      only one handed in).
//   P0, PN  the first and the last sample in px of the recorded page box
//           (the point × frame {w, h}); C0, CN the endpoints now: rect.left +
//           end.x · rect.w, rect.top + end.y · rect.h.
// A 'between' record with |PN − P0| ≥ PAGE_DEGENERATE_PX and both rects maps
// by the SIMILARITY (one uniform scale |CN − C0| ÷ |PN − P0|, one rotation,
// one translation) taking P0 → C0 and PN → CN; any other record by the
// TRANSLATION of its item (C0 − P0); a 'between' record with one rect missing
// by the present endpoint's translation, guess: true; every needed rect
// missing → null. box is the mapped points' bbox grown on every side by half
// the stroke's px width (at least 1 px); points (a plain flat array, stride
// STROKE_STRIDE) are in box's 0..1 units, p and t kept; width is the RECORDED
// px width (payload.width × frame.w, never scaled: a stretched arrow keeps
// its pen's thickness) ÷ box.w; aspect box.w ÷ box.h; scale and angle (rad)
// the similarity's (1 and 0 for a translation); drift — beside, never a state
// — |scale − 1| for the similarity, else the larger relative change of the
// followed item's box against its recorded w, h; rounded to 1e-3.
function mapPage(anchor, payload, fromRect, toRect) {
  const STRIDE = 4; // STROKE_STRIDE
  const DEGENERATE_PX = 8; // PAGE_DEGENERATE_PX
  const shape = pageShape(anchor);
  if (!shape || !payload || typeof payload !== 'object') return null;
  const fin = (v) => typeof v === 'number' && v - v === 0;
  const rectOf = (r) => {
    if (!r || typeof r !== 'object') return null;
    const w = r.w != null ? r.w : r.width;
    const h = r.h != null ? r.h : r.height;
    return fin(r.left) && fin(r.top) && fin(w) && fin(h) && w > 0 && h > 0 ? { left: r.left, top: r.top, w, h } : null;
  };
  const pts = payload.points;
  const n = pts && typeof pts.length === 'number' ? Math.floor(pts.length / STRIDE) : 0;
  if (!n) return null;
  for (let i = 0; i < n * STRIDE; i++) if (!fin(pts[i])) return null;
  const fw = anchor.frame.w;
  const fh = anchor.frame.h;
  const from = anchor.from;
  const to = anchor.to;
  let fr = rectOf(fromRect);
  let tr = rectOf(toRect);
  if (shape !== 'between') { if (!fr) fr = tr; tr = fr; }
  if (!fr && !tr) return null;
  const p0x = pts[0] * fw;
  const p0y = pts[1] * fh;
  const pnx = pts[(n - 1) * STRIDE] * fw;
  const pny = pts[(n - 1) * STRIDE + 1] * fh;
  const vx = pnx - p0x;
  const vy = pny - p0y;
  const L2 = vx * vx + vy * vy;
  // The map z → o + q·(z − P), q = qr + i·qi.
  let qr = 1;
  let qi = 0;
  let ox;
  let oy;
  let px;
  let py;
  let guess = false;
  let drift;
  const sizeDrift = (r, e) => Math.max(Math.abs(r.w - e.w) / e.w, Math.abs(r.h - e.h) / e.h);
  if (shape === 'between' && fr && tr && Math.sqrt(L2) >= DEGENERATE_PX) {
    const c0x = fr.left + from.x * fr.w;
    const c0y = fr.top + from.y * fr.h;
    const ux = tr.left + to.x * tr.w - c0x;
    const uy = tr.top + to.y * tr.h - c0y;
    qr = (ux * vx + uy * vy) / L2;
    qi = (uy * vx - ux * vy) / L2;
    ox = c0x; oy = c0y; px = p0x; py = p0y;
    drift = Math.abs(Math.sqrt(qr * qr + qi * qi) - 1);
  } else if (fr) {
    ox = fr.left + from.x * fr.w; oy = fr.top + from.y * fr.h; px = p0x; py = p0y;
    guess = shape === 'between' && !tr;
    drift = sizeDrift(fr, from);
  } else {
    ox = tr.left + to.x * tr.w; oy = tr.top + to.y * tr.h; px = pnx; py = pny;
    guess = true;
    drift = sizeDrift(tr, to);
  }
  const mapped = [];
  let x0 = Infinity; let y0 = Infinity; let x1 = -Infinity; let y1 = -Infinity;
  for (let i = 0; i < n; i++) {
    const j = i * STRIDE;
    const dx = pts[j] * fw - px;
    const dy = pts[j + 1] * fh - py;
    const X = ox + qr * dx - qi * dy;
    const Y = oy + qi * dx + qr * dy;
    if (X < x0) x0 = X;
    if (X > x1) x1 = X;
    if (Y < y0) y0 = Y;
    if (Y > y1) y1 = Y;
    mapped.push(X, Y);
    for (let k = 2; k < STRIDE; k++) mapped.push(pts[j + k]);
  }
  const widthPx = fin(payload.width) && payload.width > 0 ? payload.width * fw : 0;
  const pad = Math.max(1, widthPx / 2);
  const box = { left: x0 - pad, top: y0 - pad, w: x1 - x0 + 2 * pad, h: y1 - y0 + 2 * pad };
  const scale = Math.sqrt(qr * qr + qi * qi);
  return {
    box,
    points: reboxPoints(mapped, { left: 0, top: 0, w: 1, h: 1 }, box),
    width: widthPx / box.w,
    aspect: box.w / box.h,
    scale,
    angle: Math.atan2(qi, qr),
    drift: Math.round(drift * 1e3) / 1e3,
    guess,
  };
}

// pageRecord({from, to, frame}) → the page record (item = from.item; x, y
// bounded to |·| ≤ PAGE_END_MAX and rounded to 1e-4; w, h and frame to
// integers, at least 1), or null when what is handed in cannot make one
// (isPageRecord's refusal: an item that is no short string, a non-finite
// number, a box that is not positive).
function pageRecord(o) {
  if (!o || typeof o !== 'object') return null;
  const size = (v) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.max(1, Math.round(v)) : null);
  const unit = (v) => {
    if (typeof v !== 'number' || !Number.isFinite(v)) return null;
    const b = Math.min(PAGE_END_MAX, Math.max(-PAGE_END_MAX, v));
    return Math.round(b * 1e4) / 1e4 || 0;
  };
  const end = (e) => (e && typeof e === 'object'
    ? { item: e.item, x: unit(e.x), y: unit(e.y), w: size(e.w), h: size(e.h) } : null);
  const f = o.frame;
  const rec = {
    v: 1, kind: PAGE_KIND, item: o.from && typeof o.from === 'object' ? o.from.item : null,
    frame: { w: f && typeof f === 'object' ? size(f.w) : null, h: f && typeof f === 'object' ? size(f.h) : null },
    from: end(o.from), to: end(o.to),
  };
  return isPageRecord(rec) ? rec : null;
}

// pageLabel(a) → 'from <A> to <B>' | 'inside <A>' | 'beside <A>' (item ids
// only), or null for anything isPageRecord refuses: the one label the
// describe (public/app/ink-describe.js, U622) and the routes' describeAnchor
// (U623) both read.
function pageLabel(a) {
  const shape = pageShape(a);
  if (shape === 'between') return `from ${a.from.item} to ${a.to.item}`;
  if (shape === 'inside') return `inside ${a.item}`;
  if (shape === 'beside') return `beside ${a.item}`;
  return null;
}

// frameKindOf(anchor) → the frame a stroke's anchor names: 'page' for a page
// record; 'target' for an element record whose fp.tag is img, canvas or svg
// or whose fp.attrs names data-fixed-aspect; 'pane' for any other element
// record; null otherwise. The describe's frame word and the overlay's drift
// both read it.
function frameKindOf(anchor) {
  if (isPageRecord(anchor)) return 'page';
  if (!anchor || typeof anchor !== 'object' || anchor.kind !== 'element') return null;
  const fp = anchor.fp && typeof anchor.fp === 'object' ? anchor.fp : {};
  const tag = typeof fp.tag === 'string' ? fp.tag.toLowerCase() : '';
  const attrs = Array.isArray(fp.attrs) ? fp.attrs : [];
  return tag === 'img' || tag === 'canvas' || tag === 'svg' || attrs.indexOf('data-fixed-aspect') >= 0 ? 'target' : 'pane';
}

const CONSTANTS = {
  STROKE_STRIDE, STROKE_KEYS, DESCRIBE_KEYS, STROKE_POINTS_MAX, STROKE_NAME_MAX, GROUP_WINDOW_MS, STROKE_ID_ATTR,
  PAGE_KIND, PAGE_ITEM_MAX, PAGE_END_MAX, PAGE_DEGENERATE_PX, DOC_SPLICE,
};
const FUNCTIONS = {
  decimate, roundPoints, bboxOf, sameTarget, strokeGroups, isStrokePayload,
  isPageRecord, pageShape, reboxPoints, mapPage, pageRecord, pageLabel, frameKindOf,
};

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
