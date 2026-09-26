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
- Where it shows: one line under TRIGGER in the graph inspector, and replay
  captions. It is stored only under `.web-chat/` (private, gitignored). The
  page export does not include it — an export does not carry prompts either.

## Playing a replay — the player and `replay.html`

The replay itself is ONE self-contained document,
`lib/server/replay/document.js` (`assembleReplay`): a stage, a caption bar, a
scrubber with one tick per step, and a controller
(`lib/server/replay/player.js`, spliced in as text). Every step's frame is the
node preview document above — the same page `/preview/node/:id` serves — built
as an `<iframe srcdoc>` when the step is about to be shown. The payload carries
the preview template once plus each step's node and each distinct theme, not N
copies of the page, and only the previous, current and next step are ever live
documents.

- `GET /replay?from=&to=&…` serves it under the same `PREVIEW_CSP` as the node
  previews (`connect-src 'none'`, which the srcdoc frames inherit): pane
  scripts run, nothing reaches the daemon. It names no network API itself.
- `GET /api/replay/html?from=&to=&…` is the same document as a download,
  `replay-<from>_<to>.html` — offline, no server, like a page export.
- Options (query parameters): `hold_ms` (2500; 0.5–20 s) or `pacing=realtime`
  (each step held for the real gap to the next, clamped 1–6 s), `transition`
  `cut` (default) | `fade`, `captions` `prompt` (default) | `summary` | `none`,
  `size` (`1280x800`; the logical frame size, scaled to fit), `chrome=0` (stage
  and caption only — what a renderer captures), `speed` (0.25–4), `autoplay=1`,
  `at=<step index>`.
- **Captions carry only what their mode shows.** `prompt` shows the prompt and
  Claude's reply summary; `summary` the prompt's short summary and the reply;
  `none` neither — and the payload holds nothing more than that. A node's
  trigger never enters it, so a `replay.html` made with `captions=none` does
  not contain the prompts at all. The prompt is the only thing a replay carries
  that a page export does not; choose `summary` or `none` before sending one on.

The document exposes `window.__wcReplay` — `steps`, `duration()`, `seek(ms)`,
`play()`, `pause()`, `ready()`, `stepBy(n)`, `setSpeed(x)`, `state()`,
`subscribe(fn)`. `seek` is deterministic: it resolves once the frames visible
at that time have loaded, their fonts are ready, two animation frames have run
and a short settle has passed, and the same time always draws the same frame,
whatever was shown before.

**In the browser**, the player is an overlay over the surface
(`public/app/replay.js`): it frames `/replay` and never touches the live
surface. Open it from the graph inspector (**▶ Replay**, or `R` on a selected
node), from ⌘K (**Replay to …** the node you are viewing), or from ⋯ →
**Replay…**. It plays from the nearest bookmark down to the node you are viewing
(else the active one); the `from` / `to` pickers choose any stretch of that
lineage. `Space` plays and pauses, `←` / `→` step, the scrubber seeks (hover a
tick for its label), and speed (0.5–4×), transition and captions are remembered
per browser. **Open this node** previews the step on screen on the surface, and
**↧ replay.html** downloads what you are watching.

## Replays and GIFs — a replay as a file

The same replay can be written to disk, to attach or post:

| Route | Who uses it | What you get |
| --- | --- | --- |
| `export({ format: 'gif' \| 'mp4' \| 'webm' \| 'replay', from, to, … })` MCP tool | Claude | the path of `replay-<from>_<to>-<stamp>.gif` / `.mp4` / `.webm` / `.html` under `.web-chat/exports/` |
| `claude-web-chat export [to] --gif \| --mp4 \| --webm \| --replay [--from <node>] [--hold <ms>] [--fade] [--width <px>] [--captions …]` | the user, from a terminal | the same write, path printed |
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
- **Captions default to `summary`** for anything written this way — a file is
  made to be sent on, and a prompt is the one thing a replay carries that a page
  export does not. `captions: 'prompt'` includes them; the player's **↧ GIF** /
  **↧ MP4** / **↧ WebM** follow the player's caption choice, and with `prompt`
  selected the first click only warns that the prompts will be in the file.
- Options: `width` (320–1920, default 960; the height follows the 16:10 frame),
  `hold_ms`, `pacing`, `transition`, `captions`, `fps` (1–30: fade sampling, and
  a video's frame rate), `from` / `to` / `include_collapsed` as for the player.
- Bounded: one render at a time (a second is `409` `busy`), at most 1000 frames
  (`413` `too-many-frames`), 64 MB of output (`413` `too-large`) and five minutes
  of wall clock, capture and encode together (`504` `timeout`). A browser that
  dies or draws a frame of the wrong size, or an ffmpeg that fails a video, is a
  `502` naming what happened. Every path out closes the browser —
  `Browser.close`, then a kill — and removes its profile.
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
