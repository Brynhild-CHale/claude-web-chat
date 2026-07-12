const fs = require('fs');
const path = require('path');
const { hydrateMount } = require('./domain/turns');
const queueDomain = require('./domain/queue');

function topoEntry(node) {
  return {
    id: node.id,
    parent_id: node.parent_id,
    created_at: node.created_at,
    author: node.author,
    trigger_summary: node.trigger?.summary || '',
    bookmarked: !!node.bookmarked,
    name: node.name || '',
    children: [],
  };
}

// Deep-copy a comment pin for snapshot/restore. A shallow { ...c } shares the
// `replies` thread array AND the `anchor` object by reference, so a live reply
// (or re-anchor) would bleed into every node snapshot (copying anchor is
// strictly safer even though nothing mutates it in place yet).
function clonePin(c) {
  const copy = { ...c };
  if (Array.isArray(c.replies)) copy.replies = c.replies.map((r) => ({ ...r }));
  if (c.anchor && typeof c.anchor === 'object') copy.anchor = { ...c.anchor };
  return copy;
}

// Stored ids stay opaque (n0, n1, …). Human-legible hierarchical labels
// (n1.0, n1.1, n1.1.0, …) are derived from topology on demand — never stored,
// so there is no migration and existing graphs relabel cleanly.
//
// Rules:
//  - Roots (parent_id == null), ordered by created_at (id-seq tiebreak), are
//    trees n1, n2, …; a tree's root state is n{k}.0.
//  - The first-created child is the trunk child → increment parent's last
//    segment (n1.1 → n1.2).
//  - Any later child is a branch → append a fresh .0 (branch off n1.1 → n1.1.0),
//    whose own trunk children then increment (n1.1.0 → n1.1.1).
function computeLabels(graph) {
  const topo = graph.topology;
  const labels = new Map();

  const idSeq = (id) => {
    const m = /^n(\d+)$/.exec(id);
    return m ? parseInt(m[1], 10) : NaN;
  };
  const sortIds = (ids) => ids.slice().sort((a, b) => {
    const ta = topo.get(a), tb = topo.get(b);
    const ca = ta?.created_at ?? 0, cb = tb?.created_at ?? 0;
    if (ca !== cb) return ca - cb;
    const sa = idSeq(a), sb = idSeq(b);
    if (!isNaN(sa) && !isNaN(sb)) return sa - sb;
    return a < b ? -1 : a > b ? 1 : 0;
  });

  const incrementLast = (label) => {
    const parts = label.split('.');
    parts[parts.length - 1] = String(parseInt(parts[parts.length - 1], 10) + 1);
    return parts.join('.');
  };

  const walk = (id, label) => {
    labels.set(id, label);
    const children = sortIds(topo.get(id).children);
    children.forEach((childId, idx) => {
      walk(childId, idx === 0 ? incrementLast(label) : label + '.0');
    });
  };

  const roots = [...topo.values()]
    .filter(t => !t.parent_id || !topo.has(t.parent_id))
    .map(t => t.id);
  sortIds(roots).forEach((rootId, k) => walk(rootId, `n${k + 1}.0`));

  return labels;
}

