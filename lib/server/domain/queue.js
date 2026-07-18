// lib/server/domain/queue.js — the wake queue domain.
//
// Stateless like turns.js: every fn receives the live `state` (which owns the
// `queue` array + `queueSeq` counter) and the change `bus`. No module-level
// state, no bus construction.
//
// The queue is the DEFAULT wake path. Wake-worthy bus events — captures and
// browser-sourced declared-signal writes — are classified (lib/channel/policy)
// and folded into server-side queue items. Nothing wakes Claude on its own: the
// user hitting "Push → Claude" flushes the whole queue into ONE `wake` event,
// which the channel bridge (MCP process) turns into a single
// notifications/claude/channel. The deliberate-handoff ritual is preserved.
//
// `emitWake` is the SINGLE place a `wake` event is emitted — both the queue
// flush and the immediate-wake path (a pane's `wake:'immediate'` signal) go
// through it, so "what wakes Claude" is exactly "who calls emitWake". A `wake`
// event is emit-only: it never carries a WS frame (browsers don't consume it;
// it's the bridge's channel, fetched over SSE with kinds:['wake']).

const { deleteComment } = require('./comments');
const { wakeEnvelope } = require('../../channel/envelope');
const { mergeActivity } = require('../../channel/policy');
const { acquireWakeLock } = require('./turns');

// Memory backstop: a pathological producer (a chatty signal, a capture flood)
// must not grow the queue — and therefore draft.json — without bound. Kept
// generous so real triage/refine flows never hit it; over the cap we drop the
// oldest STAGED item (never a HELD one until forced).
const MAX_QUEUE = 500;

// The ONE staged predicate: items are staged by default; held is the
// explicit opt-out. The client keeps its own copy (public/app/queue.js) — this is
// the domain-side home so the four open-coded `staged !== false`/`=== false` reads
// can't drift apart.
const isStaged = (it) => it.staged !== false;

// The ONE queue-remove frame. Every removal — overflow eviction, a
// user Revert, an un-share dequeue, and the batched flush — emits this single
// shape on BOTH the bus event and the WS frame, with a `reason` naming the cause
// ('dropped' | 'evicted-held' | 'reverted' | 'removed' | 'flushed'). Previously
// three divergent shapes (dropped:true / reverted:bool / flushed:true), two absent
// from the WS frame; the client rebuilt the rail per frame. `ids` is authoritative;
// a single-id removal also carries `id` as a back-compat alias for single-id
// consumers (the F5 navigation test, any residual `msg.id` reader).
function emitRemove(state, bus, ids, reason) {
  const event = { kind: 'queue', op: 'remove', ids, reason };
  const ws = { type: 'queue', op: 'remove', ids, reason, count: state.queue.length };
  if (ids.length === 1) { event.id = ids[0]; ws.id = ids[0]; }
  bus.emit({ event, ws });
}

// Enqueue an item produced by policy.classify (which carries no id — the queue
// owns identity). Emits a `queue` add event + a WS frame the rail folds. Returns
// the stored item.
function enqueue(state, bus, item) {
  const id = `q${++state.queueSeq}`;
  // `staged: true` — new items go on the next Push by default; the user can hold
  // one back (staged:false) so it stays in the queue but isn't sent.
  const stored = { staged: true, ...item, id, enqueued_at: Date.now() };
  // B6: stamp the origin pane's current generation so a later Revert can tell a
  // still-current pane from a same-id re-render (see revertPane). Only when the
  // mount actually carries a gen — a gen-less mount leaves origin_gen unset so the
  // pre-B6 revert (delete-if-present) still applies.
  const originMount = stored.origin_mount && state.mounts.get(stored.origin_mount);
  if (originMount && originMount.gen != null) stored.origin_gen = originMount.gen;
  state.queue.push(stored);
  // F7: the event/WS carry a COPY — setStaged mutates the live item in place, and
  // a shared reference would retroactively rewrite the served ADD event in the ring.
  const copy = { ...stored };
  bus.emit({
    event: { kind: 'queue', op: 'add', id, item: copy },
    ws: { type: 'queue', op: 'add', item: copy, count: state.queue.length },
  });
  while (state.queue.length > MAX_QUEUE) {
    // B3: evict the OLDEST STAGED item first — a HELD item is the user's
    // deliberately-deferred handoff, so skip held items until only held remain. A
    // forced held eviction (nothing staged left) carries a distinct reason so it
    // isn't a silent loss of the user's deferred work.
    let idx = state.queue.findIndex(isStaged);
    const forcedHeld = idx < 0;
    if (forcedHeld) idx = 0;
    const [dropped] = state.queue.splice(idx, 1);
    emitRemove(state, bus, [dropped.id], forcedHeld ? 'evicted-held' : 'dropped');
  }
  return stored;
}

