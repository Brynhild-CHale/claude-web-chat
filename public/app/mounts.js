// The mount system — pane chrome, pane placement (col/span/rows on its run's
// 12-col grid), resize, drag-within-a-run, and the core mount()/clearTarget()/
// fullReset()/applySnapshot(). The last is the ONE applier of a full-surface
// snapshot frame (hello / reset / preview restore) and owns the preview fork —
// for the page record (markdown, order, run flags; public/app/page.js) as much
// as for the panes. The shadow-root mount + <script> extraction + execution stay
// in the shared runtime (window.__wcMount); this never reimplements that
// contract (rewrite risk #1). WHERE a pane's wrapper sits is page.js's
// layoutPage(); a drag's new order is a user move the daemon persists
// (page.commitRunOrder → POST /api/page/move).
import { $, hostFor, view } from './state.js';
import { store } from './store.js';
import { send, isOpen } from './ws.js';
import { applyPaneTheme } from './theme.js';
import { isPhone } from './viewport.js';
import { bus } from './bus.js';
import { togglePaneHistory } from './pane-history.js';
import {
  layoutPage, setPage, pageFromFrame, placeOf, runOf, commitRunOrder,
  COLS, ROW_PX, GAP_PX, ROWS_MIN, ROWS_MAX, SPAN_MIN,
} from './page.js';

// pane records keyed by mount id: { wrapper, host, root, pane_state, title, paneTarget, theme, themeStyle, spec }
export const panes = new Map();

// A pane may only ever land in a SLOT. `target` arrives from /api/render, which
// accepts any string for it, so resolving it with getElementById made every
// chrome element a mountable container: `target:'topbar'` filed a pane inside
// the header, and `target:'overlay'` hid one inside the (display:none) graph
// viewer — which is exactly how the service-trust prompt shipped invisible in
// 0.6.0. There is one slot today; anything that is not a slot falls back to it,
// matching the server's own `target = 'main'` default.
const SLOTS = new Set(['main']);
const slotFor = (target) => $(SLOTS.has(target) ? target : 'main');

// A mount id is agent-supplied too, and 'main' / 'status' / 'overlay' are all
// plausible ids for Claude to pick. Everything this module resolves from an id
// goes through hostFor/dropOrphanDom, which only ever see mount HOSTS: resolving
// an id against the whole document removed chrome, and because the mount persists
// in state.mounts and in every committed node, `hello` replayed the removal on
// every reload — the surface stayed dead until the mount was cleared from outside
// the browser.
//
// hostFor lives beside `$` in state.js: comment pins resolve a stored anchor's
// mount id back to its host too, and one home keeps the write side (mount()'s
// dataset) and every read side in agreement.

// Remove everything in the DOM that belongs to `id` but that no pane record owns:
// a bare mount host from an older session, and the half-built wrapper left by a
// mount that threw (the wrapper is appended before the shadow root is attached,
// so a failure used to leave an empty .pane behind and a re-render then stacked a
// second one on top of it). Only ever mount DOM — never an arbitrary element that
// happens to answer to the id.
function dropOrphanDom(id) {
  if (id == null) return;
  const host = hostFor(id);
  if (host) (host.closest('.pane') || host).remove();
  for (const w of document.querySelectorAll('.pane')) {
    if (w.dataset.paneId === id) w.remove();
  }
}

// The pane_state the chrome works on. Keys it does not interpret — `rows`,
// `claude_place` (Claude's baseline, which ↺ and the run's dirty check read) —
// ride along untouched.
function applyPaneStateDefaults(s) {
  s = s || {};
  // Legacy rowSpan → heightPx so old nodes look about right.
  let heightPx = s.heightPx;
  if (heightPx == null && s.rowSpan && s.rowSpan > 1) heightPx = s.rowSpan * 60;
  const pl = placeOf(s);
  return {
    ...s,
    col: pl.col,
    colSpan: s.colSpan || COLS,
    heightPx: heightPx || null,
    pinned: !!s.pinned,
    locked: !!s.locked,
    minimized: !!s.minimized,
    mode: s.mode === 'expanded' ? 'expanded' : 'reduced',
  };
}

const emitTimers = new Map();
function emitPaneState(id) {
  if (view.previewing) return;
  const p = panes.get(id);
  if (!p) return;
  if (emitTimers.has(id)) clearTimeout(emitTimers.get(id));
  emitTimers.set(id, setTimeout(() => {
    emitTimers.delete(id);
    // A COPY: pane_state is merged in place (applyRemotePaneState), and a frame
    // queued while the socket is down must carry what the user did, not whatever
    // the reconnect's snapshot later merges into the live object.
    // claude_place is the daemon's (Claude's baseline) — never echoed back.
    const { claude_place: _baseline, ...ps } = p.pane_state;
    send({ type: 'pane:state', id, pane_state: ps }); // queued if the socket is down
  }, 80));
}

