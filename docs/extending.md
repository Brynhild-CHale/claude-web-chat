# Extending web-chat — use the engines, don't bolt on

This doc describes the extension *engines that exist today* and the one rule that
keeps them singular.

## Working on the package

```sh
git clone https://github.com/Brynhild-CHale/claude-web-chat.git
cd claude-web-chat
npm install
npm link
```

`npm link` symlinks the three bin scripts (`claude-web-chat`, `-mcp`, `-hook`)
onto your PATH so the CLI, MCP server, and hook helper all resolve to your working
copy — edit and re-run, no reinstall cycle. After a `git pull` the symlinked bins
already point at the new code. Run the suite with a bare `node --test`
(auto-discovers `test/`; **not** `node --test test/`, which mis-resolves and
reports a spurious failure).

### Loading the MCP tools when dogfooding this repo

The committed `.mcp.json` is the plugin stub — it points at
`${CLAUDE_PLUGIN_ROOT}/bin/claude-web-chat-mcp.js`, a variable only defined when
web-chat is loaded as an installed Claude Code *plugin*. Open this repo as a plain
project and it never resolves, so Claude Code can't spawn the MCP server and none
of the in-session tools load (the daemon and CLI still work). Register a
local-scope server (absolute path, stored in the gitignored `~/.claude.json`,
leaving the committed stub intact):

```sh
claude mcp add web-chat --scope local -- node "$(pwd)/bin/claude-web-chat-mcp.js"
```

Then fully restart Claude Code (`/exit` + reopen — there is no live MCP reconnect).
Undo with `claude mcp remove web-chat --scope local`.

## The failure mode this prevents

Every earlier feature tranche was built by **copying the mechanism of the previous
feature** instead of extending a shared one — six HTTP-client copies, three
portfile readers, ~15 hand-built `.web-chat` paths. Each new feature then had to
pick which copy to imitate, imitated one imperfectly, and became copy N+1.

The refactor collapses each concept behind **one engine**. The rule that keeps it
that way:

> **If a mechanism exists, extend its engine. If it doesn't, build the engine
> (in `lib/core/` or a shared module) and consume it from your feature. A second
> hand-rolled copy of anything below is a review-blocking defect.**

