// lib/server/domain/refs.js — the one node-reference resolver.
//
// A node is named four ways across the tree: a hierarchical label (`n1.7`, the
// only name the user ever sees), an opaque stored id (`n5`), `active` (the
// commit point) and `live` (the uncommitted surface). Resolving those lived in
// three places — export's nodeForExport, the diff route's resolveRef, and the
// label → id scan inside each — and they had already drifted in the one place
// that matters to a reader: which name wins when a label and an id could both
// match, and what `live` carries for a theme. This is the single home now; every
// route or tool that takes a node ref goes through resolveNodeRef.
//
// Pure and stateless like the rest of domain/: it reads the `graph` object it is
// handed and never writes to it. `computeLabels` is required LAZILY for the same
// reason turns.js does it — graph.js top-imports domain modules, so a top-level
// require back into it is a load-time cycle waiting for the first caller.

const { ancestry } = require('./lineage');

// Resolve a node reference. `ref` may be:
//   undefined | null | 'active'  → graph.active
//   'live'                       → the uncommitted surface (graph.snapshotLive)
//   a stored id                  → 'n5'       (checked first: ids are exact)
//   a hierarchical label         → 'n1.7'
// Returns { ok:true, id, label, node } or { ok:false, code, error }, where
// `code` is 'no-active' | 'not-found' | 'live-not-allowed' so a caller can keep
// its own wording for the message.
//
// `live` resolves to { id:'live', label:'live', live:true, node } where `node`
// is a synthesized node — the page (mounts, markdown, order and the layout
// fields snapshotLive carries), the store, and a theme borrowed from the active
// node, because until the turn commits the live surface is drawn under that
// node's theme (hardcoding null reported a spurious full-theme removal when
// diffing a themed `active` against `live`, and lost node theming in a live
// export). It carries the live element projection too (PLAN 2C.5; E-STORE a):
// `comments`, the live pins as snapshotLive carries them, and `elements`, the
// live id@v references — so diff_nodes reads `live`'s elements as it reads a
// node's, and a live export of a pinned surface splices the same per-kind
// resolver a committed pinned node does (export.js nodeForExport's
// carriesElements; F-DOCS a: the documents still draw no element). Pass
// `{ allowLive:false }` where a snapshot makes no sense (a replay walks
// committed history only).
function resolveNodeRef(graph, ref, { allowLive = true } = {}) {
  const s = ref == null ? 'active' : String(ref);

  if (s === 'live') {
    if (!allowLive) return { ok: false, code: 'live-not-allowed', error: '`live` is not a committed node' };
    const snap = graph.snapshotLive();
    const activeNode = graph.active ? graph.nodes.get(graph.active) : null;
    return {
      ok: true, live: true, id: 'live', label: 'live',
      node: {
        mounts: snap.mounts || [], markdown: snap.markdown || [], order: snap.order,
        claude_order: snap.claude_order, runs: snap.runs,
        store: snap.store || {}, theme: (activeNode && activeNode.theme) ?? null,
        comments: snap.comments || [], elements: snap.elements || [],
      },
    };
  }

  const { computeLabels } = require('../graph');
  if (s === 'active') {
    if (!graph.active || !graph.nodes.has(graph.active)) {
      return { ok: false, code: 'no-active', error: 'no active node' };
    }
    const labels = computeLabels(graph);
    return { ok: true, id: graph.active, label: labels.get(graph.active) || graph.active, node: graph.nodes.get(graph.active) };
  }

  const labels = computeLabels(graph);
  let id = graph.nodes.has(s) ? s : null;
  if (!id) {
    for (const [nid, label] of labels) {
      if (label === s) { id = nid; break; }
    }
  }
  if (!id || !graph.nodes.has(id)) return { ok: false, code: 'not-found', error: 'node not found' };
  return { ok: true, id, label: labels.get(id) || id, node: graph.nodes.get(id) };
}

// The parent-chain walk is NOT here: lib/server/domain/lineage `ancestry` is
// the one walk (newest first, one cycle guard) — pane history and the replay
// path both read it.

