// The wet layer (annotation engine tranche 4, U517, plan 4A.2; AD3 (b) — the
// engine draws the stroke in progress, AD4 (a) — sample to paint under one
// frame; WET@engine — an engine module a strokes type receives through the
// create ctx, and a pack never adds a layer).
//
// WHAT IT IS. ONE canvas the engine lays over a strokes type's target for the
// stroke in progress, reached by the type as `ctx.wet` (overlay.js
// registerCreateCtx, U516's seam: no overlay.js edit). The type pushes the
// browser's samples (input.samples / input.predicted) and asks for a paint;
// the engine keeps them in a preallocated ring and paints on the next
// animation frame. At pen-up the type writes its dry record (the element log
// is the type's, never this ring) and ends the stroke: the canvas stays one
// more frame, so the dry marker paints first, then is cleared and detached. A
// cancel (a pointercancel, a two-finger pan's cancelGesture) drops it at once.
//
//   initWetLayer({overlay?, raf?, rectOf?}) → api   idempotent: the first call
//     registers ctx.wet; every call may set the injectables (raf: the frame
//     scheduler, rectOf: the box read — the tests'; overlay: {registerCreateCtx,
//     frameReason}, default overlay.js's).
//   api.begin(target, {pointerId}) → boolean  refused (false) for a target
//     overlay.js frameReason refuses (a frame, inside one, another document)
//     or one not connected, or when the browser gives no 2D context. Lays the
//     canvas over target.getBoundingClientRect(), its backing the rect ×
//     devicePixelRatio (read at each begin) and its context scaled by it. A
//     begin while a stroke is active (or ending) ends that stroke first: the
//     same canvas, cleared, carries the new one.
//   api.push(samples, {predicted}?) → n  copies each sample's x, y (relative
//     to the target's rect at the newest frame), pressure and timeStamp into
//     the ring (WET_RING samples; a longer stroke overwrites its oldest —
//     counted in stats().dropped); the predicted samples go to a small slot
//     (WET_PREDICTED) every push overwrites: drawn provisionally, never kept.
//   api.paint(fn) → boolean  at most one requestAnimationFrame per frame;
//     the frame calls the newest fn(ctx2d, view). The engine clears nothing
//     between frames: a type redraws (view.clear(), then the stroke) or draws
//     incrementally from view.fresh (the samples pushed since its last paint;
//     after a resize, which clears the canvas, every sample kept).
//   api.end() / api.cancel() / api.active() / api.stats()
//     stats() → {allocs, frames, samples, dropped}, cumulative: allocs counts
//     every buffer or element this module creates (the canvas, the ring, the
//     predicted slot — all at the first begin, so it stays still after it).
//
// THE VIEW. One object, made once, read in place: count (kept samples), x(i),
// y(i), pressure(i), t(i) for i in [0, count) oldest first; predictedCount and
// predictedX/Y/Pressure/T(i); fresh, total, dropped (this stroke's), width,
// height (CSS px — the context is already scaled), dpr, pointerId, buffer
// (the ring itself, Float64Array of WET_RING × WET_FIELDS), clear().
//
// NO ALLOCATION PER SAMPLE OR PER PUSH: push and the frame create no array,
// object, closure or typed-array view; the frame writes the canvas's style
// only when the target's rect changed. The rect is re-read once per animation
// frame while a stroke is active, and a scroll or resize asks for that frame,
// so a scroll mid-stroke keeps the canvas on the target.
//
// WHERE IT PAINTS. In the chrome's own document body, position fixed,
// pointer-events none, at the overlay's page layer's rung (--z-pins; appended
// at each begin, so above #el-layer by tree order) — never inside a pane, a
// frame or a document. A document (preview, export, replay) never loads this
// module: a type must tolerate ctx.wet being undefined there. It is no host
// (HOST_NAMES) and takes no id (no reserved id): its class is .el-wet.
import { registerCreateCtx as ovRegisterCreateCtx, frameReason as ovFrameReason } from './overlay.js';

export const WET_RING = 4096;        // samples kept for the stroke in progress
export const WET_PREDICTED = 16;     // predicted samples drawn, each push overwrites them
export const WET_FIELDS = 4;         // per sample: x, y, pressure, timeStamp
export const WET_CTX_NAME = 'wet';   // the create ctx's member name
// The low-latency hint (Chrome's desynchronized canvas; ignored where unknown).
export const WET_CONTEXT_OPTIONS = Object.freeze({ desynchronized: true });
const DEFAULT_PRESSURE = 0.5;        // a sample with no pressure (the Pointer Events default for a pressed button)

