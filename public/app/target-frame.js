// The stroke frame and the engine's stroke commit (annotation engine tranche
// 4, plan 4F.1, U561; tranche 5, 5A.1, U611: the pane frame; U612: the page
// frame and the re-frame at commit — AD2 (a) is superseded for strokes,
// DECISIONS.md N.1, O.1, O.2; DECISIONS.md N.1 AD3 (b), AD5 (a); rulings
// STREAM@4F AF1 (a), PRIVATE@create AF2 (a), U561@stroke-keys-and-window (a),
// U561-U516@orphan-removed-target (a), REQ@ink-scope-v2 (b+), REQ@margins
// (a), REQ@arrow-endpoints (a), FRAME@pane-element (c), U612@reframe-slop (a),
// U612@page-kind-hint (a); FRAME@shared, CANVAS@home, PROTO@none).
//
// Two members on the overlay's create ctx (overlay.js registerCreateCtx, U516's
// seam — this module never edits the overlay), so a strokes type's create is
// thin and no type posts on its own. Generic to any strokes type: nothing here
// names a tool, a colour or a pack.
//
//   ctx.frameAt(event) → {ok: true, kind, target, record, w, h, aspect, rect}
//                        | {ok: true, kind: 'page', target, rect, w, h,
//                           aspect, down}
//                        | {ok: false, hint} | {ok: false, page: true, hint}
//     The frame under a press (tranche 5, 5A.1, U611; REQ@ink-scope-v2 (1),
//     DECISIONS.md K.2-259; FRAME@pane-element A9 (c); FRAME@above-the-walk).
//     The press's composedPath() is scanned ONCE, inner to outer, up to the
//     pane's content root: the ShadowRoot on the path whose host is a
//     .mount-host (a press inside a nested component's shadow root is in its
//     pane too). The press's element in that root's own tree — the innermost
//     element, or the host of the nested root it lies in (the first element
//     of the path whose getRootNode() is the pane root) — is what the walk
//     reads. In order:
//       1. the refusals: over an iframe (a frame element) or in one (another
//          document's node); a CONTROL (a button, an input, a select, a
//          textarea, an option, a label, a contenteditable that is not false)
//          on the innermost element's closest(), on the in-tree element's,
//          or anywhere on the path inside the pane (CONTROL@refused: a stroke
//          may cross a control and never takes its press);
//       2. kind 'target': the resolver's target-frame walk, called ONCE
//          (ctx.anchors.targetFrame, lib/core/anchors.js — the one walk;
//          nothing here re-walks the path): a fixed-aspect target (an img, a
//          canvas, an svg, a [data-fixed-aspect] element) wins unchanged; its
//          'chrome' refusal (a data-wc-chrome subtree) stays refused;
//       3. kind 'pane' — its other refusals ('not-fixed-aspect', 'no-box',
//          'unrecordable'): THE PANE FRAME, the OUTERMOST element on the path
//          inside the pane root (the element just before that root in
//          composedPath()), recorded by the anchors' own record() — no second
//          walk, no second targetFrame call —, its box the frame's rect and
//          w ÷ h to 4 decimals its aspect. A target or a pane frame carries
//          its mount and root beside (the re-frame at commit reads the root's
//          host). Over text a stroke may drift when the text re-wraps (drift
//          is reported beside, never a state: U531@aspect-drift).
//       4. kind 'page' (U612; REQ@ink-scope-v2 (2), REQ@margins (a)): a press
//          outside every pane root, or one the pane walk found no frame for
//          (on the .mount-host itself — the pane's padding —, a null record,
//          a zero box), is read on its innermost LIGHT-DOM element (the
//          .mount-host for the latter) against a POSITIVE list: inside a
//          markdown item's [data-md-id] block in #main; the .mount-host
//          itself (that pane is the pen-down item); or one of PAGE_SURFACES,
//          the page's own surfaces (page.js .md-block, .page-run, .run-grid,
//          .page-tail; mounts.js .pane, the wrapper's own box; #main;
//          .well-wrap, the gutters). A CONTROL on the path, a data-wc-chrome
//          subtree and EVERY element the list does not name — a .pane-header
//          and all inside it (its title text too), the resize handles,
//          .run-head and its ↺ / stacks buttons, .run-min, .min-chip,
//          .run-fixed-hint, .page-meta, .page-badge, .restore, .zero-state —
//          is the chrome: refused with FRAME_HINT (CONTROL@refused; it fails
//          closed). An admitted press takes the page frame ONLY for an armed
//          type whose listing row (element-types.js typeOf) declares 'page'
//          in its anchors; for any other it answers {ok: false, page: true,
//          hint: PAGE_KIND_HINT}, and that type keeps 627c5f53's frames (its
//          strokes are never widened, below). The page frame: {ok: true,
//          kind: 'page', target: #main, rect, w, h, aspect, down: {item,
//          kind: 'pane' | 'md' | null}} in THE PAGE BOX: x over the well's
//          client box (.well-wrap's left + clientLeft, and its clientWidth:
//          the gutters lie inside [0, 1]; on a window narrower than the
//          column the well and #main coincide), y over #main's border box
//          (its rect's top and height). One box for every page record.
//     Every other refusal answers FRAME_HINT (REQ@hint-reflow's words), the
//     one hint a type shows. A path that stops short of the pane root (a
//     synthetic press) takes the innermost element's own root, as before.
//     Points are not re-ruled: recordPoint and its hint stay on fixed-aspect
//     targets (REQ@point-scope (a)). `event` may be the create's input (its
//     .event is read); the type is the armed one.
//
//   ctx.stroke.begin(input) → a handle, or null
//     At the pointerdown: the tray guard first (element-types.js trayAction: a
//     previewed node refuses with READONLY_HINT before anything is drawn, D2),
//     then the frame. A refusal shows its hint through the one note (topbar
//     showReaimNote) and answers null: a refused press draws and posts nothing.
//     The pointerdown's own samples are the stroke's first. The type is the
//     armed one.
//   handle.frame     the frame begin found, kind 'target', 'pane' or 'page' (a
//                    type's wet layer begins on handle.frame.target)
//   handle.count     the samples held
//   handle.rect      the rect the last read took ({left, top, w, h}): ONE
//                    object per handle, written in place (read only)
//   handle.push(x)   a later event's samples: x is the create's input (its
//                    samples, else its event; any sample in input.predicted
//                    is skipped) or the samples list itself. Each sample's
//                    clientX/Y goes to frame units against the frame's rect —
//                    re-read at most once per animation frame (U561b: the
//                    first push after a frame boundary, and the first after a
//                    re-render, resize or scroll; never per sample, never per
//                    push inside a frame; for a page frame the read is
//                    #main's rect, and the well's box is read at begin and
//                    again only after a window resize, since the scroller's
//                    own box does not move with its scroll) — HELD UNCLAMPED
//                    (U612: the clamp is at commit), with its pressure (0.5
//                    when the pointer reports none) and its ms since pen-down,
//                    into ONE growable Float64Array (capacity doubling): no
//                    allocation per sample. A predicted sample is never stored
//                    (a type paints those on its wet layer only).
//   handle.commit({tool, width, colour, shared}) → Promise<{ok: true, element}
//                    | {ok: false, hint}>
//                    Once per handle (one element per pen-down to pen-up).
//                    Refused unless `shared` is a boolean the type passed
//                    (PRIVATE@create: the default is the type's; the route's
//                    own default is never reached), tool and colour short
//                    strings and width a positive px width. REFRAME@commit
//                    (U612), once per handle: a target or a pane frame's
//                    stroke is WIDENED when any held sample lies more than
//                    REFRAME_SLOP_PX (in the pen-down frame's px) outside its
//                    box in either axis — and only for a type declaring
//                    'page'. Not widened: the samples are clamped to [0, 1]
//                    and the anchor is the frame's record, as before. Widened,
//                    or a page frame: every sample is taken to client px
//                    through the frame's rect read once at commit, then to
//                    the page box (read once) and clamped to [0, 1] there;
//                    when every sample lies inside the pen-down pane's
//                    .mount-host (read once) the record is that pane's
//                    'inside' page record (FRAME@pane-element (c): a stroke
//                    across two blocks of a pane is never cut to its first
//                    block); otherwise the endpoints are the items holding
//                    the first and the last point (a .mount-host's or a
//                    [data-md-id] block's box), else the item whose vertical
//                    span holds the point's y (the nearest in x of those),
//                    else the item nearest in y, ties to the earlier in page
//                    order (MARGIN@nearest-item) — ONE querySelectorAll over
//                    #main, each item's rect read at most once, never per
//                    sample. The record is lib/core/strokes pageRecord's (the
//                    one shape; a null — an endpoint past PAGE_END_MAX — is
//                    refused with FAILED_HINT, never clamped). It assumes the
//                    pen-down frame did not move against the page during the
//                    stroke. Then decimates and rounds (lib/core/strokes),
//                    runs every registered deriver keeping only
//                    DESCRIBE_KEYS, then ONE POST /api/elements through
//                    trayAction and http.js with the device claim: {type,
//                    anchor: the record, payload: {shared, tool, width: px ÷
//                    the frame's (or the page box's) width, colour, points,
//                    stride, aspect (the frame's, or the page box's w ÷ h),
//                    …derived}}. A refusal is shown as its hint.
//   handle.cancel()  drops the buffer (a pointercancel; cancelGesture's pan).
//
//   ctx.stroke.strokesOn(frame, {type}) → the live rows of that type an
//     eraser's hit test reads, and nothing more: (i) under a target or a pane
//     frame, the element rows the resolver places on the frame's target, as
//     they are; (ii) under EVERY frame kind, the page arm: each live row whose
//     anchor is a page record (isPageRecord) and whose box marker is drawn —
//     found in #el-layer ONLY, by data-el-ids~=id with data-place 'box', and
//     displayed — as a frozen view {...row, box: {left, top, w, h}}, the
//     marker's client rect (read once per call, cached under the layout
//     count); under a target or a pane frame only the page rows whose box
//     meets the frame's rect. A press that begins on a block erases that
//     block's strokes and any page stroke crossing it; one that begins in a
//     margin erases page strokes.
//
//   initTargetFrame({raf?}) — idempotent; every call may set raf, the frame
//     scheduler the rect read waits on (the tests' fake frame; null or absent:
//     the window's requestAnimationFrame). A document with no rAF (an export,
//     a jsdom without it) reads the rect on every push, as before U561b.
//
//   registerStrokeDerive(name, fn) → unregister: fn({frame, points, bbox,
//     target, items?}) → a partial payload (frame.kind tells a target, a pane
//     and the page apart). For a page record: frame is a page frame (kind
//     'page', its rect the page box at commit), points and bbox are in page
//     units, target is #main and items lists the endpoints' items — {id,
//     kind: 'pane' | 'md', root (the pane's shadowRoot or the md block),
//     rect} — one entry when from.item === to.item, so a deriver walks the
//     items, never #main's tree. Only its DESCRIBE_KEYS are kept. A throw is
//     logged and the stroke commits without it. Names are unique.
//
// THE ANCHOR is the frame target's element record — a fixed-aspect target's
// or, for a pane frame, the outermost element's — or, for a page frame or a
// widened stroke, a page record (lib/core/strokes isPageRecord; never placed
// by the resolver: mapPage places it by its items). An element record is
// placed by the resolver and the overlay's DRAW_RULES (unchanged): exact or
// re-resolved, the box marker sits on the target's current rect and the
// stroke follows a re-render, a move or a resize (its points are box units);
// orphaned with a locator guess, drawn at the guess (group.kind 'guess', the
// type draws it faded); orphaned with no guess, never drawn at a stale
// position — listed by orphans(). A stroke group is strokes.js strokeGroups'
// read-time answer, never stored here.
import { registerCreateCtx, elementsOf, armed } from './overlay.js';
import { trayAction, TRAY_REFUSAL, typeOf } from './element-types.js';
import { request } from './http.js';
import { showReaimNote } from './topbar.js';
import anchorsApi from './anchors.js';
import {
  STROKE_STRIDE, DESCRIBE_KEYS, STROKE_POINTS_MAX, STROKE_NAME_MAX,
  decimate, roundPoints, bboxOf, isPageRecord, pageRecord,
} from './strokes.js';

