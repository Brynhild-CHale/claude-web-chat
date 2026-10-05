// The desktop chat dock (design spec §7.7): ONE element, two modes — a drawer
// right of the page well (the default) and a floating window — so detaching
// never re-parents the chat panel, and the draft, the scroll position and the
// expanded cards inside it survive every switch.
//
//   initChatDock()          finds #chat-dock, builds its strip, registers the ONE
//                           chat view 'dock' (chat-slots.js); idempotent
//   dockEl                  the section, once initChatDock has found it (a live binding)
//   closeChat({returnFocus = true})   hides it; focus goes back where it was
//   focusChat(focus)        'composer' (the default): the registered composer,
//                           else #chat-stream, else the dock itself
//   resetChatWindow()       the Final's defaults, written back and applied
//                           (the ⌘K row's keyboard way out of a bad geometry)
//   isChatOpen()
//   addEscapeStep(fn)       → unregister: an inner Escape layer the dock asks
//                           first, newest first (the panel pops a detail view)
//   clampWindow(geom, area, {minW, minH, edge})   pure: a window kept inside an area
//   readWindowPrefs() / normalizeWindowPrefs(v)   the saved geometry, or the defaults
//
// OPENING. The bar's step, the M key and the act area emit chrome-bus
// `chat:open {view, id, node_id, focus}`. While the window is wide (viewport.js
// isNarrow() false) the dock shows, closes every popover (window event
// `wc:close-popovers`: opening the chat closes any tray, as the Final's
// toggleChat does), announces `chat:host {host: #cd-body, variant: 'desktop'}`
// (the panel moves itself in), remembers where focus was, focuses, and calls its
// registration's changed(). A chat:open while open only re-applies the focus.
// `view`, `id` and `node_id` are the panel's to apply (its elements): the dock
// only shows the host. While narrow, chat:open is ignored — the phone sheet
// takes it from tranche 5 (ruling U33@narrow-alpha) — and a flip to narrow while
// open closes the dock.
//
// THE POSTURE IS NOT SENT HERE. chat-slots.js owns it: changed() makes the
// registry recompute posture() and announce `chat:posture`, which ws.js turns
// into the socket's `client` field. The dock never touches the socket.
//
// DISMISSAL is shell.js's (spec §7.8): the drawer's `data-dismiss-zone` names
// where an outside pointerdown closes it (the well and the contents nav, not
// the rail, the topbar, the bar or a tray); the window drops the attribute and
// never closes on an outside click. The dock is deliberately NOT a `.drawer`
// and not a `.popover`: those close whenever another panel opens or the window
// blurs, and the chat must survive the user switching to the terminal. Escape
// reaches the dock through chat-slots' escapeChatViews(), after every popover.
//
// GEOMETRY. The window's {x, y, w, h}, its opacity and Solid-on-hover live in
// `wc:chat-window` (storage.js, local) as {v: 1, mode, op, hoverSolid, x, y, w, h};
// anything malformed reads as the Final's defaults. A gesture (the strip's grip
// moves, eight edge handles resize, pointer capture) writes it once, on pointer
// up, never per move. The area is .body-wrap's box less the 64px queue rail,
// and the window keeps at least 320×300. On open and on a window resize the
// saved geometry is clamped FOR DISPLAY ONLY, so a shrink then a grow puts the
// saved size back.
//
// Nothing here touches the DOM at load time: plain `node --test` imports this
// module for clampWindow and the prefs (test/chat-dock-geometry.test.js).
import { bus } from './bus.js';
import { registerChatView, composer } from './chat-slots.js';
import { isNarrow } from './viewport.js';
import { getLocalJson, setLocalJson } from './storage.js';

export const WINDOW_KEY = 'wc:chat-window';
// The Final's defaults (design spec, "What the Final asks for").
export const WINDOW_DEFAULTS = Object.freeze({ v: 1, mode: 'drawer', op: 1, hoverSolid: true, x: 760, y: 40, w: 420, h: 580 });
export const MIN_W = 320;
export const MIN_H = 300;
export const RAIL_W = 64;            // the collapsed queue rail the window never covers
const OP_MIN = 0.25;
const MODES = ['drawer', 'window'];
const EDGES = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'];
const DISMISS_ZONE = '#contents-nav, .well-wrap';
const UNBOUNDED = Object.freeze({ x: -1e6, y: -1e6, w: 2e6, h: 2e6 });

