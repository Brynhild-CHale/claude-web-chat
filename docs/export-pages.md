# Export a page as a self-contained attachment

A "page" in web-chat is a graph node: its panes, the store they read, and the
theme they render under. `export` writes one of those to a **single interactive
`.html` file** — every pane's HTML/JS, the store snapshot, the user's typed form
values and the resolved theme inlined — that opens in any browser with no
server, no daemon and no network. It is the thing to reach for when the user
wants to **share, save or send** something that was rendered.

## The ways to get one

| Route | Who uses it | What you get |
| --- | --- | --- |
| `export` MCP tool — `export({ node })` | Claude | the absolute path of a file written under `.web-chat/exports/` |
| `claude-web-chat export [node]` | the user, from a terminal | the same write, path printed |
| the topbar **⋯ → ↧ Export node** menu item (also ⌘K → *Export node*) | the user, from the surface | a browser download of the node currently on screen |
| the graph viewer's **↧** inspector button, or `E` | the user, from the graph | a browser download of the node selected in the graph |
| `GET /api/export/:ref` | anything local | the html streamed as an attachment; add `?format=file` to write it and get back `{ path, label }` (non-browser callers only — see below) |

All of them assemble through the same builder in `lib/server/export.js`, so what a
user downloads and what Claude writes are the same bytes.

**An export is light.** A file that is sent on has no viewer, so it is drawn in
the theme's light mode whatever mode the surface was showing, unless the request
names one: `export({ node, mode: 'dark' })` or `GET /api/export/:ref?mode=dark`.
The same holds for every replay file below (`mode` on the tool, on
`POST /api/replay/render` and on `GET /api/replay/html`); only the live player
and the graph's previews follow the viewer's mode.

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

**↧ Export node** exports what the user is *looking at*: previewing an older node
downloads that node as rendered, not the active one. The graph viewer's **↧** (and
`E`) exports whichever node is selected there instead.

## What is in the file, and what is frozen

