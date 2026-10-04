// The WebSocket connection + a message-type → handler map (replacing the old
// monolithic switch). Handlers are thin: they dispatch into the other modules.
// `send`/`isOpen` are the outbound side, imported by store.js and mounts.js.
//
// While detached in a preview, live updates fold into view.liveSnapshot instead
// of touching the DOM (rewrite risk #3 — a preview must never mutate the live node).
//
// HANDLERS is the core frames' table. A chrome module with frames of its own
// (the chat mirror's `mirror:*`, the project identity's `project`) plugs in
// through three seams instead of editing this file — see "the registration
// seams" below: onFrame, onHello and setClientField. The connection's state
// goes out on the chrome bus as `conn` {state} whenever it changes.
import { view } from './state.js';
import { store } from './store.js';
import {
  applyGlobalTheme, applyNodeTheme, applyPaneTheme, setActiveNodeTheme, getActiveNodeTheme,
} from './theme.js';
import {
  mount, clearTarget, applySnapshot, removePane, applyRemotePaneState, applyRemoteFormState, panes,
  survivesClear,
} from './mounts.js';
import {
  applyActive, applyLock, ensureGraph, updateChip, onGraphChanged, syncThemeSelect,
  showReaimNote, leavePreview,
} from './topbar.js';
import { layoutAndRender, refreshGraph, isOverlayOpen } from './graph-view.js';
import { foldQueueFrame, hydrateQueue, renderQueue, onWakeAck } from './queue.js';
import { checkVersion } from './version.js';
import { applyCommentsFrame } from './comments.js';
import { onTrustPrompt, onTrustClear, resetTrustPrompts } from './service-trust.js';
import { invalidate as invalidateComponents } from './components.js';
import { bus } from './bus.js';
import { applyBrand, refreshBrand } from './brand.js';
import { page, applyPageFrame, layoutPage } from './page.js';
import { deviceKind } from './viewport.js';

let ws = null;
export const isOpen = () => ws && ws.readyState === 1;

/* ── the outbox ──────────────────────────────────────────────────────────────
   Every frame the chrome sends is state the DAEMON has to end up holding: a
   store patch a pane wrote, a pane's geometry, an activity event, a script
   error. `send` used to drop all of them on a closed socket and say nothing —
   and a reconnect is server→client only (`hello` carries no client half), so
   the reconcile then overwrote the local copy with the server's older picture
   too. A store write or a resize made across a laptop sleep was destroyed at
   BOTH ends, with no trace anywhere.

   So queue instead of dropping. Frames that carry STATE coalesce — one entry
   per key, last write wins, store patches merged — so a gap of any length costs
   a bounded amount of memory; the append-only ones keep a capped tail. The
   drain runs from `hello`, AFTER the snapshot has been applied: the server
   built that snapshot before it heard any of this, so a frame sent ahead of it
   would be contradicted by the very frame it was meant to correct.

   Store patches coalesce per WRITER — one entry per (mount, gesture) — not into
   one patch for the whole gap. The daemon reads a store:set's `mount` and
   `gesture` to decide what it is (lib/channel/policy: a declared signal becomes
   a queue item naming its pane, a gesture-less undeclared write is a script's
   and routes nowhere), so one merged frame carrying the LAST writer's
   attribution turned two panes' handoffs into one item on the wrong pane, and a
   user's write followed by a script tick into no activity at all. Across
   writers, last-write-wins per key still holds: a later write of a key takes it
   out of every other pending patch and moves its own entry to the end, and the
   drain sends in that order.

   `pane:form` is deliberately NOT queued — the reconcile calls flushFormStates(),
   which re-reads the live DOM of every kept pane the user edited, and that is
   strictly fresher than anything stashed here. */
const OUTBOX_LOG_MAX = 100;
const pendingState = new Map();   // coalescing key → latest frame
const pendingLog = [];            // event / script:error, in order, capped