export const FRAME_HINT = 'Ink draws anywhere on the page but on a control or the chrome; over text it may drift when the text re-wraps';
export const SHARED_HINT = 'A stroke is sent only with shared true or false, as its type passes it.';
export const STYLE_HINT = `A stroke needs a tool and a colour (at most ${STROKE_NAME_MAX} characters each) and a width above 0.`;
export const EMPTY_HINT = 'Nothing was drawn.';
export const SPENT_HINT = 'This stroke was already sent or dropped.';
export const FAILED_HINT = 'The stroke was not saved.';
// A press the page frame admits, for an armed type whose listing row does not
// declare 'page' (RULED U612@page-kind-hint I2 (a)).
export const PAGE_KIND_HINT = 'This tool draws on panes, images and canvases only; its pack does not draw in the margins yet.';
// REFRAME@commit's tolerance (RULED U612@reframe-slop I1 (a)): a sample up to
// this many CSS px outside the pen-down frame's box keeps the stroke on it.
export const REFRAME_SLOP_PX = 8;
// The page's own surfaces a page frame's press may land on (page.js's
// .md-block, .page-run, .run-grid and .page-tail; mounts.js's .pane, the
// wrapper's own box; #main; the well, .well-wrap). Besides these, a markdown
// item's [data-md-id] block and anything inside it, and a .mount-host itself
// (a pane's padding). Every other element in the well is the chrome.
export const PAGE_SURFACES = '.md-block, .page-run, .run-grid, .page-tail, .pane, #main, .well-wrap';
export const ELEMENTS_PATH = '/api/elements';
export const BUFFER_START = 256;   // numbers (64 samples); doubled as a stroke grows
// A press on one of these is a control's, never ink's (checked on the
// innermost element only).
const CONTROL = 'button, input, select, textarea, option, label, [contenteditable]:not([contenteditable="false"])';
const FRAMES = new Set(['iframe', 'frame', 'object', 'embed']);

