const commands = {
  init: require('./commands/init'),
  start: require('./commands/start'),
  open: require('./commands/open'),
  launch: require('./commands/launch'),
  stop: require('./commands/stop'),
  unlock: require('./commands/unlock'),
  trust: require('./commands/trust'),
  ls: require('./commands/ls'),
  install: require('./commands/install'),
  uninstall: require('./commands/uninstall'),
  on: require('./commands/on'),
  off: require('./commands/off'),
  status: require('./commands/status'),
  doctor: require('./commands/doctor'),
  restart: require('./commands/restart'),
  update: require('./commands/update'),
  export: require('./commands/export'),
  hub: require('./commands/hub'),
  tunnel: require('./commands/tunnel'),
  // Hidden (not in showHelp): what `tunnel up` spawns detached.
  portal: require('./commands/portal'),
  profile: require('./commands/profile'),
  pack: require('./commands/pack'),
  docs: require('./commands/docs'),
  version: require('./commands/version'),
};

function showHelp() {
  console.log(`claude-web-chat — live web canvas + turn graph for Claude Code

Usage:
  claude-web-chat <command> [options]

Commands:
  init                  Set up web-chat here, or check and tidy an existing install (start here)
  open                  Open the web-chat surface in your browser (starts server if needed;
                        one still running an older build is restarted on this one)
  launch [claude-args]  Open the surface and start a Claude session (e.g. launch --resume)
  stop                  Stop the running server gracefully (snapshots draft state)
  start                 Start the server in the foreground
  start --daemon, -d    Start detached; portfile written to .web-chat/server.json
  restart               Stop running server (if any) and start fresh as daemon
  hub [start|stop|status]  Manage the capture hub — the fixed-port router the browser
                        extension sends to; forwards captures to a chosen instance
                        (default port 5170, override with WEB_CHAT_HUB_PORT)
  tunnel <setup|up|down|status|logs>
                        Reach this machine's surfaces from anywhere through a
                        Cloudflare tunnel, behind Cloudflare Access (an emailed
                        code plus your device's biometrics by default, or
                        Google) plus a local check of every sign-in token
                        against YOUR email allowlist. setup writes
                        ~/.web-chat/tunnel/tunnel.json; up starts the portal
                        (port 5171, WEB_CHAT_PORTAL_PORT) and supervises
                        cloudflared (never installed for you); status shows
                        whether the connector is ready and which projects are
                        exposed. See \`claude-web-chat docs remote-access\`
  trust [name] [--params-fp <fp>] [--all] [--deny]
                        Approve (or refuse) a component's host-side service.js.
                        With no name, lists what is waiting; --all decides on
                        everything pending in one confirmation (a pack with three
                        service components should not need three commands), or on
                        every variant of one name when a name is given. Two panes
                        of one component with different params are two decisions,
                        so a name matching both refuses and asks for the
                        --params-fp the listing prints. This
                        is the ONLY way to approve one: the surface cannot grant
                        it, because a component's own pane script runs in that
                        page. There is deliberately no --yes: no non-interactive
                        path grants host execution.
  unlock                Clear a stuck turn lock (orphaned by an interrupted turn)
  export [node]         Write a node to a self-contained .html under .web-chat/exports/
                        (node = label like n1.7, a stored id, 'active' (default), or 'live').
                        --replay | --gif | --mp4 | --webm [--from <node>] [--hold <ms>] [--fade]
                        [--width <px>] [--captions on|none] [--prompts|--no-prompts] write a REPLAY
                        instead — the lineage from --from down to [node], played node by
                        node — as a .html player, an animated GIF, or a video (GIF and video
                        need Chrome, Chromium, Edge or Brave installed, WEB_CHAT_CHROME
                        overrides; MP4/WebM also need ffmpeg, WEB_CHAT_FFMPEG overrides)
                        Captions leave your prompts out unless --prompts is given.
                        --script <file.json> plays a replay SCRIPT (from/to plus timed,
                        grouped, captioned steps) in any of those formats (.html by default).
                        --open shows the replay in the browser's player and writes nothing.
  profile <validate|dry-run|reload>  Author/test capture profiles; used by /capture-profile.
                        validate/dry-run <dir> offline-test a bundle before saving
                        (dry-run --capture <id> [--mode reduced|expanded]);
                        reload hot-reloads saved profiles into the running daemon (no restart)
  pack <install|get|review|approve|discard|list|info|remove>
                        Component packs — a repository that installs as components
                        PLUS a Claude skill (the skill is why: list_components is a
                        pull, a skill's description is in context from the start).
                        'pack get <url>' downloads for review without installing —
                        the right default for a pack you did not write yourself.
                        --global installs for all projects.
  docs [name]           Print a bundled contract doc (service-components, channels-dev,
                        driving-the-surface, …); with no name, list what's available
  ls [--reap|--json|--all]
                        List every web-chat surface running on this machine — which
                        project each one is, on what port, and whether a Claude
                        Code session is attached (VERSION: the web-chat release
                        the surface runs, <0.8 for one too old to say; CLAUDE:
                        ● N sessions, · channel when a Push wakes one; TURN:
                        mid-turn / wake; VIEWERS: browsers).
                        A ⚠ under a row means a Claude session runs a different
                        release than its surface, and names the side to restart.
                        A project with a session but no surface is listed too.
                        --all adds the inactive projects known here (booted
                        before, nothing running now). --json prints the whole
                        row. --reap asks each OTHER project's daemon to shut
                        down (so its uncommitted surface is saved) and clears
                        entries whose process is gone. One that is not answering
                        is reported with a kill hint, never signalled — that pid
                        may not be ours.
  status                Show current state across scopes (incl. managed-file drift)
  doctor                Diagnose and repair daemon/lock/portfile/MCP/hook issues
  install               Init .web-chat/ + edit-preserving sync of managed files
                        (rules/command/skills). Safe template updates auto-apply; local
                        edits are kept; conflicts land as <file>.new sidecars —
                        merge one by hand, then delete it and the file is settled
                        until the template changes again.
                        --force takes the shipped version, discarding local edits.
  uninstall [--self]    Remove web-chat hooks, managed files (rules/command/skills),
                        the .mcp.json entry AND the local-scope registration
                        \`doctor\` may have written into Claude Code's own config,
                        from this project. Your .web-chat/ graph data is kept.
                        --self also removes the program (~/.local/bin links and
                        every unpacked version under ~/.web-chat/versions/),
                        stopping a running tunnel portal first — and removing
                        nothing if the portal will not stop.
  on  [--global|--session=<id>]   Enable web-chat (default: project scope)
  off [--global|--session=<id>]   Disable web-chat (default: project scope)
  update                Install the latest GitHub release into ~/.web-chat/versions/,
                        swap the ~/.web-chat/current symlink, sync managed files
                        (edit-preserving), restart (and a running tunnel portal);
                        reports version before/after.
                        --list shows the versions on disk; --to <version> rolls back
                        to one of them (a symlink swap, no download); --force
                        reinstalls the latest even if you are already on it.
                        --from <tarball> installs a local build instead (e.g. one
                        from scripts/build-release.js --dev), verified against the
                        SHA256SUMS beside it (none there: refused without --yes).
                        Lists other projects whose server still runs a different
                        build; --restart-all restarts them on this one (works when
                        already up to date, or when GitHub cannot be reached, too).
                        Outside a project no server is restarted there
                        (--restart-all still restarts the others).
                        No npm at any point; refuses to run from a git checkout.
  version, --version    Show the version AND where it is installed from — the running
                        tree, ~/.web-chat/current, and what the command on your PATH
                        actually resolves to (they can differ; that is worth knowing)
  help                  Show this message
`);
}

function main(argv = process.argv.slice(2)) {
  const cmd = argv[0];
  const args = argv.slice(1);
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
    showHelp();
    return;
  }
  // `--version` is what everyone types; route it to the same command as
  // `version` rather than dying with "unknown command".
  if (cmd === '--version' || cmd === '-v') {
    return commands.version(args);
  }
  if (!commands[cmd]) {
    console.error(`unknown command: ${cmd}`);
    showHelp();
    process.exit(1);
  }
  // The one place a userFacing error is reported. The registration engine (and
  // the commands on it) throw `{userFacing:true}` instead of calling
  // process.exit inside a library — install's exit killed `init` mid-sequence,
  // before its closing lines and before prompt.close(). Both shapes are caught:
  // a synchronous throw, and the rejection of an async command. Anything else
  // propagates exactly as before, stack and all.
  const fail = (e) => {
    if (e && e.userFacing) { console.error(e.message); process.exitCode = 1; return; }
    throw e;
  };
  try {
    const out = commands[cmd](args);
    return out && typeof out.then === 'function' ? out.catch(fail) : out;
  } catch (e) {
    return fail(e);
  }
}

module.exports = { main };
