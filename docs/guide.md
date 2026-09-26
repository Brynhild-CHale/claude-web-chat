# Using web-chat

The README gets you to a first render. This is everything after: how to work
with the surface day to day, components and packs, channels, the browser
extension, the command line, who can reach the server, and what to do when
something is stuck. Installing, updating and removing are in
[`install.md`](install.md).

## The core loop

You get three things:

- **Chat**, in your terminal, same as always — reasoning, narrative, quick answers.
- **The surface**, in your browser — everything visual and interactive. What you click and type there flows straight back to Claude as structured data. (`claude-web-chat open` opens it; the port is per-project, starting at 5173 and walking upward, so a second project gets its own.)
- **The graph** — every Claude turn that changes the surface is saved as a node. Revisit any earlier state, branch from it, and carry on. Trying a different direction never loses the first one.

In Claude Code, bare `/web-chat` is a guided start: Claude checks the surface is up, looks at what your project actually is, and renders a first pane with a few concrete things it could do next — click one, hit **P**, and Claude picks it up. (With an argument it's a plain CLI passthrough: `/web-chat status`, `/web-chat restart`, `/web-chat doctor`.)

Or just ask, in your own words:

> Sketch this project's architecture as a diagram on the surface.

Within a few seconds the diagram appears in the browser. Notice the graph rail: a node was committed for that turn. Now try something interactive:

> Give me a small form on the surface to choose which module we refactor first, with a note field.

Fill it in, hit the submit button, and tell Claude "check the form" — your choices arrive on Claude's side as data, not a screenshot. When a pane is meant to drive a longer back-and-forth, Claude will name a **signal key** in chat and wait on it, reacting each time you hit Apply.

That's the core loop: you talk in the terminal, Claude shows its work in the browser, and your clicks talk back.

## Everyday use

**Ask for the page, not prose.** Multi-option decisions, comparison tables, forms, live UI mockups — say "on the surface" and Claude renders them instead of describing them. Panes persist across turns, so Claude (and you) can refer back to one without re-rendering it.

**Use the graph like an undo tree.** Nodes are labeled hierarchically — `n1.7` is the seventh step on the first trunk, `n1.7.0` a branch off it. In the graph viewer you can preview any node, set it *active*, and send your next message from there. Only you move the active point; Claude never does.

**Let the project accumulate components.** When Claude builds a pane worth keeping, it saves it to the project's component library and reuses it later. Over time your project grows UI that matches how you work.

**Restyle everything with themes.** Themes are design tokens that cascade from a single pane up to the whole surface. Three packs ship — Earthy (the stock look, light and dark), Paper and Georgetown — and light/dark is a mode inside a pack, flipped with ◑ or `T`. Ask Claude to theme the surface (and save the result), or swap themes yourself from **⋯ → Settings**. More detail in [`themes.md`](themes.md).

**Export anything.** Any node can become a single self-contained `.html` file — panes, data, and theme inlined, interactive with no server and no network — right for attaching to a message or an email. Use **⋯ → ↧ Export node** in the topbar (or **↧** / `E` on a node in the graph viewer), or `claude-web-chat export [node]`, or just ask Claude. More detail in [`export-pages.md`](export-pages.md).

**Other processes can draw too.** A dev server or test runner can render panes and write data between Claude's turns, so a panel can reflect live external state. See [`driving-the-surface.md`](driving-the-surface.md).

## Service-backed components

A saved component can carry a host-side service the daemon runs while its pane is open — a git dashboard, a test monitor, a file watcher that refreshes itself, no per-turn driving. The built-in `git-dashboard` is one. Because that's real code running on your machine, the first spawn waits for you to approve it **in your terminal**:

```sh
claude-web-chat trust                 # what's waiting
claude-web-chat trust git-dashboard   # approve it (--deny refuses)
claude-web-chat trust --all           # approve everything waiting, in one go
```

The page can only tell you the command — it deliberately can't grant the approval, since the component's own pane script runs in that page. There is no `--yes`: the gate exists so that a human reads what is about to run. Approval is remembered per project, per version of the service, per set of params, in `~/.web-chat/`, so one name can have more than one request waiting; when it does, the listing prints a fingerprint for each and you pick one with `--params-fp <fingerprint>` (`--key` is the same flag, and either the fingerprint or the full trust key works). See [`service-components.md`](service-components.md).

## Component packs

A pack is a git repository that installs as components *plus a Claude skill*, and the skill is the point: `list_components` is a **pull** (Claude only finds a component if it decides to look), while a skill's description sits in Claude's context from the start of the session. The same components shipped as a pack get used constantly instead of occasionally.

```sh
claude-web-chat pack get https://github.com/acme/ops-pack     # download for review — installs nothing
claude-web-chat pack review acme-ops                          # manifest, plan, files, and what SKILL.md tells Claude
claude-web-chat pack approve acme-ops                         # install it
claude-web-chat pack list --verify                            # what's installed, and what you've edited
claude-web-chat pack remove acme-ops                          # a component you edited is kept, not deleted
```

`pack install <url>` skips straight to installing; `--global` installs for every project instead of this one. The same thing lives behind the topbar's **＋** button, under **Manage**.

Installing a pack runs its code: panes are unsandboxed in the surface page, and any `service.js` is host code behind the `trust` gate above. **`pack get` is the right default for a pack you didn't write** — it downloads and verifies without installing, and `pack review` shows you the plan and the skill text before you commit. See [`component-packs.md`](component-packs.md).

## Channels (experimental)

Normally Claude only acts when you send a message. The surface's queue rail collects wake-worthy activity — page captures, pane signals, and shared comment pins — and hitting **Push → Claude** hands Claude the whole batch. A row's ⟲ takes it back: it undoes that interaction (your typed values since the last Push, and a pane's submitted signal) and never removes a pane Claude rendered.

**It works with or without the Channels capability.** For a *live, no-prompt* wake, launch Claude Code with both the env var and the capability flag — they belong together on the launch line, so a session can never claim a channel it doesn't have:

```sh
WEB_CHAT_CHANNEL=1 claude --dangerously-load-development-channels server:web-chat
```

With that, a Push wakes Claude immediately. **Without it, a Push isn't lost** — the batch is *parked* and delivered as context with your **next message** (the rail says "delivers with your next message", which is exactly what happens). The **Channels** capability is a research preview (needs Claude Code ≥ 2.1.80 and Anthropic auth); parked delivery is the universal fallback and needs neither. Details in [`channels-dev.md`](channels-dev.md).

## The browser extension

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
status              show version, daemon state, attached Claude Code sessions,
                    and install health for this project
ls [--reap|--json]  every web-chat surface on this machine, which project each
                    one is, and which have a Claude Code session attached
                    (CLAUDE ● N · channel, TURN mid-turn / wake, VIEWERS);
                    --json prints the whole row; --reap asks the others to
                    shut down (uncommitted surface saved) and clears entries
                    whose process is gone
doctor              diagnose and repair daemon / lock / MCP / hook issues
trust [name]        approve (or --deny) a component's host-side service.js;
                    with no name, list what's waiting; --all takes everything
                    waiting (or every variant of one name), --params-fp / --key
                    picks one request when a name has several
version             which version, and which tree it is actually running from
stop | restart      stop or bounce the background server
unlock              clear a turn lock orphaned by an interrupted turn
export [node]       write a node to a self-contained .html (--replay / --gif / --mp4 / --webm: a replay of its lineage)
docs [name]         print a bundled contract doc; with no name, list them
on | off            enable/disable web-chat (see install.md, “Turning it off”)
install             the setup step on its own, and how updates reach a project
update              install the latest GitHub release (checksum-verified), sync,
                    restart; --list shows versions on disk, --to <v> rolls back
uninstall           remove the hooks (your graph data is kept); --self also
                    removes the program itself
tunnel [verb]       reach your surfaces from your phone or another machine:
                    setup | up | down | status | logs, through a Cloudflare
                    tunnel behind Google sign-in (see remote-access.md)
```

Inside Claude Code, `/web-chat <subcommand>` runs any of these without leaving the chat, and bare `/web-chat` is the guided start above.

## Who can reach it

The server binds **loopback only** (`127.0.0.1`) and is deliberately unauthenticated: anything that can reach the port can read the graph and the shared store, and render arbitrary HTML/JS into your browser. So the bind address *is* the access control.

- Other programs on your machine can drive the surface — that's the point (see "Other processes can draw too" above), and it means you should treat a component from an untrusted source the way you'd treat running its code, because that is what it is.
- The WebSocket upgrade is gated on `Origin`, so a random web page you happen to visit can't open a socket to `ws://localhost:<port>` and read your store. Non-browser clients (drivers, the CLI) send no `Origin` and are unaffected.
- Captures are only readable cross-origin by the browser extension, not by any site you're browsing.
- `WEB_CHAT_HOST` overrides the bind address for the deliberate remote case (a dev container, a remote workstation). Setting it exposes all of the above to that interface with no authentication, and the server says so on startup.
- To reach your surfaces from **outside** this machine, don't widen the bind — use `claude-web-chat tunnel`: the daemons stay on loopback, and a separate portal admits only a Google account you allowlisted, verified twice (by Cloudflare Access and again locally). The walkthrough and the security model are in [`remote-access.md`](remote-access.md).

## When something's stuck

Start with `claude-web-chat doctor` — it checks the daemon, portfile, MCP registration, and hooks, and repairs what it can. A few situations worth naming:

- **Claude's tools return "disabled".** Some scope has web-chat off; `claude-web-chat status` shows which one.
- **The graph won't let you navigate.** An interrupted turn can orphan the turn lock; `claude-web-chat unlock` clears it.
- **A dashboard pane is sitting there empty.** Its component ships a `service.js` that hasn't been approved. `claude-web-chat trust` lists what's waiting.
- **You've lost track of which port is which project.** `claude-web-chat ls` maps every running surface back to its project; `--reap` asks the ones you're done with to shut down cleanly.
- **You don't know which projects Claude is actually attached to.** The CLAUDE column in `claude-web-chat ls` counts the Claude Code sessions that have web-chat loaded in each project — a project with a session but no surface is listed too — and `· channel` marks one a Push wakes mid-session. It is the live process, not the last tool call: a session appears the moment it starts and goes when it exits. TURN says whether one is mid-turn right now. The same view is in the browser: **⋯ → Sessions** (or `S`, or ⌘K *Sessions…*) lists every project with its surface and Claude state, refreshes every few seconds while open, opens another project's surface in a new tab, and gives a stopped one's `claude-web-chat open` command to copy — the page never starts a surface itself.
