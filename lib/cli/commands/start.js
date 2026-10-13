const fs = require('fs');
const { projectPaths } = require('../../core/paths');
const { resolveRoot } = require('../../setup/registration');
const { waitUntilReachable } = require('../../core/portfiles');
const { daemonFor } = require('../../util/registry');
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
// project it means rather than leaving it to the process's cwd. The rest are
// test seams, so the one-daemon refusal and the stale-build bounce can be
// pinned without a daemon: errlog, exit, daemonFor, restartIfStale,
// spawnDaemonProcess, waitUntilReachable, createServer.
async function start(args = [], deps = {}) {
  const daemon = args.includes('--daemon') || args.includes('-d');
  const log = deps.log || console.log;
  const errlog = deps.errlog || console.error;
  const exit = deps.exit || ((c) => process.exit(c));
  const root = projectRoot(deps);

  // ONE daemon per root, whatever the portfile says. Both paths ask for this
  // root's live daemon first (lib/util/registry daemonFor: the portfile, else
  // the registry entry, each accepted only once the daemon on its port has
  // answered with its pid and this root). The foreground path used to check
  // nothing (INCIDENT-2026-10-06 finding 2) — and every spawned daemon IS a
  // foreground `start` in a detached child — while --daemon read the portfile
  // alone, so deleting .web-chat/ under a live daemon let the next start boot a
  // second one onto the same root (lifecycle-bugs.md bug 2). A live daemon on an
  // older build is bounced onto this one (as before); any other live daemon is
  // refused, binding nothing.
  const live = await (deps.daemonFor || daemonFor)(root);
  if (live) {
    // Running an older build (an update restarted some other project's, not
    // this one): bounce it onto this one instead of calling it a conflict.
    const restartIfStale = deps.restartIfStale || require('../stale-daemon').restartIfStale;
    const stale = await restartIfStale(root, { log });
    if (stale && stale.restarted) return;
    errlog(`already running at ${live.url} (pid ${live.pid}) — use \`claude-web-chat restart\` to bounce it`);
    exit(1);
    return;
  }

  if (!daemon) {
    const srv = (deps.createServer || require('../../server').createServer)({ root });
    await srv.start();
    srv.installSignalHandlers();
    return;
  }

  const paths = projectPaths(root);
  fs.mkdirSync(paths.dir, { recursive: true });
  const logFile = paths.serverLog;

  const child = (deps.spawnDaemonProcess || spawnDaemonProcess)(root);

  // Wait for the daemon to bind and answer so we can report the URL.
  const info = await (deps.waitUntilReachable || waitUntilReachable)({ role: 'server', root });
  if (info) {
    log(`web-chat server started as daemon at ${info.url} (pid ${info.pid}, log ${logFile})`);
    return;
  }
  log(`web-chat server spawned (pid ${child.pid}, log ${logFile}) — portfile not yet visible`);
}

module.exports = start;
module.exports.projectRoot = projectRoot;
