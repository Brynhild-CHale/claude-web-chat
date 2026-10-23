// The input-mode policy (annotation engine 2D.4; DECISIONS.md I.6 addendum 3
// "stylus and touch", K.2 items 3, 6, 8, 9, 14, 15; W-10): which pointer goes
// to the armed tool and which to the page, as ONE table keyed by
// PointerEvent.pointerType, installed at the overlay's one pointer dispatch
// (overlay.js setPointerPolicy). The engine row: the pointer-type rule lives
// here; never a second table, and never a second armed state.
//
//   route(ev, s)          → 'tool' | 'page' | 'ignore'   THE table (pure)
//   isInteractive(el)     → boolean                       the finger's control test (K.2-9)
//   dispatchMode(ev, kind)→ {capture, cancelDefault}      how a tool takes its pointer
//   POINTER                                               the pointer tool (chrome-owned; arms nothing)
//   fingerDraws() · fingerDrawsMode() · setFingerDraws(mode) · setFingerDrawsDefault(v)
//   onFingerDrawsChange(fn)                               the finger-draws switch (K.2-8, K.2-15)
//   installInputMode()                                    the policy at setPointerPolicy, the pen watch,
//                                                         the two-finger pan
//   fingerStrokes() · touchesForTests()                   is the finger drawing; the touches tracked
//
// The table (s = {armed, input, fingerDraws, penDown, gesture?}):
//   nothing armed (the pointer tool too) → 'page' for every pointer: the
//     pointer tool turns the pen into a finger, and a finger stays a finger;
//   a click no pointer made (detail 0: Enter or Space on a focused control, a
//     field's implicit submit from Enter or Go, a script's el.click()) → 'page',
//     before the pointerType rows: a focused field takes its taps and keys with
//     the tool armed (K.2-9), so its submit is the page's;
//   pen   → 'tool', always, on a pane's controls too (clicking a control with
//           a pen is the pointer tool's or a finger's job, K.2-9);
//   mouse → 'tool' (a desktop has no stylus distinction); an unknown or empty
//           pointerType reads as mouse;
//   touch → 'ignore' while a pen pointer is down (a resting palm; the OS's own
//           palm rejection stays the first line); else 'page' on interactive
//           content (the control acts, the tool stays armed, K.2-9); else, on
//           static content, by the armed type's input kind (K.2-6, D1 (b)):
//             taps      → 'tool' for a tap (within sheet-model's TAP_SLOP, no
//                         pan), 'page' for a pan;
//             strokes   → 'tool' only with finger-draws on (drawing tools need
//                         a pen or finger-draws), else 'page';
//             selection → 'tool' for a tap (a long press) or, with finger-draws
//                         on, a drag; a pan without it is the page's scroll.
//
// The armed state is overlay.js's (setArmed / armed / onArmedChange, K.2-3) and
// the armed type's input kind its inputKindOf (K.2-14): this module reads them
// and keeps neither. Refusals (previews, levels) are the tools module's
// (U337). It never fetches; the user record's finger-draws default arrives
// through setFingerDrawsDefault (main.js feeds it from the toolbar state).
//
// The three facts that bound it (addendum 3): touch-action cannot be set per
// pointer type, so the page well keeps the browser's finger gestures
// (`#main { touch-action: manipulation }`, app.css's input-mode block) and only
// a pen's default is cancelled in a handler — except while finger-draws is on
// and a strokes tool is armed, when the finger IS the drawing pointer and the
// well takes `touch-action: none` (html.finger-strokes) so a finger stroke is
// not claimed as a pan, pinch-zoom off while it is armed (K.4 I1 = b), and the
// page scrolls by TWO fingers, panned here (the two-finger pan, below: one
// finger draws, a second finger turns the gesture into a scroll of the well,
// with no disarm step, H1 = a); the chrome's own `touch-action: none` handles
// (graph canvas, pane grips, the sheet's grip tab) are chrome gestures and
// stay; the Pencil's double-tap and squeeze never reach a page, so switching is
// the toolbar's, the hotkeys' and the pointer tool's. The two older pointerType
// reads (shell.js, the rail's hover ignores touch; sheet-drag.js, the grip
// tab's mouse-button filter) are theirs and stay as they are.
//
// No DOM is touched at import.
import { armed, cancelGesture, inputKindOf, onArmedChange, setPointerPolicy, INPUT_KINDS } from './overlay.js';
import { isTap } from './sheet-model.js';
import { getLocal, setLocal } from './storage.js';