// ── pure: the saved prefs ────────────────────────────────────────────────────

const finite = (n) => typeof n === 'number' && Number.isFinite(n);

// A saved value, or the defaults: anything that is not exactly the v1 shape —
// a wrong version, a missing or non-finite number, an unknown mode, a string —
// is malformed, and a malformed record is a viewport preference not worth
// salvaging field by field. An opacity outside 25–100 % is clamped, not refused.
export function normalizeWindowPrefs(v) {
  const d = { ...WINDOW_DEFAULTS };
  if (!v || typeof v !== 'object' || Array.isArray(v) || v.v !== 1) return d;
  if (!MODES.includes(v.mode) || typeof v.hoverSolid !== 'boolean') return d;
  if (![v.op, v.x, v.y, v.w, v.h].every(finite) || v.w <= 0 || v.h <= 0) return d;
  return { v: 1, mode: v.mode, op: Math.min(1, Math.max(OP_MIN, v.op)), hoverSolid: v.hoverSolid,
    x: v.x, y: v.y, w: v.w, h: v.h };
}

// storage.js fails open (a throwing accessor reads as the fallback), so this
// never throws either.
export function readWindowPrefs() {
  return normalizeWindowPrefs(getLocalJson(WINDOW_KEY, null));
}

// ── pure: the clamp ──────────────────────────────────────────────────────────

// One axis. `lo`/`span` are the area's, `min` the least size. `side` says which
// edge a resize moves: 'start' (the top or left edge: the far edge stays put),
// 'end' (the bottom or right edge: the near edge stays put), or null for a move
// or a display clamp (the size fits the area, then the box slides inside it).
// Where the area is smaller than `min`, the size still never goes below it and
// the box keeps its near edge at the area's start.
function axis(pos, size, lo, span, min, side) {
  const hi = lo + span;
  if (side === 'end') {
    const p = Math.max(lo, Math.min(pos, hi - min));
    return [p, Math.max(min, Math.min(size, hi - p))];
  }
  if (side === 'start') {
    const end = Math.max(lo + min, Math.min(pos + size, hi));
    const p = Math.max(lo, Math.min(pos, end - min));
    return [p, end - p];
  }
  const s = Math.max(min, Math.min(size, span));
  return [Math.max(lo, Math.min(pos, hi - s)), s];
}

// The window `geom` {x, y, w, h} kept inside `area` {x?, y?, w, h} (origin 0, 0
// unless given), never smaller than minW×minH. `edge` is the handle a resize
// drags ('n', 'se', …): the edges it does not name stay where they are. With no
// edge it is a move, or the display clamp on open and on a window resize.
// Pure: returns a new object and never edits either argument.
export function clampWindow(geom, area, { minW = MIN_W, minH = MIN_H, edge = null } = {}) {
  const ax = finite(area && area.x) ? area.x : 0;
  const ay = finite(area && area.y) ? area.y : 0;
  const aw = finite(area && area.w) ? Math.max(0, area.w) : 0;
  const ah = finite(area && area.h) ? Math.max(0, area.h) : 0;
  const e = typeof edge === 'string' ? edge : '';
  const xSide = e.includes('w') ? 'start' : e.includes('e') ? 'end' : null;
  const ySide = e.includes('n') ? 'start' : e.includes('s') ? 'end' : null;
  // An axis the handle does not name is only kept inside (a resize from 'e'
  // leaves the height alone unless it no longer fits).
  const [x, w] = axis(geom.x, geom.w, ax, aw, minW, xSide);
  const [y, h] = axis(geom.y, geom.h, ay, ah, minH, ySide);
  return { x, y, w, h };
}

// Where a gesture puts the window: `start` is the geometry at pointerdown, dx/dy
// the pointer's travel, `edge` null for a move (the grip) or the handle dragged.
export function gestureGeom(start, edge, dx, dy, area, opts = {}) {
  const g = { x: start.x, y: start.y, w: start.w, h: start.h };
  if (!edge) {
    g.x += dx;
    g.y += dy;
    return clampWindow(g, area, opts);
  }
  if (edge.includes('e')) g.w += dx;
  if (edge.includes('w')) { g.x += dx; g.w -= dx; }
  if (edge.includes('s')) g.h += dy;
  if (edge.includes('n')) { g.y += dy; g.h -= dy; }
  return clampWindow(g, area, { ...opts, edge });
}