const defaultRaf = (fn) => window.requestAnimationFrame(fn);
const defaultRectOf = (el) => el.getBoundingClientRect();
const cfg = { raf: defaultRaf, rectOf: defaultRectOf, frameReason: ovFrameReason };

let inited = false;
let api = null;
const counts = { allocs: 0, frames: 0, samples: 0, dropped: 0 };

// The buffers and the canvas, made at the first begin and reused for ever.
let ring = null;        // Float64Array(WET_RING * WET_FIELDS)
let pred = null;        // Float64Array(WET_PREDICTED * WET_FIELDS)
let canvas = null;
let ctx2d = null;

// The stroke.
let state = 'idle';     // 'idle' | 'active' | 'ending' (ended, detached at the next frame)
let target = null;
let pointerId = null;
let head = 0;           // the ring slot the next sample takes
let total = 0;          // samples pushed this stroke
let strokeDropped = 0;
let predN = 0;
let fresh = 0;          // samples pushed since the last paint (capped at the kept count)
let paintFresh = 0;     // what the running paint reads as view.fresh
let left = 0;
let top = 0;
let width = -1;
let height = -1;
let dpr = 1;
let pending = null;     // the newest paint fn
let scheduled = false;

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

function ensureCanvas() {
  if (!ring) { ring = new Float64Array(WET_RING * WET_FIELDS); counts.allocs++; }
  if (!pred) { pred = new Float64Array(WET_PREDICTED * WET_FIELDS); counts.allocs++; }
  if (!canvas) {
    canvas = document.createElement('canvas');
    counts.allocs++;
    canvas.className = 'el-wet';
    canvas.setAttribute('aria-hidden', 'true');
    canvas.style.cssText = 'position: fixed; left: 0px; top: 0px; margin: 0; padding: 0; border: 0;'
      + ' pointer-events: none; z-index: var(--z-pins);';
  }
  if (!ctx2d) {
    try { ctx2d = canvas.getContext('2d', WET_CONTEXT_OPTIONS) || null; } catch { ctx2d = null; }
  }
  return !!ctx2d;
}

// Re-read the target's rect; move the canvas and, on a size change, resize
// its backing (which clears it: every kept sample is fresh again).
function place(force) {
  const r = cfg.rectOf(target);
  const l = r.left;
  const t = r.top;
  const w = r.width > 0 ? r.width : 0;
  const h = r.height > 0 ? r.height : 0;
  if (force || l !== left) { left = l; canvas.style.left = `${l}px`; }
  if (force || t !== top) { top = t; canvas.style.top = `${t}px`; }
  if (force || w !== width || h !== height) {
    width = w;
    height = h;
    canvas.width = Math.max(1, Math.round(w * dpr));
    canvas.height = Math.max(1, Math.round(h * dpr));
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
    ctx2d.setTransform(dpr, 0, 0, dpr, 0, 0);
    fresh = keptCount();
  }
}

function schedule() {
  if (scheduled) return;
  scheduled = true;
  cfg.raf(onWetFrame);
}

function detach() {
  view.clear();
  if (canvas && canvas.parentNode) canvas.parentNode.removeChild(canvas);
  state = 'idle';
  target = null;
  pending = null;
  predN = 0;
}

function onWetFrame() {
  scheduled = false;
  counts.frames++;
  if (state === 'ending') { detach(); return; }
  if (state !== 'active') return;
  if (!target.isConnected) { detach(); return; }   // the target went mid-stroke: a cancel
  place(false);
  const fn = pending;
  if (!fn) return;
  pending = null;
  paintFresh = fresh;
  fresh = 0;
  fn(ctx2d, view);
}

function onViewportChange() {
  if (state === 'active') schedule();
}

function begin(el, opts) {
  if (!el || cfg.frameReason(el) || !el.isConnected) return false;
  if (!ensureCanvas()) return false;
  // A begin while a stroke is active or ending ends that one: the same canvas,
  // cleared below, carries the new stroke.
  state = 'idle';
  pending = null;
  target = el;
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
  state = 'active';
  return true;
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

function end() {
  if (state !== 'active') return false;
  state = 'ending';
  pending = null;
  predN = 0;
  schedule();
  return true;
}

function cancel() {
  if (state === 'idle') return false;
  detach();
  return true;
}

export function initWetLayer(opts = {}) {
  for (const k of ['raf', 'rectOf']) {
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
    stats: () => ({ allocs: counts.allocs, frames: counts.frames, samples: counts.samples, dropped: counts.dropped }),
  });
  register(WET_CTX_NAME, api);
  inited = true;
  window.addEventListener('scroll', onViewportChange, { capture: true, passive: true });
  window.addEventListener('resize', onViewportChange, { passive: true });
  return api;
}
