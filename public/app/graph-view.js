// --- Graph overlay ---
// Faithful port of the graph overlay from the monolithic public/client.js
// (overlay open/close/keys, node selection + float "glance" preview, the DAG
// layout engine, SVG rendering, and pan&zoom). Behavior is byte-for-byte; the
// overlay is not being redesigned in this step.
//
// Two `view`s used to collide here: the state singleton and the SVG pan/zoom
// transform. The transform is now `camera` ({tx, ty, scale}); the imported
// `view` is the shared state (activeId/viewedId/lock/graphCache/…).
import { view, $, cssVar } from './state.js';
import { seqNum, nodeById, labelFor, childrenOf } from './labels.js';
import { previewNode, ensureGraph, leavePreview, showReaimNote } from './topbar.js';
import { esc } from './esc.js';
import { getLocalJson, setLocalJson } from './storage.js';

const overlayEl = $('overlay');
const svgEl = $('graph-svg');
let camera = { tx: 0, ty: 0, scale: 1 };
let historyScope = 'all';              // 'all' | 'graph' (just the selected node's tree)
const historyFilters = new Set();      // subset of {'marked','forks'} — independent toggles, union

/* ---------- the camera: ONE owner of "change the view transform" ----------
   The +/− buttons went through zoomBy (which also wrote the % readout) while the
   wheel handler set camera.scale itself — so scrolling zoomed the canvas and left
   the badge sitting at 100%. Both now go through setZoom, and every camera change
   ends in applyCamera, which is also the cheap path: panning used to call
   layoutAndRender() on every mousemove, relaying out the whole DAG to move a
   transform that the layout does not depend on. Moving the camera and recomputing
   the layout are now separate operations. */
const ZOOM_MIN = 0.2, ZOOM_MAX = 3;
let rootGEl = null;                    // the <g> layoutAndRender puts every glyph in

function updateZoomReadout() {
  const p = $('gv-zoom-pct');
  if (p) p.textContent = Math.round(camera.scale * 100) + '%';
}
// Push the current camera onto the existing SVG — no layout, no re-render.
function applyCamera() {
  if (rootGEl && rootGEl.isConnected) {
    rootGEl.setAttribute('transform', `translate(${camera.tx},${camera.ty}) scale(${camera.scale})`);
  } else {
    layoutAndRender();
  }
  updateZoomReadout();
}
// `anchor` ({x,y} in SVG client coords) keeps that point fixed while scaling —
// what a wheel zoom wants; the buttons pass none and scale about the origin.
function setZoom(scale, anchor) {
  const next = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, scale));
  if (anchor && camera.scale) {
    camera.tx = anchor.x - (anchor.x - camera.tx) * (next / camera.scale);
    camera.ty = anchor.y - (anchor.y - camera.ty) * (next / camera.scale);
  }
  camera.scale = next;
  applyCamera();
}

/* ---------- per-graph placement on the canvas ----------
   Trees are auto-laid-out left-to-right and their placement was not the user's to
   control; dragging a graph by its heading now nudges the whole tree, auto-layout
   staying the base and the drag being a delta on top of it.

   This lives CLIENT-SIDE, keyed by root node id, on purpose. Where a graph sits on
   one person's canvas is a viewport preference, not graph data: the server's
   .web-chat/ graph is turn history that migrations must keep append-only, a second
   browser (or a second person on the same daemon) has its own viewport and its own
   window size, and a shared position would make one viewer's tidy-up everybody's.
   It also needs no route and no schema bump. Local, not session, storage —
   because "survives a reload" is the whole point; it goes through storage.js,
   which is where the private-window guard lives. */
const POS_KEY = 'wc:gv-graph-pos';
let graphOffsets = null;
function offsets() {
  if (graphOffsets) return graphOffsets;
  graphOffsets = getLocalJson(POS_KEY, {});
  return graphOffsets;
}
function offsetFor(rootId) {
  const o = offsets()[rootId];
  return (Array.isArray(o) && o.length === 2) ? o : [0, 0];
}
// persist:false keeps the drag cheap — one write on mouseup, not one per frame.
function setOffset(rootId, dx, dy, persist = true) {
  const o = offsets();
  const rx = Math.round(dx), ry = Math.round(dy);
  if (!rx && !ry) delete o[rootId]; else o[rootId] = [rx, ry];
  if (persist) setLocalJson(POS_KEY, o);
}

// Open the overlay: refresh the graph, reveal it, and fit the view. Wired to the
// topbar's Graph button by the topbar module (which also closes the drawer);
// exported so that module can drive it without reaching into overlay internals.
export async function openOverlay() {
  await refreshGraph();
  renderHistory();
  updateStatus();
  if (view.selectedNodeId && nodeById(view.selectedNodeId)) renderInspector(view.selectedNodeId);
  else if (view.activeId) selectNode(view.activeId, { noRender: true });
  overlayEl.classList.remove('hidden');
  // Focus management: the overlay covers the surface and owns ↑↓/↵/A/Space, but
  // focus used to stay on whatever opened it — so a keyboard user was driving an
  // element they had left behind. Move focus in (the container is tabindex="-1"),
  // and remember where to hand it back on close.
  returnFocusTo = document.activeElement;
  overlayEl.focus({ preventScroll: true });
  fitView();
}

// Where focus came from when the overlay opened, so closing returns it there.
let returnFocusTo = null;
// The single close path: hide + restore focus. Everything that dismisses the
// overlay (✕, Escape, opening a node, a float-preview action) routes through here
// so focus is never stranded on a display:none subtree.
export function closeOverlay() {
  closeFloatPreview();
  closeNamePanel();   // raised from inside the overlay — it must not outlive it
  overlayEl.classList.add('hidden');
  const back = returnFocusTo;
  returnFocusTo = null;
  if (back && back.isConnected && typeof back.focus === 'function') back.focus({ preventScroll: true });
}

export function isOverlayOpen() { return !overlayEl.classList.contains('hidden'); }

/* The overlay's half of the ONE Escape owner (shell.js handleEscape). Escape used
   to be claimed by two racing document listeners; the order between them was an
   accident of module init order and neither could see the other's state. This
   function is the overlay's layers in precedence order, and it reports whether it
   consumed the key so the shell knows to stop.

     1. the glance / float preview   (raised from inside the overlay)
     2. the rename / bookmark panel  (ditto — must never outlive its parent)
     3. the overlay itself
*/
export function escapeInOverlay() {
  if (floatEl) { closeFloatPreview(); return true; }
  if (isNamePanelOpen()) { closeNamePanel(); return true; }
  if (isOverlayOpen()) { closeOverlay(); return true; }
  return false;
}

/* Same-origin preview iframes swallow the key. The inspector's "surface preview"
   thumbnail and the glance card are both <iframe src="/preview/node/:id">, and
   clicking either moves focus INTO that document — after which a real Escape
   keypress is delivered to the iframe's document and never reaches ours at all
   (document.activeElement reads back as the IFRAME element, and no keydown
   listener on our document fires). That, not the listener race, is why Escape
   looked dead in a real browser: the overlay's own preview is the easiest thing
   on screen to click.

   Both frames are same-origin, so forward the key back to the page that owns the
   layers. This is transport, not a second Escape implementation — the forwarded
   event runs the same one owner. */
function forwardEscapeFrom(frame) {
  const bind = () => {
    let doc = null;
    try { doc = frame.contentDocument; } catch { return; }   // cross-origin: nothing to do
    if (!doc || doc.__wcEscBound) return;
    doc.__wcEscBound = true;
    doc.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
  };
  // Three cheap, idempotent moments — a navigation swaps the child document out
  // from under any single one of them:
  //   now       the document that is already there
  //   load      the one the src navigated to
  //   focus     the moment it matters — focus is entering the frame, and whatever
  //             document is live then is the one about to receive the keystrokes
  if (!frame.__wcEscWired) {
    frame.__wcEscWired = true;
    frame.addEventListener('load', bind);
    frame.addEventListener('focus', bind, true);
  }
  bind();
}

export async function refreshGraph() {
  await ensureGraph(true);
  layoutAndRender();
}

