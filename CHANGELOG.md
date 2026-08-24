# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Security
- **The daemon and the capture hub now bind loopback.** Both called `listen(port)` with no host, so everything web-chat serves — the graph, the shared store (which holds whatever a `file-editor` pane has open), arbitrary HTML/JS injection through `POST /api/render`, and `POST /api/update` — was reachable from the local network with no authentication. Set `WEB_CHAT_HOST` to opt into a different interface deliberately.
- **The WebSocket endpoint now checks `Origin`.** Browsers apply no same-origin policy to WebSocket connects and the `hello` frame is an unconditional full-state disclosure, so any page a user visited could open `ws://localhost:<port>/ws`, read the entire store and every pane's HTML, and write store keys back. Non-browser clients (local drivers, the CLI) send no `Origin` and are unaffected.
- **Service consent records moved to the user tier** (`~/.web-chat/services/trusted.json`). They used to live at `.web-chat/services/trusted.json` *inside the project*, so a repository could ship its own pre-approval: cloning a hostile repo and opening it ran its `service.js` with no prompt.
- **Service consent moved to the terminal — `claude-web-chat trust`.** It used to be a decision made on the surface, which cannot work: pane scripts are compiled with `new Function` and run in the page's own window realm with `document`, `fetch` and `WebSocket`, and no CSP is served, so a component's pane can synthesise a click on any button, open its own same-origin socket and read anything broadcast to the shell, and call any localhost endpoint. Nothing delivered to that page is a secret from the code the gate exists to gate. The surface now shows a notice naming the command; only a shell can grant. Consent is also keyed per **(project root, `service.js` hash, params shape)**, so the same component in another project, an edited service, or different params each ask again — which is what stops one `file-editor` approval covering `unfenced: true`, or a cloned repo inheriting a grant.
- **Capture reads are no longer world-readable.** The CORS layer reflected whatever `Origin` arrived, so any website the user visited could read every capture — distilled content and raw DOM — from the unauthenticated `GET /api/captures*` routes. Only extension and same-machine origins are reflected now.

### Fixed
- **Service-backed components could never be approved at all.** The trust prompt was emitted as a render targeting `overlay`, which the client resolves to the graph-viewer element — `display:none` until the user presses `G`. The prompt was filed inside a hidden panel, so both shipped builtins (`git-dashboard`, `file-editor`) and every user-authored service simply never started, with no prompt and no error. It is now chrome-level UI. The already-prompted memo is also released when the last viewer disconnects, so a refresh no longer left a service permanently unpromptable.
- **`claude-web-chat docs` crashed on every installed copy.** `docs/` was missing from the package `files` allowlist, so the three pointers the shipped rules file gives Claude all died with a raw `ENOENT` stack. The directory now ships, and a future packaging slip degrades to a message instead of a crash.
- **A single truncated node file could wedge a project's daemon permanently.** `graph.load()` parsed every node through a bare `JSON.parse`, so one partial write — a crash or a full disk — threw out of the unguarded `createServer` call path and the daemon could never boot again for that project. Unreadable nodes are now skipped with a warning.
- **Re-running `install` started a second daemon on the same project** and overwrote the portfile, orphaning the first — which kept running and kept writing the same graph directory, invisible to `stop`, `status` and `doctor`. It now probes for a live instance first, matching every other spawn site.
- **A Push could report "Delivered to Claude ✓" and be silently dropped.** Two causes, both fixed: `install` pinned `WEB_CHAT_CHANNEL=1` into `.mcp.json`, which made the MCP server start a channel bridge in *every* session including ones launched without the capability flag; and the bridge's ack confirmed only that bytes were written to stdout, not that anything received them. The env now comes solely from the launch line that also carries the flag, `install`/`update`/`doctor` clean a stale one, and an ack with no live consumer leaves the batch retained so the parked-delivery backstop still fires.
- **The launch command web-chat printed could not work.** `LAUNCH_COMMAND` omitted the `server:web-chat` argument the flag requires, so the incantation shown by `install`, the queue rail and `doctor` was inert.
- **`list_components` returned cross-tier duplicates.** The registry deduped on `get` but not on `list`, so a name present in both tiers appeared twice, identically, with no signal which one `use_component` would resolve to. Shadowed tiers are now reported on the surviving entry instead.
- **`get_graph` now reports `pending_bookmark` and `pending_reaim`** — the name of a graph the user just started (applied to the next commit) and a navigation queued during the current turn. Both were previously invisible, so Claude could be working inside a graph the user had named without any way to know it.
- Documentation no longer hardcodes `http://localhost:5173`. The port is per-project and walks upward, so that URL was wrong for every project after the first — and the rules file shipped into user projects was telling Claude to send people to another project's surface.

