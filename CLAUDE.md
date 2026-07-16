# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this project is

`claude-web-chat` is the **package that implements** the web-chat surface — not a project that uses it. It gives Claude Code a live browser canvas (`http://localhost:5173`) plus a turn-by-turn graph: Claude renders interactive HTML/JS into shadow-rooted mounts, reads/writes a shared key/value store the page is bound to, and every Claude turn becomes a navigable graph node the user can branch or revisit.

Note: `.claude/rules/web-chat.md` in this repo is the **end-user-facing rules file** (this dogfooding install of the product), describing the 23 MCP tools and how to use the surface. It is product behavior, not guidance for developing the package. When working on the package source, the architecture below is what matters.

## Commands

```sh
npm install && npm link   # symlink the 3 bin scripts onto PATH (dev setup)
node --test               # run the full test suite (Node built-in runner, test/*.test.js)
node --test test/root.test.js   # run a single test file
```

There is no build step (plain CommonJS) and no lint config. `npm start` / `node bin/claude-web-chat.js start` runs the server in the foreground; `claude-web-chat` is the user-facing CLI (`open`, `stop`, `restart`, `unlock`, `install`, `on`/`off`, `status`, `update`).

> ⚠️ Run tests with bare `node --test` (auto-discovers `test/`). `node --test test/` mis-resolves and reports a spurious single failure.

## Architecture

**Three entry points, one server.** The three bin shims each load a different `lib/` subsystem:

- `bin/claude-web-chat.js` → `lib/cli` — the user-facing CLI.
- `bin/claude-web-chat-mcp.js` → `lib/mcp` — the stdio MCP server Claude Code spawns (registered in `.mcp.json`).
- `bin/claude-web-chat-hook.js` → `lib/hooks` — the `UserPromptSubmit` / `Stop` hook helpers.

**`lib/server/` is the single source of truth.** It's an Express + `ws` HTTP/WebSocket server (`createServer({root, port})` in `index.js`). All live state lives here: `state.js` holds mounts/store/events; `graph.js` loads/saves/restores the turn graph; routes under `routes/` expose one HTTP endpoint group per concern (render, components, store, events, graph, theme, embed). Each route file exports `mountX(app, ctx)` where `ctx = { state, graph, paths, pushEvent, broadcast, broadcastReset }`.

**MCP tools and hooks are thin HTTP clients to that server.** `lib/mcp/tools/<name>.js` (23 of them, listed in `lib/mcp/index.js`) and the hooks all go through `lib/mcp/client.js`, which discovers the running daemon's port from the `.web-chat/server.json` portfile (or `WEB_CHAT_PORT`) and auto-spawns the daemon if it isn't running. So the MCP layer holds no state — it translates tool calls into HTTP requests. Each tool module exports `{ name, description, inputSchema, async handler(args) }`; tool descriptions are load-bearing (Claude reads them to choose tools).

**Turn lifecycle / the lock.** A user prompt fires the `UserPromptSubmit` hook (`turn-begin`), which acquires a graph lock pinning the commit point. Claude's `render`/`set_store`/`clear`/`use_component` calls mutate live server state during the turn. The `Stop` hook (`turn-end`) commits all of it as one new graph node and releases the lock. Claude never commits nodes or moves `active` — the harness and the user do. A stale/orphaned lock is cleared with `claude-web-chat unlock`. On graceful shutdown the server snapshots uncommitted live state to `draft.json` and restores it on next boot.

**Toggle policy — three scopes, most-restrictive-wins** (`lib/toggle/`): user (`~/.web-chat/disabled`), project (`${cwd}/.web-chat/`), session. The MCP server enforces only user+project because Claude Code doesn't pass `session_id` to MCP subprocesses; session scope only affects hooks. When disabled, hooks no-op and MCP tools return `{ disabled, scope, hint }`.

**State migrations** (`lib/update/migrations/`) run on every server boot for any project below `SCHEMA_VERSION`. They edit files in `.web-chat/` and must be idempotent and append-only — never rewrite graph history.

**Per-project runtime state** lives in `${cwd}/.web-chat/` (graph nodes, saved components, `_version.json`, portfile, draft) — gitignored. Per-user state in `~/.web-chat/` (disable markers, update-check throttle).

## Extending