// The frame scheduler the rect read waits on: the injected one, else the
// window's; false when there is none (the caller reads per push).
const cfg = { raf: null };
function askFrame(fn) {
  if (cfg.raf) { cfg.raf(fn); return true; }
  if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
    window.requestAnimationFrame(fn);
    return true;
  }
  return false;
}
// Bumped by a re-render (the mount runtime's settle), a window resize or a
// scroll: a handle whose rect was read under an older count reads at once,
// whatever the frame (the re-render follow, U561a's).
let layoutEpoch = 0;
const layoutMoved = () => { layoutEpoch++; };
// Bumped by a window resize only: a page frame's well box (its x extent) is
// read at begin and again only after one.
let resizeEpoch = 0;
const resized = () => { layoutEpoch++; resizeEpoch++; };

function note(text) {
  try { showReaimNote(text); } catch { /* the note is a courtesy */ }
}

// A pane's mount id, read off its .mount-host; null for any other host.
function mountOf(h) {
  if (!h || !h.classList || !h.classList.contains('mount-host')) return null;
  return (h.dataset && h.dataset.mountId) || h.id || null;
}
const isPaneRoot = (n) => !!(n && n.nodeType === 11 && n.host && mountOf(n.host));

// The pane content root a node sits in: the shadow root of a .mount-host
// (its mount id beside it), else null.
function contentRootOf(el) {
  const root = el && typeof el.getRootNode === 'function' ? el.getRootNode() : null;
  if (!root || root.nodeType !== 11 || !root.host) return null;
  const mount = mountOf(root.host);
  return mount ? { root, mount } : null;
}

