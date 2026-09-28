const { spawn } = require('child_process');
const { readPortfile, probeReachable } = require('../../core/portfiles');
const { findProjectRoot, projectPaths } = require('../../core/paths');
const { spawnDaemonProcess, waitForPortfile } = require('../../util/daemon');
const { restartIfStale } = require('../stale-daemon');

// Sub-targets `open` understands. The surface is the default; `extensions` is
// the front door for the browser extensions, which otherwise have no discoverable
// install path at all (the folder to sideload is machine-specific, so only the
// running daemon can name it).
const TARGETS = {
  extensions: '/extensions',
  extension: '/extensions',
};

function browserCommand() {
  if (process.platform === 'darwin') return { cmd: 'open', args: [] };
  if (process.platform === 'win32') return { cmd: 'cmd', args: ['/c', 'start', ''] };
  return { cmd: 'xdg-open', args: [] };
}

function launchBrowser(url) {
  const { cmd, args } = browserCommand();
  const fallback = (message) => {
    console.error(`(could not launch browser: ${message})`);
    console.log(`open this URL manually: ${url}`);
  };
  try {
    const child = spawn(cmd, [...args, url], { stdio: 'ignore', detached: true });
    // A missing launcher (no `xdg-open` on a server, WSL or slim container) is
    // reported asynchronously as an 'error' event, NOT a throw — without this
    // listener it is an unhandled error that kills `open` (and `launch`, which
    // awaits it) with a raw stack, scrolling the URL we just printed off screen.
    child.on('error', (e) => fallback(e.message));
    child.unref();
  } catch (e) {
    // Synchronous failures (EACCES on the launcher) still land here.
    fallback(e.message);
  }
}

// Deps are injectable so the target/hint behaviour is testable without spawning
// a daemon or a browser; defaults wire the real ones.
async function open(args = [], deps = {}) {
  const browse = deps.launchBrowser || launchBrowser;
  const log = deps.log || ((m) => console.log(m));
  const errlog = deps.errlog || ((m) => console.error(m));
  const exit = deps.exit || ((c) => process.exit(c));
  const readPort = deps.readPortfile || readPortfile;
  const probe = deps.probeReachable || probeReachable;
  const spawnDaemon = deps.spawnDaemonProcess || spawnDaemonProcess;
  const waitPort = deps.waitForPortfile || waitForPortfile;
  const bounceStale = deps.restartIfStale || restartIfStale;

  const target = args && args[0] ? String(args[0]) : '';
  if (target && !Object.prototype.hasOwnProperty.call(TARGETS, target)) {
    errlog(`unknown open target: ${target} (try: extensions)`);
    return exit(1);
  }
  const suffix = TARGETS[target] || '';

  // Only an initialised project gets a daemon. The bare-cwd fallback this used
  // to have booted one rooted wherever `open` was typed (and, since 0.8, made
  // that directory a known project the tunnel portal can start) — `start`
  // refuses such a root now, so say so here rather than wait 8s on a daemon
  // that is never coming.
  const root = deps.root || findProjectRoot(process.cwd());
  if (!root) {
    errlog(`no web-chat project here (no .web-chat/ in ${process.cwd()} or any parent) — run \`claude-web-chat init\` first`);
    return exit(1);
  }
  const paths = projectPaths(root);

  const existing = readPort('server', { root });
  if (existing) {
    const reachable = await probe(existing.port, 500);
    if (reachable) {
      // A daemon an update left on the previous build is bounced onto this one
      // first — it would serve the old chrome to the tab we are about to open.
      const stale = await bounceStale(root, { log });
      const now = stale.restarted ? (readPort('server', { root }) || existing) : existing;
      if (!stale.restarted) log(`web-chat server already running at ${now.url}`);
      browse(now.url + suffix);
      return;
    }
  }

  // Spawn detached daemon
  spawnDaemon(root);
  const logFile = paths.serverLog;

  const info = await waitPort(paths.dir, 8000);
  if (!info) {
    errlog(`web-chat server failed to start within 8s — check ${logFile}`);
    return exit(1);
  }

  log(`web-chat server started at ${info.url} (pid ${info.pid})`);
  // Only on a cold start — the once-a-session moment where a pointer is help
  // rather than noise. Without it the browser extensions (page capture: half of
  // what "web-chat" means) are documented nowhere the user will look.
  if (!suffix) log(`browser extensions (page capture, embedding): ${info.url}/extensions`);
  browse(info.url + suffix);
}

module.exports = open;
