// A block's HISTORY — the versions of one pane the page has shown on the way to
// the active node, opened from the block header's ◷ (public/app/mounts.js).
//
// It reads ONE route and writes through ONE:
//   GET  /api/mounts/:id/history   the versions, newest first, each naming the
//                                  node that introduced it (label, time, author,
//                                  trigger) — lib/server/domain/lineage;
//   POST /api/mounts/:id/restore   "Make current": that version's content back
//                                  into the live slot — lib/server/domain/mounts
//                                  restoreMount, which owns every refusal.
// Each version is drawn read-only by the daemon's preview document
// (GET /preview/pane/:node/:mount, the same PREVIEW_CSP as every preview) in an
// <iframe> beside the list — hovering a row previews it, a click keeps it.
//
// View-only by default, as the maintainer asked: nothing is written until the
// user picks a version and presses Make current. The button is disabled — with
// the reason said — where the daemon would refuse anyway: the row that is
// already current, a locked block, and a block or version someone other than
// Claude wrote (a driver's or a pane-spawned block; restoring would fight the
// writer that is still running). The daemon stays the authority: a refusal it
// answers with is shown, not swallowed.
//
// The panel is a `.popover`, so shell.js's dismiss layer and its one Escape
// owner close it; opening goes through the `wc:close-popovers` window event (the
// sessions panel's one-way trick — shell.js imports this module's importer).
// Every string from the daemon — a trigger, a label, an owner — is set as text.
import { $ } from './state.js';
import { panes, readOnlyNow, spawnParentOf } from './mounts.js';
import { nodeTime } from './labels.js';
import { effectiveMode } from './theme.js';
import { bus } from './bus.js';

const PANEL = 'pane-history';

let forId = null;       // the block the panel is open for
let versions = [];
let chosen = null;      // the kept row's node_id (a click); hover previews without moving it
let shown = null;       // the node_id the frame shows right now
let seq = 0;            // drops a slow response that lands after a newer open

const isOpen = () => { const p = $(PANEL); return !!p && !p.classList.contains('hidden'); };

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

const enc = encodeURIComponent;
// In the viewer's light/dark (the daemon has no mode of its own), so a version
// reads like the page beside it.
export const previewUrl = (nodeId, mountId, mode = effectiveMode()) =>
  `/preview/pane/${enc(nodeId)}/${enc(mountId)}?mode=${enc(mode)}`;

// A ◑ flip (or a pack change that moves the mode) redraws the version on show.
bus.on('mode', () => {
  const frame = $('ph-frame');
  const v = versionById(shown);
  if (isOpen() && frame && v && v.node_id !== 'live') frame.src = previewUrl(v.node_id, forId);
});

// Why Make current cannot apply to version `v` of the open block — the same
// rules restoreMount applies, said before the click. '' when it can.
export function restoreBlocker(v, rec) {
  if (!v) return 'Pick a version to preview it.';
  if (v.current) return 'This is the version on the page now.';
  if (v.node_id === 'live') return 'The live block is not committed yet.';
  if (!rec) return 'This block is no longer on the page.';
  if (rec.pane_state && rec.pane_state.locked) return 'The block is locked — unlock it to restore a version.';
  const owner = rec.owner || 'claude';
  if (owner !== 'claude') {
    const parent = spawnParentOf(owner);
    return parent
      ? `Block '${parent}' put this block up and still writes it, so it cannot be restored from history.`
      : `'${owner}' writes this block, so it cannot be restored from history.`;
  }
  if ((v.owner || 'claude') !== 'claude') return `'${v.owner}' wrote this version; only a version Claude wrote can be restored.`;
  return '';
}

function versionById(id) { return versions.find((v) => v.node_id === id) || null; }

