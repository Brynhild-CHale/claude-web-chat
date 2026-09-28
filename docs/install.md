# Installing, updating, and removing web-chat

The README's quickstart is the short path. This is the long one: what each step
actually does, how updates and rollback work, and exactly what lands on your
machine.

## Requirements

**Node 22.12+** and **Claude Code**, on **macOS or Linux**.

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

`init` is the one entry point, and it works out for itself which of two jobs it is doing. In a project with no `.web-chat/` it is first-time setup: it lists every file it is about to create or edit, asks once, runs the install, offers to open the surface, and leaves a short interactive tour on the page for you to work through while Claude Code restarts. In a project that already has web-chat it is orientation and repair instead: it runs `doctor`, reports managed-file drift, lists every web-chat surface running on your machine and which project each one is, and offers — one confirm-first question at a time, defaulting to the safe answer — to fix what it found. It never reaps another project's daemon, runs `update`, discards your local edits, or approves a service without you saying yes.

Under the hood the setup step is `claude-web-chat install`, which you can still run directly: it adds the web-chat MCP server to `.mcp.json`, merges two hooks into `.claude/settings.json` (existing hooks are preserved), drops usage guidance for Claude into `.claude/rules/` plus a `/web-chat` slash command and two skills into `.claude/`, creates `.web-chat/` for the project's graph and components, adds `.web-chat/` to the project's `.gitignore`, and pre-warms the background server. Your `CLAUDE.md` is never touched, and re-running either command is always safe. Neither runs in your home directory: `~/.web-chat/` is web-chat's own per-user state, so `$HOME` is never a project, and both refuse there before writing anything (an install an older version made in `~` is removed with `claude-web-chat uninstall`, typed there).

`claude-web-chat init --report` (or `--json`) is the read-only twin: it diagnoses without repairing, writes nothing, prompts for nothing, and exits non-zero when something needs attention — which is what `/web-chat init` runs, and what makes it usable as a CI health gate.

Then **restart Claude Code** in the project: it reads `.mcp.json` at startup, and on first launch it will ask you to trust the new `web-chat` MCP server — approve it, or the tools won't load.

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

It resolves the latest GitHub Release, downloads the tarball and its `SHA256SUMS`, **verifies the checksum before unpacking anything**, unpacks into `~/.web-chat/versions/<version>/`, swaps the `~/.web-chat/current` symlink, restarts the background server (and a running [tunnel portal](remote-access.md), so remote viewers reconnect to the new build), reports the version before and after, and syncs *that* project's managed files (the Claude rules file, the `/web-chat` command, and the two skills) edit-preservingly: untouched files update automatically, your edits are kept, and a genuine conflict lands beside your file as `<file>.new` for you to merge — never a silent overwrite. Merging is by hand, and **deleting the `.new` is what finishes it**: until you do, `install`, `update`, `status` and `init` keep reminding you it is there; once you do, that file is settled and stays yours until the template changes again. (`claude-web-chat install --force` is the shortcut that adopts the shipped version instead, and it discards your edits.)

Run `update` inside a web-chat project: outside one it installs and syncs nothing project-side, and restarts no server.

`update` restarts one server, the project's you typed it in. Every other project whose surface is open keeps running the old build (a server with a tab attached never exits on its own), so `update` lists each one on another build, with `cd <project> && claude-web-chat restart` — or restarts them all, one at a time, with `claude-web-chat update --restart-all` (which also works when there is nothing new to install, and when GitHub cannot be reached). `install`, `open` and `start --daemon` restart a server still on an older build too, in one line.

For your *other* installed projects, run `claude-web-chat init` (or `install`) in each to sync their managed files too (`--force` takes the shipped version). `claude-web-chat status` tells you when a project's files have drifted behind the package, and the MCP server logs a one-line nudge at session start when a refresh is due.

A failed or tampered download changes nothing: `current` only moves after a complete, verified unpack, so the install you have is the one you keep.

Old versions stay unpacked (the newest three, plus the newest release), which makes a rollback a symlink swap rather than a reinstall:

```sh
claude-web-chat update --list        # what's on disk, and which one is live
claude-web-chat update --to <version>    # go back to it — no download, no network
```

