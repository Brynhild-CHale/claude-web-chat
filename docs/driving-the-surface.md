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
| **Browser pane** | until cleared/replaced — and its `store` subscriptions, bare-name timers, `api.signal` listeners and `api.onUnmount` callbacks end with it | shadow-rooted JS + `store.subscribe` over `/ws` | Renders state, captures user input, emits signal keys. |
| **Driver (host process)** | seconds–hours; bounded by its own timeout | plain HTTP (`lib/driver.js`) | Does work the browser can't (shell, filesystem, long jobs) and pushes results to the surface. |

The store (`state.store`, a plain object mutated under Node's single-threaded
loop — see `lib/server/state.js`) is the bus. Every actor writes patches; every
actor subscribes. There is no enforced provenance, so by convention every
signal-key value carries `{seq, payload}` and readers dedupe on `seq`.

A driver is a **passive collaborator**: it writes the store and renders mounts,
but never touches the graph routes (`/api/turn-begin`, `/api/turn-end`,
`/api/unlock`, `/api/graph/active`). Those drive the per-server turn lock, and a
driver that takes it blocks the user from navigating the graph for up to the lock
TTL (default 15 min, `lib/server/domain/turns.js`; `WEB_CHAT_LOCK_TTL_MS`
overrides it, and `WEB_CHAT_WAKE_LOCK_TTL_MS` the shorter one a channel wake
takes). The graph belongs to Claude's turn lifecycle and the user.

---

## The driver helper — `lib/driver.js`

```js
const { createDriver } = require('claude-web-chat/lib/driver');

const wc = createDriver({ owner: 'test-runner' }); // discovers the port
await wc.writeMarkdown({ id: 'tests-h', text: '## Tests' });
await wc.render({ id: 'tests', html: '<p>running…</p>', after: 'tests-h' });
await wc.setStore({ test_run: { seq: Date.now(), status: 'pass', total: 42 } });
const ev = await wc.waitFor({ store_key: 'rerun_request', exists: true });
```

`createDriver({ owner, root?, port? })` discovers the port (explicit `port` →
`WEB_CHAT_PORT` → portfile walked up from `root`/cwd, matching
`lib/mcp/client.js`) and returns at once — it makes no request until the first
call. `owner` is a short lowercase name (letters, digits and dashes, e.g.
`test-runner`); the driver writes as `service:<owner>`. It returns:

| Method | Maps to | Notes |
|---|---|---|
| `render({html, id?, target?, params?, theme?, force?, after?, place?})` | `POST /api/render` | Auto-tags `owner`. Returns the envelope — check `.ok` (see ownership below). `after` and `place` position and size the pane as on the route (below); the applied placement comes back as `place`. `theme` is normalized like any other (below). |
| `writeMarkdown({text, id?, after?, force?})` | `POST /api/markdown` | Puts a markdown item on the page: a heading or short prose between and around panes. Auto-tags `owner`. Reuse `id` to rewrite one in place; left out, the server assigns `md-<n>` and returns it as `id`. `after` places it as it places a pane. Check `.ok`: an item another writer owns, an id a pane holds (`conflict`), a reserved id and text over the cap (`too_large`) all soft-reject. |
| `removeMarkdown({id, force?})` | `POST /api/markdown` with `remove: true` | Takes one markdown item off the page, and never a pane of that id. Returns `{ok, removed, id}`; `removed` is `false` when no such item was there. An item another writer owns soft-rejects without `force`. |
| `setStore(patch)` | `POST /api/store` | Merge a patch; use a signal key with a bumping `seq`. |
| `setMarks(marks)` | `POST /api/marks` | Replace this driver's transient marks (`[{mount, kind, anchor?, element?, label?}]`, at most 200 in 64 KB): highlights of the moment, held off the store — never committed into a node, never on the event log, never waking Claude — and cleared by every reset (a restore, Wipe or New graph). Keyed by this driver's owner, under its lease. Returns `{ok, owner, count, writer}`. |
| `clearMarks()` | `POST /api/marks` with `marks: []` | Clears this driver's marks. |
| `getStore(keys?)` | `GET /api/store` | Full store, or a filtered subset. |
| `clear({id?, target?})` | `POST /api/clear` | Auto-tags `owner`. By id it takes a pane or a markdown item. |
| `release()` | `DELETE /api/writers/lease` | Gives this driver's lease on its owner back (below), so another driver can take the owner. Returns `{ok, released}`; a later write by this driver leases again. |
| `getEvents({since?})` | `GET /api/events` | Catch-up tail + gap detection (see below). |
| `waitFor(predicate, {timeout_ms?})` | `POST /api/wait` | Long-poll on a store key or event kind. **Driver-only** — Claude wakes via the channel/queue, not this. |

