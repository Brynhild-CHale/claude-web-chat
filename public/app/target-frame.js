// The stroke frame and the engine's stroke commit (annotation engine tranche
// 4, plan 4F.1, U561; DECISIONS.md N.1 AD2 (a), AD3 (b), AD5 (a); rulings
// STREAM@4F AF1 (a), PRIVATE@create AF2 (a), U561@stroke-keys-and-window (a),
// U561-U516@orphan-removed-target (a); FRAME@shared, CANVAS@home, PROTO@none).
//
// Two members on the overlay's create ctx (overlay.js registerCreateCtx, U516's
// seam — this module never edits the overlay), so a strokes type's create is
// thin and no type posts on its own. Generic to any strokes type: nothing here
// names a tool, a colour or a pack.
//
//   ctx.frameAt(event) → {ok: true, target, record, w, h, aspect, rect} |
//                        {ok: false, hint}
//     The fixed-aspect target under a press: the innermost element on the
//     event's composedPath(), inside the pane's content root (the shadow root
//     of a .mount-host — never the chrome, a markdown item, another host or an
//     iframe), handed ONCE to the resolver's target-frame walk
//     (ctx.anchors.targetFrame, lib/core/anchors.js — the one walk; nothing
//     here re-walks the path). record is the target's ELEMENT record; rect
//     {left, top, w, h} its box. Any refusal — not over an img, a canvas, an
//     svg or a [data-fixed-aspect] element, over a control, in or over an
//     iframe — answers FRAME_HINT: ink never lands over prose (AD2).
//     `event` may be the create's input (its .event is read).
//
//   ctx.stroke.begin(input) → a handle, or null
//     At the pointerdown: the tray guard first (element-types.js trayAction: a
//     previewed node refuses with READONLY_HINT before anything is drawn, D2),
//     then the frame. A refusal shows its hint through the one note (topbar
//     showReaimNote) and answers null: a refused press draws and posts nothing.
//     The pointerdown's own samples are the stroke's first. The type is the
//     armed one.
//   handle.frame     the frame begin found (a type's wet layer begins on
//                    handle.frame.target)
//   handle.count     the samples held
//   handle.rect      the rect the last push read ({left, top, w, h}): ONE
//                    object per handle, written in place (read only)
//   handle.push(x)   a later event's samples: x is the create's input (its
//                    samples, else its event; any sample in input.predicted
//                    is skipped) or the samples list itself. Each sample's
//                    clientX/Y goes to frame units against the target's rect —
//                    re-read once per push, never per sample — clamped to
//                    [0, 1], with its pressure (0.5 when the pointer reports
//                    none) and its ms since pen-down, into ONE growable
//                    Float64Array (capacity doubling): no allocation per
//                    sample. A predicted sample is never stored (a type paints
//                    those on its wet layer only).
//   handle.commit({tool, width, colour, shared}) → Promise<{ok: true, element}
//                    | {ok: false, hint}>
//                    Once per handle (one element per pen-down to pen-up).
//                    Refused unless `shared` is a boolean the type passed
//                    (PRIVATE@create: the default is the type's; the route's
//                    own default is never reached), tool and colour short
//                    strings and width a positive px width. Decimates and
//                    rounds (lib/core/strokes), runs every registered deriver
//                    keeping only DESCRIBE_KEYS, then ONE POST /api/elements
//                    through trayAction and http.js with the device claim:
//                    {type, anchor: the frame's record, payload: {shared, tool,
//                    width: px ÷ the frame's width, colour, points, stride,
//                    aspect, …derived}}. A refusal is shown as its hint.
//   handle.cancel()  drops the buffer (a pointercancel; cancelGesture's pan).
//
//   ctx.stroke.strokesOn(frame, {type}) → the live rows of that type the
//     resolver places on the frame's target (an eraser's hit test, and
//     nothing more).
//
//   registerStrokeDerive(name, fn) → unregister: fn({frame, points, bbox,
//     target}) → a partial payload; only its DESCRIBE_KEYS are kept. A throw
//     is logged and the stroke commits without it. Names are unique.
//
// THE ANCHOR is the target's element record, so placing a stroke is the
// resolver's and the overlay's DRAW_RULES' (unchanged): exact or re-resolved,
// the box marker sits on the target's current rect and the stroke follows a
// re-render, a move or a resize (its points are box units); orphaned with a
// locator guess, drawn at the guess (group.kind 'guess', the type draws it
// faded); orphaned with no guess, never drawn at a stale position — listed by
// orphans(). A stroke group is strokes.js strokeGroups' read-time answer, never
// stored here.
import { registerCreateCtx, elementsOf, armed } from './overlay.js';
import { trayAction, TRAY_REFUSAL } from './element-types.js';
import { request } from './http.js';
import { showReaimNote } from './topbar.js';
import anchorsApi from './anchors.js';
import {
  STROKE_STRIDE, DESCRIBE_KEYS, STROKE_POINTS_MAX, STROKE_NAME_MAX,
  decimate, roundPoints, bboxOf,
} from './strokes.js';