// Keep the inspector's "Set active" action in sync (called on lock changes too).
export function updateSidebarButtons() {
  const btn = $('gv-set-active');
  if (!btn) return;
  const canSet = view.selectedNodeId && view.selectedNodeId !== view.activeId && !view.lock;
  btn.disabled = !canSet;
  btn.textContent = view.lock ? 'locked — turn in progress'
    : (view.selectedNodeId === view.activeId ? 'current node' : 'Set active');
}

// Click a node in the graph → SELECT it (highlight + sidebar). Selection never
// reshapes the graph (a selected node is not a break-out), so clicking inside an
// expanded serpentine no longer splits/collapses the downstream nodes.
// Space = floating preview · double-click = full open · ↑↓←→ = move selection.
export async function selectNode(id, opts = {}) {
  view.selectedNodeId = id;
  await renderInspector(id);
  renderHistory();                    // refresh the selected/active highlight
  if (floatEl) openFloatPreview(id);  // keep the floating peek tracking the selection
  if (!opts.noRender) layoutAndRender();
}

// --- lineage / state helpers ---
function lineageOf(id) {
  const chain = [];
  let cur = nodeById(id), guard = 0;
  while (cur && guard++ < 200) { chain.unshift(cur); cur = cur.parent_id ? nodeById(cur.parent_id) : null; }
  return chain;
}
function isFork(n) {
  if (!n || !n.parent_id) return false;
  const sibs = childrenOf(n.parent_id);
  return sibs.length > 1 && sibs[0] && sibs[0].id !== n.id; // a non-trunk child of a branch point
}
function stateOf(n) {
  if (!n) return { cls: 'root', text: 'NODE' };
  if (n.id === view.activeId) return { cls: 'active', text: 'ACTIVE' };
  if (n.name) return { cls: 'marked', text: '⚑ ' + n.name };
  if (isFork(n)) return { cls: 'fork', text: '⑃ FORK' };
  if (!n.parent_id) return { cls: 'root', text: 'ROOT' };
  return { cls: 'root', text: 'TURN' };
}

// The top-level tree a node belongs to (walk parents to the rootless ancestor).
function rootOf(id) {
  let cur = nodeById(id), guard = 0;
  while (cur && cur.parent_id && guard++ < 500) cur = nodeById(cur.parent_id);
  return cur ? cur.id : null;
}

// --- history list (left column) ---
// Scope ('all' vs the selected node's graph) then the union of active toggle
// filters (marked / forks); no filter active → everything in scope.
// The graph AS DRAWN. Turns that changed nothing are dropped and each survivor's
// parent is rewritten to the nearest survivor, so a run of no-change turns
// closes up instead of stretching the trunk with copies of one surface. The
// server decides what collapses (GET /api/graph -> collapsed / display_parent);
// this is the one place the decision is applied, so every consumer below —
// history list, runs, layout, keyboard nav, counts — agrees on what exists.
// `view.showCollapsed` turns it off and shows the raw commit history.
function displayNodes() {
  const all = view.graphCache?.nodes || [];
  if (view.showCollapsed) return all;
  return all
    .filter((n) => !n.collapsed)
    .map((n) => {
      const dp = n.display_parent === undefined ? n.parent_id : n.display_parent;
      return dp === n.parent_id ? n : { ...n, parent_id: dp };
    });
}

/* ---------- the display topology, built once per graph ----------
   displayNodes() decides what EXISTS; this decides what is connected to what.
   The byId / childMap / per-parent sort / isBreakout block was verbatim in two
   places (computeRuns and computeGraphLayout), and the breakout rule decides
   both which nodes get their own glyph (layout) and which stacks keyboard
   navigation expands and collapses (computeRuns) — so a change to one copy
   silently desynchronised the drawn stacks from the keyboard's idea of them.

   Everything topological reads THIS: runs, layout, keyboard nav, fork
   classification, the breadcrumb, the graph-scope filter and the counts. It is
   rebuilt when — and only when — the graph payload, the show-collapsed toggle or
   the active/viewed node changes, which is what isBreakout depends on; the same
   index therefore serves a whole burst of arrow keys without rewalking.

   labels.js's childrenOf() stays RAW (commit topology) and keeps one consumer:
   topbar's branch picker, which is asking a different question. */
let indexCache = null;
function graphIndex() {
  if (indexCache
    && indexCache.cache === view.graphCache
    && indexCache.showCollapsed === view.showCollapsed
    && indexCache.activeId === view.activeId
    && indexCache.viewedId === view.viewedId) return indexCache.idx;

  const nodes = displayNodes();
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const childMap = new Map();
  for (const n of nodes) {
    const p = n.parent_id;
    if (p == null || !byId.has(p)) continue;
    if (!childMap.has(p)) childMap.set(p, []);
    childMap.get(p).push(n.id);
  }
  const order = (a, b) => (byId.get(a).created_at - byId.get(b).created_at) || (seqNum(a) - seqNum(b));
  for (const arr of childMap.values()) arr.sort(order);
  // A node whose parent is not in the display set is a top-level tree here —
  // the same definition the layout has always used to pick its roots.
  const roots = nodes.filter((n) => n.parent_id == null || !byId.has(n.parent_id)).map((n) => n.id).sort(order);

  // A break-out node (fork, bookmark, active, or viewed) gets its own glyph; a
  // run of consecutive non-break-out trunk nodes collapses into one stack.
  const isBreakout = (id) => {
    const n = byId.get(id);
    if (!n) return false;
    return (childMap.get(id) || []).length > 1 || n.bookmarked || id === view.activeId || id === view.viewedId;
  };
  const childrenOf = (id) => (childMap.get(id) || []).map((cid) => byId.get(cid));
  const parentOf = (id) => {
    const n = byId.get(id);
    return (n && n.parent_id != null && byId.get(n.parent_id)) || null;
  };
  const lineageOf = (id) => {
    const chain = [];
    let cur = byId.get(id), guard = 0;
    while (cur && guard++ < 200) { chain.unshift(cur); cur = parentOf(cur.id); }
    return chain;
  };
  const rootOf = (id) => { const chain = lineageOf(id); return chain.length ? chain[0].id : null; };

  const idx = { nodes, byId, childMap, roots, isBreakout, childrenOf, parentOf, lineageOf, rootOf };
  indexCache = {
    cache: view.graphCache, showCollapsed: view.showCollapsed,
    activeId: view.activeId, viewedId: view.viewedId, idx,
  };
  return idx;
}

// The topbar's ↓ button steps to the next turn the graph DRAWS, which is the
// same gesture ArrowDown performs in the overlay. (Its ⑃ branch picker asks a
// different question and stays on labels.childrenOf's raw commit children.)
export function displayChildrenOf(id) { return graphIndex().childrenOf(id); }

function historyRows() {
  let ns = displayNodes().slice().sort((a, b) => (a.created_at - b.created_at) || (seqNum(a.id) - seqNum(b.id)));
  if (historyScope === 'graph') {
    const root = rootOf(view.selectedNodeId || view.activeId);
    if (root) ns = ns.filter((n) => rootOf(n.id) === root);
  }
  if (historyFilters.size) {
    ns = ns.filter((n) => (historyFilters.has('marked') && n.name) || (historyFilters.has('forks') && isFork(n)));
  }
  return ns;
}
function renderHistory() {
  const list = $('gv-history-list');
  if (!list) return;
  const rows = historyRows();
  const tc = $('gv-turncount'); if (tc) tc.textContent = displayNodes().length;
  // A keyboard selection re-renders this list, which would destroy the focused row
  // and drop focus to <body>. Remember which node had it and hand it back below.
  const focused = document.activeElement;
  const refocusId = focused && focused.classList && focused.classList.contains('gv-row') && list.contains(focused)
    ? focused.dataset.id : null;
  list.innerHTML = '';
  for (const n of rows) {
    const st = stateOf(n);
    const glyph = n.id === view.activeId ? '●' : n.name ? '⚑' : isFork(n) ? '⑃' : '○';
    const row = document.createElement('div');
    row.className = 'gv-row' + (n.id === view.activeId ? ' active' : '') + (n.id === view.selectedNodeId ? ' selected' : '');
    const trig = n.trigger_summary || n.name || '';
    const time = n.created_at ? new Date(n.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
    row.innerHTML =
      `<span class="glyph ${st.cls}">${glyph}</span>` +
      `<span class="main"><span class="lbl">${esc(n.label || n.id)}</span>${trig ? ' <span class="trig">· ' + esc(trig) + '</span>' : ''}</span>` +
      `<span class="time">${time}</span>`;
    // The row is a clickable <div>, so it was invisible to tab and to Enter/Space.
    // Give it button-ish option semantics and the same two actions the mouse gets:
    // Enter/Space selects (single click), ⌘/Ctrl+Enter opens (double click).
    row.tabIndex = 0;
    row.dataset.id = n.id;
    row.setAttribute('role', 'option');
    row.setAttribute('aria-selected', String(n.id === view.selectedNodeId));
    row.addEventListener('click', () => { selectNode(n.id); centerOn(n.id); });
    row.addEventListener('dblclick', () => { openNode(n.id); });
    row.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      e.preventDefault();
      e.stopPropagation(); // don't also fire the overlay-wide ↵/Space handlers
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) openNode(n.id);
      else { selectNode(n.id); centerOn(n.id); }
    });
    list.appendChild(row);
  }
  if (refocusId) {
    const again = [...list.children].find((el) => el.dataset && el.dataset.id === refocusId);
    if (again) again.focus({ preventScroll: true });
  }
}

