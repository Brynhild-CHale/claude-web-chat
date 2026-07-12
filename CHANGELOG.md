# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