// ── the pointer tool ─────────────────────────────────────────────────────────
// A chrome-owned tool, never an element type (no type name is reserved for
// it): the tools module (U337) arms it as setArmed(null), so every pointer
// goes to the page.
export const POINTER = Object.freeze({ id: 'pointer', label: 'Pointer', chrome: true, arms: null });

// ── interactive content (K.2-9) ──────────────────────────────────────────────
// The HTML spec's interactive content, as a finger meets it: a tap on one
// performs the control's action with the tool still armed. `summary` stands
// for `details` (a details element's body is static content; its summary is
// what toggles it).
export const INTERACTIVE_ROLES = Object.freeze([
  'button', 'checkbox', 'combobox', 'link', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'option',
  'radio', 'searchbox', 'slider', 'spinbutton', 'switch', 'tab', 'textbox', 'treeitem',
]);
const ALWAYS = new Set(['button', 'select', 'textarea', 'label', 'summary', 'iframe', 'embed']);
const EDITABLE = new Set(['', 'true', 'plaintext-only']);

function selfInteractive(el) {
  const tag = el.localName;
  if (ALWAYS.has(tag)) return true;
  if (tag === 'a' || tag === 'area') return el.hasAttribute('href');
  if (tag === 'input') return String(el.getAttribute('type') || '').toLowerCase() !== 'hidden';
  if (tag === 'audio' || tag === 'video') return el.hasAttribute('controls');
  if (tag === 'img') return el.hasAttribute('usemap');
  if (el.hasAttribute('tabindex')) return true;
  const role = String(el.getAttribute('role') || '').trim().toLowerCase().split(/\s+/)[0];
  return INTERACTIVE_ROLES.includes(role);
}
// The page well's own element: the walk stops there, so the chrome around it
// (#stage carries a tabindex) never makes the page's content interactive.
function isWell(el) {
  return el.id === 'main' && el.getRootNode && el.getRootNode() === el.ownerDocument;
}
// isInteractive(el): el, or an ancestor up to the page well (across a pane's
// shadow boundary), is interactive content.
export function isInteractive(el) {
  let editableBlocked = false;
  for (let n = el; n && n.nodeType === 1; ) {
    if (isWell(n) || n.localName === 'body' || n.localName === 'html') return false;
    if (selfInteractive(n)) return true;
    if (!editableBlocked && n.hasAttribute('contenteditable')) {
      const v = String(n.getAttribute('contenteditable')).toLowerCase();
      if (EDITABLE.has(v)) return true;
      if (v === 'false') editableBlocked = true;
    }
    if (n.parentElement) { n = n.parentElement; continue; }
    const root = n.getRootNode ? n.getRootNode() : null;
    n = root && root.nodeType === 11 && root.host ? root.host : null;
  }
  return false;
}

// The event's target: the composed path's first element (inside a pane's
// shadow root), else its target.
function targetOf(ev) {
  const path = ev && typeof ev.composedPath === 'function' ? ev.composedPath() : [];
  for (const n of path) if (n && n.nodeType === 1) return n;
  const t = ev && ev.target;
  return t && t.nodeType === 1 ? t : null;
}