Three of the most-copied primitives are enforced automatically by
`test/conventions.test.js` (see [The tripwire](#the-conventions-tripwire)); the
rest rely on this doc and review.

## Dependency direction (what may import what)

```
entry points   cli/* · mcp/* · hooks/* · driver.js · hub/* · server/*
                     │  import ↓ only
lib/client/          the one daemon HTTP client
                     │  import ↓ only
lib/core/            paths · portfiles · cors   (zero deps on the rest of lib/)
```

- `lib/core/*` imports **nothing** from `lib/` except other `core/` modules
  (`portfiles` → `paths`). It is the leaf. In particular **core must not import
  `lib/client`** — that's why the two liveness probes live in `core/portfiles`,
  not in the client.
- `lib/client` imports `core/*` (+ `util/daemon`). Everything else imports
  `lib/client` and `core/*`; entry points never reach into each other's internals.
- A helper that seems to belong in two layers belongs in the lower one.

## The engines — need X, use Y

| You need to… | Use | Never |
| --- | --- | --- |
| resolve a path under `.web-chat/` or `~/.web-chat/` | `core/paths` `projectPaths(root)` / `userPaths()` | hardcode `'.web-chat'` or call `os.homedir()` |
| find the project root (nearest `.web-chat` ancestor) | `core/paths` `findProjectRoot(dir)` | walk parent dirs yourself |
| read / write / discover a daemon portfile | `core/portfiles` `readPortfile` / `writePortfile` / `discoverPort` | read `server.json` by hand |
| check whether a daemon is alive / reachable | `core/portfiles` `probeReachable` / `probeHealth` | `http.request` a health check |
| wait for a daemon to come up / go away | `core/portfiles` `waitUntilReachable` / `waitUntilGone` | spin your own `readPortfile` loop |
| call the daemon over HTTP | `lib/client` `get` / `post` / `request` / `api` | `http.request` |
| subscribe to the SSE event stream | `lib/client` `subscribeSSE` | hand-roll SSE frame parsing |
| long-poll a wake condition (**driver only** — Claude wakes via the channel/queue) | `lib/driver` `waitFor` → `/api/wait` | `fetch /api/wait` + cursor bookkeeping by hand |
| notify the surface of a change (a WS frame + an event-log entry) | `core/bus` `emit({ event, ws, except })` | hand-pair `broadcast()` + `pushEvent()` |
| mount HTML/JS into a shadow-rooted pane + a local store | `public/mount-runtime.js` `createStore` / `attachAndExtract` / `runScripts` | re-implement `attachShadow` + `<script>` extraction + `new Function` |
| resolve a named on-disk resource across project/user/builtin tiers | `core/resources` `resourceRegistry({tiers, load, write})` → `get`/`list`/`save`/`dir` | hand-roll a `readdirSync` + tier-precedence walk |
| CORS on an extension-facing route | `core/cors` `setCors` / `mountCors` | copy the header block |
| escape HTML | `server/util/html` `escapeHtml` | inline a `.replace` chain |
| collapse whitespace in profile text | `capture/profiles/util` `collapse` | re-declare it |
| boot a server in a test | `test-support/helpers` `withServer(t, …)` | copy `tmpRoot`/`listen`/`stop` |

## The engines in detail

### `lib/core/paths.js` — the path authority

The **only** file that contains the `'.web-chat'` literal or an `os.homedir()`
call. Both builders are **pure** (no fs), so reading a path never has a side
effect.

- `projectPaths(root)` → `{ dir, serverJson, draft, graphDir, meta, captures,
  components, themesDir, theme, profiles, exports, version, managed, disabled,
  captureToken, serverLog, hookLog, PUBLIC_DIR, EXTENSIONS_DIR }`
- `userPaths()` → `{ root, disabled, sessionsDir, sessionFile(id), themesDir,
  theme, profiles, components, hubLog, instances, updateCheck }`
- `ensureProjectDirs(projectPaths(root))` — the explicit boot-time mkdir (the
  server calls it; nothing else needs to).
- `findProjectRoot(startDir)` / `resolveWebChatDir(startDir)` — root anchoring.

**Adding a new file under `.web-chat/`?** Add its key to `projectPaths`
(or `userPaths`) in this file — do not `path.join(root, '.web-chat', …)` anywhere
else. `lib/server/paths.js` (the `resolvePaths` UPPERCASE-key adapter) and
`lib/util/root.js` are thin compat shims over this; leave them, they keep their
importers unchanged.

### `lib/core/portfiles.js` — the portfile / discovery / probe engine

Everything about "is a daemon there and how do I find it." Role-based:

- `readPortfile(role, {root, checkLiveness})` — `role` is `'server'`
  (`<root>/.web-chat/server.json`); `server` is the only role-based portfile now
  (the hub folded into the registry in Phase 6). `checkLiveness` (default true)
  gates on a live pid.
- `writePortfile(role, {root, pid, port})` / `deletePortfile(role, {root})`
- `discoverPort({role, root, port, env})` — explicit port → `WEB_CHAT_PORT`
  (only when `env:true`) → portfile. **Don't pass `env:true` on a site that
  doesn't honor `WEB_CHAT_PORT` today** — that silently widens behavior.
- `probeReachable(port)` / `probeHealth(port)` / `probeHub(port)`
- `waitUntilReachable({role, root})` / `waitUntilGone({role, root})`
- `isPidAlive(pid)`, plus low-level `*At(webChatDir)` variants for callers that
  still hold a raw `.web-chat` dir (e.g. tests).

Portfile **formats** were unified in Phase 6: `hub.json` folded into the shared
registry (`~/.web-chat/instances.json`, owned by `lib/util/registry`) as a
`role:'hub'` entry, leaving `server.json` as the only role-based portfile here.
This engine also unifies the reading/discovery *code*.

### `lib/client/index.js` — the one daemon HTTP client

The single way to make an HTTP call to a web-chat daemon.

- `get(path, opts)` / `post(path, body, opts)` — throw on HTTP ≥ 400, one
  respawn-and-retry on connection-refused.
- `request(port, method, path, body, {headers, timeout})` — low-level; returns
  `{status, body}`, never throws on an HTTP status (for callers that inspect the
  status themselves, e.g. the CLI).
- `subscribeSSE({port, root, since, kinds, onEvent, onGap, onClose, onError})` —
  the live event stream. A long-lived stream, so it must **not** go through
  `request()` (which buffers to end).
- `probeReachable` / `probeHealth` (re-exported from `core/portfiles`),
  `discoverPort`, `ensureDaemon`, `NoServerError`.

Two policies are load-bearing — preserve them:

- **`spawn` defaults `false`.** Only `lib/mcp/client.js` (a spawn-injecting shim)
  opts in, so the 23 MCP tools + hooks keep auto-spawning a daemon; driver / hub /
  CLI must never resurrect a daemon the user closed. `opts.noSpawn` always wins.
- **No default socket timeout.** A driver's `/api/wait` long-poll (`lib/driver`
  `waitFor`) runs for up to `timeout_ms`; a blanket socket timeout would break it.
  `timeout` is opt-in. (Claude no longer long-polls — channels-only wake made
  `/api/wait` a driver-only endpoint.)

### `lib/core/bus.js` — the change bus

One engine for change-notification (Phase 2). The event ring (catch-up/history),
the SSE live tap, and the WS broadcaster are all fed by one `emit`. Every mutating
producer names BOTH its event entry and its WS frame(s) in a single call, so the
two can't drift — there is no projection layer between them to get out of sync.

- `emit({ event, ws, except })` — `event` (if given) becomes a ring entry (seq/ts
  assigned, spread last so a per-event `seq` can override) and fans out to
  subscribers; `ws` (a frame or an array of frames) broadcasts to sockets, skipping
  `except`. Order is event → WS. A **ws-only** emit (e.g. capture's legacy-clear)
  never enters the ring; an **event-only** emit (export) sends no frame.
- `read({ since, kinds })` — the ONE catch-up/gap impl, shared by `GET /api/events`
  and the SSE replay (`gap`/`dropped` computed off the **full** ring's oldest, so a
  kind filter never hides a gap).
- `subscribe(fn)` — the SSE live tap; returns unsubscribe. **This is the tap the
  channels bridge subscribes to** — it sees event entries, never WS-content, which
  is exactly what the bridge wants.
- `setBroadcaster(fn)` — `ws.js` late-binds its `broadcast(msg, except)` here so the
  bus never touches the socket set. `reset`/`hello` stay full-state snapshots in
  `ws.js` (they need live `mounts/store/active/lock/theme`) and never enter the ring;
  graph routes trigger `reset` via `broadcastReset`.

Never hand-pair a `broadcast()` + `pushEvent()` again — that pair *is* the drift the
bus removes. `test/bus-golden.test.js` freezes the whole wire (WS frames + event log)
as a byte-identity tripwire.

### `public/mount-runtime.js` — the one mount runtime

The shadow-root mount + local pub/sub contract, single-sourced (Phase 4). One
physical file, two delivery channels: the browser loads it as `/mount-runtime.js`
(before `client.js`); the server reads its **text** (`lib/server/runtime/
mount-runtime-src.js`, memoized) and splices it verbatim into the export + preview
docs. Three primitives, each consumer keeps its own outer shell:

- `createStore(seed, publish?)` — the store (`get`/`set`/`subscribe`, plus silent
  `replace`/`merge` the live client uses for full resets). `set` fires per-key then
  wildcard subscribers, then the optional `publish(patch, opts)` hook — the live
  client passes its ws-echo there; the frozen export/preview pass none.
- `attachAndExtract(host, html)` → `{ root, scripts }` — shadow root + inline-script
  extraction.
- `runScripts(root, scripts, store, params, mountId)` — **the one `new Function`
  site in the codebase** (the conventions tripwire enforces it).

Authored ES5-ish so a baked offline export runs in any browser, and with **no
script/style tag literal** (it's spliced unescaped inside a `<script>` — the
mount-runtime test guards this). It dual-exports (`window.__wcMount` in the browser,
`module.exports` in node) so `createStore` is unit-testable. The three consumers'
byte-identity is locked by a **source-identity tripwire** (the server splice, the
assembled export, and the preview doc must all `.includes(source())`), and the DOM
path is exercised under jsdom. **Dev caveat:** the server memoizes the text, so
editing it reflects in the browser on refresh but in export/preview only after a
restart.

### `lib/core/resources.js` — the tiered resource registry

A NARROW engine (Phase 5) for the directory-tier resolution that themes' named
library and components share. It owns only the shared skeleton — it knows nothing
type-specific (no tokens, no URL matching, no mount side-effects):

- `resourceRegistry({ name, tiers, builtins, load, file, write })` → `{ get, list,
  save, dir, tiers }`. `tiers` is `[{ tier, dir }]` most-specific-first (a `dir` of
  `undefined` is skipped); each type injects `load(path) → record | null` and
  `write(dir, name, payload)`.
- `get(name)` → `{ record, tier }` — first tier that has it, then in-code
  `builtins`, else null. `list()` — union across builtins + tiers, each tagged
  `tier` (a `load` that returns null is the uniform skip filter). `save(name,
  payload, { tier })` — mkdir the tier dir + injected write.
- Also exports `freshRequire(file)` — the one home for the cache-busting require
  idiom (profiles use it for hot-reload).

Adopters: **components** (full — and gained the `~/.web-chat/components` user tier),
**themes' named library** (list/get/save; the `resolveDefault` cascade + token
sanitization stay in `theme.js`). **Profiles do NOT** adopt the name-keyed API —
they select by URL and run executable bundles, which is not registry-shaped;
they only borrow `freshRequire`. Don't try to force a URL-matched or
cascade-resolved resource through `get(name)` — that's the leaky abstraction this
engine deliberately avoids.

### Shared small homes

- `lib/core/cors.js` — `setCors(req, res)`, `mountCors(app, path)` (the extension
  hits the instance server and the hub cross-origin).
- `lib/server/util/html.js` — `escapeHtml(s)` (null-safe).
- `lib/capture/profiles/util.js` — `collapse(s)`.

## The test harness — `test-support/helpers.js`

The one way to stand up a server in a test. Lives **outside `test/`** on purpose:
`node --test` runs every file under `test/`, and a test-less helper there would
count as a phantom passing test.

- `withServer(t, opts, fn)` — `createServer` + `server.listen(0)` on a fresh tmp
  root, with **idempotent teardown registered on `t.after`** so a failing
  assertion can't leak the port/handle. It never calls `start()` with a portfile,
  so no hub spawn and no `~/.web-chat` writes. Returns
  `{ api, port, root, webChatDir, ws, wsHello, graceful, stop, … }`.
  - `opts`: `{ root }` (reuse a root, for restart tests), `{ seed }` (write into
    `.web-chat` before boot), `{ mode:'start' }` (bind the real 5173+ range —
    port-walk only), `{ writePortfile:true }` (watch discovery).
- `withTempHome(t)` — redirect `HOME`/`USERPROFILE` to a throwaway dir so
  `os.homedir()`-based tiers (theme system scope, toggle user/session) don't touch
  the dev machine.
- `tmpRoot`, `makeApi(baseUrl)`, `wsConnect`, `wsHello`, `safeStop`.

Run the suite with bare `node --test` (auto-discovers `test/`). Not `node --test
test/` — that mis-resolves.

## The conventions tripwire

`test/conventions.test.js` is the automated half of the one-engine rule. It walks
`lib/` (+ `public/` for `new Function`) and holds a **per-file baseline** of three
banned constructs, then **ratchets**:

- **New / grown occurrence → fail.** You added `http.request(` /`os.homedir()` /
  `new Function('…')` somewhere new — route it through the engine instead.
- **Removed occurrence → fail as a STALE baseline.** A consolidation dropped a
  count below its baseline; lower the number here in the same PR. The ceiling can
  only ever move toward zero-outside-the-home.

Current homes (baselines can only shrink toward these):

| Construct | Allowed home | Phase that finishes the collapse |
| --- | --- | --- |
| `http.request(` | `lib/client/index.js` (+ `lib/core/portfiles.js` for the two probes — core can't import the client) | Phase 1 ✅ |
| `os.homedir()` | `lib/core/paths.js` | Phase 1 ✅ |
| `new Function('…')` | `public/mount-runtime.js` (the one mount-runtime source) | Phase 4 ✅ |

Working with it:

- **Legitimately need a banned construct in a new place?** That almost always
  means you should call the engine. If it's genuinely unavoidable, raise that
  file's baseline with a justifying comment — and expect review pushback.
- **The tripwire counts raw substrings, comments included.** Writing
  `os.homedir()` in a comment inflates the count. Reword the comment.
- **Adding a new duplication-prone primitive?** Add a fourth pattern to
  `PATTERNS` in `conventions.test.js` with today's occurrences as its baseline, so
  the next copy fails.

## When you genuinely need a *new* engine

Every planned consolidation has shipped — the current engines are below.

(Shipped: **process registry + versions** → `lib/util/registry.js` (the hub is a
`role:'hub'` entry alongside instances) + `lib/core/versions.js` (the three
version facts: `packageVersion`, `SCHEMA_VERSION`, `PROTOCOL_VERSION` +
`isProtocolCurrent`) (Phase 6). Register a running process with
`registerInstance`/`registerHub`; read it with `readInstances`/`readHubEntry`.
`_version.json` has one writer — the migration runner. Don't stamp a version or
add a second "who's running where" file by hand.)

(Shipped: **tiered named resources** → `lib/core/resources.js` (Phase 5), a
NARROW engine — components + themes' named library adopt it; profiles keep their
URL-matching selection and only borrow its `freshRequire`.)

(Shipped: **turn lock + commit** → `lib/server/domain/turns.js` (Phase 3);
**mount runtime** → `public/mount-runtime.js` (Phase 4). Use those, don't hand-roll.)

If you need a mechanism that doesn't have an engine and isn't a scheduled phase:
build it in `lib/core/` (if it's a zero-dependency primitive) or the appropriate
domain module, consume it from your feature, and — if it's the kind of thing that
gets copied — add it to the tripwire. Don't hand-roll the second copy.