// The turns this node stands for. Two sources, one list:
//   node.folded    turns that ended with no surface change and committed no node
//                  at all (domain/turns fold-forward) — recorded at commit time
//   n.absorbed     nodes committed BEFORE fold-forward landed that are
//                  byte-identical to their parent; the server marks them
//                  collapsed and names this node as the one they belong to
// Same thing to a reader — a turn that happened and changed nothing — so they
// render as one chronological list. This is where a chat-only turn's trigger
// text survives after its node stops being drawn.
function foldedSection(id, node) {
  const cached = nodeById(id) || {};
  const rows = [];
  for (const a of (cached.absorbed || [])) {
    rows.push({ at: a.created_at || 0, who: a.author || 'claude', label: a.label || a.id, text: a.trigger_summary || '' });
  }
  for (const f of (Array.isArray(node.folded) ? node.folded : [])) {
    rows.push({ at: f.at || 0, who: f.author || 'claude', label: '', text: f.summary || f.message || '' });
  }
  if (!rows.length) return '';
  rows.sort((a, b) => a.at - b.at);
  // folded_count counts turns the MAX_FOLDED cap dropped as well, so it can
  // exceed what we can show. Say so rather than quietly under-reporting.
  const total = (node.folded_count || (node.folded || []).length) + (cached.absorbed_count || 0);
  const aged = total - rows.length;
  const body = rows.map((r) => {
    const when = r.at ? new Date(r.at).toLocaleString() : '';
    const tag = r.label ? `<span class="gv-folded-tag">${esc(r.label)}</span>` : '';
    return `<div class="gv-folded-row" title="${esc(when)}">${tag}<span class="gv-folded-who">${esc(r.who)}</span><span class="gv-folded-text">${esc(r.text || '(no trigger)')}</span></div>`;
  }).join('');
  const note = aged > 0 ? `<div class="muted small">+${aged} older turn${aged === 1 ? '' : 's'} aged out of the record</div>` : '';
  return `<div class="gv-sect">COLLAPSED TURNS · ${total}</div>` +
    `<div class="gv-folded"><div class="muted small">changed nothing on the surface; kept here instead of as nodes</div>${body}${note}</div>`;
}

// --- inspector (right column) ---
async function renderInspector(id) {
  const box = $('gv-inspector');
  if (!box) return;
  let node = null;
  try { node = await fetch('/api/graph/node/' + id).then((r) => r.ok ? r.json() : null); } catch {}
  if (!node) { box.innerHTML = '<div class="gv-empty">Node unavailable.</div>'; return; }
  const st = stateOf(nodeById(id) || node);
  const lineage = lineageOf(id).map((n, i, a) => i === a.length - 1 ? `<b>${esc(n.label || n.id)}</b>` : esc(n.label || n.id)).join(' › ');
  const mounts = node.mounts || [];
  const paneRows = mounts.length
    ? mounts.map((m) => `<div class="gv-pane-row"><span class="pd"></span>${esc((m.params && m.params.title) || m.id)}</div>`).join('')
    : '<div class="muted small">no panes — narrative turn</div>';
  const trigger = node.trigger?.message || node.trigger?.summary || node.trigger_summary || '(no trigger)';
  const committed = node.created_at ? new Date(node.created_at).toLocaleString() : '—';
  const foldedHtml = foldedSection(id, node);

  box.innerHTML =
    `<div class="gv-preview" id="gv-preview"></div>` +
    `<div><span class="gv-insp-label">${esc(node.label || id)}</span><span class="gv-chip-state ${st.cls}">${esc(st.text)}</span></div>` +
    `<div class="gv-lineage">${lineage}</div>` +
    `<div class="gv-meta"><span class="k">AUTHOR</span><span class="v">${esc(node.author || '—')}</span><span class="k">COMMITTED</span><span class="v">${esc(committed)}</span></div>` +
    `<div class="gv-sect">TRIGGER</div><div class="gv-trigger">${esc(trigger)}</div>` +
    `<div class="gv-sect">RENDERED · ${mounts.length} pane${mounts.length === 1 ? '' : 's'}</div><div class="gv-panes">${paneRows}</div>` +
    foldedHtml +
    `<div class="gv-sect" id="gv-diff-sect">DIFF vs parent</div><div class="gv-diff" id="gv-diff"><span class="muted small">…</span></div>` +
    `<div class="gv-actions">` +
      `<button class="gv-act primary" id="gv-set-active" data-act="active">Set active</button>` +
      `<button class="gv-act" data-act="open" title="Open on the surface (↵)">⤢ Open</button>` +
      `<button class="gv-act" data-act="glance" title="Glance preview (Space)" aria-label="Glance preview (Space)">◉</button>` +
      `<button class="gv-act" data-act="bookmark" title="Bookmark (B)" aria-label="Bookmark (B)">⚑</button>` +
      `<button class="gv-act" data-act="export" title="Export (E)" aria-label="Export (E)">↧</button>` +
    `</div>`;

  drawPreview($('gv-preview'), id, mounts.length);
  renderDiff(id, node);
  updateSidebarButtons();
  updateStatus();
}

// The real node surface as a thumbnail: a scaled-down iframe of /preview/node/:id
// (the same self-contained doc the glance uses — panes render off the shared
// mount-runtime). Narrative (no-pane) turns show a placeholder instead of a blank.
const PREVIEW_W = 1160;
function drawPreview(box, id, paneCount) {
  if (!box) return;
  box.innerHTML = '<div class="cap">surface preview</div>';
  if (!paneCount) {
    const ph = document.createElement('div');
    ph.className = 'gv-preview-empty'; ph.textContent = 'no surface — narrative turn';
    box.appendChild(ph);
    return;
  }
  const scale = (box.clientWidth || 294) / PREVIEW_W;
  const fr = document.createElement('iframe');
  fr.className = 'gv-preview-frame';
  fr.setAttribute('scrolling', 'no');
  fr.style.width = PREVIEW_W + 'px';
  fr.style.height = Math.round((box.clientHeight || 120) / scale) + 'px';
  fr.style.transform = 'scale(' + scale + ')';
  fr.src = '/preview/node/' + encodeURIComponent(id);
  forwardEscapeFrom(fr);
  box.insertBefore(fr, box.firstChild);
}

