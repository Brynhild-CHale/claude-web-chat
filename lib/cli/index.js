const commands = {
  start: require('./commands/start'),
  open: require('./commands/open'),
  launch: require('./commands/launch'),
  stop: require('./commands/stop'),
  unlock: require('./commands/unlock'),
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
  profile: require('./commands/profile'),
};

function showHelp() {
  console.log(`claude-web-chat — live web canvas + turn graph for Claude Code

Usage:
  claude-web-chat <command> [options]

Commands:
  open                  Open the web-chat surface in your browser (starts server if needed)
  launch [claude-args]  Open the surface and start a Claude session (e.g. launch --resume)
  stop                  Stop the running server gracefully (snapshots draft state)
  start                 Start the server in the foreground
  start --daemon, -d    Start detached; portfile written to .web-chat/server.json
  restart               Stop running server (if any) and start fresh as daemon
  hub [start|stop|status]  Manage the capture hub — the fixed-port router the browser
                        extension sends to; forwards captures to a chosen instance
                        (default port 5170, override with WEB_CHAT_HUB_PORT)
  unlock                Clear a stuck turn lock (orphaned by an interrupted turn)
  export [node]         Write a node to a self-contained .html under .web-chat/exports/
                        (node = label like n1.7, a stored id, 'active' (default), or 'live')
  profile <validate|dry-run|reload>  Author/test capture profiles; used by /capture-profile.
                        validate/dry-run <dir> offline-test a bundle before saving
                        (dry-run --capture <id> [--mode reduced|expanded]);
                        reload hot-reloads saved profiles into the running daemon (no restart)
  status                Show current state across scopes (incl. managed-file drift)
  doctor                Diagnose and repair daemon/lock/portfile/MCP/hook issues
  install               Init .web-chat/ + edit-preserving sync of managed files
                        (rules/command). Safe template updates auto-apply; local
                        edits are kept; conflicts land as <file>.new sidecars.
                        --force takes the shipped version, discarding local edits.
  uninstall             Remove web-chat hooks from .claude/settings.json
  on  [--global|--session=<id>]   Enable web-chat (default: project scope)
  off [--global|--session=<id>]   Disable web-chat (default: project scope)
  update                Reinstall the latest build from the public repo, sync managed
                        files (edit-preserving), restart; reports version before/after
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
  if (!commands[cmd]) {
    console.error(`unknown command: ${cmd}`);
    showHelp();
    process.exit(1);
  }
  return commands[cmd](args);
}

module.exports = { main };
