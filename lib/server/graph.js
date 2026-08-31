const fs = require('fs');
const path = require('path');
const { writeJsonAtomic, readJson, renameAside } = require('../core/fsjson');
const { hydrateMount, nodeViewKey } = require('./domain/turns');
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
    // How many chat-only turns this node stands for (see domain/turns
    // applyFolded). 0 for an ordinary node. Surfaced in /api/graph — and so in
    // get_graph — so a collapsed run reads as "this node absorbed N turns"
    // rather than those turns having silently vanished. The turns themselves
    // live on the node's `folded` array (GET /api/graph/node/:id).
    folded_count: node.folded_count || (Array.isArray(node.folded) ? node.folded.length : 0),
    children: [],
  };
}

// The graph-node shape predicate, used by graph.load below as readJson's
// `validate`. It lives here and not in lib/core/fsjson because core holds no
// type-specific knowledge (the boundary lib/core/resources.js draws).
//
// Both fields are load-bearing at load time and nowhere else is either checked:
// `created_at` drives the chronological sort, and `id` is parsed back into an
// integer to seed nextSeq. Every node ever written is `n${nextSeq}` with a
// numeric created_at (domain/turns commitNode), so this rejects nothing real —
// only the shapes a torn or placeholder file produces.
// How many `<name>.corrupt-<ts>` copies of one record to keep beside it, matching
// the draft's cap in domain/turns (KEEP_ASIDE_DRAFTS). Nothing else in the tree
// reaps these, so a cap is what stops a graph dir growing a tail of them; keeping
// the newest three still leaves an unreadable node's id claimed forever (the
// filename scan in graph.load reads the aside copies too).
const KEEP_ASIDE = 3;

function isGraphNode(n) {
  return !!n && typeof n === 'object' && /^n\d+$/.test(n.id) && Number.isFinite(n.created_at);
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
    // re-projection of every node's pane HTML on every read. Derived state: never
    // persisted, rebuilt from the node files on each boot.
    viewKeys: new Map(),
  };

  // Atomic (lib/core/fsjson): a node file is the only record of a committed
  // turn, and a crash or a full disk mid-write used to leave a truncated one
  // that graph.load then had to skip — losing the turn. Throws to the caller on
  // failure, which for the commit path means the route 500s rather than
  // reporting a commit that is not on disk.
  graph.writeNode = (node) => {
    writeJsonAtomic(path.join(paths.GRAPH_DIR, `${node.id}.json`), node, { mkdir: false });
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
    writeJsonAtomic(paths.META_PATH, {
      active: graph.active,
      lock: graph.lock || null,
      pending_bookmark: graph.pendingBookmark || null,
      pending_folded: graph.pendingFolded || [],
      pending_folded_dropped: graph.pendingFoldedDropped || 0,
    }, { mkdir: false });
  };

  graph.registerNode = (node) => {
    graph.nodes.set(node.id, node);
    graph.topology.set(node.id, topoEntry(node));
    graph.viewKeys.set(node.id, nodeViewKey(node));
    if (node.parent_id && graph.topology.has(node.parent_id)) {
      graph.topology.get(node.parent_id).children.push(node.id);
    }
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
    for (const f of files) {
      const p = path.join(paths.GRAPH_DIR, f);
      const r = readJson(p, { validate: isGraphNode });
      if (r.ok) { nodes.push(r.value); continue; }
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
    }
    nodes.sort((a, b) => a.created_at - b.created_at);
    for (const n of nodes) {
      graph.nodes.set(n.id, n);
      graph.topology.set(n.id, topoEntry(n));
      graph.viewKeys.set(n.id, nodeViewKey(n));
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
    // Respect an explicit active:null in _meta.json (a wiped / fresh-blank
    // surface). Only fall back to "latest" when active is a *non-null* id that
    // is missing from the graph (corruption / deleted node).
    graph.active = null;
    graph.lock = null;
    graph.pendingBookmark = null;
    graph.pendingFolded = [];
    graph.pendingFoldedDropped = 0;
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
    const mounts = [];
    for (const [id, m] of state.mounts) mounts.push({ id, ...hydrateMount(m) });
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
  //
  // `keepPinned` is the selective form: a pin is load-bearing, not just a
  // drag-reorder guard, so a WIPE leaves pinned panes standing. Boot's blank-slate
  // clear and `new graph` (which detaches active entirely — a genuinely fresh
  // tree, not a fresh page in this one) keep the wholesale behaviour by default.
  graph.clearLiveMounts = ({ keepPinned = false } = {}) => {
    if (!keepPinned) { state.mounts.clear(); return []; }
    const kept = [];
    for (const [id, m] of state.mounts) {
      if (m && m.pane_state && m.pane_state.pinned) { kept.push(id); continue; }
      state.mounts.delete(id);
    }
    return kept;
  };

  return graph;
}

module.exports = { createGraph, computeLabels, computeCollapse };
