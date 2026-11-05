// The wet layer (annotation engine tranche 4, U517, plan 4A.2; AD3 (b) — the
// engine draws the stroke in progress, AD4 (a) — sample to paint under one
// frame; WET@engine — an engine module a strokes type receives through the
// create ctx, and a pack never adds a layer). Tranche 5, U615 (5A.3): the
// clip (WET@clip-viewport), the scroll reach and the held trail (WET@trail).
//
// WHAT IT IS. ONE live canvas the engine lays over a strokes type's target for
// the stroke in progress, reached by the type as `ctx.wet` (overlay.js
// registerCreateCtx, U516's seam: no overlay.js edit), and ONE trail canvas
// beneath it that keeps finished strokes wet until their dry markers land. The
// type pushes the browser's samples (input.samples / input.predicted) and asks
// for a paint; the engine keeps them in a preallocated ring and paints on the
// next animation frame. At pen-up the type writes its dry record (the element
// log is the type's, never this ring) and ends the stroke: the canvas stays
// one more frame, so the dry marker paints first, then is cleared and
// detached. A cancel (a pointercancel, a two-finger pan's cancelGesture) drops
// it at once.
//
//   initWetLayer({overlay?, raf?, rectOf?, setTimeout?, clearTimeout?}) → api
//     idempotent: the first call registers ctx.wet; every call may set the
//     injectables (raf: the frame scheduler, rectOf: the box read, the two
//     timer functions: the hold's — the tests'; overlay: {registerCreateCtx,
//     frameReason}, default overlay.js's).
//   api.begin(target, {pointerId}) → token | false  refused (false) for a
//     target overlay.js frameReason refuses (a frame, inside one, another
//     document) or one not connected, or when the browser gives no 2D context;
//     else a TOKEN, a positive integer (truthy, so a caller reading a boolean
//     still works). Lays the canvas over THE CLIP, its backing the clip ×
//     devicePixelRatio (read at each begin) and its context scaled by it. A
//     begin while a stroke is active (or ending) HOLDS that stroke: its pixels
//     are copied onto the trail (one drawImage at the two canvases' placement
//     offset) under its token, and the live canvas, cleared, carries the new
//     stroke — no blink between two fast strokes.
//   api.push(samples, {predicted}?) → n  copies each sample's x, y (relative
//     to the clip's origin at the newest frame), pressure and timeStamp into
//     the ring (WET_RING samples; a longer stroke overwrites its oldest —
//     counted in stats().dropped); the predicted samples go to a small slot
//     (WET_PREDICTED) every push overwrites: drawn provisionally, never kept.
//   api.paint(fn) → boolean  at most one requestAnimationFrame per frame;
//     the frame calls the newest fn(ctx2d, view). The engine clears nothing
//     between frames: a type redraws (view.clear(), then the stroke) or draws
//     incrementally from view.fresh (the samples pushed since its last paint;
//     after a resize or a clip move, which clear the canvas, every sample kept).
//   api.end(token?) / api.cancel(token?)  no token (or the active stroke's):
//     the active stroke, as before. A HELD token: end dries it at the next
//     frame (its dry marker paints first); cancel clears the whole trail at
//     once — a held stroke's pixels cannot be told from another's, so a cancel
//     of one (a failed save) drops every held stroke (a blink only then). The
//     trail is cleared once no held token remains, and WET_HOLD_MS after its
//     hold a token no call names is released (a caller that ends only its
//     newest stroke, or ends bare, still never leaves wet ink behind).
//   api.active() / api.stats()
//     stats() → {allocs, frames, samples, dropped, held}: allocs, frames,
//     samples and dropped cumulative; allocs counts every buffer or element
//     this module creates (the canvas, the ring, the predicted slot, the trail
//     canvas and the held table's three arrays — all at the first begin, so it
//     stays still after it); held is the tokens on the trail now.
//
// THE CLIP. The live canvas never covers more than it can paint: clip = the
// target's rect ∩ the layout viewport (0, 0, documentElement.clientWidth,
// clientHeight; innerWidth / innerHeight where those read 0 — no layout) ∩
// the well (.well-wrap's rect) when the target is in it. A PAGE target (#main,
// a page frame) is clipped to the well's visible part instead, so a stroke in
// the column's padding or a wide window's gutters is wet (REQ@margins = a).
// The canvas is never larger than the viewport × dpr (a page 20,000 CSS px
// tall stays far under iOS Safari's canvas area cap). The clip is re-computed
// at each frame a stroke asks for: when the target moves under the clip (the
// well scrolls under a page stroke, a pane slides past the well's edge) the
// kept samples are shifted with it and the canvas cleared, every sample fresh.
//
// NO ALLOCATION PER SAMPLE OR PER PUSH: push and the frame create no array,
// object, closure or typed-array view; the frame writes a canvas's style only
// when its placement changed. A scroll or resize asks for a frame. A scroll is
// not composed: one inside a shadow root never reaches the window's listener,
// so a stroke listens (capture, passive) on EVERY shadow root of its target's
// composed ancestry — the target's root, its host's root, up to the document —
// from its begin to its detach (U517a, widened by U615) — never an idle loop:
// no frame runs while the pen is still and nothing scrolls, and none while no
// stroke is active and the trail is empty.
//
// THE TRAIL. Laid over the layout viewport when it takes its first held
// stroke, re-sized only then; while it holds a stroke it follows a scroll at
// each frame a scroll asks for, by ONE rect read: its newest held stroke's
// target (the active stroke's rect already read when that is the same target).
// Strokes held from other targets move with that one. Its 2D context is asked
// for at its first hold (no context for a viewer that never holds one).
//
// WHERE IT PAINTS. In the chrome's own document body, position fixed,
// pointer-events none, at the overlay's page layer's rung (--z-pins; appended
// at each begin, so above #el-layer by tree order, the trail just before the
// live canvas) — never inside a pane, a frame or a document; the chrome above
// --z-pins covers both by z-order. A document (preview, export, replay) never
// loads this module: a type must tolerate ctx.wet being undefined there. It is
// no host (HOST_NAMES) and takes no id (no reserved id): its classes are
// .el-wet and .el-wet-trail.
import { registerCreateCtx as ovRegisterCreateCtx, frameReason as ovFrameReason } from './overlay.js';

