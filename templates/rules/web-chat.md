<!-- Managed by claude-web-chat. Edit freely; `claude-web-chat uninstall` removes this file. -->

# web-chat

This project has [claude-web-chat](https://github.com/) installed: a live browser surface paired with this terminal chat, accessed via 23 MCP tools, with every turn captured as a node in a persistent graph the user can navigate.

## What's available

- **MCP tools** (loaded into your tool list): `render`, `clear`, `list_mounts`, `save_component`, `list_components`, `get_component`, `use_component`, `get_store`, `set_store`, `get_events`, `get_graph`, `get_active`, `diff_nodes`, `get_comments`, `reply_comment`, `get_captures`, `inspect_capture`, `set_theme`, `get_theme`, `save_theme`, `list_themes`, `apply_theme`, `export`.
- **Browser surface** at `http://localhost:5173`. The user sees both this chat and that page.
- **Graph**: every turn of yours commits a node. The user can revisit any prior node, branch from it, or set a new active point. Reference nodes by their hierarchical label (`n1.7`); the stored id is opaque. Labels read as collapsed stacks of changes — `n1.x`/`n2.x` are separate top-level trees, trunk increments the last segment (`n1.1 → n1.2`), and a branch appends a segment (`n1.1.0`). `get_graph`/`get_active` surface these labels.
- **Disabled state**: if MCP returns `{disabled, scope, hint}`, the surface is off. Fall back to chat-only and pass on the hint.

## Use the surface for

- **Diagrams** — anything pictorial. SVG renders better than ASCII.
- **Multi-option decisions** — buttons + note fields beat prose questions.
- **Forms / structured input** — when the answer has shape, show the shape.
- **Comparisons & tables** — especially with > ~3 rows or multiple dimensions.
- **Anything worth revisiting** — every render is a graph-node-able artifact the user can come back to.
- **Live demos / mockups** — when proposing UI, render it instead of describing it.

## Stay in chat for

- **Discussing rendered content that doesn't need to change.** Mounts persist across turns; you don't need to re-render to reference them. Refer to them directly — by id, by what's on screen, by what the user just clicked. Re-render only when the content actually changes.
- Quick acknowledgments, status updates, one-line answers.
- Reasoning narrative — the "why" usually belongs here even when the "what" is rendered.
- A short pointer at what you just rendered, so the user knows where to look.
- Pure text the user can't interact with.

## Interactive surfaces: reading the user back

The surface is bidirectional. Don't treat it as a one-shot form ("render → user submits once → done"). You can render UI the user manipulates, get woken when they hand off, react, and re-render — a live loop you converse *through*. It's underused; reach for it whenever the work is iterative (refine a proposal, triage a list, tune options) rather than a single question.

**Channels is the wake path.** Everything queues. Wake-worthy activity on the surface — page captures, shared comment pins, and pane writes to keys you *declared* as signals — collects in the right-edge **queue rail** (server-side state). The user hitting **Push → Claude** (`P`) wakes you with the whole batch as a `<channel>` tag. Nothing wakes you on its own; the user controls *when* (the deliberate-handoff ritual is preserved). The `<channel>` carries a **summary only** — fetch bodies by tool call (`get_captures` / `inspect_capture` / `get_store`). Full contract: `docs/channels-dev.md`.

### Signal-key convention

A pane holds rich **local** state — sliders, toggles, draft text, multi-selects — but you should react to **deliberate handoffs**, not every keystroke. So:

- Give the pane an explicit affordance — an "Apply" / "Send" / "Next" / "Ask Claude" button — that writes **one signal key** to the store when clicked: e.g. `store.set({ form_submit: { seq: <n>, payload: {...} } })`. Bump `seq` (a counter or timestamp) on every click so repeats are distinguishable.
- **Declare that key on the `render`** — `signals: [{ key: 'form_submit', wake: 'queue' }]`. A declared `wake:'queue'` key folds a browser write to it into the queue rail (delivered when the user hits Push); `wake:'immediate'` wakes you the instant the pane writes it, bypassing the queue — reserve it for explicit "Ask Claude now" affordances. Declaring the signal *is* the whole reactive primitive: no wait to arm, no loop to background.
- Tell the user the signal key in chat ("the panel sends to `form_submit` when you hit Apply") so they know what's captured and what triggers you.

### How you get woken, and how you catch up

- **Channel wake (a channel is connected).** A Push (or a `wake:'immediate'` signal) delivers the batch as a `<channel>` tag mid-session. Read the summary, fetch bodies by tool call, act, and re-render the affected mount. If the interaction continues, you're simply woken again on the next Push — no re-arming.
- **Parked delivery (no channel this session).** If the Channels capability isn't live, a Push doesn't vanish: the daemon **parks** the same summary envelope and it arrives as context on the user's **next message** (the `UserPromptSubmit` hook injects it). Treat a parked delivery exactly like a channel wake — summary only, fetch bodies by tool call. The rail tells the user "delivers with your next message", so they know it rides their next turn rather than waking you now.
- **Catch-up.** At the start of any turn, whatever happened since your last one is in the log: `get_events({ since })` for the tail (it reports `gap`/`dropped` if your cursor fell off the ring — resync from `get_store` then), and `get_store` for current signal-key values. A click you never declared as a signal isn't lost; it just waits here until your next turn.

### Patterns beyond one-shot forms

- **Refine loop** — render a proposal (plan, diagram, config) with a declared Apply signal; the user nudges controls and hits Apply; on the next Push you read the knobs and re-render the *same* mount. Iteration without retyping.
- **Triage queue** — render N items, each with an approve/skip that bumps one declared signal; the user works the list and Pushes; you process the batch and update a progress pane.
- **Live control panel** — declared toggles that gate what you do next ("include tests? target runtime?"); read them (`get_store`) at the start of each turn instead of re-asking in prose.

## Component discovery before rendering

- Before rendering non-trivial UI, call `list_components` — there may already be a saved one for what you need.
- Each component carries a description. Read it before deciding to render from scratch.
- When you write something reusable, `save_component` with a specific description that answers *when to use this* (purpose, params, expected store interactions). Future invocations of you read that description to know what's available.
- Use stable mount IDs to replace-in-place. Random IDs stack indefinitely.

## Theming

The surface is themeable via 5 agent-only tools: `set_theme`, `get_theme`, `save_theme`, `list_themes`, `apply_theme`. A theme = **design tokens** (CSS custom properties, `--wc-` prefix) plus an optional **raw-CSS escape hatch**.

- **Cascade: pane → node → global.** Most-specific layer wins per token; unset tokens fall through to the layer below, then to built-in defaults. Set a layer with `set_theme {scope:'global'|'node'|'pane', target?, tokens?, css?, clear?}`. `global` is the web-chat-wide default (persists in the project's `theme.json`, falling back to `~/.web-chat/theme.json`, then builtins); `node` attaches to a graph node by its stored id (travels with the node, shows on its surface and glance preview); `pane` themes one mount by id (does **not** re-render its content).
- **Tokens cross everything.** Custom properties inherit through shadow roots, so tokens restyle both chrome and pane content. Vocabulary: `--wc-bg --wc-fg --wc-panel-bg --wc-header-bg --wc-muted --wc-border --wc-border-light --wc-accent --wc-accent-dark --wc-gold --wc-green --wc-radius --wc-radius-sm --wc-radius-lg --wc-shadow --wc-font --wc-mono`, plus `--wc-content-bg` / `--wc-content-fg` / `--wc-content-accent` for content that opts in, and `--wc-theme-transition` (swap-animation duration; `0ms` disables).
- **Raw CSS does NOT cross the shadow boundary.** At global/node scope `css` styles **chrome only**; at pane scope `css` styles **that pane's content only**. Tokens are the only lever that reaches both — reach for raw CSS only when no token fits.
- **Save & reuse.** `save_theme {name, location:'local'|'system', tokens, css, set_default?}` stores a named theme (local = this project, system = `~/.web-chat`); `apply_theme {name, scope, target?}` re-applies it; `list_themes` before composing from scratch. Theme swaps animate (~280ms) automatically.
- A component is only themeable insofar as it references `--wc-*` tokens; ones that hardcode their own colors keep them until updated to opt in.

## Local processes can drive the surface too

You're not the only writer. A local process (a dev server, test runner, file watcher) can render panes and write the store via `lib/driver.js` / the HTTP API — so a panel reflects live external state between your turns. Practical implications:

- Such panes are tagged `owner: "service:<name>"` (see Render etiquette) — don't clobber them.
- Driver writes show up in `get_events` with a `source` and fold into the next node like a user's pane clicks. But a driver write is `source:'server'`, so — unlike a browser signal — it does **not** enqueue or wake you: you see a driver's `test_run` at your next turn (catch up with `get_events`/`get_store`), never the instant it lands. Only browser/extension activity (captures, declared pane signals, shared pins) and the user's Push reach the queue.
- Drivers can stream events live over SSE; that's their channel, not your wake path.
- Full contract for driving the surface: `docs/driving-the-surface.md`.

## Exporting a page

`export` writes a graph node to a **self-contained, interactive `.html`** the user can attach to a message or email — every pane's HTML/JS, the store snapshot, and the resolved theme are inlined, so it opens in any browser with no server and no network. Reach for it when the user wants to **share, save, or send** something you rendered.

- `export({ node })` — `node` is a hierarchical label (`n1.7`), a stored id, `'active'` (default), or `'live'` (the current uncommitted surface). Returns the path of the written file under `.web-chat/exports/`.
- The export is a **frozen snapshot**: interactions still work locally (sliders move, forms fill) but persist nowhere — correct for a shareable artifact, not a live link.
- The user can also self-serve: the topbar **⬇** button downloads the node they're currently viewing (a previewed older node exports *that* node, as rendered), and `claude-web-chat export [node]` does the same from the CLI.
- Tell the user the path you wrote so they can grab and attach it.

## Turn lifecycle

- Every `render`, `set_store`, `use_component`, and `clear` during your turn folds into that turn's commit when it ends.
- Mid-turn user interactions (clicks, form submits, store writes from the page) also fold in. The lock prevents the user from re-aiming the commit point while you're working.
- You do **not** commit nodes — the harness's `Stop` hook does that. You do **not** change `active` — only the user does, via the graph viewer.
- Reference prior nodes by id ("the form from n5", "let's pick up from n11"). The user can jump to them.
- **What can wake you:** a new user prompt; a **channel wake** (the user hits **Push → Claude**, or a pane writes a key you declared `wake:'immediate'`) when a channel is connected; or a **parked delivery** folded into the user's next prompt when one isn't (see Interactive surfaces above). A user clicking a pane does **not** spontaneously start a turn — a browser signal reaches you only through the queue (on Push) or an immediate declared signal. Anything you didn't declare as a signal just accumulates in the store/event log until the user's next prompt (catch up then with `get_events({since})`).
- **The SSE stream (`/api/events/stream`) is not your wake path.** It's a push feed for *local driver processes* (see "Local processes can drive the surface too") — it can't start a Claude turn. You get woken by the channel (Push / immediate signal) or a parked delivery, never by listening to the stream. Don't reach for it to "listen."

## Render etiquette

- Don't clobber a mount the user is actively interacting with unless they asked.
- `clear` mounts that are stale — but only after capturing anything the user provided.
- Mounts persist until cleared. Don't accumulate cruft from old demos.
- When mounting alongside existing UI, use a fresh id (or omit id and let the server generate). When replacing, reuse the id.
- **Respect pane ownership.** `list_mounts` reports an `owner` per pane: `null`/`"claude"` is yours; `"service:<name>"` means a local driver process owns it. Re-rendering over a driver-owned pane is **soft-rejected** (`{ok:false, owned:true, owner}`) unless you pass `force:true` — check before clobbering, and prefer a fresh id alongside it. Your own renders are `"claude"`, so you never block yourself.

## Anti-patterns

- **Don't render trivia.** One-line answers don't need a panel.
- **Don't restate the obvious.** Once it's rendered, let the render carry the information. Chat can point and add narrative; it shouldn't transcribe what's on screen.
- **Don't re-render unchanged content** just to reference it. The mount is still there.
- **Don't render boilerplate** that should be a saved component — extract it the first or second time you write it.
- **Don't use rendering as a substitute for doing the work.** A plan render isn't a commit; a mock isn't an implementation. Build the thing.
- **Don't expect a pane to wake you on its own.** A browser write reaches you only if you *declared* its key as a signal (`wake:'queue'` → on Push; `wake:'immediate'` → at once) — an undeclared click just waits in the log for your next turn. Render the UI, declare the signal, and tell the user the key *before* you end the turn; there's no wait to arm and nothing to background.