async function renderDiff(id, node) {
  const el = $('gv-diff');
  const sect = $('gv-diff-sect');
  if (!el) return;
  const n = nodeById(id) || node;
  // Diff against the parent shown in the graph. With collapsed turns hidden the
  // drawn parent is display_parent — and since every collapsed node is
  // byte-identical to its own parent, the numbers are the same either way; this
  // only makes the label name the edge the user can actually see.
  const parentId = (!view.showCollapsed && n.display_parent !== undefined && n.display_parent !== null)
    ? n.display_parent : n.parent_id;
  if (!n || !parentId) { if (sect) sect.style.display = 'none'; el.style.display = 'none'; return; }
  const parentLabel = labelFor(parentId);
  if (sect) { sect.style.display = ''; sect.textContent = 'DIFF vs parent ' + parentLabel; }
  el.style.display = '';
  try {
    const d = await fetch(`/api/graph/diff?a=${encodeURIComponent(parentId)}&b=${encodeURIComponent(id)}`).then((r) => r.ok ? r.json() : null);
    const m = (d && d.mounts) || {};
    const add = (m.added || []).length, chg = (m.changed || []).length, rm = (m.removed || []).length;
    el.innerHTML = `<span class="add">+${add} pane${add === 1 ? '' : 's'}</span><span class="chg">~${chg} changed</span><span class="rm">${rm} removed</span>`;
  } catch { el.innerHTML = '<span class="muted small">diff unavailable</span>'; }
}

function updateStatus() {
  const a = $('gv-status-active'); if (a) a.textContent = (view.activeId ? labelFor(view.activeId) + ' active' : '—');
  const c = $('gv-status-counts');
  if (c) {
    const nodes = displayNodes();
    const forks = nodes.filter((n) => isFork(n)).length;
    const marks = nodes.filter((n) => n.name).length;
    c.textContent = `${nodes.length} turns · ${forks} fork${forks === 1 ? '' : 's'} · ${marks} mark${marks === 1 ? '' : 's'}`;
  }
  // The chip only exists when there is something to reveal.
  const n = view.graphCache?.collapsed_count || 0;
  const chip = $('gv-show-collapsed');
  if (chip) {
    chip.classList.toggle('hidden', n === 0);
    chip.classList.toggle('on', !!view.showCollapsed);
    const cn = $('gv-collapsed-n'); if (cn) cn.textContent = n;
  }
  const g = $('gv-graphsel');
  if (g) { const root = lineageOf(view.selectedNodeId || view.activeId)[0]; g.textContent = 'graph ' + (root ? (root.label || root.id).split('.')[0] : '—'); }
}

// open a node fully on the surface (leaves the overlay)
function openNode(id) { view.selectedNodeId = id; previewNode(id); closeOverlay(); }

/* ---------- setting a node active: ONE POST, one failure path ----------
   Three call sites move `active`: the inspector's "Set active" / the A key
   (setActive), the glance card's ◉, and the topbar's "set active here". All
   three carried the same block hand-copied, and the two in THIS file had quietly
   lost the queued-re-aim branch topbar's copy carries — so pressing A during a
   locked turn dropped this client out of preview while the server had only
   QUEUED the move, leaving the surface showing an old node as if it were live.

   All three also reported failure with alert(): a blocking browser dialog that
   looks like nothing else in this chrome and wedges an automated driver — the
   exact thing the naming panel below exists to avoid, argued twelve lines from a
   call to it. The failure now goes to topbar's in-page notice, which is what the
   queued case already used.

   Returns true only when active actually moved. */
async function postSetActive(id, { alsoCloseOverlay = false } = {}) {
  if (!id) return false;
  const r = await fetch('/api/graph/active', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }),
  });
  if (!r.ok) {
    const err = await r.json().catch(() => ({}));
    showReaimNote('Could not set active: ' + (err.error || r.statusText));
    return false;
  }
  const body = await r.json().catch(() => ({}));
  if (body.pending) {
    // Claude is mid-turn: the server queued the re-aim and applies it at
    // turn-end. Stay exactly where we are — the eventual reset frame lands it.
    showReaimNote(`Queued — jumps to ${labelFor(id)} when Claude's turn ends.`);
    return false;
  }
  leavePreview();
  if (alsoCloseOverlay) closeOverlay();
  await refreshGraph();
  return true;
}

// set a node active (commits the next turn there / branches)
async function setActive(id) {
  if (await postSetActive(id)) renderHistory();
}

function exportNode(id) {
  const a = document.createElement('a');
  a.href = '/api/export/' + encodeURIComponent(id); a.download = '';
  document.body.appendChild(a); a.click(); a.remove();
}

/* ---------- naming: the ONE name field, two callers ----------
   A graph's name IS the `name` on its bookmarked ROOT node — that is exactly what
   `new graph` writes (pendingBookmark labels the first committed node). Until now
   only creation could set it, so a graph that was not named at birth read forever
   as the fallback "graph n1" with no affordance anywhere to fix it. The canvas
   heading is now that affordance, and it reuses POST /api/graph/bookmark — the
   same endpoint the ⚑ inspector action uses, and the same one `new graph` ends at.

   Both callers go through #gv-name-panel. `bookmarkNode` used to call the native
   window.prompt(): a blocking browser dialog, unlike every other input in this
   chrome, and one that wedges an automated driver. Never window.prompt. */
const namePanel = () => $('gv-name-panel');
function isNamePanelOpen() { const p = namePanel(); return !!p && !p.classList.contains('hidden'); }
function closeNamePanel() { const p = namePanel(); if (p) p.classList.add('hidden'); }

let nameTargetId = null;
function openNamePanel({ id, title, hint, value }) {
  const p = namePanel();
  if (!p) return;
  nameTargetId = id;
  const t = $('gv-name-title'); if (t) t.textContent = title;
  const h = $('gv-name-hint'); if (h) h.textContent = hint;
  const inp = $('gv-name-input');
  if (inp) inp.value = value || '';
  p.classList.remove('hidden');
  if (inp) setTimeout(() => { if (isNamePanelOpen()) { inp.focus(); inp.select(); } }, 0);
}
async function commitName() {
  const id = nameTargetId;
  const inp = $('gv-name-input');
  const name = ((inp && inp.value) || '').trim();
  closeNamePanel();
  if (!id) return;
  await fetch('/api/graph/bookmark', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, name }),
  });
  await refreshGraph();
  renderHistory();
  if (view.selectedNodeId) renderInspector(view.selectedNodeId);
}

function bookmarkNode(id) {
  const n = nodeById(id);
  openNamePanel({
    id,
    title: 'Bookmark ' + labelFor(id),
    hint: 'Marks this turn so you can find it again. Empty clears the bookmark.',
    value: (n && n.name) || '',
  });
}

// Rename a whole GRAPH: name its root node, which is what the canvas heading shows.
function renameGraph(rootId) {
  const n = nodeById(rootId);
  openNamePanel({
    id: rootId,
    title: 'Rename graph',
    hint: 'A graph is named by its root node — this is the heading shown on the canvas. Empty restores the fallback label.',
    value: (n && n.name) || '',
  });
}

// --- Floating read-only preview: an Arc/Zen-style "glance" — a centered card
// floating over a dimmed/blurred backdrop. A peek only; never touches the live
// surface. Space (or Esc, or clicking the backdrop) closes it.
let floatEl = null;
function openFloatPreview(id) {
  if (!id) return;
  if (!floatEl) {
    floatEl = document.createElement('div');
    floatEl.className = 'glance-backdrop';
    floatEl.innerHTML =
      '<div class="glance-card">' +
        '<div class="glance-titlebar"><span class="glance-title"></span><span class="glance-hint">space to close</span></div>' +
        '<iframe class="glance-frame" title="node preview"></iframe>' +
      '</div>' +
      '<div class="glance-controls">' +
        '<button class="glance-btn" data-act="close" title="close (space)">✕</button>' +
        '<button class="glance-btn" data-act="open" title="open fully on the surface">⤢</button>' +
        '<button class="glance-btn" data-act="active" title="set as active">◉</button>' +
      '</div>';
    document.body.appendChild(floatEl);
    floatEl.addEventListener('mousedown', (e) => { if (e.target === floatEl) closeFloatPreview(); });
    floatEl.querySelector('[data-act="close"]').addEventListener('click', closeFloatPreview);
    floatEl.querySelector('[data-act="open"]').addEventListener('click', () => {
      const nid = floatEl.dataset.nodeId; closeFloatPreview();
      view.selectedNodeId = nid; previewNode(nid); closeOverlay();
    });
    floatEl.querySelector('[data-act="active"]').addEventListener('click', () => {
      postSetActive(floatEl.dataset.nodeId, { alsoCloseOverlay: true });
    });
  }
  floatEl.dataset.nodeId = id;
  floatEl.querySelector('.glance-title').textContent = 'preview ' + labelFor(id);
  const frame = floatEl.querySelector('.glance-frame');
  forwardEscapeFrom(frame);
  const src = '/preview/node/' + id;
  if (frame.getAttribute('src') !== src) frame.setAttribute('src', src);
}
function closeFloatPreview() { if (floatEl) { floatEl.remove(); floatEl = null; } }
// Read by the one Escape owner so it can tell a modal overlay layer is up.
export function hasFloatPreview() { return !!floatEl; }
function toggleFloatPreview() {
  if (floatEl) closeFloatPreview();
  else if (view.selectedNodeId) openFloatPreview(view.selectedNodeId);
}