export const WET_RING = 4096;        // samples kept for the stroke in progress
export const WET_PREDICTED = 16;     // predicted samples drawn, each push overwrites them
export const WET_FIELDS = 4;         // per sample: x, y, pressure, timeStamp
export const WET_CTX_NAME = 'wet';   // the create ctx's member name
// The low-latency hint (Chrome's desynchronized canvas; ignored where unknown).
export const WET_CONTEXT_OPTIONS = Object.freeze({ desynchronized: true });
// How long a held stroke no end or cancel names stays wet: a save's round
// trip, a slow one over the tunnel included, before its dry marker lands.
export const WET_HOLD_MS = 1000;
export const WET_HELD = 8;           // held tokens tracked at once (a ninth takes the oldest's slot)
const DEFAULT_PRESSURE = 0.5;        // a sample with no pressure (the Pointer Events default for a pressed button)
const WELL_SELECTOR = '.well-wrap';
const PAGE_ID = 'main';

const defaultRaf = (fn) => window.requestAnimationFrame(fn);
const defaultRectOf = (el) => el.getBoundingClientRect();
const defaultSetTimeout = (fn, ms, arg) => window.setTimeout(fn, ms, arg);
const defaultClearTimeout = (h) => window.clearTimeout(h);
const cfg = {
  raf: defaultRaf, rectOf: defaultRectOf, frameReason: ovFrameReason,
  setTimeout: defaultSetTimeout, clearTimeout: defaultClearTimeout,
};

let inited = false;
let api = null;
const counts = { allocs: 0, frames: 0, samples: 0, dropped: 0 };

// The buffers and the canvases, made at the first begin and reused for ever.
let ring = null;        // Float64Array(WET_RING * WET_FIELDS)
let pred = null;        // Float64Array(WET_PREDICTED * WET_FIELDS)
let canvas = null;
let ctx2d = null;
let trail = null;       // the trail canvas
let trailCtx = null;    // its 2D context, asked for at its first hold
let heldTok = null;     // Float64Array(WET_HELD): a held token per slot, 0 = empty
let heldDry = null;     // Uint8Array(WET_HELD): 1 = ended, dries at the next frame
let heldTimer = null;   // the WET_HOLD_MS timer per slot (null when none)

