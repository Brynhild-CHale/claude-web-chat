// lib/server/domain/turns.js — the turn domain.
//
// One home for the turn lock, the commit path, the mount-field allowlist, and
// draft file I/O — lifted out of routes/graph.js and server/index.js so
// routes/graph.js shrinks to HTTP translation. The module is STATELESS: every
// function receives the live `graph` object, the change `bus`, and explicit file
// paths from the caller. It never constructs a bus and never reintroduces
// broadcast/pushEvent — notification stays on the Phase-2 bus (bus.emit), called
// at the exact sites the routes called it, so the wire stays byte-identical
// (guarded by test/bus-golden.test.js).
//
// Dependency direction: domain may import core; it imports nothing upward. The
// only intra-server dep is `computeLabels`, required LAZILY inside commitNode to
// avoid a load-time cycle with graph.js (which top-imports SNAPSHOT_FIELDS /
// hydrateMount from here).

const fs = require('fs');

// The single home for the mount-field allowlist that was hand-enumerated in
// graph.restoreLiveToNode and index.loadDraft. Order is load-bearing (it fixes
// the key order of the rebuilt live-mount object). snapshotLive stays an open
// `{ id, ...m }` spread on purpose — it is the writer; hydrateMount is the reader
// boundary. Adding a persisted-and-restored mount field is now a one-line change.
const SNAPSHOT_FIELDS = ['html', 'target', 'params', 'component', 'pane_state', 'theme', 'owner'];

// Rebuild one live `state.mounts` value from a stored/draft mount record, picking
// exactly SNAPSHOT_FIELDS in order (present-but-undefined for omitted keys —
// identical to the inline 7-field literal both restore paths used to hand-write).
function hydrateMount(m) {
  const out = {};
  for (const k of SNAPSHOT_FIELDS) out[k] = m[k];
  return out;
}

// ── Draft file I/O ─────────────────────────────────────────────────────────
// On graceful shutdown the server snapshots uncommitted live state to draft.json
// and restores it on next boot (base_active gates it to the same active node).
// One home for read/write/delete — collapses the two deleteDraft copies that
// lived in index.js (dead) and routes/graph.js (deleteDraftFile, live).

const DRAFT_SCHEMA_VERSION = 1;

// Boot restore: overlay a draft onto live state if it matches the active node.
// Unlinks a corrupt or stale (base_active mismatch) draft. Mutates `state`.
function loadDraft(draftFile, activeId, state) {
  const p = draftFile;
  if (!fs.existsSync(p)) return;
  let draft;
  try {
    draft = JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    try { fs.unlinkSync(p); } catch {}
    return;
  }
  if (!draft || draft.base_active !== activeId) {
    try { fs.unlinkSync(p); } catch {}
    return;
  }
  state.mounts.clear();
  for (const m of (draft.mounts || [])) {
    state.mounts.set(m.id, hydrateMount(m));
  }
  for (const k of Object.keys(state.store)) delete state.store[k];
  Object.assign(state.store, draft.store || {});
  state.comments = Array.isArray(draft.comments) ? draft.comments.map((c) => ({ ...c })) : [];
  for (const c of state.comments) if ((c.seq || 0) > state.commentSeq) state.commentSeq = c.seq;
  state.captures = Array.isArray(draft.captures) ? draft.captures.map((c) => ({ ...c })) : [];
  for (const c of state.captures) if ((c.seq || 0) > state.captureSeq) state.captureSeq = c.seq;
  // The wake queue survives a restart too. Re-seed queueSeq past the highest
  // restored id (ids look like `q<N>`) so new items never collide with restored
  // ones. The queue isn't in any node, so there's nothing else to seed from.
  state.queue = Array.isArray(draft.queue) ? draft.queue.map((q) => ({ ...q })) : [];
  for (const q of state.queue) {
    const n = parseInt(String(q.id || '').replace(/^q/, ''), 10);
    if (Number.isFinite(n) && n > state.queueSeq) state.queueSeq = n;
  }
  // The parked wake rides the draft. Re-seed pendingWakeSeq past the restored
  // park id (ids look like `pw<N>`) so a fresh park after boot never reuses it,
  // exactly like the queueSeq seeding above.
  state.pendingWake = draft.pendingWake ? { ...draft.pendingWake } : null;
  if (state.pendingWake) {
    const n = parseInt(String(state.pendingWake.id || '').replace(/^pw/, ''), 10);
    if (Number.isFinite(n) && n > state.pendingWakeSeq) state.pendingWakeSeq = n;
  }
}