const REFUSED = Object.freeze({ ok: false, hint: FRAME_HINT });
// A press the page frame admits, for a type that does not declare 'page'.
const PAGE_REFUSED = Object.freeze({ ok: false, page: true, hint: PAGE_KIND_HINT });
const isControl = (n) => !!(n && n.nodeType === 1 && typeof n.matches === 'function' && n.matches(CONTROL));
const inControl = (n) => !!(n && typeof n.closest === 'function' && n.closest(CONTROL));

const round4 = (v) => Math.round(v * 1e4) / 1e4;

// Whether the armed type's listing row declares 'page' in its anchors.
function takesPage(type) {
  const row = type ? typeOf(type) : null;
  return !!(row && Array.isArray(row.anchors) && row.anchors.includes('page'));
}

// The page's two elements: #main and the well (.well-wrap; #main itself when
// the shell has no well), or null.
function pageEls() {
  const main = typeof document !== 'undefined' ? document.getElementById('main') : null;
  if (!main) return null;
  const well = (typeof main.closest === 'function' && main.closest('.well-wrap')) || main;
  return { main, well };
}
// The page box's x extent, into out: the well's client box (its rect's left
// plus clientLeft, and its clientWidth — the rect's width where the browser
// reports none). False for a box with no width.
function wellInto(out, well) {
  const b = well && typeof well.getBoundingClientRect === 'function' ? well.getBoundingClientRect() : null;
  if (!b) return false;
  const cw = well.clientWidth > 0 ? well.clientWidth : b.width;
  if (!(cw > 0)) return false;
  out.left = b.left + (well.clientLeft > 0 ? well.clientLeft : 0);
  out.w = cw;
  return true;
}
// The page box's y extent, into out: #main's border box.
function mainInto(out, main) {
  const b = main && typeof main.getBoundingClientRect === 'function' ? main.getBoundingClientRect() : null;
  if (!b || !(b.height > 0)) return false;
  out.top = b.top;
  out.h = b.height;
  return true;
}

// The page frame's positive list, on a press's innermost light-DOM element:
// {item, kind} of the pen-down item, or null (the chrome: refused).
function pageDown(el, els) {
  if (!el || el.nodeType !== 1 || typeof el.closest !== 'function' || typeof el.matches !== 'function') return null;
  if (typeof el.getRootNode !== 'function' || el.getRootNode() !== document) return null;
  if (!els.well.contains(el) || inControl(el) || el.closest('[data-wc-chrome]')) return null;
  const md = el.closest('[data-md-id]');
  if (md) return els.main.contains(md) ? { item: md.getAttribute('data-md-id'), kind: 'md' } : null;
  const m = mountOf(el);
  if (m) return { item: m, kind: 'pane' };   // the pane's padding
  if (!el.matches(PAGE_SURFACES)) return null;
  if (el.classList.contains('pane')) {
    for (const c of el.children) { const id = mountOf(c); if (id) return { item: id, kind: 'pane' }; }
  }
  return { item: null, kind: null };
}

