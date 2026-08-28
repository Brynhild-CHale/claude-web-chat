# claude-web-chat

claude-web-chat gives Claude Code a second surface: a live page in your browser that Claude draws on while you talk in the terminal. Diagrams, forms, comparisons, working mockups — anything better shown than described lands on the page, stays interactive, and becomes a step in a graph you can walk back through and branch. Thanks for checking it out.

You get three things:

- **Chat**, in your terminal, same as always — reasoning, narrative, quick answers.
- **The surface**, in your browser — everything visual and interactive. What you click and type there flows straight back to Claude as structured data. (`claude-web-chat open` opens it; the port is per-project, starting at 5173 and walking upward, so a second project gets its own.)
- **The graph** — every Claude turn is saved as a node. Revisit any earlier state, branch from it, and carry on. Trying a different direction never loses the first one.

The quickstart below takes you from a fresh checkout to your first interactive page in about five minutes.

## Quickstart

You'll need **Node 22+** and **Claude Code** already installed, on **macOS or Linux** (Windows via WSL2 — see [platform support](docs/platform-support.md)).

### 1. Install the package

One line in a terminal:

```sh
curl -fsSL https://raw.githubusercontent.com/Brynhild-CHale/claude-web-chat/main/install.sh | sh
```

That checks you have Node 22+, downloads the latest **GitHub Release**, verifies its SHA-256 checksum, and unpacks it — no npm, no registry, no sudo. Everything lands in your home directory:

```
~/.web-chat/versions/0.6.0/     the release, self-contained (dependencies included)
~/.web-chat/current      ->     versions/0.6.0      (rollback = one symlink swap)
~/.local/bin/claude-web-chat -> ~/.web-chat/current/bin/claude-web-chat.js
```

