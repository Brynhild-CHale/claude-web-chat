const { spawn } = require('child_process');
const { readPortfile } = require('../../core/portfiles');
const { findProjectRoot, projectPaths } = require('../../core/paths');
const { spawnDaemonProcess, waitForPortfile } = require('../../util/daemon');
const { packageVersion } = require('../../core/versions');
const registration = require('../../setup/registration');
const { restartIfStale } = require('../stale-daemon');
const { daemonFor } = require('../../util/registry');

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

// Which managed-file rows mean "not what this build ships" is decided ONCE, in
// lib/cli/init/state (DRIFT_ACTIONS): `created` and `updated` are files
// `install` writes, `conflict` is an edited file it puts the shipped version
// beside as a `.new`, and `differs` is a file that differs with no record of
// what it was shipped as — bootstrap drift, which `install` leaves alone and
// only `install --force` adopts. The line below says which is which, so it
// never names a command that will not clear it.
//
// A `pending` row on its own (an unmerged `.new` beside a settled file) is left
// out, as the MCP server's startup check leaves it out: install cannot merge
// for the user, so a line naming install over it would be an unactionable
// reminder on every `open`. `install`, `update`, `status` and `init` still
// report it.
const { DRIFT_ACTIONS } = require('../init/state');

// One line naming this project's managed files (the rules file, the /web-chat
// command, the skills) that are behind this build, with the command that
// refreshes them — or null when there are none. `open` is the command users
// run in every project, and the other places this was said were `status`,
// which nobody runs unprompted, and the MCP server's stderr, which nobody
// sees; so a project the user did not run `update` in kept the older rules
// until they thought to look. Reads through the same registration model
// `status` and `doctor` use (a pure read), and never throws.
function staleManagedLine(root, { inspect = registration.inspect, version = packageVersion() } = {}) {
  try {
    if (!registration.isInstalled(root)) return null;
    const reg = inspect(root);
    if (!reg || reg.managedError) return null;
    const drift = (reg.managed || []).filter((r) => DRIFT_ACTIONS.has(r.action));
    if (!drift.length) return null;
    const refresh = drift.filter((r) => r.action !== 'differs');
    const differs = drift.filter((r) => r.action === 'differs');
    const parts = [];
    if (refresh.length) {
      parts.push(`${refresh.map((r) => r.dest).join(', ')} — run \`claude-web-chat install\` to refresh ` +
        `${refresh.length === 1 ? 'it' : 'them'} (your edits are kept)`);
    }
    if (differs.length) {
      parts.push(`${differs.map((r) => r.dest).join(', ')} ${differs.length === 1 ? 'differs' : 'differ'} from what this build ships ` +
        'with no record of your edits — keep yours, or `claude-web-chat install --force` adopts the shipped version');
    }
    return `This project's web-chat guidance for Claude is behind v${version}: ${parts.join('; ')}.`;
  } catch {
    return null;
  }
}

// One line when Claude Code will start NO web-chat MCP server here — web-chat
// was rejected in Claude Code (disabledMcpjsonServers), disabled through /mcp,
// or is not registered at all — or null. `open` is the command run in every
// project, so it is where a project whose tools are missing hears about it.
// The words are status's and doctor's (registration describeMcp), from the same
// pure read; never throws.
function mcpLine(root, { mcpState = registration.mcpState } = {}) {
  try {
    if (!registration.isInstalled(root)) return null;
    const st = mcpState(root);
    if (!['rejected', 'disabled', 'none'].includes(st.kind)) return null;
    return `web-chat's MCP tools will not load in Claude Code here: ${registration.describeMcp(st).line}.`;
  } catch {
    return null;
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
  const spawnDaemon = deps.spawnDaemonProcess || spawnDaemonProcess;
  const waitPort = deps.waitForPortfile || waitForPortfile;
  const bounceStale = deps.restartIfStale || restartIfStale;
  const findLive = deps.daemonFor || daemonFor;
  const noteManaged = () => {
    const line = staleManagedLine(root, { inspect: deps.inspect, version: deps.version });
    if (line) log(line);
    const mcp = mcpLine(root, { mcpState: deps.mcpState });
    if (mcp) log(mcp);
  };

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

  // This root's live daemon, and only this root's: lib/util/registry daemonFor
  // reads the portfile, else the registry entry, and accepts either only once
  // the daemon on its port names its pid and this root. A bare "the portfile's
  // port answers" is not that — a stale portfile whose port another project's
  // daemon (or any HTTP server) now holds would be browsed as ours — and the
  // portfile alone deciding is how, with .web-chat/ deleted under a live
  // daemon, `open` started a SECOND daemon for the same root
  // (lifecycle-bugs.md bug 2). So nothing else is adopted.
  const existing = await findLive(root);
  if (existing) {
    // A daemon an update left on the previous build is bounced onto this one
    // first — it would serve the old chrome to the tab we are about to open.
    const stale = await bounceStale(root, { log });
    const now = stale.restarted ? (readPort('server', { root }) || existing) : existing;
    if (!stale.restarted) log(`web-chat server already running at ${now.url}`);
    noteManaged();
    browse(now.url + suffix);
    return;
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
  noteManaged();
  browse(info.url + suffix);
}

module.exports = open;
module.exports.staleManagedLine = staleManagedLine;
module.exports.mcpLine = mcpLine;