export const FRAME_HINT = 'Ink draws on an image, an svg, a canvas or a canvas sheet — never over text or a control';
export const SHARED_HINT = 'A stroke is sent only with shared true or false, as its type passes it.';
export const STYLE_HINT = `A stroke needs a tool and a colour (at most ${STROKE_NAME_MAX} characters each) and a width above 0.`;
export const EMPTY_HINT = 'Nothing was drawn.';
export const SPENT_HINT = 'This stroke was already sent or dropped.';
export const FAILED_HINT = 'The stroke was not saved.';
export const ELEMENTS_PATH = '/api/elements';
export const BUFFER_START = 256;   // numbers (64 samples); doubled as a stroke grows
// A press on one of these is a control's, never ink's (checked on the
// innermost element only).
const CONTROL = 'button, input, select, textarea, option, label, [contenteditable]:not([contenteditable="false"])';
const FRAMES = new Set(['iframe', 'frame', 'object', 'embed']);

function note(text) {
  try { showReaimNote(text); } catch { /* the note is a courtesy */ }
}

// The pane content root a node sits in: the shadow root of a .mount-host
// (its mount id beside it), else null.
function contentRootOf(el) {
  const root = el && typeof el.getRootNode === 'function' ? el.getRootNode() : null;
  if (!root || root.nodeType !== 11 || !root.host) return null;
  const h = root.host;
  if (!h.classList || !h.classList.contains('mount-host')) return null;
  const mount = (h.dataset && h.dataset.mountId) || h.id || null;
  return mount ? { root, mount } : null;
}

const REFUSED = Object.freeze({ ok: false, hint: FRAME_HINT });

function frameOf(event, api) {
  const e = event && event.event && typeof event.event === 'object' ? event.event : event;
  if (!e || typeof e !== 'object') return REFUSED;
  const path = typeof e.composedPath === 'function' ? e.composedPath() : [];
  let el = null;
  for (const n of path) if (n && n.nodeType === 1) { el = n; break; }
  if (!el && e.target && e.target.nodeType === 1) el = e.target;
  if (!el) return REFUSED;
  // Never through a frame: a press over one (the frame element) or in one
  // (another document's node).
  if (el.ownerDocument !== document || FRAMES.has(String(el.localName || '').toLowerCase())) return REFUSED;
  const where = contentRootOf(el);
  if (!where) return REFUSED;
  if (typeof el.closest === 'function' && el.closest(CONTROL)) return REFUSED;
  const a = api || anchorsApi;
  if (!a || typeof a.targetFrame !== 'function') return REFUSED;
  const f = a.targetFrame(where.root, el, { mount: where.mount });
  if (!f || f.refused || !f.target || !f.record) return REFUSED;
  return {
    ok: true, target: f.target, record: f.record, w: f.w, h: f.h, aspect: f.aspect,
    rect: { left: f.left, top: f.top, w: f.w, h: f.h },
  };
}

