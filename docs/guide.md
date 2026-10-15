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

**Wiping the page.** ⋯ → ⌫ Wipe surface empties the page but stays on this node and bookmarks the point: pinned blocks stay (with the heading right above each), comment pins on the blocks it removed are deleted, and so are the page captures not yet committed. **New graph** starts a fresh tree with no blocks, pins or captures. Nodes already committed keep everything they hold, and the store is never cleared. The live page keeps the 50 newest captures; older ones stay in the nodes that hold them.

**Let the project accumulate components.** When Claude builds a pane worth keeping, it saves it to the project's component library and reuses it later. Over time your project grows UI that matches how you work.

**Restyle everything with themes.** Themes are design tokens that cascade from a single pane up to the whole surface. Three packs ship — Earthy (the stock look, light and dark), Paper and Georgetown Blue — and light/dark is a mode inside a pack, flipped with ◑, `T` or **⋯ → Settings → Mode**. Ask Claude to theme the surface (and save the result), or swap themes yourself from **⋯ → Settings**. More detail in [`themes.md`](themes.md).

**Export anything.** Any node can become a single self-contained `.html` file — laid out as it was on the page (the same grid runs, columns and heights, with the markdown between them), panes, data, and theme inlined, interactive with no server and no network — right for attaching to a message or an email. Use **⋯ → ↧ Export node** in the topbar (or **↧** / `E` on a node in the graph viewer), or `claude-web-chat export [node]`, or just ask Claude. More detail in [`export-pages.md`](export-pages.md).

**Replay how the work evolved.** The replay player plays the page forward node by node — by default from the nearest bookmark down to the node on screen, and any stretch of that lineage you pick with its *from* / *to*. Open it with **⋯ → ▶ Replay…** or `R` on the page, **▶ Replay** (or `R`) on a node selected in the graph, or ⌘K *Replay to …*. Space plays and pauses, ←/→ step, and **Open this node** leaves the replay on the step you are looking at. Captions show each node's label, time and Claude's reply; tick **Include my prompts** to show your prompts too — the choice also decides whether they go into anything you save from the player: **↧ replay.html** (a self-contained player that works offline), **↧ GIF**, or **↧ MP4** / **↧ WebM** (a GIF needs Chrome, Chromium, Edge or Brave on this machine; the videos need ffmpeg too). More detail in [`export-pages.md`](export-pages.md).

**Find anything with ⌘K.** The palette lists four kinds of row: **node** (a turn, with its time), **section** (a heading on the page, numbered as in Contents — choosing one scrolls to it), **block** (a block on the page, with the number of the section it sits under — choosing one scrolls to it and restores it if minimized) and **command** (with its key, where it has one), including *Add block · name* for every component in the library. Type a kind to list only those. (On the graph screen and in the replay player ⌘K does nothing — the graph has its own jump search. While the graph, the palette or the player is open, Tab and typing stay inside it.) On this computer the palette also offers *Set up remote access…*, which opens the tunnel setup page in a new tab (see remote-access).

