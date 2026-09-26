// The phone graph (design "Graph Prototype", phone view): the graph screen as a
// newest-first LOG of one graph instead of a canvas a finger cannot work.
//
//   header   ◇ GRAPH · the graph switcher ("name ▾") · ◇ new · ✕
//            the jump search (hides non-matches) · ⚑ Marked / ⑃ Forks / ⋯ N folded
//   list     one card per drawn turn — id, ⚑ name, ACTIVE, ⑃, time, a two-line
//            trigger, the sections it changed ("# Results +2 ~1"), "⋯ N folded" —
//            behind a fork gutter; ⋯ N folded shows the faint ghost rows of the
//            turns that folded onto each card
//   bar      the selected turn · ◫ Glance (a bottom sheet) · ⚑ with a name field
//            (Unmark on a marked turn) · ⑃ Branch · ↧ Export · Set active
//
// Everything topological is graph-view's DISPLAY topology (graphIndex): which
// turns exist, their drawn parents, forks, folded counts, ghost texts. The gutter
// is computed from those parents (log-lanes.js) — never hand-placed — and the
// actions are graph-view's own (one POST for set active, one bookmark route, one
// export), so the phone cannot drift from the desktop canvas.
//
// Shown only while #overlay has .log-mode (graph-view openOverlay, on a phone);
// graph-view calls renderLog on every redraw through setLogRenderer.
import { view, $ } from './state.js';
import { labelFor, seqNum, nodeTime } from './labels.js';
import {
  graphIndex, matches, isFiltering, toggleFilter, setQuery, isFork, foldedCount, ghostRowsFor,
  graphNameOf, setActive, branchFrom, exportNode, saveName, unmarkNode, toggleFloatPreview,
  closeOverlay, setLogRenderer, isLogMode,
} from './graph-view.js';
import { computeLogLanes, laneX, gutterWidth } from './log-lanes.js';

let showFolded = false;   // ⋯ N folded: the ghost rows under every card
let naming = false;       // the bar's bookmark-name field is open

// Section-change chips: what each turn changed, per #/## heading of its page,
// against its parent — computed by the daemon from the pages it holds
// (GET /api/graph/changes; lib/server/domain/lineage sectionChanges). A
// committed node never changes, so an answer is kept; the log asks again only
// when it shows a turn the last answer did not cover (a new commit).
const changesById = new Map();
const changesCovered = new Set();
let changesInFlight = null;
function loadChanges(ids) {
  if (changesInFlight || ids.every((id) => changesCovered.has(id))) return;
  changesInFlight = (async () => {
    try {
      const r = await fetch('/api/graph/changes');
      const body = r.ok ? await r.json() : null;
      const got = (body && body.changes && typeof body.changes === 'object') ? body.changes : {};
      for (const id of ids) changesCovered.add(id);   // asked: an absent id changed no section
      for (const [id, c] of Object.entries(got)) { changesById.set(id, Array.isArray(c) ? c : []); changesCovered.add(id); }
    } catch {
      for (const id of ids) changesCovered.add(id);   // no chips beats a request per redraw
    } finally { changesInFlight = null; }
    renderLog();
  })();
}
// "+2 ~1 −1": added, changed, removed.
export function changeCounts(c) {
  return [c.add ? '+' + c.add : '', c.chg ? '~' + c.chg : '', c.rm ? '−' + c.rm : ''].filter(Boolean).join(' ');
}
function changeChips(id) {
  const list = changesById.get(id);
  if (!list || !list.length) return null;
  const box = el('div', 'gv-lcard-chips');
  for (const c of list) {
    const chip = el('span', 'gv-chg');
    if (c.h) chip.appendChild(el('span', 'h', c.h));
    chip.appendChild(el('span', 'sec', c.sec || ''));
    chip.appendChild(el('span', 'n ' + (c.add ? 'add' : c.chg ? 'chg' : 'rm'), changeCounts(c)));
    chip.title = `${c.h ? c.h + ' ' : ''}${c.sec}: ${[c.add && `${c.add} added`, c.chg && `${c.chg} changed`, c.rm && `${c.rm} removed`].filter(Boolean).join(', ')}`;
    box.appendChild(chip);
  }
  return box;
}

const SVGNS = 'http://www.w3.org/2000/svg';
function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;   // text, never markup: names and triggers are user text
  return e;
}
function svg(tag, attrs) {
  const e = document.createElementNS(SVGNS, tag);
  for (const k in attrs) e.setAttribute(k, attrs[k]);
  return e;
}
const newestFirst = (a, b) => (b.created_at - a.created_at) || (seqNum(b.id) - seqNum(a.id));

