// Topbar: the node label, the one status pill, node navigation (↑/↓), the
// detached read-only preview (local to this browser, never broadcast), and the
// bookmark / export / wipe actions. Owns the view-state transitions
// (applyActive/applyLock/updateChip) every other module reads.
import { view, $ } from './state.js';
import { store } from './store.js';
import { nodeById, labelFor } from './labels.js';
import { fullReset, applySnapshot, panes, syncReadonly } from './mounts.js';
import { applyNodeTheme, getActiveNodeTheme, toggleMode } from './theme.js';
import { openOverlay, isOverlayOpen, layoutAndRender, updateSidebarButtons, displayChildrenOf, displayParentOf } from './graph-view.js';
import { isPhone } from './viewport.js';
import { page, clonePage, pageFromFrame, syncPageMeta } from './page.js';

// The topbar's ONE status pill, in precedence order: the socket when it is not
// live (a stale node label under a dead socket is worse than none), then the
// gold "viewing nX" of a detached preview, then the turn lock — a 'wake' lock is
// a channel-woken turn (turn-begin-on-push), labelled for what it is so the user
// knows why the graph is briefly held — and otherwise "active nX".
export function pillState() {
  const detached = view.previewing && view.viewedId && view.viewedId !== view.activeId;
  if (view.conn !== 'live') {
    return { cls: 'off', text: view.conn === 'reconnecting' ? 'reconnecting…' : 'connecting…' };
  }
  if (detached) return { cls: 'viewing', text: `viewing ${labelFor(view.viewedId)}` };
  if (view.lock) {
    return view.lock.author === 'wake'
      ? { cls: 'locked channel', text: `channel turn ${labelFor(view.activeId)}` }
      : { cls: 'locked', text: `locked ${labelFor(view.activeId)}` };
  }
  return { cls: '', text: `active ${labelFor(view.activeId)}` };
}

export function updateChip() {
  const detached = view.previewing && view.viewedId && view.viewedId !== view.activeId;
  const nodeLabelEl = $('node-label');
  if (nodeLabelEl) nodeLabelEl.textContent = labelFor(view.viewedId);

  const pill = $('active-pill');
  if (pill) {
    const st = pillState();
    pill.className = 'active-pill' + (st.cls ? ' ' + st.cls : '');
    pill.textContent = st.text;
  }
  const ra = $('btn-return-active'); if (ra) ra.style.display = detached ? '' : 'none';
  // The narrow bottom bar carries the same ↩ active and ↑/↓ (shell.js wires them
  // to these very buttons); it mirrors their state rather than deciding its own.
  const bbReturn = $('bb-return'); if (bbReturn) bbReturn.style.display = detached ? '' : 'none';

  const cur = nodeById(view.viewedId);
  // ↑/↓ step to the previous/next turn the graph DRAWS — the same pair
  // ArrowUp/ArrowDown performs in the overlay, and they used to disagree with
  // it, navigating to nodes the DAG will not draw. (The surface's old ▾ branch
  // picker is gone: choosing among forks, and making a node active, happen on
  // the graph screen — ⑃ Branch / Set active.)
  const drawnKids = displayChildrenOf(view.viewedId);
  const drawnParent = displayParentOf(view.viewedId);
  const btnUp = $('btn-up'); if (btnUp) btnUp.disabled = !(cur && drawnParent);
  const btnDown = $('btn-down'); if (btnDown) btnDown.disabled = drawnKids.length === 0;
  const bbUp = $('bb-up'); if (bbUp) bbUp.disabled = !(cur && drawnParent);
  const bbDown = $('bb-down'); if (bbDown) bbDown.disabled = drawnKids.length === 0;

  const bm = $('bookmark-name');
  if (bm && document.activeElement !== bm) bm.value = (cur && cur.name) || '';
  // the page's title slot and its H1 meta line name the node shown
  syncPageMeta();
}

export function applyActive(id) {
  view.activeId = id;
  if (!view.previewing) view.viewedId = id;
  updateChip();
}
export function applyLock(l) {
  view.lock = l;
  const tb = $('topbar'); if (tb) tb.classList.toggle('locked', !!l);
  updateChip();
  if (view.selectedNodeId) updateSidebarButtons();
}

export async function ensureGraph(force) {
  if (view.graphCache && !force) return view.graphCache;
  const r = await fetch('/api/graph');
  view.graphCache = await r.json();
  return view.graphCache;
}
export async function onGraphChanged() {
  await ensureGraph(true);
  updateChip();
  if (isOverlayOpen()) layoutAndRender();
}

// keep the settings dropdown in sync when a named theme is applied (ws 'theme')
export function syncThemeSelect(name) {
  const sel = $('settings-theme');
  if (sel && name) sel.value = name;
}

