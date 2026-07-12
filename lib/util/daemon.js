const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { readPortfile, probeReachable, waitUntilReachable } = require('../core/portfiles');
const { projectPaths } = require('../core/paths');

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
  const paths = projectPaths(root);
  fs.mkdirSync(paths.dir, { recursive: true });
  const out = fs.openSync(paths.serverLog, 'a');
  const err = fs.openSync(paths.serverLog, 'a');
  const binPath = path.join(__dirname, '..', '..', 'bin', 'claude-web-chat.js');
  const child = spawn(process.execPath, [binPath, 'start'], {
    detached: true,
    stdio: ['ignore', out, err],
    cwd: root,
  });
  child.unref();
  return child;
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

module.exports = { spawnDaemon, spawnDaemonProcess, waitForPortfile };
