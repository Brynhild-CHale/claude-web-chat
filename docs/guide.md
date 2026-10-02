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

Within a few seconds the diagram appears in the browser, and the topbar's node label moved to the new node: a node was committed for that turn (`G` opens the graph). Now try something interactive:

> Give me a small form on the surface to choose which module we refactor first, with a note field.

Fill it in, hit the submit button, and tell Claude "check the form" — your choices arrive on Claude's side as data, not a screenshot. When a pane is meant to drive a longer back-and-forth, Claude names a **signal key** in chat: hitting Apply queues it on the right-edge rail, and **Push → Claude** (`P`) hands it over — or, when Claude declared it immediate, Apply wakes Claude at once.

That's the core loop: you talk in the terminal, Claude shows its work in the browser, and your clicks talk back.

## Everyday use

**Ask for the page, not prose.** Multi-option decisions, comparison tables, forms, live UI mockups — say "on the surface" and Claude renders them instead of describing them. Panes persist across turns, so Claude (and you) can refer back to one without re-rendering it.

**Pages read like a write-up.** Claude can write short markdown between panes — a `#` title, `##` headings, a sentence of framing. The page's first `#` heading is its title (in the topbar and at the top of the page, with the node, the pane count and when it was updated), and from 1100px up a **Contents** column lists every `#`/`##` heading, numbered, with how many blocks sit under each — click one to scroll there. Consecutive blocks form a *run*, laid out on a 12-column grid: drag a block by its header to move it within its run (it snaps to columns, and the run settles into reading order when you let go), and pull its right edge, bottom edge or corner to resize it in whole columns and 40px rows. A locked block does neither. Once you have rearranged a run, **↺ Claude's layout** above it puts it back the way Claude placed it. Each run with more than one block also carries a **stacks on narrow / fixed grid** switch: whether it folds to one column on a narrow screen, or keeps its grid and scrolls sideways. Moving and resizing need a pointer for now: there is no keyboard move or resize yet.

**A block's history.** ◷ on a block's header (behind ⋯ on a narrow block) lists the versions of that block the page has shown on the way to the current node — newest first, each with the node that introduced it, when, and the prompt behind it. Hover a version to see it, drawn read-only beside the list; click one to keep it in view. Nothing changes until you press **Make current**, which puts that version back on the page (your pin, lock and typed values stay). It is greyed out, with the reason, on the version already showing, on a locked block, and on a block or version that something other than Claude writes — a background service, or another block. A block that another block put up names its parent on its header (**↳ parent** — click it to show the parent); if the parent is closed, the child stays and says so (**↳ parent · closed**) until you close it.

**Use the graph like an undo tree.** Nodes are labeled hierarchically — `n1.7` is the seventh step on the first trunk, `n1.7.0` a branch off it. In the graph viewer (`G`) you can preview any node, set it *active* (or **⑃ Branch** from it), and send your next message from there. A preview is read-only; adding a block while previewing (＋, `N`, ⌘K *Add block*) puts it on the live page instead, leaves the preview on screen, and says so in a toast with **Jump to live**. Only you move the active point; Claude never does. A run of plain turns draws as one **×N** stack — click it to open the run in place and pick any turn in it; turns that changed nothing show as faint *folded* rows under the turn they folded onto. **⚑ Marked**, **⑃ Forks** and the search box dim everything else; click a graph's title to name it, drag it to move it.

**Let the project accumulate components.** When Claude builds a pane worth keeping, it saves it to the project's component library and reuses it later. Over time your project grows UI that matches how you work.

**Restyle everything with themes.** Themes are design tokens that cascade from a single pane up to the whole surface. Three packs ship — Earthy (the stock look, light and dark), Paper and Georgetown Blue — and light/dark is a mode inside a pack, flipped with ◑, `T` or **⋯ → Settings → Mode**. Ask Claude to theme the surface (and save the result), or swap themes yourself from **⋯ → Settings**. More detail in [`themes.md`](themes.md).