// ── THE table ────────────────────────────────────────────────────────────────
// A finger on static content, by the armed type's input kind.
const FINGER = Object.freeze({
  taps: (c) => (c.tap ? 'tool' : 'page'),
  strokes: (c) => (c.fingerDraws ? 'tool' : 'page'),
  selection: (c) => (c.tap || c.fingerDraws ? 'tool' : 'page'),
});
// One row per pointerType, the policy for a pointer while a type is armed.
export const POINTER_TABLE = Object.freeze({
  pen: () => 'tool',                                    // always the tool, on controls too (K.2-9)
  mouse: () => 'tool',                                  // as the pen: a desktop has no stylus distinction
  touch: (c) => (c.penDown ? 'ignore' : c.interactive() ? 'page' : FINGER[c.input](c)),
});

export function pointerTypeOf(ev) {
  const t = ev && ev.pointerType;
  return typeof t === 'string' && Object.hasOwn(POINTER_TABLE, t) ? t : 'mouse';
}

// route(ev, s) → 'tool' | 'page' | 'ignore'. s = {armed, input, fingerDraws,
// penDown, gesture}: `armed` the overlay's armed() (null: nothing, or the
// pointer tool), `input` the armed type's input kind (overlay inputKindOf;
// absent reads as taps, as the overlay's dispatch does), `gesture` {dx, dy} the
// farthest the pointer has gone from its pointerdown on each axis (absent: at
// the pointerdown, a tap so far).
export function route(ev, s = {}) {
  if (!s || !s.armed) return 'page';
  // A keyboard's or a script's click: no pointer behind it, so no row of the
  // table is its. The overlay asks about a click only when no pointer gesture
  // of its own is under way (a lone click); a real pointer's click counts its
  // presses (a detail of one or more), and '' stays the mouse's for those.
  if (ev && ev.type === 'click' && ev.detail === 0) return 'page';
  const g = s.gesture || {};
  const c = {
    input: INPUT_KINDS.includes(s.input) ? s.input : 'taps',
    fingerDraws: !!s.fingerDraws,
    penDown: !!s.penDown,
    tap: isTap(g.dx, g.dy),
    interactive: () => isInteractive(targetOf(ev)),
  };
  return POINTER_TABLE[pointerTypeOf(ev)](c);
}

// dispatchMode(ev, input) → {capture, cancelDefault}: how a tool routed the
// pointer takes it. A strokes or taps tool cancels a pen's default, and a
// mouse's as the pen's (K.2-9, K.2-43: the pen is wholly the tool's on a pane's
// controls, so no compatibility mousedown or focus starts in the pane), and
// never a finger's (its gestures are touch-action's to keep or give up, never a
// handler's; a finger tap on a pane's button still acts, D1). A selection tool
// cancels no pointer's default (K.2-48, K.2-6): a cancelled pointerdown
// suppresses the mousedown that starts the browser's own text selection, and
// the tool takes the selection the browser forms. A strokes tool also captures
// the pointer; a taps tool acts on the tap's click and captures nothing; a
// selection tool captures nothing either.
export function dispatchMode(ev, input) {
  const type = pointerTypeOf(ev);
  if (input === 'strokes') return { capture: true, cancelDefault: type !== 'touch' };
  if (input === 'selection') return { capture: false, cancelDefault: false };
  return { capture: false, cancelDefault: type !== 'touch' };
}

// ── finger-draws (D2 (c), K.2-8, K.2-15) ─────────────────────────────────────
// The device's own value in browser storage: auto | on | off, auto by default.
// auto = finger-draws on until the first pen pointer event this device's chrome
// sees, then the user record's boolean (default false); on and off bind
// directly. Storage that throws reads as auto, and the pen seen this session
// still counts.
export const FINGER_DRAWS_KEY = 'wc:finger-draws';
export const PEN_SEEN_KEY = 'wc:pen-seen';
export const FINGER_DRAWS_MODES = Object.freeze(['auto', 'on', 'off']);

let modeMem = 'auto';        // what setFingerDraws chose, when storage would not keep it
let penSeenMem = false;
let recordDefault = false;   // the user record's fingerDraws (U332's record, fed by main.js)
const fdSubs = new Set();

