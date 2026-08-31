const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { readPortfile, probeReachable, waitUntilReachable } = require('../core/portfiles');
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

// Poll for the daemon's portfile and confirm the bound port actually answers,
// so callers only proceed once the server is genuinely reachable (not merely
// once the file appears). Returns the portfile info, or null on timeout. Callers
// pass the project's .web-chat dir; we derive the root for the role-based engine.
async function waitForPortfile(webChatDir, maxMs = 8000) {
  const root = path.dirname(webChatDir);
  return await waitUntilReachable({ role: 'server', root, maxMs });
}

// Spawn the server as a detached daemon, logging to .web-chat/server.log. The
// child outlives this process (the whole point — it survives `/exit`). Returns
// the child handle; callers that need the URL await `waitForPortfile`.
function spawnDaemonProcess(root) {
  return spawnDetached({ args: ['start'], log: projectPaths(root).serverLog, cwd: root });
}

// Idempotent "make sure a daemon is up". Re-checks the portfile + probe first so
// concurrent callers (e.g. several MCP tool invocations racing on first use) do
// not each spawn a server — the server's own port-walk handles any collision if
// two do slip through. Returns reachable portfile info, or null if it never came
// up within `maxMs`.
async function spawnDaemon(root, { maxMs = 8000 } = {}) {
  const existing = readPortfile('server', { root });
  if (existing) {
    const reachable = await probeReachable(existing.port, 250);
    if (reachable) return existing;
  }
  spawnDaemonProcess(root);
  return await waitUntilReachable({ role: 'server', root, maxMs });
}

module.exports = { spawnDaemon, spawnDaemonProcess, waitForPortfile, spawnDetached, CLI_BIN };
