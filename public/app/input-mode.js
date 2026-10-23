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
//   installInputMode()                                    the policy at setPointerPolicy, the pen watch
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
// well takes `touch-action: pinch-zoom` (html.finger-strokes) so a finger
// stroke is not claimed as a pan; the chrome's own `touch-action: none` handles
// (graph canvas, pane grips, the sheet's grip tab) are chrome gestures and
// stay; the Pencil's double-tap and squeeze never reach a page, so switching is
// the toolbar's, the hotkeys' and the pointer tool's. The two older pointerType
// reads (shell.js, the rail's hover ignores touch; sheet-drag.js, the grip
// tab's mouse-button filter) are theirs and stay as they are.
//
// No DOM is touched at import.
import { armed, inputKindOf, onArmedChange, setPointerPolicy, INPUT_KINDS } from './overlay.js';
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
// The live state the policy reads, tracked by ONE passive capture listener on
// the window (it sees every pointer before the overlay's capture on the well,
// and never prevents a default): the pen pointers down, the device's first pen
// (on contact or hover: Safari reports the Apple Pencil so), and the primary
// touch gesture's travel. A tap tool's click is held to TAP_SLOP by the
// overlay: it asks this policy again at the click of a gesture it gave to the
// tool, as that gesture's pointer, and a finger that travelled past the slop
// answers 'page' there, so neither the tool nor the page takes that click
// (overlay.js onPointer; it replaced this module's window click guard).
const POINTER_TYPES = ['pointerdown', 'pointerover', 'pointermove', 'pointerup', 'pointercancel'];
const penIds = new Set();
let touch = null;     // {id, x0, y0, dx, dy, done}: the last primary touch gesture
let uninstall = null;

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
  const a = armed();
  const on = !!a && inputKindOf(a.type) === 'strokes' && fingerDraws();
  document.documentElement.classList.toggle('finger-strokes', on);
}
function onAnyPointer(e) {
  const pen = e.pointerType === 'pen';
  if (pen) notePen();
  switch (e.type) {
    case 'pointerdown':
      if (pen) penIds.add(e.pointerId);
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
      if (pen) penIds.delete(e.pointerId);
      if (touch && e.pointerId === touch.id) touch.done = true;   // its travel stays for the click
      break;
    default:
      break;
  }
}
// installInputMode() registers the table at the overlay's one pointer dispatch
// and starts the pen watch. Idempotent; returns its uninstall.
export function installInputMode() {
  if (uninstall) return uninstall;
  if (typeof window === 'undefined' || typeof document === 'undefined') return () => {};
  const offPolicy = setPointerPolicy(policy);
  const opts = { capture: true, passive: true };
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
    document.documentElement.classList.remove('finger-strokes');
  };
  uninstall = mine;
  return mine;
}
