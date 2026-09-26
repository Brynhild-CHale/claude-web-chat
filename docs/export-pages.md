# Export a page as a self-contained attachment

A "page" in web-chat is a graph node: its panes, the store they read, and the
theme they render under. `export` writes one of those to a **single interactive
`.html` file** — every pane's HTML/JS, the store snapshot, the user's typed form
values and the resolved theme inlined — that opens in any browser with no
server, no daemon and no network. It is the thing to reach for when the user
wants to **share, save or send** something that was rendered.

## The four ways to get one

| Route | Who uses it | What you get |
| --- | --- | --- |
| `export` MCP tool — `export({ node })` | Claude | the absolute path of a file written under `.web-chat/exports/` |
| `claude-web-chat export [node]` | the user, from a terminal | the same write, path printed |
| the topbar **⬇** button | the user, from the surface | a browser download of the node currently on screen |
| `GET /api/export/:ref` | anything local | the html streamed as an attachment; add `?format=file` to write it and get back `{ path, label }` (non-browser callers only — see below) |

All four assemble through the same builder in `lib/server/export.js`, so what a
user downloads and what Claude writes are the same bytes.

## Which node — the `ref` forms

`node` / `:ref` accepts, in the order you are most likely to want them:

- a **hierarchical label** — `n1.7`, the label the graph viewer shows;
- a **stored id** — the opaque id the node carries internally;
- `'active'` — the default: where the next turn will commit;
- `'live'` — the current *uncommitted* surface, mid-turn.

Every place that takes a node ref — this export, `diff_nodes`
(`GET /api/graph/diff`), and the replay path below — resolves it through one
function, `resolveNodeRef` in `lib/server/domain/refs.js`, so the four forms
mean the same thing everywhere. A stored id is tried before a label.

An unknown ref is an error object, never a throw: the route answers 404 with
`{ error }`, and the tool and the CLI report it.

The **⬇** button exports what the user is *looking at*: previewing an older node
downloads that node as rendered, not the active one.

## What is in the file, and what is frozen

Inlined: each pane's HTML and its `<script>` bodies, the mount targets, the store
snapshot, each pane's `pane_state` and `form_state` (so typed-but-unsent values
survive into the export), and the theme resolved through the full pane → node →
global cascade.

The page mounts its panes with **the same runtime the live surface uses** —
`public/mount-runtime.js`, spliced in verbatim by
`lib/server/runtime/mount-runtime-src.js` — so a pane behaves in the export the
way it behaved on the surface.

Frozen means: interactions still work locally (sliders move, forms fill, a pane
script's own state updates) but **persist nowhere**. There is no WebSocket, no
`fetch` back to the daemon, no store round-trip. That is the right shape for an
attachment; it is not a live link. (A pane that fetches the *public* internet
still does so when the file is opened — documented, not solved.)

Files land in `.web-chat/exports/<label>-<YYYYMMDD-HHMMSS>.html`, which is
gitignored along with the rest of `.web-chat/`.

## Replaying a lineage — which nodes, in what order

A replay plays the surface forward node by node, from an earlier node down one
lineage to a later one. Which nodes it plays is decided once, by
`resolveReplayPath` (`lib/server/domain/replay-path.js`), and served read-only
as `GET /api/replay/path?from=&to=&include_collapsed=1`:

- `to` defaults to the active node; `from` defaults to the nearest **bookmarked**
  node at or above `to`, else the root of its tree. Both take the ref forms
  above except `live` — a replay is committed history. A `from` that is not an
  ancestor of `to` is refused (400, `code:'not-ancestor'`).
- It follows the graph **as the viewer draws it**: a node byte-identical to its
  parent (the ones the viewer hides) is skipped, and its prompt — plus any turns
  already folded onto it — rides in the next kept step's `folded[]`, so nothing
  it said is lost. `include_collapsed=1` plays every commit instead. The two
  endpoints are always played.
- Each step is a caption: `{id, label, author, kind, prompt, reply, summary,
  folded[], folded_count, created_at, dt_from_prev}`. `reply` is `null` on a
  node that recorded no reply summary.
- At most 200 steps; a longer lineage keeps the 200 nearest `to` and says
  `truncated: true` with the full `total_steps`.

## Design history

This file used to be the pre-implementation plan for the feature, and was linked
from the README as the user documentation for it — so a reader looking for "how
do I export a page" got PR sequencing and a version-bump instruction instead.
The plan itself is in the history (`git log -- docs/export-pages.md`). Two of its
decisions are worth carrying forward, because the code still turns on them:

- **One assembler, two deliveries.** The route streams bytes for the browser
  button (no disk write); the MCP tool and the CLI go through `?format=file`,
  which writes under `.web-chat/exports/` and returns a path, because Claude and
  scripts want a file to reference. Both call the same `buildExportHtml`.
  `?format=file` carries the "no browsers" gate from `lib/core/cors`
  (`isBrowserRequest`, the same one on `POST /api/shutdown`) and answers `403` to
  anything sending `Origin` or `Sec-Fetch-*` — a GET that writes a file and
  appends to the event ring is otherwise triggerable by any page the user is
  browsing, with an `<img>` tag. The MCP tool and the CLI reach it through
  `lib/client` (raw `http.request`), which sends neither; Node's global `fetch`
  does, so it is on the browser side of that gate too.
- **The export runtime is not a second implementation.** The plan called for a
  purpose-built ~120-line runtime; what shipped instead splices the one mount
  runtime verbatim, so the export cannot drift from the live surface. Don't
  reintroduce a copy — see the mount-runtime section of `docs/extending.md`.

The main safety concern is unchanged, and is covered by `test/export.test.js`:
pane HTML and store values are injected into one document, so the JSON payload is
escaped against `</script>` breakout, and the assembled file must contain no
`ws://` and no origin-relative fetch back to the daemon.