// Point the frame at one version (or blank it for the uncommitted live row).
function show(nodeId) {
  const frame = $('ph-frame');
  const empty = $('ph-empty');
  if (!frame || shown === nodeId) return;
  shown = nodeId;
  const v = versionById(nodeId);
  const committed = !!v && v.node_id !== 'live';
  frame.hidden = !committed;
  if (empty) {
    empty.hidden = committed;
    empty.textContent = v ? 'The live block, not yet committed — it is what the page shows now.' : 'No version selected.';
  }
  if (committed) frame.src = previewUrl(v.node_id, forId);
  for (const row of document.querySelectorAll('#ph-list .ph-row')) {
    row.classList.toggle('shown', row.dataset.node === nodeId);
  }
}

function renderFoot() {
  const btn = $('ph-restore');
  const note = $('ph-note');
  const v = versionById(chosen);
  const why = restoreBlocker(v, panes.get(forId));
  if (btn) {
    btn.disabled = !!why || readOnlyNow();
    btn.textContent = !v || v.node_id === 'live' ? 'Make current' : v.current ? `${v.label} is current` : `Make ${v.label} current`;
  }
  if (note) { note.textContent = why; note.classList.remove('bad'); }
}

function choose(nodeId) {
  chosen = nodeId;
  for (const row of document.querySelectorAll('#ph-list .ph-row')) {
    const on = row.dataset.node === nodeId;
    row.classList.toggle('chosen', on);
    row.setAttribute('aria-selected', String(on));
  }
  show(nodeId);
  renderFoot();
}

function rowEl(v) {
  const row = el('button', 'ph-row' + (v.current ? ' current' : ''));
  row.type = 'button';
  row.setAttribute('role', 'option');
  row.dataset.node = v.node_id;
  const top = el('div', 'ph-top');
  top.append(el('span', 'ph-label', v.label || v.node_id));
  if (v.current) top.append(el('span', 'ph-badge', 'CURRENT'));
  top.append(el('span', 'ph-sp'));
  const when = v.created_at ? nodeTime(v) : '';
  const who = v.author && v.author !== 'claude' ? v.author : '';
  top.append(el('span', 'ph-when', [who, when].filter(Boolean).join(' · ')));
  row.append(top, el('div', 'ph-trig', v.trigger_summary || '(no trigger)'));
  row.addEventListener('mouseenter', () => show(v.node_id));
  row.addEventListener('focus', () => show(v.node_id));
  row.addEventListener('click', () => choose(v.node_id));
  return row;
}

export function renderHistory(data, error) {
  const list = $('ph-list');
  if (!list) return;
  list.replaceChildren();
  shown = null;
  versions = data && Array.isArray(data.versions) ? data.versions : [];
  if (error) {
    list.append(el('div', 'palette-empty', `Couldn't read this block's history — ${error}.`));
  } else if (!versions.length) {
    list.append(el('div', 'palette-empty', 'No earlier versions: this block has not been committed yet.'));
  }
  for (const v of versions) list.append(rowEl(v));
  const count = $('ph-count');
  if (count) count.textContent = error ? '' : `${versions.length} version${versions.length === 1 ? '' : 's'}`;
  // Open on the current version, the thing on the page — nothing to restore yet.
  const cur = versions.find((v) => v.current) || versions[0] || null;
  choose(cur ? cur.node_id : null);
}

export async function refreshHistory() {
  const mine = ++seq;
  const id = forId;
  let data = null, error = null;
  try {
    const r = await fetch(`/api/mounts/${enc(id)}/history`);
    data = await r.json().catch(() => null);
    if (!r.ok) error = (data && data.error) || `HTTP ${r.status}`;
  } catch (e) { error = (e && e.message) || 'network error'; }
  if (mine !== seq || !isOpen() || forId !== id) return;
  renderHistory(data, error);
}

// Where the panel sits: under the ◷ that opened it, kept inside the window.
function place(p, anchor) {
  const r = anchor && anchor.getBoundingClientRect ? anchor.getBoundingClientRect() : null;
  if (!r || !(r.width || r.height)) { p.style.left = ''; p.style.top = ''; return; }
  const w = p.offsetWidth || 560;
  const vw = window.innerWidth || 1024;
  p.style.left = Math.max(12, Math.min(vw - w - 12, r.right - w)) + 'px';
  p.style.top = (r.bottom + 6) + 'px';
}

