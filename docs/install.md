# Installing, updating, and removing web-chat

The README's quickstart is the short path. This is the long one: what each step
actually does, how updates and rollback work, and exactly what lands on your
machine.

## Requirements

**Node 22.12+** and **Claude Code**, on **macOS or Linux**. The web-chat mod (below) needs **Claude Code 2.1.287 or newer**; on an older Claude Code everything else works and the mod is simply not switched on.

**Platforms.** macOS and Linux are supported — the full suite runs on both in CI on every push. **On Windows, use WSL2**: web-chat installs and runs inside your WSL2 Linux environment like any other Linux install, and there is no native Windows installer. What each of those actually means, and what is known to be untested, is in [`platform-support.md`](platform-support.md).

## Install the package

```sh
curl -fsSL https://raw.githubusercontent.com/Brynhild-CHale/claude-web-chat/main/install.sh | sh
```

That checks you have Node 22.12+, downloads the latest **GitHub Release**, verifies its SHA-256 checksum, and unpacks it — no npm, no registry, no sudo. Everything lands in your home directory:

```
~/.web-chat/versions/<version>/ the release, self-contained (dependencies included)
~/.web-chat/current      ->     versions/<version>  (rollback = one symlink swap)
~/.local/bin/claude-web-chat -> ~/.web-chat/current/bin/claude-web-chat.js
```