**Export anything.** Any node can become a single self-contained `.html` file — laid out as it was on the page (the same grid runs, columns and heights, with the markdown between them), panes, data, and theme inlined, interactive with no server and no network — right for attaching to a message or an email. Use **⋯ → ↧ Export node** in the topbar (or **↧** / `E` on a node in the graph viewer), or `claude-web-chat export [node]`, or just ask Claude. More detail in [`export-pages.md`](export-pages.md).

**Replay how the work evolved.** The replay player plays the page forward node by node — by default from the nearest bookmark down to the node on screen, and any stretch of that lineage you pick with its *from* / *to*. Open it with **⋯ → ▶ Replay…** or `R` on the page, **▶ Replay** (or `R`) on a node selected in the graph, or ⌘K *Replay to …*. Space plays and pauses, ←/→ step, and **Open this node** leaves the replay on the step you are looking at. Captions show each node's label, time and Claude's reply; tick **Include my prompts** to show your prompts too — the choice also decides whether they go into anything you save from the player: **↧ replay.html** (a self-contained player that works offline), **↧ GIF**, or **↧ MP4** / **↧ WebM** (a GIF needs Chrome, Chromium, Edge or Brave on this machine; the videos need ffmpeg too). More detail in [`export-pages.md`](export-pages.md).

**Find anything with ⌘K.** The palette lists four kinds of row: **node** (a turn, with its time), **section** (a heading on the page, numbered as in Contents — choosing one scrolls to it), **block** (a block on the page, with the number of the section it sits under — choosing one scrolls to it and restores it if minimized) and **command** (with its key, where it has one), including *Add block · name* for every component in the library. Type a kind to list only those. (On the graph screen and in the replay player ⌘K does nothing — the graph has its own jump search. While the graph, the palette or the player is open, Tab and typing stay inside it.) On this computer the palette also offers *Set up remote access…*, which opens the tunnel setup page in a new tab (see remote-access).

