// The WebSocket connection + a message-type → handler map (replacing the old
// monolithic switch). Handlers are thin: they dispatch into the other modules.
// `send`/`isOpen` are the outbound side, imported by store.js and mounts.js.
//
// While detached in a preview, live updates fold into view.liveSnapshot instead
// of touching the DOM (rewrite risk #3 — a preview must never mutate the live node).
import { view, $ } from './state.js';
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
  completeBranchTransition, showReaimNote, leavePreview,
} from './topbar.js';
import { layoutAndRender, refreshGraph, isOverlayOpen } from './graph-view.js';
import { foldQueueFrame, hydrateQueue, renderQueue, onWakeAck } from './queue.js';
import { checkVersion } from './version.js';
import { applyCommentsFrame } from './comments.js';
import { onTrustPrompt, onTrustClear, resetTrustPrompts } from './service-trust.js';
import { invalidate as invalidateComponents } from './components.js';
import { bus } from './bus.js';

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

   `pane:form` is deliberately NOT queued — the reconcile calls flushFormStates(),
   which re-reads every kept pane's live DOM, and that is strictly fresher than
   anything stashed here. */
const OUTBOX_LOG_MAX = 100;
const pendingState = new Map();   // coalescing key → latest frame
const pendingLog = [];            // event / script:error, in order, capped

function queueFrame(frame) {
  if (frame.type === 'store:set') {
    const prev = pendingState.get('store:set');
    // Last-write-wins per key, so the whole gap collapses into one patch. The
    // newest frame's `mount`/`gesture` attribution rides along with it.
    pendingState.set('store:set', prev ? { ...frame, patch: { ...prev.patch, ...frame.patch } } : frame);
    return;
  }
  if (frame.type === 'pane:state') { pendingState.set(`pane:state:${frame.id}`, frame); return; }
  if (frame.type === 'pane:form') return;  // see the block comment
  pendingLog.push(frame);
  if (pendingLog.length > OUTBOX_LOG_MAX) pendingLog.shift();
}

export function send(frame) {
  if (!isOpen()) { queueFrame(frame); return false; }
  ws.send(JSON.stringify(frame));
  return true;
}

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

function setConnStatus(text, cls) {
  const s = $('status');
  if (s) { s.textContent = text; s.className = 'status-pill' + (cls ? ' ' + cls : ''); }
  const dot = document.querySelector('.brand .status-dot');
  if (dot) dot.classList.toggle('off', cls === 'off');
}

// --- preview fold helpers (operate on the captured live surface) ---
function snapUpsertMount(m) {
  if (!view.liveSnapshot) return;
  const entry = { id: m.id, html: m.html, target: m.target || 'main', params: m.params || {}, component: m.component, pane_state: m.pane_state, form_state: m.form_state, theme: m.theme };
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
    if (view.previewing && 'active' in msg && msg.active === view.viewedId) leavePreview();
    applyGlobalTheme(msg.theme || null, false); // initial paint: no animation
    setActiveNodeTheme(msg.activeTheme || null);
    applySnapshot(msg, { mode: 'reconcile' });
    // …and now the client's half of the catch-up: everything we tried to send
    // while the socket was down (see the outbox above).
    flushOutbox();
    if (!view.previewing) applyNodeTheme(getActiveNodeTheme(), false);
    applyActive(msg.active);
    applyLock(msg.lock);
    if (msg.project) document.title = `${msg.project} — web-chat`;
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
    if (view.previewing) snapUpsertMount(msg);
    else mount(msg);
  },
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
  // Another client (or this one — see topbar.branchOnEdit, which transitions
  // locally on the POST response and sets view.branchingTo so this frame is a
  // no-op for the editor) re-aimed the surface onto a previewed node via
  // branch-on-edit. Adopt the new live state; the editor client must NOT be
  // re-rendered (its DOM — including the in-flight edit — IS the new live state).
  async 'branch-here'(msg) {
    // The editing client completes its transition here (deferred pending
    // re-aim, or a race where the frame beats the POST response); if it already
    // transitioned (attached on the new active), it's a no-op. A bystander is
    // neither, since its active is the OLD id.
    if (completeBranchTransition(msg.id)) return;
    if (!view.previewing && view.activeId === msg.id) return;
    try {
      const r = await fetch('/api/graph/node/' + msg.id);
      if (r.ok) {
        const node = await r.json();
        applySnapshot({ mounts: node.mounts || [], store: node.store || {} });
      }
    } catch {}
    applyActive(msg.active);
    onGraphChanged();
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
    } else if (msg.scope === 'node') {
      if (msg.target === view.activeId) setActiveNodeTheme(msg.theme || null);
      if (msg.target === view.viewedId) applyNodeTheme(msg.theme || null, true);
    } else if (msg.scope === 'pane') {
      const p = panes.get(msg.target);
      if (p) applyPaneTheme(p, msg.theme || null, true);
      else if (view.liveSnapshot) {
        const sm = view.liveSnapshot.mounts.find(x => x.id === msg.target);
        if (sm) sm.theme = msg.theme || undefined;
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
  // surface the "honored, deferred" note everywhere.
  'reaim:pending'(msg) {
    const op = msg.intent && msg.intent.op;
    const what = op === 'wipe' ? 'surface wipe' : op === 'new-graph' ? 'new graph' : 'node jump';
    showReaimNote(`Queued ${what} — applies when Claude's turn ends.`);
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
};

export function connect() {
  ws = new WebSocket(`ws://${location.host}/ws`);
  ws.onopen = () => setConnStatus('live', 'live');
  ws.onclose = () => {
    setConnStatus('reconnecting…', 'off');
    // The server releases its outstanding-prompt memo when the last viewer
    // drops, so any nonce we still hold is dead. Clear and let it re-prompt.
    resetTrustPrompts();
    setTimeout(connect, 1000);
  };
  ws.onmessage = (m) => {
    let msg; try { msg = JSON.parse(m.data); } catch { return; }
    const h = HANDLERS[msg.type];
    // One throwing frame must not abort the rest of the stream (a `hello` that
    // dies partway used to leave the topbar, queue and version banner uninitialised).
    if (h) { try { h(msg); } catch (e) { console.error('[web-chat] handler failed for', msg.type, e); } }
  };
}
