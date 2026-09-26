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
// is a synthesized { mounts, store, theme } — the theme borrowed from the active
// node, because until the turn commits the live surface is drawn under that
// node's theme (hardcoding null reported a spurious full-theme removal when
// diffing a themed `active` against `live`, and lost node theming in a live
// export). Pass `{ allowLive:false }` where a snapshot makes no sense (a replay
// walks committed history only).
function resolveNodeRef(graph, ref, { allowLive = true } = {}) {
  const s = ref == null ? 'active' : String(ref);

  if (s === 'live') {
    if (!allowLive) return { ok: false, code: 'live-not-allowed', error: '`live` is not a committed node' };
    const snap = graph.snapshotLive();
    const activeNode = graph.active ? graph.nodes.get(graph.active) : null;
    return {
      ok: true, live: true, id: 'live', label: 'live',
      node: { mounts: snap.mounts || [], store: snap.store || {}, theme: (activeNode && activeNode.theme) ?? null },
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

// The RAW commit ancestry of `id`, root first and `id` last, over
// graph.topology's parent_id edges. A parent that is not in the graph ends the
// walk (that node is a root as far as labels and the viewer are concerned), and
// a visited set makes a hand-edited cycle end rather than spin. Iterative, not
// recursive: a trunk is one long chain (see computeLabels' stack overflow).
function ancestorChain(graph, id) {
  const chain = [];
  const seen = new Set();
  let cur = id;
  while (cur && graph.topology.has(cur) && !seen.has(cur)) {
    seen.add(cur);
    chain.push(cur);
    cur = graph.topology.get(cur).parent_id;
  }
  return chain.reverse();
}

module.exports = { resolveNodeRef, ancestorChain };
