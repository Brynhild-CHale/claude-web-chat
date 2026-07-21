function createState() {
  return {
    store: {},
    mounts: new Map(),
    // Comment pins (feature 6) live OUTSIDE the freeform store on purpose: the
    // store is exposed to Claude (get_store, diff_nodes), so private pins kept
    // there would leak. They persist via a dedicated `comments` field on each
    // node instead. `commentSeq` is a server-global monotonic counter (never
    // reset by node navigation) so pin ids/cursors stay unique across branches.
    comments: [],
    commentSeq: 0,
    // Tab-stream captures (feature: tab streaming). Like `comments`, a
    // node-attached collection that travels with the node via snapshotLive →
    // node.captures → restoreLiveToNode, NOT a freeform store key. Unlike
    // comments, each record's *distilled* field is meant to be agent-visible
    // (get_captures); the raw DOM lives in a sidecar file (raw_ref), fetched
    // on demand (inspect_capture) so it never floods context. `captureSeq` is a
    // server-global monotonic counter (never reset by navigation) so capture
    // ids and their sidecar filenames stay unique across branches.
    captures: [],
    captureSeq: 0,
    // The wake queue. Wake-worthy bus events fold into
    // these items; "Push → Claude" flushes them into one `wake` event. Lives on
    // live state (survives restart via draft.json, like mounts/store) but is NOT
    // committed into graph nodes — it's pending-wake state, not surface content.
    // `queueSeq` gives items stable unique ids (q1, q2, …), re-seeded from the
    // restored queue on boot so ids never collide across a restart.
    queue: [],
    queueSeq: 0,
    // Declared wake signals (params.signals) are NOT stored here — they're
    // DERIVED from live mounts on demand (see lib/server/domain/signals), so the
    // registry can never point at a mount that no longer exists.
    //
    // Count of live SSE subscribers interested in `wake` events — i.e. the
    // channel bridge. Lets the "what wakes Claude" panel honestly report whether
    // a channel is actually connected (GET /api/queue/policy).
    wakeConsumers: 0,
    // Application-level liveness of the channel bridge. The bridge POSTs
    // /api/channel/heartbeat every ~10s while its wake-stream is open, stamping
    // this. The raw wakeConsumers count alone is untrustworthy — a half-open SSE
    // socket the daemon hasn't observed closing keeps the count > 0 while nothing
    // reads the stream, so a wake fired on that basis silently vanishes. flush
    // treats a consumer whose heartbeat has gone stale as absent and PARKS
    // instead (reliable next-message delivery). 0 = never seen.
    wakeConsumerSeenAt: 0,
    // In-flight live wake awaiting delivery confirmation. A Push delivered to a
    // live channel RETAINS its batch here (keyed by the wake's ring seq) until
    // the bridge POSTs /api/channel/ack — fired only AFTER its notify() lands. An
    // ack clears it and emits a `wake-ack` frame the rail folds into a delivered
    // confirmation; no ack → the rail rejects the push ("didn't go through") and
    // offers retry / hold-for-next-message. A stale pendingAck (tab closed, never
    // acked) folds into pendingWake so the signal still rides the next message.
    // Rides draft.json like pendingWake so a Push isn't lost across restart.
    pendingAck: null,
    // Parked delivery. When "Push → Claude"
    // flushes with NO channel connected (wakeConsumers === 0), the wake can't be
    // delivered live; instead of destroying the batch (the old drop-on-flush behavior) we PARK
    // one pending envelope here. It rides draft.json like the queue (survives a
    // graceful restart) but is NOT committed to any graph node — it's pending-wake
    // state. It's delivered later either by the turn-begin hook on the user's next
    // prompt (path A) or by the first wake-consumer that connects (path B). A
    // re-push while parked MERGES into this single envelope — never two parks.
    // `pendingWakeSeq` stamps each park a unique id (re-seeded from a restored park
    // on boot, like queueSeq) so a stale hook-consume can't clear a newer park.
    pendingWake: null,
    pendingWakeSeq: 0,
  };
}

// The event ring / SSE fan-out that used to live here (events, nextSeq,
// subscribers, MAX_EVENTS, pushEvent, subscribe) moved to lib/core/bus.js in
// refactor Phase 2 — one change-notification engine. createState now holds only
// unrelated domain state (store, mounts, comments, captures).
module.exports = { createState };
