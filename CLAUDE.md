# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this project is

`claude-web-chat` is the **package that implements** the web-chat surface — not a project that uses it. It gives Claude Code a live browser canvas (a per-project port, walking upward from 5173) plus a turn-by-turn graph: Claude renders interactive HTML/JS into shadow-rooted mounts, reads/writes a shared key/value store the page is bound to, and every Claude turn becomes a navigable graph node the user can branch or revisit.

Note: `.claude/rules/web-chat.md` in this repo is the **end-user-facing rules file** (this dogfooding install of the product), describing the 23 MCP tools and how to use the surface. It is product behavior, not guidance for developing the package. When working on the package source, the architecture below is what matters.

## Commands

```sh
npm install               # dev setup; run the CLI in place: node bin/claude-web-chat.js <cmd>
npm test                  # run the full test suite (Node built-in runner, test/*.test.js)
node --test --test-timeout=60000 test/root.test.js   # run a single test file
node scripts/build-release.js   # build the release tarball + SHA256SUMS into dist/
```

> ⚠️ Do **not** `npm link` this package. npm's global prefix is shared mutable
> state — an unrelated `npm i -g` silently replaced that link with a 16-day-old
> copied build once already. See `docs/extending.md` for how to put a checkout on
> PATH deliberately; `claude-web-chat version` always reports which tree is running.

There is no build step (plain CommonJS) and no lint config. `npm start` / `node bin/claude-web-chat.js start` runs the server in the foreground; `claude-web-chat` is the user-facing CLI (`open`, `stop`, `restart`, `unlock`, `install`, `on`/`off`, `status`, `update`).

> ⚠️ Run tests with `npm test` — a bare `node --test --test-timeout=60000` (auto-discovers
> `test/`). `node --test test/` mis-resolves and reports a spurious single failure. The
> timeout is load-bearing: without it one leaked handle or never-settling await hangs the
> whole run indefinitely. Do **not** add `--test-force-exit` — it turns a hang into a
> silent pass.

## Architecture

**Three entry points, one server.** The three bin shims each load a different `lib/` subsystem:

- `bin/claude-web-chat.js` → `lib/cli` — the user-facing CLI.
- `bin/claude-web-chat-mcp.js` → `lib/mcp` — the stdio MCP server Claude Code spawns (registered in `.mcp.json`).
- `bin/claude-web-chat-hook.js` → `lib/hooks` — the `UserPromptSubmit` / `Stop` hook helpers.

**`lib/server/` is the single source of truth.** It's an Express + `ws` HTTP/WebSocket server (`createServer({root, port})` in `index.js`). All live state lives here: `state.js` holds mounts/store/events; `graph.js` loads/saves/restores the turn graph; routes under `routes/` expose one HTTP endpoint group per concern — one file each, and the `mountXRoutes(app, ctx)` calls in `index.js` are the authoritative list of them. Each route file exports `mountX(app, ctx)` where `ctx = { state, bus, graph, paths, root, broadcastReset, retain, release, sseClients, services, getViewers, getMcpSeen, triggerShutdown }`; a route announces a change through `ctx.bus.emit` (never a hand-paired broadcast + event push), and `broadcastReset` is the one full-state WS snapshot that stays outside the ring.

**MCP tools and hooks are thin HTTP clients to that server.** `lib/mcp/tools/<name>.js` (23 of them, listed in `lib/mcp/index.js`) and the hooks all go through `lib/mcp/client.js`, which discovers the running daemon's port from the `.web-chat/server.json` portfile (or `WEB_CHAT_PORT`) and auto-spawns the daemon if it isn't running. So the MCP layer holds no state — it translates tool calls into HTTP requests. Each tool module exports `{ name, description, inputSchema, async handler(args) }`; tool descriptions are load-bearing (Claude reads them to choose tools).

