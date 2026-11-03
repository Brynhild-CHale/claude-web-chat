const fs = require('fs');
const path = require('path');
const { writeJsonAtomic, readJson, renameAside } = require('../core/fsjson');
const { projectPaths } = require('../core/paths');
const { hydrateMount, nodeViewKey, PROJECTION_VERSION } = require('./domain/turns');
const queueDomain = require('./domain/queue');
const liveCaptures = require('./domain/captures');
const page = require('./domain/page');
const elementRefs = require('./domain/element-refs');

function topoEntry(node) {
  return {
    id: node.id,
    parent_id: node.parent_id,
    created_at: node.created_at,
    author: node.author,
    trigger_summary: node.trigger?.summary || '',
    bookmarked: !!node.bookmarked,
    name: node.name || '',
    // The bookmark a wipe left (drawn "⌫ wipe · <name>"). Additive, absent otherwise.
    ...(node.wipe ? { wipe: true } : {}),
    // How many chat-only turns this node stands for (see domain/turns
    // applyFolded). 0 for an ordinary node. Surfaced in /api/graph — and so in
    // get_graph — so a collapsed run reads as "this node absorbed N turns"
    // rather than those turns having silently vanished. The turns themselves
    // live on the node's `folded` array (GET /api/graph/node/:id).
    folded_count: node.folded_count || (Array.isArray(node.folded) ? node.folded.length : 0),
    children: [],
  };
}

// How many `<name>.corrupt-<ts>` copies of one record to keep beside it, matching
// the draft's cap in domain/turns (KEEP_ASIDE_DRAFTS). Nothing else in the tree
// reaps these, so a cap is what stops a graph dir growing a tail of them; keeping
// the newest three still leaves an unreadable node's id claimed forever (the
// filename scan in graph.load reads the aside copies too).
const KEEP_ASIDE = 3;

// The graph-node shape predicate (graph.load's readJson `validate`) lives in
// lib/core/element-log beside the migration that shares it.
const { isGraphNode } = require('../core/element-log');

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
//  - The second child is a branch → append a fresh .0 (branch off n1.1 → n1.1.0),
//    whose own trunk children then increment (n1.1.0 → n1.1.1).
//  - The child at index i ≥ 2 (the third, fourth, …) is a branch too, labelled
//    `L-i.0` (the third child of n1.1 is n1.1-2.0, its trunk n1.1-2.1, a branch
//    off that n1.1-2.1.0). Giving every later child `L.0` named k−1 siblings
//    alike, and a label lookup opened the first of them — the wrong node. The
//    form cannot collide: incrementLast rewrites only the final segment's
//    integer, and a segment holding '-' arises only here, for one (parent
//    label, i) pair. A node with at most two children labels exactly as before.
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

  // An EXPLICIT stack, not recursion. A trunk is one linear chain — every
  // committed turn is a child of the previous one — so a self-recursive walk
  // spends two frames per turn and threw `RangeError: Maximum call stack size
  // exceeded` at ~3,000 nodes. That is not a degraded read: labels are derived,
  // so GET /api/graph, get_graph and export would all 500 together with no file
  // to repair. Depth is O(1) here; children are pushed in reverse so the pop
  // order is the same depth-first pre-order the recursion produced.
  const stack = [];
  const roots = [...topo.values()]
    .filter(t => !t.parent_id || !topo.has(t.parent_id))
    .map(t => t.id);
  const sortedRoots = sortIds(roots);
  for (let k = sortedRoots.length - 1; k >= 0; k--) {
    stack.push([sortedRoots[k], `n${k + 1}.0`]);
  }
  while (stack.length) {
    const [id, label] = stack.pop();
    labels.set(id, label);
    const children = sortIds(topo.get(id).children);
    for (let i = children.length - 1; i >= 0; i--) {
      stack.push([children[i], i === 0 ? incrementLast(label) : i === 1 ? label + '.0' : `${label}-${i}.0`]);
    }
  }

  return labels;
}

// Every read recomputes labels for the WHOLE graph — GET /api/graph does it once,
// nodeForExport twice — so a long-lived project pays an O(n log n) walk per
// request for a result that only changes when the TOPOLOGY does. The cache is
// keyed on `graph.topoRev`, which createGraph bumps at the two places that add a
// node (registerNode, load); a caller that hands in a bare `{topology}` (tests,
// and anything built by hand) has no rev and is never cached. The returned Map is
// shared — treat it as read-only, as every caller in the tree does.
const labelCache = new WeakMap();

function computeLabelsCached(graph) {
  const rev = graph && graph.topoRev;
  if (typeof rev !== 'number') return computeLabels(graph);
  const hit = labelCache.get(graph);
  if (hit && hit.rev === rev) return hit.labels;
  const labels = computeLabels(graph);
  labelCache.set(graph, { rev, labels });
  return labels;
}

// ── Collapsing turns that changed nothing ──────────────────────────────────
// Since domain/turns' fold-forward, a turn that leaves the surface identical to
// its parent commits no node at all — its provenance rides `pendingFolded` onto
// the next node that DOES change something. Graphs written before that landed
// are full of the nodes it now prevents: byte-identical copies of their parent,
// one per chat-only turn, which is exactly the run of dead nodes that makes an
// old graph unnavigable.
//
// This is the read-time equivalent for that history. Nothing is rewritten — the
// node files are append-only and stay exactly as committed — the graph payload
// simply reports which nodes are indistinguishable from their parent and which
// surviving node stands for them. The viewer hides the former and attributes
// them to the latter, so old runs read the same way new folded turns do.
//
// A node is only collapsible when hiding it cannot cost the reader anything:
//   * it has a parent in this graph (a root is the graph's identity)
//   * its surface digest equals its parent's (the actual no-change test)
//   * it is not `active` (never hide where the user is standing)
//   * it is not bookmarked or named (that node was marked on purpose)
//   * it has exactly one child — a fork is load-bearing shape, and a tip is
//     where the lineage currently ends; hiding either would misreport the graph
// Returns id -> { collapsed } | { collapsed:false, display_parent, absorbed[] },
// where `absorbed` is the run of collapsed ancestors this node stands for,
// oldest first.
function computeCollapse(graph) {
  const topo = graph.topology;
  const keys = graph.viewKeys;
  const out = new Map();

  const collapsible = (id) => {
    const t = topo.get(id);
    if (!t || !t.parent_id || !topo.has(t.parent_id)) return false;
    if (id === graph.active) return false;
    if (t.bookmarked || t.name) return false;
    if ((t.children || []).length !== 1) return false;
    const k = keys.get(id);
    const pk = keys.get(t.parent_id);
    return Boolean(k && pk && k === pk);
  };

  const collapsed = new Set();
  for (const id of topo.keys()) if (collapsible(id)) collapsed.add(id);

  for (const id of topo.keys()) {
    if (collapsed.has(id)) { out.set(id, { collapsed: true }); continue; }
    const absorbed = [];
    let p = topo.get(id).parent_id;
    // Walk up the run of hidden ancestors to the first node that survives.
    while (p && collapsed.has(p)) { absorbed.unshift(p); p = topo.get(p).parent_id; }
    out.set(id, { collapsed: false, display_parent: p || null, absorbed });
  }
  return out;
}

