// The chat chrome's registration slots — the seam every chat surface plugs into
// without editing a module it plugs into (design spec §7.2).
//
// The chat mirror's chrome is built by many units at once: the desktop dock and
// the phone sheet are chat VIEWS, the composer fills a slot in the chat panel,
// and the answer frames fill the bar, the awaiting card and the sheet. Each
// registers here instead of being imported by the module that hosts it, so the
// host never names it and two units never edit one file:
//
//   registerComposer({ mount(slotEl, { variant }), focus(), escape() → bool })
//                                       → unregister      composer()  → it, or null
//   registerApprovals({ mountBar(slotEl, ask) → bool, mountCard(bodyEl, ask) → bool,
//                       mountSheet(bodyEl, ask) → bool, unmount(el) })
//                                       → unregister      approvals() → it, or null
//   registerChatView({ id, isOpen(), escape() → bool, close() })
//                                       → { unregister, changed }
//   escapeChatViews() → bool    the open view with an Escape step takes it (the shell's
//                               Escape calls this once, after every popover layer)
//   closeChatViews()  → bool    every open view closes (a flip of the narrow breakpoint)
//   chatViews()       → [{ id, open }]   what the bar asks before it offers the chat
//   posture()         → 'full' | 'status'   'full' while any view is open
//
// The composer and the approvals are single slots: a second registration takes
// the slot over, and the first one's unregister then does nothing, so a module
// that re-inits can never unregister its successor. A chat view registered
// again under the same id replaces its earlier registration the same way.
//
// THE SOCKET'S POSTURE HAS ONE OWNER, THIS REGISTRY. A socket wants the mirror's
// stream frames only while a chat view is open on it. A view calls its
// registration's `changed()` after it opens or closes; the registry recomputes
// `posture()` and, when it moved, emits chrome-bus `chat:posture {posture}`,
// which public/app/ws.js turns into the socket's `client` frame field `mirror`.
// No view sends the posture itself, so the dock and the sheet, open or closed in
// any order, can never leave the daemon holding a stale one. Registering,
// unregistering, an Escape a view took and closeChatViews() recompute it too.
//
// DOM-free, and it imports only bus.js, so plain `node --test` loads it
// (test/chat-slots.test.js) and so does every chrome module, at no cost.
import { bus } from './bus.js';

const fail = (what, why) => { throw new TypeError(`${what}: ${why}`); };

function requireMethods(what, impl, names) {
  if (!impl || typeof impl !== 'object') fail(what, 'expects an object');
  const missing = names.filter((n) => typeof impl[n] !== 'function');
  if (missing.length) fail(what, `${missing.join(', ')} must be ${missing.length > 1 ? 'functions' : 'a function'}`);
}

// One failing surface must not take the others down: a view that throws is
// reported and counted as closed (or as having declined the Escape), and the
// rest still answer — as the bus does for a failing listener.
function attempt(id, method, fn, fallback) {
  try { return fn(); } catch (e) {
    console.error(`[web-chat] chat view '${id}': ${method}() failed`, e);
    return fallback;
  }
}

// ── the single slots: the composer, and the approvals (the answer frames) ──
function singleSlot(what, methods) {
  let held = null;
  return {
    register(impl) {
      requireMethods(what, impl, methods);
      held = impl;
      return () => { if (held === impl) held = null; };
    },
    current: () => held,
  };
}

const composerSlot = singleSlot('registerComposer', ['mount', 'focus', 'escape']);
const approvalsSlot = singleSlot('registerApprovals', ['mountBar', 'mountCard', 'mountSheet', 'unmount']);

export const registerComposer = composerSlot.register;
export const composer = composerSlot.current;
export const registerApprovals = approvalsSlot.register;
export const approvals = approvalsSlot.current;

// ── the chat views: the desktop dock and the phone sheet ──
const views = [];        // { id, view }, in registration order
let announced = 'status'; // what the socket was last told: a fresh socket's own default

const isOpen = (r) => !!attempt(r.id, 'isOpen', () => r.view.isOpen(), false);

export function posture() {
  return views.some(isOpen) ? 'full' : 'status';
}

// Recompute, and tell the bus only when the posture moved.
function announce() {
  const now = posture();
  if (now !== announced) {
    announced = now;
    bus.emit('chat:posture', { posture: now });
  }
  return now;
}

export function registerChatView(view) {
  requireMethods('registerChatView', view, ['isOpen', 'escape', 'close']);
  if (typeof view.id !== 'string' || !view.id) fail('registerChatView', 'id must be a non-empty string');
  const reg = { id: view.id, view };
  const at = views.findIndex((r) => r.id === reg.id);
  if (at >= 0) views.splice(at, 1, reg); else views.push(reg);
  announce();
  return {
    unregister() {
      const i = views.indexOf(reg);
      if (i < 0) return;
      views.splice(i, 1);
      announce();
    },
    // After the view opens or closes. A handle whose registration is gone (it
    // unregistered, or a later one took its id) answers the posture and says
    // nothing: it no longer speaks for any view.
    changed() {
      return views.includes(reg) ? announce() : posture();
    },
  };
}

export function escapeChatViews() {
  for (const r of [...views]) {
    if (!isOpen(r)) continue;
    if (attempt(r.id, 'escape', () => r.view.escape(), false)) {
      announce();
      return true;
    }
  }
  return false;
}

export function closeChatViews() {
  let closed = false;
  for (const r of [...views]) {
    if (!isOpen(r)) continue;
    attempt(r.id, 'close', () => { r.view.close(); closed = true; });
  }
  announce();
  return closed;
}

export function chatViews() {
  return views.map((r) => Object.freeze({ id: r.id, open: isOpen(r) }));
}
