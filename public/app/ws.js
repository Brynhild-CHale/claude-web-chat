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
  mount, clearTarget, fullReset, renderMinbar, removePane, applyRemotePaneState, panes,
} from './mounts.js';
import {
  applyActive, applyLock, ensureGraph, updateChip, onGraphChanged, syncThemeSelect,
} from './topbar.js';
import { layoutAndRender, refreshGraph, isOverlayOpen } from './graph-view.js';
import { foldQueueFrame, hydrateQueue, renderQueue } from './queue.js';
import { applyCommentsFrame } from './comments.js';

let ws = null;
export const isOpen = () => ws && ws.readyState === 1;
export function send(frame) { if (isOpen()) ws.send(JSON.stringify(frame)); }

function setConnStatus(text, cls) {
  const s = $('status');
  if (s) { s.textContent = text; s.className = 'status-pill' + (cls ? ' ' + cls : ''); }
  const dot = document.querySelector('.brand .status-dot');
  if (dot) dot.classList.toggle('off', cls === 'off');
}

// --- preview fold helpers (operate on the captured live surface) ---
function snapUpsertMount(m) {
  if (!view.liveSnapshot) return;
  const entry = { id: m.id, html: m.html, target: m.target || 'main', params: m.params || {}, component: m.component, pane_state: m.pane_state, theme: m.theme };
  const i = view.liveSnapshot.mounts.findIndex(x => x.id === m.id);
  if (i >= 0) view.liveSnapshot.mounts[i] = entry; else view.liveSnapshot.mounts.push(entry);
}
function snapClearMount(id, target) {
  if (!view.liveSnapshot) return;
  if (id) view.liveSnapshot.mounts = view.liveSnapshot.mounts.filter(x => x.id !== id);
  else view.liveSnapshot.mounts = view.liveSnapshot.mounts.filter(x => (x.target || 'main') !== (target || 'main'));
}
function snapPaneState(id, ps) {
  if (!view.liveSnapshot) return;
  const m = view.liveSnapshot.mounts.find(x => x.id === id);
  if (m) m.pane_state = { ...(m.pane_state || {}), ...(ps || {}) };
}

const HANDLERS = {
  hello(msg) {
    store.merge(msg.store);
    applyGlobalTheme(msg.theme || null, false); // initial paint: no animation
    setActiveNodeTheme(msg.activeTheme || null);
    for (const mt of (msg.mounts || [])) mount(mt);
    applyNodeTheme(getActiveNodeTheme(), false);
    applyActive(msg.active);
    applyLock(msg.lock);
    if (msg.project) document.title = `${msg.project} — web-chat`;
    ensureGraph(true).then(updateChip);
    // Re-hydrate the queue on every (re)connect — the queue isn't carried on
    // hello/reset, so a reconnect after a drop would otherwise leave the rail
    // permanently out of sync with any items enqueued during the gap.
    hydrateQueue();
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
    if (view.previewing) { snapClearMount(msg.id, msg.target); return; }
    if (msg.id) removePane(msg.id);
    else clearTarget(msg.target || 'main');
  },
  'pane:state'(msg) {
    if (view.previewing) { snapPaneState(msg.id, msg.pane_state); return; }
    applyRemotePaneState(msg.id, msg.pane_state || {});
  },
  reset(msg) {
    applyGlobalTheme(msg.theme || null, true); // global applies regardless of preview
    setActiveNodeTheme(msg.activeTheme || null);
    if (view.previewing) {
      view.liveSnapshot = { mounts: (msg.mounts || []).map(x => ({ ...x })), store: { ...(msg.store || {}) } };
      if ('active' in msg) view.activeId = msg.active;
      applyLock(msg.lock);
    } else {
      fullReset(msg);
      applyNodeTheme(getActiveNodeTheme(), true);
      if ('active' in msg) applyActive(msg.active);
      applyLock(msg.lock);
    }
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
  // The wake queue — independent of preview state (it's wake
  // signals, not surface content), so it folds regardless.
  queue(msg) { foldQueueFrame(msg); },
  // Comment pins: every comment-route notify() and revertArtifact
  // pushes the whole comments array here so the marker layer re-renders immediately;
  // renderMarkers itself is the preview guard, so this can fold regardless too.
  comments(msg) { applyCommentsFrame(msg.comments || []); renderQueue(); },
};

export function connect() {
  ws = new WebSocket(`ws://${location.host}/ws`);
  ws.onopen = () => setConnStatus('live', 'live');
  ws.onclose = () => { setConnStatus('reconnecting…', 'off'); setTimeout(connect, 1000); };
  ws.onmessage = (m) => {
    let msg; try { msg = JSON.parse(m.data); } catch { return; }
    const h = HANDLERS[msg.type];
    if (h) h(msg);
  };
}
