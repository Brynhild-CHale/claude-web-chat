---
description: Guided start on the web-chat surface, or run a web-chat CLI subcommand
argument-hint: "[subcommand] — status, open, restart, doctor, trust, ls, unlock, export, docs… (empty = guided start)"
---

<!-- Managed by claude-web-chat. Edit freely; `claude-web-chat uninstall` removes this file. -->

<!-- With a subcommand this is a straight CLI passthrough. With no arguments it runs
     the read-only `status` instead of dumping `help`, because the guided start below
     needs to know whether the surface is up before it renders into it. -->

!sh -c 'if [ "$#" -gt 0 ]; then claude-web-chat "$@"; else claude-web-chat status; fi' web-chat $ARGUMENTS

---

## Now do this

**If the user passed a subcommand** — the block above is that command's output. Report
what it says in one or two lines, calling out anything that wants their attention (a
disabled scope, a stale portfile, managed files needing a refresh, a service waiting
for approval). Then stop. Do not render anything, and do not re-run the CLI.

**If the user passed nothing** — the block above is `claude-web-chat status` for this
project, and this is a guided start. Work through these four steps.

### 1. Make sure something is watching

Read the `Server:` line above.

- `not running` → run `claude-web-chat open` in the terminal. It starts the daemon
  **and** opens the surface in the browser.
- `running at http://…` → say so and give the user that URL, so they can bring the
  tab up. A pane rendered into a daemon with no browser attached still succeeds and
  still commits to the graph — it is just seen by nobody.

If `Effective: DISABLED` appears, the surface is off for this scope. Say which scope
and how to re-enable it (`claude-web-chat on`), then stop — nothing will render.

### 2. Find out what is already available

Call `list_components`. This project ships builtins — including `git-dashboard`
(live branch/status/history) and `file-editor` (edit a file from the page) — and may
have components saved from earlier sessions. Read their descriptions; they decide
what you offer in step 3.

### 3. Render one real pane — do not describe it, render it

Take a quick look at what this project actually is (its README, its `package.json`
or equivalent, the top-level layout) so the pane is about *their* repo and not a
generic tour.

Then `render` a single pane, mount id **`web-chat-start`** (a stable id, so running
`/web-chat` again replaces it instead of stacking a second copy), containing:

- one short line saying what this page is: Claude's second surface, and every turn
  here becomes a node they can walk back to;
- **three or four concrete buttons**, each a real thing you would do next *in this
  repo* — for example "diagram how these modules fit together", "open a live git
  dashboard", "table the options for &lt;a decision this repo faces&gt;", "edit
  &lt;some config file&gt; from the page". Ground every one of them in something you
  actually saw in the project;
- a free-text field for anything not on the list.

Wire it up so a click writes **one** store key, `web_chat_start`, with a bumped
`seq`, e.g. `store.set({ web_chat_start: { seq: Date.now(), choice: 'diagram', note } })`
— and declare it on the render: `signals: [{ key: 'web_chat_start', wake: 'queue' }]`.
Query the DOM through the injected `root` (the pane's shadow root), never `document`.

### 4. Say the short version in chat

Four lines at most: where to look, that the buttons write `web_chat_start`, that
**`P`** (Push → Claude) hands their choice to you, and that `⌘K`/`Ctrl-K` opens
commands, nodes and components. Do not transcribe the pane — it is on screen.

Then wait. Their Push is your next turn.