function queueStoreSet(frame) {
  const key = `store:set:${frame.mount || ''}:${frame.gesture ? 1 : 0}`;
  const written = Object.keys(frame.patch || {});
  // A key written now is no longer another writer's to send.
  for (const [k, f] of [...pendingState]) {
    if (k === key || f.type !== 'store:set') continue;
    if (!written.some((w) => w in f.patch)) continue;
    const patch = { ...f.patch };
    for (const w of written) delete patch[w];
    if (Object.keys(patch).length) pendingState.set(k, { ...f, patch });
    else pendingState.delete(k);
  }
  const prev = pendingState.get(key);
  pendingState.delete(key);   // re-inserted last: the drain replays the writes in order
  pendingState.set(key, prev ? { ...frame, patch: { ...prev.patch, ...frame.patch } } : frame);
}

function queueFrame(frame) {
  if (frame.type === 'store:set') { queueStoreSet(frame); return; }
  if (frame.type === 'pane:state') { pendingState.set(`pane:state:${frame.id}`, frame); return; }
  if (frame.type === 'pane:form') return;  // see the block comment
  if (frame.type === 'client') return;     // hello re-sends the current one
  pendingLog.push(frame);
  if (pendingLog.length > OUTBOX_LOG_MAX) pendingLog.shift();
}

export function send(frame) {
  if (!isOpen()) { queueFrame(frame); return false; }
  ws.send(JSON.stringify(frame));
  return true;
}

// The chrome's posture, for push provenance: a declared `wake:'immediate'` signal
// wakes Claude straight from this socket's store:set, so the daemon has to know
// whether this is the phone view (lib/server/domain/queue provenance). Sent on
// every (re)connect — before the outbox drains, so a write made across the gap
// is attributed — and whenever the viewport flips.
//
// Other modules add fields of their own with setClientField (the registration
// seams, below): every `client` frame carries all of them, so a reconnect's
// hello restores the whole set to a socket the daemon has just met. `type` and
// `device` stay this file's.
const clientFields = new Map();
function sendClientInfo() {
  send({ ...Object.fromEntries(clientFields), type: 'client', device: deviceKind() });
}
bus.on('viewport', sendClientInfo);

function flushOutbox() {
  const frames = [...pendingState.values(), ...pendingLog];
  pendingState.clear();
  pendingLog.length = 0;
  for (const f of frames) {
    // Converge the LOCAL copy as well: the reconcile just replaced it with what
    // the server believed before the gap. `fromServer` stops the store's publish
    // hook sending a second frame for the same patch. While previewing the DOM
    // belongs to a committed node, not the live surface, so only the wire half runs.
    if (!view.previewing) {
      if (f.type === 'store:set') store.set(f.patch, { fromServer: true });
      else if (f.type === 'pane:state') applyRemotePaneState(f.id, f.pane_state || {});
    }
    send(f);   // a socket that closed again simply re-queues it
  }
}

// The socket's state is one input to the topbar's ONE status pill (it used to
// own a second pill of its own, beside the node pill). While it is not live the
// pill says so; live, the pill goes back to naming the node. Every change also
// goes out on the chrome bus as `conn` {state} — connecting, live, reconnecting
// — for the chat chrome, which shows a dropped connection (the bar's and the
// phone tab's offline states). The brand dot that used to say it is retired:
// the co-brand lockup took the topbar's corner (spec §9.4).
function setConnStatus(state) {
  const changed = state !== view.conn;
  view.conn = state;
  updateChip();
  if (changed) bus.emit('conn', { state });
}