It throws `NoServerError` (`.code === 'NO_SERVER'`) if no daemon is reachable —
start one with `claude-web-chat open`, or set `WEB_CHAT_PORT`.

### One owner per live driver — the lease

The daemon takes a `service:` owner only from a writer that proves it
(`lib/server/routes/writers.js`): the `owner` a request body names is ignored
when the request carries a credential, and refused when it does not. A driver
proves its owner with a **lease**:

- On its first `render`, `writeMarkdown`, `removeMarkdown` or `clear`, the
  driver asks `POST /api/writers/lease {owner, pid}` (one request, however many
  writes start at once) and sends the token it gets back as the `X-WC-Writer`
  header on every call after. Reads (`getStore`, `getEvents`, `waitFor`,
  `streamEvents`) and `setStore` never lease.
- **One owner per live driver instance.** While another driver holds the owner
  — in another process, or a second `createDriver` with the same `owner` in this
  one — or while a running service of that name does, the write resolves to a
  soft reject, never a throw:

  ```json
  { "ok": false, "rejected": true, "owner_taken": true, "owner": "service:test-runner",
    "hint": "another live driver holds this owner (one owner per live driver) — release() it, or pick another owner name" }
  ```

  The next write asks for the lease again, so a driver that waits for the other
  one to `release()` (or exit) needs nothing more.
- A lease whose holder process has died is reaped by the next lease request for
  that owner — there is no timer, and nothing to clean up after a crash.
- A **service** outranks a lease: when a service-backed component's child starts
  (the user approved it with `claude-web-chat trust`), any lease on its name is
  revoked, and the holder's next write is refused until it leases again.
- Leases live in the daemon's memory. After a daemon restart the token is
  `stale` (401); the driver leases again, once, and retries the write.
- `release()` gives the lease back; a driver that is done should call it.

A service child does not lease: the supervisor hands it its own writer token
over IPC (`ctx.driver` is already built with it), revoked when the child stops.

---

## Mount ownership — the `owner` convention

Every mount carries an `owner` string. Claude (the `render` MCP tool, which sends
no owner) is `'claude'`; a driver is `'service:<name>'` (the helper adds the
`service:` prefix, and the lease above proves it — a `service:` owner sent
without its credential is refused `403 {ok:false, writer:'unverified'}`). It
rides into committed graph nodes automatically and shows up in `list_mounts` /
`GET /api/mounts`.

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

