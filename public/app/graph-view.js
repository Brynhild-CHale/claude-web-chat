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
import { previewNode, ensureGraph } from './topbar.js';

const overlayEl = $('overlay');
const svgEl = $('graph-svg');
let camera = { tx: 0, ty: 0, scale: 1 };
let historyScope = 'all';              // 'all' | 'graph' (just the selected node's tree)
const historyFilters = new Set();      // subset of {'marked','forks'} — independent toggles, union

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
  fitView();
}

export function closeOverlay() { closeFloatPreview(); overlayEl.classList.add('hidden'); }

export function isOverlayOpen() { return !overlayEl.classList.contains('hidden'); }

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
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// The top-level tree a node belongs to (walk parents to the rootless ancestor).
function rootOf(id) {
  let cur = nodeById(id), guard = 0;
  while (cur && cur.parent_id && guard++ < 500) cur = nodeById(cur.parent_id);
  return cur ? cur.id : null;
}

// --- history list (left column) ---
// Scope ('all' vs the selected node's graph) then the union of active toggle
// filters (marked / forks); no filter active → everything in scope.
function historyRows() {
  let ns = (view.graphCache?.nodes || []).slice().sort((a, b) => (a.created_at - b.created_at) || (seqNum(a.id) - seqNum(b.id)));
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
  const tc = $('gv-turncount'); if (tc) tc.textContent = (view.graphCache?.nodes || []).length;
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
    row.addEventListener('click', () => { selectNode(n.id); centerOn(n.id); });
    row.addEventListener('dblclick', () => { openNode(n.id); });
    list.appendChild(row);
  }
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

  box.innerHTML =
    `<div class="gv-preview" id="gv-preview"></div>` +
    `<div><span class="gv-insp-label">${esc(node.label || id)}</span><span class="gv-chip-state ${st.cls}">${esc(st.text)}</span></div>` +
    `<div class="gv-lineage">${lineage}</div>` +
    `<div class="gv-meta"><span class="k">AUTHOR</span><span class="v">${esc(node.author || '—')}</span><span class="k">COMMITTED</span><span class="v">${esc(committed)}</span></div>` +
    `<div class="gv-sect">TRIGGER</div><div class="gv-trigger">${esc(trigger)}</div>` +
    `<div class="gv-sect">RENDERED · ${mounts.length} pane${mounts.length === 1 ? '' : 's'}</div><div class="gv-panes">${paneRows}</div>` +
    `<div class="gv-sect" id="gv-diff-sect">DIFF vs parent</div><div class="gv-diff" id="gv-diff"><span class="muted small">…</span></div>` +
    `<div class="gv-actions">` +
      `<button class="gv-act primary" id="gv-set-active" data-act="active">Set active</button>` +
      `<button class="gv-act" data-act="open" title="Open on the surface (↵)">⤢ Open</button>` +
      `<button class="gv-act" data-act="glance" title="Glance preview (Space)">◉</button>` +
      `<button class="gv-act" data-act="bookmark" title="Bookmark (B)">⚑</button>` +
      `<button class="gv-act" data-act="export" title="Export (E)">↧</button>` +
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
  box.insertBefore(fr, box.firstChild);
}

async function renderDiff(id, node) {
  const el = $('gv-diff');
  const sect = $('gv-diff-sect');
  if (!el) return;
  const n = nodeById(id) || node;
  if (!n || !n.parent_id) { if (sect) sect.style.display = 'none'; el.style.display = 'none'; return; }
  const parentLabel = labelFor(n.parent_id);
  if (sect) { sect.style.display = ''; sect.textContent = 'DIFF vs parent ' + parentLabel; }
  el.style.display = '';
  try {
    const d = await fetch(`/api/graph/diff?a=${encodeURIComponent(n.parent_id)}&b=${encodeURIComponent(id)}`).then((r) => r.ok ? r.json() : null);
    const m = (d && d.mounts) || {};
    const add = (m.added || []).length, chg = (m.changed || []).length, rm = (m.removed || []).length;
    el.innerHTML = `<span class="add">+${add} pane${add === 1 ? '' : 's'}</span><span class="chg">~${chg} changed</span><span class="rm">${rm} removed</span>`;
  } catch { el.innerHTML = '<span class="muted small">diff unavailable</span>'; }
}

