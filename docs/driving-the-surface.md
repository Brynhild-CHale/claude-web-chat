# Driving the surface from a local process

The web-chat surface isn't only for Claude. Any local process — a dev server, a
test runner, a build pipeline, a file watcher — can push content into panes and
the shared store, so a panel reflects live external state and Claude can react to
it. This doc is the contract: the helper, the endpoints, the ownership model, how
external writes relate to the graph, and the trust boundary.

> Companion to [`.claude/rules/web-chat.md`](../.claude/rules/web-chat.md) (the
> Claude-facing surface rules) and the runnable [`examples/`](../examples/).

---

## The three-actor model

A live surface has up to three actors writing to the same state, concurrently:

| Actor | Lifetime | Channel | Role |
|---|---|---|---|
| **Claude turn** | seconds–minutes; ends at the Stop hook | MCP tools / HTTP | Authors mounts, supervises, commits a graph node on exit. |
| **Browser pane** | until cleared/replaced | shadow-rooted JS + `store.subscribe` over `/ws` | Renders state, captures user input, emits signal keys. |
| **Driver (host process)** | seconds–hours; bounded by its own timeout | plain HTTP (`lib/driver.js`) | Does work the browser can't (shell, filesystem, long jobs) and pushes results to the surface. |

The store (`state.store`, a plain object mutated under Node's single-threaded
loop — see `lib/server/state.js`) is the bus. Every actor writes patches; every
actor subscribes. There is no enforced provenance, so by convention every
signal-key value carries `{seq, payload}` and readers dedupe on `seq`.

A driver is a **passive collaborator**: it writes the store and renders mounts,
but never touches the graph routes (`/api/turn-begin`, `/api/turn-end`,
`/api/unlock`, `/api/graph/active`). Those drive the per-server turn lock, and a
driver that takes it blocks the user from navigating the graph for up to the lock
TTL (default 15 min, `lib/server/routes/graph.js`). The graph belongs to Claude's
turn lifecycle and the user.

---

## The driver helper — `lib/driver.js`

```js
const { createDriver } = require('claude-web-chat/lib/driver');

const wc = createDriver({ owner: 'test-runner' }); // discovers the port
await wc.render({ id: 'tests', html: '<h2>running…</h2>' });
await wc.setStore({ test_run: { seq: Date.now(), status: 'pass', total: 42 } });
const ev = await wc.waitFor({ store_key: 'rerun_request', exists: true });
```

`createDriver({ owner, root?, port? })` discovers the port (explicit `port` →
`WEB_CHAT_PORT` → portfile walked up from `root`/cwd, matching
`lib/mcp/client.js`) and returns:

| Method | Maps to | Notes |
|---|---|---|
| `render({html, id?, target?, params?, theme?, force?})` | `POST /api/render` | Auto-tags `owner`. Returns the envelope — check `.ok` (see ownership below). |
| `setStore(patch)` | `POST /api/store` | Merge a patch; use a signal key with a bumping `seq`. |
| `getStore(keys?)` | `GET /api/store` | Full store, or a filtered subset. |
| `clear({id?, target?})` | `POST /api/clear` | Auto-tags `owner`. |
| `getEvents({since?})` | `GET /api/events` | Catch-up tail + gap detection (see below). |
| `waitFor(predicate, {timeout_ms?})` | `POST /api/wait` | Long-poll on a store key or event kind. **Driver-only** — Claude wakes via the channel/queue, not this. |

It throws `NoServerError` (`.code === 'NO_SERVER'`) if no daemon is reachable —
start one with `claude-web-chat open`, or set `WEB_CHAT_PORT`.

---

## Mount ownership — the `owner` convention

Every mount carries an `owner` string. Claude (the `render` MCP tool, which sends
no owner) is `'claude'`; a driver is `'service:<name>'` (the helper adds the
`service:` prefix). It rides into committed graph nodes automatically and shows up
in `list_mounts` / `GET /api/mounts`.

**Clobber-guard.** If an existing mount has a *different* non-null owner, a
re-render of that `id` is **rejected** with a soft envelope (HTTP 200, like the
locked-pane reject), unless you pass `force:true`:

```json
{ "ok": false, "rejected": true, "owned": true, "id": "tests", "owner": "service:test-runner",
  "hint": "pane 'tests' is owned by 'service:test-runner'; pass force:true to take it over" }
```

So a driver and Claude can't silently overwrite each other's panes by colliding
on `id`. Both sides should check `.ok` and either pick a different `id` or
deliberately `force`. Claude sees the owner in `list_mounts` before rendering.

Pick a namespaced `id` per driver surface (`tests_*`, `watch_*`) to avoid
collisions in the first place.

---

## The event model

Every mutation endpoint emits an event with a monotonic `seq` and a `source`:

- `render` → `{kind:'render', id, target, bytes, source:<owner>}`
- `clear` → `{kind:'clear', id?, target?, source:<owner>}`
- `store` → `{kind:'store', patch, source:'server'}`
- graph ops → `{kind:'graph', op, …}`

`GET /api/events?since=<seq>` returns `{events, latest, oldest, gap, dropped}`.
The log is a **lossy ring** (1000 entries, `lib/server/state.js`): a
high-frequency producer can push old events out. If your cursor predates the
oldest retained event, `gap:true` / `dropped:N` tells you to resync from a full
`getStore()` snapshot rather than trust an incomplete catch-up.

### Push instead of poll — SSE (`GET /api/events/stream`)

