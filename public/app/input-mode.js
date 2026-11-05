// The input-mode policy (annotation engine 2D.4; DECISIONS.md I.6 addendum 3
// "stylus and touch", K.2 items 3, 6, 8, 9, 14, 15; W-10): which pointer goes
// to the armed tool and which to the page, as ONE table keyed by
// PointerEvent.pointerType, installed at the overlay's one pointer dispatch
// (overlay.js setPointerPolicy). The engine row: the pointer-type rule lives
// here; never a second table, and never a second armed state.
//
//   route(ev, s)          → 'tool' | 'page' | 'ignore'   THE table (pure)
//   isInteractive(el)     → boolean                       the finger's control test (K.2-9)
//                                                         (a [tabindex="-1"] focus sink inside a
//                                                         non-page host's root is no control, K.2-181)
//   isFocusSink(el)       → boolean                       a focused element that is no control: #stage
//                                                         (the page's focusable scroll container) or a
//                                                         [tabindex="-1"] focus target that is no control
//                                                         by its tag, role or contenteditable (the overlay
//                                                         dialog, a dismiss zone) — the last-tool key's
//                                                         reading of focus (tools.js, F.4)
//   routeAtDown(ev)       → 'tool' | 'page' | 'ignore'    a finger's reading at its pointerdown (the pan's
//                                                         heard-press rule); 'page' while previewing (K.2-104)
//   dispatchMode(ev, kind)→ {capture, cancelDefault}      how a tool takes its pointer
//   POINTER                                               the pointer tool (chrome-owned; arms nothing)
//   fingerDraws() · fingerDrawsMode() · setFingerDraws(mode) · setFingerDrawsDefault(v)
//   onFingerDrawsChange(fn)                               the finger-draws switch (K.2-8, K.2-15)
//   installInputMode()                                    the policy at setPointerPolicy, the pen watch,
//                                                         the two-finger pan
//   fingerStrokes() · touchesForTests()                   is the finger drawing; the touches tracked
//   strokesArmed()                                        is a strokes tool armed (finger-draws aside)
//   STROKES_TARGETS · STROKES_ATTR · STROKES_SHEET        the strokes input policy (4A.2, 5A.3): the
//                                                         fixed-aspect set, the host mark, the rule
//                                                         each pane root takes
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
// pointer type, so with no strokes tool armed the page well keeps the browser's
// finger gestures (`#main { touch-action: manipulation }`, app.css's input-mode
// block) and only a pen's default is cancelled in a handler; while a strokes
// tool is armed (below) the well gives up every finger gesture instead, and the
// page scrolls by TWO fingers, panned here (the two-finger pan, below: a second
// finger turns the gesture into a scroll of the well, with no disarm step,
// H1 = a), pinch-zoom off (K.4 I1 = b); with finger-draws on as well the
// finger IS the drawing pointer (html.finger-strokes). The chrome's own
// `touch-action: none` handles (graph canvas, pane grips, the sheet's grip
// tab) are chrome gestures and stay; the Pencil's double-tap and squeeze never
// reach a page, so switching is the toolbar's, the hotkeys' and the pointer
// tool's. The two older pointerType reads (shell.js, the rail's hover ignores
// touch; sheet-drag.js, the grip tab's mouse-button filter) are theirs and stay
// as they are.
//
// The strokes input policy (annotation engine 4A.2, 5A.3; AD1, AD4, K.4 I1 = b,
// AJ5; REQ@ink-scope-v2 b+, REQ@margins a, FINGER@page-limit, U515@strokes-all-
// tools a): while ANY strokes tool is armed (the box grab included), whatever
// finger-draws says, the whole well — .well-wrap (the column's padding and, on
// a wide window, the gutters beside it) and everything in it — takes
// `touch-action: none` (html.strokes-armed, app.css), because any element in
// the well is a stroke's frame (the pane and page frames) and a pen drag on a
// `manipulation` element is claimed as a scroll (a pointercancel): a cancelled
// pointerdown alone does not stop a pan, and once a pen is seen auto
// finger-draws is off. Pinch-zoom is off while it is armed. The rule reaches
// every element, not only #main, because a touch's allowed behaviours are the
// intersection over the hit element and its ancestors only up to the nearest
// scroll container, inclusive (Pointer Events, "determining supported touch
// behavior"): each pane's .mount-host is one (overflow auto), and so may be a
// pane's own content. A pane's content sits in its open shadow root, where
// app.css cannot reach, so its part is ONE constructable sheet (STROKES_SHEET)
// each pane root takes once, keyed by an attribute on its .mount-host
// (STROKES_ATTR) — mounts.js adoptReadonlySheet's pattern: the pane's own DOM is
// untouched; the sheet gives every element in the root `touch-action: none`,
// and the fixed-aspect targets (STROKES_TARGETS: an svg, an img, a canvas, an
// element marked data-fixed-aspect — the set C5 and lib/core/anchors.js
// targetFrame name) selection and the callout off, so a stroke on one is never
// a long-press either (app.css gives a light-DOM [data-fixed-aspect] the same).
// A new host while armed (a re-render makes one) is marked by a
// MutationObserver on #main, disconnected on disarm, when every mark and the
// class go. A browser without constructable sheets marks the hosts and styles
// nothing in a pane's own inner scrollers. Two fingers anywhere in the well pan
// it here (the two-finger pan, below), finger-draws on or off; ONE finger with
// finger-draws off is still the page's (route()'s strokes row), and the browser
// pans nothing from it anywhere in the well (FINGER@page-limit, the named
// limit) — a tap still reaches a control, since touch-action never blocks a
// tap. The pan scrolls the well's scroller only: a pane's own scroller (a
// rows-capped pane's .mount-host) does not scroll while a strokes tool is
// armed. No strokes tool armed (a selection tool is none): nothing here acts
// and the well is `manipulation`. The device behaviour is E3's to prove.
//
// No DOM is touched at import.
import { armed, cancelGesture, inputKindOf, isHostRoot, onArmedChange, setPointerPolicy, INPUT_KINDS } from './overlay.js';
import { isTap } from './sheet-model.js';
import { view } from './state.js';
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

