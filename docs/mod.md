# The web-chat mod

The web-chat mod is a small Claude Code plugin of function hooks that runs inside
your Claude Code session and talks to the project's web-chat server. With it,
some of what the page does becomes immediate: Stop and Kill act at once, tool
cards and Claude's reply text appear live, and a message from the page's
composer is typed into the session as a prompt. Without it, web-chat works as it
always has (tier 1: hooks, the transcript and web-chat's own MCP server), and
everything below says what each feature does with no mod.

It needs **Claude Code 2.1.287 or newer**. Mods are an early-access feature of
Claude Code that "may change between releases without notice", so the mod is
never a dependency: every path it serves falls back to tier 1.

## On by default

`claude-web-chat install` (and `claude-web-chat init`, which runs it) switches the
mod on in the project wherever Claude Code can run it. It is a **local-scope**
plugin, installed from a private marketplace kept in the project's own
`.web-chat/mod/` by Claude Code's own `claude plugin` commands: web-chat writes
no Claude Code settings file itself, nothing goes into your user settings, and
no other project is touched. Restart Claude Code in the project to load it — a
running session does not pick it up.

`claude-web-chat update` never changes Claude Code's configuration behind your
back, so it does not switch the mod on: it prints the command to run instead
(and names `mod on` when the staged mod is older than the new build).

```
mod on        switch the mod on here (and forget an earlier opt-out)
mod off       take it off here, and remember that: a later install leaves it
              off until `mod on`
mod status    'on', 'off (opted out)' or 'tier 1: <reason>', the installed and
              staged versions, and each session the mod has attached
```

`claude-web-chat uninstall` takes the mod off as well, and its result says what
happened to it: removed (the plugin and its marketplace), or the two `claude
plugin` commands to run in the project when Claude Code could not remove it.

## When it is unavailable

The mod does not run, and the project stays on tier 1, when:

- Claude Code is older than 2.1.287, or `claude` cannot be found (`mod on` says
  "mod unavailable" and installs nothing);
- mods are off in the session: safe mode, `--bare`, `disableAllHooks`, or
  managed settings that do not allow them;
- a network policy refuses the mod's call to the web-chat server on this
  machine. `mod status` words this case `network refused: tier 1`. A file
  channel that would carry the mod past such a policy is deferred to 0.8.6.

`mod status` lists each attached session; when none has attached, start or
restart Claude Code in the project.

## What it changes

- **Stop is immediate.** With a mod attached, the stop control reads
  **Interrupt** and aborts the turn at once through the mod, stopping a
  foreground command with it; the turn's node records that it was stopped from
  the page. Without a mod, Stop is the terminal's Esc typed for you where
  web-chat's server holds the terminal, else *Stop after this step*.
- **Kill, Cancel and Remove are immediate.** A task row's stop confirms in a
  control frame and stops the task at once with Claude Code's TaskStop. Without a
  mod, the confirm asks Claude to stop the task, which lands at its next tool
  call.
- **The chat is live.** A tool's card appears as the tool starts, and Claude's
  reply streams in as it is written, as provisional text that the transcript's
  copy replaces a few seconds later. Without a mod, both come from the
  transcript, about three seconds behind.
- **A composer message is typed into the session as a prompt.** It carries the
  same quoted block, under the same `[web-chat message m-…]` marker, that a
  channel wake or a parked delivery carries, so Claude reads it the same way and
  its receipt reaches **Received** from the transcript. Mid-turn it waits as a
  typed prompt does. If the mod hands a message back, it goes by the channel or
  the park instead; when the park already holds a typed message, it waits for
  the next idle (one message per park). Without a mod, a message wakes Claude
  through a channel or rides your next prompt.
- **Five of Claude Code's own commands run from the composer**: `/plan`,
  `/compact`, `/context`, `/rename` and `/recap`, listed first under `/` and
  labelled *runs in the terminal*. `/plan` and `/compact` take an optional
  one-line argument (at most 2,000 characters, not starting with `/`), `/rename`
  a name of at most 64 characters, and `/context` and `/recap` none. A command
  runs as if you had typed it and never rides a message block; its receipt
  confirms when the mod reports it ran and reads *failed* when the mod refuses
  it. `/clear` and `/resume` are not composer commands: they are session
  controls, each behind a confirm. Every other built-in command is refused with
  a hint to type it in the terminal, as it is without a mod — where these five
  are refused too.
- **Session controls** in the chat panel's header: a context meter, **Compact
  now**, **Plan mode**, and a ⋯ menu with **Rename…**, **Clear** and (behind the
  experimental flag below) **Resume ▸**. Each acts through a confirm frame.
  The meter is hidden until Claude Code's first context reading through the mod:
  it is never estimated from the transcript. Without a mod, there are no session
  controls.
- **Images** you add to a message work with or without a mod: see the guide.
- **Permission prompts through the mod** are built but switched off in this
  release: the mod hands every prompt to the existing path, so you answer them
  as without a mod (the ask hook, the card and the bar, and the terminal's own
  dialog). They are switched on once validation gate V41 shows the terminal's
  dialog stays up while the page answers.

MCP elicitations (an MCP server asking you to fill in a form) are answered from
the page by a settings hook, not by the mod; see the guide.

## What it never does

- No model, effort or configuration command: `/model`, `/config`,
  `/permissions` and the like are never offered, and the mod refuses them even
  if asked.
- No answer that grants `bypassPermissions`, and no permission rule written
  outside the session.
- Nothing a page can call: there is no route from the browser to the mod. The
  page reaches it only through control frames (Stop, Kill, the session
  controls), which a pane's script cannot press, and through the queue.
- Not through the tunnel yet: the mod's controls are for you at this machine
  until the remote portal serves the answer frames.

## The experimental in-place resume

Start the web-chat server with `WEB_CHAT_REWIND_IN_PLACE=1` in its environment
(`claude-web-chat restart` after setting it) and, with a mod attached, a turn's
footer offers **Fork here and switch the terminal**: web-chat forks the
conversation from before that turn and switches your terminal into the fork,
refilling your prompt when the page holds it whole and unmasked; the ⋯ menu's
**Resume ▸** switches to another of the project's conversations. It is refused
while Claude is working. It stays off by default until validation gate V33
records what the switch does to web-chat's own connection.

## What is still unproven

These validation gates need a real Claude Code session and have not been run:

- **V35** — `mod on` loads the mod in a 2.1.287+ session and it attaches within
  2 seconds, and `mod off` leaves your Claude Code settings as it found them.
- **V32** (its mod half) — a TaskStop of a background agent through the mod.
- **V33** — the in-place resume (above).
- **V40** — a composer message and a command through the mod, as the
  transcript records them.
- **V41** — permission prompts through the mod, and the elicitation hook's wait.
- **V42** — the session controls.
- **V43** — Stop and Kill through the mod.