For lower latency than polling, subscribe to the **Server-Sent Events** stream.
Each event arrives as an SSE frame (`id:` = seq, `event:` = the event `kind`,
`data:` = the full event JSON) the instant `pushEvent` fires. Query: `?since=<seq>`
replays buffered events before going live; `?kinds=a,b` filters to those kinds. A
reconnecting `EventSource` sends `Last-Event-ID` automatically, used as the
catch-up cursor. The ring-eviction gap is surfaced as a dedicated `event: gap`
frame (`{gap, dropped, oldest}`) — resync on it. A `:` heartbeat comment every
15s keeps the connection warm.

An open stream **retains the server** (it won't grace-shut-down with no browser
tab open), so a headless watcher stays fed. The driver helper wraps it:

```js
const sub = wc.streamEvents({
  kinds: ['store', 'render'],
  onEvent: (e) => { /* react — same shape as getEvents().events[i] */ },
  onGap:   (g) => { /* resync from getStore() */ },
});
// …later
sub.close();
```

SSE is a **latency upgrade only** — it does not change the wake model. A pane
click or driver write still can't *start* a Claude turn; Claude is woken through
the channel/queue (the user's **Push → Claude**, or a pane's declared
`wake:'immediate'` signal), or by a parked delivery folded into the user's next
message — never by a driver (see `.claude/rules/web-chat.md`). Use SSE for
driver↔driver / driver↔pane reactivity and tighter driver-side loops; the driver's
own `waitFor` long-poll (`/api/wait`, above) is the driver-only wait primitive.

**Stale signal keys across sessions.** Keys you wrote last session persist until
overwritten or server shutdown. On startup, read the current `seq` of any key
you'll wait on and treat it as your floor — don't reprocess anything `≤ floor`.
For `waitFor` with an `event_kind` predicate, pass `since_seq` (from a prior
`getEvents` `latest`) or the wait fires immediately on a buffered old event.

---

## Between-turn commit semantics

External writes are **live-only**. A driver's renders and store writes mutate the
running server's state immediately and broadcast to the browser — but they are
**not** a graph node. They fold into the **next** node the same way a user's pane
clicks do: when Claude's turn ends, the Stop hook (`turn-end`) snapshots whatever
is live — including driver-owned panes and driver store writes — into one new
node. `owner` is preserved on those mounts, so a committed node records which
panes a driver authored.

So the lifecycle is:

1. Driver renders / writes store → live state changes, browser updates. No node.
2. (optionally) Claude picks the driver writes up at its next turn via `get_events` /
   `get_store` and renders more (a driver write is `source:'server'` — it never wakes
   Claude; only the user's Push / a declared browser signal does).
3. Turn ends → everything live (Claude's + the driver's + the user's) commits as
   one node. The user can revisit it.

If the server shuts down **gracefully** between turns, uncommitted live state
(driver writes included) is snapshotted to `draft.json` and restored on next
boot. A hard crash loses uncommitted live state — drivers should keep anything
durable in their own process, not rely on the surface to persist it.

---

## Endpoint cheatsheet (for non-Node drivers)

Any language can drive the surface — it's just HTTP. Discover the port from
`<root>/.web-chat/server.json` (`{pid, port, url}`), or `WEB_CHAT_PORT`.

| Endpoint | Body | Does |
|---|---|---|
| `GET /api/health` | — | `{ok, pid, active, nodes, lock}` — liveness + graph state. |
| `GET /api/store?keys=a,b` | — | Full store, or filtered. |
| `POST /api/store` | `{patch}` | Merge + broadcast. Returns post-patch store. |
| `POST /api/render` | `{html, id?, target?, params?, theme?, owner?, force?}` | Mount/replace. Soft-rejects (HTTP 200) on locked or cross-owner; check the body. |
| `POST /api/clear` | `{id?}` / `{target?}` / `{}` | Remove a pane / slot / everything. |
| `GET /api/events?since=<seq>` | — | `{events, latest, oldest, gap, dropped}`. |
| `POST /api/wait` | `{predicate, timeout_ms}` | Long-poll (**driver-only**; Claude uses the channel/queue). `{ok:false, timeout:true}` (HTTP 200) on miss. Counts against the 5s shutdown drain. |

Don't POST the graph routes from a driver (see the three-actor model).

---

## Trust boundary & failure modes

- **localhost only.** The server binds `localhost` with no auth — any local
  process can read and write the store and render arbitrary HTML/JS into the
  user's browser. Treat the surface as a same-machine trust domain; don't expose
  the port off-box, and don't render untrusted third-party HTML through it.
- **Server auto-shuts down ~10s after the last browser disconnects**
  (`lib/server/ws.js`). A driver polling an empty server sees `ECONNREFUSED`;
  re-discover via the portfile (a fresh server writes a new one) and treat
  `NoServerError` as "surface is closed", not a fatal crash.
- **No per-key store locking.** Last write wins. Two drivers hitting one key
  race — partition the key namespace per driver, or let `seq` carry conflict
  resolution. Use **per-direction** keys (`<thing>_request` written by the pane,
  `<thing>_status` written by the driver); never write one key from both sides or
  the dedup-by-`seq` invariant breaks.
- **Pane-lock and owner soft-rejects** return HTTP 200 with `{ok:false,
  rejected:true, …}` — a driver that ignores `.ok` silently fails to update the
  UI and looks dead. Always check it and back off.
- **Bounded loops only.** A long-lived driver must have a hard timeout, run
  cleanup exactly once (a `cleanedUp` flag), and install `SIGTERM`/`SIGINT`/`exit`
  handlers so it doesn't orphan child processes. See
  [`examples/`](../examples/) for the canonical shape.