// ── The graph index (PLAN §5 4G.2, GRAPH@stored-view-key) ─────────────────
// A DERIVED file, .web-chat/graph-index.json (lib/core/paths graphIndex), with
// one entry per node FILE: {id, size, mtime_ms, view_key, header}, under the
// index's own version `v` and the projection version `pv` (domain/turns
// PROJECTION_VERSION). graph.load takes a node's stored view key instead of
// re-hashing its snapshotView, and builds the node from its stored HEADER
// instead of reading the file (LAZY NODE BODIES, below), when the entry's id,
// its size and its mtime agree with the file and `pv` matches; anything else
// is read whole and hashed as before.
//
// What it is NOT: the only copy of anything. Nothing reads it but graph.load.
// The key it carries is read only by computeCollapse (which nodes the drawn
// graph hides); labels, liveIsDirty and every data decision ignore it. The
// header is the node file's own non-body fields, copied: a node built from it
// answers every read exactly as the file would (the getters read the file for
// the rest).
// So a torn, invalid or stale index is ignored and later overwritten — never
// renamed aside — and deleting the file rebuilds it on the next boot. It is
// written once after the listen (createServer, RULED U572-U573@index-cadence-
// and-refusal (a)), never inside the boot window; nodes committed during a run
// are read whole at the next boot. It lives outside graph/ (graph.load reads
// every *.json there as a node) and no node file carries a field for it.
//
// THE RESIDUAL DRIFT: a hand edit that keeps a node file's size and its mtime
// to the millisecond keeps a stale key — at worst one mis-collapsed row in the
// drawn graph. A snapshotView change without a PROJECTION_VERSION bump would
// stale every key at once; test/graph-index.test.js's pinned fixture guards it.
// 2: the entry gained `header` (U573). An index a build of version 1 wrote
// reads as 'invalid' once, every node is read whole, and the after-listen
// flush rewrites it.
const INDEX_VERSION = 2;
const VIEW_KEY_RE = /^[0-9a-f]{40}$/;

function isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

// The index file's shape (readJson's `validate`); its entries are checked one
// by one where they are taken (indexEntryUsable), so one bad entry costs one
// hash, not the index.
function isGraphIndex(v) {
  return isPlainObject(v) && v.v === INDEX_VERSION && isPlainObject(v.nodes);
}

function indexEntryUsable(e) {
  return isPlainObject(e) && typeof e.id === 'string'
    && Number.isSafeInteger(e.size) && e.size >= 0
    && Number.isFinite(e.mtime_ms)
    && typeof e.view_key === 'string' && VIEW_KEY_RE.test(e.view_key);
}

// Does a file's stat still agree with its entry? Size exactly; mtime to within
// one millisecond. Not sub-millisecond digits: a copy that preserves
// timestamps (fs.cpSync preserveTimestamps, the measure kit's KIT@index-copy)
// restores them through Date objects, and measured on 2026-11-03 Node 26 keeps
// every digit, 22.23.3 keeps the millisecond, and 22.12.0 ROUNDS to the
// nearest one (…902.223 → …901.999, …889.523 → …890) — so a whole-millisecond
// compare (Math.trunc) refused half of a 22.12 copy. Within 1 ms is the same
// strength as a whole-millisecond compare and survives all three.
function statAgrees(st, e) {
  return st.size === e.size && Math.abs(st.mtimeMs - e.mtime_ms) < 1;
}

// ── Lazy node bodies (PLAN §5 4G.3, GRAPH@lazy-node-bodies) ────────────────
// A node's BODY is its heavy keys: the panes, the page sequence (markdown and
// order, and the layout half page.layoutFields writes — claude_order and
// runs), the store, the comment copies and the captures. Everything else is
// its HEADER (id, parent_id, created_at, author, trigger, elements, folded,
// folded_count, mirror, theme, bookmarked, name, wipe, and any key a later
// build adds), small, and what every reader of EVERY node reads: topology,
// labels, turn-guard's findFolded, the mirror's turn ids, the graph link,
// rollForward, the hello's node theme.
//
// The index entry's `header` holds the header fields (`node`) and fields
// DERIVED from the file, which live in the index only — never on a node
// object, never in a node file:
//   key_order        every key of the file, in file order (so a node built
//                    from the header lists its keys exactly as the file does)
//   body_keys        the body keys the file holds, in file order
//   pins             each comment's {id, v} (v null when absent) — exactly
//                    what element-log nodeDigest reads — or null when the
//                    comments are not an array of plain objects (the reader
//                    then needs the body)
//   max_comment_seq  the highest safe-integer comment seq (the load's floor)
//   max_capture_seq  the highest capture seq, by the load's own comparison
//   capture_ids      each capture's string id, or null when the captures are
//                    not an array
// graph.load builds a node from a usable header with one enumerable,
// configurable accessor per body key; the first touch of any of them reads
// the file and turns every body key into a plain data property, resident for
// the daemon's life (BODIES@no-evict: box-grab, the turn-guard patch, the
// node theme and the bookmark mutate the resident object, and an evicted body
// would lose those writes).
const BODY_KEYS = Object.freeze(['mounts', 'markdown', 'order', 'claude_order', 'runs', 'store', 'comments', 'captures']);
const BODY_KEY_SET = new Set(BODY_KEYS);
// What a body that cannot be read after boot answers (the getters, below):
// these four empty, the page-sequence keys absent — a node that never had one.
const EMPTY_BODY = { mounts: () => [], store: () => ({}), comments: () => [], captures: () => [] };
const own = Object.prototype.hasOwnProperty;

// The keys JSON.stringify writes for a value, in its order.
function jsonKeys(node) {
  const out = [];
  for (const k of Object.keys(node)) {
    const v = node[k];
    if (v === undefined || typeof v === 'function' || typeof v === 'symbol') continue;
    out.push(k);
  }
  return out;
}