// ── the dock ─────────────────────────────────────────────────────────────────

export let dockEl = null;   // a live binding: the section, once initChatDock has found it

let els = null;             // { dock, strip, body }
let prefs = { ...WINDOW_DEFAULTS };
let reg = null;             // the chat view's { unregister, changed }
let returnTo = null;        // the element focused before the chat opened
let gesture = null;         // { pointerId, edge, start, sx, sy, el, geom }
const escapeSteps = [];     // newest last; asked newest first

export function isChatOpen() {
  return !!els && !els.dock.classList.contains('hidden');
}

function focusEl(el) {
  if (!el) return false;
  try { el.focus({ preventScroll: true }); } catch { return false; }
  return document.activeElement === el;
}

// Where focus goes in the chat: the composer when one is registered (the M key
// and the step's own choice), else the stream (tabindex=-1, the panel's), else
// the dock itself, so a keyboard user is never left behind on the page.
export function focusChat(focus = 'composer') {
  if (!isChatOpen() || focus === 'none' || focus === false) return false;
  if (focus === 'composer' || focus === undefined || focus === null) {
    const c = composer();
    if (c) {
      try { c.focus(); return true; } catch (e) { console.error('[web-chat] the composer failed to take focus', e); }
    }
  }
  const stream = document.getElementById('chat-stream');
  if (stream && focusEl(stream)) return true;
  return focusEl(els.dock);
}

function openChat(d) {
  if (!els || isNarrow()) return;
  const focus = d && d.focus;
  if (isChatOpen()) {
    focusChat(focus);
    return;
  }
  const a = document.activeElement;
  returnTo = a && a !== document.body && a !== document.documentElement && !els.dock.contains(a) ? a : null;
  els.dock.classList.remove('hidden');
  applyGeometry();
  window.dispatchEvent(new CustomEvent('wc:close-popovers'));
  bus.emit('chat:host', { host: els.body, variant: 'desktop' });
  focusChat(focus);
  if (reg) reg.changed();
}

export function closeChat({ returnFocus = true } = {}) {
  if (!isChatOpen()) return false;
  endGesture(false);
  els.dock.classList.add('hidden');
  if (returnFocus) {
    const back = returnTo && returnTo.isConnected ? returnTo : null;
    if (!focusEl(back)) focusEl(document.getElementById('cs-step'));
  }
  returnTo = null;
  if (reg) reg.changed();
  return true;
}

// The view's Escape: an inner step first (a detail view pops), newest first;
// then the drawer closes; a window closes only while it holds focus
// (deviation 5: a faded window beside the page must not vanish on an Escape
// meant for the page).
function escapeDock() {
  for (let i = escapeSteps.length - 1; i >= 0; i--) {
    let took = false;
    try { took = !!escapeSteps[i](); } catch (e) { console.error('[web-chat] a chat Escape step failed', e); }
    if (took) return true;
  }
  if (!isChatOpen()) return false;
  if (prefs.mode === 'window' && !els.dock.contains(document.activeElement)) return false;
  closeChat();
  return true;
}

export function addEscapeStep(fn) {
  if (typeof fn !== 'function') throw new TypeError('addEscapeStep: expects a function');
  const entry = () => fn();
  escapeSteps.push(entry);
  return () => {
    const i = escapeSteps.indexOf(entry);
    if (i >= 0) escapeSteps.splice(i, 1);
  };
}

// ── the prefs, applied ───────────────────────────────────────────────────────

function savePrefs() {
  setLocalJson(WINDOW_KEY, { ...prefs, v: 1 });
}

// The window's area: .body-wrap's box less the collapsed rail. A box with no
// size (no layout yet, or hidden) is no area, and nothing is clamped against it.
function area() {
  const wrap = els && els.dock.parentElement;
  const w = wrap ? wrap.clientWidth - RAIL_W : 0;
  const h = wrap ? wrap.clientHeight : 0;
  return w > 0 && h > 0 ? { x: 0, y: 0, w, h } : null;
}