**Narrow windows and phones.** Below 900px each run of blocks stacks to one column in reading order — unless it is set to *fixed grid*, which keeps its grid and scrolls sideways (**FIXED GRID · SCROLL →**). Below 760px a bar along the bottom carries ↑/↓, ↩ active (while you are viewing an older node), **Graph** and **Queue [n]** — which opens the queue as a full screen; **‹ Page** goes back. From 1100px up the Contents column sits beside the page (hidden while the page has no headings). On a phone — a window under 760px wide that is also portrait-tall (narrower than 3:4), whatever the pointer; a phone on its side is not one, and a desktop window dragged that narrow and tall is — what is inside a block works exactly as on a desktop — type, tick, submit, press its buttons — but the layout is fixed: each block's header shows only its title and type, nothing can be moved, resized, pinned, locked, minimized or closed (a layout gesture that gets through says *Layout editing is available on a larger screen*), no block is added from ＋ or ⌘K, and a minimized block's chip only shows it on that phone. An older node you are previewing is read-only there too, as everywhere. You talk to Claude from the queue (stage or hold items, add a comment, Push) and act on the graph, which on a phone is a newest-first log of one graph with its forks drawn in a gutter: each turn names the sections it changed (**# Results +2 ~1** — blocks and prose added, changed, removed under that heading); tap a turn, then ◫ Glance, ⚑ bookmark (with a name), ⑃ Branch, ↧ Export or **Set active**. The graph name at the top switches graphs, and **⋯ N folded** shows the turns that changed nothing.

**Other processes can draw too.** A dev server or test runner can render panes and write data between Claude's turns, so a panel can reflect live external state. See [`driving-the-surface.md`](driving-the-surface.md).

## Service-backed components

A saved component can carry a host-side service the daemon runs while its pane is open — a git dashboard, a test monitor, a file watcher that refreshes itself, no per-turn driving. The built-in `git-dashboard` is one. Because that's real code running on your machine, the first spawn waits for you to approve it **in your terminal**:

```sh
claude-web-chat trust                   # what's waiting
claude-web-chat trust git-dashboard     # approve it (--deny refuses)
claude-web-chat trust --all             # approve everything waiting, in one go
claude-web-chat trust --pack acme-ops   # approve the services a pack installed, before any pane opens
```

The page can only tell you the command — it deliberately can't grant the approval, since the component's own pane script runs in that page. There is no `--yes`: the gate exists so that a human reads what is about to run. Approval is remembered per project, per version of the service, per set of params, in `~/.web-chat/`, so one name can have more than one request waiting; when it does, the listing prints a fingerprint for each and you pick one with `--params-fp <fingerprint>` (`--key` is the same flag, and either the fingerprint or the full trust key works).

A component can mark the params that do not need asking about again — a pane's title, or a file inside this project — and the listing shows them under `covers`. The built-in file editor is approved once for every file inside the project; `unfenced: true`, or a path outside the project, still asks. `--pack <name>` approves every service a pack installed in one confirmation, with the surface running and no pane open; a pane that passes anything wider than what each one covers still asks. It trusts only installs this machine recorded: a `.web-chat/packs.json` that came with a repository approves nothing, and a pack installed in a project before 0.8.2 needs installing again first. After that, any pane can point one of those services that takes a path at any file in the project, `.env` files included. See [`service-components.md`](service-components.md).

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

Normally Claude only acts when you send a message. The surface's queue rail collects wake-worthy activity — page captures, pane signals, and shared comment pins — and hitting **Push → Claude** hands Claude the whole batch. A row's ⟲ takes it back: it undoes that interaction (your typed values since the last Push, and a pane's submitted signal) and never removes a pane Claude rendered. A signal row's **▸ value** shows what that key holds right now, so you can check what you are about to hand off; Claude still receives only the key's name, and reads the value itself when it needs it.

**It works with or without the Channels capability.** For a *live, no-prompt* wake, launch Claude Code with both the env var and the capability flag — they belong together on the launch line, so a session can never claim a channel it doesn't have:

```sh
WEB_CHAT_CHANNEL=1 claude --dangerously-load-development-channels server:web-chat
```

With that, a Push wakes Claude immediately. **Without it, a Push isn't lost** — the batch is *parked* and delivered as context with your **next message** (the rail says "delivers with your next message", which is exactly what happens). That next message is typed into Claude Code on this machine, so a Push from your phone through the tunnel waits for you to get back to the terminal unless the session has Channels — start it with the line above before you leave ([`remote-access.md`](remote-access.md)). The **Channels** capability is a research preview (needs Claude Code ≥ 2.1.80 and Anthropic auth); parked delivery is the universal fallback and needs neither. Details in [`channels-dev.md`](channels-dev.md).

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
                    --all adds the inactive projects known on this machine;
                    --json prints the whole row; --reap asks the others to
                    shut down (uncommitted surface saved) and clears entries
                    whose process is gone
doctor              diagnose and repair daemon / lock / MCP / hook issues
trust [name]        approve (or --deny) a component's host-side service.js;
                    with no name, list what's waiting; --all takes everything
                    waiting (or every variant of one name), --params-fp / --key
                    picks one request when a name has several; --pack <name>
                    approves the services a pack installed, ahead of time
version             which version, and which tree it is actually running from
stop | restart      stop or bounce the background server
unlock              clear a turn lock orphaned by an interrupted turn
export [node]       write a node to a self-contained .html (--replay / --gif / --mp4 / --webm: a replay of its lineage;
                    --script <file.json>: a replay Claude or you scripted; --prompts puts your prompts in its captions)
docs [name]         print a bundled contract doc; with no name, list them
on | off            enable/disable web-chat (see install.md, “Turning it off”)
install             the setup step on its own, and how updates reach a project
update              install the latest GitHub release (checksum-verified), sync,
                    restart; --list shows versions on disk, --to <v> rolls back,
                    --from <tarball> installs a local build (a --dev build from
                    scripts/build-release.js), --restart-all restarts every other
                    project still running an older build
uninstall           remove the hooks (your graph data is kept); --self also
                    removes the program itself
tunnel [verb]       reach your surfaces from your phone or another machine:
                    setup | up | down | status | logs, through a Cloudflare
                    tunnel behind Cloudflare Access — an emailed code plus your
                    device's biometrics by default, or Google (see
                    remote-access.md)
```

Inside Claude Code, `/web-chat <subcommand>` runs any of these without leaving the chat, and bare `/web-chat` is the guided start above.

## Who can reach it

The server binds **loopback only** (`127.0.0.1`) and is deliberately unauthenticated: anything that can reach the port can read the graph and the shared store, and render arbitrary HTML/JS into your browser. So the bind address *is* the access control.

- Other programs on your machine can drive the surface — that's the point (see "Other processes can draw too" above), and it means you should treat a component from an untrusted source the way you'd treat running its code, because that is what it is.
- The WebSocket upgrade is gated on `Origin`, so a random web page you happen to visit can't open a socket to `ws://localhost:<port>` and read your store. Non-browser clients (drivers, the CLI) send no `Origin` and are unaffected.
- Captures are only readable cross-origin by the browser extension, not by any site you're browsing.
- `WEB_CHAT_HOST` overrides the bind address for the deliberate remote case (a dev container, a remote workstation). Setting it exposes all of the above to that interface with no authentication, and the server says so on startup.
- To reach your surfaces from **outside** this machine, don't widen the bind — use `claude-web-chat tunnel`: the daemons stay on loopback, and a separate portal admits only an email address you allowlisted, verified by Cloudflare Access and again locally (sign-in is an emailed code plus your device's biometrics by default, or Google). The walkthrough and the security model are in [`remote-access.md`](remote-access.md).

