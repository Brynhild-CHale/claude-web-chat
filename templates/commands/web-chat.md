---
description: Guided start on the web-chat surface, or run a web-chat CLI subcommand
argument-hint: "[subcommand] — init, status, open, restart, doctor, trust, ls, unlock, export, docs… (empty = guided start)"
---

<!-- Managed by claude-web-chat. Edit freely; `claude-web-chat uninstall` removes this file. -->

<!-- With a subcommand this is a straight CLI passthrough. With no arguments it runs
     the read-only `status` instead of dumping `help`, because the guided start below
     needs to know whether the surface is up before it renders into it.

     `init` is special-cased to `init --report`. Bare `claude-web-chat init` INSTALLS
     and PROMPTS; a slash command must never do either behind the user's back, and a
     prompt has no terminal here to answer it. `--report` is the read-only twin:
     doctor runs with dryRun, nothing is written, and the state block below is the
     handoff Claude reads. -->

!sh -c 'case "${1:-}" in "") claude-web-chat status ;; init) shift; claude-web-chat init --report "$@" ;; *) claude-web-chat "$@" ;; esac' web-chat $ARGUMENTS

---

## Now do this

**If the user passed a subcommand other than `init`** — the block above is that
command's output. Report what it says in one or two lines, calling out anything that
wants their attention (a disabled scope, a stale portfile, managed files needing a
refresh, a service waiting for approval). Then stop. Do not render anything, and do
not re-run the CLI.

**If the user passed `init`** — jump to the `init` section below.

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

---

### If the subcommand was `init`

The block above is `claude-web-chat init --report`: a human-readable report followed
by a `--- WEB-CHAT-STATE ---` fence and one JSON object. That JSON is your input.

**Hard first rule — trust your own tool list over the report.** If `render` is not in
your tools, the MCP server has not been loaded into this session. Print exactly this
and run nothing else:

> The web-chat tools aren't in this session yet. `/exit`, reopen Claude Code in this
> project, then run `/web-chat init` again. Claude Code reads `.mcp.json` only at
> startup.

`init` and bare `/web-chat` divide the work: **`init` teaches web-chat and owns the
wiring; bare `/web-chat` teaches web-chat about *their repo* and owns the everyday
first pane.** They use different mount ids (`web-chat-tour` vs `web-chat-start`) so
neither clobbers the other.

#### If the state block says `"mode": "existing"`

This user is not new. Do **not** re-explain the surface, and do **not** render a
cleanup checklist pane — a pane cannot execute anything, so it would just add round
trips in front of a terminal question they are already standing at.

Count the items in the state block that need a **human decision**: `doctor.problems`,
a non-empty `drift`, `toggle.effective` not `"enabled"`, `pending_services`,
`restart.state === "stale"`, `latest.newer`. Then:

- **Zero** → one line in chat saying it's healthy and where the surface is. Render nothing.
- **One** → ask it in chat as a plain question, with the command that fixes it.
- **Two or more** → still chat. List them with their commands, most blocking first.

#### If the state block says `"mode": "fresh"`

Nothing is installed here yet, so there is nothing for you to pick up. Tell them to
run `claude-web-chat init` in the terminal — it prompts before writing anything.

#### Otherwise: the beats

**Beat A — pick up the handoff.** The page ran a tour before you existed.

1. `get_store(['web_chat_init'])` and `list_mounts`.
2. `clear` the mounts `web-chat-tour` and `web-chat-tour-mirror`. They are unowned,
   so no `force` is needed. Do this first, so the surface is clean.
3. Then **do the thing they asked for in step 3 of the tour** — for real, in this
   repo. `web_chat_init.choice` is `architecture`, `git`, or `other` (with
   `web_chat_init.note`). Not a mock, not a plan: the actual work.
4. If they left text in `form_state` (from `list_mounts`) but never pressed Send,
   **quote their unsubmitted text back to them** and act on it. Being quoted
   something you never submitted is the moment the surface stops feeling like a form.

**Beat B — the graph, now that one exists.** The tour deliberately did not fake a
graph node: only the `Stop` hook commits, and the CLI is not a turn. After beat A
there is a real one.

- `get_active`, name the label of the node your previous turn committed.
- Ask them to press **`G`** and walk back one node, to see the surface as it was
  before beat A.
- Explain branch-on-edit **only if it actually fires** — the instant a `user`-authored
  preserve node appears. That is the only moment the concept is cheap to explain.

**Beat C — live host state, offered not forced.** Ask first; if they want it:

- `use_component('git-dashboard')` on this repo. The supervisor will refuse and file
  a pending approval, because a service is host code.
- Send them to **`claude-web-chat trust git-dashboard`** in the terminal, with one
  sentence of why only a terminal can grant it: a component's own pane script runs in
  the surface's realm with no CSP, so nothing rendered in the page can gate the host
  code asking for the grant.
- Not a git repo? Use `file-editor` on a real file in the project instead.

**Close — the three rough edges, stated plainly.**

- `claude-web-chat update` today shells out to
  `npm i -g git+https://github.com/Brynhild-CHale/claude-web-chat.git`. Distribution is
  moving to GitHub Releases and this command has not caught up.
- Channels is a gated research preview. Quote the launch command from the init report
  verbatim — never invent or fork it.
- Page capture needs the browser extension sideloaded; `claude-web-chat open extensions`
  shows the folder.

Then hand off: bare `/web-chat` is the everyday entry from here.