// --- preview fold helpers (operate on the captured live surface) ---
// The whole render frame is folded, minus its envelope (`type`) and the page
// fields that ride it (`order`/`claude_order` — pageFrame folds those onto the
// captured page). A hand-picked field list here once dropped `owner`, so a pane
// spawned during a preview came back from ↩ active as Claude's: no ↳ parent
// chip, and a pane-history "Make current" the daemon then refused.
function snapUpsertMount(m) {
  if (!view.liveSnapshot) return;
  const { type, order, claude_order, ...rest } = m;
  const entry = { ...rest, target: rest.target || 'main', params: rest.params || {} };
  const i = view.liveSnapshot.mounts.findIndex(x => x.id === m.id);
  if (i >= 0) view.liveSnapshot.mounts[i] = entry; else view.liveSnapshot.mounts.push(entry);
}
function snapClearMount(id, target, frame = {}) {
  if (!view.liveSnapshot) return;
  if (id) { view.liveSnapshot.mounts = view.liveSnapshot.mounts.filter(x => x.id !== id); return; }
  // Same clear-all rule the attached path applies (mounts.survivesClear), so a
  // detached client's captured live surface doesn't drift from the real one.
  const kept = Array.isArray(frame.kept) ? new Set(frame.kept) : null;
  view.liveSnapshot.mounts = view.liveSnapshot.mounts.filter(x => {
    if (target && (x.target || 'main') !== target) return true;
    return kept ? kept.has(x.id) : survivesClear(x.pane_state, frame);
  });
}
// A page frame (markdown, markdown:remove, page:order, page:run, a render's
// order): onto the folded live page while previewing, else onto the live page
// and laid out.
function pageFrame(msg) {
  if (view.previewing) {
    if (view.liveSnapshot && view.liveSnapshot.page) applyPageFrame(view.liveSnapshot.page, msg);
    return;
  }
  applyPageFrame(page, msg);
  layoutPage();
}
function snapPaneState(id, ps) {
  if (!view.liveSnapshot) return;
  const m = view.liveSnapshot.mounts.find(x => x.id === id);
  if (m) m.pane_state = { ...(m.pane_state || {}), ...(ps || {}) };
}

