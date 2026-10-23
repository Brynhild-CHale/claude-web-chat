// lib/server/domain/element-scope.js — which version of a page anchor a node
// shows (PLAN 1A.6; DECISIONS C1, branch-only).
//
// Page anchors version as surface state and fork with the graph: a node shows
// the NEWEST version (max v) whose HOME node is in its own ancestry. The home
// of id@v is the node of the first commit record pinning it (the element log's
// `homeOf`, lib/core/element-log). A version no commit ever pinned — dropped by
// New graph or a clean re-aim, superseded by a later write before the commit,
// a hard stop's — has NO home and is visible from no node. There is no global
// scope (C1 removed `scope` from element.json), so nothing here reads one.
//
//   visibleVersion(graph, store, id, nodeId)  → v | null
//   elementsForNode(graph, store, nodeId)     → [{id, v, newest_visible_v, newer_elsewhere}]
//
// elementsForNode answers one row per element that has any version homed in
// the node's ancestry:
//   v                 the v the node's own copy pins (its commit record's
//                     `pinsOf`), or null when the node holds no copy
//   newest_visible_v  the version the node shows (visibleVersion)
//   newer_elsewhere   [{v, home, label}] — versions with v > newest_visible_v
//                     homed OFF the ancestry (another branch, or a descendant
//                     of the node), oldest first. A DISPLAY affordance only
//                     ("N newer replies on this line, at nX", C1): `label` is
//                     computeLabels' display name and is never a key. A home
//                     node the graph has not loaded (a node file set aside)
//                     cannot be shown "at nX", so it is left out.
//
// Pure and stateless like domain/refs: it reads the `graph` (graph.nodes, and
// graph.topology for the labels) and the store it is handed — the daemon's
// `graph.elements`, or a bare lib/core/element-log instance, which answers the
// same three reads (`versionsOf`, `homeOf`, `pinsOf`) — and never writes to
// either. Each call walks the ancestry ONCE through lib/server/domain/lineage
// `ancestry` (the one parent-chain walk; reached through the module object, so
// a test can count the calls) and turns it into a Set; each element's versions
// are then walked once, with one homeOf per version — no per-version ancestry
// walk. No HTTP route reads it in tranche 1 (a route needs a remote-policy
// row, and nothing draws the affordance before tranche 2), and restore,
// preview, export and the dirty check do not consult it: a node's own copy is
// still what its page carries.
//
// `computeLabels` is required LAZILY, as domain/refs does: graph.js top-imports
// domain modules, so a top-level require back into it is a load-time cycle.

const lineage = require('./lineage');
const { pinMapOf } = require('../../core/element-log');

// The ancestry of `nodeId` (itself included) as a Set: one walk per call.
function ancestrySet(graph, nodeId) {
  return new Set(nodeId == null ? [] : lineage.ancestry(graph, nodeId));
}

// One element's versions, walked once: the newest v homed in `anc`, and every
// version homed off it (oldest first), each with its home.
function scan(store, id, anc) {
  let visible = null;
  const off = [];
  for (const rec of store.versionsOf(id) || []) {
    const v = rec && rec.v;
    if (!Number.isSafeInteger(v) || v <= 0) continue;
    const home = store.homeOf(id, v);
    if (home == null) continue; // never pinned by a commit: visible from no node
    if (anc.has(home)) { if (visible == null || v > visible) visible = v; }
    else off.push({ v, home });
  }
  return { visible, off };
}

function visibleVersion(graph, store, id, nodeId) {
  if (typeof id !== 'string' || id === '') return null;
  return scan(store, id, ancestrySet(graph, nodeId)).visible;
}

function elementsForNode(graph, store, nodeId) {
  const walk = nodeId == null ? [] : lineage.ancestry(graph, nodeId);
  const anc = new Set(walk);
  // Every element with a version homed in the ancestry is pinned by that home
  // node's commit record, so the ancestors' pins name every candidate id; a
  // candidate keeps its row only when one of its versions is homed here.
  const ids = [];
  const seen = new Set();
  for (const nid of walk) {
    for (const id of pinMapOf(store.pinsOf(nid)).keys()) {
      if (!seen.has(id)) { seen.add(id); ids.push(id); }
    }
  }
  const own = pinMapOf(store.pinsOf(nodeId));
  let labels = null;
  const labelOf = (nid) => {
    if (!labels) labels = require('../graph').computeLabels(graph);
    return labels.get(nid) || nid;
  };
  const rows = [];
  for (const id of ids) {
    const { visible, off } = scan(store, id, anc);
    if (visible == null) continue;
    const newer = off
      .filter((x) => x.v > visible && graph.nodes.has(x.home))
      .sort((a, b) => a.v - b.v)
      .map((x) => ({ v: x.v, home: x.home, label: labelOf(x.home) }));
    rows.push({ id, v: own.has(id) ? own.get(id) : null, newest_visible_v: visible, newer_elsewhere: newer });
  }
  return rows;
}

module.exports = { visibleVersion, elementsForNode };