// Fold an ACTIVITY item into the queue: ONE rolling item per origin mount. A
// match merges counts/keys and re-summarizes in place (op:'update' — the rail
// row ticks up instead of stacking a row per click); no match enqueues a fresh
// item. A HELD match still merges — holding defers delivery, it doesn't fork a
// second item for the same pane.
function coalesce(state, bus, item) {
  const match = state.queue.find(
    (it) => it.kind === 'activity' && (it.origin_mount || null) === (item.origin_mount || null)
  );
  if (!match) return enqueue(state, bus, item);
  mergeActivity(match, item);
  match.last_at = Date.now();
  const copy = { ...match }; // F7: no live reference in the ring
  bus.emit({
    event: { kind: 'queue', op: 'update', id: match.id, item: copy },
    ws: { type: 'queue', op: 'update', id: match.id, item: copy, staged: match.staged, count: state.queue.length },
  });
  return match;
}

// Snapshot of the current queue (defensive copies).
function list(state) {
  return state.queue.map((it) => ({ ...it }));
}

// Drop a pane the queue item originated from. First-cut `revert` semantics
// (R5): "drop the originating pane". Only fires when the item remembers an
// origin mount that still exists. Emits a clear frame so browsers drop it too.
function revertPane(state, bus, mountId, originGen) {
  const mount = mountId && state.mounts.get(mountId);
  if (!mount) return false;
  // B6: a stable-id re-render replaces a pane's content but keeps the id and bumps
  // its gen. Revert only when the CURRENT pane is still the one the item stamped;
  // a missing stamp (pre-B6 item) or a gen-less mount matches (back-compat).
  if (originGen != null && mount.gen != null && originGen !== mount.gen) return false;
  state.mounts.delete(mountId);
  bus.emit({ event: { kind: 'clear', id: mountId, source: 'queue-revert' }, ws: { type: 'clear', id: mountId } });
  return true;
}

// Revert the web-chat artifact a queue item stands for (the "Revert" action): a
// COMMENT item deletes its pin so the marker disappears; anything else drops its
// origin pane (revertPane). Emits the matching frame so browsers drop it too.
function revertArtifact(state, bus, item) {
  if (!item) return false;
  // Dispatch on the item's kind (C1) — not a duck-typed comment_id. A comment item
  // deletes its pin via the shared domain helper (one canonical delete shape).
  if (item.kind === 'comment') {
    // F5: the pin may already be gone (node navigation stranded the item). Delete
    // it if present; otherwise fall through to the origin pane so a stranded
    // comment item still reverts something (revertPane no-ops on a missing mount).
    if (deleteComment(state, bus, item.comment_id)) return true;
    return revertPane(state, bus, item.origin_mount, item.origin_gen);
  }
  return revertPane(state, bus, item.origin_mount, item.origin_gen);
}

// Remove one queued item by id. With `revert`, also removes its web-chat artifact
// (see revertArtifact). Emits a `queue` remove event + WS frame. Returns
// { removed, reverted } (null if the id wasn't queued) — B1: the route reports THIS
// domain-computed `reverted`, not the request flag (a Revert on an item whose
// artifact is already gone reverts nothing).
function remove(state, bus, id, { revert = false } = {}) {
  const i = state.queue.findIndex((it) => it.id === id);
  if (i < 0) return null;
  const [removed] = state.queue.splice(i, 1);
  const reverted = revert ? revertArtifact(state, bus, removed) : false;
  emitRemove(state, bus, [id], reverted ? 'reverted' : 'removed');
  return { removed, reverted };
}

// Drop every queued item that stands for a given comment pin — the reverse of the
// enqueue on a shared add/toggle: when a pin is UN-shared or deleted it should
// leave the wake rail too. Reuses `remove` (one removal path) so each drop emits
// the standard `queue` remove frame. Idempotent — 0 if the pin was never queued.
function removeByComment(state, bus, commentId) {
  if (!commentId) return 0;
  const ids = state.queue.filter((it) => it.comment_id === commentId).map((it) => it.id);
  for (const id of ids) remove(state, bus, id);
  return ids.length;
}

