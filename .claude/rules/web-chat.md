<!-- Managed by claude-web-chat. Edit freely; `claude-web-chat uninstall` removes this file. -->

# web-chat

This project has [claude-web-chat](https://github.com/) installed: a live browser surface paired with this terminal chat, accessed via 24 MCP tools, with every turn captured as a node in a persistent graph the user can navigate.

## What's available

- **MCP tools** (loaded into your tool list): `render`, `clear`, `list_mounts`, `save_component`, `list_components`, `get_component`, `use_component`, `get_store`, `set_store`, `get_events`, `get_graph`, `get_active`, `diff_nodes`, `get_comments`, `reply_comment`, `get_captures`, `inspect_capture`, `set_theme`, `get_theme`, `save_theme`, `list_themes`, `apply_theme`, `export`, `write_markdown`.
- **Browser surface** in the user's browser. The port is per-project and is NOT always 5173 — the daemon walks upward from 5173, so a second project lands on 5174, a third on 5175, and so on. Never tell the user a hardcoded port: `claude-web-chat open` opens the right one, and `claude-web-chat status` prints it. The user sees both this chat and that page.
- **Graph**: a turn of yours commits a node when it changed the surface — a turn that leaves the surface byte-identical to the active node commits nothing, and its trigger folds onto the next node that does commit (`get_graph` reports the waiting count as `pending_folded`, and the eventual node carries `folded_count`). The user can revisit any prior node, branch from it, or set a new active point. Reference nodes by their hierarchical label (`n1.7`); the stored id is opaque. Labels read as collapsed stacks of changes — `n1.x`/`n2.x` are separate top-level trees, trunk increments the last segment (`n1.1 → n1.2`), and a branch appends a segment (`n1.1.0`). `get_graph`/`get_active` surface these labels. **Previews are read-only**: a user viewing an older node cannot edit it in place (typing, toggling or submitting in a previewed pane is refused with a hint to set the node active) — to work from it they make it active on the graph screen (Set active / ⑃ Branch), which first auto-commits any uncommitted live work as a `user`-authored preserve node (nothing is lost), and the next commit lands as a branch child; the original node and its downstream are always preserved. The one exception: a block the user adds from the ＋ drawer / ⌘K while previewing is added to the LIVE page in the background (the preview stays up), so a user-spawned `spawn-<component>` pane can appear on the live surface while they look at an older node. If you see an unexpected preserve node or a re-aimed active, that's what happened.
- **Disabled state**: if MCP returns `{disabled, scope, reason, hint}`, the surface is off. Fall back to chat-only and pass on the hint — `reason:'not-installed'` means this project never ran `claude-web-chat init` (so `on` would do nothing); `reason:'marker'` means someone switched it off.
- **Someone has to be watching.** A render into a daemon with no browser attached still succeeds and still commits its node — it is simply seen by nobody. If a turn opens with context saying no browser is watching, don't be talked out of rendering: render what is better shown, and point the user at `claude-web-chat open` in the same breath.
- **Remote portal.** When the user reaches surfaces through the remote portal (`claude-web-chat tunnel`), its picker lists this machine's projects as Active and Inactive and can **start** a stopped one that is already known here (its surface has booted on this machine before) — so a user away from the terminal can bring a surface up themselves. It never starts an unknown path or a project hidden from remote access; for those, the host command is still `claude-web-chat open`.

## Use the surface for

- **Diagrams** — anything pictorial. SVG renders better than ASCII.
- **Multi-option decisions** — buttons + note fields beat prose questions.
- **Forms / structured input** — when the answer has shape, show the shape.
- **Comparisons & tables** — especially with > ~3 rows or multiple dimensions.
- **Anything worth revisiting** — every render is a graph-node-able artifact the user can come back to.
- **Live demos / mockups** — when proposing UI, render it instead of describing it.
- **Live host state** — git branches/history, test runs, log tails, file browsing/editing. A **service-backed component** (below) keeps the pane current between your turns; the user watches instead of re-asking. This trigger fires on the *task* ("what's on this branch?", "watch the tests"), not on any request to render.

## Writing pages: markdown + panes

The surface is one **page**: an ordered sequence of panes and markdown items. Consecutive panes form a grid run; markdown sits between and around runs. There are no stored sections — structure comes from the prose.

- **`write_markdown({text, id?, after?})`** puts a markdown item on the page — headings and short connective prose ("## Options", a sentence of framing, a caption). Reuse `id` to rewrite one in place; omit it and the server assigns `md-<n>`.
- **`#`/`##` headings build the page's Contents nav** (numbered, `##` nested under the `#` before it; `###` is a sub-heading inside a section and gets no row), and **the first `#` heading is the page's title** — shown in the topbar and as the page's H1. A page with several parts should open with a `#` title and head each part with a heading.
- **`after`** places an item: the id of any pane or markdown item on the page, or `"start"`. `render` and `use_component` take the same `after`. Omitted, a new item appends and a re-render keeps its place. `list_mounts` returns the page `order` (and each markdown item's headings) so you can pick an anchor.
- Markdown is a small subset (paragraphs, headings, **strong**, *em*, `code`, fenced code, `-`/`1.` lists, links) and **everything is escaped** — raw HTML shows as text. Anything interactive or visual belongs in a pane.
- **Keep prose short.** The reasoning still belongs in chat; the page carries labels and framing. Text is capped, and a longer write is refused with `too_large`.
- **`place: {col, span, rows}`** on `render` / `use_component` sizes a pane on the page's 12-column grid: `col` 1–12 (omit for auto flow), `span` 2–12 columns (clamped to fit), `rows` 2–24 rows of 40px (omit for auto height). The applied placement comes back as `place`, and `list_mounts` reports every pane's current `place`. It is a *proposal*: the user can drag and resize freely (a re-render without `place` keeps their layout), and each grid run has a **↺ Claude's layout** that puts its panes back where you placed them. A pane the user has **locked** can't be moved or resized — not by them, not by you.
- Markdown is part of the surface like a pane: it folds into the turn's node, `clear` removes one by id, a page-wide `clear {}` or Wipe takes it (pinned panes stay, and so does the markdown directly above each one — its heading/caption run, back to the previous pane or the page top; put a pinned pane's heading right above it), and panes and markdown share one id space.

## Stay in chat for

- **Discussing rendered content that doesn't need to change.** Mounts persist across turns; you don't need to re-render to reference them. Refer to them directly — by id, by what's on screen, by what the user just clicked. Re-render only when the content actually changes.
- Quick acknowledgments, status updates, one-line answers.
- Reasoning narrative — the "why" usually belongs here even when the "what" is rendered.
- A short pointer at what you just rendered, so the user knows where to look.
- Pure text the user can't interact with — except the short headings and framing lines that organise a page, which go on it with `write_markdown` (see "Writing pages" above).

## Interactive surfaces: reading the user back

The surface is bidirectional. Don't treat it as a one-shot form ("render → user submits once → done"). You can render UI the user manipulates, get woken when they hand off, react, and re-render — a live loop you converse *through*. It's underused; reach for it whenever the work is iterative (refine a proposal, triage a list, tune options) rather than a single question.

**Channels is the wake path.** Everything queues. Wake-worthy activity on the surface — page captures, shared comment pins, and pane writes to keys you *declared* as signals — collects in the right-edge **queue rail** (server-side state). The user hitting **Push → Claude** (`P`) wakes you with the whole batch as a `<channel>` tag. Nothing wakes you on its own; the user controls *when* (the deliberate-handoff ritual is preserved). The `<channel>` carries a **summary only** — fetch bodies by tool call (`get_captures` / `inspect_capture` / `get_store`). Full contract: run `claude-web-chat docs channels-dev`.

### Routing is opt-out: the activity safety net

**A broken pane script is observable.** If a pane's inline `<script>` throws at mount, the failure lands in the event log as `kind:'script-error'` (mount id + message + stack head). When a pane seems unresponsive or a declared signal never fires, check `get_events` for one of these first.

**Everything the user does in a pane reaches the queue by default — you don't have to arm anything.** Undeclared browser activity (clicks on affordances, form edits, submits, undeclared store writes) coalesces server-side into **one rolling `activity` item per mount** ("form-signoff · 2 edits, 1 click · keys: draft") delivered on the user's Push. This works even if your pane's script fails at mount — the delegated listeners live in the shell, not the pane — so a broken script degrades to "generic activity + persisted form values", never silence. Item summaries carry counts and key *names* only; fetch actual values with `get_store` / `list_mounts` / `get_events`. Opt a noisy pane out with `params.routing:'none'` (service-owned panes are opted out automatically).

**Typed form values persist automatically.** Every pane's form-element state (inputs, textareas, selects, contenteditable — keyed `#<id>:<n>` by element id, `@<name>:<n>` by name, `:<n>` positional) is captured continuously into the mount's `form_state`: it survives refresh, node navigation, restarts, and your re-renders, travels with committed nodes and exports, and is rehydrated into the DOM on every remount. Read it via `list_mounts` to see what the user has typed *even if they never hit submit*. A re-render with `params.form_reset:true` drops it (use when you supply fresh prefills); mark fields `data-no-persist` to exclude them; password, hidden, and file inputs (and `contenteditable="false"`) are never captured.

### Signal-key convention (the semantic layer)

The activity layer tells you *that* the user interacted; a **declared signal** tells you *what it means*. For deliberate handoffs, still:

- Give the pane an explicit affordance — an "Apply" / "Send" / "Next" / "Ask Claude" button — that writes **one signal key** to the store when clicked: e.g. `store.set({ form_submit: { seq: <n>, payload: {...} } })`. Bump `seq` (a counter or timestamp) on every click so repeats are distinguishable.
- **Declare that key on the `render`** (or on the `use_component` — it takes the same `signals` and `force`) — `signals: [{ key: 'form_submit', wake: 'queue' }]`. A declared `wake:'queue'` key folds a browser write to it into the queue rail as a named item (delivered when the user hits Push); `wake:'immediate'` wakes you the instant the pane writes it, bypassing the queue — reserve it for explicit "Ask Claude now" affordances. Declaring the signal *is* the whole reactive primitive: no wait to arm, no loop to background.
- Tell the user the signal key in chat ("the panel sends to `form_submit` when you hit Apply") so they know what's captured and what triggers you.
- In pane scripts, query the DOM via the injected `root` (the pane's shadow root) — **never `document.querySelector`/`getElementById`**, which cannot see into the shadow DOM and kills the script at mount. Only the *queries* break: `document.createElement`/`createTextNode` are fine, and are the way to build DOM from data rather than interpolating it into `innerHTML`.

### How you get woken, and how you catch up

- **Channel wake (a channel is connected).** A Push (or a `wake:'immediate'` signal) delivers the batch as a `<channel>` tag mid-session. Read the summary, fetch bodies by tool call, act, and re-render the affected mount. If the interaction continues, you're simply woken again on the next Push — no re-arming. A channel-woken turn is a full turn: the wake acquires the turn lock and your Stop commits its own graph node if the turn changed the surface (trigger names the wake), so your woken work has first-class provenance; a woken turn that only answers in chat folds forward like any other no-change turn.
- **Parked delivery (no channel this session).** If the Channels capability isn't live, a Push doesn't vanish: the daemon **parks** the same summary envelope and it arrives as context on the user's **next message** (the `UserPromptSubmit` hook injects it). Treat a parked delivery exactly like a channel wake — summary only, fetch bodies by tool call. The rail tells the user "delivers with your next message", so they know it rides their next turn rather than waking you now.
- **Where the push came from.** A wake or parked delivery says where the user pushed from: `push_origin="remote"`/`device="mobile"` on the `<channel>` tag, and a `Pushed from: origin=… device=…` line in its summary. **`origin=remote`** means the push came through the tunnel portal: assume the user cannot reach this terminal. Answer on the surface (render, or `reply_comment` in-thread), don't ask them to run a command, and keep the chat short. **`device=mobile`** means a phone-sized screen, so prefer compact, single-column panes. On a phone the panes' content is fully interactive (forms, buttons, declared signals, `api.spawn`) but the layout is fixed — the user cannot move, resize, pin, minimize or close panes there — so a pane the user must act on should be complete as rendered.
- **Catch-up.** At the start of any turn, whatever happened since your last one is in the log: `get_events({ since })` for the tail (it reports `gap`/`dropped` if your cursor fell off the ring — resync from `get_store` then), `get_store` for current signal-key values, and `list_mounts` for each pane's `form_state` (the user's typed-but-unsent values). Undeclared interactions also queue as per-mount activity items, so a Push tells you *which* panes saw action; these sources tell you what it was.

### Patterns beyond one-shot forms

- **Refine loop** — render a proposal (plan, diagram, config) with a declared Apply signal; the user nudges controls and hits Apply; on the next Push you read the knobs and re-render the *same* mount. Iteration without retyping.
- **Triage queue** — render N items, each with an approve/skip that bumps one declared signal; the user works the list and Pushes; you process the batch and update a progress pane.
- **Live control panel** — declared toggles that gate what you do next ("include tests? target runtime?"); read them (`get_store`) at the start of each turn instead of re-asking in prose.

### Panes can spawn panes

A pane script gets `api` beside `store` and `root`: `api.spawn({id?, component?, params?, html?, after?, place?})` puts up a child pane (exactly one of `component` / `html`; by default it lands beneath its parent, after any earlier children, with id `<parent>-<n>`), and `api.close(id)` takes one down. Both return a promise of the daemon's envelope (`{ok, id}` or `{ok:false, …, hint}`) and never throw — in an export or a preview they answer `{ok:false}` and do nothing.

- **A child is owned by its parent** (`owner: "pane:<parent>"`). A pane may re-spawn (replace) and close only its own children, or close itself — never your panes, a driver's, or another pane's children. A child the user **locked** refuses both.
- **For you it is like a driver's pane:** re-rendering or clearing one is soft-rejected (`owned:true`) unless you pass `force:true`, and a bulk `clear` that would take one is rejected whole. Children outlive a closed parent (the user sees each one's parent on its header, and "· closed" once it has gone).
- **Caps:** 20 live children per parent, 60 pane-spawned panes in all, 3 generations deep, 30 spawn/close calls per parent per 10 s, 256 KB of html and 16 KB of params per spawn. A refusal names its `cap`.
- **A spawned pane cannot declare wake signals** — `params.signals` is stripped (with a `warning`), so only you decide what wakes you.
- Reach for it when one pane's content decides what else belongs on the page (a list that opens a detail pane per row, a launcher of saved components). Prefer `component` to raw `html`; raw-HTML spawn is the risky form and may be refused on a remote surface.

