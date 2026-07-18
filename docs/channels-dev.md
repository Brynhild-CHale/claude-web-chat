# Channels (dev) — the queue-gated wake bridge

Status: research-preview integration (2026-07). This is the developer guide for
the inbound/wake edge: how to run it, the wire contract, and how to smoke-test it
without a live session. It rides on the change bus (`lib/core/bus.js`).

## What this is

MCP is pull-only — an MCP server can't push into a session on its own. Claude Code
**Channels** (v2.1.80+) add the missing inbound edge: an MCP server that declares
`capabilities.experimental['claude/channel']` may **push**
`notifications/claude/channel {content, meta}` into the running session — events
wake an idle session (or fold into the next turn if busy).

Channels is web-chat's **wake path**: everything queues, and the
user's **Push → Claude** wakes Claude with the batch. When no channel is connected,
a Push is **parked** and delivered as context on the user's next message (parked
delivery — see below), so the surface works on every Claude Code build with no dev
flag. The legacy agent-armed waits (`wait_for` tool / `claude-web-chat watch`) are
**gone**; `/api/wait` survives only as a driver-only long-poll.

web-chat's channel is **the existing `web-chat` MCP server** with that capability
turned on. No new process, no `.mcp.json` change.

## The wake model — everything queues, Push wakes

**Nothing wakes Claude on its own.** Wake-worthy bus events accumulate as items in
the right-edge **queue rail** (server-side state). **Hitting "Push → Claude" (`P`)
is the only thing that wakes Claude** — the deliberate-handoff ritual is preserved
(the user controls *when*).

Wake is **one primitive** — a `{kind:'wake', batch, reason, source}` bus event —
with (currently) two producers:

1. **The queue push (`P`).** `POST /api/queue/push` batches all queued items into
   one `wake` and clears the queue.
2. **A declared immediate signal.** A render can declare
   `params.signals: [{key, wake:'immediate'}]`; when a **browser** write hits that
   key, the daemon emits `wake` directly, bypassing the queue. Default is
   `wake:'queue'` (enqueue).

More producers can be added — the bridge only cares that *something* emitted
`wake`. So "what wakes Claude" = "who emits `wake`" (see
`lib/server/domain/queue.emitWake`), surfaced live at `GET /api/queue/policy` and
in the rail's "what wakes Claude" panel.

### The opt-out activity layer

**Routing is opt-out, not opt-in.** Declared signals depend on the pane's own
script calling `store.set` correctly — exactly what breaks when a component is
mis-authored (a script that queried `document` instead of its shadow `root` dies
at mount and its declared signal never fires, leaving a dead button and an empty
Push). Underneath the declared layer, undeclared **browser** activity routes by
default:

- **Delegated dom events** (the shell's shadow-piercing `click`/`change`/`submit`
  listeners — they live in the shell, so they survive a dead pane script) and
  **undeclared browser store writes** classify as `{action:'coalesce'}`.
- **Gesture gating**: an undeclared store write counts only when the client
  stamped it `gesture:true` (the pane's store facade marks writes within ~1.5s
  of a real interaction in that pane). A script's init/tick/reactive writes
  carry no gesture and never masquerade as user activity — otherwise every
  mount that seeds the store would enqueue a phantom item.
- They fold into **one rolling `activity` item per mount**
  (`queue.coalesce`): counts + touched key *names* only, re-summarized in place
  (`queue` op:'update' frame) — never one row per click, and **never a value**
  (payloads stay behind `get_store`/`get_events`, the captures posture).
- Bare clicks on non-affordances (prose, whitespace) don't count; only
  interactive tags / `data-*` targets, plus every change/submit.
- **Opt-out**: `params.routing:'none'` on the render. Service-owned panes
  (`owner:"service:*"`) default out — their store control-loop (e.g. `git_ctl`)
  is pane↔service traffic, not a user handoff — and `params.routing:'auto'`
  opts one back in. Derived per event from live mounts
  (`signals.deriveRouting`), surfaced as `activity_default`/`activity_opted_out`
  in `GET /api/queue/policy`.
- Store-write attribution: the client's per-pane store facade stamps writes with
  the mount id (`store:set` WS frame carries `mount`), so opt-out and coalescing
  key on the right pane; unattributed writes coalesce under a generic
  `surface` item.

Activity items queue like everything else — they never wake on their own; the
user's Push delivers them.

### Self-wake safety