// THE PAGE FRAME (U612) for a press on `light`, or a refusal.
function pageFrame(light, control, type) {
  const els = pageEls();
  const down = !control && els ? pageDown(light, els) : null;
  if (!down) return REFUSED;
  if (!takesPage(type)) return PAGE_REFUSED;
  const rect = { left: 0, top: 0, w: 0, h: 0 };
  if (!wellInto(rect, els.well) || !mainInto(rect, els.main)) return REFUSED;
  return {
    ok: true, kind: 'page', target: els.main, well: els.well, rect, w: rect.w, h: rect.h,
    aspect: round4(rect.w / rect.h), down,
  };
}

function frameOf(event, api, type) {
  const e = event && event.event && typeof event.event === 'object' ? event.event : event;
  if (!e || typeof e !== 'object') return REFUSED;
  const path = typeof e.composedPath === 'function' ? e.composedPath() : [];
  // ONE scan of the path, inner to outer, up to the pane's content root: the
  // innermost element, a control anywhere on the way (a nested component's
  // button is a control too), and the root's index k.
  let el = null;
  let k = -1;
  let control = false;
  for (let i = 0; i < path.length; i++) {
    const n = path[i];
    if (!n) continue;
    if (n.nodeType === 1) {
      if (!el) el = n;
      if (isControl(n)) control = true;
    } else if (isPaneRoot(n)) { k = i; break; }
  }
  if (!el && e.target && e.target.nodeType === 1) el = e.target;
  if (!el) return REFUSED;
  // Never through a frame: a press over one (the frame element) or in one
  // (another document's node).
  if (el.ownerDocument !== document || FRAMES.has(String(el.localName || '').toLowerCase())) return REFUSED;
  let root = null;
  if (k >= 0) root = path[k];
  else {
    // A path that stops short of the root (a synthetic press): the innermost
    // element's own root, as before; its outermost element is the last of
    // the path's elements in that root.
    const w = contentRootOf(el);
    if (w) { root = w.root; k = path.length; }
  }
  // Outside every pane root (a markdown item, #main's padding, the well's
  // gutters, a press on a .mount-host itself): the page frame's list.
  if (!root) return pageFrame(el, control, type);
  const mount = mountOf(root.host);
  // The press's element in the pane root's own tree: the innermost element,
  // or the host of the nested shadow root it lies in.
  let own = null;
  let outer = null;
  for (let i = 0; i < k; i++) {
    const n = path[i];
    if (!n || n.nodeType !== 1 || typeof n.getRootNode !== 'function' || n.getRootNode() !== root) continue;
    if (!own) own = n;
    outer = n;
  }
  if (!own) own = el.getRootNode && el.getRootNode() === root ? el : null;
  if (!own) return REFUSED;
  if (control || inControl(el) || inControl(own)) return REFUSED;
  const a = api || anchorsApi;
  if (!a || typeof a.targetFrame !== 'function') return REFUSED;
  const f = a.targetFrame(root, own, { mount });
  if (f && !f.refused && f.target && f.record) {
    return {
      ok: true, kind: 'target', target: f.target, record: f.record, w: f.w, h: f.h, aspect: f.aspect,
      rect: { left: f.left, top: f.top, w: f.w, h: f.h }, mount, root,
    };
  }
  // A control or the chrome stays refused (CONTROL@refused).
  if (!f || f.refused === 'chrome' || !f.refused) return REFUSED;
  // THE PANE FRAME (FRAME@pane-element): the outermost element on the path
  // inside the pane root, its element record and its box. None (a null
  // record, a zero box): the page frame on the pane's .mount-host.
  if (!outer) return pageFrame(root.host, false, type);
  const rec = (typeof a.record === 'function' ? a : anchorsApi).record(root, outer, { mount });
  if (!rec) return pageFrame(root.host, false, type);
  const b = typeof outer.getBoundingClientRect === 'function' ? outer.getBoundingClientRect() : null;
  if (!b || !(b.width > 0) || !(b.height > 0)) return pageFrame(root.host, false, type);
  return {
    ok: true, kind: 'pane', target: outer, record: rec, w: b.width, h: b.height,
    aspect: round4(b.width / b.height),
    rect: { left: b.left, top: b.top, w: b.width, h: b.height }, mount, root,
  };
}