// Center the viewport on a node's glyph (used by keyboard navigation).
function centerOn(id) {
  const { glyphs } = computeGraphLayout();
  const g = glyphs.find(gg => gg.id === id || (gg.kind === 'stack' && gg.ids.includes(id)));
  if (!g) return;
  const w = svgEl.clientWidth || 800, h = svgEl.clientHeight || 600;
  camera.tx = w / 2 - g.x * camera.scale;
  camera.ty = h / 2 - g.y * camera.scale;
}

// Map each node to the head of its multi-node trunk run (a collapsible stack).
// Run membership is structural (forks/bookmarks/active/viewed split runs) and
// independent of which stacks are currently expanded.
function computeRuns() {
  const map = new Map();
  if (!view.graphCache) return map;
  const { nodes, byId, childMap, isBreakout } = graphIndex();
  for (const n of nodes) {
    const start = !isBreakout(n.id) && (n.parent_id == null || !byId.has(n.parent_id) || isBreakout(n.parent_id));
    if (!start) continue;
    const run = [];
    let cur = n.id;
    while (cur != null && !isBreakout(cur)) {
      run.push(cur);
      const next = (childMap.get(cur) || [])[0];
      cur = (next && !isBreakout(next)) ? next : null;
    }
    if (run.length >= 2) for (const id of run) map.set(id, run[0]);
  }
  return map;
}

// Move the selection node-to-node: ↑ parent, ↓ trunk child, ←→ siblings.
// Leaving an expanded stack collapses it; entering a collapsed stack expands it.
export function moveSelection(dir) {
  if (!view.graphCache) return;
  const cur = nodeById(view.selectedNodeId) || nodeById(view.activeId) || displayNodes()[0];
  if (!cur) return;
  let targetId = null;
  if (dir === 'up') {
    targetId = cur.parent_id;
  } else if (dir === 'down') {
    const kids = childrenOf(cur.id);
    targetId = kids[0] && kids[0].id;
  } else {
    const sibs = cur.parent_id
      ? childrenOf(cur.parent_id)
      : displayNodes().filter(n => n.parent_id == null).sort((a, b) => (a.created_at - b.created_at) || (seqNum(a.id) - seqNum(b.id)));
    const idx = sibs.findIndex(s => s.id === cur.id);
    const next = sibs[idx + (dir === 'right' ? 1 : -1)];
    targetId = next && next.id;
  }
  if (!targetId) return;
  const runs = computeRuns();
  const fromHead = runs.get(view.selectedNodeId);
  const toHead = runs.get(targetId);
  if (fromHead && fromHead !== toHead) view.expandedStacks.delete(fromHead); // left a stack → collapse it
  if (toHead) view.expandedStacks.add(toHead);                               // entered a stack → expand it
  centerOn(targetId);
  selectNode(targetId);
}

// --- Topology-driven layout ---
// The graph reads as collapsed *stacks* of changes. A break-out node (fork,
// bookmark, active, or viewed) gets its own glyph; a maximal run of consecutive
// trunk-linked non-break-out nodes collapses into one stack glyph with a count.
// The trunk descends straight down one column; a branch claims the next free
// column to the right and descends straight; trees lay out left-to-right.
const DX = 130, DY = 66, NODE_R = 16, STACK_W = 40, STACK_H = 30;
// Serpentine layout for long expanded stacks: a boustrophedon of vertical legs.
// Nodes-per-leg is chosen per stack (legConfig) near SERP_TARGET_LEG, within
// [SERP_MIN_LEG, SERP_MAX_LEG], so the leg count is odd and the snake ends down.
const SERP_THRESHOLD = 8, SERP_TARGET_LEG = 6, SERP_MIN_LEG = 4, SERP_MAX_LEG = 9, SDX = 72, SDY = 46;

function computeGraphLayout() {
  const { byId, childMap, roots, isBreakout } = graphIndex();

  const glyphs = [];
  const edges = [];
  // frontier = x of the next free column; branches and new trees allocate here
  // so they always sit to the right of everything placed so far (incl. snakes).
  let frontier = 0;
  const bumpFrontier = (x) => { if (x + DX > frontier) frontier = x + DX; };

  const placeNode = (id, x, y, plain) => {
    const n = byId.get(id);
    const g = {
      kind: 'node', id, label: n.label, x, y,
      bookmarked: !!n.bookmarked, name: n.name || '', plain: !!plain,
      childrenCount: (childMap.get(id) || []).length, trigger: n.trigger_summary || '',
    };
    glyphs.push(g); bumpFrontier(x);
    return g;
  };
  const placeStack = (ids, x, y) => {
    const g = {
      kind: 'stack', ids: ids.slice(), head: ids[0], tail: ids[ids.length - 1],
      headLabel: byId.get(ids[0]).label, tailLabel: byId.get(ids[ids.length - 1]).label,
      count: ids.length, x, y,
    };
    glyphs.push(g); bumpFrontier(x);
    return g;
  };
  // Header shown in place of an expanded stack; click it to re-collapse.
  const placePill = (head, count, x, y) => {
    const g = { kind: 'collapse', head, count, x, y };
    glyphs.push(g); bumpFrontier(x);
    return g;
  };
  const vEdge = (a, b) => edges.push({ ax: a.x, ay: a.y, bx: b.x, by: b.y, elbow: Math.abs(a.x - b.x) > 0.5 });
  const lineEdge = (a, b) => edges.push({ ax: a.x, ay: a.y, bx: b.x, by: b.y, line: true });

  // Choose nodes-per-leg near a target so the leg COUNT is odd → the snake's
  // last leg points down and the trunk can continue straight beneath its exit.
  const legConfig = (N) => {
    let best = null;
    for (let R = SERP_MIN_LEG; R <= SERP_MAX_LEG; R++) {
      const legs = Math.ceil(N / R);
      const score = (legs % 2 === 1 ? 0 : 1000) + Math.abs(R - SERP_TARGET_LEG);
      if (!best || score < best.score) best = { R, legs, score };
    }
    if (best.legs % 2 === 0) {
      for (let R = SERP_MAX_LEG; R >= 2; R--) {
        if (Math.ceil(N / R) % 2 === 1) { best = { R, legs: Math.ceil(N / R) }; break; }
      }
    }
    return best;
  };

  function walk(startId, columnX, startY) {
    let x = columnX, y = startY, prev = null, first = null, pending = [];
    const flush = () => {
      if (!pending.length) return;
      const run = pending; pending = [];
      // single node → plain glyph inline on the trunk
      if (run.length === 1) {
        const g = placeNode(run[0], x, y, true); y += DY;
        if (prev) vEdge(prev, g); prev = g; if (!first) first = g;
        return;
      }
      // collapsed → one stack glyph
      if (!view.expandedStacks.has(run[0])) {
        const g = placeStack(run, x, y); y += DY;
        if (prev) vEdge(prev, g); prev = g; if (!first) first = g;
        return;
      }
      // expanded short run → collapse pill + an inline vertical column
      if (run.length <= SERP_THRESHOLD) {
        const pill = placePill(run[0], run.length, x, y); y += DY;
        if (prev) vEdge(prev, pill); prev = pill; if (!first) first = pill;
        let p = pill;
        for (const id of run) { const g = placeNode(id, x, y, true); y += DY; lineEdge(p, g); p = g; }
        prev = p;
        return;
      }
      // expanded long run → serpentine: a header pill above a boustrophedon of
      // full-height legs joined by rounded U-bends. The trunk then continues
      // straight down from the snake's exit column.
      const { R, legs } = legConfig(run.length);
      const pill = placePill(run[0], run.length, x, y);
      if (prev) vEdge(prev, pill); prev = pill; if (!first) first = pill;
      const topY = y + DY;
      let p = pill, exitX = x, exitY = topY;
      run.forEach((id, i) => {
        const leg = Math.floor(i / R), within = i % R;
        const down = leg % 2 === 0;
        const rowInCol = down ? within : (R - 1 - within);
        const gx = x + leg * SDX, gy = topY + rowInCol * SDY;
        const g = placeNode(id, gx, gy, true);
        if (i === 0) lineEdge(pill, g);
        else if (Math.floor((i - 1) / R) === leg) lineEdge(p, g);
        else edges.push({ ax: p.x, ay: p.y, bx: gx, by: gy, turn: ((leg - 1) % 2 === 0) ? 'bottom' : 'top' });
        p = g; exitX = gx; exitY = gy;
      });
      prev = p;
      x = exitX;            // continuation aligns under the snake's exit node
      y = exitY + DY;
    };

    let cur = startId;
    while (cur != null) {
      const kids = childMap.get(cur) || [];
      if (isBreakout(cur)) {
        flush();
        const g = placeNode(cur, x, y, false); y += DY;
        if (prev) vEdge(prev, g); prev = g; if (!first) first = g;
        for (let i = 1; i < kids.length; i++) {
          const branchHead = walk(kids[i], frontier, y);
          if (branchHead) edges.push({ ax: g.x, ay: g.y, bx: branchHead.x, by: branchHead.y, elbow: true });
        }
        cur = kids[0] || null;
      } else {
        pending.push(cur);
        cur = kids[0] || null;
      }
    }
    flush();
    return first;
  }

  // Each top-level tree is a "graph"; title it above its first glyph so graphs
  // are scannable. Label = the root's bookmark name, falling back to its id.
  const treeTitles = [];
  for (const r of roots) {
    const g0 = glyphs.length, e0 = edges.length;   // this tree's slice of the output
    const first = walk(r, frontier, 0);
    const rn = byId.get(r);
    const tt = (first && rn)
      ? { x: first.x, y: first.y, graphLabel: (rn.label || '').replace(/\.0$/, ''), name: rn.name || '', rootId: r }
      : null;
    if (tt) treeTitles.push(tt);
    // The user's saved placement is a delta ON the auto-layout: shift everything
    // this tree produced. `frontier` was advanced from the unshifted x, so moving
    // one graph never reflows the others.
    const [dx, dy] = offsetFor(r);
    if (dx || dy) {
      for (let i = g0; i < glyphs.length; i++) { glyphs[i].x += dx; glyphs[i].y += dy; }
      for (let i = e0; i < edges.length; i++) {
        const e = edges[i]; e.ax += dx; e.ay += dy; e.bx += dx; e.by += dy;
      }
      if (tt) { tt.x += dx; tt.y += dy; }
    }
  }
  return { glyphs, edges, treeTitles };
}