Only `browser`/`ext:*`-sourced events enqueue. Claude's `set_store` and drivers'
writes are `source:'server'` and never enqueue — so Claude's own mutations can't
wake it. (`lib/channel/policy.classify` is the one gate.)

### Parked delivery — the no-channel fallback

Channels availability is gated by four things the package can't control (Claude Code
≥ 2.1.80, Anthropic auth, enterprise `channelsEnabled`, the dev flag), so a Push can
land with **no bridge consuming wakes** (`state.wakeConsumers === 0`). `queue.flush`
handles both cases:

- **Connected** (`wakeConsumers > 0`): today's path — `emitWake` → `wake` bus event →
  bridge → `<channel>` tag.
- **Disconnected**: the same `wakeEnvelope(batch)` (summary only, identical contract)
  is **parked** in `state.pendingWake` — drafted/persisted like other live state, so
  it survives restart. The `POST /api/queue/push` response reports `mode:'parked'`;
  the rail shows "delivers with your next message".

The `UserPromptSubmit` hook (`lib/hooks/turn-begin.js`) then reads the park
(`GET /api/queue/pending`), **claims it by id** (`POST /api/queue/pending/consume`),
and injects the summary as context on that prompt — Claude fetches bodies by tool
call exactly as on a channel wake. Path A (hook) and path B (a bridge that connects
before the next prompt drains it) are mutually exclusive by the id-claim: **first
consumer wins**, no double delivery. A re-push while a park is pending **merges** into
the single envelope (re-stamped id) rather than stacking a second one.

## Architecture

```
 daemon (HTTP/WS server)                         MCP process
 ─────────────────────────                       ─────────────
 bus event  ──▶ policy.classify ──▶ queue        subscribeSSE(kinds:['wake'])
 (capture,        (daemon-side          │             │
  browser         subscriber)           ▼             ▼
  signal)                          state.queue    bridge.deliver
                                        │             │
                     POST /api/queue/push (P)         │  wakeEnvelope(batch)
                                        ▼             ▼
                              emitWake ──── wake ──▶ notify(
                              (bus, emit-only)        'notifications/claude/channel',
                                                       {content, meta})
```

- **`lib/channel/policy.js`** — pure `classify(event, {signals, routing})`.
  Captures → enqueue; declared browser signals → enqueue or immediate wake;
  undeclared browser activity (dom events, undeclared store writes) → coalesce
  into the mount's rolling activity item; everything else → null.
- **`lib/server/domain/queue.js`** — the queue + `emitWake`, the single `wake`
  emitter. `wake` is emit-only (no WS frame; browsers never see it).
- **`lib/channel/bridge.js`** — the MCP-process consumer. Taps `wake` over SSE,
  fires one `notifications/claude/channel` per wake. Lazy connect + capped
  backoff; seq-cursor dedupe. The experimental `notify` call is injected (one
  seam).
- **`lib/channel/envelope.js`** — `wakeEnvelope(batch) → {content, meta}`.

## The envelope / meta contract (versioned)

Constraints from the wire, enforced in `envelope.js`:

- **`content` is one string** — a sanitized **summary only**. A capture body or a
  signal payload is **never inlined** (prompt-injection surface). Claude fetches
  the real payload by tool call (`get_captures` / `inspect_capture` / `get_store`).
- **`meta` keys match `[A-Za-z0-9_]`** (the harness drops hyphens) and **values are
  strings**. Enforced by `sanitizeMeta`.

**Meta vocabulary** (`META_KEYS`, tripwire-tested in `test/conventions.test.js`):

| key        | meaning                                                            |
| ---------- | ----------------------------------------------------------------- |
| `kind`     | `capture` \| `signal` \| `activity` \| `comment` \| `batch` (mixed) |
| `count`    | number of included items                                          |
| `seq`      | the wake's ring seq (correlation)                                 |
| `origin`   | event source (`queue` \| `browser` \| `ext:tab-stream`) — NOT `source` |
| `mount`    | origin mount id (single-item only)                                |
| `ids`      | comma list of queue item ids                                     |
| `captures` | comma list of capture ids to fetch                               |

> The harness stamps `source="<channel-name>"` on the `<channel>` tag itself, so we
> use **`origin`** for the event source to avoid a collision. Do not add a meta
> `source` key.

Example wire:

```xml
<channel source="web-chat" kind="capture" count="1" seq="4" origin="queue" ids="q1" captures="cap1">
A queued signal was pushed to Claude:
- [capture] captured example.com · profile tables · cap1
</channel>
```