// The create ctx's member: called as ctx.frameAt(event), `this` is that ctx
// and its anchors the resolver asked; detached, the chrome's own.
function frameAt(event) {
  const a = armed();
  return frameOf(event, this && this.anchors ? this.anchors : null, a && a.type);
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

// ── the page's items (U612: the endpoints, at commit only) ──────────────────
// Every item of the page in page order: ONE querySelectorAll over #main's
// .mount-host and [data-md-id] blocks (the scan mount-runtime itemEl does);
// each rect read at most once, when the search first needs it.
function pageItems(main) {
  const out = [];
  for (const el of main.querySelectorAll('.mount-host, [data-md-id]')) {
    const m = mountOf(el);
    const id = m || el.getAttribute('data-md-id');
    if (id) out.push({ id, kind: m ? 'pane' : 'md', el, rect: undefined });
  }
  return out;
}
function itemRect(it) {
  if (it.rect !== undefined) return it.rect;
  const b = typeof it.el.getBoundingClientRect === 'function' ? it.el.getBoundingClientRect() : null;
  it.rect = b && b.width > 0 && b.height > 0 ? { left: b.left, top: b.top, w: b.width, h: b.height } : null;
  return it.rect;
}
// MARGIN@nearest-item: the item holding the point, else the one whose vertical
// span holds its y (the nearest of those in x), else the nearest in y; a tie
// goes to the earlier in page order.
function nearestItem(list, q) {
  let span = null;
  let spanD = Infinity;
  let near = null;
  let nearD = Infinity;
  for (const it of list) {
    const r = itemRect(it);
    if (!r) continue;
    const inY = q.y >= r.top && q.y <= r.top + r.h;
    if (inY && q.x >= r.left && q.x <= r.left + r.w) return it;
    if (inY) {
      const d = q.x < r.left ? r.left - q.x : q.x - (r.left + r.w);
      if (d < spanD) { spanD = d; span = it; }
      continue;
    }
    const d = q.y < r.top ? r.top - q.y : q.y - (r.top + r.h);
    if (d < nearD) { nearD = d; near = it; }
  }
  return span || near;
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
  // At most one rect read per animation frame (GT-22 F3, U561b): rectFresh is
  // set by a read and cleared by ONE held frame callback, made once here,
  // never per push; readAt is the layout count the read was taken under.
  let rectFresh = false;
  let rafPending = false;
  let readAt = -1;
  const clearFresh = () => { rectFresh = false; rafPending = false; };
  // A page frame (U612): its rect is the page box — #main's y extent per read,
  // the well's x extent from begin until a window resize.
  const page = frame.kind === 'page';
  let wellAt = resizeEpoch;
  // REFRAME@commit applies to a type that declares 'page' only.
  const widens = !page && takesPage(type);

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
    buf[len] = (s.clientX - rect.left) / rect.w;
    buf[len + 1] = (s.clientY - rect.top) / rect.h;
    buf[len + 2] = Number.isFinite(p) && p > 0 ? (p > 1 ? 1 : p) : 0.5;
    buf[len + 3] = t;
    len += STROKE_STRIDE;
  }
  function readRect() {
    if (page) { readPageRect(); return; }
    const t = frame.target;
    const b = t && typeof t.getBoundingClientRect === 'function' ? t.getBoundingClientRect() : null;
    // A zero-size box leaves the previous rect in place.
    if (b && b.width > 0 && b.height > 0) { rect.left = b.left; rect.top = b.top; rect.w = b.width; rect.h = b.height; }
  }
  // The page box's read: #main's rect (ONE layout read); the well's box only
  // after a window resize. A zero-size box leaves the previous one in place.
  function readPageRect() {
    mainInto(rect, frame.target);
    if (wellAt !== resizeEpoch) { wellAt = resizeEpoch; wellInto(rect, frame.well); }
  }
  // The push's read: skipped while this frame's read stands and the layout
  // has not moved since; with no frame scheduler, every push reads.
  function freshRect() {
    if (rectFresh && readAt === layoutEpoch) return;
    readRect();
    readAt = layoutEpoch;
    if (rafPending) { rectFresh = true; return; }
    if (askFrame(clearFresh)) { rafPending = true; rectFresh = true; }
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
        freshRect();
        take(e);
        return;
      }
    }
    freshRect();
    for (let i = 0; i < list.length; i++) {
      const s = list[i];
      if (!s || s.predicted === true || (predicted && predicted.includes(s))) continue;
      if (!Number.isFinite(s.clientX) || !Number.isFinite(s.clientY)) continue;
      take(s);
    }
  }
  function cancel() {
    done = true;
    rectFresh = false;
    rafPending = false;
    len = 0;
    buf = null;
  }
  // ── REFRAME@commit (U612) ──
  // Whether any held sample lies more than REFRAME_SLOP_PX outside the frame's
  // box (in its px: the held rect's size) in either axis.
  function leaves(raw) {
    const sx = REFRAME_SLOP_PX / rect.w;
    const sy = REFRAME_SLOP_PX / rect.h;
    for (let i = 0; i < raw.length; i += STROKE_STRIDE) {
      const x = raw[i];
      const y = raw[i + 1];
      if (x < -sx || x > 1 + sx || y < -sy || y > 1 + sy) return true;
    }
    return false;
  }
  // The stroke's anchor, points, width base, aspect and derive input; null
  // when no record can be made (refused, never clamped).
  function place(raw) {
    if (page) return onPage(raw, null, null);
    if (widens && leaves(raw)) {
      const t = frame.target;
      const b = t && typeof t.getBoundingClientRect === 'function' ? t.getBoundingClientRect() : null;
      const host = frame.root && frame.root.host ? frame.root.host : null;
      if (b && b.width > 0 && b.height > 0) return onPage(raw, { left: b.left, top: b.top, w: b.width, h: b.height }, host);
    }
    for (let i = 0; i < raw.length; i += STROKE_STRIDE) { raw[i] = clamp01(raw[i]); raw[i + 1] = clamp01(raw[i + 1]); }
    const points = roundPoints(decimate(raw, { max: STROKE_POINTS_MAX }));
    return {
      anchor: frame.record, points, w: frame.w, aspect: frame.aspect,
      derive: { frame, points, bbox: bboxOf(points), target: frame.target },
    };
  }
  // The page record: `fr` the pen-down frame's rect at commit (null: the
  // samples are page units already, a page frame's), `host` the pen-down
  // pane's .mount-host (the 'inside' arm's box).
  function onPage(raw, fr, host) {
    const els = pageEls();
    if (!els) return null;
    const pb = { left: 0, top: 0, w: 0, h: 0 };
    if (!wellInto(pb, els.well) || !mainInto(pb, els.main)) return null;
    let hb = null;
    if (fr && host && typeof host.getBoundingClientRect === 'function') {
      const b = host.getBoundingClientRect();
      if (b && b.width > 0 && b.height > 0) hb = { left: b.left, top: b.top, w: b.width, h: b.height };
    }
    let inside = !!hb;
    for (let i = 0; i < raw.length; i += STROKE_STRIDE) {
      let x = raw[i];
      let y = raw[i + 1];
      if (fr) {
        const cx = fr.left + x * fr.w;
        const cy = fr.top + y * fr.h;
        if (inside && (cx < hb.left || cx > hb.left + hb.w || cy < hb.top || cy > hb.top + hb.h)) inside = false;
        x = (cx - pb.left) / pb.w;
        y = (cy - pb.top) / pb.h;
      }
      raw[i] = clamp01(x);
      raw[i + 1] = clamp01(y);
    }
    const points = roundPoints(decimate(raw, { max: STROKE_POINTS_MAX }));
    const last = points.length - STROKE_STRIDE;
    const p0 = { x: pb.left + points[0] * pb.w, y: pb.top + points[1] * pb.h };
    const pn = { x: pb.left + points[last] * pb.w, y: pb.top + points[last + 1] * pb.h };
    let a;
    let b;
    if (inside) {
      a = { id: mountOf(host), kind: 'pane', el: host, rect: hb };
      b = a;
    } else {
      const list = pageItems(els.main);
      a = nearestItem(list, p0);
      b = nearestItem(list, pn);
    }
    if (!a || !b || !a.id || !b.id) return null;
    const end = (it, q) => ({ item: it.id, x: (q.x - it.rect.left) / it.rect.w, y: (q.y - it.rect.top) / it.rect.h, w: it.rect.w, h: it.rect.h });
    const anchor = pageRecord({ from: end(a, p0), to: end(b, pn), frame: { w: pb.w, h: pb.h } });
    if (!anchor) {
      console.error('[web-chat] strokes: no page record for this stroke (an endpoint lies too far from its nearest item, or the item\'s id is not [A-Za-z0-9_-])');
      return null;
    }
    const aspect = round4(pb.w / pb.h);
    const down = page ? frame.down : { item: host ? mountOf(host) : null, kind: host ? 'pane' : null };
    const pf = { ok: true, kind: 'page', target: els.main, well: els.well, rect: pb, w: pb.w, h: pb.h, aspect, down };
    const items = (a === b ? [a] : [a, b]).map((it) => ({
      id: it.id, kind: it.kind, root: it.kind === 'pane' ? it.el.shadowRoot || null : it.el, rect: { ...it.rect },
    }));
    return { anchor, points, w: pb.w, aspect, derive: { frame: pf, points, bbox: bboxOf(points), target: els.main, items } };
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
    rectFresh = false;
    rafPending = false;
    buf = null;
    len = 0;
    if (!held) { note(EMPTY_HINT); return { ok: false, hint: EMPTY_HINT }; }
    const placed = place(raw);
    if (!placed) { note(FAILED_HINT); return { ok: false, hint: FAILED_HINT }; }
    const derived = await derive(placed.derive);
    const payload = {
      ...derived,
      shared: o.shared,
      tool: o.tool,
      width: o.width / placed.w,
      colour: o.colour,
      points: placed.points,
      stride: STROKE_STRIDE,
      aspect: placed.aspect,
    };
    const body = { type, anchor: placed.anchor, payload };
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
    get rect() { return rect; },   // the held rect (read only): the box the last read took
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
  const f = frameOf(input, ctx && ctx.anchors ? ctx.anchors : null, a.type);
  if (!f.ok) { note(f.hint); return null; }
  return makeHandle(a.type, f, input);
}