## When something's stuck

Start with `claude-web-chat doctor` — it checks the daemon, portfile, MCP registration, and hooks, and repairs what it can. A few situations worth naming:

- **Claude's tools return "disabled".** Some scope has web-chat off; `claude-web-chat status` shows which one.
- **The web-chat tools never show up in Claude Code.** Claude Code starts a project's `.mcp.json` server only after you approve it, and asks when it first starts in the project. If you declined, it stays declined on every restart: `/exit`, run `claude mcp reset-project-choices` in the project directory, and start Claude Code again — it asks again.
- **The graph won't let you navigate.** An interrupted turn can leave the turn lock held, and Set active, ⑃ Branch and `A` stay off (*locked — turn in progress*) until it goes stale — 15 minutes after Claude's last write, 3 for a channel wake. Then the next click takes it over, keeping the abandoned turn's work as a node of its own; `claude-web-chat unlock` clears it at once.
- **A dashboard pane is sitting there empty.** Its component ships a `service.js` that hasn't been approved. `claude-web-chat trust` lists what's waiting.
- **You've lost track of which port is which project.** `claude-web-chat ls` maps every running surface back to its project; `--reap` asks the ones you're done with to shut down cleanly.
- **You don't know which projects Claude is actually attached to.** The CLAUDE column in `claude-web-chat ls` counts the Claude Code sessions that have web-chat loaded in each project — a project with a session but no surface is listed too — and `· channel` marks one a Push wakes mid-session. It is the live process, not the last tool call: a session appears the moment it starts and goes when it exits. TURN says whether one is mid-turn right now. The same view is in the browser: **⋯ → Sessions** (or `S`, or ⌘K *Sessions…*) lists every project with its surface and Claude state, refreshes every few seconds while open, opens another project's surface in a new tab, and gives a stopped one's `claude-web-chat open` command to copy — the page never starts a surface itself. Projects known on this machine with nothing running sit in a collapsed **Inactive** group (`ls --all` prints them too); through the remote portal, the picker can start one of those after you confirm (see remote-access).
- **You've updated, and don't know which Claude sessions still run the old tools.** A Claude Code session keeps the web-chat MCP server it started with until you restart it. `ls` (its VERSION column), the Sessions panel and the tunnel picker show the web-chat release of each surface and each attached Claude session, and a row whose Claude session is on a different release than its surface carries a ⚠ saying which side to restart — *Claude is on v0.8.0 — restart Claude Code to pick up v0.8.1*, or `claude-web-chat restart` when it is the surface that is behind. (A session started under 0.7.x records nothing and is not listed at all.) You rarely have to look: a successful `update` ends by telling you to `/exit` and reopen Claude Code, `claude-web-chat status` names the build this project's server runs (with a ⚠ and `claude-web-chat restart` when it is not the CLI's), and Claude is told — on your next prompt when the server is on another build, and in its next tool result when its own session started before the update (on an install `update` manages, not a checkout) — so it can tell you which to restart.