// The create ctx's member: called as ctx.frameAt(event), `this` is that ctx
// and its anchors the resolver asked; detached, the chrome's own.
function frameAt(event) {
  return frameOf(event, this && this.anchors ? this.anchors : null);
}

// ── derivers ────────────────────────────────────────────────────────────────
const derivers = new Map();   // name → {fn}
export function registerStrokeDerive(name, fn) {
  if (typeof name !== 'string' || !name) throw new TypeError('registerStrokeDerive: a name');
  if (typeof fn !== 'function') throw new TypeError(`registerStrokeDerive: "${name}" needs a function`);
  if (derivers.has(name)) throw new TypeError(`registerStrokeDerive: "${name}" is already registered`);
  const d = { fn };
  derivers.set(name, d);
  return () => { if (derivers.get(name) === d) derivers.delete(name); };
}
async function derive(arg) {
  const out = {};
  for (const [name, d] of derivers) {
    let part;
    try {
      part = d.fn(arg);
      if (part && typeof part.then === 'function') part = await part;
    } catch (err) {
      console.error(`[web-chat] strokes: the '${name}' deriver failed`, err);
      continue;
    }
    if (!part || typeof part !== 'object') continue;
    for (const k of DESCRIBE_KEYS) {
      if (Object.prototype.hasOwnProperty.call(part, k) && part[k] !== undefined) out[k] = part[k];
    }
  }
  return out;
}

// ── the handle ──────────────────────────────────────────────────────────────
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const nowMs = () => (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now());
const isName = (s) => typeof s === 'string' && s.length > 0 && s.length <= STROKE_NAME_MAX;