// The stroke.
let state = 'idle';     // 'idle' | 'active' | 'ending' (ended, detached at the next frame)
let target = null;
let well = null;        // the .well-wrap the target is in (null: none, or not in it)
let pageTarget = false; // the target is #main: a page frame, clipped to the well
let pointerId = null;
let token = 0;          // the newest token begin handed out
let activeTok = 0;      // the token of the stroke on the live canvas
let head = 0;           // the ring slot the next sample takes
let total = 0;          // samples pushed this stroke
let strokeDropped = 0;
let predN = 0;
let fresh = 0;          // samples pushed since the last paint (capped at the kept count)
let paintFresh = 0;     // what the running paint reads as view.fresh
let left = 0;           // the clip's origin and size (CSS px, the viewport's coordinates)
let top = 0;
let width = -1;
let height = -1;
let offX = 0;           // the target's origin in the clip's coordinates
let offY = 0;
let dpr = 1;
let pending = null;     // the newest paint fn
let scheduled = false;
const scrollRoots = []; // the shadow roots of the target's composed ancestry, listened on while a stroke holds it
const SCROLL_OPTS = { capture: true, passive: true };

// The trail.
let heldN = 0;
let trailTarget = null; // the newest held stroke's target: the trail follows its rect
let trailAX = 0;        // the trail's origin minus that target's origin
let trailAY = 0;
let trailLeft = 0;
let trailTop = 0;
let trailW = -1;
let trailH = -1;
let trailDpr = 0;

const keptCount = () => (total < WET_RING ? total : WET_RING);
const slot = (i) => (head - keptCount() + i + WET_RING) % WET_RING;

const view = Object.freeze({
  get count() { return keptCount(); },
  get total() { return total; },
  get dropped() { return strokeDropped; },
  get fresh() { return paintFresh; },
  get width() { return width; },
  get height() { return height; },
  get dpr() { return dpr; },
  get pointerId() { return pointerId; },
  get buffer() { return ring; },
  x(i) { return ring[slot(i) * WET_FIELDS]; },
  y(i) { return ring[slot(i) * WET_FIELDS + 1]; },
  pressure(i) { return ring[slot(i) * WET_FIELDS + 2]; },
  t(i) { return ring[slot(i) * WET_FIELDS + 3]; },
  get predictedCount() { return predN; },
  predictedX(i) { return pred[i * WET_FIELDS]; },
  predictedY(i) { return pred[i * WET_FIELDS + 1]; },
  predictedPressure(i) { return pred[i * WET_FIELDS + 2]; },
  predictedT(i) { return pred[i * WET_FIELDS + 3]; },
  clear() { if (ctx2d && width > 0 && height > 0) ctx2d.clearRect(0, 0, width, height); },
});

const FIXED_STYLE = 'position: fixed; left: 0px; top: 0px; margin: 0; padding: 0; border: 0;'
  + ' pointer-events: none; z-index: var(--z-pins);';

function ensureCanvas() {
  if (!ring) { ring = new Float64Array(WET_RING * WET_FIELDS); counts.allocs++; }
  if (!pred) { pred = new Float64Array(WET_PREDICTED * WET_FIELDS); counts.allocs++; }
  if (!canvas) {
    canvas = document.createElement('canvas');
    counts.allocs++;
    canvas.className = 'el-wet';
    canvas.setAttribute('aria-hidden', 'true');
    canvas.style.cssText = FIXED_STYLE;
  }
  if (!ctx2d) {
    try { ctx2d = canvas.getContext('2d', WET_CONTEXT_OPTIONS) || null; } catch { ctx2d = null; }
  }
  if (!ctx2d) return false;
  if (!trail) {
    trail = document.createElement('canvas');
    counts.allocs++;
    trail.className = 'el-wet-trail';
    trail.setAttribute('aria-hidden', 'true');
    trail.style.cssText = FIXED_STYLE;
  }
  if (!heldTok) {
    heldTok = new Float64Array(WET_HELD);
    heldDry = new Uint8Array(WET_HELD);
    heldTimer = new Array(WET_HELD).fill(null);
    counts.allocs += 3;
  }
  return true;
}

// The layout viewport's size (no layout — jsdom, a hidden document — reads 0:
// the window's inner size then).
function viewportW() { return document.documentElement.clientWidth || window.innerWidth || 0; }
function viewportH() { return document.documentElement.clientHeight || window.innerHeight || 0; }

