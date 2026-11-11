const fs = require('fs');
const { projectPaths, isHomeDir } = require('../../core/paths');
const { resolveRoot } = require('../../setup/registration');
const { daemonFor, release } = require('../../util/registry');
const { spawnDaemon, spawnDaemonProcess, DAEMON_WAIT_MS } = require('../../util/daemon');

// The project a daemon may be rooted at: an initialised one, found from the cwd
// (resolveRoot 'existing' — which never auto-detects $HOME, whose .web-chat/ is
// the USER tier). This used to fall back to the bare cwd, so `update` or
// `restart` typed in ~ or ~/Downloads booted a daemon rooted there: it made a
// .web-chat/, ran the migrations' first-touch seeding (in $HOME: into the user
// tier), and registered the directory as a KNOWN project — one the tunnel
// portal will start for a remote viewer. Throws userFacing, naming `init`.
//
// A root handed in (`restart`, update --restart-all) is checked as well, before
// anything is written: the home directory — or a folder whose .web-chat/ holds
// the user tier while HOME points elsewhere (isHomeDir) — is never a daemon's
// root, and this path used to rely on every caller having filtered it.
function projectRoot(deps) {
  if (deps.root) {
    if (isHomeDir(deps.root)) {
      const err = new Error(`${deps.root} is your home directory — its .web-chat/ is web-chat's per-user directory, `
        + 'so no surface can be rooted there. Run `claude-web-chat open` in a project directory instead.');
      err.userFacing = true;
      throw err;
    }
    return deps.root;
  }
  return resolveRoot(process.cwd(), { mode: 'existing' }).root;
}

// deps: { root, log } — `restart` (and so update's --restart-all) passes the
// project it means rather than leaving it to the process's cwd. The rest are
// test seams, so the one-daemon refusal and the stale-build bounce can be
// pinned without a daemon: errlog, exit, daemonFor, restartIfStale,
// spawnDaemonProcess, waitForDaemon, startWithinMs (the --daemon path's wait,
// through startThroughLock), createServer, takeRelaySecret.
async function start(args = [], deps = {}) {
  // The relay secret's intake (lib/server/relay-credential; 03 C-03.22),
  // FIRST: before the root is resolved, the live daemon asked for, a stale one
  // bounced or any child spawned, so no child — a restarted daemon, the
  // --daemon child, a service — ever inherits the environment fallback or
  // meets the open fd. Only the in-process server below receives it; on the
  // --daemon and already-running paths it is dropped (a connector spawns
  // neither). Through lib/server/index.js, start.js's one edge into lib/server.
  let relaySecretVia = null;
  const relaySecret = (deps.takeRelaySecret || require('../../server').takeRelaySecret)({
    onTaken: (via) => { relaySecretVia = via; },
  });
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
    // `tokenAtClaim`: the writer token file is written right after this
    // daemon claims its portfile, never at construction — at a double start
    // the loser of the portfile race must not leave the file naming a token
    // the winner never minted (DECISIONS I.3 D2; ruling
    // U214a@writer-token-orphan-overwrite).
    const srv = (deps.createServer || require('../../server').createServer)({
      root, tokenAtClaim: true, relaySecret, relaySecretVia,
    });
    const started = await srv.start();
    const port = started && started.port;
    // The instance guard (lib/server/instance-guard, U106): every 5 s this
    // daemon looks at its records again — re-writes a vanished portfile, and
    // ends the process when it is the orphan of another daemon on this root or
    // its .web-chat/ was removed. A server that reported no port (a test's
    // stand-in) has nothing to guard. `syncToken`: while the portfile names
    // this daemon the guard also puts this boot's writer token back in
    // .web-chat/writer-token when it is missing or names another token, so
    // the file follows the live daemon (D2).
    let guard = null;
    if (Number.isInteger(port)) {
      const make = deps.createInstanceGuard || require('../../server/instance-guard').createInstanceGuard;
      guard = make({
        root,
        port,
        onExit: (reason, info) => exitWithoutWriting(srv, { root, reason, info, log: errlog, exit }),
        syncToken: () => (srv.writers && typeof srv.writers.publishToken === 'function' ? srv.writers.publishToken() : null),
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

  // Through the root's spawn lock (startThroughLock, below): a daemon another
  // caller is starting right now is adopted, never doubled. The record is THIS
  // root's daemon as daemonFor verified it, never the raw portfile: a
  // .web-chat/ copied from another project carries a portfile naming THAT
  // project's live daemon, and the line below used to print its URL as the one
  // just started.
  const { info, spawned, child } = await startThroughLock(root, {
    spawnProcess: deps.spawnDaemonProcess,
    daemonFor: deps.daemonFor,
    waitForDaemon: deps.waitForDaemon,
    maxMs: deps.startWithinMs,
  });
  if (!spawned) {
    if (info) {
      log(`web-chat server already being started by another caller — adopted it at ${info.url} (pid ${info.pid}, log ${logFile})`);
      return;
    }
    errlog(`another start of this project's web-chat server held its spawn lock and no daemon is up yet — nothing spawned; check ${logFile}`);
    exit(1);
    return;
  }
  if (info) {
    log(`web-chat server started as daemon at ${info.url} (pid ${info.pid}, log ${logFile})`);
    return;
  }
  log(`web-chat server spawned (pid ${child ? child.pid : '?'}, log ${logFile}) — portfile not yet visible`);
}

// Start this root's daemon the one way every caller does: lib/util/daemon
// spawnDaemon, under the root's spawn lock (U718b). It asks daemonFor under the
// lock, ADOPTS a daemon that serves (one another caller — the connector's
// supervisor, the MCP client's auto-start, install's pre-warm, another `open` —
// started while we waited), and spawns only when there is none, then waits for
// the child's daemon. `open` and `start --daemon` used to call the bare
// spawnDaemonProcess outside the lock and started a second child beside one
// being started (U718c; the ruling SPAWNLOCK@open-start: every way of
// starting a daemon has one rule). The foreground `start` IS the daemon and
// never comes here.
//
// Returns { info, spawned, child }: `info` the verified record (or null),
// `spawned` whether THIS call started a child, `child` its handle. The commands'
// test seams are threaded into spawnDaemon's own options: `spawnProcess` (the
// spawnDaemonProcess seam) is its `spawn`, `daemonFor` its daemonFor, `maxMs`
// its wait (the lock's and the child's). An injected `waitForDaemon` stands for
// the wait after OUR spawn only — spawnDaemon's lookup, once this call has
// spawned, asks it in daemonFor's place — so a test that answers the wait
// without a daemonFor that does still reads as before. Never injected, the
// lookup is daemonFor itself.
async function startThroughLock(root, { spawnProcess, daemonFor: find, waitForDaemon: wait, maxMs = DAEMON_WAIT_MS } = {}) {
  const lookupLive = find || daemonFor;
  const start = spawnProcess || spawnDaemonProcess;
  let spawned = false;
  let child = null;
  const lookup = wait
    ? (r) => (spawned ? wait(r, { maxMs, daemonFor: lookupLive }) : lookupLive(r))
    : lookupLive;
  const info = await spawnDaemon(root, {
    maxMs,
    daemonFor: lookup,
    spawn: (r, opts) => {
      spawned = true;
      child = opts ? start(r, opts) : start(r);
      return child;
    },
  });
  return { info: info || null, spawned, child };
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
module.exports.startThroughLock = startThroughLock;
