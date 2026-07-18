// The mount system — pane chrome, layout (12-col grid), resize, drag/reorder,
// minbar, and the core mount()/clearTarget()/fullReset(). The shadow-root mount +
// <script> extraction + execution stay in the shared runtime (window.__wcMount);
// this never reimplements that contract (rewrite risk #1). Pane DOM order is
// local-only — never persisted (the drag reorder is cosmetic).
import { $, view } from './state.js';
import { store } from './store.js';
import { send, isOpen } from './ws.js';
import { applyPaneTheme } from './theme.js';

// pane records keyed by mount id: { wrapper, host, root, pane_state, title, paneTarget, theme, themeStyle, spec }
export const panes = new Map();

function applyPaneStateDefaults(s) {
  s = s || {};
  // Legacy rowSpan → heightPx so old nodes look about right.
  let heightPx = s.heightPx;
  if (heightPx == null && s.rowSpan && s.rowSpan > 1) heightPx = s.rowSpan * 60;
  return {
    col: s.col || 'auto',
    colSpan: s.colSpan || 12,
    heightPx: heightPx || null,
    pinned: !!s.pinned,
    locked: !!s.locked,
    minimized: !!s.minimized,
    mode: s.mode === 'expanded' ? 'expanded' : 'reduced',
  };
}

const COL_SNAPS = [2, 3, 4, 6, 8, 9, 12];
function snapColSpan(n) {
  let best = COL_SNAPS[0], bestD = Infinity;
  for (const s of COL_SNAPS) {
    const d = Math.abs(s - n);
    if (d < bestD) { best = s; bestD = d; }
  }
  return best;
}
const MIN_HEIGHT_PX = 80;

const emitTimers = new Map();
function emitPaneState(id) {
  if (view.previewing) return;
  const p = panes.get(id);
  if (!p) return;
  if (emitTimers.has(id)) clearTimeout(emitTimers.get(id));
  emitTimers.set(id, setTimeout(() => {
    emitTimers.delete(id);
    if (isOpen()) send({ type: 'pane:state', id, pane_state: p.pane_state });
  }, 80));
}

// ── form-state sync ─────────────────────────────────────────────────────────
// Debounce-capture a pane's form-element values (via the shared runtime's
// captureFormState) into the mount record server-side, so typed state survives
// refresh, node navigation, drafts, and exports. Skipped while previewing
// (branch-on-edit flushes explicitly after the re-aim) and while a remote
// apply is in flight (p._applyingForm gates the echo loop).
const formTimers = new Map();
const FORM_DEBOUNCE_MS = 350;
function emitFormState(id) {
  const p = panes.get(id);
  if (!p || p._applyingForm || view.previewing) return;
  if (formTimers.has(id)) clearTimeout(formTimers.get(id));
  formTimers.set(id, setTimeout(() => {
    formTimers.delete(id);
    sendFormState(id);
  }, FORM_DEBOUNCE_MS));
}
function sendFormState(id) {
  const p = panes.get(id);
  if (!p || view.previewing) return;
  const fs = window.__wcMount.captureFormState(p.root);
  const json = JSON.stringify(fs);
  if (json === p._lastFormJson) return; // unchanged — don't chat
  p._lastFormJson = json;
  p.form_state = fs;
  p.spec.form_state = fs;
  if (isOpen()) send({ type: 'pane:form', id, form_state: fs });
}
// Immediate flush of every pane's current form values — called by the
// branch-on-edit transition so the keystroke that triggered the branch isn't
// waiting out a debounce when publishing resumes.
export function flushFormStates() {
  for (const id of panes.keys()) {
    const t = formTimers.get(id);
    if (t) { clearTimeout(t); formTimers.delete(id); }
    sendFormState(id);
  }
}
// Apply a remote client's pane:form (WS 'pane:form'): rehydrate the shadow DOM
// via the shared runtime. The gate stops the dispatched input/change events
// from re-capturing and echoing the same snapshot back.
export function applyRemoteFormState(id, form_state) {
  const p = panes.get(id);
  if (!p) return;
  p.form_state = form_state;
  p.spec.form_state = form_state;
  p._lastFormJson = JSON.stringify(form_state || {});
  p._applyingForm = true;
  try { window.__wcMount.applyFormState(p.root, form_state || {}); }
  finally { p._applyingForm = false; }
}