function modeNow() {
  const v = getLocal(FINGER_DRAWS_KEY, null);
  return FINGER_DRAWS_MODES.includes(v) ? v : modeMem;
}
function penSeenNow() { return penSeenMem || getLocal(PEN_SEEN_KEY, null) === '1'; }

export function fingerDraws() {
  const mode = modeNow();
  if (mode === 'on') return true;
  if (mode === 'off') return false;
  return penSeenNow() ? recordDefault : true;
}
export function fingerDrawsMode() {
  return { mode: modeNow(), penSeen: penSeenNow(), recordDefault };
}
function tellFingerDraws() {
  const snap = { ...fingerDrawsMode(), on: fingerDraws() };
  for (const fn of [...fdSubs]) {
    try { fn(snap); } catch (e) { console.error('[web-chat] input-mode: an onFingerDrawsChange listener failed', e); }
  }
}
// U338's switch: this device's value.
export function setFingerDraws(mode) {
  if (!FINGER_DRAWS_MODES.includes(mode)) throw new TypeError(`setFingerDraws: mode must be one of ${FINGER_DRAWS_MODES.join(', ')}`);
  modeMem = mode;
  setLocal(FINGER_DRAWS_KEY, mode);
  tellFingerDraws();
}
// The user record's default, beneath the device's value.
export function setFingerDrawsDefault(v) {
  const next = v === true;
  if (next === recordDefault) return;
  recordDefault = next;
  tellFingerDraws();
}
export function onFingerDrawsChange(fn) {
  if (typeof fn !== 'function') throw new TypeError('onFingerDrawsChange: expects a function');
  const h = (v) => fn(v);
  fdSubs.add(h);
  return () => { fdSubs.delete(h); };
}
// The first pen pointer event this device's chrome sees.
export function notePen() {
  if (penSeenMem) return;
  penSeenMem = true;
  if (getLocal(PEN_SEEN_KEY, null) === '1') return;   // an earlier session saw it
  setLocal(PEN_SEEN_KEY, '1');
  tellFingerDraws();
}

// ── install ──────────────────────────────────────────────────────────────────
// The live state the policy reads, tracked by ONE capture listener on the
// window (it sees every pointer before the overlay's capture on the well):
// the pen pointers down, the device's first pen (on contact or hover: Safari
// reports the Apple Pencil so), the primary touch gesture's travel, and the
// fingers down in the well, by pointerId, for the two-finger pan. It cancels
// no default and stops nothing except the pan's own fingers (below). A tap
// tool's click is held to TAP_SLOP by the
// overlay: it asks this policy again at the click of a gesture it gave to the
// tool, as that gesture's pointer, and a finger that travelled past the slop
// answers 'page' there, so neither the tool nor the page takes that click
// (overlay.js onPointer; it replaced this module's window click guard).
const POINTER_TYPES = ['pointerdown', 'pointerover', 'pointermove', 'pointerup', 'pointercancel', 'click'];
const penIds = new Set();
let touch = null;     // {id, x0, y0, dx, dy, done}: the last primary touch gesture
let uninstall = null;

// ── the two-finger pan (K.4: H1 = a, I1 = b) ─────────────────────────────────
// While finger-draws is on and a strokes tool is armed (fingerStrokes(): the
// well's touch-action is none, so the browser pans nothing), one finger draws
// and two fingers scroll. Every finger down in the well is tracked by its
// pointerId; a finger landing while another is down (two landing together
// are the same, one pointerdown after the other) turns the gesture into a
// PAN: the stroke under way is cancelled toward the tool through the
// overlay's cancelGesture (as its pointercancel would: the box grab drops its
// rubber band and creates nothing; no event is dispatched), and from then
// until the last finger lifts the well's scroller moves by the fingers'
// midpoint's delta (scrollBy, both axes; the browser clamps an axis that does
// not scroll). The pan's fingers are the pan's alone: their pointer events
// are stopped here, at the window's capture (their default cancelled where
// cancelable), so neither the overlay nor a pane under them hears them, and
// their clicks are stopped too. A lone finger still draws; a pen is never a
// pan's (a resting palm under a pen stays the policy's 'ignore', and no pan
// starts while a pen is down); with finger-draws off, or no strokes tool
// armed, nothing here acts (the well is `manipulation`: the browser pans).
const touches = new Map();     // pointerId → {x, y}: the fingers down in the well
let pan = null;                // {ids: Set, mx, my}: the pan under way, its last midpoint
const panClicks = new Set();   // pointerIds of the pan's lifted fingers, whose click is stopped