## Component discovery before rendering

- Before rendering non-trivial UI — **and before answering a live-host-state ask (git, tests, logs, files) with one-shot terminal output** — call `list_components`; a saved or builtin component may already do it, live.
- Each component carries a description. Read it before deciding to render from scratch.
- When you write something reusable, `save_component` with a specific description that answers *when to use this* (purpose, params, expected store interactions). Future invocations of you read that description to know what's available.
- Use stable mount IDs to replace-in-place. Random IDs stack indefinitely.

### Service-backed components

A saved component can carry a host-side `service.js` that the daemon runs while its pane is on the **active node and a browser is watching** — it writes the shared store and the pane reacts, so the surface reflects live host state (git, test runs, file watches) between your turns, with no turn of yours involved.

- **Author** one by passing `service` (and optionally `seed`) to `save_component`; `list_components` marks these `has_service`. Build the pane to read its data from the store and render reactively; the service supplies that data via `ctx.driver.setStore(...)`.
- **First run waits on a TERMINAL approval — tell the user the command.** A service is host code running on the user's machine, so it does not start until they run `claude-web-chat trust <name>` in their terminal (bare `claude-web-chat trust` lists what is waiting; `--deny` refuses and stops the asking). The surface only shows a notice naming the command; it cannot grant the approval, because the component's own pane script runs in that page. Consent is recorded per **(project root, `service.js` contents, params)** in `~/.web-chat/services/trusted.json`, so editing the service, using it in another project, or spawning it with different params each ask again (render-control params — `form_reset`, `routing`, `signals` — are not part of that identity, so re-rendering a pane never re-asks). Two panes of one component with different params are two approvals: `claude-web-chat trust <name>` then refuses and asks the user to pick one with the `--params-fp` its listing prints, or take all of them with `--all`. If you mount a service-backed pane and don't say the command, the pane just sits there empty. Nothing runs headless (no viewer) or off the active node — navigating away stops the service, navigating back respawns it.
- **Make it interactive** by having the pane write a *control key* (e.g. `git_ctl`) the service watches over SSE and responds to — a live loop that does **not** wake you (it's a service reaction, not a declared signal). Reach for this for dashboards/browsers, not one-shot forms.
- **Crib from the builtins.** `git-dashboard` and `file-editor` ship canonical `service.js` implementations (SSE control-key loop, fs-watch + poll, store push) — `get_component` one before authoring a service from scratch.
- **Trigger on the task, not the word "render".** "What's on this branch", "keep an eye on the tests", "tail that log", "let me edit that file" are service-component asks even though nobody asked for UI — check `list_components` before reaching for one-shot terminal output. Builtins already cover git (`git-dashboard`) and file editing (`file-editor`).
- The service is a driver (`owner: "service:<name>"`, see below) the daemon supervises for you. Full contract: run `claude-web-chat docs service-components`.

## Theming

The surface is themeable via 5 agent-only tools: `set_theme`, `get_theme`, `save_theme`, `list_themes`, `apply_theme`. A theme = **design tokens** (CSS custom properties, `--wc-` prefix) plus an optional **raw-CSS escape hatch**.

- **Cascade: pane → node → global.** Most-specific layer wins per token; unset tokens fall through to the layer below, then to built-in defaults. Set a layer with `set_theme {scope:'global'|'node'|'pane', target?, tokens?, css?, clear?}`. `global` is the web-chat-wide default (persists in the project's `theme.json`, falling back to `~/.web-chat/theme.json`, then builtins); `node` attaches to a graph node by its stored id (travels with the node, shows on its surface and glance preview); `pane` themes one mount by id (does **not** re-render its content).
- **Tokens cross everything.** Custom properties inherit through shadow roots, so tokens restyle both chrome and pane content. Core vocabulary: `--wc-bg --wc-fg --wc-fg-bright --wc-panel-bg --wc-header-bg --wc-muted --wc-muted-dim --wc-border --wc-border-light --wc-border-soft --wc-accent --wc-accent-dark --wc-accent-fg --wc-accent-text --wc-gold --wc-gold-bg --wc-gold-fg --wc-green --wc-green-fg --wc-comment --wc-rust --wc-edge --wc-scrim --wc-radius --wc-radius-sm --wc-radius-lg --wc-shadow`, the type stacks `--wc-font --wc-mono --wc-display` (headings) `--wc-reading` (prose), plus `--wc-content-bg` / `--wc-content-fg` / `--wc-content-accent` for content that opts in, and `--wc-theme-transition` (swap-animation duration; `0ms` disables). The full canonical table (text ramp, depth layers, elevation, chrome surfaces): run `claude-web-chat docs themes`.
- **Packs and light/dark.** The builtins are packs, each with a light and a dark mode: `earthy` (the stock look), `paper` and `georgetown-blue` (Georgetown Blue — `georgetown` still applies it). Light/dark is a **mode inside a theme**: a theme may carry `modes: {light: {tokens, css?}, dark: {tokens, css?}}` over its mode-free `tokens` (on `set_theme` and `save_theme` alike); the viewer's ◑ toggle flips the mode within the current global theme, and is disabled when that theme declares one mode. `get_theme` resolves light unless you pass `mode:'dark'`.
- **Raw CSS does NOT cross the shadow boundary.** At global/node scope `css` styles **chrome only**; at pane scope `css` styles **that pane's content only**. Tokens are the only lever that reaches both — reach for raw CSS only when no token fits.
- **Save & reuse.** `save_theme {name, location:'local'|'system', tokens, css, set_default?}` stores a named theme (local = this project, system = `~/.web-chat`); `apply_theme {name, scope, target?}` re-applies it; `list_themes` before composing from scratch. Theme swaps animate (~280ms) automatically.
- **Installed themes.** A theme someone published as a pack installs from its GitHub link. When the user wants one they did not write, suggest `claude-web-chat pack get <url>`, then `pack review <name>` and `pack approve <name>` (or ＋ → Manage → **Download for review**): a link to a theme cannot show whether the repository also ships components or a service. Keep `pack install <url>` for a pack the user wrote. Once installed it lists in `list_themes` like a saved theme, and may bring logos that fill empty brand slots while it is the global theme.
- A component is only themeable insofar as it references `--wc-*` tokens; ones that hardcode their own colors keep them until updated to opt in.

## Local processes can drive the surface too

You're not the only writer. A local process (a dev server, test runner, file watcher) can render panes and write the store via `lib/driver.js` / the HTTP API — so a panel reflects live external state between your turns. Practical implications:

- Such panes are tagged `owner: "service:<name>"` (see Render etiquette) — don't clobber them.
- Driver writes show up in `get_events` with a `source` and fold into the next node like a user's pane clicks. But a driver write is `source:'server'`, so — unlike a browser signal — it does **not** enqueue or wake you: you see a driver's `test_run` at your next turn (catch up with `get_events`/`get_store`), never the instant it lands. Only browser/extension activity (captures, declared pane signals, shared pins) and the user's Push reach the queue.
- Drivers can stream events live over SSE; that's their channel, not your wake path.
- Full contract for driving the surface: run `claude-web-chat docs driving-the-surface`.

## Exporting a page

`export` writes a graph node to a **self-contained, interactive `.html`** the user can attach to a message or email — every pane's HTML/JS, the store snapshot, and the resolved theme are inlined, so it opens in any browser with no server and no network. Reach for it when the user wants to **share, save, or send** something you rendered.

- `export({ node })` — `node` is a hierarchical label (`n1.7`), a stored id, `'active'` (default), or `'live'` (the current uncommitted surface). Returns the path of the written file under `.web-chat/exports/`.
- The export is a **frozen snapshot**: interactions still work locally (sliders move, forms fill) but persist nowhere — correct for a shareable artifact, not a live link.
- The user can also self-serve: the topbar **⋯ → ↧ Export node** menu item (also in the ⌘K palette) downloads the node they're currently viewing (a previewed older node exports *that* node, as rendered), the graph viewer's **↧** inspector button (or `E`) downloads the selected node, and `claude-web-chat export [node]` does the same from the CLI.
- **To show how the work evolved**, `export({ format: 'gif' })` renders a *replay* — the surface played node by node from `from` (default: the nearest bookmark) down to `to` (default: active) — as an animated GIF, and `format: 'replay'` writes the same as a self-contained `.html` player. A GIF needs a Chrome-family browser on the machine; `{code:'chrome-not-found', hint}` means there is none — pass the hint on and offer `format: 'replay'`. `format: 'mp4'` / `'webm'` render the same replay as a video and also need ffmpeg; `{code:'ffmpeg-not-found', hint}` means there is none — pass the hint on and offer `gif`. Captions show each node's label, time and Claude's reply summary and leave the user's prompts out; pass `include_prompts: true` only when the user wants their prompts in the file (`captions: 'none'` drops captions).
- Tell the user the path you wrote so they can grab and attach it.

## Replays

A plain replay plays every node at one pace. When the user wants a **walkthrough, a demo, or a README GIF** of how something evolved, *direct* it with a replay **script** on `export`:

- `get_graph`, then pick the two moments that bound the story: `script: { from, to, title?, steps: [...] }`.
- `steps` run in path order: `{ node, hold_ms?, caption?, transition?, scroll? }` for a moment that matters, `{ nodes: [...] }` to fold a run of consecutive in-between nodes into ONE beat (it shows the last; the caption lists them). Nodes no step names are skipped. Give the key moments long holds (4000–6000 ms), quick beats short ones (1000–1500), and a few-word caption each — it replaces the automatic reply line.
- Each frame smooth-scrolls to what its step changed: the newest pane's top to the top of the window, then down to changes below the fold. A step's `scroll` directs it — `'none'` holds still, or the id of one pane or markdown item on that node's page to look at it instead (default `'auto'`).
- `export({ script, open: true })` plays it in the user's browser player first — nothing is written; then export the same script as `format: 'gif'` (or `'replay'` / `'mp4'` / `'webm'`). A refused script comes back as `{error, code, step}` naming the step — fix it and call again.
- There is no authoring UI: scripts are yours to write. The user runs one from a terminal with `claude-web-chat export --script <file.json> [--gif]`.

## Turn lifecycle

- Every `render`, `write_markdown`, `set_store`, `use_component`, and `clear` during your turn folds into that turn's commit when it ends.
- Mid-turn user interactions (clicks, form submits, store writes from the page) also fold in. A user re-aim (jump/wipe/new-graph/branch) during your turn isn't rejected — it's **queued** and applied right after your turn's commit, so don't be surprised when `active` moves the moment your turn ends.
- **Pane history.** The user can put an older version of one of your panes back (◷ on the pane's header → pick a version → "Make current"). It keeps you as the owner, shows in `get_events` as a `render` with `source:'history'`, and folds into the next commit like any user edit — so if a pane's content went backwards without you, that is why. Don't re-render over it unless asked.
- You do **not** commit nodes — the harness's `Stop` hook does that. You do **not** change `active` — only the user does, via the graph viewer.
- Reference prior nodes by the hierarchical label the user can see ("the form from `n1.4`", "let's pick up from `n2.0`") — the stored id is opaque and never on their screen. The user can jump to them from the graph viewer.
- **What can wake you:** a new user prompt; a **channel wake** (the user hits **Push → Claude**, or a pane writes a key you declared `wake:'immediate'`) when a channel is connected; or a **parked delivery** folded into the user's next prompt when one isn't (see Interactive surfaces above). A user clicking a pane does **not** spontaneously start a turn — a browser signal reaches you only through the queue (on Push) or an immediate declared signal. Anything you didn't declare as a signal just accumulates in the store/event log until the user's next prompt (catch up then with `get_events({since})`).
- **The SSE stream (`/api/events/stream`) is not your wake path.** It's a push feed for *local driver processes* (see "Local processes can drive the surface too") — it can't start a Claude turn. You get woken by the channel (Push / immediate signal) or a parked delivery, never by listening to the stream. Don't reach for it to "listen."

## Render etiquette

- Don't clobber a mount the user is actively interacting with unless they asked.
- `clear` mounts that are stale — but only after capturing anything the user provided.
- Mounts persist until cleared. Don't accumulate cruft from old demos.
- When mounting alongside existing UI, use a fresh id (or omit id and let the server generate). When replacing, reuse the id.
- **The shell's own element ids are reserved.** `main`, `topbar`, `status`, `dock`, `stage`, `overlay`, `drawer`, `minbar`, `queue-rail`, `cmd-palette` and the rest of the chrome are refused with `{ok:false, reserved:true, hint}` on `render` and `use_component`. Prefix your mount ids and it never comes up.
- **Respect pane ownership.** `list_mounts` reports an `owner` per pane: `null`/`"claude"` is yours; `"service:<name>"` means a local driver process owns it; `"pane:<id>"` means another pane spawned it. Re-rendering over a driver-owned pane is **soft-rejected** (`{ok:false, owned:true, owner}`) unless you pass `force:true` — check before clobbering, and prefer a fresh id alongside it. `clear` is gated identically, and a bulk `clear` (`{}` or a whole `target`) that would take a driver-owned pane is rejected **whole**, not half-applied (a pinned one the clear keeps doesn't count) — clear your own panes by id instead; `force:true` on a bulk clear also takes every pinned pane, the user's included. Your own renders are `"claude"`, so you never block yourself.

## Anti-patterns

- **Don't render trivia.** One-line answers don't need a panel.
- **Don't restate the obvious.** Once it's rendered, let the render carry the information. Chat can point and add narrative; it shouldn't transcribe what's on screen.
- **Don't re-render unchanged content** just to reference it. The mount is still there.
- **Don't render boilerplate** that should be a saved component — extract it the first or second time you write it.
- **Don't use rendering as a substitute for doing the work.** A plan render isn't a commit; a mock isn't an implementation. Build the thing.
- **Don't expect a pane to wake you on its own.** Nothing wakes you except the user's Push or a declared `wake:'immediate'` signal. Undeclared interactions aren't lost — they coalesce into per-mount activity items delivered on Push, and typed values persist in `form_state` — but they arrive as generic "the user did things here", so for anything with meaning (a submit payload, an approval) still declare a signal and tell the user the key *before* you end the turn.