**Use the engines — don't bolt on.** Each concept is consolidated behind one module; extend it, never hand-roll a second copy (a second copy is a review-blocking defect, and `test/conventions.test.js` fails the build for the worst three). Full guide + rationale: `docs/extending.md`.

| Need to… | Use | Never |
| --- | --- | --- |
| resolve a `.web-chat`/`~/.web-chat` path, or the project root | `lib/core/paths` (`projectPaths`/`userPaths`/`findProjectRoot`) | hardcode `.web-chat` / call `os.homedir()` |
| read/write/discover/probe a daemon portfile | `lib/core/portfiles` | read `server.json` or `http.request` a probe by hand |
| call the daemon over HTTP (incl. SSE) | `lib/client` (`get`/`post`/`request`/`subscribeSSE`) | `http.request` / hand-rolled SSE (`/api/wait` is a driver-only long-poll — drivers reach it via `lib/driver` `waitFor`, never hand-rolled) |
| notify the surface of a change (WS frame + event-log entry) | `lib/core/bus` (`emit({event, ws, except})`; one ring, one `read` gap/catch-up) | hand-pair `broadcast(...)` + `pushEvent(...)` |
| CORS / escape HTML / collapse profile text | `lib/core/cors` / `lib/server/util/html` / `lib/capture/profiles/util` | copy the helper |
| boot a server in a test | `test-support/helpers` (`withServer`) | copy `tmpRoot`/`listen`/`stop` |

Dependency direction is one-way: `core` ← `client` ← everything else, and `core` imports nothing else from `lib/`. Every concept is consolidated behind one engine (paths, portfiles, the daemon HTTP client, the change bus, the mount runtime, the tiered resource registry, the turn lock, the service supervisor) — extend the engine, never add a parallel mechanism. Full concept→engine map: `docs/extending.md`.

- **New MCP tool**: add `lib/mcp/tools/<name>.js`, append to the `tools` array in `lib/mcp/index.js`, add any backing route under `lib/server/routes/`, then `/exit` and reopen Claude Code (the MCP subprocess loads code at session start).
- **New CLI subcommand**: add `lib/cli/commands/<name>.js`, register in the `commands` map in `lib/cli/index.js`, update `showHelp()`.
- **New HTTP route**: add `lib/server/routes/<concern>.js` exporting `mountX(app, ctx)`, mount it from `lib/server/index.js`.
- **New migration**: add `lib/update/migrations/v<N>-to-v<N+1>.js`, register in the `migrations` map, bump `SCHEMA_VERSION`.
- **New service-backed component**: ship `templates/components/<name>/` with `component.html` + `meta.json` + `service.js` (+ optional `seed.js`), add the name to `BUILTINS` in `lib/server/builtins.js`. The daemon runs `service.js` (via the supervisor, `lib/server/services.js`) while the pane is active. Full contract: `docs/service-components.md`.

**What restarts after which edit:** `public/*` → refresh browser (served from disk, no cache). `lib/server/*` and `lib/capture/*` → `claude-web-chat restart` (saved capture profiles also hot-reload live via `claude-web-chat profile reload`, no restart). `lib/hub/*` → restart the hub — but an instance restart self-heals it: the hub reports a `HUB_PROTOCOL_VERSION` in `/api/health`, and `ensureHub` (called on every instance boot) bounces a hub older than the current build, so bumping that version when hub routes change is enough. `lib/mcp/*` → `/exit` + reopen Claude Code. `lib/hooks/*` → nothing (fresh process per fire). `lib/cli/*` → next invocation.

## Conventions

- CommonJS (`require`/`module.exports`), Node 18+, no transpile.
- **One engine per concept, enforced.** `test/conventions.test.js` is a ratchet — it fails on a new *or newly-removed* `http.request(` / `os.homedir()` / `new Function(` outside its single allowed home (the count can only shrink toward the home). Run the suite with bare `node --test`. See `docs/extending.md`.
- Forward-compat stubs exist for Claude Code plugin packaging: `.claude-plugin/plugin.json` and `.mcp.json` use `${CLAUDE_PLUGIN_ROOT}` to resolve bin paths.
- Distribution is the public git repo, not the npm registry: MIT-licensed v0.3.0, installed via `install.sh` and updated in place with `claude-web-chat update`. `package.json` keeps `"private": true` as an anti-publish guard — it makes an accidental `npm publish` fail fast.