## Running it (dev)

Requires Claude Code ≥ v2.1.80 and **Anthropic auth** (no Bedrock/Vertex/Foundry;
Team/Enterprise needs `channelsEnabled`). Custom/development channels need the
`--dangerously-load-development-channels` flag.

```sh
WEB_CHAT_CHANNEL=1 claude --dangerously-load-development-channels server:web-chat
```

- `WEB_CHAT_CHANNEL=1` gates the capability declaration + bridge start. `install`
  writes it into the project's `.mcp.json` env, so the only thing the
  user adds by hand is the launch flag. **Unset, the capability isn't declared and
  the bridge doesn't start** — a Push then **parks** and rides the user's next message
  (parked delivery), so the surface still works, just without live
  wakes.
- A channel notification fired while no session is listening is **dropped by the
  harness** — but the daemon is the buffer of record (queue/store/graph persist), and
  a Push with no consumer **parks** rather than dropping (parked delivery), so the UX
  degrades to catch-up-on-next-prompt, never data loss.

## Smoke test (no live session needed)

`scripts/channel-smoke.js` drives a producer against the running daemon, pushes,
and prints the exact `<channel>` the bridge would emit:

```sh
node scripts/channel-smoke.js                       # a capture → push
node scripts/channel-smoke.js --signal              # a declared queue signal → push
node scripts/channel-smoke.js --note "focus totals" # attach batch context
```

To confirm Claude *actually* wakes: run the launch command above, queue a capture
or a signal, hit **P**, and watch Claude wake with the `<channel>` batch and fetch
bodies by tool call.

## Tests

- `test/channel-policy.test.js` — classify + envelope + sanitizers.
- `test/queue.test.js` — enqueue / push→one-wake / remove / draft round-trip.
- `test/channel-signals.test.js` — declared queue vs immediate wake.
- `test/activity-routing.test.js` — the opt-out layer: per-mount coalescing,
  affordance-only clicks, value-leak guards, service-pane default opt-out.
- `test/channel-bridge.test.js` — real-daemon SSE → exactly one notification;
  dedupe/reconnect.
- `test/channel-mcp.test.js` — the env-gated capability (off = 23 tools, no
  experimental; on = `experimental['claude/channel']`).
- `test/conventions.test.js` — the meta vocabulary tripwire.

## Turn-begin-on-push (the turn-lock model after channels)

The pre-channels invariant — "Claude is working ⟺ a lock is held" — broke when
wakes started turns without the `UserPromptSubmit` hook. Restored by locking at
the source: **`queue.emitWake` acquires the turn lock** (`acquireWakeLock`,
author `'wake'`, short per-lock TTL — `WEB_CHAT_WAKE_LOCK_TTL_MS`, default 3 min)
just before the wake goes out, so a channel-woken turn runs locked like any
other and its Stop-hook `turn-end` commits a first-class node whose
`trigger.message` names the wake. Since every wake producer goes through the one
emitter, the invariant is one-line-auditable. Cases:

- **Fresh user lock** → the wake folds into the running typed turn (no-op).
- **Fresh wake lock** → a second wake extends it (one turn, one node).
- **Typed prompt during a wake turn** → `acquireLock` UPGRADES the wake lock in
  place (same base, re-stamped author/message/clock) — never a 409, because the
  prompt lands in the same session the wake woke.
- **A parked push stays lock-less** — its delivery *is* the user's next prompt,
  whose turn-begin hook locks normally.
- An orphaned wake lock (wake emitted, turn never ran) self-heals via its short
  TTL.

### Pending re-aim

A user re-aim (set-active / wipe / new-graph / branch-here) during a fresh lock
is **queued, not 409'd** — one in-memory slot (`graph.pendingReaim`, last intent
wins), surfaced to clients as a `reaim:pending` WS frame ("queued — applies when
the turn ends"). `turn-end` commits on the lock base first, then applies the
intent (`applyPendingReaim`); manual `/api/unlock` applies it too. Deliberately
not persisted: on a crash the draft preserves the *work*, and the user re-clicks
the *intent*. Tests: `test/turn-lock-wake.test.js`.

## Deferred

- Store-mailbox purification (`tab_capture` signal). *(The rules-file wake-loop
  diet and the legacy `wait_for`/`watch` deletion shipped;
  parked delivery replaced the planned GA fallback; `turn-begin-on-push` +
  pending re-aim shipped — see above.)*