export function openPaneHistory(id, anchor) {
  const p = $(PANEL);
  if (!p || readOnlyNow() || !panes.has(id)) return false;
  window.dispatchEvent(new CustomEvent('wc:close-popovers', { detail: { keep: p } }));
  forId = id;
  versions = [];
  chosen = null;
  shown = null;
  const rec = panes.get(id);
  const title = $('ph-title'); if (title) title.textContent = (rec && rec.title) || id;
  const list = $('ph-list'); if (list) list.replaceChildren(el('div', 'palette-empty', 'Loading…'));
  const frame = $('ph-frame'); if (frame) { frame.hidden = true; frame.removeAttribute('src'); }
  const empty = $('ph-empty'); if (empty) { empty.hidden = false; empty.textContent = ''; }
  renderFoot();
  p.classList.remove('hidden');
  place(p, anchor);
  document.querySelectorAll(`[aria-controls="${PANEL}"]`).forEach((c) => c.setAttribute('aria-expanded', 'false'));
  if (anchor) anchor.setAttribute('aria-expanded', 'true');
  refreshHistory();
  return true;
}

export function closePaneHistory() {
  const p = $(PANEL); if (p) p.classList.add('hidden');
  const frame = $('ph-frame'); if (frame) frame.removeAttribute('src');   // unload the preview
  document.querySelectorAll(`[aria-controls="${PANEL}"]`).forEach((c) => c.setAttribute('aria-expanded', 'false'));
  forId = null;
  shown = null;
}

// ◷ on a block: open for it, or — pressed again on the same block — close.
export function togglePaneHistory(id, anchor) {
  if (isOpen() && forId === id) { closePaneHistory(); return false; }
  return openPaneHistory(id, anchor);
}

async function makeCurrent() {
  const id = forId;
  const v = versionById(chosen);
  if (!id || restoreBlocker(v, panes.get(id)) || readOnlyNow()) return null;
  const btn = $('ph-restore'); if (btn) btn.disabled = true;
  let res = null;
  try {
    const r = await fetch(`/api/mounts/${enc(id)}/restore`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ node_id: v.node_id }),
    });
    res = await r.json().catch(() => ({ ok: false, error: `HTTP ${r.status}` }));
  } catch (e) { res = { ok: false, error: (e && e.message) || 'network error' }; }
  if (forId !== id) return res;
  if (res && res.ok) {
    // The daemon's render frame re-mounts the block with the restored content;
    // the panel has done its job.
    closePaneHistory();
    return res;
  }
  renderFoot();
  const note = $('ph-note');
  if (note) { note.textContent = (res && (res.hint || res.error)) || 'The daemon refused the restore.'; note.classList.add('bad'); }
  return res;
}

// `forwardEscapeFrom` (graph-view.js) is injected, the way initReplay gets it,
// so this module does not import the graph viewer. Clicking into the version
// preview moves focus into that same-origin document, and a real Escape is then
// delivered THERE — the window-blur rule deliberately keeps the panel open for
// that move — so without the forwarder Escape never reached the one Escape
// owner and the panel stayed up. It rebinds on every load, so wiring it once
// covers every version the frame is later pointed at.
export function initPaneHistory({ forwardEscapeFrom } = {}) {
  const frame = $('ph-frame'); if (frame && forwardEscapeFrom) forwardEscapeFrom(frame);
  const btn = $('ph-restore'); if (btn) btn.addEventListener('click', makeCurrent);
  const close = $('ph-close'); if (close) close.addEventListener('click', closePaneHistory);
  // Leaving the list puts the frame back on the kept version.
  const list = $('ph-list'); if (list) list.addEventListener('mouseleave', () => { if (chosen) show(chosen); });
}
