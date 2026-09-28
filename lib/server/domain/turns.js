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
const crypto = require('node:crypto');
const { writeJsonAtomic, readJson, renameAside } = require('../../core/fsjson');
const page = require('./page');

// The single home for the mount-field allowlist that was hand-enumerated in
// graph.restoreLiveToNode and index.loadDraft. Order is load-bearing (it fixes
// the key order of the rebuilt live-mount object). Adding a persisted-and-restored
// mount field is a one-line change here.
//
// This list is the authority for the WRITER as well as the reader: graph.snapshotLive
// projects every live mount through hydrateMount, so what a node file and a draft
// hold is exactly what comes back out. It used to be an open `{ id, ...m }` spread
// on the writing side — "write everything, let the reader pick" — and the two
// promptly disagreed the moment the live record grew `gen`.
// test/graph-persistence.test.js pins writer == reader.
//
// `gen` is deliberately NOT here (ratified as D18). It is the live re-render
// counter a queued Revert is stamped against, and it is live-only: it resets when
// a node is restored, so a Revert stamped BEFORE a restore can match the restored
// pane rather than the one it was aimed at. Keeping it out is what makes D18's
// "committed node bytes are unchanged" true, which the open spread had quietly
// falsified.
const SNAPSHOT_FIELDS = ['html', 'target', 'params', 'component', 'pane_state', 'form_state', 'theme', 'owner'];

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

// How many superseded drafts to keep beside the live one. A draft is the ONLY
// copy of uncommitted work, so a draft this boot cannot use is moved aside
// rather than destroyed — but nothing else in the tree reaps such files, so the
// cap is what stops .web-chat/ growing a tail of them forever.
const KEEP_ASIDE_DRAFTS = 3;

// Boot restore: overlay a draft onto live state if it matches the active node.
// Mutates `state`.
//
// A draft this boot cannot use — unreadable, or belonging to a different commit
// point — is RENAMED ASIDE (draft.json.corrupt-<ts>, newest three kept), not
// unlinked. This was the one reader in the tree that destroyed the record it had
// failed to read, and it sat at the end of the worst cascade in the daemon: a
// torn graph/_meta.json read as active=null, so every valid draft looked stale
// and was deleted. graph.load no longer produces that null, and if some other
// path ever does, the bytes are still on disk.
function loadDraft(draftFile, activeId, state) {
  const p = draftFile;
  const r = readJson(p);
  if (r.absent) return;
  if (!r.ok || !r.value || r.value.base_active !== activeId) {
    try { renameAside(p, { keep: KEEP_ASIDE_DRAFTS }); } catch {}
    return;
  }
  const draft = r.value;
  // The page's markdown + order ride the draft like the panes do — in a draft
  // this build wrote. A draft with NEITHER field was written by a build with no
  // page (0.7.x: a rollback's graceful stop, then an update back). It stamps the
  // same schema_version 1, so the missing keys are the marker (this build always
  // writes both). Such a draft cannot know the page's markdown, and restoring
  // "none" emptied the live page of its title and prose: live then differed
  // from the node, so the next chat-only turn committed a markdown-less node.
  // Keep the base node's page instead. Boot restores the active node BEFORE
  // this (server/index.js), and base_active === activeId above, so the live page
  // here IS that node's (page.snapshot reads it off in node shape): its
  // markdown, its order with the draft's new panes appended (page.restore
  // appends every id the order does not name), and its layout.
  const pageSrc = ('markdown' in draft || 'order' in draft) ? draft : page.snapshot(state);
  state.mounts.clear();
  for (const m of (draft.mounts || [])) {
    state.mounts.set(m.id, hydrateMount(m));
  }
  page.restore(state, pageSrc);
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
  // A restored in-flight wake belongs to the previous boot's (now-dead) seq
  // space, so it can never be acked — foldStaleAck ages it into a park on the
  // next pending-read/flush, which delivers it on the user's next message.
  state.pendingAck = draft.pendingAck ? { ...draft.pendingAck } : null;
}