// --- detached read-only preview ---
export async function previewNode(id) {
  await ensureGraph();
  if (id === view.activeId) return returnToActive();
  const r = await fetch('/api/graph/node/' + id);
  if (!r.ok) return;
  const node = await r.json();
  if (!view.previewing) {
    view.liveSnapshot = {
      mounts: [...panes.values()].map(p => ({ ...p.spec, pane_state: { ...p.pane_state } })),
      store: store.get(),
      page: clonePage(page),
    };
    view.previewing = true;
    $('main').classList.add('preview-readonly');
  }
  view.viewedId = id;
  // The ONE surface replacement that deliberately does NOT go through
  // applySnapshot: `previewing` is already true here, so the applier would fold
  // this node aside as the live surface instead of rendering it. Entering a
  // preview is the act of putting a non-live node ON the DOM.
  fullReset({ mounts: node.mounts || [], store: node.store || {}, page: pageFromFrame(node), updatedAt: node.created_at || null });
  syncReadonly();
  applyNodeTheme(node.theme || null, true);
  updateChip();
}

// ── the preview is read-only (plan §2b D2) ─────────────────────────────────
// A previewed pane refuses edits (mounts.js guardReadonly) and says so here, in
// the same in-page notice a queued re-aim uses. Editing an older node means
// making it active on the graph screen (Set active / ⑃ Branch); the next edit or
// render then commits as its child. This replaced branch-on-edit, which re-aimed
// the graph the moment a previewed form was touched.
export const READONLY_HINT = 'Read-only preview — set this node active in the graph to edit.';
// A phone's pane CONTENT is live; only its layout is fixed (mounts.js
// layoutLocked). A layout gesture that reaches a control there says where to go
// — previewing or not, since setting the node active would not unlock it.
export const LAYOUT_HINT = 'Layout editing is available on a larger screen.';
function onReadonlyAttempt(e) {
  if (e && e.detail && e.detail.layout && isPhone()) showReaimNote(LAYOUT_HINT);
  else if (view.previewing) showReaimNote(READONLY_HINT);
}

/* ---------- leaving preview: ONE owner of the transition ----------
   Three lines — `previewing = false`, drop the snapshot, un-gate #main — were
   hand-copied to EIGHT places (this file x4, graph-view x2, ws.js, shell.js) and
   had already drifted: some copies also moved active/viewed, one restored the
   captured live surface, one flushed the gated form values, and the two in
   graph-view had quietly lost the queued-re-aim branch their siblings carry.
   `previewing` is the flag state.js says GATES all writes, so a copy that drops
   out of step is a preview mutating the live node.

   The core is unconditional — including re-enabling the panes the read-only
   preview marked (syncReadonly) and repainting the chip, which reads the
   `previewing`/`viewedId` this just moved (a caller that forgot it left the
   pill saying "viewing" an older node after a re-aim) — and the real
   variations are named options rather than a switchboard:
     activeId        this client now believes active is here (a set-active that
                     has actually landed) — moves activeId AND viewedId with it.
     restoreSnapshot go back to the live surface captured on the way in:
                     re-render it, re-apply the active node's theme, aim viewed
                     at active. Consumes liveSnapshot before it is dropped.
                     Every user re-aim passes it too (Set active / Branch, Wipe,
                     New graph): the daemon broadcasts the `reset` BEFORE it
                     answers, so the new live surface is already folded in.
   (A third, flushForms, released form values gated during the preview for
   branch-on-edit; the preview is read-only now, so there are none to release.)
   Callers keep their own `body.pending` early return: whether a queued re-aim
   should leave preview AT ALL is the caller's question, not this one's. */
export function leavePreview({ activeId = null, restoreSnapshot = false } = {}) {
  const snap = view.liveSnapshot;
  view.previewing = false;
  view.liveSnapshot = null;
  $('main').classList.remove('preview-readonly');
  syncReadonly();
  if (activeId != null) { view.activeId = activeId; view.viewedId = activeId; }
  if (restoreSnapshot) {
    view.viewedId = view.activeId;
    // previewing is already false above, so this takes the applier's
    // authoritative path — the captured live surface is re-rendered verbatim.
    if (snap) applySnapshot(snap);
    applyNodeTheme(getActiveNodeTheme(), true);
  }
  updateChip();
}

export function returnToActive() {
  if (!view.previewing) { view.viewedId = view.activeId; updateChip(); return; }
  leavePreview({ restoreSnapshot: true });
}