// ── form-state sync ─────────────────────────────────────────────────────────
// Debounce-capture a pane's form-element values (via the shared runtime's
// captureFormState) into the mount record server-side, so typed state survives
// refresh, node navigation, drafts, and exports. Skipped while previewing
// (a preview is read-only) and while a remote apply is in flight (p._applyingForm gates the echo loop).
//
// p._userDirty: the user has edited this pane since the server last got its
// values. It is set in emitFormState and nowhere else — its only callers are
// the pane's input/change listeners, and its _applyingForm gate keeps a
// rehydrate's dispatched events out — and cleared once a frame is actually on
// the wire.
// flushFormStates() sends only these panes. A value a pane's SCRIPT assigns after
// mount (a store subscriber, an awaited fetch) fires no input event, so it never
// moves the _lastFormJson baseline: the reconcile's flush used to compare the
// live DOM against that baseline and publish the script's fill as if the user had
// typed it, and the surface read as changed (a spurious preserve node on Set
// active, a chat-only turn committing).
const formTimers = new Map();
const FORM_DEBOUNCE_MS = 350;
function emitFormState(id) {
  const p = panes.get(id);
  if (!p || p._applyingForm || view.previewing) return;
  p._userDirty = true;
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
  // Unchanged — don't chat. Nothing the user did is pending either: the server
  // already has what the pane shows, so the flag goes with it.
  if (json === p._lastFormJson) { p._userDirty = false; return; }
  p.form_state = fs;
  p.spec.form_state = fs;
  // Stamp the "server has this" marker ONLY once the frame is actually on the
  // wire. Stamping before the gate recorded a value the server never received,
  // so a form edit made while the socket was down was silently dropped and never
  // re-sent on reconnect — the reconcile's flush would see it as already known.
  // Returning here rather than letting ws.send queue the frame is deliberate:
  // the reconcile calls flushFormStates(), which re-reads the LIVE DOM, and that
  // is fresher than any snapshot we could stash (ws.js drops a queued pane:form
  // for the same reason).
  // _userDirty stays set on this path too, so the reconcile's flush re-sends it.
  if (!isOpen()) return;
  p._lastFormJson = json;
  p._userDirty = false;
  send({ type: 'pane:form', id, form_state: fs });
}
// Immediate flush of the form values the user changed and the server has not
// got — the reconcile's way of re-publishing what was typed while the socket
// was down (or inside the debounce when it dropped). Only user-dirty panes: a
// pane nobody typed in may still show values its own script filled since
// mount, and those are the pane's, not the user's.
function flushFormStates() {
  for (const [id, p] of panes) {
    const t = formTimers.get(id);
    if (t) { clearTimeout(t); formTimers.delete(id); }
    if (p._userDirty) sendFormState(id);
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
  p._userDirty = false;   // the DOM now shows the server's copy
  p._applyingForm = true;
  try { window.__wcMount.applyFormState(p.root, form_state || {}); }
  finally { p._applyingForm = false; }
}

// A pane's place on its run's grid (public/page.css): three custom properties,
// never an inline grid-column — so the narrow-screen rules can fold a stacked
// run to one column without fighting an inline style. A pane with `rows` is
// exactly that tall; one sized in pixels before rows existed keeps a min-height,
// as it always had.
export function applyPaneState(wrapper, pane_state) {
  const pl = placeOf(pane_state);
  const span = pl.col != null ? Math.min(pl.span, COLS - pl.col + 1) : pl.span;
  wrapper.style.setProperty('--col', pl.col != null ? String(pl.col) : 'auto');
  wrapper.style.setProperty('--span', String(span));
  const rows = Number.isFinite(Number(pane_state.rows)) && pane_state.rows != null ? Number(pane_state.rows) : null;
  wrapper.classList.toggle('has-rows', rows != null);
  if (rows != null) wrapper.style.setProperty('--rows', String(rows));
  else wrapper.style.removeProperty('--rows');
  wrapper.style.minHeight = rows == null && pane_state.heightPx ? pane_state.heightPx + 'px' : '';
  wrapper.classList.toggle('minimized', !!pane_state.minimized);
  wrapper.classList.toggle('locked', !!pane_state.locked);
  wrapper.classList.toggle('pinned', !!pane_state.pinned);
  // Under half the grid the header is too short for the type chip, pin and lock
  // (the design draws them only at span ≥ 6); ⋯ reveals pin/lock there. See
  // NARROW_SPAN and the .pane.narrow rules in app.css.
  wrapper.classList.toggle('narrow', (pane_state.colSpan || 12) < NARROW_SPAN);
  wrapper.dataset.mode = pane_state.mode === 'expanded' ? 'expanded' : 'reduced';
  // The pin/lock buttons show the pane's CURRENT state — a lock set in another
  // viewer (pane:state) has to light up here too, not only a local click.
  const pin = wrapper.querySelector('.pane-btn-pin');
  if (pin) pin.classList.toggle('active', !!pane_state.pinned);
  const lock = wrapper.querySelector('.pane-btn-lock');
  if (lock) lock.classList.toggle('lock-active', !!pane_state.locked);
}

// The block header shows the type chip, pin and lock only when the pane spans at
// least half the 12-column grid; narrower, they fold behind a ⋯ toggle.
export const NARROW_SPAN = 6;

// What the header's type chip says: the render's declared `params.type`, else
// the component it was spawned from, else nothing (the chip is hidden).
export function blockType(params, component) {
  const t = params && typeof params.type === 'string' ? params.type.trim() : '';
  if (t) return t;
  return typeof component === 'string' && component ? component : '';
}

// A pane that another pane spawned (owner `pane:<parent>`, lib/server/domain/
// spawn) names its parent on its header. The parent id, or null.
export const PANE_OWNER = 'pane:';
export function spawnParentOf(owner) {
  return typeof owner === 'string' && owner.startsWith(PANE_OWNER) && owner.length > PANE_OWNER.length
    ? owner.slice(PANE_OWNER.length) : null;
}

function makePaneChrome(id, title, pane_state, params, component, owner) {
  const wrapper = document.createElement('div');
  wrapper.className = 'pane';
  wrapper.dataset.paneId = id;

  // The header IS the drag handle (⠿ + mono title), as the design draws it; the
  // buttons on it are excluded in attachDrag.
  const header = document.createElement('div');
  header.className = 'pane-header';

  const drag = document.createElement('span');
  drag.className = 'pane-drag'; drag.textContent = '⠿'; drag.title = 'drag to reorder';
  header.appendChild(drag);

  const titleEl = document.createElement('span');
  titleEl.className = 'pane-title';
  titleEl.textContent = title || id;
  header.appendChild(titleEl);

  // textContent, never innerHTML: params.type is agent-supplied text.
  const type = blockType(params, component);
  if (type) {
    const chip = document.createElement('span');
    chip.className = 'pane-type';
    chip.textContent = type;
    header.appendChild(chip);
  }

  // ↳ parent — who put this pane up. A child outlives its parent (the daemon's
  // rule: no cascade), so the chip says so once the parent is gone rather than
  // leaving an orphan that looks like any other block (syncOwnerChips). A click
  // shows the parent.
  const parent = spawnParentOf(owner);
  if (parent) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'pane-owner';
    chip.dataset.parent = parent;
    chip.addEventListener('click', () => revealPane(parent));
    header.appendChild(chip);
    paintOwnerChip(chip);
  }

  function mkBtn(label, tip, onClick, className = '') {
    const b = document.createElement('button');
    b.className = 'pane-btn' + (className ? ' ' + className : '');
    // The label is a glyph, so the tip is also the pane button's accessible name.
    b.textContent = label; b.title = tip; b.setAttribute('aria-label', tip);
    b.addEventListener('click', onClick);
    return b;
  }
  // Every header control changes the page's LAYOUT. A detached preview is
  // read-only (plan §2b D2) and a phone's layout is fixed (viewport.js), so they
  // are hidden there (app.css) and refuse here — saying why, should a gesture
  // reach one anyway.
  const live = () => {
    if (!layoutLocked()) return true;
    refuseLayoutGesture({ id });
    return false;
  };

  // The pin's meaning, said out loud: it is not decoration, it is what keeps a
  // pane through a surface wipe and an agent-driven clear-all.
  const btnPin = mkBtn('📌', 'pin — survives wipes and re-arrangement', () => {
    if (!live()) return;
    pane_state.pinned = !pane_state.pinned;
    applyPaneState(wrapper, pane_state);
    emitPaneState(id);
  }, 'pane-btn-pin');

  const btnLock = mkBtn('🔒', 'lock — refuse re-renders and moves', () => {
    if (!live()) return;
    pane_state.locked = !pane_state.locked;
    applyPaneState(wrapper, pane_state);
    emitPaneState(id);
  }, 'pane-btn-lock');

  // The block's history: the versions the page has shown on the way to the
  // active node, each previewable, with "Make current" (public/app/pane-history).
  // Viewing only until the user picks a version and says so. aria-controls is the
  // dismiss layer's trigger contract (shell.js ownedPanel): without it the
  // popover would be dismissed out from under this very click.
  const btnHistory = mkBtn('◷', 'history — earlier versions of this block', () => {
    if (!live()) return;
    togglePaneHistory(id, btnHistory);
  }, 'pane-btn-history');
  btnHistory.setAttribute('aria-controls', 'pane-history');
  btnHistory.setAttribute('aria-haspopup', 'dialog');

  // Below NARROW_SPAN history/pin/lock are folded away; ⋯ shows them in the header.
  const btnMore = mkBtn('⋯', 'more — history, pin, lock', () => {
    if (!live()) return;
    wrapper.classList.toggle('more-open');
  }, 'pane-btn-more');

  const btnMin = mkBtn('—', 'minimize', () => {
    if (!live()) return;
    pane_state.minimized = true;
    applyPaneState(wrapper, pane_state);
    layoutPage();
    emitPaneState(id);
  }, 'pane-btn-min');

  const btnClose = mkBtn('×', 'close', async () => {
    // Closing a pane in a preview would clear the LIVE pane of the same id.
    if (!live()) return;
    await fetch('/api/clear', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      // force: the USER closing a pane outranks the clear clobber-guard — a
      // driver-owned pane must still close when they hit ×.
      body: JSON.stringify({ id, force: true }),
    });
  }, 'pane-btn-close');

  header.appendChild(btnHistory);
  header.appendChild(btnPin);
  header.appendChild(btnLock);
  header.appendChild(btnMore);
  header.appendChild(btnMin);
  header.appendChild(btnClose);
  wrapper.appendChild(header);

  // Right edge = columns, bottom edge = height, the corner = both.
  const resizeR = document.createElement('div'); resizeR.className = 'pane-resize-r';
  resizeR.title = 'resize width (snaps to columns)';
  const resizeB = document.createElement('div'); resizeB.className = 'pane-resize-b';
  resizeB.title = 'resize height';
  const resizeRB = document.createElement('div'); resizeRB.className = 'pane-resize-rb';
  resizeRB.title = 'resize';
  wrapper.appendChild(resizeR);
  wrapper.appendChild(resizeB);
  wrapper.appendChild(resizeRB);

  attachResize(wrapper, { r: resizeR, b: resizeB, rb: resizeRB }, id, pane_state);
  attachDrag(wrapper, header, id, pane_state);

  return { wrapper, titleEl };
}