export function applyPaneState(wrapper, pane_state) {
  wrapper.style.gridColumn = `span ${pane_state.colSpan}`;
  wrapper.style.gridRow = '';
  wrapper.style.minHeight = pane_state.heightPx ? pane_state.heightPx + 'px' : '';
  wrapper.classList.toggle('minimized', !!pane_state.minimized);
  wrapper.classList.toggle('locked', !!pane_state.locked);
  wrapper.classList.toggle('pinned', !!pane_state.pinned);
  const expanded = pane_state.mode === 'expanded';
  wrapper.dataset.mode = expanded ? 'expanded' : 'reduced';
  const mb = wrapper.querySelector('.pane-btn-mode');
  if (mb) { mb.textContent = expanded ? '⊟' : '⊞'; mb.classList.toggle('active', expanded); }
}

export function renderMinbar() {
  const minbarEl = $('minbar');
  if (!minbarEl) return;
  minbarEl.innerHTML = '';
  for (const [id, p] of panes) {
    if (!p.pane_state.minimized) continue;
    const chip = document.createElement('button');
    chip.className = 'min-chip';
    chip.innerHTML = `<span>${p.title || id}</span><span class="restore">↗</span>`;
    chip.addEventListener('click', () => {
      p.pane_state.minimized = false;
      applyPaneState(p.wrapper, p.pane_state);
      renderMinbar();
      emitPaneState(id);
    });
    minbarEl.appendChild(chip);
  }
}

function makePaneChrome(id, title, pane_state, params) {
  const wrapper = document.createElement('div');
  wrapper.className = 'pane';
  wrapper.dataset.paneId = id;

  const header = document.createElement('div');
  header.className = 'pane-header';

  const drag = document.createElement('span');
  drag.className = 'pane-drag'; drag.textContent = '⠿'; drag.title = 'drag to reorder';
  header.appendChild(drag);

  const titleEl = document.createElement('span');
  titleEl.className = 'pane-title';
  titleEl.textContent = title || id;
  header.appendChild(titleEl);

  function mkBtn(label, tip, onClick, className = '') {
    const b = document.createElement('button');
    b.className = 'pane-btn' + (className ? ' ' + className : '');
    b.textContent = label; b.title = tip;
    b.addEventListener('click', onClick);
    return b;
  }
  const btnPin = mkBtn('📌', 'pin', () => {
    pane_state.pinned = !pane_state.pinned;
    btnPin.classList.toggle('active', pane_state.pinned);
    applyPaneState(wrapper, pane_state);
    emitPaneState(id);
  });
  btnPin.classList.toggle('active', !!pane_state.pinned);

  const btnLock = mkBtn('🔒', 'lock (refuse re-renders)', () => {
    pane_state.locked = !pane_state.locked;
    btnLock.classList.toggle('lock-active', pane_state.locked);
    applyPaneState(wrapper, pane_state);
    emitPaneState(id);
  });
  btnLock.classList.toggle('lock-active', !!pane_state.locked);

  const btnMin = mkBtn('—', 'minimize', () => {
    pane_state.minimized = true;
    applyPaneState(wrapper, pane_state);
    renderMinbar();
    emitPaneState(id);
  });

  // Reduced/expanded toggle — only for panes that opt in via params.modes.
  let btnMode = null;
  if (params && params.modes) {
    btnMode = mkBtn(
      pane_state.mode === 'expanded' ? '⊟' : '⊞',
      'toggle reduced / expanded',
      () => {
        pane_state.mode = pane_state.mode === 'expanded' ? 'reduced' : 'expanded';
        applyPaneState(wrapper, pane_state);
        const p = panes.get(id);
        if (p && p.root) p.root.dispatchEvent(new CustomEvent('wc:mode', { detail: { mode: pane_state.mode } }));
        emitPaneState(id);
      },
      'pane-btn-mode',
    );
  }

  const btnClose = mkBtn('×', 'close', async () => {
    await fetch('/api/clear', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id }),
    });
  });

  header.appendChild(btnPin);
  header.appendChild(btnLock);
  if (btnMode) header.appendChild(btnMode);
  header.appendChild(btnMin);
  header.appendChild(btnClose);
  wrapper.appendChild(header);

  const resizeR = document.createElement('div'); resizeR.className = 'pane-resize-r';
  const resizeB = document.createElement('div'); resizeB.className = 'pane-resize-b';
  wrapper.appendChild(resizeR);
  wrapper.appendChild(resizeB);

  attachResize(wrapper, resizeR, resizeB, id, pane_state);
  attachDrag(wrapper, drag, id);

  return { wrapper, titleEl };
}

