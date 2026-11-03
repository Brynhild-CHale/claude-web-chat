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
// one entry per node FILE: {id, size, mtime_ms, view_key}, under the index's
// own version `v` and the projection version `pv` (domain/turns
// PROJECTION_VERSION). graph.load takes a node's stored view key instead of
// re-hashing its snapshotView when the entry's id, its size and its mtime agree
// with the file and `pv` matches; anything else is hashed as before.
//
// What it is NOT: the only copy of anything. Nothing reads it but graph.load,
// and the key it carries is read only by computeCollapse (which nodes the
// drawn graph hides); labels, liveIsDirty and every data decision ignore it.
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
const INDEX_VERSION = 1;
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
  };

  // The index's in-memory entries, file name -> {id, size, mtime_ms, view_key},
  // kept current by load, writeNode and registerNode; flushIndex writes them
  // when something changed since the file was read or last written.
  let indexEntries = new Map();
  let indexDirty = false;

  // Re-stat one node file and record its entry (view_key null until a key is
  // known). A file that cannot be stat'ed has no entry.
  const refreshEntry = (file, id, viewKey) => {
    if (!graph.indexPath) return;
    indexDirty = true;
    let st;
    try { st = fs.statSync(path.join(paths.GRAPH_DIR, file)); } catch { indexEntries.delete(file); return; }
    indexEntries.set(file, { id, size: st.size, mtime_ms: st.mtimeMs, view_key: viewKey || null });
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
  graph.writeNode = (node) => {
    const file = `${node.id}.json`;
    writeJsonAtomic(path.join(paths.GRAPH_DIR, file), node, { mkdir: false });
    if (!graph.indexPath) return;
    refreshEntry(file, node.id, graph.nodes.has(node.id) ? nodeViewKey(node) : null);
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
    refreshEntry(`${node.id}.json`, node.id, key);
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
    // 'corrupt' | 'invalid' | 'pv'), how many entries it held, and how many
    // view keys this load took from it or hashed.
    graph.loadReport = { nodes_aside: [], meta_aside: null, index: null };
    indexEntries = new Map();
    indexDirty = false;
    let stored = null;
    const indexReport = graph.indexPath
      ? { present: false, reason: null, entries: 0, taken: 0, hashed: 0 }
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
    // node object -> {file, st}: the stat is taken BEFORE the read, so a file
    // rewritten between the two records the older stat and is re-hashed next
    // boot rather than keeping a key for bytes it no longer holds.
    const fileOf = new Map();
    for (const f of files) {
      const p = path.join(paths.GRAPH_DIR, f);
      let st = null;
      if (indexReport) { try { st = fs.statSync(p); } catch {} }
      const r = readJson(p, { validate: isGraphNode });
      if (r.ok) { nodes.push(r.value); if (indexReport) fileOf.set(r.value, { file: f, st }); continue; }
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
    const own = Object.prototype.hasOwnProperty;
    for (const n of nodes) {
      graph.nodes.set(n.id, n);
      graph.topology.set(n.id, topoEntry(n));
      let key = null;
      const at = fileOf.get(n);
      if (at && at.st && stored && own.call(stored, at.file)) {
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
      if (at && at.st) {
        indexEntries.set(at.file, { id: n.id, size: at.st.size, mtime_ms: at.st.mtimeMs, view_key: key });
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
    let maxSeq = 0;
    for (const n of graph.nodes.values()) {
      for (const c of (n.comments || [])) if (Number.isSafeInteger(c && c.seq) && c.seq > maxSeq) maxSeq = c.seq;
    }
    if (graph.elements && maxSeq > 0) graph.elements.reserveSeq(maxSeq);
    // Same seeding for captures: push the global capture counter past the highest
    // seq in any node so a new capture never reuses an id (or clobbers an existing
    // sidecar file), even after navigating to an older branch.
    let maxCapSeq = 0;
    for (const n of graph.nodes.values()) {
      for (const c of (n.captures || [])) if ((c.seq || 0) > maxCapSeq) maxCapSeq = c.seq;
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
      for (const file of [...indexEntries.keys()].sort()) {
        const e = indexEntries.get(file);
        if (!e || !e.view_key || !graph.nodes.has(e.id)) continue;
        nodes[file] = { id: e.id, size: e.size, mtime_ms: e.mtime_ms, view_key: e.view_key };
      }
      writeJsonAtomic(graph.indexPath, { v: INDEX_VERSION, pv: PROJECTION_VERSION, nodes }, { pretty: 0, mkdir: false });
      indexDirty = false;
      return true;
    } catch (e) {
      console.error(`[web-chat] could not write the graph index ${path.basename(String(graph.indexPath))}: ${e && e.message}`);
      return false;
    }
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

module.exports = { createGraph, computeLabels: computeLabelsCached, computeCollapse, INDEX_VERSION };