const HANDLERS = {
  // The frame every (re)connection opens with — first open, and equally the
  // reconnect after a laptop sleep, a `restart` or a self-update. It carries the
  // same full snapshot `reset` does, so it goes through the same applier: this
  // handler used to mount its panes itself, with no preview fork (a reconnect
  // mid-preview overwrote the previewed node) and no removal of panes the server
  // had cleared during the gap. RECONCILE, not authoritative: nothing about the
  // surface changed, so a pane whose spec is unchanged keeps its live DOM.
  hello(msg) {
    // A re-aim that landed while this client was disconnected can put active
    // exactly where it is previewing — attach rather than sit half-detached
    // (previewing with viewedId === activeId), the same rule `reset` carries.
    // And then render the frame AUTHORITATIVELY, as `reset` does: the DOM on
    // screen is the previewed node's, not this client's picture of the live
    // surface, so there is nothing to reconcile. A reconcile kept every pane
    // whose spec matched — with the committed node's form values, since
    // form_state is never applied over a kept pane — and the next keystroke
    // published those old values over what had been typed live.
    const reattach = view.previewing && 'active' in msg && msg.active === view.viewedId;
    if (reattach) leavePreview();
    applyGlobalTheme(msg.theme || null, false); // initial paint: no animation
    setActiveNodeTheme(msg.activeTheme || null);
    applySnapshot(msg, reattach ? {} : { mode: 'reconcile' });
    sendClientInfo();
    // …and now the client's half of the catch-up: everything we tried to send
    // while the socket was down (see the outbox above).
    flushOutbox();
    if (!view.previewing) applyNodeTheme(getActiveNodeTheme(), false);
    applyActive(msg.active);
    applyLock(msg.lock);
    // The title is not this handler's: project.js, a hello hook (onHello), is
    // the tab title's one writer — the project's name, the folder's until an
    // identity lands (spec §9.4, ruling N1).
    ensureGraph(true).then(updateChip);
    // Re-hydrate the queue on every (re)connect — the queue isn't carried on
    // hello/reset, so a reconnect after a drop would otherwise leave the rail
    // permanently out of sync with any items enqueued during the gap.
    hydrateQueue();
    // Re-check the build on every (re)connect: a reconnect after a self-update
    // restart lands on the new daemon, so this clears the "Updating…" banner once
    // the version has actually moved.
    checkVersion();
  },
  'store:patch'(msg) {
    if (view.previewing) { if (view.liveSnapshot) Object.assign(view.liveSnapshot.store, msg.patch || {}); }
    else store.set(msg.patch, { fromServer: true });
  },
  render(msg) {
    // A pane placed with `after` carries the resulting page order; take it first
    // so the pane mounts straight into its slot.
    if (view.previewing) { snapUpsertMount(msg); pageFrame(msg); return; }
    applyPageFrame(page, msg);
    mount(msg);
  },
  // The page sequence (lib/server/domain/page): a markdown item put / replaced /
  // removed, a user's reorder or ↺ Claude's layout, a run's narrow-screen flag.
  markdown(msg) { pageFrame(msg); },
  'markdown:remove'(msg) { pageFrame(msg); },
  'page:order'(msg) { pageFrame(msg); },
  'page:run'(msg) { pageFrame(msg); },
  clear(msg) {
    if (view.previewing) { snapClearMount(msg.id, msg.target, msg); return; }
    if (msg.id) removePane(msg.id);
    else clearTarget(msg.target, msg); // clear-all spares pinned panes
  },
  'pane:state'(msg) {
    if (view.previewing) { snapPaneState(msg.id, msg.pane_state); return; }
    applyRemotePaneState(msg.id, msg.pane_state || {});
  },
  'pane:form'(msg) {
    if (view.previewing) {
      if (view.liveSnapshot) {
        const m = view.liveSnapshot.mounts.find(x => x.id === msg.id);
        if (m) m.form_state = msg.form_state || {};
      }
      return;
    }
    applyRemoteFormState(msg.id, msg.form_state || {});
  },
  // A full surface replacement (wipe, new graph, node jump, turn-end re-aim).
  // The frame is AUTHORITATIVE and rendered VERBATIM: whatever mounts it carries
  // are what the surface shows. Notably a wipe preserves pinned mounts SERVER-SIDE
  // and sends the survivors here — the client must not do its own pinned-filtering
  // on top, or the two rules would compound and a pin would resurrect a pane the
  // server dropped (or drop one it kept).
  reset(msg) {
    applyGlobalTheme(msg.theme || null, true); // global applies regardless of preview
    setActiveNodeTheme(msg.activeTheme || null);
    // A queued re-aim (pending set-active) applied at turn-end can land active
    // exactly where this client is previewing — attach instead of staying in a
    // half-detached state (previewing with viewedId === activeId).
    if (view.previewing && 'active' in msg && msg.active === view.viewedId) {
      leavePreview();
    }
    applySnapshot(msg); // authoritative: the surface itself moved
    if (!view.previewing) applyNodeTheme(getActiveNodeTheme(), true);
    if ('active' in msg) applyActive(msg.active); // no-ops viewedId while previewing
    applyLock(msg.lock);
    onGraphChanged();
  },
  theme(msg) {
    if (msg.scope === 'global') {
      applyGlobalTheme(msg.theme || null, true);
      if (msg.theme && msg.theme.name) syncThemeSelect(msg.theme.name);
      // The brand images follow the global theme (each theme keeps its own,
      // and its pack can fill an empty slot) — the daemon sends a `brand` frame
      // with every global theme change, just ahead of this one, so there is
      // nothing to re-read here (lib/server/routes/brand.js).
    } else if (msg.scope === 'node') {
      if (msg.target === view.activeId) setActiveNodeTheme(msg.theme || null);
      if (msg.target === view.viewedId) applyNodeTheme(msg.theme || null, true);
    } else if (msg.scope === 'pane') {
      // A pane theme is a LIVE change. While previewing, `panes` holds the
      // previewed node's panes — and with stable mount ids one of them usually
      // answers to the target — so the theme folds into the captured live
      // surface, like every other live frame, and the committed node on screen
      // is never repainted.
      if (view.previewing) {
        const sm = view.liveSnapshot && view.liveSnapshot.mounts.find(x => x.id === msg.target);
        if (sm) sm.theme = msg.theme || undefined;
      } else {
        const p = panes.get(msg.target);
        if (p) applyPaneTheme(p, msg.theme || null, true);
      }
    }
    if (isOverlayOpen()) layoutAndRender();
  },
  lock(msg) {
    applyLock(msg.lock);
    if (isOverlayOpen()) refreshGraph();
  },
  bookmark() { onGraphChanged(); },
  'node-added'(msg) {
    if (msg.unlock) applyLock(null);
    applyActive(msg.active);
    onGraphChanged();
  },
  // A re-aim was queued during a locked turn (this client's or another's) —
  // surface the "honored, deferred" note everywhere. `intent: null` withdraws
  // it: the turn it waited for never finished, and a new turn took its stale
  // lock (lib/server/domain/turns stealStale), so it will never apply.
  'reaim:pending'(msg) {
    const intent = msg.intent || msg.dropped;
    const op = intent && intent.op;
    const what = op === 'wipe' ? 'surface wipe' : op === 'new-graph' ? 'new graph' : 'node jump';
    if (!msg.intent) showReaimNote(`Dropped the queued ${what} — Claude's turn stopped without finishing. Do it again if you still want it.`);
    else showReaimNote(`Queued ${what} — applies when Claude's turn ends.`);
  },
  // The wake queue — independent of preview state (it's wake
  // signals, not surface content), so it folds regardless.
  queue(msg) { foldQueueFrame(msg); },
  // Delivery confirmation for a live Push — resolves the rail's "Sending…" state
  // into "Delivered ✓" (the timeout otherwise rejects it). See queue.onWakeAck.
  'wake-ack'(msg) { onWakeAck(msg.seq); },
  // Comment pins: every comment-route notify() and revertArtifact
  // pushes the whole comments array here so the marker layer re-renders immediately;
  // renderMarkers itself is the preview guard, so this can fold regardless too.
  comments(msg) { applyCommentsFrame(msg.comments || []); renderQueue(); },
  // The component set moved: a save_component, or a pack installed / approved /
  // removed anywhere (this browser, another one, or the CLI's announce). Drop
  // the ONE component cache; the drawer and the ⌘K palette both read it, and
  // the palette's private cache was never invalidated — so an install used to
  // be invisible there until the page was reloaded.
  components() { invalidateComponents(); },
  'packs:changed'(msg) { bus.emit('packs:changed', msg); },
  // Service consent. Chrome-level, never a mount — see service-trust.js for why.
  'service:trust'(msg) { onTrustPrompt(msg); },
  'service:trust:clear'(msg) { onTrustClear(msg); },
  // A brand image slot was set or cleared (here or in another viewer), or the
  // global theme moved and its images with it.
  brand(msg) { applyBrand(msg.slots, msg.fill, msg.theme); },
  // Claude opened a replay for the user (export({open:true}) → POST
  // /api/replay/open): the player overlay shows that script. Relayed over the
  // chrome bus, like packs:changed — replay.js listens (initReplay).
  'replay:open'(msg) { bus.emit('replay:open', msg); },
};