function attachResize(wrapper, handleR, handleB, id, pane_state) {
  function approxColWidth() {
    const mainEl = $('main');
    const w = mainEl.clientWidth - 44; // padding
    return (w - 11 * 18) / 12; // 11 gaps of 18px
  }
  function startResize(axis, handle, e) {
    e.preventDefault();
    try { handle.setPointerCapture(e.pointerId); } catch {}
    const pointerId = e.pointerId;
    const startX = e.clientX;
    const startPageY = e.pageY;
    const startCol = pane_state.colSpan;
    const startH = pane_state.heightPx || wrapper.getBoundingClientRect().height;
    const cw = approxColWidth();

    let lastClientY = e.clientY;
    let lastPageY = e.pageY;
    let scrollRaf = null;

    function applyY() {
      const dy = lastPageY - startPageY;
      const target = Math.max(MIN_HEIGHT_PX, Math.round(startH + dy));
      if (target !== pane_state.heightPx) {
        pane_state.heightPx = target;
        applyPaneState(wrapper, pane_state);
      }
    }
    function applyX(ev) {
      const dx = ev.clientX - startX;
      const target = startCol + dx / (cw + 18);
      const snapped = snapColSpan(Math.max(2, Math.min(12, target)));
      if (snapped !== pane_state.colSpan) {
        pane_state.colSpan = snapped;
        applyPaneState(wrapper, pane_state);
      }
    }
    function ensureAutoScroll() {
      if (scrollRaf) return;
      const scroller = $('main').closest('.well-wrap') || document.scrollingElement;
      const EDGE = 60;
      const tick = () => {
        const rect = scroller.getBoundingClientRect ? scroller.getBoundingClientRect() : { bottom: window.innerHeight };
        const bottom = scroller === document.scrollingElement ? window.innerHeight : rect.bottom;
        const dist = bottom - lastClientY;
        const maxScroll = scroller.scrollHeight - scroller.clientHeight;
        const room = maxScroll - scroller.scrollTop;
        if (dist < EDGE && room > 0) {
          const speed = Math.max(4, Math.min(30, EDGE - dist));
          const before = scroller.scrollTop;
          scroller.scrollTop += speed;
          const actual = scroller.scrollTop - before;
          lastPageY += actual;
          applyY();
          scrollRaf = requestAnimationFrame(tick);
        } else {
          scrollRaf = null;
        }
      };
      scrollRaf = requestAnimationFrame(tick);
    }

    function move(ev) {
      if (ev.pointerId !== pointerId) return;
      lastClientY = ev.clientY;
      lastPageY = ev.pageY;
      if (axis === 'x') applyX(ev);
      else { applyY(); ensureAutoScroll(); }
    }
    function up(ev) {
      if (ev.pointerId !== pointerId) return;
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', up);
      handle.removeEventListener('pointercancel', up);
      try { handle.releasePointerCapture(pointerId); } catch {}
      if (scrollRaf) { cancelAnimationFrame(scrollRaf); scrollRaf = null; }
      emitPaneState(id);
    }
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
    handle.addEventListener('pointercancel', up);
  }
  handleR.addEventListener('pointerdown', (e) => startResize('x', handleR, e));
  handleB.addEventListener('pointerdown', (e) => startResize('y', handleB, e));
}