// A locked pane refuses moves as well as re-renders: no drag, no resize (the
// server drops a locked pane's layout changes too, and re-sends the truth). A
// detached preview refuses them as well, and so does a phone — layoutLocked().
export function refusesLayout(pane_state) {
  return !!(pane_state && pane_state.locked) || layoutLocked();
}

// The run grid a pane sits in, measured: its rect and one column's width. A grid
// that has not been laid out (a hidden tab, jsdom) falls back to a nominal 60px
// column so the arithmetic stays finite.
function gridMetrics(wrapper) {
  const grid = wrapper.parentElement;
  const rect = grid && grid.getBoundingClientRect ? grid.getBoundingClientRect() : { left: 0, top: 0, width: 0 };
  const colW = rect.width > 0 ? (rect.width - GAP_PX * (COLS - 1)) / COLS : 60;
  return { rect, colW };
}
const clampN = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// Edge and corner resize, snapping to the grid the way the design draws it: the
// right edge to whole columns (2 up to the columns left of the pane's start),
// the bottom edge to whole 40px rows (2–24), the corner both. What persists is
// `colSpan` and `rows` (the daemon keeps heightPx = rows × 40 beside it).
function attachResize(wrapper, handles, id, pane_state) {
  function startResize(axis, handle, e) {
    if (e.button != null && e.button !== 0) return;
    e.preventDefault();
    if (refusesLayout(pane_state)) return;
    try { handle.setPointerCapture(e.pointerId); } catch {}
    const pointerId = e.pointerId;
    const startX = e.clientX;
    const startPageY = e.pageY;
    const { colW } = gridMetrics(wrapper);
    const now = placeOf(pane_state);
    const r0 = wrapper.getBoundingClientRect();
    const w0 = r0.width > 0 ? r0.width : now.span * colW + (now.span - 1) * GAP_PX;
    const h0 = r0.height > 0 ? r0.height : (now.rows ? now.rows * ROW_PX + (now.rows - 1) * GAP_PX : 0);
    const maxSpan = now.col != null ? COLS - now.col + 1 : COLS;

    let lastClientY = e.clientY;
    let lastPageY = e.pageY;
    let scrollRaf = null;

    function applyY() {
      const dy = lastPageY - startPageY;
      const rows = clampN(Math.round((h0 + dy + GAP_PX) / (ROW_PX + GAP_PX)), ROWS_MIN, ROWS_MAX);
      if (rows !== pane_state.rows) {
        pane_state.rows = rows;
        pane_state.heightPx = rows * ROW_PX;
        applyPaneState(wrapper, pane_state);
      }
    }
    function applyX(ev) {
      const dx = ev.clientX - startX;
      const span = clampN(Math.round((w0 + dx + GAP_PX) / (colW + GAP_PX)), SPAN_MIN, maxSpan);
      if (span !== pane_state.colSpan) {
        pane_state.colSpan = span;
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
      if (axis !== 'y') applyX(ev);
      if (axis !== 'x') { applyY(); ensureAutoScroll(); }
    }
    function up(ev) {
      if (ev.pointerId !== pointerId) return;
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', up);
      handle.removeEventListener('pointercancel', up);
      try { handle.releasePointerCapture(pointerId); } catch {}
      if (scrollRaf) { cancelAnimationFrame(scrollRaf); scrollRaf = null; }
      emitPaneState(id);
      layoutPage();   // the run may now be off Claude's layout (↺)
    }
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
    handle.addEventListener('pointercancel', up);
  }
  handles.r.addEventListener('pointerdown', (e) => startResize('x', handles.r, e));
  handles.b.addEventListener('pointerdown', (e) => startResize('y', handles.b, e));
  handles.rb.addEventListener('pointerdown', (e) => startResize('xy', handles.rb, e));
}

// Drag a block by its header WITHIN its run (the design's grid mechanics): the
// start column follows the pointer, snapped to the grid; hovering another block
// of the same run takes its place in the run's order (CSS `order`, so nothing is
// re-parented mid-drag); on drop the run is normalised to READING order — top to
// bottom, left to right, as it actually rendered — which is also the order it
// stacks in on a narrow screen. The column persists through pane:state, the
// order through the daemon's user move (page.commitRunOrder). A block never
// leaves its run: runs are cut by the markdown between them, which is Claude's.
export function readingOrder(ids, rectOf) {
  const at = new Map(ids.map((id, i) => [id, i]));
  return ids.slice().sort((a, b) => {
    const ra = rectOf(a), rb = rectOf(b);
    return (Math.round(ra.top / 10) - Math.round(rb.top / 10)) || (ra.left - rb.left) || (at.get(a) - at.get(b));
  });
}

function attachDrag(wrapper, handle, id, pane_state) {
  handle.addEventListener('pointerdown', (e) => {
    if (e.button != null && e.button !== 0) return;
    // The header's own buttons are clicks, not drags.
    if (e.target && e.target.closest && e.target.closest('button')) return;
    if (refusesLayout(pane_state)) return;
    const run = runOf(id);
    if (!run) return;
    e.preventDefault();
    try { handle.setPointerCapture(e.pointerId); } catch {}
    const pointerId = e.pointerId;

    const startRect = wrapper.getBoundingClientRect();
    const offX = e.clientX - startRect.left;
    const offY = e.clientY - startRect.top;
    const colBefore = pane_state.col;
    const seq = run.panes.slice();

    const ghost = document.createElement('div');
    ghost.className = 'pane-ghost';
    ghost.style.width = startRect.width + 'px';
    ghost.style.height = startRect.height + 'px';
    ghost.style.left = startRect.left + 'px';
    ghost.style.top = startRect.top + 'px';
    document.body.appendChild(ghost);
    wrapper.classList.add('pane-dragging');

    const wrapperOf = (pid) => { const p = panes.get(pid); return p && p.wrapper; };
    const restyleOrder = () => seq.forEach((pid, i) => { const w = wrapperOf(pid); if (w) w.style.order = String(i); });

    function onMove(ev) {
      if (ev.pointerId !== pointerId) return;
      ghost.style.left = (ev.clientX - offX) + 'px';
      ghost.style.top = (ev.clientY - offY) + 'px';
      const { rect, colW } = gridMetrics(wrapper);
      if (rect.width > 0) {
        const span = placeOf(pane_state).span;
        const col = clampN(Math.round((ev.clientX - offX - rect.left) / (colW + GAP_PX)) + 1, 1, COLS - span + 1);
        if (col !== pane_state.col) { pane_state.col = col; applyPaneState(wrapper, pane_state); }
      }
      // splice by hover: the block under the pointer gives up its slot
      const i = seq.indexOf(id);
      for (let j = 0; j < seq.length; j++) {
        if (seq[j] === id) continue;
        const p = panes.get(seq[j]);
        if (!p || p.pane_state.minimized) continue;
        const r = p.wrapper.getBoundingClientRect();
        if (ev.clientX >= r.left && ev.clientX <= r.right && ev.clientY >= r.top && ev.clientY <= r.bottom && r.width > 0) {
          if (j !== i) { seq.splice(i, 1); seq.splice(j, 0, id); restyleOrder(); }
          break;
        }
      }
    }
    function onUp(ev) {
      if (ev.pointerId !== pointerId) return;
      handle.removeEventListener('pointermove', onMove);
      handle.removeEventListener('pointerup', onUp);
      handle.removeEventListener('pointercancel', onUp);
      try { handle.releasePointerCapture(pointerId); } catch {}
      ghost.remove();
      wrapper.classList.remove('pane-dragging');
      // Reading order over the VISIBLE blocks, dealt back into their slots; a
      // minimized block keeps its place in the sequence.
      const visible = seq.filter((pid) => { const p = panes.get(pid); return p && !p.pane_state.minimized; });
      const sorted = readingOrder(visible, (pid) => wrapperOf(pid).getBoundingClientRect());
      let k = 0;
      const next = seq.map((pid) => (visible.includes(pid) ? sorted[k++] : pid));
      if (pane_state.col !== colBefore) emitPaneState(id);
      commitRunOrder(run.anchor, next);
      layoutPage();
    }
    handle.addEventListener('pointermove', onMove);
    handle.addEventListener('pointerup', onUp);
    handle.addEventListener('pointercancel', onUp);
  });
}

// A mount that throws must not leave a half-built pane behind — mount() has the
// wrapper in the DOM before attachAndExtract can fail — so the failure is unwound
// here and the throw is re-raised for the caller (mountAll isolates it).
export function mount(m) {
  try { mountPane(m); }
  catch (e) {
    const id = m && m.id;
    panes.delete(id);
    dropOrphanDom(id);
    layoutPage();
    throw e;
  }
}

// A pane script's surface API (panes spawning panes), bound to its mount id:
// `api.spawn(spec)` puts up a child pane this pane owns, `api.close(id)` takes
// down one of its children — or the pane itself. `parent` is stamped from the
// same closure-bound id the per-pane store facade stamps, and AFTER the caller's
// spec, so a script cannot re-aim it; who may do what (ownership, the lock, the
// caps) is the daemon's call (lib/server/domain/spawn). Both verbs resolve to the
// daemon's JSON envelope and never throw. A preview is read-only (D2), so there
// they answer without writing.
function paneApiFor(id) {
  const call = async (path, body) => {
    if (view.previewing) {
      return { ok: false, previewing: true, hint: 'the surface is showing a preview; panes cannot spawn or close panes here' };
    }
    try {
      const r = await fetch(path, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      return await r.json();
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  };
  return {
    spawn: (spec) => call('/api/pane/spawn', { ...(spec || {}), parent: id }),
    close: (childId) => call('/api/pane/close', { id: childId, parent: id }),
  };
}

function mountPane(m) {
  const { html, target, id, params, pane_state, form_state, theme } = m;
  const slot = slotFor(target);
  const existing = panes.get(id);
  if (existing) {
    if (existing.wrapper.parentElement) existing.wrapper.parentElement.removeChild(existing.wrapper);
    panes.delete(id);
  } else {
    // Whatever this id left in the DOM without a pane record — a bare mount host
    // from an older session, a wrapper a failed mount left behind — and never
    // anything else that happens to answer to this id.
    dropOrphanDom(id);
  }

  const ps = applyPaneStateDefaults(pane_state);
  const titleFromParams = params && params.title;
  const { wrapper, titleEl } = makePaneChrome(id, titleFromParams || id, ps, params, m.component, m.owner);

  const host = document.createElement('div');
  // The mount id is agent-supplied, and the shell resolves its OWN chrome live
  // ($ in state.js is document.getElementById): a host that claimed an id the
  // chrome already owns would win every later lookup of it — the contents nav's
  // $('contents-nav'), the drawer's open/close, the queue rail, the palette — and,
  // because the mount replays on every hello, would keep winning. The id always
  // lives in the dataset; it is mirrored onto the DOM id only when it is free.
  host.dataset.mountId = id;
  if (!document.getElementById(id)) host.id = id;
  host.className = 'mount-host';
  wrapper.appendChild(host);

  applyPaneState(wrapper, ps);
  slot.appendChild(wrapper);

  // The record goes in BEFORE the content attaches, so the page puts the wrapper
  // in its run first: content attached and THEN moved would load an <iframe> in
  // it twice.
  const rec = {
    wrapper, host, root: null, pane_state: ps, form_state: form_state || null,
    title: titleFromParams || id, paneTarget: target || 'main',
    theme: theme || null,
    owner: m.owner || null,
    spec: { id, html, target: target || 'main', params: params || {}, component: m.component, owner: m.owner || undefined, pane_state: ps, form_state: form_state || undefined, theme: theme || undefined },
  };
  panes.set(id, rec);
  layoutPage();

  const { root, scripts } = window.__wcMount.attachAndExtract(host, html);
  rec.root = root;
  guardReadonly(root, host, id);

  // markGesture: a REAL user interaction in this pane (synthetic rehydrate
  // events are gated out in reportEvent via _applyingForm, so
  // gesture-stamping lives with the same guard). Store writes that follow a
  // recent gesture are flagged user-driven for the activity layer — a script's
  // init/tick writes carry no gesture and never masquerade as user activity.
  const markGesture = () => {
    const p = panes.get(id);
    if (p && !p._applyingForm) p._lastGestureAt = Date.now();
  };
  root.addEventListener('click', (e) => { markGesture(); reportEvent('click', e, id); });
  root.addEventListener('change', (e) => { markGesture(); reportEvent('change', e, id); emitFormState(id); });
  root.addEventListener('submit', (e) => { markGesture(); reportEvent('submit', e, id); });
  // 'input' is deliberately NOT forwarded to the event ring (per-keystroke
  // noise; 'change' carries the settled value on blur) — it only feeds the
  // debounced form-state sync.
  root.addEventListener('input', () => { markGesture(); emitFormState(id); });
  // A pane's own reduced/expanded control (lib/capture/pane.js wrapModes — the
  // header ⊞/⊟ is gone) asks for a mode; the chrome records it on pane_state so
  // it persists, travels with the node, and reaches other viewers (pane:state).
  root.addEventListener('wc:mode-request', (e) => {
    const mode = e && e.detail && e.detail.mode === 'expanded' ? 'expanded' : 'reduced';
    const p = panes.get(id);
    if (!p || p.pane_state.mode === mode) return;
    p.pane_state.mode = mode;
    applyPaneState(p.wrapper, p.pane_state);
    emitPaneState(id);   // a no-op while previewing: the toggle stays local there
  });

  applyPaneTheme(rec, theme || null, false);

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
    if (view.previewing) return;
    send({
      type: 'script:error', id, script_index: scriptIndex,
      message: String((err && err.message) || err),
      stack: err && err.stack ? String(err.stack).split('\n').slice(0, 3).join('\n') : undefined,
    });
  }, paneApiFor(id));

  // Rehydrate persisted form values AFTER scripts ran, so a restored user draft
  // wins over a script's own initialization; the runtime dispatches input/change
  // for changed fields so reactive pane scripts resync. Gated so those dispatched
  // events don't re-capture and echo the same snapshot straight back.
  const mounted = panes.get(id);
  if (form_state) {
    mounted._applyingForm = true;
    try { window.__wcMount.applyFormState(root, form_state); }
    finally { mounted._applyingForm = false; }
  }
  // The "server has this" baseline is what the pane shows NOW — its rendered
  // defaults, plus any restored values — whether or not a form_state was stored.
  // Left unset for a pane nobody had typed in, the reconcile's flush (every
  // hello: a reload, a reconnect, a phone opening the page) took those defaults
  // for user input and published them, and the surface read as changed: Set
  // active preserved a node holding nothing, a chat-only turn committed. What
  // the pane's script fills in LATER never moves this baseline (no input event);
  // the flush keeps it off the wire by sending only user-dirty panes instead.
  mounted._lastFormJson = JSON.stringify(window.__wcMount.captureFormState(root));

  const hostTitle = host.dataset && host.dataset.paneTitle;
  if (hostTitle && !titleFromParams) {
    titleEl.textContent = hostTitle;
    panes.get(id).title = hostTitle;
  }
  // Re-assert the authoritative pane_state.mode after the bootstrap's wc:mode
  // listener attaches (a remount carries live state; baked html is frozen — and
  // the pane's own toggle may have moved the mode since the html was rendered).
  if (params && params.modes) {
    root.dispatchEvent(new CustomEvent('wc:mode', { detail: { mode: ps.mode } }));
  }
  layoutPage();
}

// Remove a single pane by id (WS 'clear' with an explicit id).
export function removePane(id) {
  const p = panes.get(id);
  if (p) { if (p.wrapper.parentElement) p.wrapper.remove(); panes.delete(id); }
  else dropOrphanDom(id); // a legacy bare host, or a failed mount's leftovers
  layoutPage();
}

// A clear-all (a `clear` frame with no id) SPARES PINNED PANES — pinning means
// "survives a wipe and a re-arrangement", and the server applies the same rule to
// state.mounts, so a client that swept them anyway would put the DOM out of sync
// with the surface it is meant to be showing.
//
// The frame stays authoritative wherever it says anything: `kept` (an explicit
// list of surviving mount ids) is obeyed verbatim, and `force` clears everything
// — matching POST /api/clear's own force escape. With neither, the pinned rule
// applies. A clear BY ID is untouched: naming a pane is a deliberate act.
export function survivesClear(paneState, frame = {}) {
  if (frame.force) return false;
  return !!(paneState && paneState.pinned);
}

export function clearTarget(target, frame = {}) {
  const slot = slotFor(target);
  const kept = Array.isArray(frame.kept) ? new Set(frame.kept) : null;
  slot.querySelectorAll('.pane').forEach(p => {
    const id = p.dataset.paneId;
    const pane = id ? panes.get(id) : null;
    // Membership of a target is the pane's RECORD, not DOM containment: every
    // pane lives in the one slot now, so a targeted clear has to read the target
    // the pane was rendered with or it would sweep the whole surface. NO target
    // still means every pane — the server's filter is `!target || m.target ===
    // target` (POST /api/clear), and a clear-all that spared the panes rendered
    // with some other target would leave them standing after the server dropped
    // them from state.mounts.
    if (target && pane && pane.paneTarget !== target) return;
    const keep = kept ? kept.has(id) : survivesClear(pane && pane.pane_state, frame);
    if (keep) return;
    if (id) panes.delete(id);
    p.remove();
  });
  layoutPage();
}

// Mount a whole frame's worth of mounts, isolating failures. One mount that
// throws must not take the others — or the rest of the frame — with it: a `hello`
// that died partway left the topbar, the queue rail and the version banner
// uninitialised, so a single bad pane read as a dead surface. The failure is
// logged rather than swallowed silently, and a pane script that throws is
// already reported separately (get_events kind:'script-error').
//
// Internal to the engine: everything outside this module reaches the surface
// through applySnapshot (below), mount() or removePane().
function mountAll(mounts) {
  for (const m of (mounts || [])) {
    try { mount(m); }
    catch (e) { console.error('[web-chat] mount failed for', m && m.id, e); }
  }
}

// `page` is the page record the mounts sit in (page.js pageFromFrame: markdown,
// order, run flags), set FIRST so every pane mounts straight into its run.
export function fullReset({ mounts, store: newStore, page: pageRec, updatedAt = null }) {
  for (const [, p] of panes) {
    if (p.wrapper.parentElement) p.wrapper.parentElement.removeChild(p.wrapper);
  }
  panes.clear();
  document.querySelectorAll('.mount-host').forEach(h => h.remove());
  store.replace(newStore);
  setPage(pageRec || pageFromFrame({ mounts }), updatedAt);
  mountAll(mounts);
  layoutPage();
}

/* ── the ONE full-snapshot applier ───────────────────────────────────────────
   Every full surface replacement lands here: the `hello` a (re)connect opens
   with, the `reset` a wipe / node jump / turn-end re-aim broadcasts, the live
   surface restored on leaving a preview.

   It owns the PREVIEW FORK. `previewing` is the flag state.js says gates all
   writes, and `hello` was written without it — so a reconnect during a node
   preview (a laptop waking, a restart, a self-update) re-mounted live panes
   over the previewed node. Every other frame handler in ws.js carried the fork;
   it lives here now, so the next snapshot path cannot be written without it.

   Two modes, because a snapshot arrives for two different reasons:

     authoritative  the SURFACE changed (reset / preview restore).
                    The frame is rendered verbatim — every pane re-mounted — which
                    is what makes a node jump actually show the node. Notably a
                    wipe preserves pinned mounts SERVER-SIDE and sends the
                    survivors, so the client must not filter on top of it.

     reconcile      the surface did NOT change; this client's picture of it may
                    have. Panes absent from the frame are REMOVED (a purely
                    additive hello kept panes the server had cleared), panes whose
                    spec is unchanged keep their live DOM — including everything
                    the user typed while the socket was down — and only
                    pane_state/theme are applied over them.

   The page record (markdown, order, Claude's baseline order, run flags) rides
   the same frame and takes the same path: folded aside with the panes, replaced
   with them, or — reconciling — swapped in before the panes are, so a kept
   pane is re-seated rather than re-mounted.

   Returns which path ran, for tests and for callers that need to know whether
   the DOM moved. */
export function applySnapshot(frame, { mode = 'authoritative' } = {}) {
  const mounts = (frame && frame.mounts) || [];
  const next = (frame && frame.store) || {};
  const pageRec = pageFromFrame(frame || {});
  if (view.previewing) {
    // Detached: the snapshot IS the live surface, folded aside untouched. The
    // DOM belongs to the previewed node until the user leaves the preview.
    view.liveSnapshot = { mounts: mounts.map((m) => ({ ...m })), store: { ...next }, page: pageRec };
    return 'folded';
  }
  if (mode !== 'reconcile') {
    fullReset({ mounts, store: next, page: pageRec });
    return 'replaced';
  }
  setPage(pageRec);
  reconcileSurface(mounts, next);
  return 'reconciled';
}

// Two mount records describe the same pane CONTENT. Anything else — a changed
// title or `modes` in params, a different component, a moved target — re-mounts,
// because those are baked into the pane chrome at mount time.
function sameSpec(spec, m) {
  return spec.html === m.html
    && (spec.target || 'main') === (m.target || 'main')
    && (spec.component || null) === (m.component || null)
    && (spec.owner || null) === (m.owner || null)
    && JSON.stringify(spec.params || {}) === JSON.stringify(m.params || {});
}

// The store half of a reconcile. `replace` is SILENT (see createStore in
// mount-runtime.js) because its only caller re-mounts every pane immediately
// after, which re-subscribes them. A reconcile deliberately does NOT re-mount,
// so the kept panes' live subscriptions have to be told what moved — otherwise a
// reconnect leaves a pane rendering values the store no longer holds.
function syncStore(next) {
  const cur = store.get();
  const same = (a, b) => a === b
    || (!!a && !!b && typeof a === 'object' && typeof b === 'object' && JSON.stringify(a) === JSON.stringify(b));
  const patch = {};
  for (const k of Object.keys(next)) if (!same(cur[k], next[k])) patch[k] = next[k];
  // A key the snapshot does not carry is gone. The store has no delete-and-notify,
  // so it is published as `undefined` — a subscriber sees the removal, and the key
  // lingers valueless in the local map until the next authoritative replace.
  for (const k of Object.keys(cur)) if (!(k in next)) patch[k] = undefined;
  store.replace(next);
  if (Object.keys(patch).length) store.set(patch, { fromServer: true });
}

function reconcileSurface(mounts, next) {
  syncStore(next);
  const wanted = new Set(mounts.map((m) => m.id));
  for (const id of [...panes.keys()]) if (!wanted.has(id)) removePane(id);
  for (const m of mounts) {
    const p = panes.get(m.id);
    if (!p || !sameSpec(p.spec, m)) {
      try { mount(m); }
      catch (e) { console.error('[web-chat] mount failed for', m && m.id, e); }
      continue;
    }
    applyRemotePaneState(m.id, m.pane_state || {});
    if (JSON.stringify(p.spec.theme || null) !== JSON.stringify(m.theme || null)) {
      p.theme = m.theme || null;
      p.spec.theme = m.theme || undefined;
      applyPaneTheme(p, m.theme || null, false);
    }
    // form_state is deliberately NOT applied over a kept pane: the DOM in front
    // of the user is at least as new as the server's copy (a value typed while
    // the socket was down never reached it), so the local values win — and the
    // flush below pushes them up rather than dropping them.
  }
  // mount() lays the page out on its way out — but a frame with ZERO mounts
  // never runs it, which is exactly the first-open case the zero
  // state exists for. Reconcile explicitly once the frame has settled.
  layoutPage();
  // Re-publish what the user typed while the socket was down. Only panes the
  // user edited are sent, and sendFormState is a no-op for one whose values the
  // server already has.
  flushFormStates();
}

// ── pane-spawned panes: the parent chip ────────────────────────────────────
// The chip's text follows the parent: `↳ parent`, or `↳ parent · closed` once the
// parent has left the page (its children stay — lib/server/domain/spawn
// closePane). Re-painted on every layout (page.js layoutPage calls this), since
// a parent can go or come back without its child re-mounting.
function paintOwnerChip(chip) {
  const parent = chip.dataset.parent;
  const gone = !panes.has(parent);
  chip.classList.toggle('orphan', gone);
  chip.textContent = `↳ ${parent}${gone ? ' · closed' : ''}`;
  const tip = gone
    ? `Spawned by block '${parent}', which has been closed. This block stays until you close it (×).`
    : `Spawned by block '${parent}' — show it`;
  chip.title = tip;
  chip.setAttribute('aria-label', tip);
}
export function syncOwnerChips() {
  for (const p of panes.values()) {
    const chip = p.wrapper.querySelector('.pane-owner');
    if (chip) paintOwnerChip(chip);
  }
}
// Jump to a block on the page: restore it if it was minimized (a write, so not
// on a read-only view), bring it into view and flash its outline so the eye
// lands on it. The ⌘K block rows and a spawned pane's parent chip.
export function revealPane(id) {
  const p = panes.get(id);
  if (!p) return false;
  if (!layoutLocked()) unminimize(id);
  const w = p.wrapper;
  if (w.scrollIntoView) w.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  w.classList.remove('pane-flash');
  void w.offsetWidth;            // restart the animation on a repeat jump
  w.classList.add('pane-flash');
  setTimeout(() => w.classList.remove('pane-flash'), 1400);
  return true;
}

// Restore a minimized pane, locally and everywhere.
//
// The drawer spawns into a STABLE slot (`spawn-<name>`), so spawning the same
// component twice replaces the pane in place. If that pane happened to be
// minimized, the re-spawn lands inside a collapsed chip and the click reads as a
// no-op — the user asked for a pane and nothing appeared. Same restore the
// minimized chip does, exported so the spawn path can share it rather than reach
// into pane_state itself.
export function unminimize(id) {
  const p = panes.get(id);
  if (!p || !p.pane_state.minimized) return false;
  p.pane_state.minimized = false;
  applyPaneState(p.wrapper, p.pane_state);
  layoutPage();
  emitPaneState(id);
  return true;
}

// Apply a remote client's pane:state (WS 'pane:state'): merge, re-layout, and
// dispatch wc:mode into the shadow root if the mode changed remotely.
//
// Merged IN PLACE: the header's pin/lock/min/resize/drag closures hold this very
// object (makePaneChrome), so replacing it left them toggling a stale copy — a
// lock set in another viewer never stopped this one's drag, and a pin clicked
// after any remote update sent the old state back.
export function applyRemotePaneState(id, pane_state) {
  const p = panes.get(id);
  if (!p) return;
  const prevMode = p.pane_state.mode;
  Object.assign(p.pane_state, pane_state);
  applyPaneState(p.wrapper, p.pane_state);
  if (p.pane_state.mode !== prevMode && p.root) {
    p.root.dispatchEvent(new CustomEvent('wc:mode', { detail: { mode: p.pane_state.mode } }));
  }
  layoutPage();
}

// ── two gates: content read-only, layout locked ─────────────────────────────
// CONTENT READ-ONLY — a detached preview, and nothing else (plan §2b D2). A
// preview shows a committed node; it is not an editing surface. Its writes were
// always gated (store echo, pane:state, pane:form, events), but an edit in a
// previewed pane used to silently re-aim the graph onto that node
// (branch-on-edit). Now editing needs the node made active on the graph screen,
// and a previewed pane refuses the gesture instead of swallowing it: form
// controls do not take input, toggles do not toggle, submits do not submit, and
// the user is told how to edit. Plain buttons and links still work — a tab
// strip or a capture pane's reduced/expanded switch is viewing, not editing.
//
// LAYOUT LOCKED — a preview OR a phone. It governs everything that arranges the
// page rather than what is in a pane: drag, resize, pin, lock, minimize, close,
// the ⋯ narrow menu, history ◷, ↺ Claude's layout, the stacks chip, adding a
// block. A phone is NOT content read-only (maintainer, 2026-09-27): through the
// tunnel it can be the only way to reach a session, so its panes' content works
// exactly as on the desktop — typing, toggles, submits, declared signals,
// api.spawn, form state, activity routing — and only the layout is fixed.
//
// These two predicates are the gates. (The one phone-only branch beside them is
// drawer.js spawnComponent: a preview adds a block to the LIVE page instead of
// refusing it, so adding a block cannot simply ask layoutLocked().)
//
// The content guards sit in the CAPTURE phase on the shadow root, so they run
// before the pane's own listeners and can stop a submit/toggle from reaching
// its script. They read the predicate at event time — a kept pane re-attached
// by leavePreview is editable again with no remount. Synthetic rehydrate events
// (applyFormState's input/change) are not gestures and are never blocked.
export const contentReadOnly = () => !!view.previewing;
export const layoutLocked = () => contentReadOnly() || isPhone();

// A layout gesture refused: the topbar words the note (a preview's D2 hint, or
// the phone's "larger screen" one).
// `detail` names what was refused ({id} a block, {spawn} a component).
export function refuseLayoutGesture(detail) {
  window.dispatchEvent(new CustomEvent('wc:readonly-attempt', { detail: { ...detail, layout: true } }));
}
const TEXT_ENTRY = 'textarea, select, input:not([type=checkbox]):not([type=radio])'
  + ':not([type=button]):not([type=submit]):not([type=reset]):not([type=image])';
const TOGGLE = 'input[type=checkbox], input[type=radio]';
const SUBMITTER = 'input[type=submit], input[type=image], input[type=reset], form button:not([type=button])';
const matches = (el, sel) => !!(el && el.matches && el.matches(sel));
const editable = (el) => matches(el, TEXT_ENTRY)
  || !!(el && el.closest && el.closest('[contenteditable]:not([contenteditable="false"])'));
// Keys that move focus or dismiss are navigation, not editing.
const NAV_KEYS = new Set(['Tab', 'Escape', 'Shift', 'Control', 'Alt', 'Meta']);

// Faint every form control while the host carries data-wc-readonly. A
// constructable sheet adopted by the shadow root — not a <style> child — so the
// pane's own DOM (child indices, comment-pin anchors, :last-child) is untouched.
let readonlySheet;
function adoptReadonlySheet(root) {
  try {
    if (readonlySheet === undefined) {
      readonlySheet = new CSSStyleSheet();
      readonlySheet.replaceSync(
        ':host([data-wc-readonly]) :is(input, textarea, select, button[type=submit], [contenteditable]:not([contenteditable="false"]))'
        + ' { cursor: not-allowed; opacity: .6; }');
    }
    if (readonlySheet) root.adoptedStyleSheets = [...root.adoptedStyleSheets, readonlySheet];
  } catch { readonlySheet = null; } // no constructable sheets: the guards still hold
}

function refuse(e, id) {
  e.preventDefault();
  e.stopPropagation();
  window.dispatchEvent(new CustomEvent('wc:readonly-attempt', { detail: { id } }));
}

function guardReadonly(root, host, id) {
  host.toggleAttribute('data-wc-readonly', contentReadOnly());
  adoptReadonlySheet(root);
  // mousedown: a text field or select takes focus / opens on press.
  root.addEventListener('mousedown', (e) => {
    if (contentReadOnly() && editable(e.target)) refuse(e, id);
  }, true);
  // keyboard focus still reaches a field (Tab stays navigation); typing does not.
  root.addEventListener('keydown', (e) => {
    if (contentReadOnly() && editable(e.target) && !NAV_KEYS.has(e.key)) refuse(e, id);
  }, true);
  // paste, drop, IME — anything that would change a value.
  root.addEventListener('beforeinput', (e) => { if (contentReadOnly()) refuse(e, id); }, true);
  // a checkbox/radio toggles on click (a label's click is re-dispatched to it);
  // a submitter submits.
  root.addEventListener('click', (e) => {
    if (contentReadOnly() && (matches(e.target, TOGGLE) || matches(e.target, SUBMITTER))) refuse(e, id);
  }, true);
  root.addEventListener('submit', (e) => { if (contentReadOnly()) refuse(e, id); }, true);
}

// Re-mark every mounted pane after a gate flips (topbar previewNode /
// leavePreview, or the phone posture coming or going). A pane mounted while
// read-only is marked at mount time.
export function syncReadonly() {
  const ro = contentReadOnly();
  for (const p of panes.values()) {
    if (p.host) p.host.toggleAttribute('data-wc-readonly', ro);
    // a phone's local peek at a minimized block does not outlive the phone
    if (!isPhone()) p.wrapper.classList.remove('peek');
  }
  // the run controls are layout, so they come and go with the layout gate
  layoutPage();
}
bus.on('viewport', syncReadonly);

function reportEvent(type, e, mountId) {
  if (view.previewing) return;
  // Synthetic events from a form-state rehydrate are not user activity — don't
  // forward them (they'd otherwise enqueue phantom activity items server-side).
  const p = panes.get(mountId);
  if (p && p._applyingForm) return;
  const t = e.target;
  // A password/hidden/file/data-no-persist field's value is NEVER captured —
  // same predicate the form-state capture uses, so the two paths can't drift.
  // Only the value is redacted: the routing layer keys off type/tag/dataset/id
  // (lib/channel/policy domIsMeaningful + activityItem, neither of which reads
  // `value`), so a redacted event still produces its activity item exactly as
  // before — a broken pane script stays observable.
  const payload = {
    type, mountId,
    tag: t?.tagName, id: t?.id || null,
    name: t?.getAttribute?.('name') || null,
    value: window.__wcMount.isValueExcluded(t) ? null : (t?.value ?? null),
    dataset: t?.dataset ? { ...t.dataset } : null,
  };
  send({ type: 'event', payload });   // queued while the socket is down
}
