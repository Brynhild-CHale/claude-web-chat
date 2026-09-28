const fs = require('fs');
const { projectPaths } = require('../../core/paths');
const { resolveRoot } = require('../../setup/registration');
const { readPortfile, probeReachable, waitUntilReachable } = require('../../core/portfiles');
const { spawnDaemonProcess } = require('../../util/daemon');

// The project a daemon may be rooted at: an initialised one, found from the cwd
// (resolveRoot 'existing' — which never auto-detects $HOME, whose .web-chat/ is
// the USER tier). This used to fall back to the bare cwd, so `update` or
// `restart` typed in ~ or ~/Downloads booted a daemon rooted there: it made a
// .web-chat/, ran the migrations' first-touch seeding (in $HOME: into the user
// tier), and registered the directory as a KNOWN project — one the tunnel
// portal will start for a remote viewer. Throws userFacing, naming `init`.
function projectRoot(deps) {
  if (deps.root) return deps.root;
  return resolveRoot(process.cwd(), { mode: 'existing' }).root;
}

// deps: { root, log } — `restart` (and so update's --restart-all) passes the
// project it means rather than leaving it to the process's cwd.
async function start(args = [], deps = {}) {
  const daemon = args.includes('--daemon') || args.includes('-d');
  const log = deps.log || console.log;
  const root = projectRoot(deps);

  if (!daemon) {
    const srv = require('../../server').createServer({ root });
    await srv.start();
    srv.installSignalHandlers();
    return;
  }

  const paths = projectPaths(root);
  fs.mkdirSync(paths.dir, { recursive: true });
  const logFile = paths.serverLog;

  const existing = readPortfile('server', { root });
  if (existing) {
    const reachable = await probeReachable(existing.port, 500);
    if (reachable) {
      // Running an older build (an update restarted some other project's, not
      // this one): bounce it onto this one instead of calling it a conflict.
      const stale = await require('../stale-daemon').restartIfStale(root, { log });
      if (stale.restarted) return;
      console.error(`already running at ${existing.url} (pid ${existing.pid}) — use \`claude-web-chat restart\` to bounce it`);
      process.exit(1);
    }
  }

  const child = spawnDaemonProcess(root);

  // Wait for the daemon to bind and answer so we can report the URL.
  const info = await waitUntilReachable({ role: 'server', root });
  if (info) {
    log(`web-chat server started as daemon at ${info.url} (pid ${info.pid}, log ${logFile})`);
    return;
  }
  log(`web-chat server spawned (pid ${child.pid}, log ${logFile}) — portfile not yet visible`);
}

module.exports = start;
module.exports.projectRoot = projectRoot;