function setGeomVars(g) {
  const s = els.dock.style;
  s.setProperty('--cd-x', `${Math.round(g.x)}px`);
  s.setProperty('--cd-y', `${Math.round(g.y)}px`);
  s.setProperty('--cd-w', `${Math.round(g.w)}px`);
  s.setProperty('--cd-h', `${Math.round(g.h)}px`);
}

// The saved geometry, clamped to today's area for display; the saved value is
// left as it was.
function applyGeometry() {
  if (!els) return;
  const a = area();
  setGeomVars(a ? clampWindow(prefs, a) : prefs);
}

function applyPrefs() {
  const d = els.dock;
  d.dataset.mode = prefs.mode;
  if (prefs.mode === 'drawer') d.setAttribute('data-dismiss-zone', DISMISS_ZONE);
  else d.removeAttribute('data-dismiss-zone');
  d.style.setProperty('--cd-op', String(prefs.op));
  d.toggleAttribute('data-solid', !!prefs.hoverSolid);
  applyGeometry();
  buildStrip();
}

export function resetChatWindow() {
  prefs = { ...WINDOW_DEFAULTS };
  savePrefs();
  if (els) applyPrefs();
}

function setMode(mode) {
  if (prefs.mode === mode) return;
  const hadFocus = els.dock.contains(document.activeElement);
  prefs = { ...prefs, mode };
  savePrefs();
  applyPrefs();
  // The button pressed went with the old strip: focus its counterpart.
  if (hadFocus) focusEl(els.strip.querySelector(mode === 'window' ? '.cd-attach' : '.cd-detach'));
}

// ── the strip ────────────────────────────────────────────────────────────────

function button(cls, text, label, onClick) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = `cd-btn ${cls}`;
  b.textContent = text;
  if (label) {
    b.setAttribute('aria-label', label);
    b.title = label;
  }
  b.addEventListener('click', onClick);
  return b;
}

const pct = (op) => `${Math.round(op * 100)}%`;

// Built by textContent, no ids (every chrome id is reserved ahead of its unit,
// and the strip's controls need none: classes and aria-labels say what they are).
function buildStrip() {
  const strip = els.strip;
  const nodes = [];
  if (prefs.mode === 'drawer') {
    const label = document.createElement('span');
    label.className = 'cd-label';
    label.textContent = 'DOCKED';
    const spacer = document.createElement('span');
    spacer.className = 'cd-spacer';
    nodes.push(label, spacer,
      button('cd-detach', '⇱ Detach', 'Detach the chat into a floating window', () => setMode('window')));
  } else {
    const close = button('cd-close', '✕', 'Close the chat', () => closeChat());
    const grip = document.createElement('span');
    grip.className = 'cd-grip';
    grip.title = 'Drag to move the chat window';
    grip.setAttribute('aria-hidden', 'true');
    grip.textContent = '⠿';
    grip.addEventListener('pointerdown', (e) => startGesture(e, null));
    const opLabel = document.createElement('label');
    opLabel.className = 'cd-op';
    const icon = document.createElement('span');
    icon.className = 'cd-op-icon';
    icon.setAttribute('aria-hidden', 'true');
    icon.textContent = '◐';
    const range = document.createElement('input');
    range.type = 'range';
    range.className = 'cd-op-range';
    range.min = '25';
    range.max = '100';
    range.step = '5';
    range.value = String(Math.round(prefs.op * 100));
    range.setAttribute('aria-label', 'Window opacity');
    const readout = document.createElement('span');
    readout.className = 'cd-op-val';
    readout.textContent = pct(prefs.op);
    const fromRange = () => {
      const v = Math.min(100, Math.max(25, Number(range.value) || 100)) / 100;
      prefs = { ...prefs, op: v };
      els.dock.style.setProperty('--cd-op', String(v));
      readout.textContent = pct(v);
    };
    range.addEventListener('input', fromRange);
    range.addEventListener('change', () => { fromRange(); savePrefs(); });   // the gesture's end
    opLabel.append(icon, range, readout);
    const solid = button('cd-solid', 'Solid', 'Solid while the pointer or focus is on the window', () => {
      prefs = { ...prefs, hoverSolid: !prefs.hoverSolid };
      solid.setAttribute('aria-pressed', String(prefs.hoverSolid));
      els.dock.toggleAttribute('data-solid', prefs.hoverSolid);
      savePrefs();
    });
    solid.setAttribute('aria-pressed', String(!!prefs.hoverSolid));
    const spacer = document.createElement('span');
    spacer.className = 'cd-spacer';
    nodes.push(close, grip, opLabel, solid, spacer,
      button('cd-attach', '⇥ Attach', 'Attach the chat to the side of the page', () => setMode('drawer')));
  }
  // A control never starts a drag (only the grip and the handles do), and a
  // pointerdown on one must not reach a strip-level listener either.
  for (const n of nodes) {
    if (n.classList.contains('cd-grip')) continue;
    n.addEventListener('pointerdown', (e) => e.stopPropagation());
  }
  strip.replaceChildren(...nodes);
}