// The derived fields of a RESIDENT node (never call it on a lazy node whose
// body is not in memory — it reads comments and captures). The two seq
// floors are graph.load's expressions as they were before the index, verbatim
// (a node they throw on threw out of the load then, and still does).
function derivedOf(node, keys = jsonKeys(node)) {
  const body_keys = keys.filter((k) => BODY_KEY_SET.has(k));
  const cs = node.comments;
  let pins = [];
  if (cs) {
    pins = Array.isArray(cs) && cs.every(isPlainObject)
      ? cs.map((c) => ({ id: c.id, v: c.v ?? null }))
      : null;
  }
  let max_comment_seq = 0;
  for (const c of (node.comments || [])) if (Number.isSafeInteger(c && c.seq) && c.seq > max_comment_seq) max_comment_seq = c.seq;
  let max_capture_seq = 0;
  for (const c of (node.captures || [])) if ((c.seq || 0) > max_capture_seq) max_capture_seq = c.seq;
  const caps = node.captures;
  const capture_ids = Array.isArray(caps)
    ? caps.filter((c) => c && typeof c.id === 'string').map((c) => c.id)
    : (caps ? null : []);
  return { body_keys, pins, max_comment_seq, max_capture_seq, capture_ids };
}

// THE one derivation of a node's index header (exported for tests): its
// header fields as the file holds them (a JSON copy, so later in-memory
// mutation of the node never reaches a stored header), its key order, and
// the derived fields above.
function headerOf(node) {
  const key_order = jsonKeys(node);
  const fields = {};
  for (const k of key_order) if (!BODY_KEY_SET.has(k)) fields[k] = node[k];
  return { node: JSON.parse(JSON.stringify(fields)), key_order, ...derivedOf(node, key_order) };
}

// Is a stored header one a node can be built from? Its node passes the load's
// own shape check, its keys are exactly the header fields plus the body keys
// (disjoint, unique, in one order), and every derived field has its shape.
function headerUsable(h, id) {
  if (!isPlainObject(h) || !isPlainObject(h.node) || !isGraphNode(h.node) || h.node.id !== id) return false;
  if (!Array.isArray(h.key_order) || !Array.isArray(h.body_keys)) return false;
  if (!(h.pins === null || (Array.isArray(h.pins) && h.pins.every(isPlainObject)))) return false;
  if (!Number.isSafeInteger(h.max_comment_seq) || h.max_comment_seq < 0) return false;
  if (!own.call(h, 'max_capture_seq')) return false;
  if (!(h.capture_ids === null || (Array.isArray(h.capture_ids) && h.capture_ids.every((c) => typeof c === 'string')))) return false;
  const seen = new Set();
  let b = 0;
  for (const k of h.key_order) {
    if (typeof k !== 'string' || seen.has(k)) return false;
    seen.add(k);
    if (BODY_KEY_SET.has(k)) { if (h.body_keys[b++] !== k) return false; }
    else if (!own.call(h.node, k)) return false;
  }
  return b === h.body_keys.length && Object.keys(h.node).length === seen.size - b;
}

function defineData(obj, k, value) {
  Object.defineProperty(obj, k, { value, writable: true, enumerable: true, configurable: true });
}

