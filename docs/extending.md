# Extending web-chat — use the engines, don't bolt on

This doc describes the extension *engines that exist today* and the one rule that
keeps them singular.

## Working on the package

```sh
git clone https://github.com/Brynhild-CHale/claude-web-chat.git
cd claude-web-chat
npm install
node bin/claude-web-chat.js help    # run it straight out of the checkout
```

Run the suite with `npm test` — that is `node --test --test-timeout=60000 --import ./test-support/sandbox.js`,
which auto-discovers `test/`; **not** `node --test test/`, which mis-resolves and
reports a spurious failure. The timeout is load-bearing: without it one leaked
handle or never-settling await hangs the whole run indefinitely. Do not add
`--test-force-exit` — it would turn that hang into a silent pass.

**Do not use `npm link`.** npm's global prefix is a shared mutable directory: any
later `npm i -g` of anything rewrites what lives there, and that is not
hypothetical — it silently replaced this package's link to a dev checkout with a
copied build from 16 days earlier. The checkout's tests stayed green while the
`claude-web-chat` on PATH was ancient, and the first symptom was `unknown
command` for a command written that morning. Releases now install into
`~/.web-chat/versions/<v>/` with `~/.local/bin` symlinks, and nothing but this
program writes there.

To put a checkout on your PATH, link it yourself and know what you are doing:

```sh
ln -sf "$(pwd)/bin/claude-web-chat.js"      ~/.local/bin/claude-web-chat
ln -sf "$(pwd)/bin/claude-web-chat-mcp.js"  ~/.local/bin/claude-web-chat-mcp
ln -sf "$(pwd)/bin/claude-web-chat-hook.js" ~/.local/bin/claude-web-chat-hook
```

