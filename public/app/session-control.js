// The chrome's control frames (spec §15.5) and the Stop control (§15.2, §7.5,
// §7.9): the ONE helper that mounts a control frame, and the Stop in the status
// bar's #cs-stop and the chat panel header's #cp-stop.
//
//   initSessionControl({ timers })   starts the Stop control; idempotent. U66a
//                                    calls it from main.js after initAsks.
//                                    `timers` ({setTimeout, clearTimeout}) is a
//                                    test seam, swapped by a second call too.
//   stopSessionControl()             unmounts both Stops, clears the linger
//                                    timers and the pending frame, unlistens
//   mountControlFrame(container, { action, params, layout: 'stop'|'confirm',
//                     size, onDone }) → { frame, unmount() } | null
//   mountStop(container, { conversationId, size: 'bar'|'panel'|'sheet' })
//                                    → { frame, unmount() } | null
//                                    (tranche 5's sheet header takes 'sheet')
//
// WHY A FRAME (ruling U81-U85-U86@click-token (a), Q-C). Every acting control
// is a button in a document of the answer origin: its nonce, minted there for
// one action on one target, is the click token, and pane script — which runs in
// THIS realm and owns the DOM around anything drawn here — can neither read it
// nor forge the origin. So nothing here posts to an acting route, binds a key
// or words a result: the frame does all of it (lib/server/answer-surface/
// public/control-stop.js, control-confirm.js).
//
// mountControlFrame is asks.js's mountAnswerFrame with the control kind (U56:
// "mountAnswerFrame mounts control frames too"): the document
// /answer/control/<action>?<params>&size=&layout=&mode=&device=, the clipboard
// allowed only for a confirm (the fork's Copy). It answers null at once —
// never waiting on the network — when the viewer may not act (local, or remote
// at level `full` through the portal's answer origin: class P2, §15.5) or no
// answer origin is known yet; asks.js then refreshes the port in the
// background and emits PORT_EVENT, on which the Stop control asks again. A
// mounted frame that reports no size in 3 s is asks.js's to remount once at
// the fresh port (never the popup), and a port change remounts every frame.
// onDone(outcome, result) hears only the layout's own outcomes:
//   stop     'interrupted'
//   confirm  'restored' · 'failed' · 'undone' · 'forked' · 'refused'
// with `result` counts only — the chrome never receives a restore id or a fork
// command (B-confirm (4)). It works anywhere a container is, a registerStopper
// slot (div.cs-row-confirm, compact or touch, chat-actions.js) included, so
// tranche 6's stopper is one call.
//
// THE STOP CONTROL. On chat-state's `mirror` events (one animation frame
// coalesces them), a stop frame sits in #cs-stop (size bar) for the bar's
// conversation and in #cp-stop (size panel) for the panel's, each while
// capabilities.interrupt is true, the viewer may act, and that conversation's
// live state is working, compacting, question or waiting. Both read the
// followed conversation (chat-state's `followed`: this tab's choice while live,
// else the server's primary) — it is what the bar and the panel SHOW, so a
// Stop never stops a conversation other than the one beside it. A slot
// remounts when its conversation changes, and the panel's when the panel moves
// host (chat:host: a moved iframe reloads anyway; the remount gives it a fresh
// record). It unmounts 1.5 s after its conversation leaves those states — one
// bounded setTimeout per slot, cleared by stopSessionControl — so the frame's
// own 'Interrupted' is seen; then the bar's 'Stopped · from this page' (from
// last_turn.ended_by) carries it. Never a setInterval, never a setTimeout chain
// (§10.1).
//
// NEVER: a write to #cs-act, the step text or the bar's state (chat-bar.js's);
// an Escape binding (shell.js owns Escape; §4.5: Esc never answers anything);
// opacity, a filter, a transform, a clip or a mask on a frame (its visibility
// proof would read any of them as covered); a stopper registration (ruling E1
// (a): with none, Kill, Cancel and Remove keep the queue route).
import { bus } from './bus.js';
import { mirror, statusOf, atLeast } from './chat-state.js';
import { mountAnswerFrame, PORT_EVENT } from './asks.js';