// Shutdown snapshot: persist uncommitted live state. Skips (returns false) when
// the surface is empty across all four collections so a blank surface leaves no
// draft behind.
function writeDraft(draftFile, activeId, snap) {
  const hasMounts = (snap.mounts || []).length > 0 || (snap.markdown || []).length > 0;
  const hasStore = Object.keys(snap.store || {}).length > 0;
  const hasComments = (snap.comments || []).length > 0;
  const hasCaptures = (snap.captures || []).length > 0;
  const hasQueue = (snap.queue || []).length > 0;
  // A park with no queued items and an empty surface must still persist, so it
  // counts toward "there is a draft to write".
  const hasPending = !!snap.pendingWake || !!snap.pendingAck;
  if (!hasMounts && !hasStore && !hasComments && !hasCaptures && !hasQueue && !hasPending) return false;
  const draft = {
    schema_version: DRAFT_SCHEMA_VERSION,
    saved_at: Date.now(),
    base_active: activeId,
    mounts: snap.mounts,
    markdown: snap.markdown || [],
    order: snap.order || [],
    ...page.layoutFields(snap),
    store: snap.store,
    comments: snap.comments,
    captures: snap.captures,
    queue: snap.queue,
    pendingWake: snap.pendingWake || null,
    pendingAck: snap.pendingAck || null,
  };
  // Atomic (lib/core/fsjson) — this runs during graceful shutdown, the exact
  // moment a half-written file is most likely. Failure stays a RETURN VALUE
  // rather than an exception: the shutdown path must finish either way.
  try {
    writeJsonAtomic(draftFile, draft);
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

// ── Dirty check ────────────────────────────────────────────────────────────
// Deterministic JSON of a value regardless of object-key insertion order —
// live-state objects and node-file objects reach the same keys along different
// paths, so a naive stringify would report phantom dirt.
function stableStringify(v) {
  if (Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']';
  if (v && typeof v === 'object') {
    return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + stableStringify(v[k])).join(',') + '}';
  }
  return JSON.stringify(v);
}

// The canonical "what this surface IS" projection, shared by the dirty check and
// the node digest below so the two can never drift into disagreeing about what
// counts as a change. Only the fields commitNode snapshots into a node
// (SNAPSHOT_FIELDS per mount + store/comments/captures + the page's markdown and
// order) — never queue/pendingWake, which are live-only.
//
// The page ORDER is part of what a surface is: moving a pane, or writing prose
// between two, is a change the user sees. It is compared as page.pageOrder, the
// one reading of it, so a node written before `order` existed (its mounts array
// order IS its page order) and the live surface restored from it agree.
// An EMPTY form_state is the same surface as none: a pane with no form fields
// captures `{}`, and a page that published that capture (a reload's reconcile
// flush did, for every pane nobody had typed in) must not read as a change —
// or Set active preserves a node holding nothing, and a chat-only turn commits
// instead of folding. The projection only; the record keeps what it was sent.
function viewMount(m) {
  const out = { id: m.id, ...hydrateMount(m) };
  const fs = out.form_state;
  if (fs && typeof fs === 'object' && !Object.keys(fs).length) out.form_state = undefined;
  return out;
}

function snapshotView(s) {
  const mounts = (s.mounts || [])
    .map(viewMount)
    .sort((a, b) => String(a.id) < String(b.id) ? -1 : 1);
  const markdown = (s.markdown || [])
    .map((m) => ({ id: m.id, ...page.hydrateMarkdown(m) }))
    .sort((a, b) => String(a.id) < String(b.id) ? -1 : 1);
  return stableStringify({
    mounts,
    markdown,
    order: page.pageOrder(s),
    // Layout: a run flag is a change the user sees; so is Claude's baseline
    // moving (it is what ↺ goes back to). Both default-free (layoutFields), so
    // a surface nobody rearranged reads exactly as it did before they existed.
    layout: page.layoutFields(s),
    store: s.store || {},
    comments: s.comments || [],
    captures: s.captures || [],
  });
}

// A short content digest of a committed node's surface. Two nodes with equal
// keys are byte-identical surfaces — which is what makes a turn a "no-change"
// turn. Hashed rather than kept whole because the graph holds every node in
// memory and a node's mounts carry full pane HTML: one digest per node costs
// bytes, the projection it stands for costs megabytes.
function nodeViewKey(node) {
  return crypto.createHash('sha1').update(snapshotView(node || {})).digest('hex');
}

// Does the live surface differ from the active node's snapshot? Used by
// set-active to decide whether uncommitted work needs auto-preserving before
// the re-aim discards it, and by turn-end to decide whether this turn earned a
// node at all. No active node → dirty iff anything is live.
function liveIsDirty(graph) {
  const snap = graph.snapshotLive();
  const node = graph.active ? graph.nodes.get(graph.active) : null;
  return snapshotView(snap) !== snapshotView(node || { mounts: [], store: {}, comments: [], captures: [] });
}

// ── The turn lock ──────────────────────────────────────────────────────────
// A turn lock is only cleared by turn-end (the Stop hook). If a turn never
// reaches a clean Stop (user interrupt, agent crash, terminal close), the lock
// orphans and wedges the graph. After its TTL a lock is considered stale
// and may be stolen by a new turn-begin or ignored by a re-aim, so the graph
// self-heals on the next interaction instead of staying wedged. LOCK_TTL_MS is
// env-read at module load (the single home for it now).
//
// Two lock authors exist since channels: 'user' (the turn-begin hook — a typed
// prompt) and 'wake' (turn-begin-on-push — the daemon locks when it emits a
// channel wake, so a channel-woken turn commits its own node instead of folding
// into the next typed turn's). Wake turns are bursty, so a wake lock carries a
// much shorter per-lock TTL (lock.ttl_ms) — a wake that never produced a turn
// (session died, notification dropped) self-heals in minutes, not fifteen.
const LOCK_TTL_MS = parseInt(process.env.WEB_CHAT_LOCK_TTL_MS || '', 10) || 15 * 60 * 1000;
const WAKE_LOCK_TTL_MS = parseInt(process.env.WEB_CHAT_WAKE_LOCK_TTL_MS || '', 10) || 3 * 60 * 1000;

const lockTtl = (lock) => (Number.isFinite(lock.ttl_ms) ? lock.ttl_ms : LOCK_TTL_MS);

function lockIsStale(lock) {
  if (!lock) return false;
  return (Date.now() - (lock.started_at || 0)) > lockTtl(lock);
}

// The ONE outward view of a lock: the record plus `stale`, whether its TTL has
// run out. Computed, never stored — graph.lock and _meta.json keep exactly the
// record they always did. Every lock a browser is shown goes through here (the
// lock frames below, the hello/reset snapshots in ws.js, GET /api/graph), so the
// chrome can gate its re-aim buttons on a FRESH lock: a stale one is stolen by
// the very Set active it would otherwise refuse (guardReaim).
function lockView(lock) {
  return lock ? { ...lock, stale: lockIsStale(lock) } : null;
}

// ── the stale moment ───────────────────────────────────────────────────────
// A lock goes stale by the clock alone: nothing is written when it happens, so
// no frame would ever tell a watching chrome, and its graph screen kept saying
// "locked — turn in progress" for up to the whole TTL after the turn died. One
// timer per graph fires a lock frame (stale:true) at that moment. It is re-armed
// on every lock change below and cleared when the lock goes; a keep-alive
// re-stamp (installLockKeepalive) moves the deadline without touching it, so a
// timer that fires early just re-arms for the new one.
//
// Unref'd: a daemon (or a test run) must never be held open by a lock nobody
// released. Keyed by the graph in a WeakMap rather than stored on it, so the
// module stays stateless about everything but this one handle.
const staleTimers = new WeakMap();

function syncStaleTimer(graph, bus) {
  const prev = staleTimers.get(graph);
  if (prev) { clearTimeout(prev); staleTimers.delete(graph); }
  const lock = graph.lock;
  if (!lock || !bus || lockIsStale(lock)) return;
  const wait = Math.max(1, (lock.started_at || 0) + lockTtl(lock) - Date.now() + 1);
  const timer = setTimeout(() => {
    staleTimers.delete(graph);
    if (graph.lock !== lock) return;
    if (!lockIsStale(lock)) { syncStaleTimer(graph, bus); return; }
    bus.emit({ ws: { type: 'lock', lock: lockView(lock) } });
  }, wait);
  if (typeof timer.unref === 'function') timer.unref();
  staleTimers.set(graph, timer);
}

// ── stealing a stale lock ──────────────────────────────────────────────────
// A stale lock is a turn that never reached its Stop hook. Every steal — a
// re-aim (guardReaim), a new prompt (acquireLock) and a wake (acquireWakeLock)
// — goes through here, so the abandoned turn is handled one way:
//
//   * its work is kept as its OWN node. Whatever it rendered is uncommitted; a
//     dirty live surface is committed as a 'claude' preserve node on the current
//     commit point before anything re-bases on it (the next turn's base is then
//     the preserve node). Without this a re-aim destroyed the work outright, and
//     a new prompt stamped it onto that prompt's node as if it had asked for it.
//   * the re-aim it queued is forgotten. A pending re-aim waits for THAT turn's
//     end, which will never come; left in the slot it fired at the end of the
//     next, unrelated turn — a wipe or a jump minutes later, with no click.
//     The drop rides the returned value (and so the caller's ring event). A new
//     turn's steal also says so on the frame that announced the intent —
//     `reaim:pending` with `intent: null` and what was `dropped` — so a chrome
//     stops promising "applies when Claude's turn ends" and asks the user to do
//     it again. A re-aim's steal (`superseded`) does not: the click that made it
//     replaces the queued intent, exactly as it does under a fresh lock.
function stealStale(graph, bus, draftPath, { superseded = false } = {}) {
  let preserved = null;
  if (liveIsDirty(graph)) {
    const author = graph.lock.author || 'user';
    preserved = commitNode(graph, bus, {
      draftPath, parentId: graph.active, author: 'claude',
      triggerKind: 'preserve', message: '',
      summary: `auto-preserved from an abandoned ${author} turn`,
      clearLock: false, op: 'commit', includeLabelAndUnlock: false,
    }).node_id;
  }
  const p = graph.pendingReaim;
  graph.pendingReaim = null;
  const dropped = p ? { op: p.op, ...(p.id ? { id: p.id } : {}), ...(p.name ? { name: p.name } : {}) } : null;
  // WS-only, like the frame it withdraws (setPendingReaim): no ring entry.
  if (dropped && !superseded) bus.emit({ ws: { type: 'reaim:pending', intent: null, dropped } });
  return {
    ...(preserved ? { preserved } : {}),
    ...(dropped ? { dropped_reaim: dropped } : {}),
  };
}

// turn-begin. Acquires the lock, stealing a stale one (over-writing, never an
// interim null — see stealStale for what a steal keeps and drops). A FRESH
// 'wake' lock does not block — the typed prompt lands in the same session that
// the wake woke, so the turn is ONE turn: UPGRADE the lock in place (keep its
// base — the woken work is uncommitted on that base — re-stamp
// author/message/clock, drop the short wake TTL). An upgrade is not a steal: it
// preserves nothing and keeps a queued re-aim. Returns { ok:false, lock } only
// when a fresh USER lock is held (route → 409). On success sets graph.lock,
// persists, emits the combined turn-begin event + lock WS frame, returns
// { ok:true, lock, stole_stale_lock, upgraded_wake_lock[, preserved][, dropped_reaim] }.
function acquireLock(graph, bus, { message = '', author = 'user', draftPath } = {}) {
  const fresh = graph.lock && !lockIsStale(graph.lock);
  if (fresh && graph.lock.author !== 'wake') return { ok: false, lock: graph.lock };
  const upgraded = Boolean(fresh); // fresh here ⟹ a wake lock being upgraded
  const stolen = !fresh && graph.lock ? graph.lock : null;
  const steal = stolen ? stealStale(graph, bus, draftPath) : {};
  const base = upgraded ? graph.lock.base : graph.active;
  graph.lock = { base, started_at: Date.now(), message, author };
  graph.saveMeta();
  bus.emit({
    event: { kind: 'graph', op: 'turn-begin', base, stole_stale_lock: Boolean(stolen), ...(upgraded ? { upgraded_wake_lock: true } : {}), ...steal },
    ws: { type: 'lock', lock: lockView(graph.lock) },
  });
  syncStaleTimer(graph, bus);
  return { ok: true, lock: graph.lock, stole_stale_lock: Boolean(stolen), upgraded_wake_lock: upgraded, ...steal };
}

// turn-begin-on-push. Called by the ONE wake emitter (queue.emitWake) just
// before the wake goes out, so the channel-woken turn runs under a lock like
// any other and its Stop-hook turn-end commits a first-class node. Never
// blocks and never emits an error:
//   * fresh USER lock  → fold: the wake lands in an already-running turn; that
//     turn's commit captures the woken work. No-op.
//   * fresh WAKE lock  → extend: a second wake during a wake turn re-stamps the
//     clock/message (one turn, one node).
//   * stale lock / none → acquire with author:'wake' + the short wake TTL (a
//     stale one is stolen through stealStale, exactly as turn-begin steals).
function acquireWakeLock(graph, bus, { message = '', draftPath } = {}) {
  const fresh = graph.lock && !lockIsStale(graph.lock);
  if (fresh && graph.lock.author !== 'wake') return { ok: true, folded: true, lock: graph.lock };
  if (fresh) {
    graph.lock.started_at = Date.now();
    if (message) graph.lock.message = message;
    graph.saveMeta();
    bus.emit({ ws: { type: 'lock', lock: lockView(graph.lock) } });
    syncStaleTimer(graph, bus);
    return { ok: true, extended: true, lock: graph.lock };
  }
  const stolen = graph.lock ? graph.lock : null;
  const steal = stolen ? stealStale(graph, bus, draftPath) : {};
  const base = graph.active;
  graph.lock = { base, started_at: Date.now(), message, author: 'wake', ttl_ms: WAKE_LOCK_TTL_MS };
  graph.saveMeta();
  bus.emit({
    event: { kind: 'graph', op: 'turn-begin', base, author: 'wake', stole_stale_lock: Boolean(stolen), ...steal },
    ws: { type: 'lock', lock: lockView(graph.lock) },
  });
  syncStaleTimer(graph, bus);
  return { ok: true, lock: graph.lock, stole_stale_lock: Boolean(stolen), ...steal };
}

// unlock. Clears the lock, persists, and emits the always-fires unlock event +
// a lock-cleared WS frame only if there was a lock (ws:null → bus null-skips).
function releaseLock(graph, bus) {
  const had = graph.lock;
  graph.lock = null;
  graph.saveMeta();
  syncStaleTimer(graph, bus);
  bus.emit({
    event: { kind: 'graph', op: 'unlock', had: Boolean(had) },
    ws: had ? { type: 'lock', lock: null } : null,
  });
  return { cleared: Boolean(had) };
}

// ── Pending re-aim ─────────────────────────────────────────────────────────
// A user re-aim (set-active / wipe / new-graph) during a fresh
// lock is QUEUED, not rejected — the one place the design still hard-409'd a
// user intent, now consistent with "everything queues, deliberate application
// points". A single in-memory slot, last intent wins; the routes apply it after
// the turn-end commit (or on manual unlock). Deliberately NOT persisted: if the
// process dies mid-turn the draft machinery preserves the *work*, and a stale
// navigation intent silently re-aiming a rebooted surface would be worse than
// asking the user to click again.
function setPendingReaim(graph, bus, intent) {
  graph.pendingReaim = { ...intent, requested_at: Date.now() };
  // WS-only frame (no ring entry): the rail/pill shows "queued — applies when
  // the turn ends"; the eventual APPLY emits the real graph events.
  bus.emit({ ws: { type: 'reaim:pending', intent: { op: intent.op, id: intent.id || null, name: intent.name || null } } });
  return graph.pendingReaim;
}

// Claim-and-clear. The applier takes the slot exactly once.
function takePendingReaim(graph) {
  const p = graph.pendingReaim || null;
  graph.pendingReaim = null;
  return p;
}

// The pre-guard shared by set-active / wipe / new-graph (re-aim
// the commit point). A fresh lock queues (route → pending); a stale lock is
// stolen — cleared, PERSISTED, and a seq-less lock-cleared WS frame emitted (no
// ring entry). The unconditional saveMeta here is the fix for the
// /api/graph/new drift (it used to steal without persisting, unlike
// set-active/wipe).
//
// Stealing a stale lock means a turn that never reached its Stop hook, and the
// re-aim that follows the steal calls restoreLiveToNode — so whatever that turn
// had already rendered was silently destroyed. That is data loss with no undo
// (nothing was ever committed), so the steal auto-preserves first (stealStale,
// the one steal every path shares): commit the dirty live surface as its own
// node on the current commit point, then let the re-aim proceed. Authored
// 'claude' because the abandoned turn's work is what is being saved. A re-aim
// the dead turn had queued is dropped with it — the caller's own intent is the
// user's latest.
function guardReaim(graph, bus, { draftPath } = {}) {
  if (graph.lock && !lockIsStale(graph.lock)) return { blocked: true, lock: graph.lock };
  if (!graph.lock) return { blocked: false };
  const steal = stealStale(graph, bus, draftPath, { superseded: true });
  graph.lock = null;
  graph.saveMeta();
  syncStaleTimer(graph, bus);
  bus.emit({ ws: { type: 'lock', lock: null } });
  return { blocked: false, stole_stale_lock: true, ...steal };
}

// Keep-alive for a lock whose holder is demonstrably still working. A TTL exists
// to unwedge the graph when a turn NEVER reaches its Stop hook; it was never
// meant as a budget on how long a turn may take. But nothing re-stamped
// started_at during a turn, so a wake lock's deliberately short TTL was a hard
// window measured from the Push — and an agentic turn that runs past it goes
// stealable while it is still rendering, losing everything it has drawn to the
// next user click. Every write Claude makes proves the turn is alive, so each
// one re-stamps the clock.
//
// Only source 'claude'. A driver's writes (source 'service:<name>', and the
// store route's undifferentiated 'server') must NOT hold a lock open: a
// service-backed pane pushes continuously, and a lock that never went stale
// would wedge every user re-aim behind a turn that ended long ago. An already
// stale lock is left stale — reviving one under a re-aim's feet is the very
// thing the steal exists to prevent.
//
// No saveMeta: _meta.json's copy of the lock only matters across a crash, and
// clearLockOnBoot discards a persisted lock unconditionally at boot. Writing the
// file on every render would be pure amplification.
function installLockKeepalive(graph, bus) {
  return bus.subscribe((e) => {
    if (!e || e.source !== 'claude') return;
    if (!graph.lock || lockIsStale(graph.lock)) return;
    graph.lock.started_at = Date.now();
  });
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
  syncStaleTimer(graph);
}

// ── Commit ─────────────────────────────────────────────────────────────────

// `wipe` / `new graph` mark the *next* committed node as a bookmark (the start
// of fresh content / a new graph's root). Applied once, then cleared.
function applyPendingBookmark(graph, node) {
  if (!graph.pendingBookmark) return;
  node.bookmarked = true;
  node.name = graph.pendingBookmark.name || '';
  if (graph.pendingBookmark.wipe) node.wipe = true;   // additive: a wipe's fresh-start bookmark
  graph.pendingBookmark = null;
}

// ── Folded turns (turns that changed nothing) ──────────────────────────────
// A turn whose Stop leaves the surface identical to the active node commits NO
// node — otherwise a chat-only conversation produces a run of byte-identical
// nodes that makes the graph useless to navigate. Its provenance is not thrown
// away: the trigger accumulates on graph.pendingFolded and rides forward onto
// the next node that DOES commit, as an additive `folded` array (so the
// collapsed turns stay individually inspectable instead of being flattened into
// one string).
//
// The accumulator rides `graph/_meta.json` via saveMeta — the same "state that
// rides until the next commit" slot pendingBookmark uses — so a daemon restart
// mid-conversation doesn't lose it. Both are additive _meta.json fields: no node
// schema change, no SCHEMA_VERSION bump, no migration (an old _meta.json simply
// reads back as "nothing pending").
//
// Bounded on purpose: _meta.json is rewritten on every saveMeta, so a very long
// chat-only run must not grow it without limit. Oldest entries drop first and
// the count of dropped ones is kept, so the eventual node's `folded_count` stays
// honest about how many turns it stands for.
const MAX_FOLDED = 50;
const FOLDED_MESSAGE_MAX = 1000;

// `reply` (a summarizeReply'd string) is the short summary of what Claude said
// back in that turn — written only when there is one, so an entry from a turn
// with no reply has no key at all rather than an empty one.
function accumulateFolded(graph, { author = 'claude', kind = 'turn', message = '', summary = '', reply = '' } = {}) {
  const msg = String(message || '').slice(0, FOLDED_MESSAGE_MAX);
  graph.pendingFolded.push({
    at: Date.now(),
    author,
    kind,
    message: msg,
    summary: summary || (msg ? msg.slice(0, 100) : ''),
    ...(reply ? { reply } : {}),
  });
  while (graph.pendingFolded.length > MAX_FOLDED) {
    graph.pendingFolded.shift();
    graph.pendingFoldedDropped = (graph.pendingFoldedDropped || 0) + 1;
  }
  return graph.pendingFolded.length + (graph.pendingFoldedDropped || 0);
}

// Attach the accumulated turns to a node being committed, then clear the slot.
// `folded_count` is the TOTAL number of collapsed turns including any the cap
// dropped, so `folded.length < folded_count` reads as "older ones aged out".
function applyFolded(graph, node) {
  if (!graph.pendingFolded || !graph.pendingFolded.length) {
    graph.pendingFoldedDropped = 0;
    return;
  }
  node.folded = graph.pendingFolded.map((f) => ({ ...f }));
  node.folded_count = node.folded.length + (graph.pendingFoldedDropped || 0);
  graph.pendingFolded = [];
  graph.pendingFoldedDropped = 0;
}

// Drop the accumulator without attaching it. Called by the re-aims that MOVE the
// commit point (set-active-with-nothing-to-preserve / new-graph):
// those collapsed turns happened against a context the user has now left, and
// silently stapling them to an unrelated node later would be a provenance lie.
// A `wipe` deliberately does NOT discard — it keeps `active` (same lineage, same
// parent for the next commit), so the turns still belong where they'll land.
function discardFolded(graph) {
  const dropped = graph.pendingFolded ? graph.pendingFolded.length : 0;
  graph.pendingFolded = [];
  graph.pendingFoldedDropped = 0;
  return dropped;
}

// turn-end's no-change path. Accumulates this turn's trigger, releases the lock
// (persisting it, exactly as a commit would) and emits ONE ring entry describing
// the skip plus the lock-cleared WS frame the surface needs to drop its turn
// pill. Returns the running total of collapsed turns.
function skipTurn(graph, bus, { author = 'claude', summary, reply } = {}) {
  const total = accumulateFolded(graph, {
    author,
    kind: 'turn',
    message: (graph.lock && graph.lock.message) || '',
    summary,
    reply,
  });
  graph.lock = null;
  graph.saveMeta();
  syncStaleTimer(graph, bus);
  bus.emit({
    event: { kind: 'graph', op: 'turn-skipped', reason: 'no-change', accumulated: total },
    ws: { type: 'lock', lock: null },
  });
  return total;
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
//   reply                  the Stop hook's summary of   absent
//                          Claude's reply (optional)
// The lock precondition (turn-end soft-skips w/o a lock; commit 409s WITH one)
// stays in the routes — it decides whether commitNode is called at all.
function commitNode(graph, bus, {
  draftPath, parentId, author, triggerKind, message, summary, reply,
  clearLock, op, includeLabelAndUnlock,
}) {
  const snap = graph.snapshotLive();
  const newId = `n${graph.nextSeq++}`;
  const node = {
    id: newId,
    parent_id: parentId,
    created_at: Date.now(),
    author,
    trigger: {
      kind: triggerKind, message, summary: summary || (message ? String(message).slice(0, 100) : ''),
      // Additive and optional: a node committed without a reply (a manual
      // commit, a preserve, an older hook) has no `reply` key. No migration.
      ...(reply ? { reply } : {}),
    },
    mounts: snap.mounts,
    // markdown + order only when the page has markdown (page.nodeFields): a
    // node without them reads its page order off the mounts array, as every
    // node committed before the page sequence existed does.
    ...page.nodeFields(snap),
    store: snap.store,
    comments: snap.comments,
    captures: snap.captures,
  };
  applyPendingBookmark(graph, node);
  // Every commit path drains the folded accumulator — turn-end, /api/commit, and
  // set-active's auto-preserve alike. That is what makes set-active correct
  // without a special case: if there IS uncommitted work, the preserve node is
  // the commit of this context and rightly carries the collapsed turns; if there
  // isn't, the route discards them because the commit point moved.
  applyFolded(graph, node);
  graph.writeNode(node);
  graph.registerNode(node);
  graph.active = newId;
  if (clearLock) { graph.lock = null; syncStaleTimer(graph, bus); }
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
  SNAPSHOT_FIELDS, hydrateMount, liveIsDirty, snapshotView, nodeViewKey,
  DRAFT_SCHEMA_VERSION, loadDraft, writeDraft, deleteDraft,
  LOCK_TTL_MS, WAKE_LOCK_TTL_MS, lockIsStale, lockView, acquireLock, acquireWakeLock, releaseLock, guardReaim, lockHeld, clearLockOnBoot,
  installLockKeepalive,
  setPendingReaim, takePendingReaim,
  MAX_FOLDED, accumulateFolded, applyFolded, discardFolded, skipTurn,
  commitNode,
};
