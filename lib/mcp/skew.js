// When this session's web-chat tools and the builds around them have drifted
// apart, say so to CLAUDE, in the tool result: the one channel it reads.
//
// Two drifts, and until now neither reached Claude. The MCP server's own
// notices went to stderr, which Claude Code shows only in its MCP logs, and
// the tools/call catch turned every daemon error into a bare `Error: <message>`.
//
//   * The daemon is OLDER than these tools. An update restarts the daemon of
//     the project it was typed in and no other, so a reopened session
//     elsewhere runs new tools against an old daemon, and a route that build
//     never had answers 404. unknownRouteError turns that 404 into the fix.
//
//   * These tools are older (or newer) than the INSTALLED build. Claude Code
//     loads the MCP server once, at session start, so a session begun before
//     `update` keeps the tools it loaded while ~/.web-chat/current moves on.
//     createBuildNotice notices, once per session, and names the fix.

const { HttpError } = require('../client');
const { describeInstall } = require('../update/install-layout');
const { packageVersion } = require('../core/versions');

// Express answers a route it does not have with its default 404 page: HTML,
// not JSON. Every route the tools call answers its OWN 404s ("no such node",
// "unknown component") with a JSON object, so a 404 whose body is not an
// object is the daemon saying it has never heard of the route, which means
// it runs an older build than these tools. The HTML page itself says nothing
// Claude can use, so the message drops it. Returns the error text, or null
// for any other failure.
function unknownRouteError(e) {
  if (!(e instanceof HttpError) || e.status !== 404) return null;
  if (e.body && typeof e.body === 'object') return null;
  return `Error: ${e.method} ${e.path} → 404: this project's web-chat server does not have this route, so it is running an older build than these tools. Tell the user to run \`claude-web-chat restart\` in this project.`;
}

// How often the installed build is looked at: a few fs reads, at most once a
// minute, on the tool-call path.
const CHECK_INTERVAL_MS = 60_000;

// `take()` returns the one-line notice the first time the installed build
// (~/.web-chat/current, as describeInstall reads it) differs from the build
// this process loaded, and null every other time. `running` is the version
// this process loaded, not re-read from its directory, because `update` prunes
// old version directories, possibly this one, while a session still runs.
//
// Only a managed install has an installed build to fall behind. A checkout or
// a hand-copied tree is not loaded through ~/.web-chat/current, so its first
// look is its last. The kind is decided on that first look and kept: a later
// prune of this process's directory must not reclassify it.
function createBuildNotice({
  describe = () => describeInstall(),
  running = packageVersion(),
  now = Date.now,
  intervalMs = CHECK_INTERVAL_MS,
} = {}) {
  let done = false;
  let managed = null;
  let lastCheck = -Infinity;
  return {
    take() {
      if (done) return null;
      const t = now();
      if (t - lastCheck < intervalMs) return null;
      lastCheck = t;
      let d;
      try { d = describe(); } catch { return null; }
      if (managed === null) managed = Boolean(d && d.kind === 'managed');
      if (!managed) { done = true; return null; }
      const installed = d && d.currentVersion;
      if (!installed || !running || installed === running) return null;
      done = true;
      return `[web-chat] v${installed} is installed, but this Claude Code session still runs the v${running} web-chat tools. Tell the user to /exit and reopen Claude Code to load them.`;
    },
  };
}

module.exports = { unknownRouteError, createBuildNotice, CHECK_INTERVAL_MS };