function createGraph({ paths, state, draftPath = null, indexPath } = {}) {
  const graph = {
    nodes: new Map(),
    topology: new Map(),
    active: null,
    lock: null,
    nextSeq: 0,
    // Set by `wipe` / `new graph`; bookmarks the next committed node (the start
    // of fresh content / a new graph's root), then cleared.
    pendingBookmark: null,
    // Provenance of turns that ended with no surface change and therefore
    // committed no node (see domain/turns accumulateFolded). Rides _meta.json
    // alongside pendingBookmark and folds onto the next node that does commit.
    pendingFolded: [],
    pendingFoldedDropped: 0,
    // A user re-aim queued during a locked turn (see domain/turns
    // setPendingReaim); applied after turn-end / on unlock. In-memory only.
    pendingReaim: null,
    // id -> content digest of that node's surface (domain/turns nodeViewKey).
    // Filled once per node, at load and at registerNode, so the "is this node
    // identical to its parent" question is a string compare rather than a
    // re-projection of every node's pane HTML on every read. Derived state:
    // persisted only in the derived graph index (above createGraph), and
    // re-hashed at load whenever the node file or the projection version
    // disagrees with its entry.
    viewKeys: new Map(),
    // Bumped by every topology change (registerNode, load) so computeLabelsCached
    // can tell a stale label map from a current one. Derived state, never persisted.
    topoRev: 0,
    // Where this project's draft.json lives, for the commit paths that start far
    // from a route holding one: a wake's lock (domain/queue emitWake →
    // turns.acquireWakeLock) can steal a stale lock, and that steal commits the
    // abandoned turn's work — which supersedes the draft like any commit.
    // Derived ONCE, by createServer, and handed in; the graph routes read it
    // from here too. Null for a graph built outside a server (a unit test).
    draftPath,
    // Where the derived graph index lives: the project's graphIndex when the
    // paths name a root (createServer's do), else none — a graph built outside a
    // server has no index, as it has no draftPath. `indexPath` overrides it
    // (tests); null turns it off.
    indexPath: indexPath !== undefined ? indexPath
      : (paths && paths.root ? projectPaths(paths.root).graphIndex : null),
    // The ids of nodes built from a header whose body could not be read when
    // first touched (the file gone, torn, or no longer that node). Such a node
    // answers an empty body, and writeNode refuses it. Derived, never
    // persisted: the next boot reads the file afresh (and sets it aside if it
    // is unreadable then).
    unreadableBodies: new Set(),
  };

  // The index's in-memory entries, file name -> {id, size, mtime_ms, view_key,
  // header}, kept current by load, writeNode and registerNode; flushIndex
  // writes them when something changed since the file was read or last
  // written. An entry's header describes the file's BYTES as last read or
  // written, never the node in memory.
  let indexEntries = new Map();
  let indexDirty = false;

  // node object -> its lazy state {id, file, bodyKeys, getters, done, derived}
  // while it was built from a header (done once its body was read, or failed).
  let lazyOf = new WeakMap();
  let lazyCounts = { headers: 0, faults: 0, faulted_ids: [] };
  const FAULTED_IDS_MAX = 50;

  // Re-stat one node file and record its entry (view_key / header null until
  // known). A file that cannot be stat'ed has no entry.
  const refreshEntry = (file, id, viewKey, header) => {
    if (!graph.indexPath) return;
    indexDirty = true;
    let st;
    try { st = fs.statSync(path.join(paths.GRAPH_DIR, file)); } catch { indexEntries.delete(file); return; }
    indexEntries.set(file, { id, size: st.size, mtime_ms: st.mtimeMs, view_key: viewKey || null, header: header || null });
  };
  // headerOf for an entry: a node it throws on (a shape the load's floors
  // throw on too) simply has no header, and is read whole next boot.
  const headerOrNull = (node) => { try { return headerOf(node); } catch { return null; } };

  // THE FAULT: read a lazy node's file once and put its body in place. Every
  // body key still carrying its accessor becomes a plain data property with
  // the file's value (a key the file no longer holds goes); every header field
  // stays as it is in memory, so a bookmark or a theme set before the touch is
  // kept. A file that is gone, torn or no longer this node gives the empty
  // body instead, one stderr line, and the mark writeNode refuses.
  const faultBody = (node, lz) => {
    if (lz.done) return;
    lz.done = true;
    lazyCounts.faults++;
    if (lazyCounts.faulted_ids.length < FAULTED_IDS_MAX) lazyCounts.faulted_ids.push(lz.id);
    const r = readJson(path.join(paths.GRAPH_DIR, lz.file), { validate: isGraphNode });
    const ok = r.ok && r.value.id === lz.id;
    if (!ok) {
      lz.unreadable = true;
      graph.unreadableBodies.add(lz.id);
      const why = r.ok ? `it now holds ${String(r.value.id)}` : r.absent ? 'file disappeared'
        : (r.invalid ? 'not a graph node' : (r.error && r.error.message));
      console.error(`[web-chat] the body of graph node ${lz.id} (${lz.file}) is unreadable: ${why}; it reads empty and is not rewritten until a restart`);
      const e = indexEntries.get(lz.file);
      if (e && e.id === lz.id) { indexEntries.delete(lz.file); indexDirty = true; }
    }
    for (const k of lz.bodyKeys) {
      const d = Object.getOwnPropertyDescriptor(node, k);
      if (!d || d.get !== lz.getters.get(k)) continue;
      if (ok) {
        if (own.call(r.value, k)) defineData(node, k, r.value[k]);
        else delete node[k];
      } else if (own.call(EMPTY_BODY, k)) {
        defineData(node, k, EMPTY_BODY[k]());
      } else {
        delete node[k];
      }
    }
  };

  // A node built from its header: the header fields as plain data properties
  // (a copy — the entry keeps its own), each body key an enumerable,
  // configurable accessor, in the file's key order. A set before the first
  // touch reads the body first, then sets.
  const lazyNode = (header, file) => {
    const node = {};
    const fields = structuredClone(header.node);
    const lz = {
      id: header.node.id, file, bodyKeys: header.body_keys.slice(), getters: new Map(),
      done: false, unreadable: false, derived: header,
    };
    for (const k of header.key_order) {
      if (!BODY_KEY_SET.has(k)) { defineData(node, k, fields[k]); continue; }
      const get = () => { faultBody(node, lz); return node[k]; };
      const set = (v) => { faultBody(node, lz); node[k] = v; };
      lz.getters.set(k, get);
      Object.defineProperty(node, k, { get, set, enumerable: true, configurable: true });
    }
    lazyOf.set(node, lz);
    return node;
  };
  const bodyPending = (node) => {
    const lz = node && typeof node === 'object' ? lazyOf.get(node) : null;
    return lz && !lz.done ? lz : null;
  };

  // Atomic (lib/core/fsjson): a node file is the only record of a committed
  // turn, and a crash or a full disk mid-write used to leave a truncated one
  // that graph.load then had to skip — losing the turn. Throws to the caller on
  // failure, which for the commit path means the route 500s rather than
  // reporting a commit that is not on disk.
  //
  // The index entry follows the write: the file is re-stat'ed so the after-
  // listen flush never records a stale stat. A REWRITE of a registered node
  // (the bookmark, the node theme, the late-Stop patch — none of them projected
  // by snapshotView) records nodeViewKey of the bytes written, so the stored
  // key is what the next boot's full re-hash would give even if a rewrite ever
  // did touch a projected field (the in-memory key is left as it was, as
  // before the index). A new node's key comes from registerNode, next.
  //
  // THE REFUSAL (RULED U572-U573@index-cadence-and-refusal (a)): a node whose
  // body could not be read after boot (graph.unreadableBodies) is never
  // rewritten — writing it would replace the turn's panes, store and comments
  // on disk with the empty body it reads as. writeNode reads a lazy node's
  // body first (writing it whole needs it anyway), then throws an Error with
  // code 'NODE_BODY_UNREADABLE' before touching the file: the bookmark and
  // theme routes answer 500, the late-Stop patch's own catch takes it. The
  // header change the caller made in memory before the call stays there
  // until the restart.
  graph.writeNode = (node) => {
    const lz = bodyPending(node);
    if (lz) faultBody(node, lz);
    if (node && graph.unreadableBodies.has(node.id)) {
      const err = new Error(`graph node ${node.id}: its body could not be read, so it is not rewritten`);
      err.code = 'NODE_BODY_UNREADABLE';
      throw err;
    }
    const file = `${node.id}.json`;
    writeJsonAtomic(path.join(paths.GRAPH_DIR, file), node, { mkdir: false });
    if (!graph.indexPath) return;
    const registered = graph.nodes.has(node.id);
    refreshEntry(file, node.id, registered ? nodeViewKey(node) : null, registered ? headerOrNull(node) : null);
  };

  graph.saveMeta = () => {
    // The lock is persisted so a crash mid-turn doesn't silently lose it; on the
    // next boot a stale one is cleared (see createServer) and a still-fresh one
    // is restored. A clean turn-end/unlock writes lock:null here.
    //
    // pending_bookmark / pending_folded ride here too: both are "state that
    // waits for the next commit", and a daemon restart between the gesture and
    // that commit used to lose them (a `new graph` name, and now the provenance
    // of every collapsed chat-only turn). Additive keys — an older _meta.json
    // without them loads as "nothing pending".
    //
    // Atomic (lib/core/fsjson), and this is the record that most needed it: it is
    // rewritten on every lock acquire and release, so it is the file a crash is
    // most likely to catch mid-write — and a torn one used to read as "the user
    // wiped the surface", which then took draft.json with it.
    //
    // last_node (additive, like the two above) is the last node commitNode
    // committed: a boot that finds a node newer than it knows the meta was not
    // saved after that commit, as opposed to a re-aim (domain/turns commitNode).
    writeJsonAtomic(paths.META_PATH, {
      active: graph.active,
      lock: graph.lock || null,
      pending_bookmark: graph.pendingBookmark || null,
      pending_folded: graph.pendingFolded || [],
      pending_folded_dropped: graph.pendingFoldedDropped || 0,
      last_node: graph.lastNode || null,
    }, { mkdir: false });
  };

  graph.registerNode = (node) => {
    graph.nodes.set(node.id, node);
    graph.topology.set(node.id, topoEntry(node));
    const key = nodeViewKey(node);
    graph.viewKeys.set(node.id, key);
    if (graph.indexPath) refreshEntry(`${node.id}.json`, node.id, key, headerOrNull(node));
    if (node.parent_id && graph.topology.has(node.parent_id)) {
      graph.topology.get(node.parent_id).children.push(node.id);
    }
    graph.topoRev++;
  };

  graph.load = () => {
    const entries = fs.readdirSync(paths.GRAPH_DIR);
    // An id is claimed by a FILE EXISTING, not by that file being readable.
    //
    // nextSeq used to be seeded only from the nodes that LOADED, so an n<K>.json
    // we had just declined to read left nextSeq behind it and the next commit
    // wrote straight over the file — destroying the one record of that turn
    // moments after refusing to destroy it. Worse, any surviving node whose
    // parent_id still names n<K> would have grafted onto the unrelated new node.
    //
    // So the scan runs over the raw directory listing and matches on the `n<K>.json`
    // PREFIX: it covers live node files, the `.corrupt-<ts>` copies the skip path
    // below renames aside (which is what keeps the id claimed on every later boot,
    // once the original name is gone), and a `n<K>.json.<pid>.tmp` left by a crash
    // mid-write.
    for (const f of entries) {
      const m = /^n(\d+)\.json/.exec(f);
      if (!m) continue;
      const seqNum = parseInt(m[1], 10);
      if (Number.isFinite(seqNum) && seqNum >= graph.nextSeq) graph.nextSeq = seqNum + 1;
    }
    const files = entries.filter(f => f.endsWith('.json') && f !== '_meta.json');
    // Skip-on-error. A bare JSON.parse here meant a single truncated node file —
    // a crash or a full disk mid-write — threw out of graph.load(), which
    // createServer calls unguarded, so the daemon could never boot again FOR
    // THAT PROJECT, forever. Losing one unreadable node is recoverable; losing
    // the whole graph is not.
    //
    // The SHAPE check is half of that guarantee, not a nicety: guarding only the
    // parse left `null` and `{}` (both perfectly valid JSON, and both plausible
    // outputs of a crash or a half-written placeholder) to reach the sort's
    // `a.created_at` and `n.id.replace` below and throw out of load anyway.
    // isGraphNode is applied inside the same read, so an unusable file is
    // skipped and logged rather than wedging boot.
    const nodes = [];
    // What this load set aside, beside the stderr lines (U209's boot report
    // reads it): each unreadable node file and the meta, with why. `index` is
    // the graph index's content-free counts (null when this graph has none):
    // whether a file was there, why it was not used (null | 'absent' |
    // 'corrupt' | 'invalid' | 'pv'), how many entries it held, how many
    // view keys this load took from it or hashed, how many nodes it built
    // from a stored header (`headers`) and how many it read whole
    // (`read_whole`, the files that loaded).
    graph.loadReport = { nodes_aside: [], meta_aside: null, index: null };
    indexEntries = new Map();
    indexDirty = false;
    lazyOf = new WeakMap();
    lazyCounts = { headers: 0, faults: 0, faulted_ids: [] };
    graph.unreadableBodies = new Set();
    let stored = null;
    const indexReport = graph.indexPath
      ? { present: false, reason: null, entries: 0, taken: 0, hashed: 0, headers: 0, read_whole: 0 }
      : null;
    if (indexReport) {
      const ir = readJson(graph.indexPath, { validate: isGraphIndex });
      indexReport.present = !ir.absent;
      if (ir.ok) {
        indexReport.entries = Object.keys(ir.value.nodes).length;
        if (ir.value.pv === PROJECTION_VERSION) stored = ir.value.nodes;
        else indexReport.reason = 'pv';
      } else {
        indexReport.reason = ir.absent ? 'absent' : (ir.invalid ? 'invalid' : 'corrupt');
      }
      // Anything but a usable index is rewritten after the listen.
      if (!stored) indexDirty = true;
    }
    // node object -> {file, st, entry?}: the stat is taken BEFORE the read, so
    // a file rewritten between the two records the older stat and is re-hashed
    // next boot rather than keeping a key for bytes it no longer holds.
    //
    // A name whose entry passes the view-key checks AND carries a usable
    // header is never read here: the node is built from the header (lazyNode)
    // and its body read on first touch. Any other name — absent from the
    // index (a node committed during the last run, or by an older build after
    // a rollback), its stat or id disagreeing, its header unusable — is read
    // whole, exactly as before the index.
    const fileOf = new Map();
    for (const f of files) {
      const p = path.join(paths.GRAPH_DIR, f);
      let st = null;
      if (indexReport) { try { st = fs.statSync(p); } catch {} }
      const e = st && stored && own.call(stored, f) ? stored[f] : null;
      if (e && indexEntryUsable(e) && statAgrees(st, e) && headerUsable(e.header, e.id)) {
        const n = lazyNode(e.header, f);
        nodes.push(n);
        fileOf.set(n, { file: f, st, entry: e });
        indexReport.headers++;
        lazyCounts.headers++;
        continue;
      }
      const r = readJson(p, { validate: isGraphNode });
      if (r.ok) {
        nodes.push(r.value);
        if (indexReport) { fileOf.set(r.value, { file: f, st }); indexReport.read_whole++; }
        continue;
      }
      const why = r.absent ? 'file disappeared' : (r.invalid ? 'not a graph node' : (r.error && r.error.message));
      // "I could not read this" is not a licence to destroy it (lib/core/fsjson
      // renameAside, the same rule loadDraft follows). The bytes are the only
      // record of that turn and a human — or a later reader that knows more than
      // isGraphNode does — may still get something out of them, so they move to
      // `<name>.corrupt-<ts>` rather than staying under a name the commit path
      // is entitled to write.
      let aside = null;
      try {
        aside = renameAside(p, { keep: KEEP_ASIDE });
      } catch (e) {
        console.error(`[web-chat] could not move ${f} aside: ${e && e.message}`);
      }
      const moved = aside ? ` (moved to ${path.basename(aside)})` : '';
      console.error(`[web-chat] skipping unreadable graph node ${f}: ${why}${moved}`);
      graph.loadReport.nodes_aside.push({ file: f, aside: aside ? path.basename(aside) : null, why: String(why || '') });
    }
    nodes.sort((a, b) => a.created_at - b.created_at);
    // The derived fields of each node read whole (the seq floors below read
    // them; built from a header, a node's come from its entry).
    const derivedAt = new Map();
    for (const n of nodes) {
      graph.nodes.set(n.id, n);
      graph.topology.set(n.id, topoEntry(n));
      let key = null;
      const at = fileOf.get(n);
      if (at && at.entry) {
        // Built from its header: the entry was checked above.
        key = at.entry.view_key;
        indexReport.taken++;
        if (at.st.mtimeMs !== at.entry.mtime_ms) indexDirty = true;
      } else if (at && at.st && stored && own.call(stored, at.file)) {
        const e = stored[at.file];
        if (indexEntryUsable(e) && e.id === n.id && statAgrees(at.st, e)) {
          key = e.view_key;
          indexReport.taken++;
          // A copy may have moved the mtime inside the millisecond: record
          // what the file says now, so the next boot compares against it.
          if (at.st.mtimeMs !== e.mtime_ms) indexDirty = true;
        }
      }
      if (!key) {
        key = nodeViewKey(n);
        if (indexReport) { indexReport.hashed++; indexDirty = true; }
      }
      graph.viewKeys.set(n.id, key);
      if (at && at.entry) {
        indexEntries.set(at.file, { id: n.id, size: at.st.size, mtime_ms: at.st.mtimeMs, view_key: key, header: at.entry.header });
      } else if (at && at.st) {
        const header = headerOrNull(n);
        if (header) derivedAt.set(n, header);
        indexEntries.set(at.file, { id: n.id, size: at.st.size, mtime_ms: at.st.mtimeMs, view_key: key, header });
        // Every entry a whole read made carries a header the index lacked.
        indexDirty = true;
      } else if (at) {
        indexDirty = true;
      }
      // Belt to the filename scan's braces: a node whose id disagrees with its
      // filename (hand-edited, or copied in from elsewhere) still claims its id.
      const seqNum = parseInt(n.id.replace(/^n/, ''), 10);
      if (!isNaN(seqNum) && seqNum >= graph.nextSeq) graph.nextSeq = seqNum + 1;
    }
    for (const t of graph.topology.values()) {
      if (t.parent_id && graph.topology.has(t.parent_id)) {
        graph.topology.get(t.parent_id).children.push(t.id);
      }
    }
    graph.topoRev++;
    if (indexReport) {
      // An entry for a file that no longer loads (removed, set aside) is
      // dropped by the next flush.
      if (stored) for (const f of Object.keys(stored)) if (!indexEntries.has(f)) { indexDirty = true; break; }
      graph.loadReport.index = indexReport;
    }
    // Respect an explicit active:null in _meta.json (a wiped / fresh-blank
    // surface). Only fall back to "latest" when active is a *non-null* id that
    // is missing from the graph (corruption / deleted node).
    graph.active = null;
    graph.lock = null;
    graph.pendingBookmark = null;
    graph.pendingFolded = [];
    graph.pendingFoldedDropped = 0;
    graph.lastNode = null;
    // ABSENT is meaningful and stays meaningful: no _meta.json means a graph
    // that has never had a commit point, and active stays null.
    //
    // CORRUPT or wrong-shaped is NOT the same thing, and used to be swallowed by
    // a bare `catch {}` that left active null — indistinguishable from the
    // deliberate wipe above. The cost was not a blank surface: createServer then
    // called loadDraft with active=null, every real draft looked stale, and the
    // one file protecting uncommitted work was deleted. A torn meta now means
    // "the active id is UNKNOWN", which falls through to the same latest-node
    // recovery a dangling active id already took, and saveMeta rewrites a whole
    // file so the damage does not persist.
    let activeUnknown = false;
    const metaRead = readJson(paths.META_PATH, {
      validate: (m) => m && typeof m === 'object' && !Array.isArray(m),
    });
    if (metaRead.ok) {
      const meta = metaRead.value;
      graph.active = meta.active || null;
      graph.lock = meta.lock || null;
      graph.pendingBookmark = meta.pending_bookmark || null;
      graph.pendingFolded = Array.isArray(meta.pending_folded) ? meta.pending_folded.map((f) => ({ ...f })) : [];
      graph.pendingFoldedDropped = Number(meta.pending_folded_dropped) || 0;
      graph.lastNode = typeof meta.last_node === 'string' ? meta.last_node : null;
    } else if (!metaRead.absent) {
      activeUnknown = true;
      const why = metaRead.invalid ? 'not an object' : (metaRead.error && metaRead.error.message);
      // The recovery below REWRITES this file, so move the unreadable bytes aside
      // first. renameAside landed with fsjson for exactly this ("I could not read
      // it" is not a licence to destroy it) and was wired to draft.json but never
      // to the meta — which is the record most likely to be caught mid-write, and
      // the one that carries the turn lock and the pending bookmark a human may
      // want to look at after a crash.
      let aside = null;
      try {
        aside = renameAside(paths.META_PATH, { keep: KEEP_ASIDE });
      } catch (e) {
        console.error(`[web-chat] could not move graph/_meta.json aside: ${e && e.message}`);
      }
      const moved = aside ? ` kept as ${path.basename(aside)};` : '';
      console.error(`[web-chat] graph/_meta.json is unreadable (${why});${moved} recovering the active node from the latest commit`);
      graph.loadReport.meta_aside = { aside: aside ? path.basename(aside) : null, why: String(why || '') };
    }
    if (activeUnknown || (graph.active && !graph.nodes.has(graph.active))) {
      const latest = [...graph.nodes.values()].sort((a, b) => b.created_at - a.created_at)[0];
      graph.active = latest ? latest.id : null;
      // BEST-EFFORT heal. graph.load is called unguarded by createServer, so a
      // throw here is the daemon failing to boot — and this write can genuinely
      // fail for reasons a rename cannot fix (a directory at META_PATH, an
      // unwritable graph dir, a full disk). The recovered `active` is already in
      // memory and correct; persisting it is an optimisation for the NEXT boot,
      // never a precondition for this one.
      try {
        graph.saveMeta();
      } catch (e) {
        console.error(`[web-chat] could not rewrite graph/_meta.json: ${e && e.message}`);
      }
    }
    // Reserve the highest comment seq in ANY node in the element log, the one
    // id authority (domain/elements; PLAN 1A.2): a seq only a node copy holds
    // (a node 0.8.5 wrote during a rollback, a hand-made one) is never minted
    // again, so a new pin never reuses an id, even after navigating to an
    // older branch.
    //
    // Both floors read each node's derived fields (derivedOf: the expressions
    // this loop and the next held before the index, verbatim, per node), so a
    // node built from its header reads no body here.
    const derivedFor = (n) => {
      const lz = lazyOf.get(n);
      return lz ? lz.derived : (derivedAt.get(n) || derivedOf(n));
    };
    let maxSeq = 0;
    for (const n of graph.nodes.values()) {
      const d = derivedFor(n);
      if (d.max_comment_seq > maxSeq) maxSeq = d.max_comment_seq;
    }
    if (graph.elements && maxSeq > 0) graph.elements.reserveSeq(maxSeq);
    // Same seeding for captures: push the global capture counter past the highest
    // seq in any node so a new capture never reuses an id (or clobbers an existing
    // sidecar file), even after navigating to an older branch.
    let maxCapSeq = 0;
    for (const n of graph.nodes.values()) {
      const d = derivedFor(n);
      if (d.max_capture_seq > maxCapSeq) maxCapSeq = d.max_capture_seq;
    }
    // …and, for the same reason nextSeq is seeded from the node FILENAMES above,
    // past the highest seq that has a SIDECAR on disk. A capture's `capN.html` is
    // written before the record reaches a node, and the node carrying it can be
    // one graph.load declined to read — either way the counter would come back
    // below a file the next capture then overwrites. A file existing claims its
    // id here too.
    if (paths.CAPTURES_DIR) {
      let sidecars = [];
      try { sidecars = fs.readdirSync(paths.CAPTURES_DIR); } catch {}
      for (const f of sidecars) {
        const m = /^cap(\d+)\./.exec(f);
        if (!m) continue;
        const n = parseInt(m[1], 10);
        if (Number.isFinite(n) && n > maxCapSeq) maxCapSeq = n;
      }
    }
    state.captureSeq = Math.max(state.captureSeq, maxCapSeq);
  };

  // Write the graph index when anything changed since it was read or last
  // written. createServer calls it ONCE, on the first immediate after the
  // listen. {mkdir: false}: a removed .web-chat/ is never recreated (the
  // instance guard's rule). Never throws — the index is derived, so a failed
  // write costs the next boot the old hashing and nothing else. Returns
  // whether a file was written.
  graph.flushIndex = () => {
    if (!graph.indexPath || !indexDirty) return false;
    try {
      const nodes = {};
      // A lazy node's header is written from its entry, never by touching
      // its body.
      for (const file of [...indexEntries.keys()].sort()) {
        const e = indexEntries.get(file);
        if (!e || !e.view_key || !e.header || !graph.nodes.has(e.id)) continue;
        nodes[file] = { id: e.id, size: e.size, mtime_ms: e.mtime_ms, view_key: e.view_key, header: e.header };
      }
      writeJsonAtomic(graph.indexPath, { v: INDEX_VERSION, pv: PROJECTION_VERSION, nodes }, { pretty: 0, mkdir: false });
      indexDirty = false;
      return true;
    } catch (e) {
      console.error(`[web-chat] could not write the graph index ${path.basename(String(graph.indexPath))}: ${e && e.message}`);
      return false;
    }
  };

  // The derived fields of one node — {body_keys, pins, max_comment_seq,
  // max_capture_seq, capture_ids} (the shapes are the index header's, above
  // createGraph) — answered whether or not its body is resident: from the
  // stored header while the body has not been read, from the node in memory
  // once it has (or for a node read whole). Null for an unknown id. A copy:
  // the caller may keep or change it. pins null means "read the body" (the
  // reconcile's seam, U574).
  graph.headerOf = (id) => {
    const node = graph.nodes.get(id);
    if (!node) return null;
    const lz = bodyPending(node);
    const d = lz ? lz.derived : derivedOf(node);
    return {
      body_keys: d.body_keys.slice(),
      pins: d.pins ? d.pins.map((p) => ({ ...p })) : null,
      max_comment_seq: d.max_comment_seq,
      max_capture_seq: d.max_capture_seq,
      capture_ids: d.capture_ids ? d.capture_ids.slice() : null,
    };
  };

  // Counts for the reconcile's proof (U574) and the soak: how many nodes this
  // load built from a header, how many bodies are in memory (read whole, read
  // on touch, or committed this run — an unreadable one is not), how many
  // bodies were read on touch, how many could not be, and the first
  // FAULTED_IDS_MAX node ids read on touch, in order.
  graph.lazyStats = () => {
    let resident = 0;
    for (const n of graph.nodes.values()) {
      const lz = lazyOf.get(n);
      if (!lz || (lz.done && !lz.unreadable)) resident++;
    }
    return {
      headers: lazyCounts.headers,
      resident,
      faults: lazyCounts.faults,
      unreadable: graph.unreadableBodies.size,
      faulted_ids: lazyCounts.faulted_ids.slice(),
    };
  };

  graph.snapshotLive = () => {
    // ONE field authority for the mount record: a snapshot carries exactly what
    // hydrateMount will read back (id + SNAPSHOT_FIELDS, in that order), because
    // every consumer of this snapshot — commitNode's node file, writeDraft's
    // draft.json, the diff and the export — is read back through hydrateMount or
    // through those same fields.
    //
    // It used to be an open `{ id, ...m }` spread, i.e. a writer that persisted
    // whatever the live record happened to hold while the reader picked. The live
    // record grew `gen` (the re-render counter behind the queue's Revert guard),
    // so every committed node and every draft carried a field D18 had explicitly
    // decided to keep OUT of node bytes, and which nothing would ever read back.
    // Live-only state that DOES need to survive a shutdown is picked explicitly
    // below (queue / pendingWake / pendingAck) — never inherited by spread.
    //
    // Panes are listed in PAGE order (lib/server/domain/page), and the page's
    // markdown items + full order ride beside them — see page.snapshot.
    const mounts = [];
    for (const [id, m] of page.orderedMounts(state)) mounts.push({ id, ...hydrateMount(m) });
    const pg = page.snapshot(state);
    return {
      mounts,
      markdown: pg.markdown,
      order: pg.order,
      // Layout state, present only off its defaults (page.layoutFields):
      // Claude's baseline order once the user has rearranged, and run flags.
      ...(pg.claude_order ? { claude_order: pg.claude_order } : {}),
      ...(pg.runs ? { runs: pg.runs } : {}),
      store: { ...state.store },
      comments: state.comments.map(clonePin),
      // The non-comment elements' id@v references (domain/element-refs, E-STORE):
      // always a list here; the node, draft and view-key writers drop it empty.
      elements: elementRefs.refsOf(state),
      captures: state.captures.map((c) => ({ ...c })),
      // The wake queue rides the live snapshot so it persists into draft.json on
      // shutdown. commitNode picks specific fields into a graph node and does NOT
      // include `queue` — pending wakes stay live-only, never committed history.
      queue: state.queue.map((q) => ({ ...q })),
      // A parked wake (Push made while no channel was connected) rides the
      // draft too, so a Push isn't lost across a graceful restart. Like the queue,
      // commitNode does NOT pick it into a node — it's pending-wake state.
      pendingWake: state.pendingWake ? { ...state.pendingWake } : null,
      // An in-flight (un-acked) live wake rides the draft too, so a Push mid-flight
      // at shutdown isn't lost — on restore it ages into a park and delivers on
      // the next message (its original boot's wake seq is dead, so it can't be acked).
      pendingAck: state.pendingAck ? { ...state.pendingAck } : null,
    };
  };

  graph.restoreLiveToNode = (id, bus) => {
    const node = graph.nodes.get(id);
    if (!node) return;
    state.mounts.clear();
    for (const m of (node.mounts || [])) {
      state.mounts.set(m.id, hydrateMount(m));
    }
    page.restore(state, node);
    for (const k of Object.keys(state.store)) delete state.store[k];
    Object.assign(state.store, node.store || {});
    // Pins travel with the node; the element log's seq is NOT reset here (it
    // only ever grows), so a pin added on an older node still gets a fresh
    // unique id and the comment cursor never goes back.
    state.comments = Array.isArray(node.comments) ? node.comments.map(clonePin) : [];
    // Element references travel with the node too (absent → []); the log they
    // name is never touched here (domain/element-refs).
    elementRefs.setRefs(state, node.elements);
    // The wake queue does NOT travel with the node (it's live-only pending-wake
    // state), so a queued element can outlive what it stands for once we swap
    // comments and element references wholesale. Drop every queued member
    // whose page-family element the restored node does not hold — a comment
    // by the restored pins, any other page type by the restored element
    // references — through the queue's own removal (removeByElement: a group
    // loses the member with an update frame, its last member's leaving
    // removes it), so Push never wakes Claude quoting a ghost. A chat-family
    // member is never dropped by a restore (it is gone only by its own Delete,
    // RULED REQ@chat-wipe O1 = a). A legacy kind 'comment' item restored from
    // an older draft goes the same way by its comment_id.
    if (bus && Array.isArray(state.queue) && state.queue.length) {
      const pins = new Set(state.comments.map((c) => c.id));
      const familyOf = (type) => {
        try { return graph.elements && typeof graph.elements.familyOf === 'function' ? graph.elements.familyOf(type) : 'page'; } catch { return 'page'; }
      };
      const orphaned = new Set();
      for (const it of state.queue) {
        if (it.kind === 'comment' && it.comment_id && !pins.has(it.comment_id)) orphaned.add(it.comment_id);
        if (it.kind !== 'element' || familyOf(it.type) === 'chat') continue;
        const members = Array.isArray(it.element_ids) ? it.element_ids : (it.element_id ? [it.element_id] : []);
        for (const m of members) {
          const held = it.type === 'comment' ? pins.has(m) : !!elementRefs.refOf(state, m);
          if (!held) orphaned.add(m);
        }
      }
      for (const elementId of orphaned) queueDomain.removeByElement(state, bus, elementId);
    }
    // Captures travel with the node too (same counter discipline as comments).
    // Their raw_ref sidecar files are keyed by the global-unique id, so they
    // remain valid no matter which node restored the record.
    state.captures = Array.isArray(node.captures) ? node.captures.map((c) => ({ ...c })) : [];
    // The same holds for capture items: the swap takes off every live capture the
    // restored node does not hold, so drop each queued capture item whose capture
    // isn't in the restored set (removeByCapture, through the queue's one removal
    // path, so an open rail gets the remove frame at once). Without it a Push would
    // deliver a capture id get_captures no longer lists. With no bus the items go
    // silently (removeByCapture's own fallback) — they still go.
    if (Array.isArray(state.queue) && state.queue.length) {
      const restored = new Set(state.captures.map((c) => c && c.id));
      const orphaned = state.queue
        .filter((it) => it.kind === 'capture' && it.capture_id && !restored.has(it.capture_id))
        .map((it) => it.capture_id);
      queueDomain.removeByCapture(state, bus, orphaned);
    }
    // The live cap holds after a restore too (ruled A4 (c)): a node committed
    // before 0.8.5 may hold more than 50. The node keeps every one; only the live
    // list is trimmed.
    liveCaptures.retain(state, { bus });
    // Each restored pin gets the log version it pins, hash-checked
    // (domain/elements attachLive): only `v` is added, never text.
    if (graph.elements) graph.elements.attachLive(state.comments, { node: id });
  };

  // Empty the live surface's panes only; the store is intentionally preserved.
  // Used by the Wipe button and by boot when there is no active node.
  //
  // `keepPinned` is the selective form: a pin is load-bearing, not just a
  // drag-reorder guard, so a WIPE leaves pinned panes standing. Boot's blank-slate
  // clear and `new graph` (which detaches active entirely — a genuinely fresh
  // tree, not a fresh page in this one) keep the wholesale behaviour by default.
  //
  // Prose has no pin of its own, so markdown goes — except the markdown directly
  // above a surviving pinned pane (page.markdownAbove: its heading/caption run),
  // which stays with it. page.clearMarkdown also re-derives the order, so the
  // survivors keep their relative positions.
  graph.clearLiveMounts = ({ keepPinned = false } = {}) => {
    if (!keepPinned) { state.mounts.clear(); page.clearMarkdown(state); return []; }
    const kept = [];
    for (const [id, m] of state.mounts) {
      if (m && m.pane_state && m.pane_state.pinned) kept.push(id);
    }
    const keepMd = page.markdownAbove(state, kept);
    for (const id of [...state.mounts.keys()]) if (!kept.includes(id)) state.mounts.delete(id);
    page.clearMarkdown(state, { keep: keepMd });
    return kept;
  };

  return graph;
}

module.exports = { createGraph, computeLabels: computeLabelsCached, computeCollapse, INDEX_VERSION, BODY_KEYS, headerOf };