**Turn lifecycle / the lock.** A user prompt fires the `UserPromptSubmit` hook (`turn-begin`), which acquires a graph lock pinning the commit point; a channel wake acquires one too (`turn-begin-on-push`: `emitWake` → `acquireWakeLock`, author `'wake'`, short TTL — a typed prompt mid-wake-turn upgrades it in place). Claude's `render`/`set_store`/`clear`/`use_component` calls mutate live server state during the turn. The `Stop` hook (`turn-end`) commits all of it as one new graph node and releases the lock. A user re-aim during a locked turn is never 409'd — it queues as `graph.pendingReaim` (last wins) and applies after the turn-end commit or on unlock. Claude never commits nodes or moves `active` — the harness and the user do. The user also moves it implicitly via **branch-on-edit** (`POST /api/graph/branch-here`): editing a form while previewing an older node auto-commits any dirty live state as a `user`-authored preserve node, then re-aims `active` to the previewed node so the next commit branches (`liveIsDirty` in `lib/server/domain/turns.js`). A stale/orphaned lock is cleared with `claude-web-chat unlock`. On graceful shutdown the server snapshots uncommitted live state to `draft.json` and restores it on next boot.

**Toggle policy — three scopes, most-restrictive-wins** (`lib/toggle/`): user (`~/.web-chat/disabled`), project (`${cwd}/.web-chat/`), session. The MCP server enforces only user+project because Claude Code doesn't pass `session_id` to MCP subprocesses; session scope only affects hooks. When disabled, hooks no-op and MCP tools return `{ disabled, scope, hint }`.

**State migrations** (`lib/update/migrations/`) run on every server boot for any project below `SCHEMA_VERSION`. They edit files in `.web-chat/` and must be idempotent and append-only — never rewrite graph history.

**Per-project runtime state** lives in `${cwd}/.web-chat/` (graph nodes, saved components, `_version.json`, portfile, draft) — gitignored. Per-user state in `~/.web-chat/` (disable markers, update-check throttle).

## Extending

**Use the engines — don't bolt on.** Each concept is consolidated behind one module; extend it, never hand-roll a second copy (a second copy is a review-blocking defect, and `test/conventions.test.js` fails the build for the most-copied constructs — the tripwire table in `docs/extending.md` lists every one and its allowed home). Full guide + rationale: `docs/extending.md`.