export const ACTIVE_STATES = Object.freeze(['working', 'compacting', 'question', 'waiting']);
export const LINGER_MS = 1500;
export const STOP_SIZES = Object.freeze(['bar', 'panel', 'sheet']);
export const OUTCOMES = Object.freeze({
  stop: Object.freeze(['interrupted']),
  confirm: Object.freeze(['restored', 'failed', 'undone', 'forked', 'refused']),
});
const ACTIVE = new Set(ACTIVE_STATES);
const ACTION_RE = /^[a-z][a-z-]{1,31}$/;
const PARAM_RE = /^[a-z][a-z0-9_]{0,31}$/;
const SIZE_RE = /^[a-z][a-z-]{0,15}$/;
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
// The answer surface's own query keys: never a param of an action's target.
const SURFACE_KEYS = new Set(['layout', 'mode', 'size', 'device', 'v', 'wait', 'action', 'id']);
const PARAM_MAX = 256;

let timers = {
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (h) => globalThis.clearTimeout(h),
};

// ── the one helper ──────────────────────────────────────────────────────────

// Whether this viewer may take a control action at all: local, or remote at
// `full` (the portal's answer host carries the rest of the gate, §4.6).
export function mayAct() {
  const a = mirror.access || {};
  if (a.remote === true) return a.level === 'full';
  return atLeast(a.level, 'full');
}

export function mountControlFrame(container, { action, params, layout, size, onDone } = {}) {
  if (!container || typeof container.append !== 'function') return null;
  if (typeof action !== 'string' || !ACTION_RE.test(action)) return null;
  if (layout !== 'stop' && layout !== 'confirm') return null;
  if (!mayAct()) return null;
  const query = {};
  for (const [k, v] of Object.entries(params && typeof params === 'object' ? params : {})) {
    if (!PARAM_RE.test(k) || SURFACE_KEYS.has(k)) return null;
    if (typeof v !== 'string' && !(typeof v === 'number' && Number.isFinite(v))) return null;
    const s = String(v);
    if (!s || s.length > PARAM_MAX) return null;
    query[k] = s;
  }
  if (size !== undefined && size !== null) {
    if (typeof size !== 'string' || !SIZE_RE.test(size)) return null;
    query.size = size;
  }
  const allowed = OUTCOMES[layout];
  const done = typeof onDone === 'function' ? (outcome, result) => {
    if (!allowed.includes(outcome)) return;
    onDone(outcome, result);
  } : null;
  const h = mountAnswerFrame(container, {
    kind: 'control',
    path: action,
    query,
    layout,
    onDone: done,
    clipboard: layout === 'confirm',
    title: layout === 'stop' ? 'Stop Claude' : 'Confirm a web-chat action',
  });
  if (!h) return null;
  return {
    get frame() { return h.frame; },
    unmount() { h.unmount(); },
  };
}

// The slot says its size (data-wc-stop), which app.css's U85 section sizes the
// frame by: asks.js rebuilds the iframe on a remount, so the size lives on the
// slot, never on the frame.
export function mountStop(container, { conversationId, size = 'bar' } = {}) {
  if (typeof conversationId !== 'string' || !ID_RE.test(conversationId)) return null;
  if (!STOP_SIZES.includes(size)) return null;
  const h = mountControlFrame(container, {
    action: 'interrupt', params: { conversation_id: conversationId }, layout: 'stop', size,
  });
  if (!h) return null;
  container.setAttribute('data-wc-stop', size);
  return {
    get frame() { return h.frame; },
    unmount() {
      h.unmount();
      if (!container.querySelector('.wc-answer-frame')) container.removeAttribute('data-wc-stop');
    },
  };
}

// ── the Stop control ────────────────────────────────────────────────────────