// Re-compute the clip; move the canvas and, on a size change, resize its
// backing (which clears it: every kept sample is fresh again). When the
// target moved under the clip, shift the kept samples with it and clear.
function place(force) {
  const r = cfg.rectOf(target);
  const rl = r.left;
  const rt = r.top;
  let cl = rl;
  let ct = rt;
  let cr = rl + (r.width > 0 ? r.width : 0);
  let cb = rt + (r.height > 0 ? r.height : 0);
  if (well) {
    const w = cfg.rectOf(well);
    if (w.width > 0 && w.height > 0) {
      const wr = w.left + w.width;
      const wb = w.top + w.height;
      if (pageTarget) {
        cl = w.left;
        ct = w.top;
        cr = wr;
        cb = wb;
      } else {
        if (w.left > cl) cl = w.left;
        if (w.top > ct) ct = w.top;
        if (wr < cr) cr = wr;
        if (wb < cb) cb = wb;
      }
    }
  }
  const vw = viewportW();
  const vh = viewportH();
  if (cl < 0) cl = 0;
  if (ct < 0) ct = 0;
  if (cr > vw) cr = vw;
  if (cb > vh) cb = vh;
  const w = cr > cl ? cr - cl : 0;
  const h = cb > ct ? cb - ct : 0;
  const ox = rl - cl;
  const oy = rt - ct;
  let moved = false;
  if (!force && (ox !== offX || oy !== offY)) { shiftKept(ox - offX, oy - offY); moved = true; }
  offX = ox;
  offY = oy;
  if (force || cl !== left) { left = cl; canvas.style.left = `${cl}px`; }
  if (force || ct !== top) { top = ct; canvas.style.top = `${ct}px`; }
  if (force || w !== width || h !== height) {
    width = w;
    height = h;
    canvas.width = Math.max(1, Math.round(w * dpr));
    canvas.height = Math.max(1, Math.round(h * dpr));
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
    ctx2d.setTransform(dpr, 0, 0, dpr, 0, 0);
    fresh = keptCount();
  } else if (moved) {
    view.clear();
    fresh = keptCount();
  }
}

// The target moved by (dx, dy) in the clip's coordinates: every kept and
// predicted sample moves with it, in place.
function shiftKept(dx, dy) {
  const n = keptCount();
  for (let i = 0; i < n; i++) {
    const k = slot(i) * WET_FIELDS;
    ring[k] += dx;
    ring[k + 1] += dy;
  }
  for (let i = 0; i < predN; i++) {
    pred[i * WET_FIELDS] += dx;
    pred[i * WET_FIELDS + 1] += dy;
  }
}

function schedule() {
  if (scheduled) return;
  scheduled = true;
  cfg.raf(onWetFrame);
}

// A scroll inside a shadow root never reaches the window (it is not
// composed): listen on every shadow root of the target's composed ancestry
// for the stroke's life.
function watchRoots(el) {
  unwatchRoots();
  let r = el.getRootNode();
  while (r && r !== document && r.nodeType === 11 && r.host) {
    r.addEventListener('scroll', onViewportChange, SCROLL_OPTS);
    scrollRoots.push(r);
    r = r.host.getRootNode();
  }
}

function unwatchRoots() {
  for (let i = 0; i < scrollRoots.length; i++) scrollRoots[i].removeEventListener('scroll', onViewportChange, SCROLL_OPTS);
  scrollRoots.length = 0;
}

// The well the target is in, across its shadow hosts (null when none).
function wellOf(el) {
  const w = document.querySelector(WELL_SELECTOR);
  if (!w) return null;
  let n = el;
  while (n) {
    if (w.contains(n)) return w;
    const r = n.getRootNode();
    n = r && r.nodeType === 11 ? r.host : null;
  }
  return null;
}

function detach() {
  unwatchRoots();
  view.clear();
  if (canvas && canvas.parentNode) canvas.parentNode.removeChild(canvas);
  state = 'idle';
  target = null;
  well = null;
  pending = null;
  predN = 0;
}

// ── the trail ───────────────────────────────────────────────────────────────

function heldSlot(tok) {
  if (!heldTok || !(tok > 0)) return -1;
  for (let i = 0; i < WET_HELD; i++) if (heldTok[i] === tok) return i;
  return -1;
}

function releaseSlot(i) {
  if (heldTimer[i] !== null) { cfg.clearTimeout(heldTimer[i]); heldTimer[i] = null; }
  heldTok[i] = 0;
  heldDry[i] = 0;
  heldN--;
  if (heldN === 0) clearTrail();
}

function clearTrail() {
  for (let i = 0; i < WET_HELD; i++) {
    if (heldTimer[i] !== null) { cfg.clearTimeout(heldTimer[i]); heldTimer[i] = null; }
    heldTok[i] = 0;
    heldDry[i] = 0;
  }
  heldN = 0;
  trailTarget = null;
  if (trailCtx && trailW > 0 && trailH > 0) trailCtx.clearRect(0, 0, trailW, trailH);
  if (trail && trail.parentNode) trail.parentNode.removeChild(trail);
}