| Need to… | Use | Never |
| --- | --- | --- |
| resolve a `.web-chat`/`~/.web-chat` path, or the project root | `lib/core/paths` (`projectPaths`/`userPaths`/`findProjectRoot`) | hardcode `.web-chat` / call `os.homedir()` |
| ask whether a path is inside a directory (a fence) | `lib/core/paths` (`isInside`/`realpath` for a path on disk; `fence(parent, child)` for one you were HANDED or are about to create — services get it as `ctx.fence`) | compare with `startsWith` or `path.relative` by hand |
| read/write/discover/probe a daemon portfile | `lib/core/portfiles` | read `server.json` or `http.request` a probe by hand |
| ask whether a pid is alive | `lib/core/portfiles` (`isPidAlive`) | inline `process.kill(pid, 0)` (no type guard) |
| release a daemon's records, or classify the machine | `lib/util/registry` (`release({root,pid})` / `rows()` / `readAllEntries`) | delete a portfile and a registry entry separately, or re-derive liveness per caller |
| stop or clear ANOTHER project's surface | `lib/cli/reap` (`reap` / `stopRow`) | signal a pid read out of a file |
| call the daemon over HTTP (incl. SSE) | `lib/client` (`get`/`post`/`request`/`subscribeSSE`) | `http.request` / hand-rolled SSE (`/api/wait` is a driver-only long-poll — drivers reach it via `lib/driver` `waitFor`, never hand-rolled) |
| write a small JSON record durably, or read one back honestly | `lib/core/fsjson` (`writeJsonAtomic`; `readJson` → `ok`/`absent`/`corrupt`/`invalid`, `readJsonOr`, `renameAside`) | `writeFileSync(JSON.stringify(...))`, a private tmp+rename, or a `catch` that collapses absent and torn |
| notify the surface of a change (WS frame + event-log entry) | `lib/core/bus` (`emit({event, ws, except})`; one ring, one `read` gap/catch-up) | hand-pair `broadcast(...)` + `pushEvent(...)` |
| CORS / escape HTML / collapse profile text | `lib/core/cors` / `lib/core/html` (`escapeHtml(s)` — five characters, no modes) / `lib/capture/profiles/util` | copy the helper, or inline a `.replace` chain |
| resolve + scheme-gate an href/src read out of a captured page | `lib/capture/profiles/util` (`safeHref(href, pageUrl)`) | `new URL` plus your own `javascript:` regex |
| render a capture pane (default reduce, mode wrapper, reader view, feedback card) | `lib/capture/pane` | import them from `lib/server/routes/capture` |
| read/validate/require a capture-profile bundle | `lib/capture/profiles` (`loadBundle` / `validateMeta`) | a second reader of `profile.json` with its own rules |
| hand a capture profile a helper (`esc`, `collapse`, `safeHref`) | the injected extract/pane ctx — `CTX_HELPERS` in `capture/profiles` | declare one inside the bundle |
| ask the user a question in the terminal | `lib/cli/prompt` (`createPrompt` → `confirm`/`line`/`close`; the non-TTY/CI/`--no-input`/`--yes` gate is inside the engine) | `require('node:readline')` at a call site, or gate on `process.stdin.isTTY` yourself |
| unpack or inspect a `.tar.gz` | `lib/update/archive` (`extractTarGz`/`rootOf`/`listTarGz`) | a second `spawnSync('tar')` |
| compare two versions | `lib/core/versions.compareVersions` | a third dotted-number comparator |
| know the supported Node floor, or where releases come from | `lib/core/versions` (`NODE_FLOOR`/`checkNodeFloor`, `REPO_SLUG` + the URLs built from it) | write `22` or the repo slug into a message |
| resolve a `.claude/` path (settings, rules, skills) | `lib/core/paths` (`claudePaths`/`userClaudePaths`) | hardcode `.claude` |
| fetch / plan / install a component pack | `lib/packs/` (`source`→`fetch`→`manifest`→`plan`→`tree`→`install`) | a second install path beside the CLI's |
| decide whether a name may become a component directory | `lib/core/names` (`assertComponentName`/`isComponentName`/`BUILTIN_COMPONENTS`) | re-declare the kebab grammar, or re-list the builtin names |
| read/write a browser storage key in the chrome | `public/app/storage.js` (`getLocal`/`setLocal`/`getSession`/`getLocalJson`, all fail open) | touch `localStorage`/`sessionStorage` directly (the accessor throws in a private window) |
| leave the detached node preview | `public/app/topbar.js` (`leavePreview({activeId, restoreSnapshot, flushForms})`) | hand-copy the `previewing = false` transition |
| walk the graph as DRAWN (nav, forks, lineage, layout) | `public/app/graph-view.js` (`graphIndex`/`displayChildrenOf`/`displayParentOf`) | `labels.childrenOf` — raw commit children, for the ⑃ branch picker only |
| dismiss a transient chrome panel | `public/app/shell.js` (give it `.popover`; `closeAllPopovers`/`handleEscape` own it) | a private outside-click or document-Escape listener |
| boot a server in a test | `test-support/helpers` (`withServer`) | copy `tmpRoot`/`listen`/`stop` |

Dependency direction is one-way: `core` ← `client` ← everything else, `core` imports nothing else from `lib/`, and entry points never reach into each other's internals — **`test/dependency-direction.test.js` enforces all three**, with a named, shrink-only baseline for the edges that legitimately remain. Every concept is consolidated behind one engine (paths, portfiles, durable JSON records, the daemon HTTP client, the change bus, the mount runtime, the tiered resource registry, the turn lock, the service supervisor) — extend the engine, never add a parallel mechanism. Full concept→engine map: `docs/extending.md`.