That *shadows* any installed release (the release's own links live at the same
three paths). `claude-web-chat version` always prints which tree it is running
from, what `~/.web-chat/current` points at, and what the command on your PATH
resolves to — check it whenever behaviour and source disagree. `claude-web-chat
update` refuses outright on a checkout: a checkout is updated with `git pull`,
and rewriting `~/.web-chat/versions/` would change nothing you actually run.
Re-run `install.sh` to put the release links back.

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
entry points       cli/* · mcp/* · hooks/* · driver.js · hub/* · server/*
                         │  import ↓ only      (never each other)
shared libraries   util/* · toggle/* · update/* · setup/* · packs/* · capture/* ·
                   channel/*
                         │  import ↓ only      (may import each OTHER — that is
                         │                      composition, not direction)
lib/client/        the one daemon HTTP client
                         │  import ↓ only
lib/core/          paths · portfiles · bus · names · fsjson · html · versions · cors ·
                   channels · resources · mcp-seen   (zero deps on the rest of lib/)
```

- `lib/core/*` imports **nothing** from `lib/` except other `core/` modules
  (`portfiles` → `paths`). It is the leaf. In particular **core must not import
  `lib/client`** — that's why the two liveness probes live in `core/portfiles`,
  not in the client.
- `lib/client` imports `core/*` (+ `util/daemon`). Everything else imports
  `lib/client` and `core/*`; entry points never reach into each other's internals.
- A **shared library** implements one concern and is consumed by the entry
  points. It may import another shared library (`lib/packs` uses `lib/update`'s
  archive reader); it may never import an entry point.
- A helper that seems to belong in two layers belongs in the lower one.

**`test/dependency-direction.test.js` enforces this.** It parses every relative
`require()` under `lib/`, maps it to an edge between two subsystems, and fails
any edge the direction forbids — a `core` or `client` reach outward, an entry
point importing another entry point, a shared library importing an entry point.
The edges that legitimately remain are listed in a `BASELINE` in that file, each
with the reason it is allowed, and the baseline is **shrink-only**: an entry that
no longer matches fails as stale, so a consolidation tightens the rule in the
same PR. One entry is marked `OWED` — `lib/packs` still reaches into
`lib/server` for the components registry (the reserved-name list now lives in
`lib/core/names.js`).

The rule was a paragraph until then, and a paragraph is one lazy `require` away
from being wrong. It already was, in four places, and every one of them was the
same mistake: a *generic leaf helper parked above the leaf layer*. `lib/packs`
imported the **updater** for a path predicate and the **server** for a path
adapter; `lib/capture` imported the **server** for an HTML escaper. Nobody meant
to couple those subsystems — they wanted `isInside` and `escapeHtml`, and those
were the only places they lived.

## The engines — need X, use Y

| You need to… | Use | Never |
| --- | --- | --- |
| resolve a path under `.web-chat/` or `~/.web-chat/` | `core/paths` `projectPaths(root)` / `userPaths()` | hardcode `'.web-chat'` or call `os.homedir()` |
| resolve a path under `.claude/` (settings, rules, skills) | `core/paths` `claudePaths(root)` / `userClaudePaths()` | hardcode `'.claude'` |
| find the project root (nearest `.web-chat` ancestor) | `core/paths` `findProjectRoot(dir)` | walk parent dirs yourself |
| ask whether a path is inside a directory (a fence) | `core/paths` `isInside(parent, child)` / `realpath(p)` | `startsWith` / `path.relative` containment by hand |
| fence a path you were HANDED (a store value, a form field), incl. one about to be created | `core/paths` `fence(parent, child)` → abs \| null (services get it as `ctx.fence`) | a lexical `path.relative` check that a symlink walks straight out of |
| read / write / discover a daemon portfile | `core/portfiles` `readPortfile` / `writePortfile` / `discoverPort` | read `server.json` by hand |
| check whether a daemon is alive / reachable | `core/portfiles` `probeReachable` / `probeHealth` | `http.request` a health check |
| wait for a daemon to come up / go away | `core/portfiles` `waitUntilReachable` / `waitUntilGone` | spin your own `readPortfile` loop |
| ask whether a pid is alive | `core/portfiles` `isPidAlive(pid)` | `try { process.kill(pid, 0) }` inline (the type guard is the point) |
| remove a daemon's records on the way out | `lib/util/registry` `release({root, pid})` | `deletePortfile` and `deregisterInstance` separately, or either one unguarded |
| list every surface on this machine, classified | `lib/util/registry` `rows({probe, timeoutMs})` → `{…entry, pid_alive, reachable}` | read the registry and re-derive liveness per caller |
| stop (or clear) another project's surface | `lib/cli/reap` `reap(rows, {here, log})` / `stopRow(row)` | signal a pid out of a file, or delete a record you did not confirm is dead |
| call the daemon over HTTP | `lib/client` `get` / `post` / `request` / `api` | `http.request` |
| subscribe to the SSE event stream | `lib/client` `subscribeSSE` | hand-roll SSE frame parsing |
| long-poll a wake condition (**driver only** — Claude wakes via the channel/queue) | `lib/driver` `waitFor` → `/api/wait` | `fetch /api/wait` + cursor bookkeeping by hand |
| write a small JSON record durably | `core/fsjson` `writeJsonAtomic(file, value, {pretty, newline, mkdir, fsync})` | `writeFileSync(JSON.stringify(…))`, or a private temp-file + `renameSync` |
| read one back, telling absent from torn from wrong-shaped | `core/fsjson` `readJson(file, {validate})` → `ok`/`absent`/`corrupt`/`invalid` (or `readJsonOr(file, fallback)`) | `try { JSON.parse(readFileSync(…)) } catch { return <one value> }` |
| keep a record you could not read | `core/fsjson` `renameAside(file, {tag, keep})` | `unlinkSync` it |
| notify the surface of a change (a WS frame + an event-log entry) | `core/bus` `emit({ event, ws, except })` | hand-pair `broadcast()` + `pushEvent()` |
| put a pane on the live surface, or take one off | `lib/server/domain/mounts` `setMount` / `removeMount` / `emitMount` | hand-write `state.mounts.set(…)` plus a render frame, or a delete plus a clear frame |
| mount HTML/JS into a shadow-rooted pane + a local store | `public/mount-runtime.js` `createStore` / `attachAndExtract` / `runScripts` | re-implement `attachShadow` + `<script>` extraction + `new Function` |
| resolve a named on-disk resource across project/user/builtin tiers | `core/resources` `resourceRegistry({tiers, load, write})` → `get`/`list`/`save`/`dir` | hand-roll a `readdirSync` + tier-precedence walk |
| decide who may reach this server (bind host, `Host` gate, WS `Origin` gate, extension CORS, the preview document's CSP) | `core/cors` `LISTEN_HOST` / `requireLocalHost` / `isLocalHost` / `verifyUpgrade` / `isLocalOrigin` / `isBrowserRequest` / `setCors` / `mountCors` / `PREVIEW_CSP` / `warnIfExposed` | hardcode `127.0.0.1`, re-derive "is this local", read `req.headers.host` by hand, or copy the header block |
| escape HTML (host) | `core/html` `escapeHtml(s)` | inline a `.replace` chain or a `{'&':'&amp;'}` map |
| sanitise or render `--wc-*` design tokens | `lib/server/theme` `sanitizeTokens(tokens)` / `tokenDecls(tokens, indent)` | re-declare `TOKEN_RE` or strip your own character set |
| collapse whitespace in profile text | `capture/profiles/util` `collapse` | re-declare it |
| resolve + scheme-gate an href/src read out of a captured page | `capture/profiles/util` `safeHref(href, pageUrl)` | `new URL` plus your own `javascript:` regex |
| render a capture pane (default reduce, mode wrapper, reader view, feedback card) | `capture/pane` `renderProfilePane` / `renderSimplifiedPane` / `defaultReduce` | import them from `lib/server/routes/capture` |
| read, validate and require a capture-profile bundle | `capture/profiles` `loadBundle(dir)` / `validateMeta(meta)` | a second reader of `profile.json` with its own acceptance rules |
| hand a capture profile a helper (`esc`, `collapse`, `safeHref`, `absolutize`) | the injected extract/pane ctx — `CTX_HELPERS` in `capture/profiles` | declare one inside the bundle (it cannot import, so a copy is the only alternative) |
| unpack, list or find the root of a `.tar.gz` | `lib/update/archive` `extractTarGz` / `rootOf` / `listTarGz` | a second `spawnSync('tar')` |
| decide whether version A is newer than B | `core/versions` `compareVersions` | a third dotted-number comparator |
| gate on the supported Node version | `core/versions` `NODE_FLOOR` / `checkNodeFloor(v)` | write the major version into a comparison |
| name the repo, or build a github.com / raw.githubusercontent URL | `core/versions` `REPO_SLUG` / `REPO_URL` / `RELEASES_PAGE` / `DOCS_URL` / `INSTALL_SH_URL` / `releaseTagUrl(tag)` | paste the slug into a string |
| decide which project a command operates on | `lib/setup/registration` `resolveRoot(cwd, {mode})` → `{root, movedUp}` | `process.cwd()`, or your own `findProjectRoot(cwd) || cwd` per command |
| read what is registered with Claude Code here (hooks per event, the `.mcp.json` entry, managed-file drift, gitignore) | `lib/setup/registration` `inspect(root)` | count hooks yourself, or classify the MCP entry a second way |
| register a project, or un-register one | `lib/setup/registration` `apply(root, {force, dryRun, runClaude})` / `remove(root, {runClaude})` | call `ensureHooks` + `reconcileManagedFiles` + `ensureMcpRegistration` in your own order, with your own stub policy |
| build the `claude mcp add`/`remove` argv | `lib/setup/registration` `mcpArgv()` / `removeArgv()` | `path.join(__dirname, …, 'bin')` (that is the version dir, which gets pruned) |
| name the hook events registration means | `lib/setup/registration` `hookEvents()` | iterate whatever `settings.hooks` happens to hold |
| say what a managed-file conflict means and how it ends, incl. the reminder an unmerged `.new` leaves | `lib/update/managed-files` `conflictAdvice(results)` / `conflictSummary(results)` | a fifth wording of "review and merge, then re-run install" (the step that resolves one is: merge, then delete the `.new`) |
| fetch / validate / plan / install a component pack | `lib/packs/*` (`installPack`, `quarantinePack`, `removePackByName`, …) | a second install path beside the CLI's |
| decide whether a name may become a component directory (kebab grammar + reserved builtins) | `core/names` `assertComponentName` / `isComponentName` / `BUILTIN_COMPONENTS` | re-declare `/^[a-z][a-z0-9-]*$/`, or re-list the builtin names |
| ask the user a question in the terminal | `lib/cli/prompt` `createPrompt({log, yes, noInput})` → `confirm`/`line`/`close` | `require('node:readline')` at a call site, or gate on `process.stdin.isTTY` yourself |
| read or write a browser storage key from the chrome | `public/app/storage.js` `getLocal` / `setLocal` / `getSession` / `getLocalJson` — every one fails open | touch `localStorage` / `sessionStorage` directly: the accessor itself throws in a private window and takes the whole module graph down with it |
| leave the detached node preview | `public/app/topbar.js` `leavePreview({activeId, restoreSnapshot, flushForms})` | hand-copy `previewing = false` + drop the snapshot + un-gate `#main` (it reached eight copies) |
| walk the graph AS DRAWN — nav, fork glyphs, lineage, layout, counts | `public/app/graph-view.js` `graphIndex()` (memoized) / `displayChildrenOf(id)` / `displayParentOf(id)` — the ↑/↓ pair reads both, so they stay inverses | `labels.childrenOf`, which is the RAW commit topology and has one consumer by design: the ⑃ branch picker |
| dismiss a transient chrome panel | `public/app/shell.js` — give the element `.popover` and let `closeAllPopovers` / `handleEscape` own it | a private outside-click listener or a second document-level Escape handler |
| boot a server in a test | `test-support/helpers` `withServer(t, …)` | copy `tmpRoot`/`listen`/`stop` |
| boot the capture hub in a test | `test-support/helpers` `withHub(t, {port})` | `createHub` + `server.listen` in the test body |
| wait for a condition in a test | `test-support/helpers` `waitUntil(pred, {timeout, interval, what})` | a private `waitFor`/`until` loop, or a fixed sleep as synchronisation |
| open an SSE stream in a test | `test-support/helpers` `openSSE(port, {kinds, since, onEvent, awaitChannel})` | `subscribeSSE` with only `onOpen` (it can never reject) |

## The engines in detail

### `lib/core/paths.js` — the path authority

The only file that **builds** a `.web-chat` path or calls `os.homedir()` (one
other file compares a single path segment against `'.web-chat'`; nothing else
joins one). Both builders are **pure** (no fs), so reading a path never has a
side effect.

- `projectPaths(root)` / `userPaths()` — **see the return object in the source.**
  The key sets are deliberately not copied here: an enumeration in prose falls
  behind the moment a feature adds a file, and this one did (it predated the
  packs and services keys).
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
- `writePortfile(role, {root, pid, port})` / `deletePortfile(role, {root, pid})` —
  the delete carries an **ownership rule**, and `pid` is tri-state: omitted =
  unguarded (legacy), a number = "mine, unless a different live process has since
  claimed it", `null` = "I own nothing; reap only if the process it names is
  gone". Two daemons can share one root, and the one that leaves must not tear
  down the record of the one that stayed. `lib/util/registry.release({root, pid})`
  applies the same rule to BOTH records at once — call that from a shutdown path,
  not this one.
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

### `lib/core/fsjson.js` — the durable-JSON-record engine

The small JSON records under `.web-chat/` and `~/.web-chat/` — graph node files,
`graph/_meta.json`, `draft.json`, `_version.json`, `instances.json`, `packs.json`
— written so a crash cannot tear one, and read so a torn one is distinguishable
from a missing one.

- `writeJsonAtomic(file, value, { pretty = 2, newline = false, mkdir = true,
  fsync = false })` — serialize, write `${file}.${pid}.tmp` **in the same
  directory**, `renameSync` onto the destination. Returns the path; **throws** on
  failure, because the callers legitimately disagree about what to do with one
  (`writeNode` lets the route 500, `writeDraft` returns false, `recordMcpSeen`
  ignores it). `newline` defaults off so adopting the engine never rewrites the
  bytes of a record that had no trailing newline.
- `readJson(file, { validate })` → exactly one of `{ok, value}` / `{absent}` /
  `{corrupt, error}` / `{invalid, error, value}`. Not `existsSync`-then-read —
  that is a TOCTOU; the ENOENT branch *is* the check.
- `readJsonOr(file, fallback, { validate })` — the shape most readers want. The
  fallback covers `corrupt` too, which is right both for the fail-CLOSED readers
  (a torn trust store must read as "nothing trusted") and the documented
  fail-soft ones.
- `renameAside(file, { tag = 'corrupt', keep = 0 })` — move a record you could
  not use out of the way instead of destroying it; `keep` caps how many such
  files accumulate.

Two rules the engine deliberately keeps:

- **No type-specific knowledge.** Shape predicates are passed in as `validate`
  and live next to the type's owner (`isGraphNode` sits beside `graph.load`) —
  the same boundary `core/resources.js` draws.
- **`invalid` is a returned state, never a throw and never a silent skip.** The
  callers want three different things from it: `graph.load` skips the node,
  `components-registry` surfaces a placeholder record, `seedBuiltins` repairs the
  directory from the shipped copy.

Out of scope: cross-filesystem moves (the temp file is always a sibling, so
`renameSync` cannot hit `EXDEV`), append-only logs (`packs`' NDJSON audit trail
stays on `appendFileSync` — a torn *line* is recoverable, a torn rewrite of the
whole log is not), and read-modify-write races. Atomic rename makes each write
whole; it does not serialize two writers. `doctor`'s out-of-process `_meta.json`
repair says so in place.

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
- `runScripts(root, scripts, store, params, mountId)` — one of the two dynamic-eval
  sites in this file, which is **the only file that has any** (the other is
  `runSeed`, which derives an AsyncFunction for a component's `seed.js`). The
  conventions tripwire enforces both spellings.

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

### `lib/core/cors.js` — the local network trust boundary

Everything web-chat serves is unauthenticated by design — the graph, the shared
store, arbitrary HTML/JS injection through `/api/render`. So "who may reach this
server" is a single security decision, and it lives in one zero-import leaf
module. Facts that must never drift apart:

- `LISTEN_HOST` — what the instance server and the hub bind. `127.0.0.1` unless
  `WEB_CHAT_HOST` says otherwise; `warnIfExposed()` prints the consequences of
  that override on startup. Never write a bind address anywhere else, and never
  bind a wildcard "for convenience" — a loopback bind is the access control.
- `isLocalHost(host)` / `requireLocalHost` / `verifyUpgrade` — is the NAME the
  client dialled one we answer to. A loopback bind stops a remote packet but not
  a page whose DNS is rebound to `127.0.0.1`: that fetch is *same-origin*, so it
  carries no `Origin` and none of the rules below ever fire. `Host` is the header
  that still tells the truth and the one page script cannot forge. Mounted as the
  **first** middleware on both apps (above `express.json`, so a rebound POST is
  refused before a 200mb body is parsed) and folded into the WS upgrade as
  `verifyUpgrade`, which never sees `app.use`. A single non-loopback
  `WEB_CHAT_HOST` is accepted alongside loopback; a wildcard bind skips the check
  entirely, because no name is then distinguishable from any other.
- `isLocalOrigin(origin)` — is a browser `Origin` one of this machine's own
  surfaces. Gates the WS upgrade (`verifyClient` in `lib/server/ws.js`), because
  browsers apply no same-origin policy to WebSocket connects and the `hello`
  frame is an unconditional full-state disclosure. An **absent** origin is not
  decided here: the caller allows it, since a non-browser client (driver, CLI,
  test) already has filesystem access to everything.
- `isBrowserRequest(headers)` — is this a browser at all, ours or anyone's. The
  gate for an endpoint whose damage is done by the *request* rather than the
  reply, where CORS is no defence: `POST /api/shutdown` and the disk-writing
  `GET /api/export/:ref?format=file`. Fails closed — Node's global `fetch` sends
  `Sec-Fetch-*` and is refused too; local tooling reaches these through
  `lib/client`.
- `setCors(req, res)` / `mountCors(app, path)` — the extension-facing headers.
  The allowed set is narrow on purpose (extension schemes + this machine); it
  used to reflect any `Origin`, which made every capture readable by any site the
  user happened to be browsing.
- `PREVIEW_CSP` — what the `/preview/node` document may reach. The graph viewer
  runs one of those documents per visible node thumbnail, executing historical
  pane scripts unattended against the live daemon, so `connect-src 'none'` is the
  load-bearing directive. `'unsafe-eval'` is required, not sloppy: the spliced
  mount runtime executes pane bodies through `new Function`.

`LOOPBACK` is the literal address web-chat's own clients dial — deliberately not
the name `localhost`, which resolves to both `::1` and `127.0.0.1` on a
dual-stack machine.

### `lib/packs/` — the component-pack pipeline

A pack is a git repository that installs as components **plus a Claude skill**.
The skill is the reason the format exists: `list_components` is a *pull* (Claude
learns a component exists only if it calls the tool), while a skill's frontmatter
description sits in context from session start.

One direction, one module per step, no step reaching backwards:

```
source.js    parse a URL → { owner, repo, apiBase }; resolve a ref → a commit sha
   ↓
fetch.js     download (release+SHA256SUMS, else the sha-pinned archive) → verify
             → stage into mkdtemp; refuse hostile archive members on OUR terms
   ↓
manifest.js  parse + validate web-chat-pack.json; read SKILL.md frontmatter
   ↓
plan.js      planInstall() → { units, collisions, services, errors }  — PURE
   ↓
tree.js      applyPlan / removeUnits / verifyPack / stage+promote quarantine
             — plus beginJournal (the undo list) and droppedUnits (the diff)
   ↓
install.js   orchestrate, write the provenance record, append the audit line
```

`plan.js` writes nothing, deliberately: the same function serves the install, the
`review` output, and the drawer's quarantine card, so "show me what this would
do" cannot drift from what it actually does.

Five invariants live in code rather than in a reviewer's memory:

- **An install is one transaction.** Pack units land FLAT in shared tier
  directories, so there is no directory to rename over the way `installRelease`
  and `symlinkAtomic` do — the reversibility has to be an undo list instead.
  `beginJournal({ backupDir })` records every creation, copies every file it is
  about to overwrite into `projectPaths(root).packsBackup`, and remembers every
  directory the apply had to create; any throw unwinds in reverse and rethrows.
  `installFromStage` writes a `pending` marker (its own file, never `packs.json`)
  before the first byte and clears it after the record, so a half-install is
  discoverable without being mistaken for an installed one. A same-pack
  re-install diffs the previous record against the plan (`droppedUnits`, pure)
  and routes the difference through `removeUnits` — under the same edited-file
  rule — *after* a successful apply. `lib/packs/install.js` and
  `lib/packs/plan.js` are held at zero `copyFileSync`/`unlinkSync`/`rmSync` by
  the conventions tripwire, so a second apply path cannot grow beside the
  journalled one.

- **`tar` is not the security boundary — the copier is.** Members are listed
  (`archive.listTarGz`, pure JS) and refused before extraction: absolute paths,
  any `..` segment, anything that is not a regular file or a directory. BSD tar
  errors on a `..` member and GNU tar has historically stripped it; "refused" vs
  "silently renamed" is exactly the distinction that matters, so it is ours to
  make. The staged tree is then walked again and modes normalized.
- **The integrity anchor is the commit sha, never the tarball digest.** GitHub
  archive tarballs are not byte-stable. `tarball_sha256` is recorded as an
  observed fact and never compared.
- **A builtin component name is a hard refusal.** No override, either tier,
  either actor — because `seedBuiltins` only repairs a directory whose
  `meta.json` says `builtin: true`, so a shadowing pack would win permanently.
  The list and the grammar both live in `lib/core/names.js`, and the refusal is
  asserted at every writer (`POST /api/components`, `componentsRegistry.write`,
  `validateManifest`, `planInstall`), not just in the packs pipeline.
- **The installed record is untrusted input.** `.web-chat/packs.json` is
  project-tier and a repository can commit a `.web-chat/` tree — the reason
  quarantine records were moved to the user tier. Every path `removeUnits`
  unlinks is built from that record, so `verifyPack` validates it at READ time:
  kebab-case unit name, `memberEscapes` on every recorded path, and
  `isInside` for any recorded file that exists. A unit that fails is `refused`
  whole — nothing unlinked, counted as drift, kept in the record.

`lib/server/routes/packs.js` and `lib/cli/commands/pack.js` are both thin over
`install.js`. **Read the risk paragraph at the head of the route file before
changing it**: the install endpoint is reachable by any pane script and cannot
tell a pane's `fetch` from a user's click. `--replace`, and removing a pack you
have edited, are therefore terminal-only.

### `lib/core/names.js` — what may become a component directory

A component name is not decoration: it **becomes a directory**. Every writer
joins it to a tier dir, and every reader joins it again to reach
`component.html` / `seed.js` / `service.js`. Two rules govern it, and they are
declared once, here:

- **The grammar**, `COMPONENT_NAME_RE = /^[a-z][a-z0-9-]*$/`. A containment rule
  wearing a style rule's clothes — a name that cannot carry a separator cannot
  leave its parent. `test/conventions.test.js` ratchets this literal to this file.
- **The reserved list**, `BUILTIN_COMPONENTS`. The six builtins, refused in either
  tier for either actor with no override, because `seedBuiltins` only repairs a
  directory whose `meta.json` says `builtin: true`.

`assertComponentName(name, { what, reserved })` throws a `userFacing` error
carrying `code: 'name-invalid' | 'name-reserved'`, so each caller maps one
refusal onto its own wire shape without re-deciding what is legal:
`POST /api/components` answers 400 for the first and 200 `{ok:false, reserved,
hint}` for the second (the drawer and `save_component` read `.ok`, not the
status), the packs route uses its `reject()` envelope, the CLI lets it throw.
`isComponentName` is the non-throwing half, for `validateManifest`, which
collects every problem instead of stopping at the first.

The list lives in **core**, not `lib/server`, because `lib/packs` needs it too and
`lib/packs → lib/server` is backwards; `lib/server/builtins.js` re-exports it as
`BUILTINS` and keeps `seedBuiltins`. Pack names share the grammar but **not** the
reserved list (a pack is checked against reserved *skill* names, derived from
`lib/update/managed-files`, which core must not import) — which is why
`reserved` is an explicit argument rather than an assumption.

Two checks deliberately stay outside the engine: `planInstall` refuses when the
destination's `meta.json` already says `builtin: true` (an fs check, not a name
check), and `verifyPack` re-validates a *recorded* unit name at read time,
skipping rather than throwing so `pack remove` over a damaged record degrades.

### `lib/setup/registration.js` — the project-registration model

What it means for a project to be **registered with Claude Code**: which root a
command operates on, the hook events from `templates/settings.hooks.json`, the
`.mcp.json` entry and its `${CLAUDE_PLUGIN_ROOT}` policy, the managed files and
their baselines, the `.gitignore` line. Four functions:

- **`resolveRoot(cwd, {mode})`** → `{root, from, source, movedUp}`. One answer
  where there were five. `'existing'` requires an installed root at or above
  `cwd` and throws a `userFacing` refusal naming `claude-web-chat init` (`on`,
  `off`); `'install'` falls back to `cwd` when there is none (`install`,
  `uninstall`, `doctor`, `status`, the MCP dispatcher); `'optional'` returns
  `root: null` for a caller with nothing to do outside a project (`update`).
  All three inherit `findProjectRoot`'s `$HOME` refusal.
- **`inspect(root)`** — pure read: `installed`, `hooks` per event
  (`ok` / `bare` / `missing`), `mcp` (`present`, `kind`, `resolvable`, `reason`,
  `channelEnv`), `managed` (the dry-run reconcile), `gitignore`. `doctor`,
  `status` and the MCP dispatcher all report from this one read, so they cannot
  disagree about the same project.
- **`apply(root, {force, dryRun, runClaude})`** — hooks + managed files +
  `.gitignore` + the MCP registration, under **one** stub policy: a committed
  `${CLAUDE_PLUGIN_ROOT}` entry is never rewritten, and when it cannot resolve
  here the registration is completed with `claude mcp add --scope local`.
- **`remove(root, {runClaude})`** — the hook handlers for `hookEvents()` only,
  the managed files, their `.new` sidecars and baselines, the `.mcp.json` entry,
  and the local-scope registration `apply`/`doctor` may have written.

Two asymmetries are deliberate, and stated in the module header: `apply()` is
**not** the whole of `install` (creating `.web-chat/`, running the migrations and
pre-warming the daemon stay in the command, so `doctor`'s repair never forks a
server), and `remove()` is **not** the inverse of `apply()` (`.web-chat/` holds
the graph and is preserved; the daemon is not stopped).

`isInstalled(root)` is the cheap half of `inspect` — one `existsSync` — because
the MCP dispatcher asks "is web-chat installed here?" on every tool call in a
disabled project, and `inspect().installed` is defined as it.

**`runClaude(argv, {cwd})` always takes the resolved root.** `claude mcp
add|remove … --scope local` registers the directory `claude` runs in, so a
shell-out from `process.cwd()` would be a second, implicit root derivation
inside the one module that exists to have exactly one: `install` in a
subdirectory would adopt the parent root and then register the subdirectory,
and `uninstall` would leave the local-scope entry it exists to remove. The three
call sites (`apply`, `remove`, `doctor`) all pass `{cwd: root}`; a fake in a test
must record it, not just the argv. `update` deliberately passes a `runClaude`
that **records and prints** rather than runs — an upgrade syncs project files
and does not mutate Claude Code's own config behind the user's back.

It sits **above** `lib/update/managed-files`, which keeps every export: that is
where the primitives live, and `lib/packs` imports two of them — a pack installer
must not become a dependent of a CLI-registration module. And it imports no entry
point, which is why the `claude` shell-out is an injectable `runClaude` rather
than something reached for from `lib/cli`. The hook template has one reader,
`managed-files.hookTemplate()` — `ensureHooks` merges its handlers, `hookEvents()`
takes `Object.keys` off it — and the wording for a managed-file **conflict** has
one home too, `managed-files.conflictAdvice()` / `conflictSummary()`, which
`install`, `update`, `init` and `status` all print.

`inspect().managed` rows carry that conflict's whole state machine, and it is
worth knowing which end of it you are reading. The baseline in
`.web-chat/managed.json` is **the shipped bytes a file was last reconciled
against — applied or merely offered**, so announcing a conflict records the
offer: the next run sees `shipped === baseline` and a hand merge settles as
`kept-edited` rather than re-announcing itself forever. A real template change
moves `shipped` off that baseline and fires a fresh conflict. The outstanding
offer is tracked on the **filesystem**, not in JSON: while `<dest>.new` sits
beside a file that still differs from shipped, the row carries `pending: true`,
and deleting the sidecar is the entire resolution ritual. Consumers therefore
have two questions to answer, not one — "is this a fresh conflict?" and "is
there an offer still open?" — and each one states its answer in a comment
(`status`/`init` report both; the MCP startup nudge reports only the first,
because it tells the user to run `install` and `install` cannot merge for them).

`update` loads this module out of `versions/<target>` (the same reason
`loadRestart` exists), so **the export surface is a cross-version contract**:
keep it small and additive, and keep the fallback in `loadRegistration` loud.
test/release-build.test.js pins both halves of that contract — the path and the
`apply` export in the tree, and `lib/setup/registration.js` in the release
artifact — so a rename fails the build instead of the updaters already shipped.

### Shared small homes

- `lib/core/html.js` — `escapeHtml(s)`. Null-safe; escapes all five characters
  (`& < > " '`) because the result lands in an attribute value as often as in a
  text node, and an escaper that is only safe in one of those positions is a
  trap. There is deliberately **no** fewer-characters mode: the only reason to
  want one is byte-preservation for a producer whose output is compared, and
  nothing in the tree is in that position — add it then, named for what it
  omits, with its caller in the same PR. `lib/server/util/html.js` re-exports it
  for the server routes that already import it from there.
  **The client has its own home**, `public/app/esc.js` (same five characters) —
  the chrome cannot `require` out of `lib/`. **Capture profiles have neither**:
  the loader reads user-authored profiles from `.web-chat/profiles/`, which
  cannot import the package, so the eight bundled profiles still carry a
  four-character copy each. Both spellings of a hand-rolled escaper — the
  `.replace` chain and the `{'&':'&amp;'}` lookup map — are pinned by
  `test/conventions.test.js`, and those eight are the whole grandfathered list.
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
  - `opts` also takes `{ createServer }` — an injected module, for a test that
    busts `require.cache` (lock-ttl re-reads `WEB_CHAT_LOCK_TTL_MS` at module
    load). `withServer` resolves `createServer` **lazily**; it used to bind it at
    require time, which meant such a test silently booted the stale module.
- `withHub(t, { port })` — the same for the capture hub: `createHub` + a
  `LISTEN_HOST` bind + idempotent `t.after` stop. Returns `{ hub, server, port,
  baseUrl, api, stop }`. Four boots used to be hand-rolled with the stop at the
  end of the test body.
- `waitUntil(pred, { timeout = 2000, interval = 25, what })` — **the** deadline
  poll. Awaits the predicate, resolves with the **first truthy value** (not
  `true`, so a caller can read a nonce or a pid straight out), re-evaluates once
  after the deadline, and on failure throws ``timed out waiting for `what` `` when
  `what` is given, else returns `false` (which is what keeps
  `assert.ok(await waitUntil(…), 'message')` reporting its own message). Nine
  files carried a private copy under four names and three incompatible timeout
  contracts. Binding a longer budget onto it for a file that waits on child
  processes is fine; writing a second loop is not.
- `openSSE(port, { kinds, since, onEvent, timeout = 5000, awaitChannel })` — the
  one stream opener, and the only one that can **fail**: it rejects on `onError`,
  on a close before open, and on the deadline. The three private openers passed
  `onOpen` alone, so a non-200 or a request error left the promise pending
  forever — that is the shape behind an unexplained hung run. `awaitChannel: api`
  additionally polls `/api/queue/policy` until the server counts the stream as
  the connected channel. It does **not** subsume `test/events-sse.test.js`, whose
  raw client asserts on `:` heartbeat comments and `id:` lines that
  `subscribeSSE` discards.
- `withTempHome(t)` — redirect `HOME`/`USERPROFILE` to a throwaway dir so
  `os.homedir()`-based tiers (theme system scope, toggle user/session) don't touch
  the dev machine.
- `wsConnect(port, path, { headers })` / `wsHello(port, path, { headers })` —
  `headers` is what makes the WS Origin gate testable at all (Node's `ws` client
  sends no `Origin`, so every connection used to take the `!origin` branch and
  deleting `verifyClient` passed the suite). `wsHello` surfaces a refused upgrade
  as a rejection carrying `.statusCode`, not a hang.
- `tmpRoot`, `makeApi(baseUrl)`, `safeStop`.

`test-support/sandbox.js` is loaded by `npm test` through
`--import ./test-support/sandbox.js`, before any test file's first `require`, and
required from `helpers.js` as a fallback for a runner that does not carry the
flag through to its per-file children. It points `HOME`/`USERPROFILE` at a
throwaway dir for the whole process. Its job is the two paths `withServer` cannot
see, both of which spawn a subprocess with **no `env`** so the child inherits:
`client-autospawn`'s real daemon (which used to register tmp roots in the
developer's `~/.web-chat/instances.json` and bounce the live capture hub) and
`profile-cli`'s real CLI (which read the developer's real profiles). It is a
floor, not a replacement — `withServer` still mints a per-test home, because one
process-wide home does not isolate tests from each other (the service trust
store, system-scope themes and the update-check throttle all accumulate).

Run the suite with `npm test`. It is `node --test` with **no path argument** (a
directory mis-resolves), `--test-timeout=60000` so an unsettled await is a named
failing test instead of an anonymous 15-minute CI job, and the sandbox preload.
Deliberately **not** `--test-force-exit`: that turns a leaked handle from a loud
hang into a silent green, and `test/events-sse.test.js` has the suite's only
structural leak detectors.

`test/harness-conventions.test.js` ratchets the five constructs above back into
`test-support` — the deadline loop, a poll-helper definition, `subscribeSSE(`,
`createServer({ root` and `.server.listen(` — with named exemptions (the two
heredoc daemons, the fake clients injected into the channel bridge). It is a
separate file from `conventions.test.js` on purpose: that one deliberately does
not scan `test/`, and adding these roots to its patterns would fire
`http.request(` and `os.homedir()` across ~20 files at once. Fixed sleeps and
`process.env.HOME =` are deliberately **not** ratcheted — a good number of both
are legitimate, so a count could never approach zero.

### `lib/server/domain/mounts.js` — the mount-set engine

Putting a pane on the live surface is not one write. It is, in order: reserved-id
validation, a lock check, an owner gate plus `force`, the `pane_state` /
`form_state` / `theme` carry rules, the `gen` bump a queued Revert is stamped
against, the owner stamp, and ONE `bus.emit` naming both the ring event and the
WS frame. Four routes hand-copied that sequence and each dropped a different
part of it, which is the whole argument for the module.

- `setMount(state, bus, {id, html, target, params, owner, force, component, theme, pane_state_patch, policy})`
  → `{ok:true, id, owner}` or a refusal envelope (`lockReject` / `ownerReject` /
  `reservedReject` — always HTTP 200 with `ok:false`, the tree's refusal
  convention; Claude's tools and the drawer read `.ok`, not the status).
- `removeMount(state, bus, {id, source, originGen, target})` → whether a pane
  went. `originGen` is the queue's generation guard.
- `emitMount(state, bus, id, {source})` — re-broadcast a pane as it stands,
  without replacing it (the queue's activity Revert restores form values in
  place and needs every browser to remount).

**The carry rules are not uniform and must not be flattened.** `pane_state` and
`theme` carry; `form_state` carries unless `params.form_reset`; a supplied
`theme` wins over the pane's; and `component` is written only when the caller
passes one — never carried, because a plain render over a service-backed pane
dropping `component` is exactly how the supervisor stops that pane's child.

**Two named policies, and a third means the abstraction is wrong.** `default`
covers Claude, `/use` and drivers. `capture` exists for one deviation: the
tab-stream extension re-renders its own pane on every capture and must not
soft-reject itself against a stale owner on that id. Everything else the capture
path used to skip — the ring event, the lock check, `gen`, the `form_state`
carry — it no longer does.

What stays OUTSIDE: `graph.restoreLiveToNode` and `turns.loadDraft` replace the
whole surface and broadcast a `reset` instead of per-pane frames, and
`routes/render.js`'s bulk clear owns a pin filter and two batched frame shapes.
`test/conventions.test.js` ratchets exactly that boundary.

## The conventions tripwire

`test/conventions.test.js` is the automated half of the one-engine rule. It walks
`lib/` (+ `public/` for the eval, escaping and token patterns, and `public/app`
for the browser-storage one) and holds a
**per-file baseline** for every construct in the table below, then **ratchets**.
It does not scan `test/` or `test-support/`, so the harness may use raw
http/ws/fetch; the harness's own five constructs have their own file
(`test/harness-conventions.test.js`, described under the test harness above).
The ratchet works the same way in both:

- **New / grown occurrence → fail.** You wrote a banned construct somewhere new —
  route it through its engine instead.
- **Removed occurrence → fail as a STALE baseline.** A consolidation dropped a
  count below its baseline; lower the number here in the same PR. The ceiling can
  only ever move toward zero-outside-the-home.

Current homes (baselines can only shrink toward these):

| Construct | Allowed home | Phase that finishes the collapse |
| --- | --- | --- |
| `http.request(` | `lib/client/index.js` (+ `lib/core/portfiles.js` for the two probes — core can't import the client) | Phase 1 ✅ |
| `os.homedir()` | `lib/core/paths.js` | Phase 1 ✅ |
| `new Function('…')` | `public/mount-runtime.js` (the one mount-runtime source) | Phase 4 ✅ |
| `getPrototypeOf(async function` | `public/mount-runtime.js` (`runSeed`) — the AsyncFunction spelling of the same eval, added when `drawer.js` grew a second eval site the `new Function(` pattern could not see | Phase 4 ✅ |
| `/^[a-z][a-z0-9-]*$/` (the component-name grammar) | `lib/core/names.js` (`COMPONENT_NAME_RE`, beside the reserved builtin list) | landed with `core/names` ✅ |
| `require('node:readline…')` | `lib/cli/prompt.js` (the one prompt engine) | landed with `init` ✅ |
| `.replace(/&/g` | `lib/core/html.js` (`escapeHtml`) — plus `lib/server/export.js`, whose one match is JSON-for-`<script>` escaping, not HTML | landed with the core leaves ✅ |
| `startsWith('..' + path.sep)` | `lib/core/paths.js` — `isInside(parent, child)` for a path on disk, `fence(parent, child)` for one you were handed (services get it as `ctx.fence`); the one grandfathered match is the lexical half of `fence` itself | landed with the file-editor hole fix ✅ |
| `{'&': '&amp;'}` (the lookup-map spelling) | `lib/core/html.js` (host) · `public/app/esc.js` (client) — plus the two builtin component templates, whose pane script is evaluated in the browser with no module scope | landed with the core leaves ✅ |
| `const esc =` / `function esc(` (the declaration spelling) | same two homes — capture profiles take `esc` off their injected ctx | landed with `lib/capture/pane` ✅ |
| `/^--wc-[\w-]+$/` | `lib/server/theme.js` (`TOKEN_RE` + `sanitizeTokens`/`tokenDecls`) — plus the one copy baked into `lib/server/export.js`'s downloaded shell script, which has no server to require from | landed with the core leaves ✅ |
| `.tmp` — a per-pid temp name, both spellings (`.${pid}.tmp` / `.tmp-${pid}`) | `lib/core/fsjson.js` (`writeJsonAtomic`) — plus `lib/update/install-layout.js`, which swaps a *symlink*, not a JSON record | landed with the durable-record engine ✅ |
| `writeFileSync(` **in three named files only** | `lib/core/fsjson.js` — `lib/server/graph.js`, `lib/server/domain/turns.js` and `lib/update/migrations/index.js` are held at zero | landed with the durable-record engine ✅ |
| `process.kill(` | `lib/core/portfiles.js` `isPidAlive` for liveness · `lib/cli/commands/stop.js` for the one SIGTERM escalation — plus the two hub bounces, which signal only the pid `/api/health` reported | landed with the daemon-record engine ✅ |
| `state.mounts.set(` / `state.mounts.delete(` | `lib/server/domain/mounts.js` (`setMount` / `removeMount` / `emitMount`) — plus the two bulk restore paths (`lib/server/graph.js`, `lib/server/domain/turns.js`), which replace the whole surface and broadcast a `reset`, and the bulk clear's per-pane delete in `lib/server/routes/render.js`, which owns a pin filter and two batched frame shapes | landed with the mount-set engine ✅ |
| `findProjectRoot(` **in the eight registration consumers only** | `lib/setup/registration.js` (`resolveRoot(cwd, {mode})`) — `install`, `uninstall`, `on`, `off`, `doctor`, `status`, `update` and `lib/mcp/index.js` are held at zero; every other command legitimately walks up to find a *daemon* | landed with the registration engine ✅ |
| `'settings.hooks.json'` (the quoted filename) | `lib/update/managed-files.js` — `hookTemplate()`, exposed to the CLI as `hookEvents()`. The pattern matches the file being *opened*, not the four places that name it in prose, so a comment or a user-facing warning citing the template is free | landed with the registration engine ✅ |
| `copyFileSync/cpSync/writeFileSync/renameSync/unlinkSync/rmSync/rmdirSync` **in two named files only** | `lib/packs/tree.js` — `applyPlan`/`removeUnits`, under `beginJournal`. `lib/packs/install.js` (the orchestrator) and `lib/packs/plan.js` (pure by contract) are held at zero for every one of them, so nothing mutates the installed tree outside the undo journal — a second apply path spelled `cpSync` or `renameSync` is the same defect | landed with the pack transaction ✅ |
| `localStorage` / `sessionStorage` **in `public/app` only** | `public/app/storage.js` — the one guarded home, held at a true **zero** everywhere else in the chrome | landed with the front-end one-engine pass ✅ |

Working with it:

- **Legitimately need a banned construct in a new place?** That almost always
  means you should call the engine. If it's genuinely unavoidable, raise that
  file's baseline with a justifying comment — and expect review pushback.
- **The tripwire counts raw substrings, comments included.** Writing
  `os.homedir()` in a comment inflates the count. Reword the comment.
- **Adding a new duplication-prone primitive?** Add another pattern to
  `PATTERNS` in `conventions.test.js` with today's occurrences as its baseline, so
  the next copy fails.
- **Deliberately NOT ratcheted: the outbound requesters.** The `http.request(`
  row above polices calls to *our own daemon*, whose home is `lib/client`. Two
  places instead reach the **public internet**, and they are a different concept
  with no engine: `lib/server/routes/embed.js` (probe a URL a pane named — spelt
  `lib.request(`, so the row does not see it) and `lib/update/release.js` (fetch a
  release tarball — spelt `agentFor(u).get(`, which no `.request(` regex sees
  either). A row here would have to name a home that does not exist, and routing
  either through `lib/client` would be wrong: the client dials loopback and has
  none of the fencing an outbound request needs (`refuseTarget` /
  `publicOnlyLookup` in `embed.js`, checksum verification in `release.js`). If a
  **third** outbound requester appears, that is the moment to extract the engine
  and add the row — not before.
- **A construct that is fine almost everywhere but must stay at zero in a few
  places?** Give the pattern a `files` list instead of `roots`. That is why
  `writeFileSync(` is not banned tree-wide: about eight of its ~35 sites in
  `lib/` are legitimately not JSON records (export HTML, capture sidecars,
  `component.html`/`seed.js`/`service.js`, `.gitignore`, the empty disable
  markers), so a tree-wide ceiling could never approach zero-outside-the-home and
  would bake in a table of baselines that are correct forever.

## When you genuinely need a *new* engine

Every planned consolidation has shipped — the current engines are below.

(Shipped: **process registry + versions** → `lib/util/registry.js` (the hub is a
`role:'hub'` entry alongside instances) + `lib/core/versions.js` (the three
version facts: `packageVersion`, `SCHEMA_VERSION`, `PROTOCOL_VERSION` +
`isProtocolCurrent`) (Phase 6). Register a running process with
`registerInstance`/`registerHub`; read it with `readInstances`/`readHubEntry`;
release it with `release({root, pid})`, which removes the portfile and the
registry entry under one ownership rule; classify the machine with `rows()`.
`readInstances` prunes dead pids as it reads (the hub's idle monitor depends on
it) — `readAllEntries()` is the raw view, and the only thing that can report a
ghost record instead of quietly deleting it. `_version.json` has one writer —
the migration runner. Don't stamp a version or add a second "who's running
where" file by hand.)

(Shipped: **tiered named resources** → `lib/core/resources.js` (Phase 5), a
NARROW engine — components + themes' named library adopt it; profiles keep their
URL-matching selection and only borrow its `freshRequire`.)

(Shipped: **turn lock + commit** → `lib/server/domain/turns.js` (Phase 3);
**mount runtime** → `public/mount-runtime.js` (Phase 4). Use those, don't hand-roll.)

If you need a mechanism that doesn't have an engine and isn't a scheduled phase:
build it in `lib/core/` (if it's a zero-dependency primitive) or the appropriate
domain module, consume it from your feature, and — if it's the kind of thing that
gets copied — add it to the tripwire. Don't hand-roll the second copy.