The script is short and does nothing but that — [read it](https://raw.githubusercontent.com/Brynhild-CHale/claude-web-chat/main/install.sh) before piping it to a shell if you like. Re-running it is always safe.

Verify it worked:

```sh
claude-web-chat help
```

You should see the command list. If your shell can't find it, `~/.local/bin` isn't on your PATH — the installer prints the exact `export PATH=…` line to add to your shell profile.

`claude-web-chat version` answers a question that matters more than it sounds: **which copy am I actually running?** It prints the running tree, what `~/.web-chat/current` points at, and what the `claude-web-chat` on your PATH resolves to, and shouts if those disagree.

**Developing on web-chat itself?** Work from a checkout and run it in place — see [`extending.md`](extending.md), which also explains why `npm link` is the one thing not to do here:

```sh
git clone https://github.com/Brynhild-CHale/claude-web-chat.git
cd claude-web-chat
npm install
node bin/claude-web-chat.js help
```

## Wire it into a project

web-chat is opt-in per project. In any project where you want it:

```sh
cd ~/Dev/my-project
claude-web-chat init
```

`init` is the one entry point, and it works out for itself which of two jobs it is doing. It works on the folder you type it in, or the one you name (`claude-web-chat init ~/Dev/my-project`; the folder must already exist). In a folder with no `.web-chat/` it is first-time setup: it lists every file it is about to create or edit, asks once, runs the install, offers to open the surface, and leaves a short interactive tour on the page for you to work through while Claude Code restarts. In a folder that already has web-chat it is orientation and repair instead: it runs `doctor`, reports managed-file drift, lists every web-chat surface running on your machine and which project each one is, and offers — one confirm-first question at a time, defaulting to the safe answer — to fix what it found. It never reaps another project's daemon, runs `update`, discards your local edits, or approves a service without you saying yes. A folder inside another web-chat project is set up as a separate project of its own, and `init` says so before it asks (see [Nested installs](#nested-installs)); `claude-web-chat init --nearest-parent` checks and repairs the nearest web-chat project at or above the folder instead — what `init` did by default before 0.8.5.

Under the hood the setup step is `claude-web-chat install [folder]`, which you can still run directly. Like `init` it sets up the folder it is typed in, or the one named, even inside another web-chat project (it prints one line naming the project above when it does), and `install --nearest-parent` updates the nearest web-chat project at or above the folder instead. A folder that does not exist, a file, or two folders are refused before anything is written. It registers the web-chat MCP server with Claude Code for this folder (at Claude Code's *local scope* — see below), merges web-chat's Claude Code hooks into `.claude/settings.json` (existing hooks are preserved; what they are is below), drops usage guidance for Claude into `.claude/rules/` plus a `/web-chat` slash command and three skills (`capture-profile`, `respond-to-comment` and `project-identity`) into `.claude/`, creates `.web-chat/` for the project's graph and components, adds `.web-chat/` to the project's `.gitignore` inside a git repository (unless git already ignores it there: a `.web-chat/` line in the repository root's `.gitignore` covers every folder in it, a `/.web-chat/` line only the root — a subfolder it does not cover gets the line in its own `.gitignore`), and pre-warms the background server. Your `CLAUDE.md` is never touched, and re-running either command is always safe. Neither runs in your home directory: `~/.web-chat/` is web-chat's own per-user state, so `$HOME` is never a project, and both refuse there before writing anything (an install an older version made in `~` is removed with `claude-web-chat uninstall`, typed there).

**The hooks it registers** are fifteen handlers on thirteen Claude Code events. Each runs as a short-lived process and exits cleanly even when something goes wrong, so a web-chat hook never fails your turn.

- `UserPromptSubmit` and `Stop` run each turn's lifecycle: the turn lock, and the graph node a turn commits. `StopFailure`, which Claude Code fires instead of `Stop` when a turn ends on an API error, runs the same commit, so that turn no longer holds the lock until it times out.
- `SessionStart`, `SessionEnd`, `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `SubagentStop` and `PreCompact` tell the chat mirror what Claude is doing as it happens. All but `SessionEnd` run in the background, so a tool call does not wait on them, and a tool's input is cut down inside the hook (a command, a path, never a file's contents) before it reaches the server.
- `PermissionRequest` lets you answer a permission prompt, a question or a plan from the page. The terminal's own prompt stays up the whole time and whichever answers first wins; with no answer from the page, nothing is answered for you.
- `Elicitation` lets you answer an MCP server's form from the page. It holds the form only while a page of this project is open on this machine, for at most 45 seconds; otherwise the terminal's dialog appears as before.
- Three more, on `PreToolUse`, `PostToolUse` and `PostToolBatch`, are a small shell script behind the page's *Stop after this step*. Until a stop is set, they print nothing and change nothing.

Running `install` again — or `update`, or `doctor` — repairs them: it adds a handler the project is missing, gives a bare `claude-web-chat-hook` command its absolute path, and puts back the template's settings (a timeout, running in the background) on a web-chat handler that differs from this build's, leaving every other hook in the file alone. A project an update does not reach keeps the hooks it has until `install` or `doctor` runs there, and `claude-web-chat status` and `doctor` say which handlers are missing or out of date and what each one costs. When the hooks change, restart Claude Code (or open `/hooks` to review them): a session that is already running may not pick up a hook `install` has just added.

**The web-chat mod.** Where Claude Code 2.1.287 or newer can run it, `install` (and `init`) also switch on the web-chat mod: a small Claude Code plugin, installed at Claude Code's local scope from a marketplace web-chat keeps in the project's own `.web-chat/mod/`, by Claude Code's own `claude plugin` commands, so nothing is written to your user settings. Restart Claude Code in the project to load it. It makes Stop and Kill immediate, streams the chat live and types composer messages into the session; without it everything works as before. `claude-web-chat mod off` takes it off and remembers that, so a later `install` leaves it off until `claude-web-chat mod on`; `claude-web-chat mod status` says whether it is on, off (opted out) or on tier 1 with the reason (an older Claude Code, say), and which sessions it attached to. `update` never switches it on: it prints the command to run. See [`mod.md`](mod.md).

`claude-web-chat init --report` (or `--json`) is the read-only twin: it diagnoses without repairing, writes nothing, prompts for nothing, and exits non-zero when something needs attention — which is what makes it usable as a CI health gate. Its state block says which rule picked the folder (`root_rule`: `here` or `nearest-parent`) and the web-chat project above it, if any (`enclosing`). `/web-chat init` runs `init --report --nearest-parent`, so in a Claude Code session started in a subfolder it reports the project that session uses.

### Nested installs

A web-chat project can sit inside another — a package of a monorepo with its own surface, say. What Claude Code does with that, as measured in Claude Code 2.1.289 and re-read in 2.1.294:

- **The MCP tools** in a session use the surface of the nearest folder at or above the folder the session started in that has web-chat.
- **The hooks** live in `.claude/settings.json`, which Claude Code reads only from the folder the session started in. A session started in a subfolder of a project gets the tools (inside a git repository only) but none of the hooks, so its turns do not commit — unless that subfolder has its own install.
- **The rules** in `.claude/rules/` are read from the start folder and every folder above it, so a session in a nested install loads both installs' web-chat rules.
- **Inside one git repository** every install shares one local-scope MCP registration, keyed by the repository's root, and `uninstall` keeps it while another install in the repository still uses it.

Then **restart Claude Code** in the project: it loads MCP servers only at startup, so the web-chat tools appear in the next session, and that is the only step left. `install` registers web-chat's MCP server by running `claude mcp add web-chat --scope local` from the project root, which puts it in Claude Code's own config (`~/.claude.json`, or the one under `CLAUDE_CONFIG_DIR`) for this folder — inside a git repository, for the whole repository and its worktrees, and `install` says so. A server registered that way needs no approval, so Claude Code never asks about it. A server in a project's `.mcp.json` does, and in a folder that is not a git repository but sits inside one Claude Code trusts, Claude Code cannot keep that approval: it asks on every launch, and its default answer, No, rejects the server for good, with every web-chat tool hidden.

If web-chat's entry is still in the project's `.mcp.json` (every project set up before 0.8.5), `claude-web-chat doctor` makes the move: it registers the server at local scope, checks the entry landed, and only then takes web-chat's own entry out of `.mcp.json` — and the file with it, when nothing else is left. It asks first (default No) before editing a `.mcp.json` git tracks, and keeps an entry that differs from what it registered, or that sessions in folders below the project still reach. When someone answered No to Claude Code about web-chat here, `install` on an existing project and `doctor` ask before registering over that No (default No); `--register-mcp` answers yes without a terminal, and `claude-web-chat off` is the way to say No that web-chat itself honours. If `claude` cannot be found (not on your PATH, in `~/.local/bin` or in `~/.claude/local`), `install` writes the `.mcp.json` entry instead and says so: Claude Code will then ask you to approve it, and `claude-web-chat doctor` finishes the registration once `claude` is available. `claude-web-chat status` says which of these is true here.

## Open the surface

```sh
claude-web-chat open
```

This starts the background server (if it isn't already running) and opens the surface in your browser. The port is per-project, starting at 5173 and walking upward, so a second project gets its own. It greets you with a **Nothing on the page yet** card — the empty state, with a prompt to try and the three keys worth knowing first (`G` the graph, `N` a block from the library, `?` every shortcut). That's correct; nothing has been rendered yet.

> Prefer one command? `claude-web-chat launch` opens the surface *and* starts a Claude session together.

## Updating

Run `update` from any installed project:

```sh
claude-web-chat update
```

It resolves the latest GitHub Release, downloads the tarball and its `SHA256SUMS`, **verifies the checksum before unpacking anything**, unpacks into `~/.web-chat/versions/<version>/`, swaps the `~/.web-chat/current` symlink, restarts the background server (and a running [tunnel portal](remote-access.md), so remote viewers reconnect to the new build), reports the version before and after, and — where web-chat is registered, its hooks or its `.mcp.json` entry in place — syncs *that* project's managed files (the Claude rules file, the `/web-chat` command, and the three skills) edit-preservingly: untouched files update automatically, your edits are kept, and a genuine conflict lands beside your file as `<file>.new` for you to merge — never a silent overwrite. Merging is by hand, and **deleting the `.new` is what finishes it**: until you do, `install`, `update`, `status` and `init` keep reminding you it is there; once you do, that file is settled and stays yours until the template changes again. (`claude-web-chat install --force` is the shortcut that adopts the shipped version instead, and it discards your edits.)

Run `update` inside a web-chat project: outside one it installs and syncs nothing project-side, and restarts no server. `update` never writes Claude Code's own config: in a project whose MCP server is still registered only through `.mcp.json`, it prints one line naming `claude-web-chat doctor`, which moves it to local scope. In a directory that has a `.web-chat/` but where web-chat is not registered — a project you ran `uninstall` in, or one an old build started a server in — it restarts the server and writes nothing else there; `claude-web-chat install` registers it.

`update` restarts one server, the project's you typed it in. Every other project whose surface is open keeps running the old build (a server with a tab attached never exits on its own), so `update` lists each one on another build, with the command for it: `cd <project> && claude-web-chat install`, which restarts its server and refreshes its managed files (`restart` instead after a rollback, and where web-chat is not registered, since `install` would register it there; for a server an old build started in your home directory, `claude-web-chat ls --reap`, which stops it along with every other project's server) — or restarts them all, one at a time, with `claude-web-chat update --restart-all` (which also works when there is nothing new to install, and when GitHub cannot be reached). After each restart, `--restart-all` also refreshes the managed files of each project web-chat is registered in — its hooks or its `.mcp.json` entry in place, both before the restart and after it: exactly what `claude-web-chat install` writes there, through the same engine and the new build's templates, edit-preserving, with one line per project saying what it refreshed and anything left for you to do there. A directory where web-chat is not registered (an uninstalled project, or one an old build started a server in) is restarted but its managed files are never written — though the restart itself writes its `.web-chat/` state and makes it a known project (see `projects.json` below). A server in your home directory is stopped, not restarted, since no server starts there from 0.8 on. A project whose restart fails is left as it was, and a refresh that stops part-way is reported without stopping the next. The `update` that runs is the installed build's, so this needs 0.8.2 or later installed: the update that brings you from 0.8.0 to 0.8.2 restarts the others without refreshing them. `install`, `open` and `start --daemon` restart a server still on an older build too, in one line, and `claude-web-chat status` shows the build this project's server runs, with a ⚠ and the `restart` to run when it is not the CLI's.

A successful `update` ends by telling you to `/exit` and reopen Claude Code: each open session keeps the web-chat MCP server — and the tools — it started with. When the restart replaces a server older than 0.8 (the update onto 0.8, or a `claude-web-chat restart` of an old server in another project), the restart prints the rest of that upgrade as a checklist instead: reload every open tab, `/exit` and reopen Claude Code, and run `update --restart-all`, which restarts every other project's server still on the old build and refreshes those of them web-chat is registered in — then `install` in every other project you use web-chat in (one whose server was not running, or the one you ran `restart` in) — with a link to the release notes.

For your *other* installed projects, `update --restart-all` syncs the managed files of each one whose server it restarts and web-chat is registered in; in any other, run `claude-web-chat init` (or `install`) to sync them (`--force` takes the shipped version). You don't have to remember which: each time you run `claude-web-chat open` in a project whose managed files are behind the package, it names them in one line, with `claude-web-chat install` to refresh them, and `claude-web-chat status` reports them on its `Managed:` line.

A failed or tampered download changes nothing: `current` only moves after a complete, verified unpack, so the install you have is the one you keep.

Old versions stay unpacked (the newest three, plus the newest release), which makes a rollback a symlink swap rather than a reinstall:

```sh
claude-web-chat update --list        # what's on disk, and which one is live
claude-web-chat update --to <version>    # go back to it — no download, no network
```

A rollback says so (*Rolled back: v0.8.0 → v0.7.6.*), and lists the projects still running a different build.

**`update` refuses to run from a git checkout**, loudly, and tells you to `git pull` instead. That is deliberate. npm's global prefix is a shared directory, and an unrelated `npm i -g` once replaced this package's link to a dev checkout with a copy of a build from 16 days earlier — green tests, ancient binary, no warning anywhere. Releases now live in a directory only this program writes, and `claude-web-chat version` will always tell you which tree you are running.

The surface also checks for new **GitHub releases** (once a day, cached in `~/.web-chat/`) and shows a dismissible banner linking the release notes when one is newer than your build. Taking the update is always your call from the terminal — the page will not install anything.

Developing from a checkout? `git pull` (plus `npm install` if dependencies changed) is the whole package update. If you also run a `--dev` build of it as the managed install, `version` and `status` typed inside the checkout say when that build was cut from a commit other than the checkout's HEAD. They cannot tell which of the two is newer — a build cut on another branch may be ahead of the checkout — so they name both commits and leave rebuilding to you (see [Testing an unreleased build](extending.md#testing-an-unreleased-build)).

`claude-web-chat update --from <tarball>` installs a build that is already on disk instead of asking GitHub — verified against the `SHA256SUMS` beside it, and otherwise the same install. It exists for testing an unreleased build; see [Testing an unreleased build](extending.md#testing-an-unreleased-build). It needs an installed build that has it — the 0.8.0 dev builds or later. The `update` in 0.7.5 and 0.7.6 does not know the flag and silently ignores it (falling through to a normal GitHub update), so an older install takes the one-time manual bootstrap described there first.

## Turning it off

`claude-web-chat off` disables web-chat for the current project; `on` re-enables it. Add `--global` to toggle every project on the machine at once, or `--session=<id>` for a single Claude Code session. If any applicable scope says off, web-chat is off — hooks go quiet and Claude falls back to plain chat, telling you why.

And since it's opt-in, projects you never ran `install` in are simply inert.

## What it writes to your machine

- `<project>/.web-chat/` — the project's own state: the graph (`graph/`), the live page kept over a graceful restart (`draft.json`), saved components (`components/`), captures from the browser extension (`captures/`), exports (`exports/`), the project's theme library and theme (`themes/`, `theme.json`, and `theme-default.json`, the pack a project created on 0.8 or later starts in), capture profiles (`profiles/`), installed packs (`packs.json`, `packs/`), the brand images you drop into ⋯ → Settings, kept per theme (`brand/`), the scratch files of a replay render (a throwaway browser profile, video frames) while one runs (`tmp/`), the state schema version (`_version.json`), what each managed file was last synced to (`managed.json`), how and when web-chat last registered its MCP server with Claude Code (`mcp-registration.json`: the scope, the time, the command with any env values left out, and the config file and key it landed under), the server's portfile and logs (`server.json`, `server.log`, `hook.log`), and an empty `services/`. With the chat mirror it also keeps the mirror's own state (`mirror/`: the Claude Code conversations it follows, a turn index per Claude Code session, the per-turn code diffs, and a shadow git store of the working-tree snapshots they are taken from); all of it is derived from Claude Code's transcripts, the graph and the working tree, so deleting it costs a re-scan and the older code diffs, nothing else. Once you set one, it keeps the project's identity: its display name and whether the topbar shows it (`project.json`), its logo and favicon with their dark variants (`project-logo`, `project-logo-dark`, `project-favicon` and `project-favicon-dark`, each a `.svg` or a `.png`), and its home-screen icon (`project-touch-icon`, a `.png`). As the features behind them are used, it keeps a log of the prompts answered from the browser (`asks/`: ids, the tool and the outcome, never a command or an answer), the log and restore record of the page's control actions, such as an interrupt or a code revert (`control/`: ids and file lists, never file contents), the mod's staged package, the project's own plugin marketplace, with a record of the version installed and of an opt-out (`mod/`), and the images you attach to a message (`attachments/`). Three more exist only once you make them: `disabled` (`claude-web-chat off`), `no-remote` (keeps the project off the [tunnel](remote-access.md)) and `capture-token` (a shared secret the capture endpoints then require). `install` adds `.web-chat/` to your `.gitignore` (unless a rule for it is already there).
- `<project>/.claude/` — hook entries merged into `settings.json`, plus the managed rules file, the `/web-chat` slash command, and three skills (`capture-profile`, `respond-to-comment`, `project-identity`).
- Claude Code's own config — `~/.claude.json`, or `$CLAUDE_CONFIG_DIR/.claude.json` — gets web-chat's MCP server for this project at local scope (`projects[<folder>].mcpServers["web-chat"]`, keyed by the git repository's root inside one), written by Claude Code's own `claude mcp add` and removed by `claude-web-chat uninstall` (which prints the command instead when another web-chat project in the same repository shares the entry). From that file web-chat reads only its own entry, the list `/mcp` → Disable writes, and the names of the project folders below this one — and it never writes the file itself. Only when `claude` cannot be found does the server go into the project's `.mcp.json` instead.
- `~/.web-chat/` — the program itself (`versions/<version>/` plus the `current` symlink, and `staging/` while an update unpacks) and per-user state: the disable markers (`disabled` from `off --global`, `sessions/` from `off --session`), the update-check cache (`update-check.json`), saved themes and the user-wide theme (`themes/`, `theme.json`), `services/trusted.json` (which component services you've approved, and for which project), user-tier components, capture profiles and packs (`components/`, `profiles/`, `packs.json`, `packs/`), which projects have been through `init` (`onboarded.json`), the flags behind "stop after this step" (`halt/`, one per Claude Code session, only while a stop is pending), and the capture hub's log (`hub.log`).
- `~/.web-chat/instances.json` — the machine registry: each running daemon, the capture hub and the tunnel portal, plus one row per Claude Code session's web-chat MCP server (its presence, recorded from the moment Claude Code starts it, even in a project where web-chat is switched off). Every change to it, and to `projects.json`, holds `instances.json.lock` beside it for a moment (the lock names its writer's pid, and is gone once the write is done), so two writers starting at once cannot lose each other's rows. A lock whose writer died is broken by one waiter at a time, which holds `instances.json.lock.break` while it does (gone once the break is done). If a break ever moves a live writer's lock it cannot put back, it keeps that file as `instances.json.lock.stale-<pid>-<hex>` and says so on stderr rather than delete it.
- `~/.web-chat/projects.json` — every project whose surface has booted on this machine: the known-projects list `ls --all`, the Sessions panel and the tunnel picker show, and the only projects the tunnel portal can start. An entry whose directory is gone, or no longer has `.web-chat/`, drops out on the next read.
- `~/.web-chat/tunnel/` — only once you run `claude-web-chat tunnel setup`: `tunnel.json`, the cloudflared connector **token** (a secret, kept 0600), `cloudflared.yml` (the ingress generated for a `local` tunnel), `cloudflared.pid.json` (the connector the portal is running, so the next portal can stop one a killed portal left behind), and the portal, cloudflared and remote-access logs. See [remote access](remote-access.md).
- `~/.local/bin/` — three symlinks (`claude-web-chat`, `-mcp`, `-hook`) pointing at `~/.web-chat/current/bin/`.

Nothing else — no system directories, and nothing needing sudo. `uninstall` removes this project's hooks while leaving your graph data alone, then stops the project's server — every one running for it, including one whose `.web-chat/server.json` is gone (it looks on ports 5173–5272) — unless you pass `--keep-running`. A server of a build before 0.8.5 cannot say which project it serves, so it is only named, with the `kill` to run if it is this project's. A Claude Code session still open in the project can start the server again until you exit it, so `uninstall` lists those sessions. `claude-web-chat uninstall --self` also removes the program (the `~/.local/bin` links and every unpacked version), leaving per-user state and every project's graph in place. If a tunnel portal is running, `uninstall --self` stops it and its cloudflared first — no command that could stop them would be left afterwards — and removes nothing if it will not stop. It then stops every web-chat server it can verify on this machine (registry records plus one look at ports 5173–5272, each asked only after it answers as itself) and the capture hub; anything it finds but cannot verify — a build before 0.8.5, a project this machine does not know, a record whose pid no longer answers — is listed with the `kill` to run and never signalled. With `--keep-running` it stops none of them and lists them instead. Delete `~/.web-chat/tunnel/` afterwards to remove the connector token.