// The eraser's page arm (U612): a page row's drawn box marker in #el-layer
// (data-place 'box', data-el-ids naming it, displayed), its client rect read
// once per marker and cached under the layout count.
const markerBoxes = new WeakMap();   // marker → {at, box}
function boxMarkers() {
  const layer = typeof document !== 'undefined' ? document.getElementById('el-layer') : null;
  const out = new Map();   // element id → marker
  if (!layer) return out;
  for (const m of layer.querySelectorAll('[data-place="box"][data-el-ids]')) {
    if (m.hidden || (m.style && m.style.display === 'none')) continue;
    for (const id of String(m.getAttribute('data-el-ids')).split(/\s+/)) if (id && !out.has(id)) out.set(id, m);
  }
  return out;
}
function markerBox(m) {
  const had = markerBoxes.get(m);
  if (had && had.at === layoutEpoch) return had.box;
  const b = typeof m.getBoundingClientRect === 'function' ? m.getBoundingClientRect() : null;
  const box = b && b.width > 0 && b.height > 0 ? Object.freeze({ left: b.left, top: b.top, w: b.width, h: b.height }) : null;
  markerBoxes.set(m, { at: layoutEpoch, box });
  return box;
}
const meets = (a, b) => a.left <= b.left + b.w && a.left + a.w >= b.left && a.top <= b.top + b.h && a.top + a.h >= b.top;