// The two slots: where, at what size, for which conversation.
const SLOTS = [
  { id: 'cs-stop', size: 'bar', conversation: () => mirror.followed },
  { id: 'cp-stop', size: 'panel', conversation: () => mirror.followed },
];

let inited = null;
let offs = [];
let frame = null;           // the pending animation frame
const recs = new Map();     // slot id → { container, cid, handle, linger, waiting }

const isActive = (cid) => {
  const s = cid ? statusOf(cid) : null;
  return !!s && ACTIVE.has(s.state);
};

function drop(rec) {
  if (rec.linger !== null) { timers.clearTimeout(rec.linger); rec.linger = null; }
  if (rec.handle) { rec.handle.unmount(); rec.handle = null; }
  rec.cid = null;
}

function syncSlot(slot) {
  let rec = recs.get(slot.id);
  if (!rec) { rec = { container: null, cid: null, handle: null, linger: null, waiting: false }; recs.set(slot.id, rec); }
  const container = typeof document !== 'undefined' ? document.getElementById(slot.id) : null;
  const cid = slot.conversation() || null;
  const allowed = !!container && !!cid && mirror.capabilities.interrupt === true && mayAct();
  // Another conversation, another host, or no right to it: the frame goes now.
  if (rec.handle && (!allowed || rec.cid !== cid || rec.container !== container)) drop(rec);
  if (rec.container !== container || rec.cid !== cid) rec.waiting = false;
  rec.container = container;
  if (!allowed) { rec.cid = null; return; }
  if (isActive(cid)) {
    if (rec.linger !== null) { timers.clearTimeout(rec.linger); rec.linger = null; }
    if (rec.handle || rec.waiting) { rec.cid = cid; return; }
    rec.handle = mountStop(container, { conversationId: cid, size: slot.size });
    rec.cid = cid;
    // No origin yet: asks.js is refreshing the port; PORT_EVENT asks again.
    rec.waiting = !rec.handle;
    return;
  }
  // Out of the active states: the frame stays LINGER_MS, so its own
  // 'Interrupted' is seen, then goes.
  rec.waiting = false;
  if (rec.handle && rec.linger === null) {
    rec.linger = timers.setTimeout(() => {
      rec.linger = null;
      if (rec.handle && !isActive(rec.cid)) { rec.handle.unmount(); rec.handle = null; rec.cid = null; }
    }, LINGER_MS);
  }
}

function sync() {
  if (frame !== null) { cancelFrame(frame); frame = null; }
  if (!inited) return;
  for (const slot of SLOTS) syncSlot(slot);
}

function cancelFrame(h) {
  const caf = globalThis.cancelAnimationFrame;
  if (typeof caf === 'function') caf(h);
}

// Every event of one frame is one sync.
function schedule() {
  if (!inited || frame !== null) return;
  const raf = globalThis.requestAnimationFrame;
  if (typeof raf !== 'function') { sync(); return; }
  frame = raf(() => { frame = null; sync(); });
}

// The panel moved host: its Stop is remounted there (once).
function onHost() {
  const rec = recs.get('cp-stop');
  if (rec && rec.handle) drop(rec);
  if (rec) rec.waiting = false;
  schedule();
}

// A port is known (or changed): a slot that answered null asks again.
function onPort() {
  for (const rec of recs.values()) rec.waiting = false;
  schedule();
}

export function initSessionControl({ timers: t } = {}) {
  if (t && typeof t.setTimeout === 'function' && typeof t.clearTimeout === 'function') timers = t;
  if (inited) return inited;
  inited = { stop: stopSessionControl };
  offs = [
    bus.on('mirror', schedule),
    bus.on('chat:host', onHost),
    bus.on(PORT_EVENT, onPort),
  ];
  sync();
  return inited;
}

export function stopSessionControl() {
  for (const off of offs.splice(0)) { try { off(); } catch { /* gone */ } }
  if (frame !== null) { cancelFrame(frame); frame = null; }
  for (const rec of recs.values()) drop(rec);
  recs.clear();
  inited = null;
}
