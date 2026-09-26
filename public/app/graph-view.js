// --- Graph screen ---
// The canvas-first graph (plan §2b, design "Graph Canvas Prototype"): the DAG
// gets the whole stage and every control floats over it — "◇ GRAPH · active nX"
// top-left, the jump search top-centre, ⚑/⑃ filters + Collapse all + ◇ New + ✕
// top-right, the zoom pill bottom-left, the legend bottom-right. The inspector is
// NOT a column: it appears only while a node is selected. The history column,
// Scope, the disabled Log / ⇄ compare placeholders and the inspector's lineage,
// diff-vs-parent, folded-list and author sections are gone (maintainer ruling:
// simplify now, bring back if missed).
//
// ×N stacks list REAL nodes (ruling D1): a run of plain trunk turns draws as one
// three-card glyph, and clicking it expands IN PLACE into a "sleeve" — a capped,
// internally scrolling column of those nodes, each selectable. Turns that
// changed nothing committed no node at all; they are shown as faint "ghost" rows
// under the node they folded onto (dashed dots on its edge, on the canvas).
//
// Two `view`s used to collide here: the state singleton and the SVG pan/zoom
// transform. The transform is `camera` ({tx, ty, scale}); the imported `view` is
// the shared state (activeId/viewedId/lock/graphCache/…).
import { view, $ } from './state.js';
import { seqNum, nodeById, labelFor, nodeTime } from './labels.js';
import { previewNode, ensureGraph, leavePreview, showReaimNote } from './topbar.js';
import { esc } from './esc.js';
import { getLocalJson, setLocalJson } from './storage.js';
import { openReplay } from './replay.js';
import { isPhone } from './viewport.js';
import { bus } from './bus.js';

const overlayEl = $('overlay');
const svgEl = $('graph-svg');
const worldEl = $('gv-world');          // HTML layer (sleeves) riding the same camera
let camera = { tx: 0, ty: 0, scale: 1 };
const filters = new Set();              // subset of {'marked','forks'} — independent toggles, union-dims
let query = '';                         // the jump search; non-matches dim, ↵ selects the next hit

/* ---------- the camera: ONE owner of "change the view transform" ----------
   The +/− buttons, the wheel and the reset all go through setZoom/centerGraph,
   and every camera change ends in applyCamera — the cheap path: panning moves a
   transform the layout does not depend on, so it never relays the DAG out. The
   SVG glyphs, the HTML sleeves and the dot grid all follow the one camera. */
const ZOOM_MIN = 0.2, ZOOM_MAX = 3;
const GRID = 22;                        // the dot grid's pitch, in graph units
let rootGEl = null;                     // the <g> layoutAndRender puts every glyph in

