const { findProjectRoot } = require('../../core/paths');
const portfiles = require('../../core/portfiles');
const { packageVersion, isDevVersion, releaseTagUrl } = require('../../core/versions');
const { isLegacyBuild } = require('../stale-daemon');
const stop = require('./stop');
const start = require('./start');

// restart = stop + start, and `stop` is the ONE engine for stopping a daemon.
// This used to hand-roll its own `process.kill(pid,'SIGTERM')` + wait — a second
// copy of the mechanism, which meant the acknowledged-shutdown path could be
// fixed in `stop` and silently miss `restart`, the command most likely to be
// bouncing a daemon with unsaved surface state on it.
//
// Outside a project there is nothing to restart, and it says so and returns
// rather than throwing: an OLDER build's `update` (0.7.6's, performing the hop
// to this one) loads THIS file and calls it unconditionally, wherever the user
// happened to type `update` — and its fallback used to be the bare cwd, which
// booted a daemon rooted at ~ or ~/Downloads (see start.js projectRoot).
async function restart(args = [], deps = {}) {
  const log = deps.log || console.log;
  const root = deps.root !== undefined ? deps.root : findProjectRoot(process.cwd());
  if (!root) {
    log(`No web-chat project here (${process.cwd()}) — no server to restart. Run \`claude-web-chat restart\` inside a project.`);
    return { ok: true, stopped: null, started: false, reason: 'no-project' };
  }
  // Injectable so a test can assert WHETHER we start, without spawning a real
  // detached daemon (which would also bring up the hub and the user registry).
  const startFn = deps.start || start;

  // Asked BEFORE the stop: afterwards there is nobody left to ask.
  const legacy = await replacingLegacyBuild(root, deps);

  const stopped = await stop(args, { ...deps, root, log });

  // A daemon that survived both a request and a signal still holds the port and
  // the portfile. Starting now would either lose the race to it or make `start`
  // print "already running — use restart", i.e. tell the user to run the command
  // they just ran. Say the true thing instead.
  if (!stopped.ok) {
    log('restart aborted — the old daemon is still running. Clear it first (`claude-web-chat doctor`), then retry.');
    return { ok: false, stopped, started: false };
  }

  await startFn(['--daemon'], { root, log });
  const out = { ok: true, stopped, started: true };
  if (legacy && printChecklist(log)) out.checklist = true;
  return out;
}

// ── the hop's post-update checklist ─────────────────────────────────────────
// The hop onto 0.8 is performed by the OLD build's frozen `update` (0.7.6's):
// it activates the new build, syncs this project's managed files, calls THIS
// restart and returns — so this is the last 0.8 code that prints in the
// terminal the user is watching, and the only place that can say what the
// release notes ask of them. It prints when the daemon just replaced was a
// pre-0.8 build (asked of the daemon itself, with stale-daemon's probe), and
// only after the new one has started. A plain `restart` of an old daemon an
// update left behind in some other project prints it too, which is right: that
// project's tabs and Claude Code are behind as well.
//
// Print-only, and it must never cost the restart anything: the probe is
// swallowed to "not legacy" and the printing to "not printed".
async function replacingLegacyBuild(root, deps) {
  try {
    const info = portfiles.readPortfile('server', { root });
    if (!info) return false;
    return await (deps.isLegacyBuild || isLegacyBuild)(info.port, { root });
  } catch {
    return false;
  }
}

function upgradeChecklist(version = packageVersion()) {
  const lines = [
    '',
    `The server here was on a build older than 0.8; it now runs v${version}. To finish the upgrade:`,
    '  1. Reload every open web-chat tab — a page loaded before the update keeps running the old one.',
    '  2. /exit and reopen Claude Code — a running session keeps the MCP server it started with,',
    '     so write_markdown arrives with the next one.',
    '  3. Run `claude-web-chat install` in each web-chat project you did not run `update` in — it',
    '     refreshes the rules and restarts a server still on the old build.',
    '     To restart every server still on the old build at once: `claude-web-chat update --restart-all`.',
  ];
  if (!isDevVersion(version)) lines.push(`  Release notes (see "Upgrading"): ${releaseTagUrl(`v${version}`)}`);
  return lines;
}

function printChecklist(log) {
  try {
    for (const line of upgradeChecklist()) log(line);
    return true;
  } catch {
    return false;
  }
}

module.exports = restart;
module.exports.upgradeChecklist = upgradeChecklist;