// The graph the log shows: the selected turn's, else the active node's, else the
// newest. The switcher moves the selection into another graph, so it follows.
function currentRoot(idx) {
  const anchor = [view.selectedNodeId, view.activeId].find((id) => id && idx.byId.has(id));
  if (anchor) return idx.rootOf(anchor);
  const newest = idx.nodes.slice().sort(newestFirst)[0];
  return newest ? idx.rootOf(newest.id) : null;
}
// The drawn turns of one graph (a walk down its display children).
function treeNodes(idx, root) {
  const out = [];
  const stack = root ? [root] : [];
  while (stack.length) {
    const id = stack.pop();
    const n = idx.byId.get(id);
    if (!n) continue;
    out.push(n);
    for (const c of idx.childrenOf(id)) stack.push(c.id);
  }
  return out.sort(newestFirst);
}

// One gutter cell: the lane lines through this row, the merge curves into it,
// and (for a card) the dot. Width is the whole log's, so every row lines up.
function gutter(width, { lines = [], merges = [] }, dot) {
  const g = el('div', 'gv-gutter');
  g.style.width = width + 'px';
  const s = svg('svg', { viewBox: `0 0 ${width} 100`, preserveAspectRatio: 'none', 'aria-hidden': 'true' });
  for (const l of lines) {
    s.appendChild(svg('line', { x1: laneX(l.lane), x2: laneX(l.lane), y1: l.y1, y2: l.y2, class: 'gv-lane', 'vector-effect': 'non-scaling-stroke' }));
  }
  for (const m of merges) {
    const a = laneX(m.from), b = laneX(m.to);
    s.appendChild(svg('path', { d: `M${a} 0 C${a} 34 ${b} 22 ${b} 50`, class: 'gv-lane gv-merge', 'vector-effect': 'non-scaling-stroke' }));
  }
  g.appendChild(s);
  if (dot) {
    const d = el('span', dot.cls);
    d.style.left = (laneX(dot.lane) - 5) + 'px';
    g.appendChild(d);
  }
  return g;
}

function renderSwitcher(idx, root) {
  const sel = $('gv-log-graph');
  if (!sel) return;
  sel.innerHTML = '';
  for (const r of idx.roots) {
    const o = el('option', null, graphNameOf(r));
    o.value = r;
    if (r === root) o.selected = true;
    sel.appendChild(o);
  }
}

export function renderLog() {
  const list = $('gv-log-list');
  if (!list || !isLogMode()) return;
  const idx = graphIndex();
  const root = currentRoot(idx);
  renderSwitcher(idx, root);
  const nodes = treeNodes(idx, root);

  const folded = nodes.reduce((a, n) => a + foldedCount(n), 0);
  const fchip = document.querySelector('#gv-log-filters [data-folded]');
  if (fchip) {
    fchip.hidden = !folded;
    fchip.textContent = `⋯ ${folded} folded`;
    fchip.classList.toggle('on', showFolded);
    fchip.setAttribute('aria-pressed', String(showFolded));
  }

  // Filtering HIDES here (a list has no shape to keep, unlike the canvas, which
  // dims) and drops the gutter's lines, which would join rows that are no longer
  // neighbours.
  const filtering = isFiltering();
  const shown = filtering ? nodes.filter(matches) : nodes;
  const lanes = computeLogLanes(nodes.map((n) => {
    const p = idx.parentOf(n.id);
    return { id: n.id, parent: p ? p.id : null };
  }));
  const byRow = new Map(lanes.rows.map((r) => [r.id, r]));
  const width = gutterWidth(filtering ? 1 : lanes.lanes);

  list.innerHTML = '';
  for (const n of shown) {
    const lane = byRow.get(n.id);
    const isActive = n.id === view.activeId;
    const isSel = n.id === view.selectedNodeId;
    const row = el('div', 'gv-lrow');
    row.dataset.id = n.id;
    const dotCls = 'gv-ldot' + (isActive ? ' active' : n.bookmarked ? ' bm' : '') + (isSel ? ' selected' : '');
    row.appendChild(gutter(width, filtering ? {} : lane, { lane: filtering ? 0 : lane.col, cls: dotCls }));

    const card = el('button', 'gv-lcard' + (isActive ? ' active' : '') + (isSel ? ' selected' : ''));
    card.type = 'button';
    card.dataset.id = n.id;
    const top = el('div', 'gv-lcard-top');
    top.appendChild(el('span', 'id', n.label || n.id));
    if (n.bookmarked) top.appendChild(el('span', 'bm', (n.wipe ? '⌫ wipe' : '⚑') + (n.name ? ' ' + n.name : '')));
    if (isActive) top.appendChild(el('span', 'gv-badge active', 'ACTIVE'));
    if (isFork(n)) top.appendChild(el('span', 'gv-badge fork', '⑃'));
    top.appendChild(el('span', 'sp'));
    top.appendChild(el('span', 't', nodeTime(n)));
    card.appendChild(top);
    card.appendChild(el('div', 'gv-lcard-trig', n.trigger_summary || '(no trigger)'));
    const chips = changeChips(n.id);
    if (chips) card.appendChild(chips);
    const nf = foldedCount(n);
    if (nf) card.appendChild(el('div', 'gv-lcard-folded', `⋯ ${nf} folded`));
    row.appendChild(card);
    list.appendChild(row);

    if (showFolded && nf) {
      const cont = filtering ? [] : lane.below.map((k) => ({ lane: k, y1: 0, y2: 100 }));
      for (const gr of ghostRowsFor(n)) {
        const gRow = el('div', 'gv-lrow ghost');
        gRow.appendChild(gutter(width, { lines: cont }, { lane: filtering ? 0 : lane.col, cls: 'gv-ldot ghost' }));
        const body = el('div', 'gv-lghost' + (gr.more ? ' more' : ''));
        if (gr.reply) body.title = 'reply: ' + gr.reply;
        if (!gr.more) body.appendChild(el('span', 'k', 'folded'));
        body.appendChild(el('span', 'txt', gr.text));
        gRow.appendChild(body);
        list.appendChild(gRow);
      }
    }
  }
  if (!shown.length) list.appendChild(el('div', 'gv-log-empty', filtering ? 'No turns match.' : 'No turns yet.'));
  loadChanges(nodes.map((n) => n.id));
  renderBar();
}