function attachDrag(wrapper, handle, id) {
  handle.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    try { handle.setPointerCapture(e.pointerId); } catch {}
    const pointerId = e.pointerId;
    const mainEl = $('main');

    const startRect = wrapper.getBoundingClientRect();
    const offX = e.clientX - startRect.left;
    const offY = e.clientY - startRect.top;

    const ghost = document.createElement('div');
    ghost.className = 'pane-ghost';
    ghost.style.width = startRect.width + 'px';
    ghost.style.height = startRect.height + 'px';
    ghost.style.left = startRect.left + 'px';
    ghost.style.top = startRect.top + 'px';
    document.body.appendChild(ghost);

    const indicator = document.createElement('div');
    indicator.className = 'pane-drop-indicator';
    document.body.appendChild(indicator);

    wrapper.classList.add('pane-dragging');

    let targetPane = null;
    let side = null;

    function updateIndicator(ev) {
      ghost.style.left = (ev.clientX - offX) + 'px';
      ghost.style.top = (ev.clientY - offY) + 'px';

      const candidates = [...mainEl.querySelectorAll(':scope > .pane')]
        .filter(p => p !== wrapper && !p.classList.contains('minimized'));
      targetPane = null;
      side = null;

      let under = null;
      const elBelow = document.elementFromPoint(ev.clientX, ev.clientY);
      if (elBelow && elBelow.closest) under = elBelow.closest('.pane');
      if (under && candidates.includes(under)) {
        targetPane = under;
      } else if (candidates.length) {
        let best = null, bestD = Infinity;
        for (const c of candidates) {
          const r = c.getBoundingClientRect();
          const cx = r.left + r.width / 2;
          const cy = r.top + r.height / 2;
          const d = Math.hypot(ev.clientX - cx, ev.clientY - cy);
          if (d < bestD) { bestD = d; best = c; }
        }
        targetPane = best;
      }

      if (!targetPane) { indicator.style.display = 'none'; return; }
      const r = targetPane.getBoundingClientRect();
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      const nx = (ev.clientX - cx) / (r.width / 2);
      const ny = (ev.clientY - cy) / (r.height / 2);
      if (Math.abs(nx) > Math.abs(ny)) side = nx > 0 ? 'right' : 'left';
      else side = ny > 0 ? 'bottom' : 'top';

      indicator.style.display = 'block';
      if (side === 'left' || side === 'right') {
        indicator.style.height = r.height + 'px';
        indicator.style.width = '4px';
        indicator.style.top = r.top + 'px';
        indicator.style.left = ((side === 'right' ? r.right : r.left) - 2) + 'px';
      } else {
        indicator.style.height = '4px';
        indicator.style.width = r.width + 'px';
        indicator.style.left = r.left + 'px';
        indicator.style.top = ((side === 'bottom' ? r.bottom : r.top) - 2) + 'px';
      }
    }

    function applySideResize(draggedId, targetId) {
      const dPane = panes.get(draggedId);
      const tPane = panes.get(targetId);
      if (!dPane || !tPane) return;
      let dSpan = dPane.pane_state.colSpan;
      let tSpan = tPane.pane_state.colSpan;
      if (dSpan + tSpan > 12) {
        if (tSpan >= 12) { dSpan = 6; tSpan = 6; }
        else dSpan = Math.max(1, 12 - tSpan);
        dPane.pane_state.colSpan = dSpan;
        tPane.pane_state.colSpan = tSpan;
        applyPaneState(dPane.wrapper, dPane.pane_state);
        applyPaneState(tPane.wrapper, tPane.pane_state);
        emitPaneState(draggedId);
        emitPaneState(targetId);
      }
    }

    function onMove(ev) { if (ev.pointerId === pointerId) updateIndicator(ev); }
    function onUp(ev) {
      if (ev.pointerId !== pointerId) return;
      handle.removeEventListener('pointermove', onMove);
      handle.removeEventListener('pointerup', onUp);
      handle.removeEventListener('pointercancel', onUp);
      try { handle.releasePointerCapture(pointerId); } catch {}
      ghost.remove();
      indicator.remove();
      wrapper.classList.remove('pane-dragging');
      if (targetPane && side) {
        const targetId = targetPane.dataset.paneId;
        if (side === 'left' || side === 'right') applySideResize(id, targetId);
        const insertAfter = (side === 'right' || side === 'bottom');
        mainEl.insertBefore(wrapper, insertAfter ? targetPane.nextSibling : targetPane);
      }
    }
    updateIndicator(e);
    handle.addEventListener('pointermove', onMove);
    handle.addEventListener('pointerup', onUp);
    handle.addEventListener('pointercancel', onUp);
  });
}