function updateStatus() {
  const a = $('gv-status-active'); if (a) a.textContent = (view.activeId ? labelFor(view.activeId) + ' active' : '—');
  const c = $('gv-status-counts');
  if (c) {
    const nodes = view.graphCache?.nodes || [];
    const forks = nodes.filter((n) => isFork(n)).length;
    const marks = nodes.filter((n) => n.name).length;
    c.textContent = `${nodes.length} turns · ${forks} fork${forks === 1 ? '' : 's'} · ${marks} mark${marks === 1 ? '' : 's'}`;
  }
  const g = $('gv-graphsel');
  if (g) { const root = lineageOf(view.selectedNodeId || view.activeId)[0]; g.textContent = 'graph ' + (root ? (root.label || root.id).split('.')[0] : '—'); }
}

// open a node fully on the surface (leaves the overlay)
function openNode(id) { view.selectedNodeId = id; previewNode(id); overlayEl.classList.add('hidden'); }

// set a node active (commits the next turn there / branches)
async function setActive(id) {
  if (!id) return;
  const r = await fetch('/api/graph/active', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }),
  });
  if (!r.ok) { const err = await r.json().catch(() => ({})); alert('failed: ' + (err.error || r.statusText)); return; }
  view.previewing = false; view.liveSnapshot = null;
  $('main').classList.remove('preview-readonly');
  await refreshGraph();
  renderHistory();
}

function exportNode(id) {
  const a = document.createElement('a');
  a.href = '/api/export/' + encodeURIComponent(id); a.download = '';
  document.body.appendChild(a); a.click(); a.remove();
}

async function bookmarkNode(id) {
  const n = nodeById(id);
  const name = prompt('Bookmark name (empty to clear):', (n && n.name) || '');
  if (name === null) return;
  await fetch('/api/graph/bookmark', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, name: name.trim() }),
  });
  await refreshGraph();
  renderHistory();
  renderInspector(id);
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
      view.selectedNodeId = nid; previewNode(nid); overlayEl.classList.add('hidden');
    });
    floatEl.querySelector('[data-act="active"]').addEventListener('click', async () => {
      const nid = floatEl.dataset.nodeId;
      const r = await fetch('/api/graph/active', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: nid }),
      });
      if (!r.ok) { const err = await r.json().catch(() => ({})); alert('failed: ' + (err.error || r.statusText)); return; }
      view.previewing = false; view.liveSnapshot = null;
      $('main').classList.remove('preview-readonly');
      closeFloatPreview(); overlayEl.classList.add('hidden');
      await refreshGraph();
    });
  }
  floatEl.dataset.nodeId = id;
  floatEl.querySelector('.glance-title').textContent = 'preview ' + labelFor(id);
  const frame = floatEl.querySelector('.glance-frame');
  const src = '/preview/node/' + id;
  if (frame.getAttribute('src') !== src) frame.setAttribute('src', src);
}
function closeFloatPreview() { if (floatEl) { floatEl.remove(); floatEl = null; } }
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
  const nodes = view.graphCache.nodes;
  const byId = new Map(nodes.map(n => [n.id, n]));
  const childMap = new Map();
  for (const n of nodes) {
    const p = n.parent_id;
    if (p == null || !byId.has(p)) continue;
    if (!childMap.has(p)) childMap.set(p, []);
    childMap.get(p).push(n.id);
  }
  for (const arr of childMap.values()) {
    arr.sort((a, b) => (byId.get(a).created_at - byId.get(b).created_at) || (seqNum(a) - seqNum(b)));
  }
  const isBreakout = (id) => {
    const kids = childMap.get(id) || [];
    const n = byId.get(id);
    return kids.length > 1 || n.bookmarked || id === view.activeId || id === view.viewedId;
  };
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
  const cur = nodeById(view.selectedNodeId) || nodeById(view.activeId) || view.graphCache.nodes[0];
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
      : view.graphCache.nodes.filter(n => n.parent_id == null).sort((a, b) => (a.created_at - b.created_at) || (seqNum(a.id) - seqNum(b.id)));
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
  const nodes = view.graphCache ? view.graphCache.nodes : [];
  const byId = new Map(nodes.map(n => [n.id, n]));
  const childMap = new Map();
  for (const n of nodes) {
    const p = n.parent_id;
    if (p == null || !byId.has(p)) continue;
    if (!childMap.has(p)) childMap.set(p, []);
    childMap.get(p).push(n.id);
  }
  for (const arr of childMap.values()) {
    arr.sort((a, b) => (byId.get(a).created_at - byId.get(b).created_at) || (seqNum(a) - seqNum(b)));
  }
  const roots = nodes
    .filter(n => n.parent_id == null || !byId.has(n.parent_id))
    .map(n => n.id)
    .sort((a, b) => (byId.get(a).created_at - byId.get(b).created_at) || (seqNum(a) - seqNum(b)));

  const glyphs = [];
  const edges = [];
  // frontier = x of the next free column; branches and new trees allocate here
  // so they always sit to the right of everything placed so far (incl. snakes).
  let frontier = 0;
  const bumpFrontier = (x) => { if (x + DX > frontier) frontier = x + DX; };

  const isBreakout = (id) => {
    const kids = childMap.get(id) || [];
    const n = byId.get(id);
    return kids.length > 1 || n.bookmarked || id === view.activeId || id === view.viewedId;
  };
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
    const first = walk(r, frontier, 0);
    const rn = byId.get(r);
    if (first && rn) treeTitles.push({ x: first.x, y: first.y, graphLabel: (rn.label || '').replace(/\.0$/, ''), name: rn.name || '' });
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

  // Tree titles (one per top-level graph), above each column.
  for (const tt of (treeTitles || [])) {
    const grp = svgEl_('g', {});
    const t = svgEl_('text', {
      x: tt.x, y: tt.y - 34, 'text-anchor': 'middle',
      'font-family': mono('ui-monospace, Menlo, monospace'), 'font-size': '12', 'font-weight': '700',
      fill: tt.name ? gold('#9a6700') : muted('#57606a'),
    });
    t.textContent = (tt.name ? '🔖 ' : '') + (tt.name || ('graph ' + tt.graphLabel));
    grp.appendChild(t);
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
      overlayEl.classList.add('hidden');
    }
  };
}