function makeHandle(type, frame, first) {
  let buf = new Float64Array(BUFFER_START);
  let len = 0;
  let t0 = null;
  let lastT = 0;
  // ONE held rect per handle (GT-22's per-sample allocation clause): seeded
  // from the frame's rect at begin and written in place by readRect, so a push
  // builds no object; frame.rect itself stays the begin-time box.
  const rect = { left: frame.rect.left, top: frame.rect.top, w: frame.rect.w, h: frame.rect.h };
  let done = false;

  function grow() {
    const next = new Float64Array(buf.length * 2);
    next.set(buf);
    buf = next;
  }
  function take(s) {
    if (len + STROKE_STRIDE > buf.length) grow();
    const ts = Number.isFinite(s.timeStamp) ? s.timeStamp : nowMs();
    if (t0 == null) t0 = ts;
    let t = Math.round(ts - t0);
    if (!(t >= lastT)) t = lastT;
    lastT = t;
    const p = s.pressure;
    buf[len] = clamp01((s.clientX - rect.left) / rect.w);
    buf[len + 1] = clamp01((s.clientY - rect.top) / rect.h);
    buf[len + 2] = Number.isFinite(p) && p > 0 ? (p > 1 ? 1 : p) : 0.5;
    buf[len + 3] = t;
    len += STROKE_STRIDE;
  }
  function readRect() {
    const t = frame.target;
    const b = t && typeof t.getBoundingClientRect === 'function' ? t.getBoundingClientRect() : null;
    // A zero-size box leaves the previous rect in place.
    if (b && b.width > 0 && b.height > 0) { rect.left = b.left; rect.top = b.top; rect.w = b.width; rect.h = b.height; }
  }
  function push(x) {
    if (done || x == null) return;
    let list = x;
    let predicted = null;
    if (typeof x.length !== 'number') {
      list = x.samples && typeof x.samples.length === 'number' ? x.samples : null;
      if (x.predicted && typeof x.predicted.length === 'number' && x.predicted.length) predicted = x.predicted;
      if (list == null) {
        // A browser without coalesced samples: the event itself.
        const e = x.event && typeof x.event === 'object' ? x.event : x;
        if (e.predicted === true || !Number.isFinite(e.clientX) || !Number.isFinite(e.clientY)) return;
        readRect();
        take(e);
        return;
      }
    }
    readRect();
    for (let i = 0; i < list.length; i++) {
      const s = list[i];
      if (!s || s.predicted === true || (predicted && predicted.includes(s))) continue;
      if (!Number.isFinite(s.clientX) || !Number.isFinite(s.clientY)) continue;
      take(s);
    }
  }
  function cancel() {
    done = true;
    len = 0;
    buf = null;
  }
  async function commit(opts) {
    const o = opts && typeof opts === 'object' ? opts : {};
    if (done) return { ok: false, hint: SPENT_HINT };
    if (typeof o.shared !== 'boolean') {
      console.error('[web-chat] strokes: commit needs shared true or false from the type (PRIVATE@create)');
      note(SHARED_HINT);
      return { ok: false, hint: SHARED_HINT };
    }
    if (!isName(o.tool) || !isName(o.colour) || !(Number.isFinite(o.width) && o.width > 0)) {
      note(STYLE_HINT);
      return { ok: false, hint: STYLE_HINT };
    }
    const held = len;
    const raw = buf ? buf.subarray(0, held) : null;
    done = true;
    buf = null;
    len = 0;
    if (!held) { note(EMPTY_HINT); return { ok: false, hint: EMPTY_HINT }; }
    const points = roundPoints(decimate(raw, { max: STROKE_POINTS_MAX }));
    const bbox = bboxOf(points);
    const derived = await derive({ frame, points, bbox, target: frame.target });
    const payload = {
      ...derived,
      shared: o.shared,
      tool: o.tool,
      width: o.width / frame.w,
      colour: o.colour,
      points,
      stride: STROKE_STRIDE,
      aspect: frame.aspect,
    };
    const body = { type, anchor: frame.record, payload };
    const sent = trayAction(() => request('POST', ELEMENTS_PATH, { body, device: true }), { note });
    const r = await sent;
    if (r === TRAY_REFUSAL) return { ok: false, hint: r.hint };   // the guard showed it
    const element = r && r.ok && r.body && r.body.element && typeof r.body.element === 'object' ? r.body.element : null;
    if (!element) {
      const hint = (r && (r.hint || (r.body && r.body.hint))) || FAILED_HINT;
      note(hint);
      return { ok: false, hint };
    }
    return { ok: true, element };
  }
  const handle = {
    type,
    frame,
    get count() { return len / STROKE_STRIDE; },
    get rect() { return rect; },   // the held rect (read only): the box the last push read
    push,
    commit,
    cancel,
  };
  push(first);
  return handle;
}

function begin(input, ctx) {
  if (trayAction(() => true, { note }) !== true) return null;
  const a = armed();
  if (!a || !a.type) return null;
  const f = frameOf(input, ctx && ctx.anchors ? ctx.anchors : null);
  if (!f.ok) { note(f.hint); return null; }
  return makeHandle(a.type, f, input);
}

// The live rows of `type` the resolver places on the frame's target.
function strokesOn(frame, { type } = {}) {
  if (!frame || !frame.ok || !frame.target || !frame.record) return [];
  const where = contentRootOf(frame.target);
  if (!where) return [];
  let ix = null;
  const out = [];
  for (const r of elementsOf('live')) {
    if (type != null && r.type !== type) continue;
    const a = r.anchor;
    if (!a || a.kind !== 'element' || (a.mount == null ? null : a.mount) !== where.mount) continue;
    if (!ix) ix = anchorsApi.index(where.root);
    let ans = null;
    try { ans = anchorsApi.resolve(where.root, a, undefined, ix); } catch { ans = null; }
    if (ans && ans.el === frame.target && ans.state !== 'orphaned') out.push(r);
  }
  return out;
}

export const stroke = Object.freeze({ begin, strokesOn });
export { frameAt };

let unregister = null;
export function initTargetFrame() {
  if (unregister) return;
  const a = registerCreateCtx('frameAt', frameAt);
  const b = registerCreateCtx('stroke', stroke);
  unregister = () => { a(); b(); unregister = null; };
}