export function mount(m) {
  const { html, target, id, params, pane_state, form_state, theme } = m;
  const slot = $(target) || $('main');
  const existing = panes.get(id);
  if (existing) {
    if (existing.wrapper.parentElement) existing.wrapper.parentElement.removeChild(existing.wrapper);
    panes.delete(id);
  } else {
    const stale = document.getElementById(id);
    if (stale) stale.remove();
  }

  const ps = applyPaneStateDefaults(pane_state);
  const titleFromParams = params && params.title;
  const { wrapper, titleEl } = makePaneChrome(id, titleFromParams || id, ps, params);

  const host = document.createElement('div');
  host.id = id;
  host.className = 'mount-host';
  wrapper.appendChild(host);

  applyPaneState(wrapper, ps);
  slot.appendChild(wrapper);

  const { root, scripts } = window.__wcMount.attachAndExtract(host, html);

  // markGesture: a REAL user interaction in this pane (synthetic rehydrate
  // events are gated out in reportEvent/editInPreview via _applyingForm, so
  // gesture-stamping lives with the same guard). Store writes that follow a
  // recent gesture are flagged user-driven for the activity layer — a script's
  // init/tick writes carry no gesture and never masquerade as user activity.
  const markGesture = () => {
    const p = panes.get(id);
    if (p && !p._applyingForm) p._lastGestureAt = Date.now();
  };
  root.addEventListener('click', (e) => { markGesture(); reportEvent('click', e, id); });
  root.addEventListener('change', (e) => { markGesture(); reportEvent('change', e, id); emitFormState(id); editInPreview(id); });
  root.addEventListener('submit', (e) => { markGesture(); reportEvent('submit', e, id); editInPreview(id); });
  // 'input' is deliberately NOT forwarded to the event ring (per-keystroke
  // noise; 'change' carries the settled value on blur) — it only feeds the
  // debounced form-state sync and the branch-on-edit trigger.
  root.addEventListener('input', () => { markGesture(); emitFormState(id); editInPreview(id); });

  panes.set(id, {
    wrapper, host, root, pane_state: ps, form_state: form_state || null,
    title: titleFromParams || id, paneTarget: target || 'main',
    theme: theme || null,
    spec: { id, html, target: target || 'main', params: params || {}, component: m.component, pane_state: ps, form_state: form_state || undefined, theme: theme || undefined },
  });
  applyPaneTheme(panes.get(id), theme || null, false);

  // Per-pane store facade: same store, but writes are stamped with this mount's
  // id so the server can attribute an undeclared write to its pane (opt-out
  // activity routing). Panes that grab window.store instead still work, just
  // unattributed.
  const GESTURE_WINDOW_MS = 1500;
  const paneStore = {
    get: (k) => store.get(k),
    set: (patch, opts) => {
      const p = panes.get(id);
      const gesture = !!p && (Date.now() - (p._lastGestureAt || 0)) < GESTURE_WINDOW_MS;
      store.set(patch, { ...(opts || {}), mount: id, gesture });
    },
    subscribe: (a, b) => store.subscribe(a, b),
  };
  window.__wcMount.runScripts(root, scripts, paneStore, params || {}, id, (err, scriptIndex) => {
    // Forward the failure to the daemon so it lands in the event ring
    // (get_events kind:'script-error') — a dead pane script must be observable
    // outside the browser console. Preview renders stay local.
    if (view.previewing || !isOpen()) return;
    send({
      type: 'script:error', id, script_index: scriptIndex,
      message: String((err && err.message) || err),
      stack: err && err.stack ? String(err.stack).split('\n').slice(0, 3).join('\n') : undefined,
    });
  });

  // Rehydrate persisted form values AFTER scripts ran, so a restored user draft
  // wins over a script's own initialization; the runtime dispatches input/change
  // for changed fields so reactive pane scripts resync. Gated so those dispatched
  // events don't re-capture and echo the same snapshot straight back.
  if (form_state) {
    const p = panes.get(id);
    p._lastFormJson = JSON.stringify(form_state);
    p._applyingForm = true;
    try { window.__wcMount.applyFormState(root, form_state); }
    finally { p._applyingForm = false; }
  }

  const hostTitle = host.dataset && host.dataset.paneTitle;
  if (hostTitle && !titleFromParams) {
    titleEl.textContent = hostTitle;
    panes.get(id).title = hostTitle;
  }
  // Re-assert the authoritative pane_state.mode after the bootstrap's wc:mode
  // listener attaches (a remount carries live state; baked html is frozen).
  if (params && params.modes && ps.mode === 'expanded') {
    root.dispatchEvent(new CustomEvent('wc:mode', { detail: { mode: ps.mode } }));
  }
  renderMinbar();
}