const SVGNS = 'http://www.w3.org/2000/svg';
function svgEl_(tag, attrs) {
  const el = document.createElementNS(SVGNS, tag);
  for (const k in attrs) el.setAttribute(k, attrs[k]);
  return el;
}

export function layoutAndRender() {
  const { glyphs, edges, treeTitles } = computeGraphLayout();
  svgEl.innerHTML = '';

  // SVG glyph colors are attributes, not CSS, so resolve each theme token against
  // its own original literal via cssVar — unthemed it's pixel-identical; a theme
  // that sets the token recolors the graph too.
  const accent = (fb) => cssVar('--wc-accent', fb);
  const accentDark = (fb) => cssVar('--wc-accent-dark', fb);
  const gold = (fb) => cssVar('--wc-gold', fb);
  const border = (fb) => cssVar('--wc-border', fb);
  const muted = (fb) => cssVar('--wc-muted', fb);
  const mono = (fb) => cssVar('--wc-mono', fb);

  const rootG = svgEl_('g', { transform: `translate(${camera.tx},${camera.ty}) scale(${camera.scale})` });
  rootGEl = rootG;   // applyCamera moves THIS without recomputing the layout
  svgEl.appendChild(rootG);

  // Edges first (under glyphs)
  const edgesG = svgEl_('g', {});
  rootG.appendChild(edgesG);
  for (const e of edges) {
    let d;
    if (e.turn) {
      // rounded U-bend joining two serpentine legs at the shared top/bottom line
      const r = 10, K = 30;
      if (e.turn === 'bottom') {
        d = `M ${e.ax} ${e.ay + r} C ${e.ax} ${e.ay + r + K}, ${e.bx} ${e.by + r + K}, ${e.bx} ${e.by + r}`;
      } else {
        d = `M ${e.ax} ${e.ay - r} C ${e.ax} ${e.ay - r - K}, ${e.bx} ${e.by - r - K}, ${e.bx} ${e.by - r}`;
      }
    } else if (e.line) {
      // generic center-to-center connector (serpentine legs), any direction
      const dx = e.bx - e.ax, dy = e.by - e.ay, len = Math.hypot(dx, dy) || 1;
      const ux = dx / len, uy = dy / len, gap = 11;
      d = `M ${e.ax + ux * gap} ${e.ay + uy * gap} L ${e.bx - ux * gap} ${e.by - uy * gap}`;
    } else if (e.elbow) {
      d = `M ${e.ax} ${e.ay + NODE_R} C ${e.ax} ${e.ay + DY * 0.55}, ${e.bx} ${e.by - DY * 0.55}, ${e.bx} ${e.by - NODE_R}`;
    } else {
      d = `M ${e.ax} ${e.ay + NODE_R} L ${e.bx} ${e.by - NODE_R}`;
    }
    edgesG.appendChild(svgEl_('path', { d, fill: 'none', stroke: muted('#8b949e'), 'stroke-width': '1.5' }));
  }

  // Tree titles (one per top-level graph), above each column. The heading is the
  // graph's handle: click it to rename the graph (it names the root node), drag it
  // to place the graph on the canvas.
  for (const tt of (treeTitles || [])) {
    const grp = svgEl_('g', { class: 'gv-tree-title' });
    grp.dataset.graphRoot = tt.rootId;
    grp.style.cursor = 'grab';
    const caption = (tt.name ? '🔖 ' : '') + (tt.name || ('graph ' + tt.graphLabel));
    // A transparent pad so the heading is a target, not a 12px glyph outline.
    const hitW = Math.max(96, caption.length * 8 + 40);
    grp.appendChild(svgEl_('rect', {
      x: tt.x - hitW / 2, y: tt.y - 48, width: hitW, height: tt.name ? 34 : 20, rx: 10,
      fill: 'transparent', class: 'gv-tt-hit',
    }));
    const hint = svgEl_('title', {});
    hint.textContent = 'Click to rename this graph · drag to move it';
    grp.appendChild(hint);
    const t = svgEl_('text', {
      x: tt.x, y: tt.y - 34, 'text-anchor': 'middle',
      'font-family': mono('ui-monospace, Menlo, monospace'), 'font-size': '12', 'font-weight': '700',
      fill: tt.name ? gold('#9a6700') : muted('#57606a'),
    });
    t.textContent = caption;
    grp.appendChild(t);
    const pencil = svgEl_('text', {
      x: tt.x + hitW / 2 - 10, y: tt.y - 33, 'text-anchor': 'middle', class: 'gv-tt-pencil',
      'font-family': 'ui-sans-serif, system-ui', 'font-size': '11', fill: muted('#8b949e'),
    });
    pencil.textContent = '✎';
    grp.appendChild(pencil);
    if (tt.name) {
      const sub = svgEl_('text', {
        x: tt.x, y: tt.y - 21, 'text-anchor': 'middle',
        'font-family': mono('ui-monospace, Menlo, monospace'), 'font-size': '9', fill: muted('#8b949e'),
      });
      sub.textContent = tt.graphLabel;
      grp.appendChild(sub);
    }
    rootG.appendChild(grp);
  }

  for (const g of glyphs) {
    const grp = svgEl_('g', { class: 'glyph' });
    grp.style.cursor = 'pointer';
    if (g.kind === 'collapse') {
      grp.dataset.stackHead = g.head;
      const w = 50, h = 22;
      grp.appendChild(svgEl_('rect', {
        x: g.x - w / 2, y: g.y - h / 2, width: w, height: h, rx: 11,
        fill: '#eef2f6', stroke: border('#6e7781'), 'stroke-width': '1.3',
      }));
      const t = svgEl_('text', {
        x: g.x, y: g.y + 4, 'text-anchor': 'middle',
        'font-family': mono('ui-monospace, Menlo, monospace'), 'font-size': '11', 'font-weight': '700', fill: muted('#57606a'),
      });
      t.textContent = '⊟ ×' + g.count;
      grp.appendChild(t);
      rootG.appendChild(grp);
      continue;
    }
    if (g.kind === 'stack') {
      grp.dataset.stackHead = g.head;
      // stacked-cards look: two offset shadow rects behind the front rect
      for (let i = 2; i >= 1; i--) {
        grp.appendChild(svgEl_('rect', {
          x: g.x - STACK_W / 2 + i * 3, y: g.y - STACK_H / 2 - i * 3,
          width: STACK_W, height: STACK_H, rx: 6,
          fill: '#fff', stroke: border('#c4ccd4'), 'stroke-width': '1.2',
        }));
      }
      grp.appendChild(svgEl_('rect', {
        x: g.x - STACK_W / 2, y: g.y - STACK_H / 2, width: STACK_W, height: STACK_H, rx: 6,
        fill: '#f6f8fa', stroke: border('#6e7781'), 'stroke-width': '1.4',
      }));
      const count = svgEl_('text', {
        x: g.x, y: g.y + 4, 'text-anchor': 'middle',
        'font-family': mono('ui-monospace, Menlo, monospace'), 'font-size': '12', 'font-weight': '700', fill: '#24292f',
      });
      count.textContent = '×' + g.count;
      grp.appendChild(count);
      const sub = svgEl_('text', {
        x: g.x, y: g.y + STACK_H / 2 + 14, 'text-anchor': 'middle',
        'font-family': mono('ui-monospace, Menlo, monospace'), 'font-size': '9.5', fill: muted('#8c959f'),
      });
      sub.textContent = g.headLabel === g.tailLabel ? g.headLabel : `${g.headLabel}…${g.tailLabel}`;
      grp.appendChild(sub);
    } else {
      grp.dataset.id = g.id;
      const isActive = g.id === view.activeId;
      const isViewed = g.id === view.viewedId && g.id !== view.activeId;
      const isSelected = g.id === view.selectedNodeId;
      const isLocked = view.lock && g.id === view.activeId;
      const r = g.plain ? 9 : NODE_R;

      if (isLocked) {
        const ring = svgEl_('circle', { cx: g.x, cy: g.y, r: r + 6, fill: 'none', stroke: '#bf870080', 'stroke-width': '4' });
        ring.innerHTML = `<animate attributeName="r" values="${r + 6};${r + 12};${r + 6}" dur="1.4s" repeatCount="indefinite"/><animate attributeName="opacity" values="1;0.2;1" dur="1.4s" repeatCount="indefinite"/>`;
        grp.appendChild(ring);
      }
      if (isViewed) {
        grp.appendChild(svgEl_('circle', { cx: g.x, cy: g.y, r: r + 6, fill: 'none', stroke: gold('#d4a72c'), 'stroke-width': '3' }));
      }
      if (isSelected) {
        grp.appendChild(svgEl_('circle', { cx: g.x, cy: g.y, r: r + 9, fill: 'none', stroke: accent('#0969da'), 'stroke-width': '2', 'stroke-dasharray': '3 3' }));
      }

      grp.appendChild(svgEl_('circle', {
        cx: g.x, cy: g.y, r,
        fill: isActive ? accent('#0969da') : (g.bookmarked ? '#fff8e6' : '#ffffff'),
        stroke: isActive ? accentDark('#0550ae') : (g.bookmarked ? gold('#d4a72c') : border('#6e7781')),
        'stroke-width': g.plain ? '1.2' : '1.5',
      }));

      const label = svgEl_('text', {
        x: g.x, y: g.y + r + 14, 'text-anchor': 'middle',
        'font-family': mono('ui-monospace, Menlo, monospace'), 'font-size': '10.5', fill: muted('#444'),
      });
      label.textContent = g.label;
      grp.appendChild(label);

      if (g.bookmarked && g.name) {
        const badge = svgEl_('g', {});
        const padX = 6, bw = Math.min(120, 7 * g.name.length + padX * 2), bx = g.x + r + 6, by = g.y - 9;
        badge.appendChild(svgEl_('rect', { x: bx, y: by, width: bw, height: 18, rx: 9, fill: '#fff8e6', stroke: gold('#d4a72c'), 'stroke-width': '1' }));
        const bt = svgEl_('text', { x: bx + padX, y: by + 13, 'font-family': 'ui-sans-serif, system-ui', 'font-size': '11', fill: gold('#9a6700') });
        bt.textContent = '🔖 ' + g.name;
        badge.appendChild(bt);
        grp.appendChild(badge);
      } else if (!g.plain && g.trigger) {
        const sub = svgEl_('text', {
          x: g.x, y: g.y + r + 26, 'text-anchor': 'middle',
          'font-family': 'ui-sans-serif, system-ui', 'font-size': '9.5', fill: muted('#888'),
        });
        sub.textContent = g.trigger.length > 28 ? g.trigger.slice(0, 26) + '…' : g.trigger;
        grp.appendChild(sub);
      }
    }
    rootG.appendChild(grp);
  }

  const hitGlyph = (target) => {
    let el = target;
    while (el && el !== svgEl && !(el.dataset && (el.dataset.id || el.dataset.stackHead))) el = el.parentNode;
    return (el && el !== svgEl && el.dataset) ? el : null;
  };
  svgEl.onclick = (e) => {
    const el = hitGlyph(e.target);
    if (!el) return;
    if (el.dataset.stackHead) {
      if (view.expandedStacks.has(el.dataset.stackHead)) view.expandedStacks.delete(el.dataset.stackHead);
      else view.expandedStacks.add(el.dataset.stackHead);
      layoutAndRender();
    } else if (el.dataset.id) {
      selectNode(el.dataset.id); // select only — no surface change, no stack split
    }
  };
  // double-click → fully open the node (detached read-only on the main surface)
  svgEl.ondblclick = (e) => {
    const el = hitGlyph(e.target);
    if (el && el.dataset.id) {
      closeFloatPreview();
      view.selectedNodeId = el.dataset.id;
      previewNode(el.dataset.id);
      closeOverlay();
    }
  };
}