Inlined: each pane's HTML and its `<script>` bodies, the mount targets, the store
snapshot, each pane's `pane_state` and `form_state` (so typed-but-unsent values
survive into the export), and the theme resolved through the full pane → node →
global cascade. A theme with light and dark modes is baked in its **light** mode
(a single-mode theme in its own) — the export has no viewer whose ◑ preference
it could read; see [`themes.md`](themes.md). The bundled fonts that theme names
(Geist, Geist Mono, Libre Caslon Text) are inlined too, as `data:` URIs, and
nothing else is — an unthemed page carries no font and falls back to the
reader's system stack. So are the project's brand images, when set (⋯ →
Settings → Brand; see [`themes.md`](themes.md#brand-images)): the `lockup` heads
the page and the `seal` sits in a footer, each an `<img>` with a `data:` URI. An
unset slot adds nothing to the file.

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
  node that recorded no reply summary (see below); folded entries carry theirs
  the same way.
- At most 200 steps; a longer lineage keeps the 200 nearest `to` and says
  `truncated: true` with the full `total_steps`.

### Claude's side of the turn — `trigger.reply`

A node has always recorded the prompt that started its turn
(`trigger.message`). It now records a short summary of what Claude said back,
as `trigger.reply`, so a caption can show both sides:

- The `Stop` hook (`lib/hooks/turn-end.js`) reads Claude's final message from
  its payload — `last_assistant_message`, or, on Claude Code versions without
  it, the tail of `transcript_path` (the final assistant text of the current
  turn only; the file is never read whole) — and sends it with
  `/api/turn-end` as `reply`.
- The summary is `summarizeReply` (`lib/core/reply.js`): whitespace collapsed,
  at most 280 characters, a trailing `…` when cut. The daemon re-applies it to
  whatever the request carried, so a node can never hold more.
- A turn that changed nothing commits no node; its reply rides in its
  `folded[]` entry onto the next node that does, beside its prompt.
- Additive and optional: a node or folded entry with no reply has **no
  `reply` key** — older nodes, manual commits, preserves, and a payload that
  carried nothing. No migration.
- Where it shows: one line under the trigger in the graph inspector (a folded
  turn's reply is the tooltip on its ghost row), and replay captions. It is stored only under `.web-chat/` (private, gitignored). The
  page export does not include it — an export does not carry prompts either.

## Playing a replay — the player and `replay.html`

The replay itself is ONE self-contained document,
`lib/server/replay/document.js` (`assembleReplay`): a stage, a caption bar, a
scrubber with one tick per step, and a controller
(`lib/server/replay/player.js`, spliced in as text). Every step's frame is the
node preview document above — the same page `/preview/node/:id` serves — built
as an `<iframe srcdoc>` when the step is about to be shown. So a node's page
plays as that page: markdown between and around its panes, in page order,
rendered on the host by the one renderer (`lib/server/preview` `pageItems`) and
escaped — a step's frame carries the rendered page, not the raw markdown. The
payload carries the preview template once plus each step's node and each
distinct theme, not N copies of the page, and only the previous, current and
next step are ever live documents.

- `GET /replay?from=&to=&…` serves it under the same `PREVIEW_CSP` as the node
  previews (`connect-src 'none'`, which the srcdoc frames inherit): pane
  scripts run, and nothing reaches the daemon from their own realm. (The in-app
  player frames it same-origin, unlike the sandboxed node previews, because the
  chrome drives it through its window — a recorded, accepted risk.) It names no network API itself.
- `GET /api/replay/html?from=&to=&…` is the same document as a download,
  `replay-<from>_<to>.html` — offline, no server, like a page export.
- Options (query parameters): `hold_ms` (2500; 0.5–20 s) or `pacing=realtime`
  (each step held for the real gap to the next, clamped 1–6 s), `transition`
  `cut` (default) | `fade`, `captions` `on` (default) | `none`,
  `include_prompts=1` (default off — see below), `size` (`1280x800`; the
  logical frame size, scaled to fit), `chrome=0` (stage and caption only —
  what a renderer captures), `speed` (0.25–4), `autoplay=1`,
  `at=<step index>`.
- **Your prompts are in a replay only when you say so — "Include my prompts".**
  A caption shows each node's label, its time and Claude's reply summary.
  `include_prompts=1` adds the prompt that started the turn; without it there
  is NO prompt text anywhere in the document — not the prompt, not the
  trigger's 100-character summary of it, nothing in the embedded payload JSON
  (the tests grep the bytes). `captions=none` drops the caption bar and ships
  neither prompts nor replies. A node's trigger never enters the payload. The
  retired `captions=prompt` / `captions=summary` now mean `captions=on`, and
  neither turns prompts on.
- **Where the choice lives.** The player's **Include my prompts** checkbox (off
  until you tick it, then remembered per browser) drives what you watch and
  every file you save from the player — **↧ replay.html**, **↧ GIF**, **↧ MP4**,
  **↧ WebM**. A file saved with it on renders on the first click, and the note
  that links it says *includes your prompts*. Everything else that writes a file
  defaults it OFF: the `export` MCP tool (`include_prompts: true` to include
  them), `claude-web-chat export` (`--prompts`; `--no-prompts` is the default
  spelled out) and `POST /api/replay/render` (`include_prompts: true`).

The document exposes `window.__wcReplay` — `steps`, `duration()`, `seek(ms)`,
`play()`, `pause()`, `ready()`, `stepBy(n)`, `setSpeed(x)`, `state()`,
`subscribe(fn)`. `seek` is deterministic: it resolves once the frames visible
at that time have loaded, their fonts are ready, two animation frames have run
and a short settle has passed, and the same time always draws the same frame,
whatever was shown before.

**In the browser**, the player is an overlay over the surface
(`public/app/replay.js`): it frames `/replay` and never touches the live
surface. Open it from the graph inspector (**▶ Replay**, or `R` on a selected
node), from ⌘K (**Replay to …** the node you are viewing), from ⋯ →
**Replay…**, or `R` on the surface. It plays from the nearest bookmark down to the node you are viewing
(else the active one); the `from` / `to` pickers choose any stretch of that
lineage. `Space` plays and pauses, `←` / `→` step, the scrubber seeks (hover a
tick for its label), and speed (0.5–4×), transition, captions and **Include my
prompts** are remembered per browser. **Open this node** previews the step on screen on the surface, and
**↧ replay.html** downloads what you are watching.

## Replay scripts — a replay Claude directs

A plain replay plays every drawn node at one pace. A **replay script** picks
the two moments to play between and, optionally, the beats in between, each
with its own timing and caption — for a walkthrough, a demo or a README GIF.
There is no authoring UI: Claude writes the script (the rules file's
**Replays** section teaches it when and how), or you write one as a JSON file.

```json
{
  "from": "n1.2", "to": "n1.9", "title": "How the dashboard grew",
  "default_hold_ms": 2000,
  "steps": [
    { "node": "n1.2", "hold_ms": 4000, "caption": "The first sketch" },
    { "nodes": ["n1.3", "n1.4", "n1.5"], "hold_ms": 1500, "caption": "Layout passes" },
    { "node": "n1.9", "hold_ms": 6000, "transition": "fade", "caption": "Shipped" }
  ]
}
```

- `from` / `to` — the two moments (a label, a stored id or `active`; the same
  defaults as a plain replay). `from` must be an ancestor of `to`.
- `steps` — the beats, in path order. `node` shows one node; `nodes` is a
  GROUP of consecutive nodes played as one beat: it shows the group's LAST
  node and its caption lists every node in it (`n1.3 · n1.4 · n1.5`). A
  no-change node the graph hides may sit inside a group unnamed. Nodes no step
  names are not shown. Omit `steps` and the script is the plain replay: every
  drawn node at `default_hold_ms`.
- `hold_ms` (per step, else `default_hold_ms`, else the replay's `hold_ms`)
  is clamped to 500–20000 ms; `transition` (`cut` | `fade`) is how that beat
  comes in; `caption` (cut to 280 characters) takes the place of the
  automatic reply line; `title` (cut to 120) heads the caption bar and names
  the document; `include_prompts`, when the script says it, wins over the
  request's.
- A script is checked, not guessed at: a node off the `from` → `to` path
  (`off-path`), steps out of path order or naming a node twice
  (`out-of-order`), a group with a drawn node missing from its run
  (`not-contiguous`), more than 200 steps (`too-many-steps`) or a malformed
  script (`bad-script`) is refused with `{ error, code, step }` naming the
  step. `normalizeReplayScript` (`lib/server/domain/replay-path.js`) is the
  one home of that check, and its answer is what the replay document, the
  player and the renderer all play — a plain replay is the no-steps case of
  the same model, not a second path.

Where a script goes:

| Route | Who | What happens |
| --- | --- | --- |
| `export({ script, format? })` | Claude | the script written as `replay` (the default with a script), `gif`, `mp4` or `webm` |
| `export({ script, open: true })` | Claude | the player opens in every browser watching the surface, on that script — nothing is written (`viewers: 0` says nobody saw it) |
| `claude-web-chat export --script <file.json> [--gif \| --mp4 \| --webm \| --replay \| --open]` | you, from a terminal | the same, from a JSON file (`.html` by default) |
| `POST /api/replay/render { script, … }` | anything local, JSON only | the render, as for from/to |
| `POST /api/replay/open { script } \| { from, to }` | MCP / CLI only | a `replay:open` WS frame; refused (403 `local-only`) to a browser and through the tunnel |

A browser loads a script by id — `GET /replay?script=<id>` and
`GET /api/replay/html?script=<id>` — because the headless Chrome a render
drives and the overlay both navigate to the document, and a captioned script
can outgrow a request line. The daemon holds the scripts it was given in
memory (`lib/server/replay/scripts.js`: the id is a hash of the script with
every node pinned to its stored id, the oldest of 64 goes first); after a
restart an old id is a 404 that says to open the replay again. The overlay
opened on a script keeps play / pause / scrub, speed, captions and
**Include my prompts**; its ↧ buttons render the same script, and picking a
different from / to leaves the script for a plain replay of that range.

## Replays and GIFs — a replay as a file

The same replay can be written to disk, to attach or post:

| Route | Who uses it | What you get |
| --- | --- | --- |
| `export({ format: 'gif' \| 'mp4' \| 'webm' \| 'replay', from, to, … })` MCP tool | Claude | the path of `replay-<from>_<to>-<stamp>.gif` / `.mp4` / `.webm` / `.html` under `.web-chat/exports/` |
| `claude-web-chat export [to] --gif \| --mp4 \| --webm \| --replay [--from <node>] [--hold <ms>] [--fade] [--width <px>] [--captions on\|none] [--prompts\|--no-prompts]` | the user, from a terminal | the same write, path printed |
| **↧ GIF** / **↧ MP4** / **↧ WebM** in the replay player | the user, from the surface | a render of what the player is showing, with a link to download it |
| `POST /api/replay/render` | anything local, JSON body only | `{ ok, path, label, from, to, format, frames, encoder, bytes }` |

`format: 'html'` (the default) is still the one-page export above, unchanged;
`replay` writes the replay document as a self-contained `.html` player and needs
nothing but the daemon. `mp4` (H.264) and `webm` (VP9) are the same frames as a
video, and need ffmpeg as well as a browser (below).

**A GIF is drawn by a real browser — the user's own.** There is no bundled
browser (the release keeps to its four runtime dependencies), so the daemon
looks for one (`lib/replay/find.js`): `WEB_CHAT_CHROME` if set (then it is the
only candidate, so a wrong path is reported rather than routed around), else on
macOS the Chrome, Chromium, Edge and Brave app bundles in `/Applications`, else
`google-chrome`, `chromium`, `microsoft-edge`, `brave-browser` and friends on
`PATH`. With none, a GIF request answers `422` `code: 'chrome-not-found'` with a
hint naming what to install; `GET /api/replay/capabilities` (`{ chrome, ffmpeg,
formats, gif_encoder }`, cached — `?refresh=1` looks again) says so up front,
the player disables the buttons it cannot serve, and `claude-web-chat doctor`
notes what it found.

**ffmpeg is optional, and used when it is there** (`WEB_CHAT_FFMPEG`, same
override rule, else `ffmpeg` on `PATH`; version 4.4 or later). It encodes every
format (`lib/replay/encode.js`):

- **MP4 / WebM exist only through it.** Without it, `format: 'mp4' | 'webm'`
  answers `422` `code: 'ffmpeg-not-found'` with a hint — before any browser is
  started — and the player's **↧ MP4** / **↧ WebM** are disabled with a title
  saying what to install. MP4 is H.264 and WebM VP9, both `yuv420p` (what every
  player decodes; the frame is always an even size) at a constant `fps`
  (default 10), cut to the replay's exact length.
- **A GIF prefers it.** ffmpeg computes one palette over the whole replay
  (`palettegen`) and applies it with error diffusion (`paletteuse`,
  `sierra2_4a`, limited to each frame's changed rectangle so a held frame does
  not shimmer) — smoother gradients and images than the built-in encoder's
  per-frame, undithered palette. Holds are exact to the centisecond, the last
  one included. If ffmpeg fails on a GIF, the frames already captured go through
  the built-in encoder instead and the answer carries `encoder: 'builtin'` plus
  `fallback` (ffmpeg's error); a failed MP4/WebM is a `502` `ffmpeg-failed`
  naming ffmpeg's last line of stderr. The answer's `encoder` is always the one
  that wrote the file.
- It is run with an argv this package builds (never a shell, never a value from
  the request but clamped numbers), on an `ffconcat` list of the distinct frames
  written under `.web-chat/tmp/` — a node held for 2.5 s is one image with a
  2.5 s duration — which is removed when the render ends, and it shares the
  render's wall-clock budget.

How a render works (`lib/server/replay/render.js`):

- The browser runs headless on a **throwaway profile** under `.web-chat/tmp/`,
  launched with `--remote-debugging-pipe` — the DevTools protocol over two
  inherited file descriptors, so no debugging port is ever opened
  (`lib/replay/chrome.js`). It is pointed at this daemon's own `/replay` document
  over loopback with `chrome=0`, so a frame is drawn under the same
  `PREVIEW_CSP` as every preview.
- Frames are taken where `player.js`'s own timeline says: one per step for a
  cut, and for a fade `fps` samples across the fade (default 10) then one held
  frame. Each is `seek(t)` then a screenshot; the PNG is decoded by
  `lib/core/png.js` and streamed into `lib/core/gif.js` — a per-frame median-cut
  palette (exact when a frame has ≤ 256 colours, which UI often does), LZW, and
  frame differencing, so a node held for 2.5 s is one frame and a caption change
  is a small rectangle — or, when ffmpeg is there, into ffmpeg as above. The GIF
  loops forever.
- **Prompts are left out** of anything written this way unless
  `include_prompts: true` — a file is made to be sent on, and the prompt is the
  one thing a replay carries that a page export does not. The captions still
  show each node's label, time and Claude's reply; `captions: 'none'` drops
  them. The browser is pointed at `/replay?…&include_prompts=0`, so the page it
  draws the frames from holds no prompt text either. The answer carries
  `include_prompts`, and the player's **↧ GIF** / **↧ MP4** / **↧ WebM** follow
  its **Include my prompts** checkbox (see above).
- Options: `width` (320–1920, default 960; the height follows the 16:10 frame),
  `hold_ms`, `pacing`, `transition`, `captions`, `include_prompts`, `fps` (1–30: fade sampling, and
  a video's frame rate), `from` / `to` / `include_collapsed` as for the player.
- Bounded: one render at a time (a second is `409` `busy`), at most 1000 frames
  (`413` `too-many-frames`), 64 MB of output (`413` `too-large`) and five minutes
  of wall clock, capture and encode together (`504` `timeout`). A browser that
  dies (`chrome-exited`), a page that crashes in it (`page-crashed`), a frame of
  the wrong size, or an ffmpeg that fails a video, is a `502` naming what
  happened — answered the moment it happens, even mid page load, so the render
  never sits out the five minutes holding the single flight. Every path out closes the browser — success,
  failure, the timeout, and the daemon shutting down mid-render (that render
  answers `503` `aborted`). The browser runs as the leader of its own process
  group, and teardown is bounded: `Browser.close`, then SIGTERM to the whole
  group (Chrome's helper processes included), then SIGKILL, each after a short
  grace — a wedged Chrome that ignores the first two cannot outlive its render.
  The profile is always removed, and a daemon that exits with a render still up
  SIGKILLs the group on its way out. A daemon killed outright (SIGKILL, a crash,
  power loss) cannot clean up after itself, so the next one sweeps: at boot and
  before every render it removes each `.web-chat/tmp/chrome-<pid>-*` profile and
  `frames-<pid>-*` directory whose `<pid>` is no longer running
  (`lib/replay/tmp.js`) — never one a live process owns.
- `GET /api/replay/file/:name` hands a rendered file back as a download. It
  serves only `replay-*.{gif,mp4,webm,html}` names, resolved inside
  `.web-chat/exports/` (a symlink pointing out is refused); page exports are not
  its to serve.
- The route's risk, and why it is accepted, is written at the head of
  `lib/server/routes/replay.js`: any pane can ask for a render, but what it can
  make the daemon do is exactly what the player can — one browser, fixed flags,
  pointed at the daemon's own page, then at most one ffmpeg with an argv built
  from its own paths, writing only under `exports/` — and a JSON
  body is required, so a site the user is browsing cannot trigger one at all.

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