Markdown items carry an owner the same way (`writeMarkdown` stamps the
driver's), under the same gate: rewriting or removing an item another writer
owns soft-rejects with this envelope unless you pass `force:true`.

Pick a namespaced `id` per driver surface (`tests_*`, `watch_*`) to avoid
collisions in the first place.

Pane history's "make current" (`POST /api/mounts/:id/restore`) never touches a
driver's pane: it refuses a live pane a driver owns, and a version a driver wrote.

A third kind of owner is `pane:<id>`: a pane that another pane's script spawned
(`api.spawn`, via `POST /api/pane/spawn`). The same gate applies to a driver —
a driver re-rendering or clearing one needs `force:true` — and a pane can never
spawn over a driver's pane, because it never passes `force`. Only a spawn mints
a `pane:` owner: a render, markdown write or clear that names one is refused
(403).

---

## The event model

Every mutation endpoint emits an event with a monotonic `seq` and a `source`:

- `render` → `{kind:'render', id, target, bytes, source:<owner>}`
- `markdown` → `{kind:'markdown', op:'put', id, bytes, source:<owner>}`, or
  `{kind:'markdown', op:'remove', id, source:<owner>}`
- `clear` → `{kind:'clear', id?, target?, source:<owner>}`
- `store` → `{kind:'store', patch, source:'server'}`
- graph ops → `{kind:'graph', op, …}`

`GET /api/events?since=<seq>` returns `{events, latest, oldest, gap, dropped}`.
The log is a **lossy ring** (`MAX_EVENTS` = 1000, `lib/core/bus.js`): a
high-frequency producer can push old events out. If your cursor predates the
oldest retained event, `gap:true` / `dropped:N` tells you to resync from a full
`getStore()` snapshot rather than trust an incomplete catch-up.

### Push instead of poll — SSE (`GET /api/events/stream`)

For lower latency than polling, subscribe to the **Server-Sent Events** stream.
Each event arrives as an SSE frame (`id:` = seq, `event:` = the event `kind`,
`data:` = the full event JSON) the instant `bus.emit` fires. Query: `?since=<seq>`
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

External writes are **live-only**. A driver's renders, markdown and store writes
mutate the running server's state immediately and broadcast to the browser — but
they are **not** a graph node. They fold into the **next** node the same way a
user's pane clicks do: when Claude's turn ends, the Stop hook (`turn-end`)
snapshots whatever is live — including driver-owned panes and markdown and driver
store writes — into one new node. `owner` is preserved on those panes and
markdown items, so a committed node records which ones a driver authored.

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
`<root>/.web-chat/server.json` (`{pid, port, url}`), or `WEB_CHAT_PORT`. To
render, write markdown or clear as `service:<name>`, lease the owner first and
send the token as `X-WC-Writer` on those calls (the body's `owner` is then
ignored); a 401 `{writer:'stale'}` means the daemon restarted — lease again.

| Endpoint | Body | Does |
|---|---|---|
| `GET /api/health` | — | `{ok, pid, package_version, active, nodes, lock, lock_stale, active_label, last_commit_at, viewers}` — liveness + graph state; `package_version` is the web-chat release the daemon runs (`version` is the wire-protocol number, not a release). |
| `GET /api/store?keys=a,b` | — | Full store, or filtered. |
| `POST /api/store` | `{patch}` | Merge + broadcast. Returns post-patch store. |
| `POST /api/writers/lease` | `{owner, pid}` | Lease `owner` (`service:<name>`) for one driver: `200 {ok, owner, token}`, `409 {ok:false, refused:'owner_taken', owner, hint}` while a live driver or a running service holds it, `400` for any other owner (`claude`, `user`, `pane:*` are never leasable). Local, non-browser callers only. |
| `DELETE /api/writers/lease` | — (header `X-WC-Writer: <token>`) | Release that lease: `{ok, released}`. |
| `POST /api/render` | `{html, id?, target?, params?, theme?, owner?, force?, after?, place?}` | Mount/replace. A `service:` `owner` needs the lease's `X-WC-Writer` (403 `unverified` without it); with it, the lease's owner is used. Soft-rejects (HTTP 200) on locked or cross-owner; check the body. `theme` normalized (below). `after` positions the pane in the page sequence; `place: {col, span, rows}` sizes it on the 12-column grid (clamped; the applied value comes back as `place`). |
| `POST /api/markdown` | `{text, id?, after?, owner?, force?}` / `{id, remove:true, owner?, force?}` | Put or replace a markdown item (escaped; a page's headings build its Contents), or take one off. Soft-rejects (HTTP 200) on cross-owner, an id a pane holds, a reserved id, or text over the cap; check the body. |
| `POST /api/clear` | `{id?}` / `{target?}` / `{}` | Remove a pane or markdown item by id / a slot / everything. |
| `POST /api/marks` | `{marks, owner?}` | Replace the caller's transient marks (an empty list clears them); host only. A ws-only `marks` frame, no event, no node. `GET /api/marks` lists every set with its writer. |
| `GET /api/events?since=<seq>` | — | `{events, latest, oldest, gap, dropped}`. |
| `POST /api/wait` | `{predicate, timeout_ms}` | Long-poll (**driver-only**; Claude uses the channel/queue). `{ok:false, timeout:true}` (HTTP 200) on miss. Counts against the 5s shutdown drain. |

**A `theme` on a render is a pane theme, and it takes the same path as one set
through `POST /api/theme` with `{scope:'pane'}`.** Token names that are not
`--wc-` prefixed are dropped, and values lose the characters that could break out
of a `name: value;` declaration — so the two doors onto a pane's theme agree.
Omitting `theme` on a re-render KEEPS the pane's current one; sending `null`
clears it. Raw `css` at pane scope is still the documented escape hatch and is
carried through as written: it lands inside that pane's shadow root and styles
that pane's content only.

Don't POST the graph routes from a driver (see the three-actor model).

---

## Trust boundary & failure modes

- **Loopback only.** The server binds `127.0.0.1` (`LISTEN_HOST` in
  `lib/core/cors.js`, overridable with `WEB_CHAT_HOST` for the deliberate remote
  case) with no auth — any local process can read and write the store and render
  arbitrary HTML/JS into the user's browser. The bind address IS the access
  control. Treat the surface as a same-machine trust domain; don't expose the port
  off-box, and don't render untrusted third-party HTML through it. One thing a
  `WEB_CHAT_HOST` bind does NOT open: the chat mirror shows a peer on the network
  only Claude's status — the heartbeat (state, timings, the kind of step), never
  a prompt, a reply, a path or a command — and nothing it sends raises that
  (`lib/server/audience.js`); Claude's conversation leaves the machine only
  through the authenticated tunnel (see
  [Showing Claude's conversation remotely](remote-access.md#showing-claudes-conversation-remotely)).
- **Pane code runs with the chrome's authority.** A pane's script is not
  sandboxed: it runs in the surface page's own window (its shadow root scopes
  styles, not privilege, and is open), so it can do whatever the chrome can. It
  can Push to Claude — click **Push → Claude**, or `POST /api/queue/push` with a
  note of its choosing — which wakes Claude like your own Push. It can read every
  store key, another pane's or a service's included, and other panes' shadow
  roots. It can call almost any local route: render, a forced `clear`, Wipe,
  `POST /api/graph/active`. The exceptions are the few routes that refuse any
  request carrying browser fetch metadata (`isBrowserRequest` in
  `lib/core/cors.js` — `Origin` or `Sec-Fetch-*`, which page script can neither
  forge nor strip): `POST /api/shutdown`, the export that writes a file to disk
  (`GET /api/export/:ref?format=file`; the download a browser makes has no
  `format`) and `POST /api/replay/open`. And `POST /api/components/:name/use`,
  the ＋ drawer's route, strips `params.signals` and ignores `force` for a
  browser, so a pane cannot declare a wake signal or take over another pane
  through it. Approving a service has no route at all. The daemon's own rules —
  the `event` frame allowlist, owner and lock checks, the spawn caps, declared
  signals — decide what the
  browser's frames *mean*; they are not a fence around a pane's code. Panes are
  trusted, agent-authored JavaScript: don't render untrusted third-party HTML into
  one, and read a component pack (`pack get` + `pack review`) before installing
  components you did not write.
- **Every request is gated on `Host`.** The daemon and the hub answer only to the
  names they actually are — `localhost`, `127.0.0.1`, `[::1]` — and reply
  `421 Misdirected Request` to anything else. This is the DNS-rebinding gate: a
  page at `attacker.example` whose DNS is rebound to `127.0.0.1` reaches us
  *same-origin*, so it sends no `Origin` and the CORS rules never fire; `Host`
  still carries the name it dialled, and page script cannot forge it. A driver is
  unaffected — dial `127.0.0.1` or `localhost` and Node sets the header for you.
  Two exceptions to know: with `WEB_CHAT_HOST` set to a **single** address, that
  address is accepted alongside loopback (the deliberate remote case), and with it
  set to a **wildcard** (`0.0.0.0`, `::`) the check is skipped entirely, because
  every name that resolves to this machine is then legitimate and none is
  distinguishable — a wildcard bind is back to "the bind address is the access
  control" (for everything but the chat mirror, which still shows a network peer
  only Claude's status), which is what `warnIfExposed` warns about at boot. Point the browser
  extension at a non-local hub and you must bind that host explicitly, or its
  requests are refused.
- **The WS upgrade is gated on `Origin`** (and on `Host`, as above — the upgrade
  never passes through express middleware, so `verifyUpgrade` folds both in).
  A browser asserting a foreign origin is
  refused (that's what stops any page the user visits from opening
  `ws://localhost:<port>/ws` and reading the whole store out of the `hello` frame).
  A driver sends **no** `Origin` at all, and an absent one is allowed — so
  `new WebSocket(...)` from a Node process is unaffected. Don't invent an `Origin`
  header to "look like a browser"; that's the one thing that would get you
  rejected.
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
  UI and looks dead. Always check it and back off. `owner_taken: true` is the
  driver helper's: another live driver (or a running service) holds your owner —
  pick another owner name, or wait for it to `release()`.
- **Bounded loops only.** A long-lived driver must have a hard timeout, run
  cleanup exactly once (a `cleanedUp` flag), and install `SIGTERM`/`SIGINT`/`exit`
  handlers so it doesn't orphan child processes. See
  [`examples/`](../examples/) for the canonical shape.
