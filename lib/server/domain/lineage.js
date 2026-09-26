// lib/server/domain/lineage.js — walking a node's ancestry, and the pane
// history that walk answers.
//
// A node's lineage is its parent chain back to the root of its tree: the path
// the surface actually travelled to get where it is. `ancestry` below is the ONE
// parent-chain walk in the daemon — pane history ("which versions of this pane
// has the page shown on the way here?") and the replay path
// (domain/replay-path, which reverses it to play root → to) both read it, so
// there is one loop and one cycle guard. Resolving a node REF (label, id,
// active, live) is the other half and lives in domain/refs.
//
// Read-only and stateless: every function takes the `graph` (and, for the live
// comparison, the live mount record) from its caller. Labels are handed IN, so
// this module never reaches up into lib/server/graph.js.

const crypto = require('node:crypto');
const { stableStringify } = require('../diff');

// The ancestry of `fromId`, NEWEST first: [fromId, parent, grandparent, … root].
// An explicit loop, never recursion — a trunk is one linear chain thousands of
// turns deep (see computeLabels in lib/server/graph.js for the stack overflow a
// recursive walk hit). The `seen` guard makes a hand-edited parent cycle end the
// walk instead of spinning; a parent_id that names no loaded node ends it too.
function ancestry(graph, fromId) {
  const out = [];
  const seen = new Set();
  let id = fromId;
  while (id != null && graph.nodes.has(id) && !seen.has(id)) {
    seen.add(id);
    out.push(id);
    id = graph.nodes.get(id).parent_id;
  }
  return out;
}

// What makes two versions of a pane "the same version": its CONTENT — the html,
// the params it was rendered with, and the component it came from. Deliberately
// NOT pane_state (a user's drag or resize is not a new version), form_state (the
// user's typing is not a new version), the per-pane theme, target or owner.
const VERSION_FIELDS = ['html', 'params', 'component'];

function specHash(m) {
  // Every field is picked, present or not, so a live record's undefined key and
  // a node file's absent one hash alike.
  const pick = {};
  for (const k of VERSION_FIELDS) pick[k] = m ? m[k] : undefined;
  return crypto.createHash('sha1').update(stableStringify(pick)).digest('hex').slice(0, 16);
}

// Committed nodes are immutable, so a pane's hash in one is computed once. Keyed
// on the node OBJECT: a node re-read from disk is a new object and simply misses.
const nodeHashCache = new WeakMap();

function nodeMountHash(node, mountId) {
  let per = nodeHashCache.get(node);
  if (!per) { per = new Map(); nodeHashCache.set(node, per); }
  if (per.has(mountId)) return per.get(mountId);
  const m = findMount(node, mountId);
  const h = m ? specHash(m) : null;
  per.set(mountId, h);
  return h;
}

function findMount(node, mountId) {
  return (node && Array.isArray(node.mounts) ? node.mounts : []).find((x) => x && x.id === mountId) || null;
}

// The distinct versions of pane `mountId` along `fromId`'s ancestry, newest
// first. Each entry names the node that INTRODUCED that version — the oldest
// node of the unbroken run showing it — because that node's trigger and author
// are the answer to "where did this version come from". A version that comes
// back later (A → B → A) is listed once, at its most recent introduction.
//
// `live` is the live mount record (or null) and is compared only when walking
// from the active node: when the live pane holds content no listed version has
// (a turn in progress, a driver write) it is prepended as a `node_id:'live'` row.
// Whichever entry matches the live content carries `current:true`.
function mountHistory(graph, { mountId, fromId, labels, live = null, includeLive = false } = {}) {
  const versions = [];
  let prev = null;
  for (const id of ancestry(graph, fromId)) {
    const node = graph.nodes.get(id);
    const h = nodeMountHash(node, mountId);
    if (h == null) { prev = null; continue; }
    if (prev && prev.spec_hash === h) {
      // Same version one node further back: the run's introduction moves back.
      Object.assign(prev, entryFor(node, labels, h, findMount(node, mountId)));
      continue;
    }
    prev = entryFor(node, labels, h, findMount(node, mountId));
    versions.push(prev);
  }
  const seen = new Set();
  const out = versions.filter((v) => (seen.has(v.spec_hash) ? false : (seen.add(v.spec_hash), true)));
  if (includeLive && live) {
    const lh = specHash(live);
    const match = out.find((v) => v.spec_hash === lh);
    if (match) match.current = true;
    else {
      out.unshift({
        node_id: 'live', label: 'live', created_at: null,
        author: live.owner || 'claude', owner: live.owner || 'claude',
        trigger_summary: 'the live surface (not yet committed)',
        spec_hash: lh, current: true,
      });
    }
  }
  return out;
}

function entryFor(node, labels, h, m) {
  return {
    node_id: node.id,
    label: (labels && labels.get(node.id)) || node.id,
    created_at: node.created_at,
    author: node.author,
    owner: (m && m.owner) || 'claude',
    trigger_summary: (node.trigger && node.trigger.summary) || '',
    spec_hash: h,
  };
}

module.exports = { ancestry, specHash, mountHistory, findMount, VERSION_FIELDS };