/* ── the registration seams ───────────────────────────────────────────────────
   HANDLERS stays the core frames' one table. A module with frames, hello work
   or client fields of its own registers them here instead, so the chat mirror's
   chrome (design spec §7.2) and everything after it plug in without editing
   this file, and no two of them ever edit the same lines:

     onFrame(typeOrPrefix, handler) → unregister
         an exact frame type ('project'), or a prefix ending in ':' for a family
         ('mirror:'). Several per type; they run in registration order AFTER any
         built-in handler, each in its own try/catch, so a module that throws
         cannot cost the next one its frame.
     onHello(handler) → unregister
         runs at the end of every `hello`: after the snapshot, the outbox drain
         and hydrateQueue(). hello carries nothing new for a module (the wire is
         pinned byte for byte, test/bus-golden.test.js), so this is where one
         re-reads what a (re)connect may have missed.
     setClientField(key, value)
         merged into every `client` frame, and sent at once while the socket is
         open; a reconnect's hello re-sends the whole set. `undefined` withdraws
         the field.

   The one field this file sets itself: the chat views' posture. chat-slots.js
   owns it and announces each change as `chat:posture`; the socket carries it
   as `mirror`, which the daemon reads to decide whether this viewer wants the
   mirror's stream frames. */
const frameHandlers = [];   // { key, prefix, fn }, in registration order
const helloHooks = [];      // { fn }