// Refresh the summary of every queued item standing for a comment pin (F9): a
// plain text edit of an ALREADY-queued shared pin must not leave the wake line
// quoting the pre-edit (possibly retracted) text. Rebuilds summary/why_wake from
// the freshly-classified item and emits a `queue` update frame carrying a COPY
// (F7 — no live reference in the ring; carries the current `staged` so the client's
// update fold can't clobber a held item). No-op (0) if the pin isn't queued —
// refresh never enqueues.
function refreshComment(state, bus, commentId, item) {
  if (!commentId || !item) return 0;
  const targets = state.queue.filter((it) => it.comment_id === commentId);
  for (const it of targets) {
    it.summary = item.summary;
    it.why_wake = item.why_wake;
    const copy = { ...it };
    bus.emit({
      event: { kind: 'queue', op: 'update', id: it.id, item: copy },
      ws: { type: 'queue', op: 'update', id: it.id, item: copy, staged: it.staged, count: state.queue.length },
    });
  }
  return targets.length;
}

// Stage / unstage a queued item. Held (staged:false) items stay in
// the queue but aren't sent on Push. Persists on state.queue (rides draft.json),
// so a held item stays held across reconnect/restart. Emits a `queue` update
// frame the rail folds. Returns the item (null if the id wasn't queued). The frame
// carries only primitives (id/staged) — no live reference — so it can't rewrite a
// served ADD event (F7 fixes that at the source, in enqueue's copy).
function setStaged(state, bus, id, staged) {
  const it = state.queue.find((q) => q.id === id);
  if (!it) return null;
  it.staged = staged !== false;
  bus.emit({
    event: { kind: 'queue', op: 'update', id, staged: it.staged },
    ws: { type: 'queue', op: 'update', id, staged: it.staged, count: state.queue.length },
  });
  return it;
}

// The ONE wake emitter. Emits `{kind:'wake', batch, reason, source[, note]}` on
// the bus (ring + SSE subscribers only — NO WS frame). The channel bridge builds
// the envelope from this event and pushes the notification. Returns the event.
//
// turn-begin-on-push: when the caller passes `graph`, the wake acquires a turn
// lock BEFORE it goes out (acquireWakeLock — folds into a running user turn,
// extends a running wake turn, else locks with the short wake TTL), so the
// channel-woken turn commits its own node at Stop instead of riding the next
// typed turn's commit. Living here keeps the invariant one-line-auditable:
// every wake producer goes through emitWake, so every wake-started turn locks.
function emitWake(bus, batch, { reason = 'push', source = 'queue', note, graph } = {}) {
  if (graph) {
    const n = Array.isArray(batch) ? batch.length : 0;
    acquireWakeLock(graph, bus, {
      message: `channel wake: ${n} signal${n === 1 ? '' : 's'}${reason && reason !== 'push' ? ` (${reason})` : ''}`,
    });
  }
  const event = { kind: 'wake', batch, reason, source };
  if (note != null && note !== '') event.note = String(note);
  // Ride the daemon's boot token so the bridge can distinguish a fresh daemon's
  // reset seq space from a same-daemon replay (see lib/channel/bridge deliver()).
  if (bus.bootId != null) event.boot = bus.bootId;
  return bus.emit({ event });
}