// Lay the empty trail over the layout viewport.
function layTrail() {
  if (!trailCtx) {
    try { trailCtx = trail.getContext('2d') || null; } catch { trailCtx = null; }
    if (!trailCtx) return false;
  }
  const vw = viewportW();
  const vh = viewportH();
  trailLeft = 0;
  trailTop = 0;
  trail.style.left = '0px';
  trail.style.top = '0px';
  if (vw !== trailW || vh !== trailH || dpr !== trailDpr) {
    trailW = vw;
    trailH = vh;
    trailDpr = dpr;
    trail.width = Math.max(1, Math.round(vw * dpr));
    trail.height = Math.max(1, Math.round(vh * dpr));
    trail.style.width = `${vw}px`;
    trail.style.height = `${vh}px`;
    trailCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  return true;
}

// Copy the live stroke onto the trail under its token (begin's, while a
// stroke is active or ending). An ended stroke dries at the next frame, as its
// end asked; an active one waits for its own end, cancel or WET_HOLD_MS.
function holdLive() {
  if (!(width > 0 && height > 0) || !activeTok) return;
  const ended = state === 'ending';
  if (!ended && pending) {   // its newest samples, not yet painted, are painted first
    const fn = pending;
    pending = null;
    paintFresh = fresh;
    fresh = 0;
    fn(ctx2d, view);
  }
  if (heldN === 0 && !layTrail()) return;
  try {
    trailCtx.drawImage(canvas, left - trailLeft, top - trailTop, width, height);
  } catch {
    if (heldN === 0) clearTrail();
    return;
  }
  let i = -1;
  for (let j = 0; j < WET_HELD && i < 0; j++) if (heldTok[j] === 0) i = j;
  if (i < 0) {   // full: the oldest token gives up its slot (its pixels stay until the trail clears)
    let oldest = 0;
    for (let j = 1; j < WET_HELD; j++) if (heldTok[j] < heldTok[oldest]) oldest = j;
    i = oldest;
    if (heldTimer[i] !== null) { cfg.clearTimeout(heldTimer[i]); heldTimer[i] = null; }
    heldN--;
  }
  heldTok[i] = activeTok;
  heldDry[i] = ended ? 1 : 0;
  heldTimer[i] = ended ? null : cfg.setTimeout(onHoldExpire, WET_HOLD_MS, activeTok);
  heldN++;
  // The trail follows this stroke's target from here.
  trailTarget = target;
  trailAX = trailLeft - (left + offX);
  trailAY = trailTop - (top + offY);
  if (canvas.parentNode === document.body) document.body.insertBefore(trail, canvas);
  else document.body.appendChild(trail);
  if (ended) schedule();
}

function onHoldExpire(tok) {
  const i = heldSlot(tok);
  if (i >= 0) { heldTimer[i] = null; releaseSlot(i); }
}

// The frame's trail work: ended holds dry; the trail follows its target.
function trailFrame() {
  for (let i = 0; i < WET_HELD && heldN > 0; i++) if (heldTok[i] !== 0 && heldDry[i] === 1) releaseSlot(i);
  if (heldN === 0) return;
  if (!trailTarget.isConnected) { clearTrail(); return; }
  let tl = 0;
  let tt = 0;
  if (trailTarget === target && state === 'active') {
    tl = left + offX + trailAX;
    tt = top + offY + trailAY;
  } else {
    const r = cfg.rectOf(trailTarget);
    tl = r.left + trailAX;
    tt = r.top + trailAY;
  }
  if (tl !== trailLeft) { trailLeft = tl; trail.style.left = `${tl}px`; }
  if (tt !== trailTop) { trailTop = tt; trail.style.top = `${tt}px`; }
}

function onWetFrame() {
  scheduled = false;
  counts.frames++;
  if (state === 'ending') detach();
  else if (state === 'active') {
    if (!target.isConnected) detach();   // the target went mid-stroke: a cancel
    else {
      place(false);
      const fn = pending;
      if (fn) {
        pending = null;
        paintFresh = fresh;
        fresh = 0;
        fn(ctx2d, view);
      }
    }
  }
  if (heldN > 0) trailFrame();
}

function onViewportChange() {
  if (state === 'active' || heldN > 0) schedule();
}

function begin(el, opts) {
  if (!el || cfg.frameReason(el) || !el.isConnected) return false;
  if (!ensureCanvas()) return false;
  // A begin while a stroke is active or ending holds that one on the trail;
  // the live canvas, cleared below, carries the new stroke.
  if (state === 'active' || state === 'ending') holdLive();
  state = 'idle';
  pending = null;
  target = el;
  well = wellOf(el);
  pageTarget = el.id === PAGE_ID && el.getRootNode() === document;
  pointerId = opts && opts.pointerId != null ? opts.pointerId : null;
  const d = Number(window.devicePixelRatio);
  dpr = d > 0 && Number.isFinite(d) ? d : 1;
  head = 0;
  total = 0;
  strokeDropped = 0;
  predN = 0;
  fresh = 0;
  paintFresh = 0;
  place(true);
  view.clear();
  if (canvas.parentNode !== document.body || canvas.nextSibling) document.body.appendChild(canvas);
  if (heldN > 0 && trail.nextSibling !== canvas) document.body.insertBefore(trail, canvas);
  watchRoots(el);
  state = 'active';
  token++;
  activeTok = token;
  return activeTok;
}

function push(samples, opts) {
  if (state !== 'active') return 0;
  const n = samples ? samples.length : 0;
  for (let i = 0; i < n; i++) {
    const s = samples[i];
    const k = head * WET_FIELDS;
    const p = s.pressure;
    ring[k] = s.clientX - left;
    ring[k + 1] = s.clientY - top;
    ring[k + 2] = typeof p === 'number' && p === p ? p : DEFAULT_PRESSURE;
    ring[k + 3] = s.timeStamp;
    head = (head + 1) % WET_RING;
    if (total >= WET_RING) { strokeDropped++; counts.dropped++; }
    total++;
  }
  counts.samples += n;
  fresh += n;
  if (fresh > WET_RING) fresh = WET_RING;
  const list = opts ? opts.predicted : null;
  const m = list ? (list.length < WET_PREDICTED ? list.length : WET_PREDICTED) : 0;
  for (let i = 0; i < m; i++) {
    const s = list[i];
    const k = i * WET_FIELDS;
    const p = s.pressure;
    pred[k] = s.clientX - left;
    pred[k + 1] = s.clientY - top;
    pred[k + 2] = typeof p === 'number' && p === p ? p : DEFAULT_PRESSURE;
    pred[k + 3] = s.timeStamp;
  }
  predN = m;
  return n;
}

function paint(fn) {
  if (state !== 'active' || typeof fn !== 'function') return false;
  pending = fn;
  schedule();
  return true;
}

// No token, or the active stroke's: the active stroke. A held token: it
// dries at the next frame. Any other token (stale, released): nothing.
function end(tok) {
  if (tok == null || (tok === activeTok && state !== 'idle')) {
    if (state !== 'active') return false;
    state = 'ending';
    pending = null;
    predN = 0;
    schedule();
    return true;
  }
  const i = heldSlot(tok);
  if (i < 0) return false;
  heldDry[i] = 1;
  if (heldTimer[i] !== null) { cfg.clearTimeout(heldTimer[i]); heldTimer[i] = null; }
  schedule();
  return true;
}

// No token, or the active stroke's: drop the active stroke at once. A held
// token: the whole trail at once (its pixels cannot be told apart).
function cancel(tok) {
  if (tok == null || (tok === activeTok && state !== 'idle')) {
    if (state === 'idle') return false;
    detach();
    return true;
  }
  if (heldSlot(tok) < 0) return false;
  clearTrail();
  return true;
}

export function initWetLayer(opts = {}) {
  for (const k of ['raf', 'rectOf', 'setTimeout', 'clearTimeout']) {
    if (opts[k] != null) {
      if (typeof opts[k] !== 'function') throw new TypeError(`initWetLayer: ${k} must be a function`);
      cfg[k] = opts[k];
    }
  }
  if (inited) return api;
  const ov = opts.overlay || null;
  const register = ov && typeof ov.registerCreateCtx === 'function' ? ov.registerCreateCtx : ovRegisterCreateCtx;
  if (ov && typeof ov.frameReason === 'function') cfg.frameReason = ov.frameReason;
  api = Object.freeze({
    begin, push, paint, end, cancel,
    active: () => state === 'active',
    stats: () => ({ allocs: counts.allocs, frames: counts.frames, samples: counts.samples, dropped: counts.dropped, held: heldN }),
  });
  register(WET_CTX_NAME, api);
  inited = true;
  window.addEventListener('scroll', onViewportChange, { capture: true, passive: true });
  window.addEventListener('resize', onViewportChange, { passive: true });
  return api;
}