const unregisterFrom = (list, entry) => () => {
  const i = list.indexOf(entry);
  if (i >= 0) list.splice(i, 1);
};

export function onFrame(typeOrPrefix, handler) {
  if (typeof typeOrPrefix !== 'string' || !typeOrPrefix) {
    throw new TypeError('onFrame: give a frame type, or a prefix ending in ":"');
  }
  if (typeof handler !== 'function') throw new TypeError('onFrame: the handler must be a function');
  const entry = { key: typeOrPrefix, prefix: typeOrPrefix.endsWith(':'), fn: handler };
  frameHandlers.push(entry);
  return unregisterFrom(frameHandlers, entry);
}

export function onHello(handler) {
  if (typeof handler !== 'function') throw new TypeError('onHello: the handler must be a function');
  const entry = { fn: handler };
  helloHooks.push(entry);
  return unregisterFrom(helloHooks, entry);
}

const OWN_CLIENT_FIELDS = new Set(['type', 'device']);
export function setClientField(key, value) {
  if (typeof key !== 'string' || !key || OWN_CLIENT_FIELDS.has(key)) {
    throw new TypeError(`setClientField: '${key}' is not a field another module may set`);
  }
  if (value === undefined) {
    if (!clientFields.has(key)) return;
    clientFields.delete(key);
  } else {
    if (clientFields.has(key) && clientFields.get(key) === value) return;
    clientFields.set(key, value);
  }
  if (isOpen()) sendClientInfo();   // closed: the next hello sends it
}

bus.on('chat:posture', (d) => {
  const posture = d && d.posture;
  if (posture === 'full' || posture === 'status') setClientField('mirror', posture);
});

function runSafely(fn, msg, what) {
  try { fn(msg); } catch (e) { console.error(`[web-chat] ${what} failed for`, msg.type, e); }
}

// One frame: the built-in handler, then (for a hello) the hello hooks, then
// every registered handler whose type or prefix matches. One throwing frame
// must not abort the rest of the stream (a `hello` that died partway used to
// leave the topbar, queue and version banner uninitialised), and one throwing
// handler must not starve the others — so each runs on its own.
function dispatch(msg) {
  if (!msg || typeof msg !== 'object' || typeof msg.type !== 'string') return;
  const { type } = msg;
  if (Object.prototype.hasOwnProperty.call(HANDLERS, type)) runSafely(HANDLERS[type], msg, 'handler');
  if (type === 'hello') for (const h of [...helloHooks]) runSafely(h.fn, msg, 'hello hook');
  for (const h of [...frameHandlers]) {
    if (h.prefix ? type.startsWith(h.key) : type === h.key) runSafely(h.fn, msg, 'frame handler');
  }
}

// The daemon's socket, on the page's own origin and scheme. A page served over
// https (a TLS proxy or tunnel in front of the daemon) must open wss: — a browser
// refuses a plain ws: socket from a secure page as mixed content, and the surface
// then sat on "reconnecting…" forever with nothing else to say why.
export const wsUrl = (loc = location) => `${loc.protocol === 'https:' ? 'wss' : 'ws'}://${loc.host}/ws`;

export function connect() {
  ws = new WebSocket(wsUrl());
  ws.onopen = () => { setConnStatus('live'); refreshBrand(); };
  ws.onclose = () => {
    setConnStatus('reconnecting');
    // The server releases its outstanding-prompt memo when the last viewer
    // drops, so any nonce we still hold is dead. Clear and let it re-prompt.
    resetTrustPrompts();
    setTimeout(connect, 1000);
  };
  ws.onmessage = (m) => {
    let msg; try { msg = JSON.parse(m.data); } catch { return; }
    dispatch(msg);
  };
}