// PARK a wake that can't be delivered live because no channel is connected.
// Builds the SUMMARY envelope now — the same
// contract a live wake carries (wakeEnvelope: summary only, bodies fetched by tool
// call) — and stores it as the SINGLE pending wake. A re-push while parked MERGES
// its batch into the existing park and rebuilds the envelope (never two
// parks); the park id is RE-STAMPED on every park/merge so an in-flight
// hook-consume of the pre-merge envelope no-ops on its id check (drops nothing).
// The latest non-blank note re-stamps; a note-less re-push keeps the parked note.
// A park emits nothing on the bus — delivery is deferred to the turn-begin hook
// (path A) or the first wake-consumer to connect (path B, drainPending). Returns
// the stored park.
function parkWake(state, { batch, reason, source, note }) {
  const prev = state.pendingWake;
  // Memory backstop, mirroring enqueue's MAX_QUEUE loop. A park MERGES every
  // re-push while disconnected (the default/fallback case), so without a cap N
  // pushes accumulate up to N×MAX_QUEUE items — regrowing draft.json (the park
  // rides it, graph.js/turns.js) and the injected envelope without bound, exactly
  // the unbounded growth MAX_QUEUE exists to prevent. Cap the merged batch at
  // MAX_QUEUE, evicting the OLDEST overflow (the newest signals are the most
  // relevant to the next prompt; the batch is oldest-first). The park is a delivery
  // buffer, not a record — dropped ids already left their queue-remove trail.
  const merged = prev ? [...prev.batch, ...batch] : batch.slice();
  const mergedBatch = merged.length > MAX_QUEUE ? merged.slice(-MAX_QUEUE) : merged;
  const newNote = note != null && String(note).trim() !== '' ? String(note) : null;
  const mergedNote = newNote != null ? newNote : (prev ? prev.note : note);
  const id = `pw${++state.pendingWakeSeq}`;
  const envelope = wakeEnvelope(mergedBatch, { reason, source, seq: state.pendingWakeSeq, note: mergedNote });
  state.pendingWake = {
    id,
    created_at: prev ? prev.created_at : Date.now(),
    batch: mergedBatch,
    note: mergedNote,
    reason,
    source,
    envelope,
  };
  return state.pendingWake;
}

// Deliver a parked wake NOW as a real `wake` event — path B: the first
// wake-consumer (the channel bridge) to connect drains the park (called from the
// wakeConsumers++ site in routes/events). Clears the park BEFORE emitting so a
// concurrent turn-begin hook consume (path A) finds nothing to double-deliver.
// Returns the emitted wake event (or null if nothing was parked).
function drainPending(state, bus, graph) {
  const park = state.pendingWake;
  if (!park) return null;
  state.pendingWake = null;
  return emitWake(bus, park.batch, { reason: park.reason, source: park.source, note: park.note, graph });
}

// Consume (clear) the parked wake IF `id` matches the current park — path A: the
// turn-begin hook calls this after injecting the summary as prompt context. The id
// check makes a race with drainPending (path B) or a re-push merge harmless: once
// either clears or re-stamps the park, a stale id no-ops. Returns whether it cleared.
function consumePending(state, id) {
  const park = state.pendingWake;
  if (!park || park.id !== id) return false;
  state.pendingWake = null;
  return true;
}

// Flush the STAGED items into one wake, clearing only them; HELD (staged:false)
// items stay in the queue for a later push (this supersedes the old
// `exclude`/"not this push, cleared" rule: holding an item now DEFERS it). A
// note-only push (no staged item + a non-blank comment) is still a deliberate
// wake. Emits ONE batched `queue` remove (not ~N per-item frames, which could
// evict half the event ring and made the client rebuild the rail per frame) then
// the one wake — OR, when no channel is connected (wakeConsumers === 0), PARKS the
// batch instead of firing it into the void. Either way the staged
// items clear (they're IN the park). Returns {batch, wake, parked} — exactly one of
// wake/parked is non-null on a non-inert flush.
function flush(state, bus, { reason = 'push', source = 'queue', note, graph } = {}) {
  const staged = state.queue.filter(isStaged);
  const held = state.queue.filter((it) => !isStaged(it));
  const hasNote = note != null && String(note).trim() !== '';
  if (!staged.length && !hasNote) return { batch: [], wake: null, parked: null };
  const batch = staged.map((it) => ({ ...it }));
  state.queue = held;
  if (staged.length) emitRemove(state, bus, staged.map((it) => it.id), 'flushed');
  // With no channel connected the wake would be consumerless (previously the
  // batch was destroyed here). Park it for next-prompt / next-connect delivery instead.
  if (!((state.wakeConsumers || 0) > 0)) {
    const parked = parkWake(state, { batch, reason, source, note });
    return { batch, wake: null, parked };
  }
  const wake = emitWake(bus, batch, { reason, source, note, graph });
  return { batch, wake, parked: null };
}

module.exports = { enqueue, coalesce, list, remove, removeByComment, refreshComment, setStaged, flush, emitWake, parkWake, drainPending, consumePending, revertPane, revertArtifact, isStaged, MAX_QUEUE };
