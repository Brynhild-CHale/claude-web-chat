const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const registry = require('./registry');
const { projectPaths, PACKAGE_ROOT } = require('../core/paths');

// The CLI bin every detached child is started from. Derived from PACKAGE_ROOT,
// not by walking __dirname: two spawners walked it independently, which is one
// directory move away from disagreeing.
const CLI_BIN = path.join(PACKAGE_ROOT, 'bin', 'claude-web-chat.js');

// The one "start a child that outlives me, with its output appended to a log".
// Both spawners wanted this and spelled it differently — daemon.js opened the
// same log file TWICE (one fd for stdout, one for stderr) where hub.js reused
// one, and neither closed the parent's copies. spawn() dup()s the descriptors
// into the child, so what the parent keeps is pure leak: harmless in a one-shot
// CLI, but the MCP server is long-lived and respawns a dead daemon on demand
// (lib/client), so it leaked a pair per respawn for the life of a Claude Code
// session. One open, closed as soon as the child owns its own.
function spawnDetached({ bin = CLI_BIN, args = [], log, cwd, env } = {}) {
  fs.mkdirSync(path.dirname(log), { recursive: true });
  const fd = fs.openSync(log, 'a');
  try {
    const child = spawn(process.execPath, [bin, ...args], {
      detached: true,
      stdio: ['ignore', fd, fd],
      ...(cwd ? { cwd } : {}),
      ...(env ? { env } : {}),
    });
    child.unref();
    return child;
  } finally {
    // spawn() is synchronous in creating the child, so by here it holds its own
    // dup of `fd` and ours is dead weight. A spawn that threw closes it too.
    try { fs.closeSync(fd); } catch {}
  }
}

// How long a spawn path waits for the daemon it started to answer.
const DAEMON_WAIT_MS = 8000;

// THE wait for this root's daemon: poll lib/util/registry daemonFor until it
// verifies a live daemon of `root` (its portfile, else its registry entry,
// answering /api/health as that pid and this root's instance), or `maxMs`
// passes — the record ({pid, port, url, source}), or null. Never the raw
// portfile (core/portfiles waitUntilReachable, which stays the primitive for a
// caller that does not need identity): a .web-chat/ copied from another project
// carries a portfile naming THAT project's live daemon, which answers at once,
// and every spawn path that waited on it reported, browsed or adopted the other
// project's daemon as the one it had just started (lifecycle-bugs.md; U107c,
// U107d). `not: {pid, port}` skips one daemon — the one a restart just stopped,
// still answering on its way out: a daemon is its pid and the port it bound (a
// process never moves port), so a new pid, or the same pid on another port
// (in-process daemons in a test share one), is a new daemon. `daemonFor` is a
// test seam.
async function waitForDaemon(root, { maxMs = DAEMON_WAIT_MS, intervalMs = 100, daemonFor: find, not = null } = {}) {
  const lookup = find || registry.daemonFor;
  const skip = (d) => Boolean(not && d.pid === not.pid && d.port === not.port);
  const deadline = Date.now() + maxMs;
  for (;;) {
    let d = null;
    try { d = await lookup(root); } catch { d = null; }
    if (d && !skip(d)) return d;
    if (Date.now() >= deadline) return null;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

// Spawn the server as a detached daemon, logging to .web-chat/server.log. The
// child outlives this process (the whole point — it survives `/exit`). Returns
// the child handle; callers that need the URL await `waitForDaemon`.
function spawnDaemonProcess(root) {
  return spawnDetached({ args: ['start'], log: projectPaths(root).serverLog, cwd: root });
}

// Idempotent "make sure a daemon is up". Asks for this root's LIVE daemon first
// (lib/util/registry daemonFor: the portfile, else the registry entry, each
// accepted only once the daemon answering on its port names its pid and this
// root) and ADOPTS it — returns its info, so lib/client talks to its port. The
// portfile alone used to decide: with .web-chat/ deleted under a running daemon
// every caller here (lib/client's auto-spawn for the MCP server and hooks,
// install's pre-warm, the portal's starter) started a second daemon for the
// same root. A portfile-less daemon re-writes its own record (U106's guard).
// Concurrent first spawns can still both slip between this check and the bind;
// the loser's own boot check (`start`) and U106's guard make it exit. After a
// spawn it waits with waitForDaemon, the same rule: the raw portfile it used to
// wait on could be a copy naming another project's live daemon, whose port the
// MCP server and hooks then adopted. Returns the verified record ({pid, port,
// url, source}), or null if it never came up within `maxMs`. `daemonFor` and
// `spawn` are test seams.
async function spawnDaemon(root, { maxMs = DAEMON_WAIT_MS, daemonFor, spawn: spawnFn } = {}) {
  const find = daemonFor || registry.daemonFor;
  const live = await find(root);
  if (live) return live;
  (spawnFn || spawnDaemonProcess)(root);
  return await waitForDaemon(root, { maxMs, daemonFor: find });
}

module.exports = { spawnDaemon, spawnDaemonProcess, waitForDaemon, DAEMON_WAIT_MS, spawnDetached, CLI_BIN };