The script is short and does nothing but that — [read it](https://raw.githubusercontent.com/Brynhild-CHale/claude-web-chat/main/install.sh) before piping it to a shell if you like. Re-running it is always safe.

Verify it worked:

```sh
claude-web-chat help
```

You should see the command list. If your shell can't find it, `~/.local/bin` isn't on your PATH — the installer prints the exact `export PATH=…` line to add to your shell profile.

`claude-web-chat version` answers a question that matters more than it sounds: **which copy am I actually running?** It prints the running tree, what `~/.web-chat/current` points at, and what the `claude-web-chat` on your PATH resolves to, and shouts if those disagree.

**Platforms.** macOS and Linux are supported — the full suite runs on both in CI on every push. **On Windows, use WSL2**: web-chat installs and runs inside your WSL2 Linux environment like any other Linux install, and there is no native Windows installer. What each of those actually means, and what is known to be untested, is in [`docs/platform-support.md`](docs/platform-support.md).

**Developing on web-chat itself?** Work from a checkout and run it in place — see [`docs/extending.md`](docs/extending.md), which also explains why `npm link` is the one thing not to do here:

```sh
git clone https://github.com/Brynhild-CHale/claude-web-chat.git
cd claude-web-chat
npm install
node bin/claude-web-chat.js help
```

### 2. Wire it into a project

web-chat is opt-in per project. In any project where you want it:

```sh
cd ~/Dev/my-project
claude-web-chat init
```

`init` is the one entry point, and it works out for itself which of two jobs it is doing. In a project with no `.web-chat/` it is first-time setup: it lists every file it is about to create or edit, asks once, runs the install, offers to open the surface, and leaves a short interactive tour on the page for you to work through while Claude Code restarts. In a project that already has web-chat it is orientation and repair instead: it runs `doctor`, reports managed-file drift, lists every web-chat surface running on your machine and which project each one is, and offers — one confirm-first question at a time, defaulting to the safe answer — to fix what it found. It never reaps another project's daemon, runs `update`, discards your local edits, or approves a service without you saying yes.

Under the hood the setup step is `claude-web-chat install`, which you can still run directly: it adds the web-chat MCP server to `.mcp.json`, merges two hooks into `.claude/settings.json` (existing hooks are preserved), drops usage guidance for Claude into `.claude/rules/` plus a `/web-chat` slash command and two skills into `.claude/`, creates `.web-chat/` for the project's graph and components, adds `.web-chat/` to the project's `.gitignore`, and pre-warms the background server. Your `CLAUDE.md` is never touched, and re-running either command is always safe.

`claude-web-chat init --report` (or `--json`) is the read-only twin: it diagnoses without repairing, writes nothing, prompts for nothing, and exits non-zero when something needs attention — which is what `/web-chat init` runs, and what makes it usable as a CI health gate.

### 3. Restart Claude Code

Claude Code reads `.mcp.json` at startup, so restart it in this project. On first launch it will ask you to trust the new `web-chat` MCP server — approve it, or the tools won't load.

### 4. Open the surface

```sh
claude-web-chat open
```

This starts the background server (if it isn't already running) and opens the surface in your browser. It greets you with a **Nothing rendered yet** card — the empty state, listing the four keys worth knowing (`⌘K` commands, `N` components, `G` graph, `P` push). That's correct; nothing has been rendered yet.

> Prefer one command? `claude-web-chat launch` opens the surface *and* starts a Claude session together.

### 5. Render your first page

Back in Claude Code, type:

```
/web-chat
```

With no arguments that slash command is a guided start: Claude checks the surface is up, looks at what your project actually is, and renders a first pane with a few concrete things it could do next — click one, hit **P**, and Claude picks it up. (With an argument it's a plain CLI passthrough: `/web-chat status`, `/web-chat restart`, `/web-chat doctor`.)

Or just ask, in your own words:

> Sketch this project's architecture as a diagram on the surface.

Within a few seconds the diagram appears in the browser. Notice the graph rail: a node was committed for that turn. Now try something interactive:

> Give me a small form on the surface to choose which module we refactor first, with a note field.

Fill it in, hit the submit button, and tell Claude "check the form" — your choices arrive on Claude's side as data, not a screenshot. When a pane is meant to drive a longer back-and-forth, Claude will name a **signal key** in chat and wait on it, reacting each time you hit Apply.

That's the core loop: you talk in the terminal, Claude shows its work in the browser, and your clicks talk back.

## Everyday use

A few things worth knowing once you're past the first render:

**Ask for the page, not prose.** Multi-option decisions, comparison tables, forms, live UI mockups — say "on the surface" and Claude renders them instead of describing them. Panes persist across turns, so Claude (and you) can refer back to one without re-rendering it.

**Use the graph like an undo tree.** Nodes are labeled hierarchically — `n1.7` is the seventh step on the first trunk, `n1.7.0` a branch off it. In the graph viewer you can preview any node, set it *active*, and send your next message from there. Only you move the active point; Claude never does.

**Let the project accumulate components.** When Claude builds a pane worth keeping, it saves it to the project's component library and reuses it later. Over time your project grows UI that matches how you work.

**Restyle everything with themes.** Themes are design tokens that cascade from a single pane up to the whole surface. Ask Claude to theme the surface (and save the result), or swap saved themes yourself from the ⚙ button in the topbar.

**Export anything.** Any node can become a single self-contained `.html` file — panes, data, and theme inlined, interactive with no server and no network — right for attaching to a message or an email. Use the topbar **⬇** button, or `claude-web-chat export [node]`, or just ask Claude. More detail in [`docs/export-pages.md`](docs/export-pages.md).

**Other processes can draw too.** A dev server or test runner can render panes and write data between Claude's turns, so a panel can reflect live external state. See [`docs/driving-the-surface.md`](docs/driving-the-surface.md).

**Or bundle the process with the component.** A saved component can carry a host-side service the daemon runs while its pane is open — a git dashboard, a test monitor, a file watcher that refreshes itself, no per-turn driving. The built-in `git-dashboard` is one. Because that's real code running on your machine, the first spawn waits for you to approve it **in your terminal**:

```sh
claude-web-chat trust                 # what's waiting
claude-web-chat trust git-dashboard   # approve it (--deny refuses)
```

The page can only tell you the command — it deliberately can't grant the approval, since the component's own pane script runs in that page. Approval is remembered per project, per version of the service, per set of params, in `~/.web-chat/`. See [`docs/service-components.md`](docs/service-components.md).

**Install a whole set at once — a component pack.** A pack is a git repository that installs as components *plus a Claude skill*, and the skill is the point: `list_components` is a **pull** (Claude only finds a component if it decides to look), while a skill's description sits in Claude's context from the start of the session. The same components shipped as a pack get used constantly instead of occasionally.

```sh
claude-web-chat pack get https://github.com/acme/ops-pack     # download for review — installs nothing
claude-web-chat pack review acme-ops                          # manifest, plan, files, and what SKILL.md tells Claude
claude-web-chat pack approve acme-ops                         # install it
claude-web-chat pack list --verify                            # what's installed, and what you've edited
claude-web-chat pack remove acme-ops                          # a component you edited is kept, not deleted
```

`pack install <url>` skips straight to installing; `--global` installs for every project instead of this one. The same thing lives behind the topbar's **＋** button, under **Manage**.

Installing a pack runs its code: panes are unsandboxed in the surface page, and any `service.js` is host code behind the `trust` gate above. **`pack get` is the right default for a pack you didn't write** — it downloads and verifies without installing, and `pack review` shows you the plan and the skill text before you commit. See [`docs/component-packs.md`](docs/component-packs.md).

## Channels (experimental)

Normally Claude only acts when you send a message. The surface's queue rail collects wake-worthy activity — page captures, pane signals, and shared comment pins — and hitting **Push → Claude** hands Claude the whole batch.

**It works with or without the Channels capability.** For a *live, no-prompt* wake, launch Claude Code with both the env var and the capability flag — they belong together on the launch line, so a session can never claim a channel it doesn't have:

```sh
WEB_CHAT_CHANNEL=1 claude --dangerously-load-development-channels server:web-chat
```

With that, a Push wakes Claude immediately. **Without it, a Push isn't lost** — the batch is *parked* and delivered as context with your **next message** (the rail says "delivers with your next message", which is exactly what happens). The **Channels** capability is a research preview (needs Claude Code ≥ 2.1.80 and Anthropic auth); parked delivery is the universal fallback and needs neither. Details in [`docs/channels-dev.md`](docs/channels-dev.md).

## Load the browser extension

Page captures — the "web" half of web-chat — come from a small Chrome extension that streams the tab you're on into the surface, where it lands in the queue rail. It ships *inside* the installed package, so load it once from disk:

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top-right toggle).
3. Click **Load unpacked** and choose the extension folder inside your install: `~/.web-chat/current/extensions/tab-stream`. Or let web-chat show you — `claude-web-chat open extensions` opens a page that names the exact folder for your machine (the path differs for a dev checkout).

Sideloading is how you run it today; a Web Store listing is a planned follow-up.

## The command line

`claude-web-chat help` is the full reference. The ones you'll actually reach for:

```
open                open the surface in your browser (starts the server if needed)
launch              open the surface and start a Claude session together
init                set up web-chat here, or check and tidy an existing install
status              show version, daemon state, and install health for this project
ls [--reap]         every web-chat surface running on this machine, and which
                    project each one is; --reap stops the others and clears
                    stale registry entries
doctor              diagnose and repair daemon / lock / MCP / hook issues
trust [name]        approve (or --deny) a component's host-side service.js;
                    with no name, list what's waiting
version             which version, and which tree it is actually running from
stop | restart      stop or bounce the background server
unlock              clear a turn lock orphaned by an interrupted turn
export [node]       write a node to a self-contained .html
docs [name]         print a bundled contract doc; with no name, list them
on | off            enable/disable web-chat (see “Turning it off”)
init                the one entry point: first-run setup + tutorial, or orient/repair
install             the setup step on its own, and how updates reach a project
update              install the latest GitHub release (checksum-verified), sync,
                    restart; --list shows versions on disk, --to <v> rolls back
uninstall           remove the hooks (your graph data is kept); --self also
                    removes the program itself
```

Inside Claude Code, `/web-chat <subcommand>` runs any of these without leaving the chat, and bare `/web-chat` is the guided start from step 5.

## Turning it off

`claude-web-chat off` disables web-chat for the current project; `on` re-enables it. Add `--global` to toggle every project on the machine at once, or `--session=<id>` for a single Claude Code session. If any applicable scope says off, web-chat is off — hooks go quiet and Claude falls back to plain chat, telling you why.

And since it's opt-in, projects you never ran `install` in are simply inert.

## Updating

Run `update` from any installed project:

```sh
claude-web-chat update
```

It resolves the latest GitHub Release, downloads the tarball and its `SHA256SUMS`, **verifies the checksum before unpacking anything**, unpacks into `~/.web-chat/versions/<version>/`, swaps the `~/.web-chat/current` symlink, restarts the background server, reports the version before and after, and syncs *that* project's managed files (the Claude rules file, the `/web-chat` command, and the two skills) edit-preservingly: untouched files update automatically, your edits are kept, and a genuine conflict lands beside your file as `<file>.new` for you to merge — never a silent overwrite.

For your *other* installed projects, run `claude-web-chat init` (or `install`) in each to sync their managed files too (`--force` takes the shipped version). `claude-web-chat status` tells you when a project's files have drifted behind the package, and the MCP server logs a one-line nudge at session start when a refresh is due.

A failed or tampered download changes nothing: `current` only moves after a complete, verified unpack, so the install you have is the one you keep.

Old versions stay unpacked (the newest three), which makes a rollback a symlink swap rather than a reinstall:

```sh
claude-web-chat update --list        # what's on disk, and which one is live
claude-web-chat update --to <version>    # go back to it — no download, no network
```

**`update` refuses to run from a git checkout**, loudly, and tells you to `git pull` instead. That is deliberate. npm's global prefix is a shared directory, and an unrelated `npm i -g` once replaced this package's link to a dev checkout with a copy of a build from 16 days earlier — green tests, ancient binary, no warning anywhere. Releases now live in a directory only this program writes, and `claude-web-chat version` will always tell you which tree you are running.

The surface also checks for new **GitHub releases** (once a day, cached in `~/.web-chat/`) and shows a dismissible banner linking the release notes when one is newer than your build. Taking the update is always your call from the terminal — the page will not install anything.

Developing from a checkout? `git pull` (plus `npm install` if dependencies changed) is the whole package update.

## What it writes to your machine

- `<project>/.web-chat/` — the graph, saved components, exports, server portfile and log. `install` adds it to your `.gitignore` (unless a rule for it is already there).
- `<project>/.claude/` — hook entries merged into `settings.json`, plus the managed rules file, the `/web-chat` slash command, and two skills.
- `~/.web-chat/` — the program itself (`versions/<version>/` plus the `current` symlink) and per-user state: disable markers, the update-check cache, saved themes, and `services/trusted.json` (which component services you've approved, and for which project).
- `~/.local/bin/` — three symlinks (`claude-web-chat`, `-mcp`, `-hook`) pointing at `~/.web-chat/current/bin/`.

Nothing else — no system directories, and nothing needing sudo. `uninstall` removes this project's hooks while leaving your graph data alone; `claude-web-chat uninstall --self` also removes the program (the `~/.local/bin` links and every unpacked version), leaving per-user state and every project's graph in place.

## Who can reach it

The server binds **loopback only** (`127.0.0.1`) and is deliberately unauthenticated: anything that can reach the port can read the graph and the shared store, and render arbitrary HTML/JS into your browser. So the bind address *is* the access control.

- Other programs on your machine can drive the surface — that's the point (see "Other processes can draw too"), and it means you should treat a component from an untrusted source the way you'd treat running its code, because that is what it is.
- The WebSocket upgrade is gated on `Origin`, so a random web page you happen to visit can't open a socket to `ws://localhost:<port>` and read your store. Non-browser clients (drivers, the CLI) send no `Origin` and are unaffected.
- Captures are only readable cross-origin by the browser extension, not by any site you're browsing.
- `WEB_CHAT_HOST` overrides the bind address for the deliberate remote case (a dev container, a remote workstation). Setting it exposes all of the above to that interface with no authentication, and the server says so on startup.

## When something's stuck

Start with `claude-web-chat doctor` — it checks the daemon, portfile, MCP registration, and hooks, and repairs what it can. Two situations worth naming:

- **Claude's tools return "disabled".** Some scope has web-chat off; `claude-web-chat status` shows which one.
- **The graph won't let you navigate.** An interrupted turn can orphan the turn lock; `claude-web-chat unlock` clears it.
- **A dashboard pane is sitting there empty.** Its component ships a `service.js` that hasn't been approved. `claude-web-chat trust` lists what's waiting.
- **You've lost track of which port is which project.** `claude-web-chat ls` maps every running surface back to its project; `--reap` stops the ones you're done with.

## Contributing

Development setup, architecture, and how to extend the package live in [`CLAUDE.md`](CLAUDE.md) and [`docs/extending.md`](docs/extending.md). Run the tests with `npm test` (a bare `node --test --test-timeout=60000`, which auto-discovers `test/` — **not** `node --test test/`, which mis-resolves and reports a spurious failure).

## License

[MIT](LICENSE). See [`CHANGELOG.md`](CHANGELOG.md) for what's landed.