function selfInteractive(el, { tabindex = true } = {}) {
  const tag = el.localName;
  if (ALWAYS.has(tag)) return true;
  if (tag === 'a' || tag === 'area') return el.hasAttribute('href');
  if (tag === 'input') return String(el.getAttribute('type') || '').toLowerCase() !== 'hidden';
  if (tag === 'audio' || tag === 'video') return el.hasAttribute('controls');
  if (tag === 'img') return el.hasAttribute('usemap');
  if (tabindex && el.hasAttribute('tabindex')) return true;
  const role = String(el.getAttribute('role') || '').trim().toLowerCase().split(/\s+/)[0];
  return INTERACTIVE_ROLES.includes(role);
}
// The page well's own element, or another overlay host's root (overlay.js
// isHostRoot: the chat's #chat-views): the walk stops there, so the chrome
// around it (#stage carries a tabindex) never makes the host's content
// interactive. A focus sink below a host's root (#chat-stream's tabindex -1)
// is hostSink's, below (K.2-181).
function isWell(el) {
  return (el.id === 'main' && el.getRootNode && el.getRootNode() === el.ownerDocument) || isHostRoot(el);
}
// isFocusSink(el): a focused element that takes focus without being a control
// — #stage, the page's focusable scroll container (index.html gives it
// tabindex="0", so a click on the page leaves it focused), or a
// [tabindex="-1"] focus target (the overlay dialog, the chat dock, a dismiss
// zone) that is no control by its own tag, role or contenteditable. A
// [tabindex="-1"] button or role="option" row stays a control.
export function isFocusSink(el) {
  if (!el || el.nodeType !== 1) return false;
  if (el.id === 'stage' && el.getRootNode && el.getRootNode() === el.ownerDocument) return true;
  if (String(el.getAttribute('tabindex')).trim() !== '-1') return false;
  if (selfInteractive(el, { tabindex: false })) return false;
  return !(el.hasAttribute('contenteditable') && EDITABLE.has(String(el.getAttribute('contenteditable')).toLowerCase()));
}
// A focus sink inside another overlay host's root (the chat's #chat-stream:
// tabindex -1 for focus, role log) is that host's scroll box, never a
// control: a finger's tap on the static text it holds is the tool's, as on
// the page (K.2-9; U434a, K.2-181). The page well's own content is unchanged.
function hostSink(el) {
  if (!isFocusSink(el)) return false;
  for (let p = el.parentElement; p; p = p.parentElement) {
    if (p.id === 'main' && p.getRootNode() === p.ownerDocument) return false;
    if (isHostRoot(p)) return true;
  }
  return false;
}
// isInteractive(el): el, or an ancestor up to the page well (across a pane's
// shadow boundary), is interactive content.
export function isInteractive(el) {
  let editableBlocked = false;
  for (let n = el; n && n.nodeType === 1; ) {
    if (isWell(n) || n.localName === 'body' || n.localName === 'html') return false;
    if (selfInteractive(n) && !hostSink(n)) return true;
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
// While a strokes tool is armed (strokesArmed(): the well's touch-action is
// none, so the browser pans nothing), two fingers scroll, and with finger-draws
// on one finger draws. Every finger down in the well is tracked by its
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
// starts while a pen is down); with no strokes tool armed nothing here acts
// (the well is `manipulation` and the browser pans); with one armed a gesture
// anywhere in the well — a pane's prose, a control, the column's padding or
// the gutters beside it (inWell: the .well-wrap) — pans here, finger-draws on
// or off.
// Two rules bound a pan under way (K.2-98, K.2-99):
//   - it moves nothing while a pen is down: two resting contacts that came
//     down before the pen (a palm) keep their pan — their events still
//     stopped, their clicks still owed — but no scrollBy runs under the pen's
//     stroke, so the box grab captures the region drawn; the midpoint is
//     rebased on every move, so once the pen lifts the next move scrolls by
//     that move's delta only (no jump). A pen's pointerdown never ends the pan
//     (its fingers would then reach the overlay and the page);
//   - a pan finger whose press a pane HEARD delivers its own lift: at each
//     finger's pointerdown the policy's reading of it is kept beside its
//     point (routeAtDown: route() as the overlay asks it there); a finger the
//     policy gave the page ('page': a pane's control) whose pointerdown went
//     through — it was down before the pan began, never one that landed
//     during it, whose press the pan stopped — has its pointermoves taken by
//     the pan and its click still owed, but its own pointerup or
//     pointercancel, the event the browser sends, is not stopped: it reaches
//     the pane as sent, so a pane holding press or drag state (a slider that
//     took capture, an :active handler) releases it as after a native pan's
//     pointercancel. Nothing synthetic is dispatched; a finger the tool had
//     (cancelGesture ended its stroke) has its lift stopped as before.
const touches = new Map();     // pointerId → {x, y, route, heard}: the fingers down in the well
let pan = null;                // {ids: Set, mx, my}: the pan under way, its last midpoint
const panClicks = new Set();   // pointerIds of the pan's lifted fingers, whose click is stopped

// strokesArmed(): a strokes tool is armed, whatever finger-draws says (the
// strokes input policy on a target).
export function strokesArmed() {
  const a = armed();
  return !!a && inputKindOf(a.type) === 'strokes';
}
export function fingerStrokes() {
  return strokesArmed() && fingerDraws();
}
// A snapshot of what the pan tracks, for the tests: no stale entry may stay
// after a gesture ends. With {routes: true} it adds each finger's policy
// reading at its pointerdown (routes: {pointerId: route}) and the fingers whose
// press a pane heard (heard: [pointerId]).
export function touchesForTests({ routes = false } = {}) {
  const snap = { touches: [...touches.keys()], pan: pan ? [...pan.ids] : null, clicks: [...panClicks] };
  if (!routes) return snap;
  snap.routes = Object.fromEntries([...touches].map(([id, p]) => [id, p.route]));
  snap.heard = [...touches].filter(([, p]) => p.heard).map(([id]) => id);
  return snap;
}
function wellOf() { return document.getElementById('main'); }
// The element that scrolls the page: the well's .well-wrap (mounts.js's
// edge-scroll reads the same), else the document's scroller.
function scrollerOf() {
  const well = wellOf();
  return (well && well.closest('.well-wrap')) || document.scrollingElement || null;
}
// The well a finger is tracked in: the .well-wrap that holds #main (REQ@margins
// = a: the column's padding and the gutters beside it), else #main itself.
function zoneOf() {
  const well = wellOf();
  return well ? (well.closest('.well-wrap') || well) : null;
}
function inWell(e) {
  const well = zoneOf();
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
// The policy's reading of a finger at its pointerdown, as the overlay asks it
// there (askPolicy → policy → route): the gesture absent, a tap so far.
// 'page' is a press the page under it hears (a pane's control, or static
// content while no drawing tool takes fingers). While a previous node is
// previewed it is 'page' for every pointer, as the overlay's own dispatch
// gives the page everything then (onPointer's `if (view.previewing) return`,
// D2): a strokes tool armed before the preview no longer makes a press the
// pane heard read 'tool', so its lift reaches the pane (K.2-104, K.2-99).
export function routeAtDown(e) {
  if (view.previewing) return 'page';
  return route(e, { ...stateFor(armed()), gesture: null });
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
      const r = routeAtDown(e);
      // heard: the press goes on to the page; a finger landing during a pan
      // is stopped below, so no pane hears its press (and none hears its lift).
      touches.set(id, { x: e.clientX || 0, y: e.clientY || 0, route: r, heard: !pan && r === 'page' });
      if (pan) { pan.ids.add(id); rebase(); stop(e); return true; }
      if (touches.size < 2 || penIds.size > 0 || !strokesArmed()) return false;
      touches.get(id).heard = false;   // the finger that starts the pan: its press is stopped
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
      pan.mx = m.x;   // rebased on every move, a pen down or not (K.2-98)
      pan.my = m.y;
      const el = scrollerOf();
      if (!penIds.size && (dx || dy) && el && typeof el.scrollBy === 'function') el.scrollBy({ left: -dx, top: -dy });
      stop(e);
      return true;
    }
    case 'pointerup':
    case 'pointercancel': {
      const p = touches.get(id);
      touches.delete(id);
      if (!pan || !pan.ids.has(id)) return false;
      pan.ids.delete(id);
      if (e.type === 'pointerup') panClicks.add(id);
      if (pan.ids.size) rebase(); else pan = null;
      // A press a pane heard: its own lift reaches the pane as sent (K.2-99).
      if (!(p && p.heard)) stop(e);
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
// ── the strokes input policy (4A.2, 5A.3) ────────────────────────────────────
// STROKES_TARGETS is the second spelling of targetFrame's set (U515), held
// equal to it by test/input-mode.test.js and test/elements-e2e-t4-chrome.test.js.
// STROKES_SHEET, two rules: every element in a marked pane root gives up the
// finger's gestures (a pane's own scroll container stops the intersection over
// ancestors, so #main's and the host's none would not reach below it), and the
// fixed-aspect targets also give up selection and the callout.
export const STROKES_TARGETS = 'svg, img, canvas, [data-fixed-aspect]';
export const STROKES_ATTR = 'data-wc-strokes';
export const STROKES_SHEET = `:host([${STROKES_ATTR}]) * { touch-action: none; }`
  + ` :host([${STROKES_ATTR}]) :is(${STROKES_TARGETS})`
  + ' { -webkit-user-select: none; user-select: none; -webkit-touch-callout: none; }';
let strokesSheet;              // the one sheet; null where constructable sheets are absent
const sheetRoots = new WeakSet();   // the pane roots that took it
let marked = null;             // the well whose hosts are marked (null: none)
let hostWatch = null;          // the MutationObserver on that well while armed
function sheet() {
  if (strokesSheet === undefined) {
    try {
      strokesSheet = new window.CSSStyleSheet();
      strokesSheet.replaceSync(STROKES_SHEET);
    } catch { strokesSheet = null; }
  }
  return strokesSheet;
}
// Once per root, idempotent; a root that takes no adopted sheet is left as it is.
function adoptStrokes(root) {
  const s = root && !sheetRoots.has(root) ? sheet() : null;
  if (!s) return;
  try {
    const cur = root.adoptedStyleSheets;
    if (!cur || typeof cur.includes !== 'function') return;
    if (!cur.includes(s)) root.adoptedStyleSheets = [...cur, s];
    sheetRoots.add(root);
  } catch { /* the root keeps its sheets: the mark alone styles nothing */ }
}
function hostsIn(node) {
  if (!node || node.nodeType !== 1) return [];
  const out = node.classList.contains('mount-host') ? [node] : [];
  return out.concat([...node.querySelectorAll('.mount-host')]);
}
function markHost(host) {
  host.toggleAttribute(STROKES_ATTR, true);
  adoptStrokes(host.shadowRoot);
}
function markTargets() {
  const well = wellOf();
  if (marked && marked === well) return;
  unmarkTargets();
  if (!well) return;
  marked = well;
  for (const h of hostsIn(well)) markHost(h);
  if (typeof MutationObserver !== 'function') return;
  hostWatch = new MutationObserver((records) => {
    for (const r of records) for (const n of r.addedNodes) for (const h of hostsIn(n)) markHost(h);
  });
  hostWatch.observe(well, { childList: true, subtree: true });
}
function unmarkTargets() {
  if (hostWatch) { hostWatch.disconnect(); hostWatch = null; }
  marked = null;
  for (const h of document.querySelectorAll(`.mount-host[${STROKES_ATTR}]`)) h.removeAttribute(STROKES_ATTR);
}
function syncStrokes() {
  const html = document.documentElement;
  html.classList.toggle('finger-strokes', fingerStrokes());
  const on = strokesArmed();
  html.classList.toggle('strokes-armed', on);
  if (on) markTargets();
  else if (marked) unmarkTargets();
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
    document.documentElement.classList.remove('finger-strokes', 'strokes-armed');
    unmarkTargets();
  };
  uninstall = mine;
  return mine;
}