### Changed
- `install`'s next steps lead with the ordinary path (restart Claude Code, then `claude-web-chat open`) and present Channels as the optional research preview it is.
- `status` reports the real channel state — connected, or parked-until-your-next-message — instead of inferring it from project wiring.
- Server tests sandbox `HOME`, so the suite no longer writes the developer's real `~/.web-chat`.

## [0.4.0] - 2026-07-18

### Added
- **Service-backed components.** A saved component can carry a host-side `service.js` that the daemon supervises while its pane is on the active node and a browser is watching, so a pane can reflect live host state between Claude's turns with no turn of Claude's involved. Trust is confirm-on-first-use, keyed by the hash of `service.js` so an edit re-prompts. Full contract in `docs/service-components.md`.
- **`git-dashboard` and `file-editor` builtins.** A live git browser (branches, commit log, per-commit drill-in with file stats) and a lightweight file editor with version history and unified diffs — both service-backed, and both canonical examples to crib from.
- **Channels v2.** Activity routing is now opt-out: every user interaction in a pane coalesces into one rolling activity item per mount, so nothing the user does is lost even when a pane's script fails at mount. Typed form values persist per mount (`form_state`) across refresh, navigation, restarts and re-renders. Editing a form while previewing an older node auto-commits dirty live state and re-aims there (branch-on-edit), so the next commit branches instead of overwriting.
- **`claude-web-chat docs`** — prints the bundled contract docs from wherever the package landed on disk, so the rules file can point at them without knowing the install path.

### Changed
- A guidance audit pass over the agent-facing rules file and the MCP tool descriptions, which are load-bearing: Claude picks tools by reading them.

## [0.3.0] - 2026-07-12

### Added
- **Channels are the wake path, and they work everywhere.** Wake-worthy activity — page captures, declared pane signals, and shared comment pins — collects in the surface's queue rail; hitting **Push → Claude** hands over the whole batch. With the Claude Code Channels capability a Push wakes Claude live and no-prompt; without it the batch is *parked* and delivered as context with your next message. Either way there are no background listeners to arm, so the loop works on every Claude Code.
- **Bundled capture profiles.** The package now ships ready-to-use capture profiles — Gmail, Wikipedia, YouTube, Reddit, and a generic reader-lite article view — as a first-class package tier, so common sites distill cleanly the moment the browser extension is loaded, with no per-user setup. User-authored profiles still override the bundled ones.
- **Public-repo distribution.** MIT-licensed and installable in one line: `curl -fsSL …/install.sh | sh` puts the `claude-web-chat` command on your PATH straight from the public repository — no npm registry. `claude-web-chat update` (now reporting the version before and after) and the 24-hour update check target the repo too. The README leads with the one-liner and documents loading the browser extension from the installed package.

### Changed
- **Review hardening.** A pass over the queue / bridge / comment-policy substrate the wake path leans on: private comment pins no longer leak their text onto the wake bus, navigating the graph no longer strands queued items, and the surrounding fixes each landed with a test.

### Removed
- The legacy Claude-facing listener surface — the `wait_for` MCP tool and the `claude-web-chat watch` CLI — in favour of the queue / Push / parked-delivery path. (The `/api/wait` endpoint remains as a driver-only contract.)

## [0.2.0] - 2026-06-19

### Added
- **Page export.** Export any graph node to a self-contained, interactive `.html` (every pane's HTML/JS + store snapshot + resolved theme inlined; opens with no server or network). Three surfaces over one server-side assembler (`lib/server/export.js`): the topbar **⬇** Download button (exports the node currently viewed, as rendered), the `export` MCP tool, and `claude-web-chat export [node]`. Files land in `.web-chat/exports/`. Refs accept a label (`n1.7`), a stored id, `active` (default), or `live`.
- **Managed-file propagation.** `update`/`install` now reconcile the per-project managed templates (`.claude/rules/web-chat.md`, `.claude/commands/web-chat.md`) with an edit-preserving 3-way merge instead of skip-if-exists: safe template updates auto-apply, local edits are kept, conflicts surface as `<file>.new` sidecars. Baselines tracked in `.web-chat/managed.json`; drift surfaced in `status` and a once-per-session MCP-startup nudge.

## [0.1.0] - 2026-05-27

### Added
- Initial restructure into publishable npm package layout (`bin/`, `lib/`, `public/`, `templates/`).
- `lib/server/` decomposition of the original `server.js` into `paths`, `state`, `graph`, `ws`, and per-concern route modules.
- `.web-chat/` per-project runtime state directory (graph nodes + saved components + `_version.json`).
- Reserved `.claude-plugin/plugin.json` and `.mcp.json` for future Claude Code plugin packaging.
- Local git initialized.