**Narrow windows and phones.** Below 900px each run of blocks stacks to one column in reading order — unless it is set to *fixed grid*, which keeps its grid and scrolls sideways (**FIXED GRID · SCROLL →**). Below 760px a bar along the bottom carries ↑/↓, ↩ active (while you are viewing an older node), **Graph** and **Queue [n]** — which opens the chat sheet on Tasks → Queue: the same queue with everything it does (stage or hold items, add a comment, Push), and **Queue** again, the tab or a tap on the dimmed page closes it. From 1100px up the Contents column sits beside the page (hidden while the page has no headings). On a phone — a window under 760px wide that is also portrait-tall (narrower than 3:4), whatever the pointer; a phone on its side is not one, and a desktop window dragged that narrow and tall is — what is inside a block works exactly as on a desktop — type, tick, submit, press its buttons — but the layout is fixed: each block's header shows only its title and type, nothing can be moved, resized, pinned, locked, minimized or closed (a layout gesture that gets through says *Layout editing is available on a larger screen*), no block is added from ＋ or ⌘K, and a minimized block's chip only shows it on that phone. An older node you are previewing is read-only there too, as everywhere. You talk to Claude from the chat sheet (see *The chat on a phone* below) and act on the graph, which on a phone is a newest-first log of one graph with its forks drawn in a gutter: each turn names the sections it changed (**# Results +2 ~1** — blocks and prose added, changed, removed under that heading); tap a turn, then ◫ Glance, ⚑ bookmark (with a name), ⑃ Branch, ↧ Export or **Set active**. The graph name at the top switches graphs, and **⋯ N folded** shows the turns that changed nothing.

**Follow Claude's conversation in the chat.** The bar along the bottom of the page says what Claude is doing right now; click its step (or press `M`, or ⌘K *Chat with Claude*) and the chat opens in a drawer beside the page, following the same conversation: your prompts, Claude's replies in markdown, and each turn's tool calls folded into one group (*▸ 3 tool calls · Read, Edit, Bash · 42s*) — open the group, and a card, to see a call's input and output. It is read from Claude Code's own transcript as it is written, and kept across a server restart. A question, a permission or a plan Claude is waiting on shows as a card at the top, and you can answer it there (see *Answering Claude and steering it from the page* below). When you rewind the conversation in the terminal, the turns you abandoned stay in the stream, dimmed under a *↶ Rewound in the terminal* note. **⇱ Detach** floats the chat as a window you can move and resize, with an opacity slider and **Solid** (opaque while the pointer or focus is on it); **⇥ Attach** puts it back; ⌘K *Reset the chat window* restores its size and place. `Esc` closes one layer at a time — a card's detail, then the chat — and a click on the page closes the drawer, while a click on the queue rail or the topbar leaves it open. Below 760px wide the same chat opens as a sheet from the bottom of the page instead (next). Through the tunnel, a remote viewer sees only Claude's status until you run `claude-web-chat tunnel mirror on` in the project (see [`remote-access.md`](remote-access.md#showing-claudes-conversation-remotely)).

**The chat on a phone.** Below 760px wide — a phone, or a narrow window — the status bar gives way to a grip tab on the top edge of the bottom bar. It says what Claude is doing: its bar pulses while Claude works (and stays still once Claude has gone quiet), it widens to *QUESTION* in gold or *NEEDS YOU* in rust when Claude waits on you, and it shows idle, offline and suspended. Tap it and the chat comes up as a sheet at half height (at full height when a prompt is waiting and half is too short for its card); drag it up or down and it snaps to half, full or closed — a drag of more than 40px always moves at least one step, and a sideways swipe never opens it. The tab, **Close**, `Esc`, the phone's Back gesture or a tap on the dimmed page closes it, and that tap presses nothing on the page behind. **Chat | Tasks** switch inside the sheet. **Chat** is the chat described above — the stream, the waiting card you answer in, the composer and **Stop** — sized for a finger. Opening the sheet never raises the keyboard; tap the composer and the sheet sits on top of the keyboard, then goes back to where it was when the keyboard closes. The badge beside the tab counts the background work running and opens **Tasks**: a line each for shells, agents, workflows, monitors and the queue. A line opens its category's rows; **Output** and **Open** on a row open inside Tasks (*‹ Shells* goes back), and a task that ends while you look keeps its last content under *No longer running*. **Kill**, **Cancel** and **Remove** take two taps on a phone: the first turns the button into *Confirm kill* (or *Confirm cancel*, *Confirm remove*), and three seconds or any other tap undoes it. **Queue** on the bottom bar, and `Q`, open Tasks → Queue. Drag the closed tab sideways to dock it left, centre or right; centred, the running count shows in the tab itself. The dock is remembered in this browser. Through the tunnel the sheet works the same way, and at the `full` mirror level you answer Claude and stop it from it (see *Answering Claude and steering it from the page*).

**Background work, on the bar.** When Claude starts work that runs on in the background — a shell (`npm run dev`, a test watcher), a monitor, an agent or a workflow — a chip for it appears at the right of the bar: *2 shells*, *1 agent*, *agents · 1 done*. (What waits on the queue has no chip; it has the queue rail.) Click a chip to open its tray, one row per item with what it is doing now: a shell's last line of output, an agent's last step, a workflow's *step 3 / 5*. **Output** on a shell's row shows the tail of its output in place (*[exited with code 3]* once it has ended) and **Open full output** takes it into the chat; **Open** on an agent's row follows the agent's own transcript there as it grows, and on a workflow's row shows its phases and their agents. These detail views open over the chat's stream, and `Esc` goes back. **Kill** (a shell), **Cancel** (an agent or a workflow) and **Remove** (a monitor) stop one from the page — see below. Below `read`, a remote viewer's chips show counts only.

**What a turn changed in your files.** In a git repository, web-chat records what each of Claude's turns changed in the project's files: the bar reads *Done · 3 files changed*, and the turn's footer in the chat reads *3 files +40 −12* with **View changes**, which opens the turn's diff — or, for the turn that committed a node, the node's. The footer also carries the turn's **node chip** (*n1.14*, or *no surface change · rode into n1.14* for a turn that left the page as it was): click it to preview that node. The snapshots live in a store of web-chat's own under `.web-chat/mirror/git`, which borrows your repository's objects and never writes your `.git` — no commit, no index, no ref. It is capped at 1 GiB, a turn's record is kept for 30 days, and anything that looks like a secret is masked before a diff is written. `WEB_CHAT_MIRROR_DIFFS=0` in the daemon's environment turns it off.

**A node's turns, in the graph.** Select a node in the graph viewer (`G`) and its inspector lists the chat turns that rode into it — **CHAT TURNS · 2**: the turn that committed it (●) and any that changed nothing on the page and folded onto it (◦), each with its prompt, time, duration, tools and files changed. A node whose turns you later rewound in the terminal keeps them, dimmed and tagged *rewound*, under a *↶ 2 of 3 turns rewound in the terminal* line, and wears a ↶ beside its glyph on the canvas; the node itself is never changed.

**Other processes can draw too.** A dev server or test runner can render panes and write data between Claude's turns, so a panel can reflect live external state. See [`driving-the-surface.md`](driving-the-surface.md).

## Answering Claude and steering it from the page

Everything in this section acts on Claude Code or on your files, so none of it is a button on the page itself: each one is a small frame the page borrows from a second, private origin of web-chat's own, which no block's script can reach, read or click for you. It waits until the frame is fully visible and the click is yours. Firefox and Safari cannot prove a frame is visible, so there the frame offers **Review & answer ↗** (or **Review & confirm ↗**) instead, which opens a small window to do it in.

**Answering a prompt.** When Claude asks for a permission, the bar shows **Allow** and **Deny** for it, and the chat's waiting card shows **Allow once** and **Deny**, with an optional note for Claude that goes with a Deny. A request too long for the bar shows **Review ›**, which opens it in the chat. A question shows **Answer ›**: pick your answers in the card. A plan offers two approvals, **Approve · auto-accept edits** and **Approve · ask before edits**, or **Keep planning…** with a note for Claude. The terminal's own prompt stays up the whole time, and whichever answers first wins: the card then reads *Answered in the terminal* or shows what you chose. A value that looks like a secret is masked on the page (*Masked here; the terminal shows the real text*), and an answer is matched to Claude's own unmasked copy, never to the masked text. A request too large to show reads *Too long to show here — answer in the terminal*. If no answer comes from the page, nothing is answered for you: the terminal prompt simply stays. Claude reads a Deny from the page as your decision and does not retry the same call. Through the tunnel, you answer the same way in a project at the `full` mirror level (`claude-web-chat tunnel mirror on`): the frames load from the project's answer host, and on a phone, as in Firefox and Safari, a request opens in a small window (**Review & answer ↗**). At `read` a remote viewer sees the request read only, with **Review ›**, and it is answered in the terminal.

**Sending Claude a message.** The chat has a composer at the bottom. Type and press Enter (Shift+Enter for a new line) or **Send**. Start with `/` to pick one of the skills Claude can run in this conversation (a skill picked here asks Claude to run it; Claude Code's own commands such as `/clear`, `/compact` and `/model`, and skills only you may run, are refused with a hint to type them in the terminal; with the web-chat mod five of them run, see below). Type `@` to attach a file from the project: it is sent by **path**, never its contents, and Claude reads it itself; a file outside the project, an ignored one, a link or one that looks like it holds secrets cannot be attached. A message is at most 3,000 characters with up to five files. While Claude is working, a message waits for its turn to end and shows **next**, then **#2** and so on, and goes in order, one per turn; **Send now** (on its row in the queue tray) sends it at once whatever Claude is doing, and **Hold** keeps it from going on its own. A waiting message can be edited from its row too. Under the message the chat says what happened to it: *sending…*, then **Sent** once it reached a live channel, *With your next message* when it was parked for the next prompt you type in the terminal (see Channels below), **Received** once Claude's transcript shows it, or *failed —* with **Retry**. For a live channel it stays at *Sent* until validation gate V30 is recorded, which confirms how a live message shows in Claude's transcript; until then only parked messages reach *Received*. A parked message can be taken back from the queue rail with **Take back**, which returns your message to the queue and leaves anything else in that delivery parked. The composer needs the mirror: on this machine, before the page has heard from it or with the mirror off, it reads *Sending messages from this page is off — reply in the terminal.* Through the tunnel it is there only at the `full` mirror level; below that it says messages are sent from the host, or with `claude-web-chat tunnel mirror on`.

**Stopping background work.** A row in the bar's trays has **Kill** (a shell), **Cancel** (an agent or a workflow) or **Remove** (a monitor). Confirm it and web-chat asks Claude to stop that task with its TaskStop tool: the row reads *stopping…* until Claude does, and if nothing confirms the stop within a minute it says to stop it in the terminal. During a long turn the request lands at Claude's next tool call. A stop request carries the task's id and nothing else, so a task's title can never put words in your mouth.

**Stopping Claude.** While Claude is working, the bar (and the chat's header) has a stop control. **Interrupt** is the terminal's own Esc, typed for you: it stops the reply, kills the running tool and declines a waiting permission prompt, keeping what was already written. It is offered only on this machine, and only when web-chat's server in that Claude Code session holds its terminal; it reads *Interrupting…*, and *Interrupted* once the conversation shows it stopped. Everywhere else, or when no confirmation comes within 3 seconds, the control is **Stop after this step**: Claude stops at its next tool call, which cannot cut off text already being written and waits for the tool that is running. A control that can do neither says *Stop from the terminal (Esc)*. A stop is at most once every 1.5 seconds per conversation, and the turn's node records that it was stopped from the page.

**Restore files.** In a git repository, a turn that changed files has **Restore files** among its footer actions, and a node in the graph inspector has **Restore files to before this node**. It opens a preview of what would happen — the files rewritten, re-created and deleted, and what it does not cover and why (ignored files, files over the size cap, nested repositories) — with *Nothing to restore: the files already match.* when that is so, and a note when HEAD has moved since that turn (files go back; commits and branches do not). Edits made since that turn, yours included, are reverted too. The confirm is in a frame like the others. It is refused while a turn is in progress, while any conversation in the project is working, waiting or compacting, while another Claude Code session inside the project is busy, or when the files changed after the preview (open it again). It never touches your commits, branches, index, ignored files or anything outside the project. After a restore a toast offers **Undo** for 30 seconds, and the next prompt you type tells Claude which files were put back (*Files restored from the web-chat page*), so it re-reads them before editing. Restore files is not offered when it cannot work here: when git is older than 2.40, when per-turn diffs are off (`WEB_CHAT_MIRROR_DIFFS=0`), or when the project is not a git repository — and, in a new project, until web-chat has snapshot a first turn (it can take up to half a minute after that to appear). See [`code-revert.md`](code-revert.md) for what it does exactly.

**Fork from here.** A turn's footer also has **Fork from here**: confirm it and web-chat forks the conversation from just before that turn, with no model call and no cost, and answers the command to paste into a terminal, `claude --resume <id>`. The original conversation is untouched, and no files are restored (that is Restore files). It is not offered when `claude` is not on the daemon's PATH, or when the chat mirror is not reading transcripts; the first turn of a conversation, or one abandoned by a rewind, cannot be forked.

**Images in a message.** **Add image** in the composer, a pasted image or a dropped one adds a PNG, JPEG, GIF or WebP image of up to 5 MB to your message, at most 20 a minute. web-chat checks the bytes are the image their type says, saves it under `.web-chat/attachments/` and names it in the message by its **path**, like a file from `@`, for Claude to read; the page shows your own copy as a chip, and the server never serves the image back. The project keeps the newest 50: an older one is deleted when you add another. It works with or without the web-chat mod, wherever the composer is on (the `full` mirror level), and an image counts toward the message's five files.

**Answering an MCP server's form.** When an MCP server asks you to fill in a form (an *elicitation*), the bar reads **MCP input · <server>** and the chat's waiting card shows the form: the server's message and one field per question, a text box, a number, a checkbox or a list. **Every field starts empty** — the page never fills one in for you, and a default only shows as a placeholder. **Accept** (once every required field holds a valid value), **Decline** or **Cancel** answer it; **Answer in the terminal** leaves it to the terminal. Claude Code shows its own dialog only after web-chat lets the form go, so web-chat holds it for the page only while a page of this project is open on this machine, and for at most 45 seconds; with no page open, or after that, the terminal's dialog appears as usual. Only flat forms are drawn here (text, numbers, true or false, a list of choices); anything else, and a server asking you to open a link, is answered in the terminal. It is for you at this machine only: in 0.8.5 a form is never answered through the tunnel, at any mirror level, because a form can ask for credentials. What you type goes straight to Claude Code and is never logged or kept.

**With the web-chat mod.** The mod is a small Claude Code plugin that `install` switches on where Claude Code 2.1.287 or newer can run it (see [`mod.md`](mod.md); `claude-web-chat mod off` opts a project out). With it attached to the conversation: **Interrupt** stops the turn at once through the mod; **Kill**, **Cancel** and **Remove** confirm in a frame and stop the task at once; a tool's card appears as the tool starts, and Claude's reply streams in as provisional text the transcript's copy then replaces; a composer message is typed into the session as a prompt (the same quoted, marked block, so it reaches **Received** from the transcript), and `/plan`, `/compact`, `/context`, `/rename` and `/recap` are listed first under `/` as *runs in the terminal* and run as Claude Code's own commands — `/plan` and `/compact` with an optional line of up to 2,000 characters, `/rename` with a name of up to 64 — their receipt confirming when the mod reports they ran. The chat panel's header gains the **session controls**: a context meter, shown once Claude Code first reports the context through the mod (it is never estimated from the transcript), **Compact now** (it says *Compaction did not start — run /compact in the terminal* if nothing starts within 2 minutes), **Plan mode** (which also switches the model, as `/plan` does; leave plan mode in the terminal with Shift+Tab), and a ⋯ menu with **Rename…** and **Clear**, each behind a confirm. With `WEB_CHAT_REWIND_IN_PLACE=1` in the server's environment (experimental, off until a validation gate passes), a turn's footer also offers **Fork here and switch the terminal**, and the ⋯ menu **Resume ▸**. Without a mod, everything in this section works as described above it: Stop is *Interrupt* (the terminal's Esc) or *Stop after this step*, a stop request lands at Claude's next tool call, the chat follows the transcript a few seconds behind, a message wakes Claude through a channel or rides your next prompt, the five commands are refused with a hint to type them in the terminal, and there are no session controls. Permission prompts are answered as above either way: answering them through the mod is built but stays switched off in 0.8.5 until validation gate V41 is recorded.

Every one of these is for you at this machine, or through the tunnel at the `full` mirror level, where the frames load from the project's answer host (see [`remote-access.md`](remote-access.md#answering-claude-remotely)); at `read` a remote viewer only watches. A remote Stop never types Esc in your terminal: without a mod it is *Stop after this step*, and with the mod attached it reads **Interrupt** and the mod aborts the turn. On a phone, as in Firefox and Safari, an answer opens in a small window; Stop, Restore files and Fork have no such window, so in a browser where their frames do not load they are not offered. Each action, and each refusal, is written to an audit log under `.web-chat/` (never file contents or what you typed), a remote one marked as such.

## Your project's name and icon

The topbar, the tab and a phone's home screen show your project's identity: a name (the folder's, until you set one), a logo, a favicon, and a dark variant of each. Set them from the terminal with `claude-web-chat identity` — or share the image with Claude and say what it is for: the **project-identity** skill, which `init` installs, walks Claude through looking at the artwork, agreeing the choices with you and showing you the candidates first.

```sh
claude-web-chat identity show                                  # the name, the images, and which one is the mark
claude-web-chat identity name "Acme Web"
claude-web-chat identity logo logo.png --dark auto --preview   # candidates on the surface, to pick from; applies nothing
claude-web-chat identity logo logo.png --dark auto             # the logo and a generated dark variant
claude-web-chat identity favicon icon.png --dark icon-dark.png # the tab's icon, with your own dark one
claude-web-chat identity favicon wordmark.png --pad            # a wide image centred on a square (--crop x,y,w,h cuts first)
claude-web-chat identity clear favicon                         # or logo, name, touch, all
```

The tab shows the **mark** — the favicon, else a square logo, else web-chat's W (blue in a light browser, gold in a dark one) — and follows the browser's own light or dark setting, while the topbar follows web-chat's ◑ mode. While Claude needs you, the tab's icon wears a dot: rust for a permission or a plan, gold for a question. Setting a favicon (or a square logo, when there is no favicon) also makes the 180×180 home-screen icon a phone uses when you add the page to it; `clear touch` removes it, and an SVG favicon leaves web-chat's W there. `--pad` is for a favicon only and warns when text in it would be unreadable at 16px; neither `--pad` nor `--crop` applies to an SVG. With the surface running the change shows at once; without it, the files are written directly and show at the next start. A browser may keep showing an old favicon until a hard refresh.

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

**It works with or without the Channels capability.** For a *live, no-prompt* wake, launch Claude Code with both the env var and the capability flag — they belong together on the launch line, so a session can never claim a channel it doesn't have. web-chat starts its side of the channel only in a session that was launched this way (`--channels web-chat` counts too); `WEB_CHAT_CHANNEL=1` alone, inherited by a session that never loaded the channel, no longer starts it, and the server says so once on its stderr. If you start Claude Code through a wrapper that hides its command line, set `WEB_CHAT_CHANNEL_FORCE=1` as well:

```sh
WEB_CHAT_CHANNEL=1 claude --dangerously-load-development-channels server:web-chat
```

With that, a Push — or a message from the composer — wakes Claude immediately, and only the session the message is for: with two sessions in a project, each message goes to the conversation you sent it in. **Without it, a Push isn't lost** — the batch is *parked* and delivered as context with your **next message** (the rail says "delivers with your next message", which is exactly what happens). That next message is typed into Claude Code on this machine, so a Push from your phone through the tunnel waits for you to get back to the terminal unless the session has Channels — start it with the line above before you leave ([`remote-access.md`](remote-access.md)). The **Channels** capability is a research preview (needs Claude Code ≥ 2.1.80 and Anthropic auth); parked delivery is the universal fallback and needs neither. Details in [`channels-dev.md`](channels-dev.md).

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
doctor              diagnose and repair daemon / lock / MCP / hook issues;
                    registers web-chat's MCP server with Claude Code at local
                    scope (--register-mcp: over a No recorded in Claude Code,
                    or a tracked .mcp.json, without a terminal)
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
mod [verb]          the web-chat mod, a Claude Code plugin (2.1.287+) that
                    install switches on where Claude Code can run it: on | off |
                    status — off opts this project out (remembered), on switches
                    it back on, status says 'on', 'off (opted out)' or
                    'tier 1: <reason>' and which sessions attached (mod.md)
install             the setup step on its own, and how updates reach a project
update              install the latest GitHub release (checksum-verified), sync,
                    restart; --list shows versions on disk, --to <v> rolls back,
                    --from <tarball> installs a local build (a --dev build from
                    scripts/build-release.js), --restart-all restarts every other
                    project still running an older build and refreshes the
                    managed files of each one web-chat is registered in
uninstall           remove the hooks (your graph data is kept); --self also
                    removes the program itself
tunnel [verb]       EXPERIMENTAL and unstable (use it at your own risk):
                    reach your surfaces from your phone or another machine:
                    setup | up | down | status | logs, through a Cloudflare
                    tunnel behind Cloudflare Access — an emailed code plus your
                    device's biometrics by default, or Google (see
                    remote-access.md); mirror on | off | status shows (or
                    stops showing) this project's conversation to remote
                    viewers, who otherwise see only Claude's status
identity [verb]     set the project's name, logo and favicon (show | name |
                    show-name | logo | favicon | clear): the topbar lockup, the
                    tab title, the tab's favicon and the home-screen icon; logo
                    and favicon take a dark variant (--dark auto or a file) and
                    --dry-run / --preview to compare candidates first
```

Inside Claude Code, `/web-chat <subcommand>` runs any of these without leaving the chat, and bare `/web-chat` is the guided start above.

## Who can reach it

The server binds **loopback only** (`127.0.0.1`) and is deliberately unauthenticated: anything that can reach the port can read the graph and the shared store, and render arbitrary HTML/JS into your browser. So the bind address *is* the access control.

- Other programs on your machine can drive the surface — that's the point (see "Other processes can draw too" above), and it means you should treat a component from an untrusted source the way you'd treat running its code, because that is what it is.
- The WebSocket upgrade is gated on `Origin`, so a random web page you happen to visit can't open a socket to `ws://localhost:<port>` and read your store. Non-browser clients (drivers, the CLI) send no `Origin` and are unaffected.
- Captures are only readable cross-origin by the browser extension, not by any site you're browsing.
- `WEB_CHAT_HOST` overrides the bind address for the deliberate remote case (a dev container, a remote workstation). Setting it exposes all of the above to that interface with no authentication, and the server says so on startup. The chat mirror is the exception: it shows network peers only Claude's status (what it is doing, never your prompts, its replies or a file), whatever they send — Claude's conversation leaves this machine only through the authenticated tunnel, below.
- To reach your surfaces from **outside** this machine, don't widen the bind — use `claude-web-chat tunnel`: the daemons stay on loopback, and a separate portal admits only an email address you allowlisted, verified by Cloudflare Access and again locally (sign-in is an emailed code plus your device's biometrics by default, or Google). The walkthrough and the security model are in [`remote-access.md`](remote-access.md).