function createGraph({ paths, state }) {
  const graph = {
    nodes: new Map(),
    topology: new Map(),
    active: null,
    lock: null,
    nextSeq: 0,
    // Set by `wipe` / `new graph`; bookmarks the next committed node (the start
    // of fresh content / a new graph's root), then cleared.
    pendingBookmark: null,
  };

  graph.writeNode = (node) => {
    fs.writeFileSync(path.join(paths.GRAPH_DIR, `${node.id}.json`), JSON.stringify(node, null, 2));
  };

  graph.saveMeta = () => {
    // The lock is persisted so a crash mid-turn doesn't silently lose it; on the
    // next boot a stale one is cleared (see createServer) and a still-fresh one
    // is restored. A clean turn-end/unlock writes lock:null here.
    fs.writeFileSync(paths.META_PATH, JSON.stringify({ active: graph.active, lock: graph.lock || null }, null, 2));
  };

  graph.registerNode = (node) => {
    graph.nodes.set(node.id, node);
    graph.topology.set(node.id, topoEntry(node));
    if (node.parent_id && graph.topology.has(node.parent_id)) {
      graph.topology.get(node.parent_id).children.push(node.id);
    }
  };

  graph.load = () => {
    const files = fs.readdirSync(paths.GRAPH_DIR).filter(f => f.endsWith('.json') && f !== '_meta.json');
    const nodes = files.map(f => JSON.parse(fs.readFileSync(path.join(paths.GRAPH_DIR, f), 'utf8')));
    nodes.sort((a, b) => a.created_at - b.created_at);
    for (const n of nodes) {
      graph.nodes.set(n.id, n);
      graph.topology.set(n.id, topoEntry(n));
      const seqNum = parseInt(n.id.replace(/^n/, ''), 10);
      if (!isNaN(seqNum) && seqNum >= graph.nextSeq) graph.nextSeq = seqNum + 1;
    }
    for (const t of graph.topology.values()) {
      if (t.parent_id && graph.topology.has(t.parent_id)) {
        graph.topology.get(t.parent_id).children.push(t.id);
      }
    }
    // Respect an explicit active:null in _meta.json (a wiped / fresh-blank
    // surface). Only fall back to "latest" when active is a *non-null* id that
    // is missing from the graph (corruption / deleted node).
    graph.active = null;
    graph.lock = null;
    if (fs.existsSync(paths.META_PATH)) {
      try {
        const meta = JSON.parse(fs.readFileSync(paths.META_PATH, 'utf8'));
        graph.active = meta.active || null;
        graph.lock = meta.lock || null;
      } catch {}
    }
    if (graph.active && !graph.nodes.has(graph.active)) {
      const latest = [...graph.nodes.values()].sort((a, b) => b.created_at - a.created_at)[0];
      graph.active = latest ? latest.id : null;
      graph.saveMeta();
    }
    // Seed the global comment counter past the highest seq in ANY node so new
    // pins never reuse an id, even after navigating to an older branch.
    let maxSeq = 0;
    for (const n of graph.nodes.values()) {
      for (const c of (n.comments || [])) if ((c.seq || 0) > maxSeq) maxSeq = c.seq;
    }
    state.commentSeq = Math.max(state.commentSeq, maxSeq);
    // Same seeding for captures: push the global capture counter past the highest
    // seq in any node so a new capture never reuses an id (or clobbers an existing
    // sidecar file), even after navigating to an older branch.
    let maxCapSeq = 0;
    for (const n of graph.nodes.values()) {
      for (const c of (n.captures || [])) if ((c.seq || 0) > maxCapSeq) maxCapSeq = c.seq;
    }
    state.captureSeq = Math.max(state.captureSeq, maxCapSeq);
  };

  graph.snapshotLive = () => {
    const mounts = [];
    for (const [id, m] of state.mounts) mounts.push({ id, ...m });
    return {
      mounts,
      store: { ...state.store },
      comments: state.comments.map(clonePin),
      captures: state.captures.map((c) => ({ ...c })),
      // The wake queue rides the live snapshot so it persists into draft.json on
      // shutdown. commitNode picks specific fields into a graph node and does NOT
      // include `queue` — pending wakes stay live-only, never committed history.
      queue: state.queue.map((q) => ({ ...q })),
      // A parked wake (Push made while no channel was connected) rides the
      // draft too, so a Push isn't lost across a graceful restart. Like the queue,
      // commitNode does NOT pick it into a node — it's pending-wake state.
      pendingWake: state.pendingWake ? { ...state.pendingWake } : null,
    };
  };

  graph.restoreLiveToNode = (id, bus) => {
    const node = graph.nodes.get(id);
    if (!node) return;
    state.mounts.clear();
    for (const m of (node.mounts || [])) {
      state.mounts.set(m.id, hydrateMount(m));
    }
    for (const k of Object.keys(state.store)) delete state.store[k];
    Object.assign(state.store, node.store || {});
    // Pins travel with the node; the global counter is NOT reset here (it only
    // ever grows), so a pin added on an older node still gets a fresh unique id.
    state.comments = Array.isArray(node.comments) ? node.comments.map(clonePin) : [];
    // The wake queue does NOT travel with the node (it's live-only pending-wake
    // state), so a comment item can outlive the pin it stands for once we swap
    // comments wholesale. Drop every queued item whose pin isn't in the restored
    // set, reusing removeByComment so each drop emits the canonical queue-remove
    // event — otherwise Push would wake Claude quoting a ghost pin.
    if (bus && Array.isArray(state.queue) && state.queue.length) {
      const restored = new Set(state.comments.map((c) => c.id));
      const orphaned = new Set(
        state.queue.filter((it) => it.comment_id && !restored.has(it.comment_id)).map((it) => it.comment_id)
      );
      for (const commentId of orphaned) queueDomain.removeByComment(state, bus, commentId);
    }
    // Captures travel with the node too (same counter discipline as comments).
    // Their raw_ref sidecar files are keyed by the global-unique id, so they
    // remain valid no matter which node restored the record.
    state.captures = Array.isArray(node.captures) ? node.captures.map((c) => ({ ...c })) : [];
  };

  // Empty the live surface's panes only; the store is intentionally preserved.
  // Used by the Wipe button and by boot when there is no active node.
  graph.clearLiveMounts = () => {
    state.mounts.clear();
  };

  return graph;
}

module.exports = { createGraph, computeLabels };
