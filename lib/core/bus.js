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
//   queue — the wake queue. `{ op: 'add'|'update'|'remove'|'clear', ... }`.
//     The wake queue changed; carries a WS frame the right-edge rail folds.
//     A composer message (an item of kind 'message', its source 'composer' or,
//     for a Kill, Cancel or Remove, 'task-stop') rides the same ops; an edit
//     or a held-back message is an 'update'. Op 'receipt' — `{ op: 'receipt',
//     msg_id, state }` on the ring, `{ type: 'queue', op: 'receipt', msg_id,
//     state, at }` on the WS — is a message's delivery receipt moving (queued,
//     sending, sent, parked, handed_over, confirmed, unconfirmed, failed),
//     emitted only by domain/queue noteReceipt; it names the message by id and
//     never carries its text.
//   wake  — the wake queue. `{ batch:[item…], reason, source, target_pid? }`.
//     The single wake primitive. EMIT-ONLY: it never carries a WS frame
//     (browsers don't consume it). The channel bridge (MCP process) taps it
//     over SSE (kinds:['wake']) and fires exactly one
//     notifications/claude/channel per wake. "What wakes Claude" = who emits
//     `wake` (queue flush + immediate signals, via
//     lib/server/domain/queue.emitWake). A batch may hold composer messages
//     (items of kind 'message', rendered as quoted blocks by
//     lib/channel/envelope); `target_pid` (the Claude Code process the
//     message is for) makes every bridge but that session's skip it, and the
//     wake lock it takes reads `web message m-…`, never the text.
//   packs — the installed component set changed (a pack was installed,
//     quarantined, approved, discarded or removed). Carries TWO WS frames: a
//     `packs:changed` the drawer's Manage tab folds, and a bare `components`
//     that invalidates the one shared component cache the drawer and the ⌘K
//     palette both read. The CLI reaches this via POST /api/packs/announce.
//   brand — a brand image slot was set or cleared (`{ op: 'set'|'remove',
//     slot, theme }`), or the global theme changed and so did the images that
//     show (`{ op: 'theme', theme }`) — brand images are kept per theme, and
//     `theme` is the key of the one they now belong to. Its WS frame
//     `{type:'brand', theme, slots, fill}` carries that theme and every slot's
//     metadata, so each topbar re-points (or drops) its logotype.
//   wake-ack — delivery confirmation for a live `wake`. `{ seq }`. The bridge
//     POSTs /api/channel/ack after its notify() lands; ackWake emits this so the
//     right-edge rail can resolve its "Sending…" state into "Delivered ✓" (and
//     reject the push on the absence of one). Carries both an event (a delivery
//     trail beside the `wake`) and a WS frame the rail folds.
//   project — the project's identity changed: its display name, whether the
//     name shows, or one of its images (`{ op: 'set'|'remove', field }`, the
//     field named, never its value). Its WS frame `{type:'project', identity}`
//     carries the whole identity, so each chrome redraws its lockup and its
//     tab title (lib/server/routes/project.js, lib/core/project-identity).
//   control — an action the control layer accepted, emitted only by the
//     action table's rows in lib/server/control/ (the conventions ratchet holds
//     `kind: 'control'` there). EMIT-ONLY, no WS frame.
//       `{ op: 'interrupt', id, conversation_id, session_id, via: 'tty'|'hook'
//         (or a later tier's), target_pid?, expires_at }` — `via: 'tty'` names
//         the Claude Code process (`target_pid`) whose MCP server injects the
//         Esc, and expires_at is epoch ms, 2 s ahead; `via: 'hook'` is the halt
//         flag, and expires_at is its epoch-seconds expiry. The chat mirror's
//         facade reads it to say who ended a turn (`ended_by` web or hook);
//         the Esc injector follows `kinds:['control']` over SSE, a stream that
//         does not keep the daemon up.
//       `{ op: 'restore'|'undo', id, outcome }` (control/revert) and
//       `{ op: 'fork', id, conversation_id, session_id, outcome }`
//         (control/fork; session_id is the source session, and the new id is
//         never on it).
//
// The same engine runs two more instances, each with its own ring and seq
// space, so their volume never evicts the surface's events above:
//   the hook tap (lib/server/hook-tap.js, `ctx.hooks`, 200 entries) — every
//     Claude Code hook envelope the daemon accepts, as `kind: 'hook'` entries,
//     with NO broadcaster: nothing on it ever becomes a WS frame.
//   the mirror bus (lib/server/mirror, 2,000 entries) — the chat mirror's
//     `mirror:*` frames, beside compact, content-free `kind: 'mirror'` ring
//     entries (`op` 'update', 'reset' or a live-state transition). It shares
//     lib/server/ws.js's broadcaster, which projects each mirror frame per
//     socket for that socket's level, so nothing mirror-shaped reaches a socket
//     that may not see it. The asks domain (lib/server/domain/asks) emits here
//     too: a `mirror:ask` frame `{ op: 'open'|'update'|'close', ask, answer }`
//     and, beside it, a content-free `kind: 'ask'` ring entry `{ op:
//     'open'|'decided'|'resolved', id, ask_kind, tool_name, outcome }`. Being
//     on this bus and not the main one, an ask's outcome never reaches
//     Claude's get_events or an SSE driver of the main ring.

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
  //
  // `meta` is in-process context for LIVE subscribers only: it is handed to each
  // subscriber as a second argument and never enters the ring, the SSE wire or a
  // WS frame. It exists for facts a synchronous subscriber needs but the served
  // event must not carry — a store write's pre-write values, which the queue
  // stamps on a signal item so its Revert can put the key back (domain/store).
  function emit({ event = null, ws = null, except, meta } = {}) {
    let built = null;
    if (event) {
      built = { seq: nextSeq++, ts: Date.now(), ...event };
      events.push(built);
      if (events.length > maxEvents) events.shift();
      if (subscribers.size) {
        for (const fn of subscribers) { try { fn(built, meta); } catch {} }
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
  //
  // A cursor AHEAD of the ring is the OTHER discontinuity, and the one the header
  // above describes: nextSeq resets to 1 on every boot, so a cursor carried across
  // a `claude-web-chat restart` is numerically higher than anything in the new
  // ring. That used to read as `{events: [], gap: false}` — "nothing has happened
  // since you last looked" — which is the most wrong answer available, and it was
  // returned to every consumer except the channel bridge (the bootId token rides
  // `wake` events alone). It is now `gap: true` with `reset: true`, so a caller
  // that already knows to resync on a gap does the right thing without knowing
  // about boots at all; `dropped` stays 0 because the count is unknowable.
  function read({ since = 0, kinds = null } = {}) {
    const list = kinds
      ? events.filter((e) => e.seq > since && kinds.includes(e.kind))
      : events.filter((e) => e.seq > since);
    const oldest = events.length ? events[0].seq : null;
    const latest = nextSeq - 1;
    if (since > latest) return { events: [], latest, oldest, gap: true, dropped: 0, reset: true };
    const gap = since > 0 && oldest != null && since < oldest - 1;
    const dropped = gap ? oldest - 1 - since : 0;
    return { events: list, latest, oldest, gap, dropped };
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
