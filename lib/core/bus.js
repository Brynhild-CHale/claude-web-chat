// The change bus — one engine for the server's change-notification. It owns the
// event ring + the SSE subscriber set (lifted out of lib/server/state.js) and
// late-binds the WS broadcaster (lib/server/ws.js).
//
// Every mutating route used to hand-pair a `broadcast(...)` WS frame with a
// `pushEvent(...)` event entry, each shaped independently — five overlapping
// notification mechanisms. This collapses them to one `emit`:
// each site names BOTH its event entry and its WS frame(s) in a single call, so
// they can't drift (there is no projection layer between them to get out of sync).
//
// Design note (co-located emit, deliberately chosen over a projection registry):
// the emit sites are genuinely heterogeneous (WS `type` ≠ event
// `kind`; render carries `html` on WS but `bytes` in the event; capture's
// triple-effect; conditional WS frames), so a canonical-change + toWs/toEvent
// projection registry would just relocate that irreducible case-analysis into one
// branch-heavy file. Co-location keeps each site's two payloads side by side and
// is byte-identical by construction. The future channels bridge subscribes to the
// event feed (`subscribe`) — it never needs the WS-content projection.
//
// Zero dependencies, tripwire-clean (none of the three banned constructs the
// conventions test ratchets — the daemon HTTP client, the home-dir builder, or
// dynamic script eval).
//
// Change-shape notes — event kinds (the registry the change-shape docs track):
//   store | render | clear | pane | dom | graph | comment | capture (pre-channels)
//   queue — the wake queue. `{ op: 'add'|'remove'|'clear', ... }`. The
//     wake queue changed; carries a WS frame the right-edge rail folds.
//   wake  — the wake queue. `{ batch:[item…], reason, source }`. The
//     single wake primitive. EMIT-ONLY: it never carries a WS frame (browsers
//     don't consume it). The channel bridge (MCP process) taps it over SSE
//     (kinds:['wake']) and fires exactly one notifications/claude/channel per
//     wake. "What wakes Claude" = who emits `wake` (queue flush + immediate
//     signals, via lib/server/domain/queue.emitWake).

const MAX_EVENTS = 1000;

function createBus({ maxEvents = MAX_EVENTS, bootId = null } = {}) {
  // The ring buffer (catch-up / history tap) + its monotonic cursor. `nextSeq`
  // resets to 1 on every daemon boot (in-memory), so the seq space is NOT
  // monotonic across restarts. `bootId` (a per-process token) is exposed (not
  // stamped on the general event wire — that stays byte-stable) so the ONE wake
  // emitter can ride it on `wake` events; the channel bridge, which outlives
  // daemon restarts in the MCP process, reads it to detect the seq reset and drop
  // its stale cursor instead of swallowing the fresh (lower-seq) wakes as replays.
  const events = [];
  let nextSeq = 1;
  // Live push tap (SSE). Empty by default → zero cost when nobody is streaming.
  const subscribers = new Set();
  // Late-bound WS broadcaster: ws.js owns the socket set and registers its
  // broadcast(msg, except) here, so the bus never touches the socket set itself.
  let broadcaster = null;

  // The one notification primitive. `event` (if given) becomes a ring entry and
  // fans out to subscribers; `ws` (a single frame or an array) is broadcast to
  // WS clients, skipping `except`. Canonical internal order is event → WS: safe
  // because the two travel to disjoint consumer sets (ring/SSE vs sockets), and
  // seq/ts are computed only in the event step. Returns the built entry or null.
  //
  // NOTE: the `{ seq, ts, ...event }` spread order is load-bearing — a field on
  // `event` (e.g. capture's own `seq`) intentionally overrides the ring seq,
  // matching the pre-bus pushEvent exactly. Do not reorder.
  function emit({ event = null, ws = null, except } = {}) {
    let built = null;
    if (event) {
      built = { seq: nextSeq++, ts: Date.now(), ...event };
      events.push(built);
      if (events.length > maxEvents) events.shift();
      if (subscribers.size) {
        for (const fn of subscribers) { try { fn(built); } catch {} }
      }
    }
    if (ws != null && broadcaster) {
      const frames = Array.isArray(ws) ? ws : [ws];
      for (const frame of frames) {
        if (frame == null) continue;
        broadcaster(frame, except);
      }
    }
    return built;
  }

  // Subscribe to live events (the SSE live tap). Returns an unsubscribe fn.
  // Notification is synchronous within emit — subscribers must not throw (wrapped
  // defensively above) and should not do blocking work.
  function subscribe(fn) {
    subscribers.add(fn);
    return () => subscribers.delete(fn);
  }

  // The ONE catch-up / gap implementation, consumed by both GET /api/events and
  // the SSE replay. `kinds` filters the returned events (the gap math always uses
  // the FULL ring's oldest, matching the pre-bus behavior where SSE gap detection
  // ignored the kind filter). A cursor predating the oldest retained event means
  // the events in between were evicted (ring overflow) — flagged via gap/dropped.
  function read({ since = 0, kinds = null } = {}) {
    const list = kinds
      ? events.filter((e) => e.seq > since && kinds.includes(e.kind))
      : events.filter((e) => e.seq > since);
    const oldest = events.length ? events[0].seq : null;
    const gap = since > 0 && oldest != null && since < oldest - 1;
    const dropped = gap ? oldest - 1 - since : 0;
    return { events: list, latest: nextSeq - 1, oldest, gap, dropped };
  }

  // Late-bind ws.js's broadcast(msg, except).
  function setBroadcaster(fn) { broadcaster = fn; }

  return {
    emit,
    subscribe,
    read,
    setBroadcaster,
    // Per-boot token (null in tests that don't pass one). The wake emitter rides
    // it on `wake` events; the channel bridge uses it to survive daemon restarts.
    bootId,
    // Read-only ring ref for POST /api/wait's scan (matcher unchanged).
    get events() { return events; },
  };
}

module.exports = { createBus, MAX_EVENTS };