// The live rows of `type` an eraser reads under the frame: the element rows
// the resolver places on a target or a pane frame's target, as they are; and,
// under every frame kind, each drawn page row as a frozen {...row, box} (under
// a target or a pane frame only those whose box meets the frame's rect).
function strokesOn(frame, { type } = {}) {
  if (!frame || !frame.ok || !frame.target) return [];
  const onElement = frame.kind !== 'page' && !!frame.record;
  const where = onElement ? contentRootOf(frame.target) : null;
  let ix = null;
  let markers = null;
  const out = [];
  for (const r of elementsOf('live')) {
    if (type != null && r.type !== type) continue;
    const a = r.anchor;
    if (isPageRecord(a)) {
      if (!markers) markers = boxMarkers();
      const m = markers.get(r.id);
      const box = m ? markerBox(m) : null;
      if (!box) continue;
      if (frame.kind !== 'page' && !(frame.rect && meets(box, frame.rect))) continue;
      out.push(Object.freeze({ ...r, box }));
      continue;
    }
    if (!where) continue;
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
export function initTargetFrame(opts = {}) {
  if (opts && Object.prototype.hasOwnProperty.call(opts, 'raf')) {
    if (opts.raf != null && typeof opts.raf !== 'function') throw new TypeError('initTargetFrame: raf must be a function');
    cfg.raf = opts.raf || null;
  }
  if (unregister) return;
  const a = registerCreateCtx('frameAt', frameAt);
  const b = registerCreateCtx('stroke', stroke);
  // The re-render follow: a settle, a resize or a scroll moves the layout
  // count, so the next push reads the rect at once.
  const M = typeof window !== 'undefined' ? window.__wcMount : null;
  const c = M && typeof M.onSettle === 'function' ? M.onSettle(layoutMoved) : null;
  if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
    window.addEventListener('scroll', layoutMoved, { capture: true, passive: true });
    window.addEventListener('resize', resized, { passive: true });
  }
  unregister = () => {
    a(); b();
    if (c) c();
    if (typeof window !== 'undefined' && typeof window.removeEventListener === 'function') {
      window.removeEventListener('scroll', layoutMoved, { capture: true });
      window.removeEventListener('resize', resized);
    }
    unregister = null;
  };
}