// Remove a single pane by id (WS 'clear' with an explicit id).
export function removePane(id) {
  const p = panes.get(id);
  if (p) { if (p.wrapper.parentElement) p.wrapper.remove(); panes.delete(id); }
  else { const host = document.getElementById(id); if (host) host.remove(); } // legacy bare host
  renderMinbar();
}

export function clearTarget(target) {
  const slot = $(target) || $('main');
  slot.querySelectorAll('.pane').forEach(p => {
    const id = p.dataset.paneId; if (id) panes.delete(id);
    p.remove();
  });
  renderMinbar();
}

export function fullReset({ mounts, store: newStore }) {
  for (const [, p] of panes) {
    if (p.wrapper.parentElement) p.wrapper.parentElement.removeChild(p.wrapper);
  }
  panes.clear();
  document.querySelectorAll('.mount-host').forEach(h => h.remove());
  store.replace(newStore);
  for (const m of (mounts || [])) mount(m);
  renderMinbar();
}

// Apply a remote client's pane:state (WS 'pane:state'): merge, re-layout, and
// dispatch wc:mode into the shadow root if the mode changed remotely.
export function applyRemotePaneState(id, pane_state) {
  const p = panes.get(id);
  if (!p) return;
  const prevMode = p.pane_state.mode;
  p.pane_state = { ...p.pane_state, ...pane_state };
  applyPaneState(p.wrapper, p.pane_state);
  if (p.pane_state.mode !== prevMode && p.root) {
    p.root.dispatchEvent(new CustomEvent('wc:mode', { detail: { mode: p.pane_state.mode } }));
  }
  renderMinbar();
}

// A form edit inside a pane while DETACHED on an older node triggers the
// branch-on-edit flow (silent re-aim; see topbar.branchOnEdit). Decoupled via a
// window event because topbar owns the preview state machine and already
// imports from this module (avoids an import cycle). Clicks deliberately do NOT
// trigger it — only genuine form edits (input/change/submit) branch.
function editInPreview(mountId) {
  // A rehydrate (applyFormState) dispatches synthetic input/change events that
  // bubble here — without this gate, merely PREVIEWING a node with form_state
  // would trigger a branch.
  const p = panes.get(mountId);
  if (p && p._applyingForm) return;
  if (!view.previewing) return;
  if (!view.viewedId || view.viewedId === view.activeId) return;
  window.dispatchEvent(new CustomEvent('wc:edit-in-preview'));
}

function reportEvent(type, e, mountId) {
  if (view.previewing) return;
  // Synthetic events from a form-state rehydrate are not user activity — don't
  // forward them (they'd otherwise enqueue phantom activity items server-side).
  const p = panes.get(mountId);
  if (p && p._applyingForm) return;
  const t = e.target;
  const payload = {
    type, mountId,
    tag: t?.tagName, id: t?.id || null,
    name: t?.getAttribute?.('name') || null,
    value: t?.value ?? null,
    dataset: t?.dataset ? { ...t.dataset } : null,
  };
  if (isOpen()) send({ type: 'event', payload });
}