// The action bar describes the selection and gates what cannot apply to it.
function renderBar() {
  const id = view.selectedNodeId;
  const idx = graphIndex();
  const n = id ? idx.byId.get(id) : null;
  const selEl = $('gv-log-sel'); if (selEl) selEl.textContent = n ? labelFor(id) : '—';
  const acts = $('gv-log-acts');
  if (!acts) return;
  const isActive = !!n && id === view.activeId;
  for (const b of acts.querySelectorAll('[data-act]')) {
    const act = b.dataset.act;
    b.disabled = !n || ((act === 'active' || act === 'branch') && (isActive || !!view.lock));
  }
  const bm = acts.querySelector('[data-act="bookmark"]');
  if (bm) {
    const marked = !!(n && n.bookmarked);
    bm.classList.toggle('on', marked);
    bm.title = marked ? 'Remove the bookmark' : 'Bookmark';
    bm.setAttribute('aria-label', bm.title);
  }
  const act = $('gv-log-active');
  if (act) act.textContent = view.lock ? 'Locked' : (isActive ? 'Active' : 'Set active');
  const box = $('gv-log-naming'); if (box) box.classList.toggle('hidden', !naming || !n);
}

function select(id) {
  view.selectedNodeId = id;
  naming = false;
  renderLog();
}

function openNaming() {
  naming = true;
  renderBar();
  const inp = $('gv-log-name');
  if (inp) { inp.value = ''; setTimeout(() => { if (naming) inp.focus(); }, 0); }
}
function closeNaming() { naming = false; renderBar(); }
async function commitName() {
  const id = view.selectedNodeId;
  const inp = $('gv-log-name');
  const name = ((inp && inp.value) || '').trim();
  naming = false;
  if (!id) return;
  // An empty field still marks the turn — named by its label, as the canvas
  // would caption it — rather than silently doing nothing.
  await saveName(id, name || labelFor(id));
}

export function initGraphLog() {
  setLogRenderer(renderLog);
  const on = (id, ev, fn) => { const e = $(id); if (e) e.addEventListener(ev, fn); };

  on('gv-log-list', 'click', (e) => {
    const card = e.target.closest && e.target.closest('.gv-lcard');
    if (card) select(card.dataset.id);
  });
  on('gv-log-close', 'click', closeOverlay);
  on('gv-log-graph', 'change', (e) => {
    // Into another graph: land on its active node when it holds it, else its newest turn.
    const idx = graphIndex();
    const nodes = treeNodes(idx, e.target.value);
    const pick = nodes.find((n) => n.id === view.activeId) || nodes[0];
    if (pick) select(pick.id);
  });
  on('gv-log-q', 'input', (e) => setQuery(e.target.value));
  on('gv-log-filters', 'click', (e) => {
    const c = e.target.closest && e.target.closest('button');
    if (!c) return;
    if (c.hasAttribute('data-folded')) { showFolded = !showFolded; renderLog(); return; }
    if (c.dataset.filter) toggleFilter(c.dataset.filter);
  });
  on('gv-log-acts', 'click', (e) => {
    const b = e.target.closest && e.target.closest('[data-act]');
    const id = view.selectedNodeId;
    if (!b || b.disabled || !id) return;
    const n = graphIndex().byId.get(id);
    ({
      glance: () => toggleFloatPreview(),
      bookmark: () => { if (n && n.bookmarked) unmarkNode(id); else if (naming) closeNaming(); else openNaming(); },
      branch: () => branchFrom(id),
      export: () => exportNode(id),
      active: () => setActive(id),
    })[b.dataset.act]?.();
  });
  on('gv-log-name-save', 'click', commitName);
  on('gv-log-name', 'keydown', (e) => {
    // The field's own Escape — stop it before the document owner closes the graph.
    if (e.key === 'Enter') { e.preventDefault(); commitName(); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeNaming(); }
  });
}