export function fingerStrokes() {
  const a = armed();
  return !!a && inputKindOf(a.type) === 'strokes' && fingerDraws();
}
// A snapshot of what the pan tracks, for the tests: no stale entry may stay
// after a gesture ends.
export function touchesForTests() {
  return { touches: [...touches.keys()], pan: pan ? [...pan.ids] : null, clicks: [...panClicks] };
}
function wellOf() { return document.getElementById('main'); }
// The element that scrolls the page: the well's .well-wrap (mounts.js's
// edge-scroll reads the same), else the document's scroller.
function scrollerOf() {
  const well = wellOf();
  return (well && well.closest('.well-wrap')) || document.scrollingElement || null;
}
function inWell(e) {
  const well = wellOf();
  if (!well) return false;
  const path = typeof e.composedPath === 'function' ? e.composedPath() : [];
  if (path.length) return path.includes(well);
  const t = e.target;
  return !!(t && t.nodeType === 1 && well.contains(t));
}
function midpoint(ids) {
  let x = 0;
  let y = 0;
  let n = 0;
  for (const id of ids) {
    const p = touches.get(id);
    if (!p) continue;
    x += p.x; y += p.y; n += 1;
  }
  return n ? { x: x / n, y: y / n } : null;
}
function rebase() {
  const m = pan && midpoint(pan.ids);
  if (m) { pan.mx = m.x; pan.my = m.y; }
}
function stop(e) {
  e.stopPropagation();
  if (e.cancelable) e.preventDefault();
}
// The pan's part of the window capture: true when it took the event.
function onPan(e) {
  if (e.type === 'click') {
    // A click that names a pointer is the pan's only when it names one of the
    // pan's fingers (a keyboard's -1 never does); one that names none, only
    // when a pointer pressed it (detail is the count of presses, 0 for a
    // keyboard's) and a pan finger's click is still owed.
    if (typeof e.pointerId === 'number') {
      if (!panClicks.delete(e.pointerId)) return false;
    } else if (!panClicks.size || !e.detail) {
      return false;
    } else {
      panClicks.clear();
    }
    stop(e);
    return true;
  }
  if (e.type === 'pointerdown' && !pan) panClicks.clear();   // an earlier pan's click never came
  if (e.pointerType !== 'touch') return false;
  const id = e.pointerId;
  switch (e.type) {
    case 'pointerdown': {
      // A primary touch is the first finger of a new touch: no other finger is
      // down, whatever an earlier gesture left behind.
      if (e.isPrimary) { touches.clear(); pan = null; }
      if (!pan && !inWell(e)) return false;
      touches.set(id, { x: e.clientX || 0, y: e.clientY || 0 });
      if (pan) { pan.ids.add(id); rebase(); stop(e); return true; }
      if (touches.size < 2 || penIds.size > 0 || !fingerStrokes()) return false;
      // The second finger: the stroke under way is the tool's no more.
      for (const other of touches.keys()) if (other !== id) cancelGesture(other);
      pan = { ids: new Set(touches.keys()), mx: 0, my: 0 };
      rebase();
      stop(e);
      return true;
    }
    case 'pointermove': {
      const p = touches.get(id);
      if (!p) return false;
      p.x = e.clientX || 0;
      p.y = e.clientY || 0;
      if (!pan || !pan.ids.has(id)) return false;
      const m = midpoint(pan.ids);
      const dx = m.x - pan.mx;
      const dy = m.y - pan.my;
      pan.mx = m.x;
      pan.my = m.y;
      const el = scrollerOf();
      if ((dx || dy) && el && typeof el.scrollBy === 'function') el.scrollBy({ left: -dx, top: -dy });
      stop(e);
      return true;
    }
    case 'pointerup':
    case 'pointercancel': {
      touches.delete(id);
      if (!pan || !pan.ids.has(id)) return false;
      pan.ids.delete(id);
      if (e.type === 'pointerup') panClicks.add(id);
      if (pan.ids.size) rebase(); else pan = null;
      stop(e);
      return true;
    }
    case 'pointerover':
      if (!pan || !pan.ids.has(id)) return false;
      stop(e);
      return true;
    default:
      return false;
  }
}
function dropPan() {
  touches.clear();
  pan = null;
  panClicks.clear();
}