A rollback says so (*Rolled back: v0.8.0 → v0.7.6.*), and lists the projects still running a different build.

**`update` refuses to run from a git checkout**, loudly, and tells you to `git pull` instead. That is deliberate. npm's global prefix is a shared directory, and an unrelated `npm i -g` once replaced this package's link to a dev checkout with a copy of a build from 16 days earlier — green tests, ancient binary, no warning anywhere. Releases now live in a directory only this program writes, and `claude-web-chat version` will always tell you which tree you are running.

The surface also checks for new **GitHub releases** (once a day, cached in `~/.web-chat/`) and shows a dismissible banner linking the release notes when one is newer than your build. Taking the update is always your call from the terminal — the page will not install anything.

Developing from a checkout? `git pull` (plus `npm install` if dependencies changed) is the whole package update.

`claude-web-chat update --from <tarball>` installs a build that is already on disk instead of asking GitHub — verified against the `SHA256SUMS` beside it, and otherwise the same install. It exists for testing an unreleased build; see [Testing an unreleased build](extending.md#testing-an-unreleased-build). It needs an installed build that has it — the 0.8.0 dev builds or later. The `update` in 0.7.5 and 0.7.6 does not know the flag and silently ignores it (falling through to a normal GitHub update), so an older install takes the one-time manual bootstrap described there first.

## Turning it off

`claude-web-chat off` disables web-chat for the current project; `on` re-enables it. Add `--global` to toggle every project on the machine at once, or `--session=<id>` for a single Claude Code session. If any applicable scope says off, web-chat is off — hooks go quiet and Claude falls back to plain chat, telling you why.

And since it's opt-in, projects you never ran `install` in are simply inert.

## What it writes to your machine

- `<project>/.web-chat/` — the graph, saved components, exports, server portfile and log; `brand/` holds the brand images you drop into ⋯ → Settings, and `tmp/` the scratch files of a replay render (a throwaway browser profile, video frames) while one runs. `install` adds it to your `.gitignore` (unless a rule for it is already there).
- `<project>/.claude/` — hook entries merged into `settings.json`, plus the managed rules file, the `/web-chat` slash command, and two skills.
- `~/.web-chat/` — the program itself (`versions/<version>/` plus the `current` symlink) and per-user state: disable markers, the update-check cache, saved themes, `services/trusted.json` (which component services you've approved, and for which project), user-tier components, capture profiles and packs (`components/`, `profiles/`, `packs.json`, `packs/`), and which projects have been through `init` (`onboarded.json`).
- `~/.web-chat/instances.json` — the machine registry: each running daemon, the capture hub and the tunnel portal, plus one row per Claude Code session's web-chat MCP server (its presence, recorded from the moment Claude Code starts it, even in a project where web-chat is switched off). Every change to it, and to `projects.json`, holds `instances.json.lock` beside it for a moment (the lock names its writer's pid, and is gone once the write is done), so two writers starting at once cannot lose each other's rows.
- `~/.web-chat/projects.json` — every project whose surface has booted on this machine: the known-projects list `ls --all`, the Sessions panel and the tunnel picker show, and the only projects the tunnel portal can start. An entry whose directory is gone, or no longer has `.web-chat/`, drops out on the next read.
- `~/.web-chat/tunnel/` — only once you run `claude-web-chat tunnel setup`: `tunnel.json`, the cloudflared connector **token** (a secret, kept 0600), `cloudflared.yml` (the ingress generated for a `local` tunnel), `cloudflared.pid.json` (the connector the portal is running, so the next portal can stop one a killed portal left behind), and the portal, cloudflared and remote-access logs. See [remote access](remote-access.md).
- `~/.local/bin/` — three symlinks (`claude-web-chat`, `-mcp`, `-hook`) pointing at `~/.web-chat/current/bin/`.

Nothing else — no system directories, and nothing needing sudo. `uninstall` removes this project's hooks while leaving your graph data alone; `claude-web-chat uninstall --self` also removes the program (the `~/.local/bin` links and every unpacked version), leaving per-user state and every project's graph in place. If a tunnel portal is running, `uninstall --self` stops it and its cloudflared first — no command that could stop them would be left afterwards — and removes nothing if it will not stop. Delete `~/.web-chat/tunnel/` afterwards to remove the connector token.