// ── gestures: the grip moves, the eight handles resize ───────────────────────

function startGesture(e, edge) {
  if (!els || prefs.mode !== 'window' || gesture) return;
  if (typeof e.button === 'number' && e.button !== 0) return;
  e.preventDefault();
  e.stopPropagation();
  const a = area();
  const start = a ? clampWindow(prefs, a) : { x: prefs.x, y: prefs.y, w: prefs.w, h: prefs.h };
  const el = e.currentTarget;
  gesture = { pointerId: e.pointerId, edge, start, sx: e.clientX || 0, sy: e.clientY || 0, el, area: a, geom: start };
  try { if (el.setPointerCapture && e.pointerId !== undefined) el.setPointerCapture(e.pointerId); } catch { /* not capturable */ }
  els.dock.classList.add('cd-gesture');
  el.addEventListener('pointermove', onGestureMove);
  el.addEventListener('pointerup', onGestureUp);
  el.addEventListener('pointercancel', onGestureCancel);
}

function onGestureMove(e) {
  if (!gesture) return;
  const g = gesture;
  const dx = (e.clientX || 0) - g.sx;
  const dy = (e.clientY || 0) - g.sy;
  // No area (no layout to measure): only the minimum size holds.
  g.geom = gestureGeom(g.start, g.edge, dx, dy, g.area || UNBOUNDED);
  setGeomVars(g.geom);
}

function onGestureUp(e) {
  onGestureMove(e);
  endGesture(true);
}

function onGestureCancel() { endGesture(false); }

// The gesture's end: written once, here, never per move. A cancelled gesture
// puts the saved geometry back.
function endGesture(commit) {
  if (!gesture) return;
  const g = gesture;
  gesture = null;
  g.el.removeEventListener('pointermove', onGestureMove);
  g.el.removeEventListener('pointerup', onGestureUp);
  g.el.removeEventListener('pointercancel', onGestureCancel);
  try { if (g.el.releasePointerCapture && g.pointerId !== undefined) g.el.releasePointerCapture(g.pointerId); } catch { /* released */ }
  els.dock.classList.remove('cd-gesture');
  if (commit) {
    prefs = { ...prefs, x: g.geom.x, y: g.geom.y, w: g.geom.w, h: g.geom.h };
    savePrefs();
  }
  applyGeometry();
}

// ── init ─────────────────────────────────────────────────────────────────────

export function initChatDock() {
  if (els) return dockEl;
  const dock = typeof document !== 'undefined' ? document.getElementById('chat-dock') : null;
  const strip = dock && dock.querySelector('#cd-strip');
  const body = dock && dock.querySelector('#cd-body');
  if (!dock || !strip || !body) return null;
  els = { dock, strip, body };
  dockEl = dock;
  prefs = readWindowPrefs();
  for (const h of dock.querySelectorAll('.cd-h[data-edge]')) {
    const edge = h.dataset.edge;
    if (EDGES.includes(edge)) h.addEventListener('pointerdown', (e) => startGesture(e, edge));
  }
  applyPrefs();
  // The view id is 'dock', never 'sheet': chat-pull-stub.js retires the phone's
  // stand-in when a view named 'sheet' registers.
  reg = registerChatView({ id: 'dock', isOpen: isChatOpen, escape: escapeDock, close: () => { closeChat(); } });
  bus.on('chat:open', openChat);
  bus.on('viewport:narrow', (d) => { if (d && d.narrow) closeChat(); });
  window.addEventListener('resize', () => { if (isChatOpen() && !gesture) applyGeometry(); });
  return dockEl;
}