// Export the node AS RENDERED: a detached preview exports that committed node,
// otherwise export the live surface (which may hold uncommitted renders).
export function doExport() {
  const ref = (view.previewing && view.viewedId) ? view.viewedId : 'live';
  const a = document.createElement('a');
  a.href = '/api/export/' + encodeURIComponent(ref);
  a.download = '';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

// The shell's ONE in-page transient notice (the id is historical: it began as
// "your re-aim is queued" — a re-aim during a locked turn is queued, not
// rejected, and applied when the turn ends). Everything that has to tell the
// user something outside a panel says it here, and it goes by itself after 6s.
//
// `action` ({label, run}) adds one button — "Jump to live" on a block added to
// the live page from a preview (drawer.js). A notice with a button is a toast,
// so it must be reachable without a mouse: the note sits in the DOM directly
// after the topbar (the next Tab stop after its controls), is announced politely
// (role=status), and its dismissal is held while the pointer or focus is inside
// it — a timer that pulls the button out from under a keyboard user is a button
// a keyboard user cannot press. Running the action dismisses the note.
export const NOTE_MS = 6000;
export function showReaimNote(text, { action = null } = {}) {
  let el = $('reaim-note');
  if (!el) {
    el = document.createElement('div');
    el.id = 'reaim-note';
    el.className = 'reaim-note';
    el.setAttribute('role', 'status');
    const tb = $('topbar');
    if (tb && tb.parentElement) tb.after(el); else document.body.appendChild(el);
    const hold = () => clearTimeout(showReaimNote._t);
    const release = () => {
      if (!el.isConnected || el.matches(':hover') || el.contains(document.activeElement)) return;
      armNoteDismiss();
    };
    el.addEventListener('mouseenter', hold);
    el.addEventListener('focusin', hold);
    el.addEventListener('mouseleave', release);
    el.addEventListener('focusout', () => setTimeout(release, 0));
  }
  const msg = document.createElement('span');
  msg.className = 'reaim-note-text';
  msg.textContent = text;
  el.replaceChildren(msg);
  if (action && typeof action.run === 'function') {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'reaim-note-action';
    b.textContent = action.label || 'Go';
    b.addEventListener('click', () => { dismissNote(); action.run(); });
    el.appendChild(b);
  }
  armNoteDismiss();
}
function armNoteDismiss() {
  clearTimeout(showReaimNote._t);
  showReaimNote._t = setTimeout(dismissNote, NOTE_MS);
}
function dismissNote() {
  clearTimeout(showReaimNote._t);
  const n = $('reaim-note');
  if (n) n.remove();
}

// Wipe the live surface. The server keeps `active` and sets a pendingBookmark, so
// the next committed node marks this point — `name` labels that bookmark. Empty
// (the user declined to label) still wipes and still bookmarks, unlabelled. The
// label prompt itself is #wipe-panel (shell.js); this is the transport.
export async function doWipe(name) {
  const r = await fetch('/api/graph/wipe', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: (name || '').trim() }),
  });
  const body = await r.json().catch(() => ({}));
  if (body.pending) { showReaimNote("Claude is mid-turn — the surface wipes when the turn ends."); return; }
  // The reset was broadcast before this answer and, while previewing, folded
  // into liveSnapshot: render it (see postSetActive in graph-view.js).
  leavePreview({ restoreSnapshot: true });
}

async function bookmark() {
  const id = view.viewedId || view.activeId;
  if (!id) return;
  const name = (($('bookmark-name') || {}).value || '').trim();
  await fetch('/api/graph/bookmark', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id, name }),
  });
}

export function initTopbar() {
  const on = (id, ev, fn) => { const el = $(id); if (el) el.addEventListener(ev, fn); };

  on('btn-return-active', 'click', returnToActive);
  // A previewed pane refused an edit (mounts.js guardReadonly): say how to edit.
  window.addEventListener('wc:readonly-attempt', onReadonlyAttempt);

  on('btn-up', 'click', async () => {
    await ensureGraph();
    const parentId = displayParentOf(view.viewedId);  // the previous turn as DRAWN — see updateChip
    if (parentId) previewNode(parentId);
  });
  on('btn-down', 'click', async () => {
    await ensureGraph();
    const kids = displayChildrenOf(view.viewedId);   // the next turn as DRAWN — see updateChip
    if (kids.length) previewNode(kids[0].id);
  });
  on('btn-graph', 'click', () => openOverlay());
  on('btn-theme-toggle', 'click', () => { toggleMode(); });

  // bookmark: ⚑ toggles a small popover with the name field + save
  on('btn-bookmark', 'click', (e) => { e.stopPropagation(); togglePopover('bookmark-pop'); });
  on('btn-bookmark-save', 'click', () => { bookmark(); togglePopover('bookmark-pop', false); });
  // Escape closes the popover — its own handler, since F12 moved shell.js's Escape
  // below the editable-field guard (an editable chrome field owns its own Escape).
  on('bookmark-name', 'keydown', (e) => {
    if (e.key === 'Enter') { bookmark(); togglePopover('bookmark-pop', false); }
    else if (e.key === 'Escape') togglePopover('bookmark-pop', false);
  });
}

// generic popover show/hide (also used by shell.js via the export). Any control
// that declares `aria-controls="<id>"` has its aria-expanded kept in sync here, so
// the one show/hide path is also the one place the a11y state is told the truth.
export function togglePopover(id, force) {
  const el = $(id);
  if (!el) return;
  const show = force === undefined ? el.classList.contains('hidden') : force;
  el.classList.toggle('hidden', !show);
  document.querySelectorAll(`[aria-controls="${id}"]`).forEach((c) => c.setAttribute('aria-expanded', String(show)));
}