function updateZoomReadout() {
  const p = $('gv-zoom-pct');
  if (p) p.textContent = Math.round(camera.scale * 100) + '%';
}
function cameraTransform() { return `translate(${camera.tx},${camera.ty}) scale(${camera.scale})`; }
// Push the current camera onto the existing layers — no layout, no re-render.
function applyCamera() {
  if (rootGEl && rootGEl.isConnected) rootGEl.setAttribute('transform', cameraTransform());
  else { layoutAndRender(); return; }
  if (worldEl) worldEl.style.transform = `translate(${camera.tx}px, ${camera.ty}px) scale(${camera.scale})`;
  const wrap = svgEl.parentElement;
  if (wrap) {
    wrap.style.backgroundSize = `${GRID * camera.scale}px ${GRID * camera.scale}px`;
    wrap.style.backgroundPosition = `${camera.tx}px ${camera.ty}px`;
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
   Trees are auto-laid-out left-to-right; dragging a graph by its heading nudges
   the whole tree, auto-layout staying the base and the drag a delta on top.

   This lives CLIENT-SIDE, keyed by root node id, on purpose. Where a graph sits on
   one person's canvas is a viewport preference, not graph data: the server's
   .web-chat/ graph is turn history that migrations must keep append-only, a second
   browser has its own viewport, and a shared position would make one viewer's
   tidy-up everybody's. Local, not session, storage — "survives a reload" is the
   point; it goes through storage.js, which is where the private-window guard lives. */
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
// persist:false keeps the drag cheap — one write on pointerup, not one per frame.
function setOffset(rootId, dx, dy, persist = true) {
  const o = offsets();
  const rx = Math.round(dx), ry = Math.round(dy);
  if (!rx && !ry) delete o[rootId]; else o[rootId] = [rx, ry];
  if (persist) setLocalJson(POS_KEY, o);
}

// Open the graph screen: refresh, reveal, fit. Canvas-first — nothing is
// selected (so no inspector) unless the surface is previewing an older node, in
// which case that node is selected: reopening the graph after ↵ puts you back on
// the node you went to look at.
//
// On a PHONE (viewport.js) the same screen is a log, not a canvas: #overlay takes
// .log-mode and graph-log.js draws the newest-first list with its fork gutter.
// The log always has a selection — its action bar acts on one — so it starts on
// the active node.
export async function openOverlay() {
  const log = isPhone();
  overlayEl.classList.toggle('log-mode', log);
  view.selectedNodeId = (view.previewing && view.viewedId) ? view.viewedId : (log ? view.activeId : null);
  await refreshGraph();
  overlayEl.classList.remove('hidden');
  // Focus management: the overlay covers the surface and owns the arrows / Space /
  // ↵ / A — move focus in (the container is tabindex="-1") and remember where to
  // hand it back on close.
  returnFocusTo = document.activeElement;
  overlayEl.focus({ preventScroll: true });
  fitView();
  renderInspector(view.selectedNodeId);
}

// Where focus came from when the overlay opened, so closing returns it there.
let returnFocusTo = null;
// The single close path: hide + restore focus. Everything that dismisses the
// overlay (✕, Escape, opening a node, a glance action) routes through here so
// focus is never stranded on a display:none subtree.
export function closeOverlay() {
  closeFloatPreview();
  closeNamePanel();   // raised from inside the overlay — it must not outlive it
  overlayEl.classList.add('hidden');
  const back = returnFocusTo;
  returnFocusTo = null;
  if (back && back.isConnected && typeof back.focus === 'function') back.focus({ preventScroll: true });
}

export function isOverlayOpen() { return !overlayEl.classList.contains('hidden'); }
export function isLogMode() { return overlayEl.classList.contains('log-mode'); }

// The phone log (graph-log.js) registers its renderer here rather than being
// imported: it reads this module's topology, so an import back would be a cycle.
// Every redraw of the graph (layoutAndRender) redraws the log too while it shows.
let logRenderer = null;
export function setLogRenderer(fn) { logRenderer = typeof fn === 'function' ? fn : null; }

// A phone rotated wide (or a narrow window gaining a finger) flips the open graph
// between log and canvas in place.
bus.on('viewport', ({ phone }) => {
  if (!isOverlayOpen()) return;
  overlayEl.classList.toggle('log-mode', !!phone);
  if (phone && !view.selectedNodeId) view.selectedNodeId = view.activeId;
  if (!phone) fitView(); else layoutAndRender();
  renderInspector(view.selectedNodeId);
});

/* The overlay's half of the ONE Escape owner (shell.js handleEscape): its layers
   in precedence order, reporting whether it consumed the key.

     1. the glance                  (raised from inside the overlay)
     2. the rename / bookmark panel (ditto — must never outlive its parent)
     3. the selection               (the inspector is only there while one exists;
                                     not in the phone log, which always has one)
     4. the overlay itself
*/
export function escapeInOverlay() {
  if (floatEl) { closeFloatPreview(); return true; }
  if (isNamePanelOpen()) { closeNamePanel(); return true; }
  // (The phone log always keeps a selection for its action bar: Escape closes it.)
  if (isOverlayOpen() && view.selectedNodeId && !isLogMode()) { deselect(); return true; }
  if (isOverlayOpen()) { closeOverlay(); return true; }
  return false;
}

/* Same-origin preview iframes swallow the key. The inspector's thumbnail and the
   glance are both <iframe src="/preview/node/:id">; clicking either moves focus
   INTO that document, after which a real Escape is delivered there and never
   reaches ours. Both are same-origin, so forward the key back to the page that
   owns the layers. Transport, not a second Escape implementation. */
export function forwardEscapeFrom(frame) {
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
  // from under any single one: now, on load, and on focus entering the frame.
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
  updateHead();
}

// Keep the inspector's Set active / Branch in sync (called on lock changes too).
export function updateSidebarButtons() {
  const id = view.selectedNodeId;
  const isActive = !!id && id === view.activeId;
  const btn = $('gv-set-active');
  if (btn) {
    btn.disabled = !id || isActive || !!view.lock;
    btn.textContent = view.lock ? 'locked — turn in progress'
      : (isActive ? 'A · Active' : 'A · Set active here');
  }
  const br = $('gv-branch');
  if (br) br.disabled = !id || isActive || !!view.lock;
}

// Select a node → highlight it and raise the inspector. Selecting a node inside a
// collapsed stack expands that stack (and scrolls its sleeve to the row), so the
// selection is always something on screen. Selection never reshapes the graph
// otherwise. Space = glance · ↵ / double-click = open · arrows = move.
export async function selectNode(id, opts = {}) {
  view.selectedNodeId = id;
  if (id) {
    const head = computeRuns().get(id);
    if (head && !view.expandedStacks.has(head)) view.expandedStacks.add(head);
    revealInSleeve(id);
  }
  if (!opts.noRender) layoutAndRender();
  if (id && opts.center) { centerOn(id); applyCamera(); }
  if (floatEl && id) openFloatPreview(id);  // keep the glance tracking the selection
  await renderInspector(id);
}
function deselect() {
  view.selectedNodeId = null;
  layoutAndRender();
  renderInspector(null);
}

// --- topology helpers ---
// All read the DISPLAY topology (graphIndex), not the raw commit graph: the ⑃
// badge, the forks filter and the stacks describe what is on screen.
export function isFork(n) {
  if (!n) return false;
  const idx = graphIndex();
  const dn = idx.byId.get(n.id);          // the node AS DRAWN (its display parent)
  if (!dn || !dn.parent_id) return false;
  const sibs = idx.childrenOf(dn.parent_id);
  return sibs.length > 1 && sibs[0] && sibs[0].id !== dn.id; // a non-trunk child of a branch point
}
// How many no-change turns a node stands for: turns that committed no node
// (`folded_count`) plus legacy byte-identical nodes the server hides (`absorbed`).
export const foldedCount = (n) => ((n && n.folded_count) || 0) + ((n && n.absorbed_count) || 0);

// The top-level tree a node belongs to (walk display parents to the ancestor the
// canvas draws a heading over).
const rootOf = (id) => graphIndex().rootOf(id);
export const graphNameOf = (id) => {
  const r = nodeById(rootOf(id));
  return r ? (r.name || 'graph ' + String(r.label || r.id).split('.')[0]) : '—';
};

// The graph AS DRAWN. Turns that changed nothing are dropped and each survivor's
// parent is rewritten to the nearest survivor, so a run of no-change turns closes
// up instead of stretching the trunk with copies of one surface. The server
// decides what collapses (GET /api/graph -> collapsed / display_parent); this is
// the one place the decision is applied, so every consumer below agrees on what
// exists. The collapsed turns themselves are not lost: they are the ghost rows of
// the node that absorbed them.
function displayNodes() {
  const all = view.graphCache?.nodes || [];
  return all
    .filter((n) => !n.collapsed)
    .map((n) => {
      const dp = n.display_parent === undefined ? n.parent_id : n.display_parent;
      return dp === n.parent_id ? n : { ...n, parent_id: dp };
    });
}

/* ---------- the display topology, built once per graph ----------
   displayNodes() decides what EXISTS; this decides what is connected to what.
   Everything topological reads THIS: runs, layout, keyboard nav, fork
   classification and the counts. Rebuilt when — and only when — the graph
   payload or the active/viewed node changes (isBreakout depends on those).

   labels.js's childrenOf() stays RAW (commit topology) for a question about the
   commit graph, which is a different question. */
let indexCache = null;
export function graphIndex() {
  if (indexCache
    && indexCache.cache === view.graphCache
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
  // A node whose parent is not in the display set is a top-level tree here.
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
    while (cur && guard++ < 10000) { chain.unshift(cur); cur = parentOf(cur.id); }
    return chain;
  };
  const rootOf = (id) => { const chain = lineageOf(id); return chain.length ? chain[0].id : null; };

  const idx = { nodes, byId, childMap, roots, isBreakout, childrenOf, parentOf, lineageOf, rootOf };
  indexCache = { cache: view.graphCache, activeId: view.activeId, viewedId: view.viewedId, idx };
  return idx;
}

// The turns the graph DRAWS, in commit order — for a surface that lists nodes
// rather than walking them (the ⌘K palette), so a collapsed no-change turn never
// gets a row that previews a node the DAG does not draw.
export function displayNodeList() { return graphIndex().nodes; }

// The topbar's ↓ steps to the next turn the graph DRAWS, the same gesture
// ArrowDown performs here…
export function displayChildrenOf(id) { return graphIndex().childrenOf(id); }

// …and ↑ is its mirror: the previous turn as DRAWN. The two buttons read the SAME
// topology or they are not inverses. One raw fallback: a viewed node absent from
// the display set has no drawn parent, and the raw parent is the only way out.
export function displayParentOf(id) {
  const idx = graphIndex();
  if (idx.byId.has(id)) { const p = idx.parentOf(id); return p ? p.id : null; }
  const n = nodeById(id);
  return (n && n.parent_id) || null;
}

/* ---------- filters + jump search: dim, never hide ----------
   ⚑ Marked and ⑃ Forks are independent toggles, the search is free text over
   the label, trigger and bookmark name; together they DIM everything that does
   not match (the graph keeps its shape — hiding nodes would redraw the DAG as
   something it is not). ↵ in the search selects and centres the next match. */
export function isFiltering() { return filters.size > 0 || !!query; }
export function matches(n) {
  if (!n) return false;
  if (filters.has('marked') && !n.bookmarked) return false;
  if (filters.has('forks') && !isFork(n)) return false;
  if (query) {
    const hay = `${n.label || n.id} ${n.trigger_summary || ''} ${n.name || ''}`.toLowerCase();
    if (!hay.includes(query)) return false;
  }
  return true;
}
// The one lever for both filter chip groups (the canvas's and the phone log's)
// and the jump search, so the two surfaces never disagree about what is shown.
export function toggleFilter(f) {
  if (filters.has(f)) filters.delete(f); else filters.add(f);
  for (const c of overlayEl.querySelectorAll(`[data-filter="${f}"]`)) {
    c.classList.toggle('on', filters.has(f));
    c.setAttribute('aria-pressed', String(filters.has(f)));
  }
  layoutAndRender();
}
export function setQuery(q) {
  query = String(q || '').toLowerCase().trim();
  layoutAndRender();
}
function jumpToNextMatch() {
  const hits = graphIndex().nodes.slice()
    .sort((a, b) => (a.created_at - b.created_at) || (seqNum(a.id) - seqNum(b.id)))
    .filter(matches);
  if (!hits.length) return;
  const at = hits.findIndex((n) => n.id === view.selectedNodeId);
  const next = hits[(at + 1) % hits.length];
  selectNode(next.id, { center: true });
}

// The floating "◇ GRAPH · active nX · N turns" chip.
function updateHead() {
  const m = $('gv-head-meta');
  if (!m) return;
  const n = graphIndex().nodes.length;
  const act = view.activeId ? 'active ' + labelFor(view.activeId) : 'no active node';
  m.textContent = `${act} · ${n} turn${n === 1 ? '' : 's'}`;
}

// --- inspector (floating, 300px, only while a node is selected) ---
// One request token for the whole panel: the inspector paints after an await
// while view.selectedNodeId — which the action buttons read — moves synchronously
// on every arrow key. A response is painted only if it is still the one asked for,
// so held arrows can never leave the panel describing one node while A/⚑/↧ act on
// another.
let inspectorSeq = 0;
async function renderInspector(id) {
  const box = $('gv-inspector');
  if (!box) return;
  const seq = ++inspectorSeq;
  if (!id) { box.classList.add('hidden'); box.innerHTML = ''; return; }
  let node = null;
  try { node = await fetch('/api/graph/node/' + encodeURIComponent(id)).then((r) => r.ok ? r.json() : null); } catch {}
  if (seq !== inspectorSeq) return;   // a newer selection won the race
  box.classList.remove('hidden');
  if (!node) { box.innerHTML = '<div class="gv-empty">Node unavailable.</div>'; return; }
  const n = nodeById(id) || node;
  const inStack = computeRuns().has(id);
  const badges =
    (id === view.activeId ? '<span class="gv-badge active">ACTIVE</span>' : '') +
    (isFork(n) ? '<span class="gv-badge fork">FORK</span>' : '') +
    (inStack ? '<span class="gv-badge stack">IN STACK</span>' : '');
  const bm = n.bookmarked ? `<div class="gv-insp-bm">${esc(bookmarkCaption(n))}</div>` : '';
  const trigger = node.trigger?.message || node.trigger?.summary || node.trigger_summary || '(no trigger)';
  const when = node.created_at ? new Date(node.created_at).toLocaleString() : '—';
  const marked = !!n.bookmarked;
  // Claude's side of the turn (the Stop hook's reply summary) — one line, full
  // text on hover. Older nodes and manual commits have none; no line then.
  const reply = node.trigger?.reply || '';

  box.innerHTML =
    `<div class="gv-insp-head"><span class="gv-insp-label">${esc(node.label || id)}</span>${badges}` +
      `<button class="gv-insp-close" data-act="close" title="Close (Esc)" aria-label="Close the inspector">✕</button></div>` +
    bm +
    `<div class="gv-preview" id="gv-preview"></div>` +
    `<div class="gv-trigger">${esc(trigger)}</div>` +
    (reply ? `<div class="gv-reply" title="${esc(reply)}">${esc(reply)}</div>` : '') +
    `<div class="gv-meta"><span class="k">GRAPH</span><span class="v">${esc(graphNameOf(id))}</span>` +
      `<span class="k">WHEN</span><span class="v">${esc(when)}</span>` +
      `<span class="k">CHANGED</span><span class="v" id="gv-changed">…</span></div>` +
    `<div class="gv-actions">` +
      `<button class="gv-act primary" id="gv-set-active" data-act="active" title="Make this the node the next turn commits onto (A)">A · Set active here</button>` +
      `<button class="gv-act" id="gv-branch" data-act="branch" title="Set active here so the next commit forks from this node">⑃ Branch</button>` +
      `<button class="gv-act" data-act="glance" title="Glance (Space)">Glance</button>` +
      (marked
        ? `<button class="gv-act" data-act="unmark" title="Remove the bookmark">⚑ Unmark</button>`
        : `<button class="gv-act" data-act="bookmark" title="Bookmark (B)">⚑ Bookmark</button>`) +
      `<button class="gv-act" data-act="export" title="Export (E)">↧ Export</button>` +
      `<button class="gv-act" data-act="replay" title="Replay up to this node (R)">▶ Replay</button>` +
    `</div>`;

  drawPreview($('gv-preview'), id, (node.mounts || []).length);
  renderChanged(id, node, seq);
  updateSidebarButtons();
}

// The real node surface as a thumbnail: a scaled-down iframe of /preview/node/:id
// (the same self-contained doc the glance uses). A turn with no blocks shows a
// placeholder instead of a blank.
const PREVIEW_W = 1160;
function drawPreview(box, id, paneCount) {
  if (!box) return;
  box.innerHTML = '';
  if (!paneCount) {
    const ph = document.createElement('div');
    ph.className = 'gv-preview-empty'; ph.textContent = `no blocks at ${labelFor(id)}`;
    box.appendChild(ph);
    return;
  }
  const scale = (box.clientWidth || 274) / PREVIEW_W;
  const fr = document.createElement('iframe');
  fr.className = 'gv-preview-frame';
  fr.setAttribute('scrolling', 'no');
  fr.setAttribute('title', 'page preview at ' + labelFor(id));
  fr.style.width = PREVIEW_W + 'px';
  fr.style.height = Math.round((box.clientHeight || 96) / scale) + 'px';
  fr.style.transform = 'scale(' + scale + ')';
  fr.src = '/preview/node/' + encodeURIComponent(id);
  forwardEscapeFrom(fr);
  box.appendChild(fr);
}

// The CHANGED row: one line, from the diff against the parent the canvas DRAWS
// (every collapsed node is byte-identical to its own parent, so the counts are
// the same either way — this only names the edge the user can see).
async function renderChanged(id, node, seq) {
  const el = $('gv-changed');
  if (!el) return;
  const n = nodeById(id) || node;
  if (n.wipe) { el.textContent = 'surface wiped · pinned blocks kept'; return; }
  const parentId = displayParentOf(id);
  if (!parentId) { el.textContent = 'first turn of the graph'; return; }
  try {
    const d = await fetch(`/api/graph/diff?a=${encodeURIComponent(parentId)}&b=${encodeURIComponent(id)}`).then((r) => r.ok ? r.json() : null);
    if (seq !== inspectorSeq) return;   // the selection moved on
    const m = (d && d.mounts) || {};
    const parts = [];
    const add = (m.added || []).length, chg = (m.changed || []).length, rm = (m.removed || []).length;
    if (add) parts.push(`${add} added`);
    if (chg) parts.push(`${chg} changed`);
    if (rm) parts.push(`${rm} removed`);
    el.textContent = parts.length ? `blocks: ${parts.join(' · ')}` : 'no block changes';
  } catch { el.textContent = '—'; }
}

// open a node on the surface (a read-only preview; leaves the overlay)
function openNode(id) { view.selectedNodeId = id; previewNode(id); closeOverlay(); }

/* ---------- setting a node active: ONE POST, one failure path ----------
   Set active, ⑃ Branch, the A key and the glance's "Set active here" all move
   `active`, and all go through requestSetActive: the POST and its two not-moved
   answers (refused → the reason; queued behind a locked turn → "Queued"). Both
   are reported in the page (topbar.showReaimNote), never a blocking dialog, and
   echoed on the graph's own toast while it is open — the page note paints under
   the overlay. Returns true only when active actually moved. */
export async function requestSetActive(id) {
  if (!id) return false;
  const r = await fetch('/api/graph/active', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }),
  });
  if (!r.ok) {
    const err = await r.json().catch(() => ({}));
    note('Could not set active: ' + (err.error || r.statusText));
    return false;
  }
  const body = await r.json().catch(() => ({}));
  if (body.pending) {
    // Claude is mid-turn: the server queued the re-aim and applies it at
    // turn-end. Stay exactly where we are — the eventual reset frame lands it.
    note(`Queued — jumps to ${labelFor(id)} when Claude's turn ends.`);
    return false;
  }
  return true;
}
function note(text) {
  showReaimNote(text);
  if (isOverlayOpen()) toast(text);
}
function toast(text) {
  const t = $('gv-toast');
  if (!t) return;
  t.textContent = text;
  t.classList.remove('hidden');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.add('hidden'), 2600);
}