// ── graph anchors ───────────────────────────────────────────────────────────
// A graph anchor pins an annotation to the graph itself rather than to a place
// on one node's page (PLAN 1A.8, C1): a node, a fork, a span of turns, or a
// branch. It is keyed by STORED NODE IDS, never by label. A label is derived
// from topology on every read (computeLabels) and is only ever a display name:
// before the third-child fix every later sibling shared `L.0`, and any future
// change of the label rule would silently re-point a label-keyed anchor. So an
// anchor that names a node only by `label` is refused ('label-not-an-anchor').
//
// Anchor shapes:
//   {kind: 'node',   node_id}           any node
//   {kind: 'fork',   node_id}           a node with two or more children
//   {kind: 'span',   from_id, to_id}    from is an ancestor of to, or to itself
//   {kind: 'branch', node_id}           a non-first child (a branch off its parent)
//
// Answers:
//   {ok: true, state: 'exact', kind, …the anchor's ids, label, …}
//     node   → {node_id, label}
//     fork   → {node_id, label, children: [id…], labels: [label…] (parallel)}
//     span   → {from_id, to_id, length (nodes from..to inclusive), label: 'from..to',
//               labels: [from label, to label]}
//     branch → {node_id, label, parent_id, parent_label}
//   {ok: false, state: 'orphaned', reason}
//     reason: 'node-gone' | 'not-an-ancestor' | 'not-a-fork' | 'not-a-branch'
//           | 'label-not-an-anchor' | 'unknown-kind'
//
// The two states are members of the one anchor-state vocabulary
// (lib/core/anchor-states.js, built in the same wave, so not imported here); a
// test there holds GRAPH_ANCHOR_STATES inside it. Pure and stateless like
// resolveNodeRef: it reads graph.nodes / graph.topology and the cached labels,
// and never writes.
const GRAPH_ANCHOR_STATES = Object.freeze(['exact', 'orphaned']);

const ANCHOR_ID_FIELDS = { node: ['node_id'], fork: ['node_id'], branch: ['node_id'], span: ['from_id', 'to_id'] };

function resolveGraphAnchor(graph, anchor) {
  const orphaned = (reason) => ({ ok: false, state: 'orphaned', reason });
  const a = anchor && typeof anchor === 'object' ? anchor : {};
  const fields = Object.prototype.hasOwnProperty.call(ANCHOR_ID_FIELDS, a.kind) ? ANCHOR_ID_FIELDS[a.kind] : null;
  if (!fields) return orphaned('unknown-kind');
  const named = (v) => typeof v === 'string' && v !== '';
  if (!fields.every((f) => named(a[f]))) {
    // Keyed by label (or by nothing) instead of by id: a label is display only.
    return orphaned(Object.keys(a).some((k) => k.includes('label')) ? 'label-not-an-anchor' : 'node-gone');
  }
  if (!fields.every((f) => graph.nodes.has(a[f]))) return orphaned('node-gone');

  const { computeLabels } = require('../graph');
  const labels = computeLabels(graph);
  const labelOf = (id) => labels.get(id) || id;

  if (a.kind === 'node') {
    return { ok: true, state: 'exact', kind: 'node', node_id: a.node_id, label: labelOf(a.node_id) };
  }

  if (a.kind === 'fork') {
    const t = graph.topology.get(a.node_id);
    const children = (t && Array.isArray(t.children) ? t.children : []).filter((c) => graph.nodes.has(c));
    if (children.length < 2) return orphaned('not-a-fork');
    return {
      ok: true, state: 'exact', kind: 'fork', node_id: a.node_id, label: labelOf(a.node_id),
      children, labels: children.map(labelOf),
    };
  }

  if (a.kind === 'branch') {
    // A branch is a child that is not its parent's first (trunk) child. Which
    // child is first is computeLabels' decision, read off its own rule rather
    // than a second copy of its sort: the trunk child increments the parent's
    // last segment (never to 0), every later child's label ends in `.0`.
    const parentId = graph.nodes.get(a.node_id).parent_id;
    const t = parentId != null ? graph.topology.get(parentId) : null;
    if (!t || !graph.nodes.has(parentId) || !Array.isArray(t.children) || !t.children.includes(a.node_id)) {
      return orphaned('not-a-branch');
    }
    const label = labels.get(a.node_id);
    if (typeof label !== 'string' || !label.endsWith('.0')) return orphaned('not-a-branch');
    return {
      ok: true, state: 'exact', kind: 'branch', node_id: a.node_id, label,
      parent_id: parentId, parent_label: labelOf(parentId),
    };
  }

  // span: from must be on to's ancestry (lineage `ancestry`, the one walk).
  const idx = ancestry(graph, a.to_id).indexOf(a.from_id);
  if (idx < 0) return orphaned('not-an-ancestor');
  const lf = labelOf(a.from_id), lt = labelOf(a.to_id);
  return {
    ok: true, state: 'exact', kind: 'span', from_id: a.from_id, to_id: a.to_id,
    length: idx + 1, label: `${lf}..${lt}`, labels: [lf, lt],
  };
}

module.exports = { resolveNodeRef, resolveGraphAnchor, GRAPH_ANCHOR_STATES };