function stateFor(a) {
  const type = a && a.type;
  return {
    armed: a || null,
    input: type ? inputKindOf(type) : null,
    fingerDraws: fingerDraws(),
    penDown: penIds.size > 0,
    gesture: touch ? { dx: touch.dx, dy: touch.dy } : null,
  };
}
function policy(e, ctx) {
  return route(e, stateFor(ctx && ctx.armed !== undefined ? ctx.armed : armed()));
}
function syncStrokes() {
  document.documentElement.classList.toggle('finger-strokes', fingerStrokes());
}
function onAnyPointer(e) {
  if (e.type !== 'click' && e.pointerType === 'pen') notePenDown(e);
  if (onPan(e)) return;
  if (e.type === 'click') return;
  switch (e.type) {
    case 'pointerdown':
      if (e.pointerType === 'touch') {
        if (e.isPrimary || !touch || touch.done) {
          touch = { id: e.pointerId, x0: e.clientX || 0, y0: e.clientY || 0, dx: 0, dy: 0, done: false };
        }
      } else {
        touch = null;
      }
      syncStrokes();
      break;
    case 'pointermove':
      if (touch && e.pointerId === touch.id) {
        touch.dx = Math.max(touch.dx, Math.abs((e.clientX || 0) - touch.x0));
        touch.dy = Math.max(touch.dy, Math.abs((e.clientY || 0) - touch.y0));
      }
      break;
    case 'pointerup':
    case 'pointercancel':
      if (touch && e.pointerId === touch.id) touch.done = true;   // its travel stays for the click
      break;
    default:
      break;
  }
}
// The pens: seen (on contact or hover) and down, ahead of the pan, which
// starts no pan while one is down.
function notePenDown(e) {
  notePen();
  if (e.type === 'pointerdown') penIds.add(e.pointerId);
  else if (e.type === 'pointerup' || e.type === 'pointercancel') penIds.delete(e.pointerId);
}
// installInputMode() registers the table at the overlay's one pointer dispatch
// and starts the pen watch and the two-finger pan. Idempotent; returns its
// uninstall.
export function installInputMode() {
  if (uninstall) return uninstall;
  if (typeof window === 'undefined' || typeof document === 'undefined') return () => {};
  const offPolicy = setPointerPolicy(policy);
  // Not passive: the pan cancels its own fingers' defaults.
  const opts = { capture: true, passive: false };
  for (const t of POINTER_TYPES) window.addEventListener(t, onAnyPointer, opts);
  const offArmed = onArmedChange(syncStrokes);
  const offFd = onFingerDrawsChange(syncStrokes);
  syncStrokes();
  const mine = () => {
    if (uninstall !== mine) return;
    uninstall = null;
    offPolicy();
    for (const t of POINTER_TYPES) window.removeEventListener(t, onAnyPointer, opts);
    offArmed();
    offFd();
    penIds.clear();
    touch = null;
    dropPan();
    document.documentElement.classList.remove('finger-strokes');
  };
  uninstall = mine;
  return mine;
}