async function postSetActive(id, { alsoCloseOverlay = false } = {}) {
  if (!await requestSetActive(id)) return false;
  leavePreview();
  if (alsoCloseOverlay) closeOverlay();
  await refreshGraph();
  if (isOverlayOpen() && view.selectedNodeId) renderInspector(view.selectedNodeId);
  return true;
}

export async function setActive(id) {
  if (await postSetActive(id)) toast(`Active → ${labelFor(id)} · your next message commits here`);
}
// ⑃ Branch = make this node active; if it already has children, the next commit
// is a sibling of them — a fork. (Branching only ever happens by making a node
// active — ruling D2: editing a previewed node no longer does it.)
export async function branchFrom(id) {
  const kids = ((nodeById(id) || {}).children || []).length;
  if (await postSetActive(id)) {
    toast(kids ? `⑃ Next commit branches from ${labelFor(id)}` : `Active → ${labelFor(id)} · the next commit continues from it`);
  }
}

export function exportNode(id) {
  const a = document.createElement('a');
  a.href = '/api/export/' + encodeURIComponent(id); a.download = '';
  document.body.appendChild(a); a.click(); a.remove();
}

/* ---------- naming: the ONE name field, two callers ----------
   A graph's name IS the `name` on its bookmarked ROOT node — exactly what `new
   graph` writes. The canvas heading is the affordance to (re)name a graph, and it
   reuses POST /api/graph/bookmark — the same endpoint ⚑ uses. Both callers go
   through #gv-name-panel. Never window.prompt: a blocking browser dialog, unlike
   every other input in this chrome, and one that wedges an automated driver. */
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
export async function saveName(id, name) {
  await fetch('/api/graph/bookmark', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, name }),
  });
  await refreshGraph();
  if (view.selectedNodeId) renderInspector(view.selectedNodeId);
}
async function commitName() {
  const id = nameTargetId;
  const inp = $('gv-name-input');
  const name = ((inp && inp.value) || '').trim();
  closeNamePanel();
  if (!id) return;
  await saveName(id, name);
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
export function unmarkNode(id) { return saveName(id, ''); }

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

// --- Glance: a read-only render of the node in a modal card over a scrim. A
// peek only; never touches the live surface. Space, Esc or the scrim close it.
let floatEl = null;
function openFloatPreview(id) {
  if (!id) return;
  if (!floatEl) {
    floatEl = document.createElement('div');
    floatEl.className = 'glance-backdrop';
    floatEl.innerHTML =
      '<div class="glance-card" role="dialog" aria-label="Glance">' +
        '<div class="glance-titlebar"><span class="glance-title"></span><span class="glance-trigger"></span>' +
          '<button class="glance-btn" data-act="open" title="Open on the surface (↵)">⤢ Open</button>' +
          '<button class="glance-btn primary" data-act="active" title="Set this node active">Set active here</button>' +
          '<button class="glance-btn icon" data-act="close" title="Close (Space)" aria-label="Close the glance">✕</button>' +
        '</div>' +
        '<iframe class="glance-frame" title="node preview"></iframe>' +
      '</div>';
    document.body.appendChild(floatEl);
    floatEl.addEventListener('mousedown', (e) => { if (e.target === floatEl) closeFloatPreview(); });
    floatEl.querySelector('[data-act="close"]').addEventListener('click', closeFloatPreview);
    floatEl.querySelector('[data-act="open"]').addEventListener('click', () => {
      const nid = floatEl.dataset.nodeId; closeFloatPreview();
      openNode(nid);
    });
    floatEl.querySelector('[data-act="active"]').addEventListener('click', () => {
      const nid = floatEl.dataset.nodeId; closeFloatPreview();
      postSetActive(nid, { alsoCloseOverlay: true });
    });
  }
  const n = nodeById(id) || {};
  floatEl.dataset.nodeId = id;
  floatEl.querySelector('.glance-title').textContent = labelFor(id) + ' · glance';
  floatEl.querySelector('.glance-trigger').textContent = n.trigger_summary || '';
  const act = floatEl.querySelector('[data-act="active"]');
  act.disabled = id === view.activeId || !!view.lock;
  const frame = floatEl.querySelector('.glance-frame');
  forwardEscapeFrom(frame);
  const src = '/preview/node/' + encodeURIComponent(id);
  if (frame.getAttribute('src') !== src) frame.setAttribute('src', src);
}
function closeFloatPreview() { if (floatEl) { floatEl.remove(); floatEl = null; } }
// Read by the one Escape owner so it can tell a modal overlay layer is up.
export function hasFloatPreview() { return !!floatEl; }
export function toggleFloatPreview() {
  if (floatEl) closeFloatPreview();
  else if (view.selectedNodeId) openFloatPreview(view.selectedNodeId);
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

// Move the selection node-to-node: ↑ parent, ↓ trunk child, ←→ siblings. With
// nothing selected, the first arrow selects the active node. Leaving an
// expanded stack collapses it; entering a collapsed stack expands it.
export function moveSelection(dir) {
  if (!view.graphCache) return;
  // The DISPLAY topology, so every step lands on a node that is drawn.
  const idx = graphIndex();
  const cur = idx.byId.get(view.selectedNodeId);
  if (!cur) {
    const start = idx.byId.get(view.activeId) || idx.nodes[0];
    if (start) selectNode(start.id, { center: true });
    return;
  }
  let targetId = null;
  if (dir === 'up') {
    const p = idx.parentOf(cur.id);
    targetId = p && p.id;
  } else if (dir === 'down') {
    const kids = idx.childrenOf(cur.id);
    targetId = kids[0] && kids[0].id;
  } else {
    const sibs = (cur.parent_id != null && idx.byId.has(cur.parent_id))
      ? idx.childrenOf(cur.parent_id)
      : idx.roots.map((rid) => idx.byId.get(rid));
    const at = sibs.findIndex((sib) => sib.id === cur.id);
    const next = sibs[at + (dir === 'right' ? 1 : -1)];
    targetId = next && next.id;
  }
  if (!targetId) return;
  const runs = computeRuns();
  const fromHead = runs.get(view.selectedNodeId);
  const toHead = runs.get(targetId);
  if (fromHead && fromHead !== toHead) view.expandedStacks.delete(fromHead); // left a stack → collapse it
  selectNode(targetId, { center: true });                                      // entering one expands it
}

// --- Topology-driven layout ---
// A break-out node (fork, bookmark, active, or viewed) gets its own glyph; a
// maximal run of consecutive trunk-linked non-break-out nodes collapses into one
// ×N stack. The trunk descends straight down one column; a branch claims the next
// free column to the right; trees lay out left-to-right. An EXPANDED stack is a
// sleeve: a fixed-width card in place of the stack, capped at SLEEVE_CAP rows and
// scrolling inside itself, so a 30-turn run moves everything below it once, by a
// bounded amount (design "Stack Expansion Options" 1a/2a — it replaced the old
// serpentine, which read as a different graph).
const DX = 130, DY = 66, NODE_R = 16, PLAIN_R = 9, STACK_W = 40, STACK_H = 30;
const SLEEVE_W = 318, SLEEVE_INSET = 30, SLEEVE_HDR = 28, SLEEVE_PAD = 8, SLEEVE_FOOT = 26;
const ROW_H = 30, GHOST_H = 22, SLEEVE_CAP = 8, GHOST_CAP = 3;
const BM_ROOM = 16;                     // extra headroom above a node that carries a bookmark caption
// The dashed ghost dots on a node's incoming edge must sit in the CLEAR part of
// it — below the label under the glyph above, above the bookmark caption over
// the node — so each dot buys the edge some length. Spread evenly over the edge
// they sat on the parent's label and the caption, and two of them nearly touched.
const GHOST_DOTS = 3, GHOST_DOT_ROOM = 12;
const LABEL_CLEAR = 22;                 // a glyph's label runs to ~17px below it; a dot's radius is 4
const CAPTION_CLEAR = 24, EDGE_CLEAR = 8;
const foldRoom = (n) => Math.min(GHOST_DOTS, foldedCount(n)) * GHOST_DOT_ROOM;

// Ghost rows for one node: the turns that folded onto it, oldest first, capped
// at GHOST_CAP with the last row saying how many more there are.
export function ghostRowsFor(n) {
  const total = foldedCount(n);
  if (!total) return [];
  const texts = foldedTexts(n);
  const rows = [];
  const shown = total > GHOST_CAP ? GHOST_CAP - 1 : total;
  for (let i = 0; i < shown; i++) {
    const f = texts[i] || {};
    rows.push({ kind: 'ghost', for: n.id, text: f.text || 'folded turn', reply: f.reply || '' });
  }
  if (total > shown) rows.push({ kind: 'ghost', for: n.id, more: total - shown, text: `⋯ ${total - shown} more folded turn${total - shown === 1 ? '' : 's'}` });
  return rows;
}

// Folded trigger text. Legacy collapsed nodes ride /api/graph (`absorbed`); the
// turns that committed no node live only on the node record (`folded`), fetched
// once per node on demand and cached — a node's folded list never changes after
// it commits. Each entry is { text, reply } — reply is Claude's summary of that
// turn's answer, shown on hover (a folded turn is often exactly a chat-only reply).
const foldedCache = new Map();          // id -> {text, reply}[] | null (in flight)
function foldedTexts(n) {
  const out = (n.absorbed || []).map((a) => ({ text: a.trigger_summary || '(no trigger)', reply: '' }));
  if (n.folded_count) {
    const got = foldedCache.get(n.id);
    if (got) out.push(...got);
    else if (!foldedCache.has(n.id)) fetchFolded(n.id);
  }
  return out;
}
async function fetchFolded(id) {
  foldedCache.set(id, null);
  let list = [];
  try {
    const node = await fetch('/api/graph/node/' + encodeURIComponent(id)).then((r) => r.ok ? r.json() : null);
    list = ((node && node.folded) || []).map((f) => ({ text: f.summary || f.message || '(no trigger)', reply: f.reply || '' }));
  } catch {}
  foldedCache.set(id, list);
  if (isOverlayOpen()) layoutAndRender();
}

// Per-sleeve scroll offset, keyed by the run head, so a re-render (a selection,
// a graph refresh) does not throw the user back to the top of a long run.
const sleeveScroll = new Map();

function computeGraphLayout() {
  const { byId, childMap, roots, isBreakout } = graphIndex();
  const runs = computeRuns();

  const glyphs = [];
  const edges = [];
  const sleeves = [];
  const pos = new Map();                 // id -> {x, y, sleeve?} for centring
  // frontier = x of the next free column; branches and new trees allocate here
  // so they always sit to the right of everything placed so far (incl. sleeves).
  let frontier = 0;
  const bumpFrontier = (x) => { if (x > frontier) frontier = x; };

  const placeNode = (id, x, y, plain) => {
    const n = byId.get(id);
    const r = plain ? PLAIN_R : NODE_R;
    const g = {
      kind: 'node', id, label: n.label, x, y, r, top: y - r, bottom: y + r,
      bookmarked: !!n.bookmarked, name: n.name || '', wipe: !!n.wipe, plain: !!plain,
      trigger: n.trigger_summary || '', folded: foldedCount(n), node: n,
    };
    glyphs.push(g); bumpFrontier(x + DX); pos.set(id, { x, y });
    return g;
  };
  const placeStack = (ids, x, y) => {
    const g = {
      kind: 'stack', ids: ids.slice(), head: ids[0],
      headLabel: byId.get(ids[0]).label, tailLabel: byId.get(ids[ids.length - 1]).label,
      count: ids.length, x, y, top: y - STACK_H / 2 - 6, bottom: y + STACK_H / 2,
    };
    glyphs.push(g); bumpFrontier(x + DX);
    for (const id of ids) pos.set(id, { x, y });
    return g;
  };
  const placeSleeve = (ids, x, y) => {
    const rows = [];
    let top = SLEEVE_PAD;
    for (const id of ids) {
      const n = byId.get(id);
      rows.push({ kind: 'node', id, n, top }); top += ROW_H;
      for (const gr of ghostRowsFor(n)) { rows.push({ ...gr, top }); top += GHOST_H; }
    }
    const contentH = top + SLEEVE_PAD;
    const cap = SLEEVE_CAP * ROW_H + 2 * SLEEVE_PAD;
    const scrolls = contentH > cap;
    const viewH = Math.min(contentH, cap);
    const h = SLEEVE_HDR + viewH + (scrolls ? SLEEVE_FOOT : 0);
    const sTop = y - 16;
    const s = {
      kind: 'sleeve', head: ids[0], ids: ids.slice(), rows, x: x - SLEEVE_INSET, y: sTop, w: SLEEVE_W, h,
      viewH, contentH, scrolls, trunkX: x, top: sTop, bottom: sTop + h,
    };
    sleeves.push(s); bumpFrontier(x - SLEEVE_INSET + SLEEVE_W + 40);
    for (const r of rows) if (r.kind === 'node') pos.set(r.id, { x, y: sTop + SLEEVE_HDR + r.top + ROW_H / 2, sleeve: s, row: r });
    return s;
  };
  const straight = (a, b) => edges.push({ ax: a.x, ay: a.bottom, bx: b.x, by: b.top, from: a, to: b });
  const elbow = (a, b) => edges.push({ ax: a.x, ay: a.bottom, bx: b.x, by: b.top, elbow: true, to: b });

  // Does the trunk that starts here contain an expanded run? Then the column is
  // a sleeve wide, and a branch taken ABOVE the sleeve must already clear it.
  const trunkHasSleeve = (startId) => {
    for (let cur = startId, guard = 0; cur != null && guard++ < 100000; cur = (childMap.get(cur) || [])[0]) {
      const h = runs.get(cur);
      if (h && view.expandedStacks.has(h)) return true;
    }
    return false;
  };

  function walk(startId, columnX, startY) {
    let x = columnX, y = startY, prev = null, first = null, pending = [];
    if (trunkHasSleeve(startId)) bumpFrontier(x - SLEEVE_INSET + SLEEVE_W + 40);
    const link = (g) => { if (prev) straight(prev, g); prev = g; if (!first) first = g; };
    const flush = () => {
      if (!pending.length) return;
      const run = pending; pending = [];
      if (run.length === 1) {
        if (prev) y += foldRoom(byId.get(run[0]));   // room for its ghost dots
        link(placeNode(run[0], x, y, true)); y += DY; return;
      }
      if (!view.expandedStacks.has(run[0])) { link(placeStack(run, x, y)); y += DY; return; }
      const s = placeSleeve(run, x, y);
      link({ x, top: s.top, bottom: s.bottom });   // the trunk enters at its top, leaves at its bottom
      y = s.bottom + 44;
    };

    let cur = startId;
    while (cur != null) {
      const kids = childMap.get(cur) || [];
      if (isBreakout(cur)) {
        flush();
        const n = byId.get(cur);
        if (prev && n.bookmarked) y += BM_ROOM;   // room for the caption above it
        if (prev) y += foldRoom(n);               // and for its ghost dots
        const g = placeNode(cur, x, y, false); y += DY;
        link(g);
        for (let i = 1; i < kids.length; i++) {
          const branchHead = walk(kids[i], frontier, y);
          if (branchHead) elbow(g, branchHead);
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

  // Which tree every node belongs to — one walk down from each root, not a
  // lineage walk up per node.
  const treeOf = new Map();
  for (const r of roots) {
    const stack = [r];
    while (stack.length) { const id = stack.pop(); treeOf.set(id, r); stack.push(...(childMap.get(id) || [])); }
  }

  // Each top-level tree is a "graph"; title it above its first glyph.
  const treeTitles = [];
  for (const r of roots) {
    const g0 = glyphs.length, e0 = edges.length, s0 = sleeves.length;
    const first = walk(r, frontier, 0);
    const rn = byId.get(r);
    let count = 0;
    for (const t of treeOf.values()) if (t === r) count++;
    const tt = (first && rn)
      ? { x: first.x, y: first.top != null ? first.top : first.y, graphLabel: (rn.label || '').replace(/\.0$/, ''), name: rn.name || '', rootId: r, count }
      : null;
    if (tt) treeTitles.push(tt);
    // The user's saved placement is a delta ON the auto-layout: shift everything
    // this tree produced. `frontier` was advanced from the unshifted x, so moving
    // one graph never reflows the others.
    const [dx, dy] = offsetFor(r);
    if (dx || dy) {
      for (let i = g0; i < glyphs.length; i++) { const g = glyphs[i]; g.x += dx; g.y += dy; g.top += dy; g.bottom += dy; }
      for (let i = s0; i < sleeves.length; i++) { const s = sleeves[i]; s.x += dx; s.y += dy; s.trunkX += dx; s.top += dy; s.bottom += dy; }
      for (let i = e0; i < edges.length; i++) { const e = edges[i]; e.ax += dx; e.ay += dy; e.bx += dx; e.by += dy; }
      for (const [id, p] of pos) if (treeOf.get(id) === r) pos.set(id, { ...p, x: p.x + dx, y: p.y + dy });
      if (tt) { tt.x += dx; tt.y += dy; }
    }
  }
  return { glyphs, edges, sleeves, treeTitles, pos };
}

// Scroll a sleeve so a node's row is inside its window (a selection by key or
// search lands on a row the user can see).
function revealInSleeve(id) {
  const head = computeRuns().get(id);
  if (!head || !view.expandedStacks.has(head)) return;
  const s = computeGraphLayout().sleeves.find((sl) => sl.head === head);
  if (!s || !s.scrolls) return;
  const row = s.rows.find((r) => r.kind === 'node' && r.id === id);
  if (!row) return;
  let cur = sleeveScroll.get(head) || 0;
  if (row.top < cur + SLEEVE_PAD) cur = Math.max(0, row.top - SLEEVE_PAD);
  else if (row.top + ROW_H > cur + s.viewH - SLEEVE_PAD) cur = row.top + ROW_H - s.viewH + SLEEVE_PAD;
  sleeveScroll.set(head, Math.max(0, Math.min(cur, s.contentH - s.viewH)));
}

// Center the viewport on a node (used by keyboard navigation and the search).
function centerOn(id) {
  const p = computeGraphLayout().pos.get(id);
  if (!p) return;
  let y = p.y;
  if (p.sleeve) y -= (sleeveScroll.get(p.sleeve.head) || 0);
  const w = svgEl.clientWidth || 800, h = svgEl.clientHeight || 600;
  camera.tx = w / 2 - p.x * camera.scale;
  camera.ty = h / 2 - y * camera.scale;
}

const SVGNS = 'http://www.w3.org/2000/svg';
function svgEl_(tag, attrs, text) {
  const el = document.createElementNS(SVGNS, tag);
  for (const k in attrs) el.setAttribute(k, attrs[k]);
  if (text != null) el.textContent = text;
  return el;
}
export const bookmarkCaption = (n) => n.wipe ? '⌫ wipe' + (n.name ? ' · ' + n.name : '') : '⚑ ' + (n.name || labelFor(n.id));

// Every colour is a CSS class reading a --wc-* token (app.css, "graph screen"),
// so a theme or a mode flip restyles the canvas without a relayout.
export function layoutAndRender() {
  const { glyphs, edges, sleeves, treeTitles } = computeGraphLayout();
  const filtering = isFiltering();
  const dimNode = (n) => filtering && !matches(n);
  svgEl.innerHTML = '';

  const rootG = svgEl_('g', { transform: cameraTransform() });
  rootGEl = rootG;   // applyCamera moves THIS without recomputing the layout
  svgEl.appendChild(rootG);

  // Edges first (under glyphs), then the folded ghost dots riding them.
  const edgesG = svgEl_('g', { class: 'gv-edges' });
  rootG.appendChild(edgesG);
  for (const e of edges) {
    const d = e.elbow
      ? `M ${e.ax} ${e.ay} C ${e.ax} ${e.ay + DY * 0.55}, ${e.bx} ${e.by - DY * 0.55}, ${e.bx} ${e.by}`
      : `M ${e.ax} ${e.ay} L ${e.bx} ${e.by}`;
    edgesG.appendChild(svgEl_('path', { d, class: 'gv-edge' }));
    const to = e.to;
    if (!e.elbow && to && to.kind === 'node' && to.folded) {
      const k = Math.min(GHOST_DOTS, to.folded);
      // A node or stack above carries a label under it; a sleeve does not.
      const top = e.ay + (e.from && e.from.kind ? LABEL_CLEAR : EDGE_CLEAR);
      const bottom = e.by - (to.bookmarked ? CAPTION_CLEAR : EDGE_CLEAR);
      const band = Math.max(0, bottom - top);
      for (let i = 1; i <= k; i++) {
        edgesG.appendChild(svgEl_('circle', {
          cx: e.bx, cy: top + (band * (i - 0.5)) / k, r: 4, class: 'gv-ghost-dot' + (dimNode(to.node) ? ' dim' : ''),
        }));
      }
    }
  }

  // Tree titles: "◇ name" (or "◇ graph nX") + "N turns ✎". The heading is the
  // graph's handle: click it to rename (it names the root node), drag to move.
  for (const tt of treeTitles) {
    const grp = svgEl_('g', { class: 'gv-tree-title' + (tt.name ? ' named' : '') });
    grp.dataset.graphRoot = tt.rootId;
    const caption = '◇ ' + (tt.name || ('graph ' + tt.graphLabel));
    const sub = `${tt.count} turn${tt.count === 1 ? '' : 's'}`;
    const hitW = Math.max(120, (caption.length + sub.length) * 7 + 48);
    const ty = tt.y - 22;
    grp.appendChild(svgEl_('rect', { x: tt.x - hitW / 2, y: ty - 16, width: hitW, height: 24, rx: 4, class: 'gv-tt-hit' }));
    grp.appendChild(svgEl_('title', {}, 'Click to rename this graph · drag to move it'));
    const t = svgEl_('text', { x: tt.x, y: ty, 'text-anchor': 'middle', class: 'gv-tt' });
    t.appendChild(svgEl_('tspan', { class: 'gv-tt-name' }, caption));
    t.appendChild(svgEl_('tspan', { class: 'gv-tt-sub', dx: '8' }, sub));
    t.appendChild(svgEl_('tspan', { class: 'gv-tt-pencil', dx: '6' }, '✎'));
    grp.appendChild(t);
    rootG.appendChild(grp);
  }

  const rootIds = new Set(treeTitles.map((t) => t.rootId));
  for (const g of glyphs) {
    if (g.kind === 'stack') {
      const members = g.ids.map((id) => nodeById(id)).filter(Boolean);
      const dim = filtering && !members.some(matches);
      const grp = svgEl_('g', { class: 'glyph gv-stack' + (dim ? ' dim' : '') });
      grp.dataset.stackHead = g.head;
      grp.appendChild(svgEl_('title', {}, `${g.count} turns · ${g.headLabel} → ${g.tailLabel} · click to expand`));
      for (let i = 2; i >= 1; i--) {
        grp.appendChild(svgEl_('rect', {
          x: g.x - STACK_W / 2 + i * 3, y: g.y - STACK_H / 2 - i * 3, width: STACK_W, height: STACK_H, rx: 6, class: 'gv-card-back',
        }));
      }
      grp.appendChild(svgEl_('rect', { x: g.x - STACK_W / 2, y: g.y - STACK_H / 2, width: STACK_W, height: STACK_H, rx: 6, class: 'gv-card' }));
      grp.appendChild(svgEl_('text', { x: g.x, y: g.y + 4, 'text-anchor': 'middle', class: 'gv-card-count' }, '×' + g.count));
      grp.appendChild(svgEl_('text', { x: g.x, y: g.y + STACK_H / 2 + 14, 'text-anchor': 'middle', class: 'gv-card-range' },
        g.headLabel === g.tailLabel ? g.headLabel : `${g.headLabel}…${g.tailLabel}`));
      rootG.appendChild(grp);
      continue;
    }
    const isActive = g.id === view.activeId;
    const isViewed = g.id === view.viewedId && !isActive;
    const isSelected = g.id === view.selectedNodeId;
    const isLocked = !!view.lock && isActive;
    const cls = ['glyph', 'gv-node'];
    if (isActive) cls.push('active');
    if (g.bookmarked) cls.push('bm');
    if (g.wipe) cls.push('wipe');
    if (g.plain) cls.push('plain');
    if (isViewed) cls.push('viewed');
    if (isSelected) cls.push('selected');
    if (dimNode(g.node)) cls.push('dim');
    const grp = svgEl_('g', { class: cls.join(' ') });
    grp.dataset.id = g.id;
    // hover tooltip = the trigger (+ how many turns folded onto it)
    grp.appendChild(svgEl_('title', {}, (g.trigger || g.label) + (g.folded ? ` · ${g.folded} folded turn${g.folded === 1 ? '' : 's'}` : '')));
    const r = g.r;
    if (isLocked) {
      const ring = svgEl_('circle', { cx: g.x, cy: g.y, r: r + 6, class: 'gv-lock-ring' });
      ring.innerHTML = `<animate attributeName="r" values="${r + 6};${r + 12};${r + 6}" dur="1.4s" repeatCount="indefinite"/><animate attributeName="opacity" values="1;0.2;1" dur="1.4s" repeatCount="indefinite"/>`;
      grp.appendChild(ring);
    }
    if (isViewed) grp.appendChild(svgEl_('circle', { cx: g.x, cy: g.y, r: r + 5, class: 'gv-viewed-ring' }));
    if (isSelected) grp.appendChild(svgEl_('circle', { cx: g.x, cy: g.y, r: r + 7, class: 'gv-sel-ring' }));
    grp.appendChild(svgEl_('circle', { cx: g.x, cy: g.y, r, class: 'gv-body' }));
    grp.appendChild(svgEl_('text', { x: g.x, y: g.y + r + 14, 'text-anchor': 'middle', class: 'gv-lbl' }, g.label));
    // The bookmark caption sits ABOVE the node. A root's name is the tree title
    // already, so it is not repeated there.
    if (g.bookmarked && !rootIds.has(g.id)) {
      grp.appendChild(svgEl_('text', { x: g.x, y: g.y - r - 7, 'text-anchor': 'middle', class: 'gv-bm' }, bookmarkCaption(g.node)));
    }
    if (g.folded) {
      grp.appendChild(svgEl_('text', { x: g.x + r + 5, y: g.y + 4, class: 'gv-fold-n' }, '⋯' + g.folded));
    }
    rootG.appendChild(grp);
  }

  renderSleeves(sleeves, filtering, dimNode);
  applyCamera();
  updateHead();
  if (logRenderer && isLogMode()) logRenderer();

  const hitGlyph = (target) => {
    let el = target;
    while (el && el !== svgEl && !(el.dataset && (el.dataset.id || el.dataset.stackHead))) el = el.parentNode;
    return (el && el !== svgEl && el.dataset) ? el : null;
  };
  svgEl.onclick = (e) => {
    const el = hitGlyph(e.target);
    if (!el) return;
    if (el.dataset.stackHead) toggleStack(el.dataset.stackHead);
    else if (el.dataset.id) selectNode(el.dataset.id); // select only — no surface change
  };
  // double-click → open the node on the surface (a read-only preview)
  svgEl.ondblclick = (e) => {
    const el = hitGlyph(e.target);
    if (el && el.dataset.id) { closeFloatPreview(); openNode(el.dataset.id); }
  };
}

function toggleStack(head) {
  if (view.expandedStacks.has(head)) view.expandedStacks.delete(head);
  else view.expandedStacks.add(head);
  layoutAndRender();
}

/* ---------- sleeves: an expanded ×N stack, in place ----------
   HTML, not SVG, because it scrolls inside itself; it lives in #gv-world, which
   rides the same camera transform as the SVG. Header: ⊟ (collapse) + "N turns ·
   first → last" + the window ("1–8 of N"); body: the trunk line continuing
   through, one selectable row per real node and the faint ghost rows of the turns
   folded onto it; footer (only when it scrolls): "N more ↓" / "end of run". The
   copy never says "no surface change" — every row is a turn that DID change it. */
function renderSleeves(sleeves, filtering, dimNode) {
  if (!worldEl) return;
  worldEl.innerHTML = '';
  for (const s of sleeves) {
    const first = s.rows.find((r) => r.kind === 'node'), last = [...s.rows].reverse().find((r) => r.kind === 'node');
    const el = document.createElement('div');
    el.className = 'gv-sleeve' + (filtering && !s.ids.some((id) => matches(nodeById(id))) ? ' dim' : '');
    el.dataset.stackHead = s.head;
    Object.assign(el.style, { left: s.x + 'px', top: s.y + 'px', width: s.w + 'px', height: s.h + 'px' });
    const rows = s.rows.map((r) => {
      if (r.kind === 'ghost') {
        const tip = r.reply ? ` title="${esc('reply: ' + r.reply)}"` : '';
        return `<div class="gv-ghost${r.more ? ' more' : ''}" data-for="${esc(r.for)}"${tip}><span class="gdot"></span>` +
          `<span class="k">folded</span><span class="txt">${esc(r.text)}</span></div>`;
      }
      const n = r.n;
      const cls = ['gv-srow'];
      if (r.id === view.selectedNodeId) cls.push('selected');
      if (dimNode(n)) cls.push('dim');
      const t = nodeTime(n);
      return `<button type="button" class="${cls.join(' ')}" data-id="${esc(r.id)}" title="${esc(n.trigger_summary || n.label)}">` +
        `<span class="dot"></span><span class="id">${esc(n.label || r.id)}</span>` +
        `<span class="trig">${esc(n.trigger_summary || '')}</span><span class="t">${esc(t)}</span></button>`;
    }).join('');
    el.innerHTML =
      `<button type="button" class="gv-sleeve-head" data-collapse title="Collapse">` +
        `<span>⊟</span><span class="ttl">${s.ids.length} turns · ${esc(first.n.label)} → ${esc(last.n.label)}</span>` +
        `<span class="sp"></span><span class="pos"></span></button>` +
      `<div class="gv-sleeve-body" style="height:${s.viewH}px">` +
        `<div class="gv-sleeve-scroll"><div class="gv-sleeve-list" style="height:${s.contentH}px">` +
          `<div class="gv-sleeve-rail"></div>${rows}</div></div>` +
        (s.scrolls ? '<div class="gv-fade top"></div><div class="gv-fade bot"></div>' : '') +
      `</div>` +
      (s.scrolls ? '<div class="gv-sleeve-foot"></div>' : '');
    worldEl.appendChild(el);

    const scroller = el.querySelector('.gv-sleeve-scroll');
    const nodeRows = s.rows.filter((r) => r.kind === 'node');
    const updateWindow = () => {
      if (!s.scrolls) return;
      const top = scroller.scrollTop || 0;
      const visible = nodeRows.map((r, i) => ({ r, i }))
        .filter(({ r }) => r.top + ROW_H > top + SLEEVE_PAD - 1 && r.top < top + s.viewH - SLEEVE_PAD + 1);
      const a = visible.length ? visible[0].i + 1 : 1;
      const b = visible.length ? visible[visible.length - 1].i + 1 : Math.min(SLEEVE_CAP, nodeRows.length);
      el.querySelector('.pos').textContent = `${a}–${b} of ${nodeRows.length}`;
      const more = nodeRows.length - b;
      el.querySelector('.gv-sleeve-foot').textContent = more > 0 ? `${more} more ↓` : `end of run${a > 1 ? ` · ${a - 1} above` : ''}`;
    };
    scroller.scrollTop = sleeveScroll.get(s.head) || 0;
    updateWindow();
    scroller.addEventListener('scroll', () => { sleeveScroll.set(s.head, scroller.scrollTop); updateWindow(); });
    // The wheel scrolls the run, not the canvas zoom, while it is over a sleeve
    // that has somewhere to scroll.
    el.addEventListener('wheel', (e) => { if (s.scrolls) e.stopPropagation(); });
  }
}

// The ONE place that decides where the camera goes to put the whole graph in the
// middle of the viewport. `pickScale` is the only thing its two callers differ on:
// Fit chooses a scale that makes everything visible, the zoom badge resets to a
// true 1:1. Bounds include sleeves (they are wider than a glyph).
function centerGraph(pickScale) {
  const { glyphs, sleeves } = computeGraphLayout();
  if (!glyphs.length && !sleeves.length) return;
  const xs = [], ys = [];
  for (const g of glyphs) { xs.push(g.x); ys.push(g.y); }
  for (const s of sleeves) { xs.push(s.x, s.x + s.w); ys.push(s.y, s.y + s.h); }
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minY = Math.min(...ys), maxY = Math.max(...ys);
  const w = svgEl.clientWidth || 800, h = svgEl.clientHeight || 600;
  const scale = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, pickScale({
    w, h, contentW: (maxX - minX) + 160, contentH: (maxY - minY) + 200,
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

// Clicking the zoom percentage: back to a true 1:1, graph centred.
export function resetView() { centerGraph(() => 1); }

// Wire the overlay-internal controls. NOT wired here: the topbar's Graph button
// (topbar module → openOverlay) and ◇ New (shell.js, which owns the new-graph
// panel). Called once at bootstrap.
export function initGraph() {
  $('overlay-close').addEventListener('click', closeOverlay);
  $('overlay-fit').addEventListener('click', fitView);
  document.addEventListener('keydown', (e) => {
    // Escape is NOT handled here: it has one owner (shell.js handleEscape), which
    // calls escapeInOverlay() for the overlay's own layers.
    if (e.key === 'Escape') return;
    if (overlayEl.classList.contains('hidden')) return;
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const id = view.selectedNodeId;
    if (e.key === 'ArrowUp') { e.preventDefault(); moveSelection('up'); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); moveSelection('down'); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); moveSelection('left'); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); moveSelection('right'); }
    else if (e.key === ' ') { e.preventDefault(); toggleFloatPreview(); }
    else if (e.key === 'Enter') { e.preventDefault(); if (id) openNode(id); }
    // Guarded exactly as the Set active button is (updateSidebarButtons): not on
    // the node that is already active, and not while a turn holds the lock.
    else if (e.key === 'a' || e.key === 'A') { e.preventDefault(); if (id && id !== view.activeId && !view.lock) setActive(id); }
    else if (e.key === 'e' || e.key === 'E') { e.preventDefault(); if (id) exportNode(id); }
    else if (e.key === 'b' || e.key === 'B') { e.preventDefault(); if (id) bookmarkNode(id); }
    else if (e.key === 'r' || e.key === 'R') { e.preventDefault(); if (id) openReplay({ to: id }); }
  });

  // inspector actions (delegated — the inspector is re-rendered per selection)
  $('gv-inspector').addEventListener('click', (e) => {
    const b = e.target.closest('[data-act]'); if (!b || b.disabled) return;
    if (b.dataset.act === 'close') { deselect(); return; }
    const id = view.selectedNodeId; if (!id) return;
    ({ active: () => setActive(id), branch: () => branchFrom(id), glance: () => toggleFloatPreview(),
       bookmark: () => bookmarkNode(id), unmark: () => unmarkNode(id), export: () => exportNode(id),
       replay: () => openReplay({ to: id }) })[b.dataset.act]?.();
  });

  // ⚑ Marked / ⑃ Forks — independent toggles; they dim, never hide
  $('gv-filters').addEventListener('click', (e) => {
    const c = e.target.closest('[data-filter]'); if (!c) return;
    toggleFilter(c.dataset.filter);
  });
  $('gv-collapse-all').addEventListener('click', () => { view.expandedStacks.clear(); layoutAndRender(); });

  // jump search: dims non-matches as you type; ↵ selects + centres the next hit
  const jump = $('gv-jump');
  jump.addEventListener('input', () => setQuery(jump.value));
  jump.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); jumpToNextMatch(); } });

  // sleeves: ⊟ collapses, a row selects, a double-click opens
  worldEl.addEventListener('click', (e) => {
    const head = e.target.closest('[data-collapse]');
    if (head) { toggleStack(head.closest('.gv-sleeve').dataset.stackHead); return; }
    const row = e.target.closest('.gv-srow');
    if (row) selectNode(row.dataset.id);
  });
  worldEl.addEventListener('dblclick', (e) => {
    const row = e.target.closest('.gv-srow');
    if (row) { closeFloatPreview(); openNode(row.dataset.id); }
  });

  // the one name field (graph rename + node bookmark) — see openNamePanel
  const onEl = (id, ev, fn) => { const el = $(id); if (el) el.addEventListener(ev, fn); };
  onEl('btn-gv-name-go', 'click', commitName);
  onEl('btn-gv-name-cancel', 'click', closeNamePanel);
  onEl('gv-name-input', 'keydown', (e) => {
    // Escape here is the field's own; stop it before the document owner reads it
    // as "close the overlay".
    if (e.key === 'Enter') { e.preventDefault(); commitName(); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeNamePanel(); }
  });

  // zoom controls — all go through setZoom / centerGraph
  $('gv-zoom-pct').addEventListener('click', resetView);
  $('gv-zoom-in').addEventListener('click', () => setZoom(camera.scale * 1.2));
  $('gv-zoom-out').addEventListener('click', () => setZoom(camera.scale / 1.2));

  // pan, graph placement & zoom
  // Pointer events, not mouse events: a touch drag never produces mousemove. One
  // pointer drives it — the first one down; a second finger is ignored rather
  // than yanking the camera between two contact points — and the canvas declares
  // `touch-action: none` (app.css) so the browser hands the drag to us.
  (() => {
    const wrap = svgEl.parentElement;
    let panning = false, sx = 0, sy = 0, stx = 0, sty = 0;
    let dragPointer = null;   // the pointerId that owns the current pan / heading drag
    // Dragging a graph HEADING moves that tree; dragging empty canvas pans; a
    // glyph or a sleeve owns its own click. One pointerdown, three destinations.
    let titleDrag = null;
    const DRAG_SLOP = 4; // px before a press on the heading counts as a drag, not a click
    const mine = (e) => dragPointer == null || e.pointerId == null || e.pointerId === dragPointer;

    wrap.addEventListener('pointerdown', (e) => {
      if (!e.target.closest) return;
      if (e.button != null && e.button > 0) return;     // primary button / touch / pen only
      // A second finger mid-drag is ignored (only a DIFFERENT pointer: a mouse
      // whose pointerup was lost presses again with the same id).
      if (dragPointer != null && e.pointerId !== dragPointer) return;
      if (e.target.closest('.glyph') || e.target.closest('.gv-sleeve')) return;
      const heading = e.target.closest('.gv-tree-title');
      if (heading && heading.dataset.graphRoot) {
        const [ox, oy] = offsetFor(heading.dataset.graphRoot);
        titleDrag = { rootId: heading.dataset.graphRoot, sx: e.clientX, sy: e.clientY, ox, oy, moved: false };
        dragPointer = e.pointerId ?? null;
        e.preventDefault();
        return;
      }
      panning = true; sx = e.clientX; sy = e.clientY; stx = camera.tx; sty = camera.ty;
      dragPointer = e.pointerId ?? null;
      try { wrap.setPointerCapture(e.pointerId); } catch {}
    });
    const endDrag = (e, cancelled) => {
      if (!mine(e)) return;
      dragPointer = null;
      if (titleDrag) {
        const d = titleDrag;
        titleDrag = null;
        // Moved → persist the placement. Didn't move → it was a click: rename.
        // A cancelled pointer (the OS took the touch) is neither.
        if (d.moved) { const [dx, dy] = offsetFor(d.rootId); setOffset(d.rootId, dx, dy, true); }
        else if (!cancelled) renameGraph(d.rootId);
        return;
      }
      panning = false;
    };
    window.addEventListener('pointerup', (e) => endDrag(e, false));
    window.addEventListener('pointercancel', (e) => endDrag(e, true));
    window.addEventListener('pointermove', (e) => {
      if (!mine(e)) return;
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
      applyCamera();                   // camera only — no relayout per pointermove
    });
    wrap.addEventListener('wheel', (e) => {
      e.preventDefault();
      const rect = svgEl.getBoundingClientRect();
      setZoom(camera.scale * Math.exp(-e.deltaY * 0.0015),
        { x: e.clientX - rect.left, y: e.clientY - rect.top });
    }, { passive: false });
  })();
}