export function fitView() {
  const { glyphs } = computeGraphLayout();
  if (!glyphs.length) return;
  const xs = glyphs.map(g => g.x), ys = glyphs.map(g => g.y);
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minY = Math.min(...ys), maxY = Math.max(...ys);
  const w = svgEl.clientWidth || 800, h = svgEl.clientHeight || 600;
  const contentW = (maxX - minX) + 160, contentH = (maxY - minY) + 160;
  const scale = Math.min(1.4, Math.max(0.35, Math.min(w / contentW, h / contentH)));
  camera.scale = scale;
  camera.tx = w / 2 - ((minX + maxX) / 2) * scale;
  camera.ty = h / 2 - ((minY + maxY) / 2) * scale;
  layoutAndRender();
}

// Wire the overlay-internal controls: fit/close buttons, the document keydown
// handler (Escape/arrows/space, active only while the overlay is open), the
// set-active sidebar button, and the pan&zoom on the canvas wrap. NOT wired here:
// the topbar's Graph button that opens the overlay (it lives in the topbar module
// and calls the exported openOverlay). Called once at bootstrap.
export function initGraph() {
  $('overlay-close').addEventListener('click', closeOverlay);
  $('overlay-fit').addEventListener('click', fitView);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (floatEl) { closeFloatPreview(); return; }
      if (!overlayEl.classList.contains('hidden')) overlayEl.classList.add('hidden');
      return;
    }
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

  // zoom controls
  const zoomBy = (f) => { camera.scale = Math.max(0.2, Math.min(3, camera.scale * f)); layoutAndRender(); const p = $('gv-zoom-pct'); if (p) p.textContent = Math.round(camera.scale * 100) + '%'; };
  $('gv-zoom-in').addEventListener('click', () => zoomBy(1.2));
  $('gv-zoom-out').addEventListener('click', () => zoomBy(1 / 1.2));

  // pan & zoom
  (() => {
    const wrap = document.querySelector('.graph-canvas-wrap');
    let panning = false, sx = 0, sy = 0, stx = 0, sty = 0;
    wrap.addEventListener('mousedown', (e) => {
      if (e.target.closest && e.target.closest('.glyph')) return;
      panning = true; sx = e.clientX; sy = e.clientY; stx = camera.tx; sty = camera.ty;
    });
    window.addEventListener('mouseup', () => { panning = false; });
    window.addEventListener('mousemove', (e) => {
      if (!panning) return;
      camera.tx = stx + (e.clientX - sx);
      camera.ty = sty + (e.clientY - sy);
      layoutAndRender();
    });
    wrap.addEventListener('wheel', (e) => {
      e.preventDefault();
      const factor = Math.exp(-e.deltaY * 0.0015);
      const rect = svgEl.getBoundingClientRect();
      const mx = e.clientX - rect.left, my = e.clientY - rect.top;
      const newScale = Math.max(0.2, Math.min(3, camera.scale * factor));
      camera.tx = mx - (mx - camera.tx) * (newScale / camera.scale);
      camera.ty = my - (my - camera.ty) * (newScale / camera.scale);
      camera.scale = newScale;
      layoutAndRender();
    }, { passive: false });
  })();
}