// The ONE place that decides where the camera goes to put the whole graph in the
// middle of the viewport. `pickScale` is the only thing its two callers differ
// on: Fit chooses a scale that makes everything visible, the zoom badge resets
// to a true 1:1. Everything else — the bounds, the centring translate, the
// re-render, the badge — is shared, so the two can never drift into centring
// the graph differently.
//
// This does NOT route through setZoom: setZoom preserves an anchor point (what a
// wheel zoom wants) whereas centring deliberately discards the existing pan.
// Both still end at updateZoomReadout, which is the invariant that matters —
// the badge always reflects camera.scale.
function centerGraph(pickScale) {
  const { glyphs } = computeGraphLayout();
  if (!glyphs.length) return;
  const xs = glyphs.map(g => g.x), ys = glyphs.map(g => g.y);
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minY = Math.min(...ys), maxY = Math.max(...ys);
  const w = svgEl.clientWidth || 800, h = svgEl.clientHeight || 600;
  const scale = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, pickScale({
    w, h, contentW: (maxX - minX) + 160, contentH: (maxY - minY) + 160,
  })));
  camera.scale = scale;
  camera.tx = w / 2 - ((minX + maxX) / 2) * scale;
  camera.ty = h / 2 - ((minY + maxY) / 2) * scale;
  layoutAndRender();
  updateZoomReadout();   // centring changes the zoom too — the badge must follow
}