// Shutdown snapshot: persist uncommitted live state. Skips (returns false) when
// the surface is empty across all four collections so a blank surface leaves no
// draft behind.
function writeDraft(draftFile, activeId, snap) {
  const hasMounts = (snap.mounts || []).length > 0;
  const hasStore = Object.keys(snap.store || {}).length > 0;
  const hasComments = (snap.comments || []).length > 0;
  const hasCaptures = (snap.captures || []).length > 0;
  const hasQueue = (snap.queue || []).length > 0;
  // A park with no queued items and an empty surface must still persist, so it
  // counts toward "there is a draft to write".
  const hasPending = !!snap.pendingWake;
  if (!hasMounts && !hasStore && !hasComments && !hasCaptures && !hasQueue && !hasPending) return false;
  const draft = {
    schema_version: DRAFT_SCHEMA_VERSION,
    saved_at: Date.now(),
    base_active: activeId,
    mounts: snap.mounts,
    store: snap.store,
    comments: snap.comments,
    captures: snap.captures,
    queue: snap.queue,
    pendingWake: snap.pendingWake || null,
  };
  try {
    fs.writeFileSync(draftFile, JSON.stringify(draft, null, 2));
    return true;
  } catch {
    return false;
  }
}

// Best-effort removal — the single deleteDraft (was deleteDraftFile in
// routes/graph.js + a dead copy in index.js). Called whenever a commit or a
// re-aim supersedes the uncommitted draft.
function deleteDraft(draftFile) {
  try { fs.unlinkSync(draftFile); } catch {}
}

// ── The turn lock ──────────────────────────────────────────────────────────
// A turn lock is only cleared by turn-end (the Stop hook). If a turn never
// reaches a clean Stop (user interrupt, agent crash, terminal close), the lock
// orphans and wedges the graph. After LOCK_TTL_MS a lock is considered stale
// and may be stolen by a new turn-begin or ignored by a re-aim, so the graph
// self-heals on the next interaction instead of staying wedged. LOCK_TTL_MS is
// env-read at module load (the single home for it now).
const LOCK_TTL_MS = parseInt(process.env.WEB_CHAT_LOCK_TTL_MS || '', 10) || 15 * 60 * 1000;

function lockIsStale(lock) {
  return Boolean(lock) && (Date.now() - (lock.started_at || 0)) > LOCK_TTL_MS;
}

// turn-begin. Acquires the lock, stealing a stale one (over-writing, never an
// interim null). Returns { ok:false, lock } when a FRESH lock is held (route →
// 409). On success sets graph.lock, persists, emits the combined turn-begin
// event + lock WS frame, returns { ok:true, lock, stole_stale_lock }.
function acquireLock(graph, bus, { message = '', author = 'user' } = {}) {
  if (graph.lock && !lockIsStale(graph.lock)) return { ok: false, lock: graph.lock };
  const stolen = graph.lock ? graph.lock : null;
  const base = graph.active;
  graph.lock = { base, started_at: Date.now(), message, author };
  graph.saveMeta();
  bus.emit({
    event: { kind: 'graph', op: 'turn-begin', base, stole_stale_lock: Boolean(stolen) },
    ws: { type: 'lock', lock: graph.lock },
  });
  return { ok: true, lock: graph.lock, stole_stale_lock: Boolean(stolen) };
}

// unlock. Clears the lock, persists, and emits the always-fires unlock event +
// a lock-cleared WS frame only if there was a lock (ws:null → bus null-skips).
function releaseLock(graph, bus) {
  const had = graph.lock;
  graph.lock = null;
  graph.saveMeta();
  bus.emit({
    event: { kind: 'graph', op: 'unlock', had: Boolean(had) },
    ws: had ? { type: 'lock', lock: null } : null,
  });
  return { cleared: Boolean(had) };
}