- **New MCP tool**: add `lib/mcp/tools/<name>.js`, append to the `tools` array in `lib/mcp/index.js`, add any backing route under `lib/server/routes/`, then `/exit` and reopen Claude Code (the MCP subprocess loads code at session start).
- **New CLI subcommand**: add `lib/cli/commands/<name>.js`, register in the `commands` map in `lib/cli/index.js`, update `showHelp()`.
- **New HTTP route**: add `lib/server/routes/<concern>.js` exporting `mountX(app, ctx)`, mount it from `lib/server/index.js`.
- **New migration**: add `lib/update/migrations/v<N>-to-v<N+1>.js`, register in the `migrations` map, bump `SCHEMA_VERSION`.
- **Component packs** (`lib/packs/`): a pack is a repo that installs as components **plus a `.claude/skills/<pack>/SKILL.md`** — the skill is the point (`list_components` is a pull; a skill's description is in context from session start). The pipeline is one direction: `source` (parse a URL, pin a commit) → `fetch` (download, verify, stage — refusing hostile archive members on our terms, not `tar`'s) → `manifest` (validate, read the skill frontmatter) → `plan` (PURE — no writes) → `tree` (copy / remove per unit, under ONE undo journal — `beginJournal`) → `install` (orchestrate + record + audit). **An install is one transaction**: `beginJournal` records every creation, copies every file it is about to overwrite into `projectPaths().packsBackup`, and remembers every directory the apply created — any throw unwinds in reverse and rethrows, so nothing lands. The provenance record is written as a `pending` marker (its own `.web-chat/packs/pending.json`, never `packs.json`, so `ownerOf`/`verifyPack`/`pack list` never see a half-install as installed) BEFORE the bytes and finalised after; a same-pack re-install diffs the previous record against the plan (`droppedUnits`, pure) and prunes the difference through `removeUnits` AFTER a successful apply. `lib/packs/install.js` and `lib/packs/plan.js` are held at zero `copyFileSync`/`unlinkSync`/`rmSync` by the conventions ratchet. `lib/server/routes/packs.js` and `lib/cli/commands/pack.js` are both thin over `lib/packs/install`. **Read the risk paragraph at the head of `routes/packs.js` before touching any of it**: the install endpoint is reachable by any pane and cannot distinguish a pane's `fetch` from a user's click. A builtin component name is a hard refusal with no override, in either tier, for either actor — `seedBuiltins` only repairs directories marked `builtin`, so a shadowing pack would win permanently.
- **New service-backed component**: ship `templates/components/<name>/` with `component.html` + `meta.json` + `service.js` (+ optional `seed.js`), add the name to `BUILTINS` in `lib/server/builtins.js`. The daemon runs `service.js` (via the supervisor, `lib/server/services.js`) while the pane is active. Full contract: `docs/service-components.md`.

**What restarts after which edit:** `public/*` → refresh browser (served from disk, no cache). `lib/server/*` and `lib/capture/*` → `claude-web-chat restart` (saved capture profiles also hot-reload live via `claude-web-chat profile reload`, no restart). `lib/hub/*` → restart the hub — but an instance restart self-heals it: the hub reports a `HUB_PROTOCOL_VERSION` in `/api/health`, and `ensureHub` (called on every instance boot) bounces a hub older than the current build, so bumping that version when hub routes change is enough. `lib/mcp/*` → `/exit` + reopen Claude Code. `lib/hooks/*` → nothing (fresh process per fire). `lib/cli/*` → next invocation.

## Conventions

- CommonJS (`require`/`module.exports`), Node 22+, no transpile. The floor is 22 because `node-html-parser` pulls in an ESM-only `entities`, and `require(esm)` landed in 22 — below it the daemon does not start at all.
- **One engine per concept, enforced.** `test/conventions.test.js` is a ratchet — it fails on a new *or newly-removed* occurrence of any banned construct (dynamic eval in both its spellings, `http.request(`, `os.homedir()`, the readline require, both hand-rolled HTML escapers, the design-token and component-name regexes) outside its single allowed home (the count can only shrink toward the home); `docs/extending.md`'s tripwire table names each one and its home. Run the suite with `npm test`. See `docs/extending.md`.
- Forward-compat stubs exist for Claude Code plugin packaging: `.claude-plugin/plugin.json` and `.mcp.json` use `${CLAUDE_PLUGIN_ROOT}` to resolve bin paths.
- **Distribution is GitHub Releases — npm is not involved at any point.** `scripts/build-release.js` builds a self-contained, reproducible `claude-web-chat-<version>.tar.gz` (the `files` allowlist plus production `node_modules`, since the four runtime deps mean a source tarball cannot run) plus `SHA256SUMS`; `.github/workflows/release.yml` attaches both to the release on a `v*` tag. `install.sh` and `claude-web-chat update` download it, verify the checksum, unpack into `~/.web-chat/versions/<v>/`, swap the `~/.web-chat/current` symlink and link three bins into `~/.local/bin` — no sudo, and `update --to <v>` rolls back to a version still on disk. `update` refuses to run from a git checkout or any other unmanaged copy (`lib/update/install-layout.js`). **macOS and Linux are supported; Windows means WSL2** — the policy, what CI does and does not prove, and the known cross-platform bugs are in `docs/platform-support.md`, with per-platform findings on the `platform/linux` and `platform/windows` branches. `package.json` keeps `"private": true` as an anti-publish guard — it makes an accidental `npm publish` fail fast.