## When something's stuck

Start with `claude-web-chat doctor` — it checks the daemon, portfile, MCP registration, and hooks, and repairs what it can. A few situations worth naming:

- **Claude's tools return "disabled".** Some scope has web-chat off; `claude-web-chat status` shows which one.
- **The web-chat tools never show up in Claude Code.** Run `claude-web-chat doctor` in the project, then `/exit` and start Claude Code again. web-chat registers its MCP server with Claude Code for you at *local scope* (in Claude Code's own config, for this folder), which needs no approval at launch; `doctor` makes that registration when it is missing, and `claude-web-chat status` says which state the project is in (*registered for you (local scope)*, *only in .mcp.json*, *REJECTED*, *disabled*). If you once answered No to Claude Code's dialog for web-chat, `doctor` asks before registering over it (it defaults to No; `--register-mcp` does it without a terminal). If you disabled web-chat through `/mcp`, `doctor` leaves that alone: re-enable it there.
- **The graph won't let you navigate.** An interrupted turn can leave the turn lock held, and Set active, ⑃ Branch and `A` stay off (*locked — turn in progress*) until it goes stale — 15 minutes after Claude's last write, 3 for a channel wake. Then the next click takes it over, keeping the abandoned turn's work as a node of its own; `claude-web-chat unlock` clears it at once.
- **A dashboard pane is sitting there empty.** Its component ships a `service.js` that hasn't been approved. `claude-web-chat trust` lists what's waiting.
- **You've lost track of which port is which project.** `claude-web-chat ls` maps every running surface back to its project; `--reap` asks the ones you're done with to shut down cleanly.
- **You don't know which projects Claude is actually attached to.** The CLAUDE column in `claude-web-chat ls` counts the Claude Code sessions that have web-chat loaded in each project — a project with a session but no surface is listed too — and `· channel` marks one a Push wakes mid-session. It is the live process, not the last tool call: a session appears the moment it starts and goes when it exits. TURN says whether one is mid-turn right now. The same view is in the browser: **⋯ → Sessions** (or `S`, or ⌘K *Sessions…*) lists every project with its surface and Claude state, refreshes every few seconds while open, opens another project's surface in a new tab, and gives a stopped one's `claude-web-chat open` command to copy — the page never starts a surface itself. Projects known on this machine with nothing running sit in a collapsed **Inactive** group (`ls --all` prints them too); through the remote portal, the picker can start one of those after you confirm (see remote-access).
- **You've updated, and don't know which Claude sessions still run the old tools.** A Claude Code session keeps the web-chat MCP server it started with until you restart it. `ls` (its VERSION column), the Sessions panel and the tunnel picker show the web-chat release of each surface and each attached Claude session, and a row whose Claude session is on a different release than its surface carries a ⚠ saying which side to restart — *Claude is on v0.8.0 — restart Claude Code to pick up v0.8.1*, or `claude-web-chat restart` when it is the surface that is behind. (A session started under 0.7.x records nothing and is not listed at all.) You rarely have to look: a successful `update` ends by telling you to `/exit` and reopen Claude Code, `claude-web-chat status` names the build this project's server runs (with a ⚠ and `claude-web-chat restart` when it is not the CLI's), and Claude is told — on your next prompt when the server is on another build, and in its next tool result when its own session started before the update (on an install `update` manages, not a checkout) — so it can tell you which to restart.