// The pre-guard shared by set-active / wipe / new-graph (re-aim the commit
// point). A fresh lock blocks (route → 409); a stale lock is stolen — cleared,
// PERSISTED, and a seq-less lock-cleared WS frame emitted (no ring entry). The
// unconditional saveMeta here is the fix for the /api/graph/new drift (it used
// to steal without persisting, unlike set-active/wipe).
function guardReaim(graph, bus) {
  if (graph.lock && !lockIsStale(graph.lock)) return { blocked: true, lock: graph.lock };
  if (graph.lock) { graph.lock = null; graph.saveMeta(); bus.emit({ ws: { type: 'lock', lock: null } }); }
  return { blocked: false };
}

// /api/commit's guard — categorically stricter than guardReaim: ANY lock blocks
// (no staleness escape, no steal), because a manual commit must not race a turn.
function lockHeld(graph) {
  return Boolean(graph.lock);
}

// Boot: a lock persisted in _meta.json was written by a prior process that no
// longer holds it, so it has no live holder regardless of age — clear it
// unconditionally (TTL-blind, and no WS emit: there are no clients at boot).
// saveMeta fires only when a lock was actually present.
function clearLockOnBoot(graph) {
  if (graph.lock) { graph.lock = null; graph.saveMeta(); }
}

// ── Commit ─────────────────────────────────────────────────────────────────

// `wipe` / `new graph` mark the *next* committed node as a bookmark (the start
// of fresh content / a new graph's root). Applied once, then cleared.
function applyPendingBookmark(graph, node) {
  if (!graph.pendingBookmark) return;
  node.bookmarked = true;
  node.name = graph.pendingBookmark.name || '';
  graph.pendingBookmark = null;
}

// The single commit path behind BOTH /api/turn-end and /api/commit. Snapshots
// live state into a new node, persists it, advances active, and emits the
// graph event + node-added WS frame. The two callers' divergences are all
// parameters:
//   parentId               turn-end: graph.lock.base   commit: graph.active
//   author/triggerKind     'claude'/'turn'             'manual'/'manual'
//   message                graph.lock.message          body message
//   clearLock              true (turn-end clears)       false
//   op                     'turn-end'                   'commit'
//   includeLabelAndUnlock  true (adds node.label +      false
//                          top-level unlock:true)
// The lock precondition (turn-end soft-skips w/o a lock; commit 409s WITH one)
// stays in the routes — it decides whether commitNode is called at all.
function commitNode(graph, bus, {
  draftPath, parentId, author, triggerKind, message, summary,
  clearLock, op, includeLabelAndUnlock,
}) {
  const snap = graph.snapshotLive();
  const newId = `n${graph.nextSeq++}`;
  const node = {
    id: newId,
    parent_id: parentId,
    created_at: Date.now(),
    author,
    trigger: { kind: triggerKind, message, summary: summary || (message ? String(message).slice(0, 100) : '') },
    mounts: snap.mounts,
    store: snap.store,
    comments: snap.comments,
    captures: snap.captures,
  };
  applyPendingBookmark(graph, node);
  graph.writeNode(node);
  graph.registerNode(node);
  graph.active = newId;
  if (clearLock) graph.lock = null;
  graph.saveMeta();
  deleteDraft(draftPath);
  const wsNode = { id: newId, parent_id: node.parent_id, created_at: node.created_at, author, trigger_summary: node.trigger.summary };
  const ws = { type: 'node-added', node: wsNode, active: newId };
  if (includeLabelAndUnlock) {
    // Lazy require breaks the load-time cycle (graph.js top-imports this module).
    // Runs only for turn-end and only AFTER registerNode + active advance, since
    // the label is derived from the freshly-registered topology.
    const { computeLabels } = require('../graph');
    wsNode.label = computeLabels(graph).get(newId) || newId;
    ws.unlock = true;
  }
  bus.emit({ event: { kind: 'graph', op, id: newId }, ws });
  return { node_id: newId };
}

module.exports = {
  SNAPSHOT_FIELDS, hydrateMount,
  DRAFT_SCHEMA_VERSION, loadDraft, writeDraft, deleteDraft,
  LOCK_TTL_MS, lockIsStale, acquireLock, releaseLock, guardReaim, lockHeld, clearLockOnBoot,
  commitNode,
};
