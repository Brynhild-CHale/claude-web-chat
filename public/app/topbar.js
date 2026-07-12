// Topbar: the view chip / node label, node navigation (up/down/branch), the
// detached read-only preview (local to this browser, never broadcast), and the
// bookmark / export / wipe actions. Owns the view-state transitions
// (applyActive/applyLock/updateChip) every other module reads.
import { view, $ } from './state.js';
import { store } from './store.js';
import { nodeById, labelFor, childrenOf } from './labels.js';
import { fullReset, panes } from './mounts.js';
import { applyNodeTheme, getActiveNodeTheme, toggleMode } from './theme.js';
import { openOverlay, isOverlayOpen, layoutAndRender, updateSidebarButtons } from './graph-view.js';

export function updateChip() {
  const detached = view.previewing && view.viewedId && view.viewedId !== view.activeId;
  const nodeLabelEl = $('node-label');
  if (nodeLabelEl) nodeLabelEl.textContent = labelFor(view.viewedId);

  const pill = $('active-pill');
  if (pill) {
    if (detached) {
      pill.className = 'active-pill viewing';
      pill.textContent = `viewing ${labelFor(view.viewedId)}`;
    } else {
      pill.className = 'active-pill' + (view.lock ? ' locked' : '');
      pill.textContent = (view.lock ? 'locked ' : 'active ') + labelFor(view.activeId);
    }
  }
  const ra = $('btn-return-active'); if (rah(ra)) ra.style.display = detached ? '' : 'none';
  const sa = $('btn-set-active-here'); if (rah(sa)) sa.style.display = detached ? '' : 'none';

  const cur = nodeById(view.viewedId);
  const kids = childrenOf(view.viewedId);
  const btnUp = $('btn-up'); if (btnUp) btnUp.disabled = !(cur && cur.parent_id);
  const btnDown = $('btn-down'); if (btnDown) btnDown.disabled = kids.length === 0;
  const btnBranch = $('btn-branch'); if (btnBranch) btnBranch.style.display = kids.length > 1 ? '' : 'none';

  const bm = $('bookmark-name');
  if (bm && document.activeElement !== bm) bm.value = (cur && cur.name) || '';
}
const rah = (el) => !!el; // small guard helper

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
    };
    view.previewing = true;
    $('main').classList.add('preview-readonly');
  }
  view.viewedId = id;
  fullReset({ mounts: node.mounts || [], store: node.store || {} });
  applyNodeTheme(node.theme || null, true);
  updateChip();
}

export function returnToActive() {
  if (!view.previewing) { view.viewedId = view.activeId; updateChip(); return; }
  const snap = view.liveSnapshot;
  view.previewing = false;
  view.liveSnapshot = null;
  view.viewedId = view.activeId;
  $('main').classList.remove('preview-readonly');
  if (snap) fullReset({ mounts: snap.mounts, store: snap.store });
  applyNodeTheme(getActiveNodeTheme(), true);
  updateChip();
}

function showBranchPicker(kids, anchor) {
  const existing = $('branch-picker');
  if (existing) existing.remove();
  if (!kids.length) return;
  const pop = document.createElement('div');
  pop.id = 'branch-picker';
  pop.className = 'popover branch-picker';
  const rect = anchor.getBoundingClientRect();
  pop.style.left = rect.left + 'px';
  pop.style.top = (rect.bottom + 4) + 'px';
  pop.style.right = 'auto';
  kids.forEach((k, i) => {
    const b = document.createElement('button');
    b.className = 'menu-item' + (i === 0 ? ' trunk' : '');
    b.textContent = k.label + (i === 0 ? '  (trunk)' : '') + (k.name ? '  · ' + k.name : '');
    b.addEventListener('click', () => { pop.remove(); previewNode(k.id); });
    pop.appendChild(b);
  });
  document.body.appendChild(pop);
  const close = (ev) => {
    if (!pop.contains(ev.target)) { pop.remove(); document.removeEventListener('mousedown', close); }
  };
  setTimeout(() => document.addEventListener('mousedown', close), 0);
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

export async function doWipe() {
  view.previewing = false;
  view.liveSnapshot = null;
  $('main').classList.remove('preview-readonly');
  await fetch('/api/graph/wipe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
}

async function setActiveHere() {
  const target = view.viewedId;
  if (!target) return;
  const r = await fetch('/api/graph/active', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: target }),
  });
  if (!r.ok) { const err = await r.json().catch(() => ({})); alert('failed: ' + (err.error || r.statusText)); return; }
  view.previewing = false;
  view.liveSnapshot = null;
  $('main').classList.remove('preview-readonly');
  view.activeId = target;
  view.viewedId = target;
  const nr = await fetch('/api/graph/node/' + target);
  if (nr.ok) { const node = await nr.json(); fullReset({ mounts: node.mounts || [], store: node.store || {} }); }
  await onGraphChanged();
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
  on('btn-set-active-here', 'click', setActiveHere);

  on('btn-up', 'click', async () => {
    await ensureGraph();
    const cur = nodeById(view.viewedId);
    if (cur && cur.parent_id) previewNode(cur.parent_id);
  });
  on('btn-down', 'click', async () => {
    await ensureGraph();
    const kids = childrenOf(view.viewedId);
    if (kids.length) previewNode(kids[0].id);
  });
  on('btn-branch', 'click', async (e) => {
    await ensureGraph();
    showBranchPicker(childrenOf(view.viewedId), $('btn-branch'));
    e.stopPropagation();
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

// generic popover show/hide (also used by shell.js via the export)
export function togglePopover(id, force) {
  const el = $(id);
  if (!el) return;
  const show = force === undefined ? el.classList.contains('hidden') : force;
  el.classList.toggle('hidden', !show);
}