export function fitView() {
  centerGraph(({ w, h, contentW, contentH }) =>
    Math.min(1.4, Math.max(0.35, Math.min(w / contentW, h / contentH))));
}

// Clicking the zoom percentage between − and +: back to a true 1:1, graph
// centred. The readout is the affordance — the number you are being shown is
// also the button that undoes whatever pan and zoom you wandered into.
export function resetView() { centerGraph(() => 1); }

// Wire the overlay-internal controls: fit/close buttons, the document keydown
// handler (Escape/arrows/space, active only while the overlay is open), the
// set-active sidebar button, and the pan&zoom on the canvas wrap. NOT wired here:
// the topbar's Graph button that opens the overlay (it lives in the topbar module
// and calls the exported openOverlay). Called once at bootstrap.
export function initGraph() {
  $('overlay-close').addEventListener('click', closeOverlay);
  $('overlay-fit').addEventListener('click', fitView);
  document.addEventListener('keydown', (e) => {
    // Escape is NOT handled here. It has one owner (shell.js handleEscape), which
    // calls this module's escapeInOverlay() for the overlay's own layers — two
    // document listeners both claiming the key is what made it unpredictable.
    if (e.key === 'Escape') return;
    // graph navigation keys — only while the graph overlay is open and not typing
    if (overlayEl.classList.contains('hidden')) return;
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    if (e.key === 'ArrowUp') { e.preventDefault(); moveSelection('up'); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); moveSelection('down'); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); moveSelection('left'); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); moveSelection('right'); }
    else if (e.key === ' ') { e.preventDefault(); toggleFloatPreview(); }
    else if (e.key === 'Enter') { e.preventDefault(); if (view.selectedNodeId) openNode(view.selectedNodeId); }
    else if (e.key === 'a' || e.key === 'A') { e.preventDefault(); if (view.selectedNodeId) setActive(view.selectedNodeId); }
    else if (e.key === 'e' || e.key === 'E') { e.preventDefault(); if (view.selectedNodeId) exportNode(view.selectedNodeId); }
    else if (e.key === 'b' || e.key === 'B') { e.preventDefault(); if (view.selectedNodeId) bookmarkNode(view.selectedNodeId); }
  });

  // inspector action footer (delegated — footer is re-rendered per selection)
  $('gv-inspector').addEventListener('click', (e) => {
    const b = e.target.closest('[data-act]'); if (!b) return;
    const id = view.selectedNodeId; if (!id) return;
    ({ active: () => setActive(id), open: () => openNode(id), glance: () => toggleFloatPreview(),
       bookmark: () => bookmarkNode(id), export: () => exportNode(id) })[b.dataset.act]?.();
  });

  // scope toggle (All ⟷ This graph) — mutually exclusive segment
  $('gv-scope').addEventListener('click', (e) => {
    const b = e.target.closest('[data-scope]'); if (!b) return;
    historyScope = b.dataset.scope;
    [...$('gv-scope').children].forEach((x) => x.classList.toggle('on', x === b));
    renderHistory();
  });
  // Show/hide the collapsed no-change turns. Not a history filter — it changes
  // what the whole view considers to exist — so it redraws rather than just
  // re-listing.
  const collapsedChip = $('gv-show-collapsed');
  if (collapsedChip) collapsedChip.addEventListener('click', () => {
    view.showCollapsed = !view.showCollapsed;
    collapsedChip.classList.toggle('on', view.showCollapsed);
    layoutAndRender();
    renderHistory();
    updateStatus();
  });
  // marked / forks — independent toggle filters (one, both, or neither)
  $('gv-filters').addEventListener('click', (e) => {
    const c = e.target.closest('[data-filter]'); if (!c) return;
    const f = c.dataset.filter;
    if (historyFilters.has(f)) historyFilters.delete(f); else historyFilters.add(f);
    c.classList.toggle('on');
    renderHistory();
  });

  // jump box: filter the history list by label / trigger text
  $('gv-jump').addEventListener('input', (e) => {
    const q = e.target.value.toLowerCase().trim();
    for (const row of $('gv-history-list').children) {
      const txt = row.textContent.toLowerCase();
      row.style.display = !q || txt.includes(q) ? '' : 'none';
    }
  });

  // Graph / Log mode toggle
  $('gv-mode').addEventListener('click', (e) => {
    const b = e.target.closest('[data-mode]'); if (!b) return;
    [...$('gv-mode').children].forEach((x) => x.classList.toggle('on', x === b));
    overlayEl.classList.toggle('log-mode', b.dataset.mode === 'log');
  });

  // the one name field (graph rename + node bookmark) — see openNamePanel
  const onEl = (id, ev, fn) => { const el = $(id); if (el) el.addEventListener(ev, fn); };
  onEl('btn-gv-name-go', 'click', commitName);
  onEl('btn-gv-name-cancel', 'click', closeNamePanel);
  onEl('gv-name-input', 'keydown', (e) => {
    // Escape here is the field's own (an editable chrome field owns its Escape,
    // like #bookmark-name / #new-graph-name); stop it before the document owner
    // reads it as "close the overlay".
    if (e.key === 'Enter') { e.preventDefault(); commitName(); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeNamePanel(); }
  });

  // zoom controls — both go through setZoom, the one owner of "change the zoom"
  $('gv-zoom-pct').addEventListener('click', resetView);
  $('gv-zoom-in').addEventListener('click', () => setZoom(camera.scale * 1.2));
  $('gv-zoom-out').addEventListener('click', () => setZoom(camera.scale / 1.2));

  // pan, graph placement & zoom
  (() => {
    const wrap = document.querySelector('.graph-canvas-wrap');
    let panning = false, sx = 0, sy = 0, stx = 0, sty = 0;
    // Dragging a graph HEADING moves that tree; dragging empty canvas still pans;
    // a glyph still owns its own click. One mousedown, three destinations.
    let titleDrag = null;
    const DRAG_SLOP = 4; // px before a press on the heading counts as a drag, not a click

    wrap.addEventListener('mousedown', (e) => {
      if (!e.target.closest) return;
      if (e.target.closest('.glyph')) return;
      const heading = e.target.closest('.gv-tree-title');
      if (heading && heading.dataset.graphRoot) {
        const [ox, oy] = offsetFor(heading.dataset.graphRoot);
        titleDrag = { rootId: heading.dataset.graphRoot, sx: e.clientX, sy: e.clientY, ox, oy, moved: false };
        e.preventDefault();
        return;
      }
      panning = true; sx = e.clientX; sy = e.clientY; stx = camera.tx; sty = camera.ty;
    });
    window.addEventListener('mouseup', () => {
      if (titleDrag) {
        const d = titleDrag;
        titleDrag = null;
        // Moved → persist the placement. Didn't move → it was a click: rename.
        if (d.moved) { const [dx, dy] = offsetFor(d.rootId); setOffset(d.rootId, dx, dy, true); }
        else renameGraph(d.rootId);
        return;
      }
      panning = false;
    });
    window.addEventListener('mousemove', (e) => {
      if (titleDrag) {
        if (!titleDrag.moved && Math.hypot(e.clientX - titleDrag.sx, e.clientY - titleDrag.sy) < DRAG_SLOP) return;
        titleDrag.moved = true;
        const s = camera.scale || 1;   // screen px → graph units
        setOffset(titleDrag.rootId,
          titleDrag.ox + (e.clientX - titleDrag.sx) / s,
          titleDrag.oy + (e.clientY - titleDrag.sy) / s, false);
        layoutAndRender();             // the layout really did change
        return;
      }
      if (!panning) return;
      camera.tx = stx + (e.clientX - sx);
      camera.ty = sty + (e.clientY - sy);
      applyCamera();                   // camera only — no relayout per mousemove
    });
    wrap.addEventListener('wheel', (e) => {
      e.preventDefault();
      const rect = svgEl.getBoundingClientRect();
      setZoom(camera.scale * Math.exp(-e.deltaY * 0.0015),
        { x: e.clientX - rect.left, y: e.clientY - rect.top });
    }, { passive: false });
  })();
}
