const fs = require('fs');
const { projectPaths } = require('../../core/paths');
const { resolveRoot } = require('../../setup/registration');
const { daemonFor, release } = require('../../util/registry');
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
// spawnDaemonProcess, waitForDaemon, createServer.
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
    // `daemon: live` — the record daemonFor just verified, so the bounce acts on
    // exactly that daemon and does not ask /api/health a second time.
    const stale = await restartIfStale(root, { log, daemon: live });
    if (stale && stale.restarted) return;
    errlog(`already running at ${live.url} (pid ${live.pid}) — use \`claude-web-chat restart\` to bounce it`);
    exit(1);
    return;
  }

  if (!daemon) {
    const srv = (deps.createServer || require('../../server').createServer)({ root });
    const started = await srv.start();
    const port = started && started.port;
    // The instance guard (lib/server/instance-guard, U106): every 5 s this
    // daemon looks at its records again — re-writes a vanished portfile, and
    // ends the process when it is the orphan of another daemon on this root or
    // its .web-chat/ was removed. A server that reported no port (a test's
    // stand-in) has nothing to guard.
    let guard = null;
    if (Number.isInteger(port)) {
      const make = deps.createInstanceGuard || require('../../server/instance-guard').createInstanceGuard;
      guard = make({
        root,
        port,
        onExit: (reason, info) => exitWithoutWriting(srv, { root, reason, info, log: errlog, exit }),
      });
      // Stopped the moment a signal arrives, BEFORE the server's own handler
      // (installed just below, so it runs after this one) starts the graceful
      // shutdown: a pass must not end the process mid-shutdown. POST
      // /api/shutdown and the viewer grace never come through here; there the
      // guard keeps running and leans on runShutdown releasing the records as
      // its last synchronous step (see the header of lib/server/instance-guard).
      const stopGuard = () => guard.stop();
      process.on('SIGTERM', stopGuard);
      process.on('SIGINT', stopGuard);
    }
    srv.installSignalHandlers();
    if (guard) guard.start();
    return;
  }

  const paths = projectPaths(root);
  fs.mkdirSync(paths.dir, { recursive: true });
  const logFile = paths.serverLog;

  const child = (deps.spawnDaemonProcess || spawnDaemonProcess)(root);

  // Wait for THIS root's daemon to bind and answer so we can report its URL —
  // a record daemonFor has verified, never the raw portfile: a .web-chat/ copied
  // from another project carries a portfile naming THAT project's live daemon,
  // and the line below used to print its URL as the one just started.
  const info = await (deps.waitForDaemon || waitForDaemon)(root, { daemonFor: deps.daemonFor });
  if (info) {
    log(`web-chat server started as daemon at ${info.url} (pid ${info.pid}, log ${logFile})`);
    return;
  }
  log(`web-chat server spawned (pid ${child.pid}, log ${logFile}) — portfile not yet visible`);
}

// Poll until lib/util/registry daemonFor verifies a live daemon of `root` (its
// portfile, else its registry entry, answering /api/health as that pid and this
// root), or `maxMs` passes: the record, or null. `daemonFor` is a test seam.
async function waitForDaemon(root, { maxMs = 8000, intervalMs = 100, daemonFor: find } = {}) {
  const lookup = find || daemonFor;
  const deadline = Date.now() + maxMs;
  for (;;) {
    let d = null;
    try { d = await lookup(root); } catch { d = null; }
    if (d) return d;
    if (Date.now() >= deadline) return null;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

// The instance guard's way out (U106, ruled A6 (b)): end this daemon WITHOUT
// writing anything into the project. Never srv.gracefulShutdown() or srv.stop():
// both persist (draft.json, the chat mirror's files) — into a .web-chat/ the user
// removed, or one another daemon now owns. What it does, all synchronously, so no
// request can be served in between:
//   * the service children are told to stop (the supervisor's stopAll; a child
//     also stops when its IPC channel closes with this process);
//   * this daemon's records are released, pid-guarded (lib/util/registry
//     release): a portfile or registry entry naming the OTHER, live daemon stays;
//   * one log line naming the reason (and a re-created .web-chat/ it left);
//   * the process exits 0.
// The server's own 'exit' hook runs release() once more; pid-guarded, a no-op.
// `exit` is a test seam.
function exitWithoutWriting(srv, { root, reason, info, log = console.error, pid = process.pid, exit = (c) => process.exit(c) }) {
  const { describeExit } = require('../../server/instance-guard');
  try { if (srv && srv.services) srv.services.stopAll(); } catch {}
  try { release({ root, pid }); } catch {}
  try { log(describeExit(reason, info)); } catch {}
  exit(0);
}

module.exports = start;
module.exports.projectRoot = projectRoot;
module.exports.exitWithoutWriting = exitWithoutWriting;
module.exports.waitForDaemon = waitForDaemon;
