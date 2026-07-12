# claude-web-chat

claude-web-chat gives Claude Code a second surface: a live page in your browser that Claude draws on while you talk in the terminal. Diagrams, forms, comparisons, working mockups — anything better shown than described lands on the page, stays interactive, and becomes a step in a graph you can walk back through and branch. Thanks for checking it out.

You get three things:

- **Chat**, in your terminal, same as always — reasoning, narrative, quick answers.
- **The surface**, at `http://localhost:5173` — everything visual and interactive. What you click and type there flows straight back to Claude as structured data.
- **The graph** — every Claude turn is saved as a node. Revisit any earlier state, branch from it, and carry on. Trying a different direction never loses the first one.

The quickstart below takes you from a fresh checkout to your first interactive page in about five minutes.

## Quickstart

You'll need **Node 18+** and **Claude Code** already installed.

### 1. Install the package

One line in a terminal:

```sh
curl -fsSL https://raw.githubusercontent.com/Brynhild-CHale/claude-web-chat/main/install.sh | sh
```

That checks you have Node 18+, installs the `claude-web-chat` command globally from the public repo (no npm registry involved), and prints the next step. The script is short and does nothing but that — [read it](https://raw.githubusercontent.com/Brynhild-CHale/claude-web-chat/main/install.sh) before piping it to a shell if you like.

Verify it worked:

```sh
claude-web-chat help
```

You should see the command list. If your shell can't find it, check that npm's global bin directory is on your PATH.

**Developing on web-chat itself?** Install from a checkout instead, so your edits take effect on the next invocation:

```sh
git clone https://github.com/Brynhild-CHale/claude-web-chat.git
cd claude-web-chat
npm install
npm link
```

`npm link` puts the command on your PATH from your working copy. See [`docs/extending.md`](docs/extending.md) for the development setup.

### 2. Wire it into a project

web-chat is opt-in per project. In any project where you want it:

```sh
cd ~/Dev/my-project
claude-web-chat install
```

This adds the web-chat MCP server to `.mcp.json`, merges two hooks into `.claude/settings.json` (existing hooks are preserved), drops usage guidance for Claude into `.claude/rules/`, and creates `.web-chat/` for the project's graph and components. Your `CLAUDE.md` is never touched, and re-running `install` is always safe.

### 3. Restart Claude Code

Claude Code reads `.mcp.json` at startup, so restart it in this project. On first launch it will ask you to trust the new `web-chat` MCP server — approve it, or the tools won't load.

### 4. Open the surface

```sh
claude-web-chat open
```

This starts the background server (if it isn't already running) and opens the surface in your browser. You'll see an empty page with a topbar — that's correct; nothing has been rendered yet.

> Prefer one command? `claude-web-chat launch` opens the surface *and* starts a Claude session together.

### 5. Render your first page

Back in Claude Code, try:

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

## Channels (experimental)

Normally Claude only acts when you send a message. The surface's queue rail collects wake-worthy activity — page captures, pane signals, and shared comment pins — and hitting **Push → Claude** hands Claude the whole batch.

**It works with or without the Channels capability.** `claude-web-chat install` already wires `WEB_CHAT_CHANNEL=1` into this project's MCP entry, so the one thing left for a *live, no-prompt* wake is to launch Claude Code with the capability flag:

```sh
WEB_CHAT_CHANNEL=1 claude --dangerously-load-development-channels
```

With that, a Push wakes Claude immediately. **Without it, a Push isn't lost** — the batch is *parked* and delivered as context with your **next message** (the rail says "delivers with your next message", which is exactly what happens). The **Channels** capability is a research preview (needs Claude Code ≥ 2.1.80 and Anthropic auth); parked delivery is the universal fallback and needs neither. Details in [`docs/channels-dev.md`](docs/channels-dev.md).

## Load the browser extension

Page captures — the "web" half of web-chat — come from a small Chrome extension that streams the tab you're on into the surface, where it lands in the queue rail. It ships *inside* the installed package, so load it once from disk:

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top-right toggle).
3. Click **Load unpacked** and choose the extension folder inside your global install. Find the path with:

   ```sh
   npm root -g
   ```

   The folder is `<that path>/claude-web-chat/extensions/tab-stream`.

Sideloading is how you run it today; a Web Store listing is a planned follow-up.

## The command line

`claude-web-chat help` is the full reference. The ones you'll actually reach for:

```
open                open the surface in your browser (starts the server if needed)
launch              open the surface and start a Claude session together
status              show version, daemon state, and install health for this project
doctor              diagnose and repair daemon / lock / MCP / hook issues
stop | restart      stop or bounce the background server
export [node]       write a node to a self-contained .html
on | off            enable/disable web-chat (see “Turning it off”)
install             first-time setup, and how updates reach a project
update              reinstall the latest build from the public repo, sync, restart
uninstall           remove the hooks (your graph data is kept)
```

## Turning it off

`claude-web-chat off` disables web-chat for the current project; `on` re-enables it. Add `--global` to toggle every project on the machine at once, or `--session=<id>` for a single Claude Code session. If any applicable scope says off, web-chat is off — hooks go quiet and Claude falls back to plain chat, telling you why.

And since it's opt-in, projects you never ran `install` in are simply inert.

## Updating

Run `update` from any installed project:

```sh
claude-web-chat update
```

It reinstalls the latest build from the public repo, reports the version before and after, then syncs *that* project's managed files (the Claude rules and slash command) edit-preservingly: untouched files update automatically, your edits are kept, and a genuine conflict lands beside your file as `<file>.new` for you to merge — never a silent overwrite.

For your *other* installed projects, run `claude-web-chat install` in each to sync their managed files too (`--force` takes the shipped version). `claude-web-chat status` tells you when a project's files have drifted behind the package, and the server prints a one-line nudge at session start when a refresh is due.

Developing from a checkout? `git pull` (plus `npm install` if dependencies changed) is the whole package update — the global command is a symlink into your working copy.

## What it writes to your machine

- `<project>/.web-chat/` — the graph, saved components, exports, server portfile and log. Gitignored by default.
- `<project>/.claude/` — hook entries merged into `settings.json`, plus the managed rules file and `/web-chat` slash command.
- `~/.web-chat/` — per-user state: disable markers and an update-check cache.

Nothing else, and `uninstall` removes the hooks while leaving your graph data alone.

## When something's stuck

Start with `claude-web-chat doctor` — it checks the daemon, portfile, MCP registration, and hooks, and repairs what it can. Two situations worth naming:

- **Claude's tools return "disabled".** Some scope has web-chat off; `claude-web-chat status` shows which one.
- **The graph won't let you navigate.** An interrupted turn can orphan the turn lock; `claude-web-chat unlock` clears it.

## Contributing

Development setup, architecture, and how to extend the package live in [`CLAUDE.md`](CLAUDE.md) and [`docs/extending.md`](docs/extending.md). Run the tests with a bare `node --test`.

## License

[MIT](LICENSE). See [`CHANGELOG.md`](CHANGELOG.md) for what's landed.
