# Plan — Export a page as a self-contained attachment

## Context

A "page" in web-chat is a graph node: `{ mounts: [{id, html, target, params, pane_state, theme}], store, comments }` (`lib/server/graph.js:140`). Every pane's HTML/JS is already a string held server-side, and the store/theme are plain data. That makes a **self-contained interactive `.html` export nearly free** — assemble a minimal shell + inlined mounts + baked store + baked theme into one file, no headless browser.

Two existing patterns are reused: the zero-dependency zip writer is *not* needed (single file), but the `Content-Disposition: attachment` download pattern (`embed-helper.js:185`) is, and `computeLabels` (`graph.js:176`) gives id↔label.

Confirmed decisions:
- **Format:** self-contained interactive HTML, purpose-built ~120-line runtime (store shim + `mount()` + theme application). Live JS, **frozen store snapshot**, theme baked in.
- **Unit:** a graph node (all its panes + store + theme).
- **Triggers (one shared assembler):** topbar **Download** button · MCP `export` tool · `claude-web-chat export [node]` CLI.
- **Button semantics:** exports the node **currently rendered** (`viewedId`), active or not — previewing an old node exports that node as shown. Mid-turn uncommitted live surface (no `viewedId`) falls back to assembling from live state.
- **`.web-chat/exports/`** — output dir for MCP/CLI, gitignored (`.web-chat/` already in `.gitignore`).
- **Out of v1:** PNG/PDF (fast-follow — PNG via the open browser's `html2canvas`); re-importing an export into another install (state transfer, a different feature).

## How the export runtime mirrors the client

The browser mounts a pane (`client.js:487-540`) by: `attachShadow({mode:'open'})` → parse `html` into a `<template>` → pull `<script>` textContent out → append the rest to the shadow root → run each script via `new Function('store','root','params','mountId', code)`. Mounts carry **no separate `js` field** — JS lives in `<script>` tags inside `html`. The export runtime replicates exactly this. The store (`client.js:1-27`) is a pub/sub whose only network coupling is a `ws.readyState === 1`-guarded send; drop that branch and the same object is a self-contained local store.

So the emitted runtime needs only: the store pub/sub (no ws), `mount()` (shadow root + script extraction + `new Function`), per-pane theme application (tokens on host + raw css into shadow root), and a bootstrap that seeds the store then mounts each pane. No graph viewer, minimap, SSE, WS, or comments code.

## Core mechanism — the assembler

New module **`lib/server/export.js`**:

- `assembleExport({ mounts, store, theme, meta }) → htmlString`. Pure (no fs, no ctx) for unit-testing. Produces:
  ```
  <!doctype html><html><head>
    <meta charset/viewport>, <title> from meta.label
    <style> host/pane CSS (minimal subset of styles.css) + node/global raw chrome css
            + :root { --wc-* tokens } </style>
  </head><body>
    <div id="export-meta"> small caption: label + timestamp (optional, themed) </div>
    <div id="main"></div>  (+ any non-'main' targets referenced by mounts)
    <script id="export-data" type="application/json"> { mounts, store, paneThemes } </script>
    <script> /* ~120-line runtime */ </script>
  </body></html>
  ```
  - `mounts`: array of `{ id, html, target, params, theme }`. `pane_state` (collapsed/size) baked into initial host styling; not interactive chrome.
  - `store`: baked object; runtime seeds it before mounting so components read initial values synchronously.
  - HTML-escape only where injecting into attributes/text; the `<script type="application/json">` payload is JSON-encoded with `<` escaped (`<\/script>` / `<`) to prevent breakout. **This is the main injection-safety concern — covered by a test.**
  - No `ws://`, no `fetch` to the origin, no absolute localhost URLs. (Pane content that fetches the *public* network still does so at view time — documented, not solved.)
- `resolveExportTheme(ctx, nodeId | {live:true})` — wraps `theme.js` resolution: global ⊕ node tokens + raw css for the page, and per-pane global ⊕ node ⊕ pane tokens + pane raw css. **Reuse, don't reimplement:** export `resolveScope`/add a thin `resolveForExport` helper from `lib/server/routes/theme.js` (it already does `mergeTokens`/`mergeCss`/`normalizeTheme` with the pane→node→global cascade).
- `nodeForExport(ctx, ref) → { mounts, store, theme-inputs, label }` — resolves a node reference to its data:
  - `ref` omitted / `'active'` → `graph.active`.
  - `ref` a label (`n1.7`) → invert `computeLabels(graph)`.
  - `ref` a stored id (`n5`) → direct.
  - `ref === 'live'` → `graph.snapshotLive()` (current uncommitted surface).
  - Returns a clear error object for unknown refs (no throw across the HTTP boundary).
- `writeExport(ctx, ref) → { path, label }` — assembles and writes `${paths.WEB_CHAT_DIR}/exports/<label>-<YYYYMMDD-HHMMSS>.html` (mkdir -p), returns the absolute path. Used by MCP + CLI.

## Wire-up

- **`lib/server/routes/export.js`** — `mountExportRoutes(app, ctx)`:
  - `GET /api/export/:ref` → assemble for `ref` (label/id/`active`/`live`), respond with the html and `Content-Disposition: attachment; filename="<label>.html"` (escape filename). 404 with `{error}` for unknown ref.
  - Mounted from `lib/server/index.js` alongside the others (`mountExportRoutes(app, ctx)` at ~line 207).
- **`public/` — topbar Download button:**
  - `index.html`: add `<button class="btn" id="btn-export" title="download this view as a self-contained .html">⬇</button>` next to `#btn-settings`.
  - `client.js`: on click, resolve the target ref — `previewing && viewedId ? viewedId : (activeId || 'live')` — and trigger a download by navigating a hidden link / `window.location` to `/api/export/<ref>`. Server sets the attachment header; the browser saves it. (No mounts posted over the wire — server reads the node.)
- **`lib/mcp/tools/export.js`** — `{ name:'export', description, inputSchema:{ node?: string (label/id, default active; or 'live') }, handler }`. Calls the daemon over `lib/mcp/client.js` (a new `exportNode` helper hitting a small JSON endpoint, e.g. `GET /api/export/:ref?as=json` returning `{path}` after the server writes the file — keeps the write server-side where `paths` lives). Returns `{ path, label }`. Register in the `tools` array in `lib/mcp/index.js`. Description states *when*: "Export a rendered page (graph node) to a self-contained .html file you can attach to a message."
- **`lib/cli/commands/export.js`** — `claude-web-chat export [node]`: resolves the running daemon via the portfile (like other CLI/daemon interactions), requests the write, prints the path. Register in `commands` map in `lib/cli/index.js` + `showHelp()`.

> Server-side write vs client download: the **route** streams the file for the browser button (no disk write needed); the **MCP/CLI** path writes to `.web-chat/exports/` and returns a path (Claude/scripts want a file to reference). Both call `assembleExport`. Add a `GET /api/export/:ref?format=file` (or a sibling `POST`) that writes and returns `{path,label}` for the MCP/CLI clients.

## Reuse

`computeLabels` (graph.js) for label↔id; `theme.js` resolution helpers (export `resolveScope`); the `Content-Disposition` attachment pattern (embed-helper.js); `graph.snapshotLive()` for the live fallback; `paths.WEB_CHAT_DIR` for the exports dir; `lib/mcp/client.js` port discovery for the tool; the portfile reader for the CLI.

## Tests

**`test/export.test.js`** (pure assembler + integration against a temp server):
- `assembleExport` with a 2-pane node fixture → output contains both panes' html, the baked store JSON, and the `--wc-*` tokens; contains **no** `ws://`, no `localhost`, no `/api/`.
- **Injection safety:** a mount whose html contains `</script>` and a store value containing `</script>`/`<!--` → assembled file still parses (payload properly escaped); assert the breakout string is neutralized.
- Self-contained: write the html to a temp file and assert it has no external `<script src>`/`<link href>` to our origin.
- `nodeForExport` ref resolution: `active`, a label, a raw id, `live`, and an unknown ref (→ error object, no throw).
- Theme baking: a node with a theme + a pane with its own theme → both token sets present at the right scope.
- Route: `GET /api/export/:ref` returns 200 + `Content-Disposition: attachment`; unknown ref → 404 `{error}`.
- `writeExport` lands a file under `.web-chat/exports/` with a label-stamped name and returns its path.

Run with bare `node --test` (the existing suite must stay green).

## Verification

- **Automated:** `node --test` (new export suite + existing stay green).
- **Manual:** open a project, render 2–3 panes (one with an interactive control bound to the store), `claude-web-chat export` → open the produced `.html` in a fresh browser with **no daemon running** → panes render, theme matches, the interactive control works locally (updates its pane) and persists nowhere. Preview an older node, click the topbar **⬇**, confirm the downloaded file is *that* node, not the active one.
- **Dogfood:** export a node from this repo's own surface and attach it.

## Sequencing

1. `lib/server/export.js` (`assembleExport` + the emitted runtime) + pure unit tests (assembly, injection safety, self-containment).
2. `nodeForExport` / `resolveExportTheme` / `writeExport` (reuse theme.js + graph helpers) + ref-resolution tests.
3. `lib/server/routes/export.js` + mount in `index.js` + route test.
4. `public/` Download button (index.html + client.js).
5. `lib/mcp/tools/export.js` (+ client helper, register) and `lib/cli/commands/export.js` (+ register, help).
6. README + `.claude/rules/web-chat.md` / templates note (new tool in the tool list); CHANGELOG.
7. **Bump version 0.1.0 → 0.2.0** (new feature, minor) before merge.
8. Adversarial review (focus: injection/escaping of mount html + store into the single file; ref resolution incl. `live` and unknown; theme cascade fidelity; the export running with zero network), then PR + merge.
