const path = require('path');
const client = require('../mcp/client');
const portfiles = require('../core/portfiles');
const { projectPaths } = require('../core/paths');
const { packageVersion } = require('../core/versions');
const { readJsonOr, writeJsonAtomic } = require('../core/fsjson');

// Two states that used to be conflated into one wrong sentence.
//
// The old message said the render tools "will fail" whenever the daemon was
// down. They do not: the MCP client auto-spawns the daemon and the call
// succeeds. So the hook was talking Claude out of using the surface on exactly
// the turns that most needed it — and it was doing so on the strength of a claim
// that was false.
//
// What is actually worth saying is the OTHER thing, which the hook never
// checked: whether anyone is watching. A render into a daemon with no browser
// attached succeeds, commits, and is seen by nobody.
const NO_SERVER_CONTEXT = '[web-chat] No web-chat daemon is running for this project, and no browser is open on the surface. The MCP tools still work — they start the daemon on first use — but anything you render will not be SEEN until the user opens the surface. If your answer would be better shown than described, render it and tell the user to run `claude-web-chat open`; otherwise proceed normally.';

const NO_VIEWER_CONTEXT = '[web-chat] The web-chat daemon is running, but no browser is watching the surface. Renders will succeed and will commit to the graph — the user just will not see them until they open it. If you render, say so and point them at `claude-web-chat open`.';

// A Push made while no channel was connected PARKS a wake
// envelope on the daemon. This frame introduces the parked SUMMARY as context on
// the user's next prompt, framed as what it is; bodies stay fetched by tool call
// (get_captures / get_store) per the envelope contract.
const PARKED_PREFIX = '[web-chat] Parked delivery — while the Channels wake path was not connected, the user pushed the following from the web-chat surface. It is delivered now, with this message. Fetch any bodies by tool call (get_captures / get_store) as usual.\n\n';

function emitContext(text) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext: text,
    },
  }));
}

function emitNoServer() { emitContext(NO_SERVER_CONTEXT); }

// The daemon serving this project runs a different build than this hook.
//
// The hook command resolves through ~/.web-chat/current, so it runs the NEW
// build the moment `update` flips that link — while every other project's
// daemon keeps the build it booted on until something restarts it (a tab
// attached keeps it alive indefinitely). There, a tool the old build lacks
// 404s and newer arguments are silently dropped, and nothing said why. The
// hook already reads /api/health on every prompt, and from 0.8 on that carries
// `package_version`; a web-chat instance answering without one is older than
// 0.8. Message only: this hook has just taken the turn lock, and a restart
// from inside it would pull the daemon out from under the turn.
function skewLine(health, build = packageVersion()) {
  if (!health || health.ok !== true || health.role !== 'instance') return null;
  const pv = typeof health.package_version === 'string' && health.package_version ? health.package_version : null;
  if (pv === build) return null;
  const running = pv ? `v${pv}` : 'a build older than 0.8';
  return `[web-chat] This project's surface is running ${running}, not the installed v${build} — web-chat tools may 404 or ignore arguments until the user runs \`claude-web-chat restart\` in this project. Tell them.`;
}

// Say it once per Claude session per daemon, not on every prompt: the line
// stays in the session's context, and a notice repeated each turn becomes a
// nag. Keyed to the daemon pid and both builds, so a restart onto another
// build, or another update, is news again. Best-effort: a marker that cannot
// be read or written just means the line is said again.
const SKEW_SESSIONS_KEPT = 50;
function firstTimeFor(root, key, sessionId) {
  const file = path.join(projectPaths(root).tmp, 'build-skew-notice.json');
  const rec = readJsonOr(file, null, {
    validate: (v) => v && typeof v === 'object' && typeof v.key === 'string' && Array.isArray(v.sessions),
  });
  const sessions = rec && rec.key === key ? rec.sessions : [];
  const sid = typeof sessionId === 'string' ? sessionId : '';
  if (sessions.includes(sid)) return false;
  try { writeJsonAtomic(file, { key, sessions: [...sessions, sid].slice(-SKEW_SESSIONS_KEPT) }); } catch {}
  return true;
}

// How long the liveness probe waits for the daemon's HEAD /api/health. Injectable
// (ctx.probeMs) because it is a wall-clock budget: a loaded machine — or a test
// runner sharing a CPU with a dozen other suites — can miss 500ms on a daemon
// that is perfectly alive, and the hook would then tell Claude nothing is running.
const PROBE_MS = 500;

module.exports = async function turnBegin(payload, ctx = {}) {
  const root = ctx.root || process.cwd();
  const probeMs = Number.isFinite(ctx.probeMs) ? ctx.probeMs : PROBE_MS;
  const info = portfiles.readPortfile('server', { root });
  const reachable = info ? await portfiles.probeReachable(info.port, probeMs) : false;

  if (!reachable) {
    emitNoServer();
    return;
  }

  const message = payload.prompt
    || payload.user_prompt
    || payload.userPrompt
    || payload.message
    || '';
  // `root` + noSpawn are load-bearing, not decoration. lib/mcp/client defaults
  // spawn:true, and lib/client's retry-on-ECONNREFUSED calls ensureDaemon(root)
  // — with no root that resolves findProjectRoot(process.cwd()), i.e. WHATEVER
  // project the process happens to sit in. A daemon that answered the probe and
  // then died mid-call would therefore lock (or spawn a daemon into) a different
  // project's graph than the one this hook fired for. noSpawn turns that retry
  // into a NO_SERVER we report honestly below; root pins it either way.
  try {
    await client.post('/api/turn-begin', { message, author: 'user' }, { port: info.port, root, noSpawn: true });
  } catch (e) {
    if (e && e.code === 'NO_SERVER') {
      emitNoServer();
      return;
    }
    throw e;
  }

  // Path A — deliver a parked wake (a Push made while no channel was
  // connected) as context on THIS prompt. Read the park, CLAIM it by id, and only
  // surface it if the claim succeeded — so path A and the bridge-connect drain
  // (path B) are mutually exclusive ("first consumer wins"): if the bridge drained
  // it (or a re-push merged into a fresh id) first, our id no longer matches, the
  // consume no-ops, and we print nothing (no double delivery). The daemon is already
  // confirmed reachable above, so noSpawn keeps this silent-fast; any failure here
  // is best-effort and must not disturb the turn.
  let parked = null;
  try {
    const body = await client.get('/api/queue/pending', { port: info.port, noSpawn: true });
    const pending = body && body.pending;
    if (pending && pending.envelope && pending.envelope.content) {
      const claim = await client.post('/api/queue/pending/consume', { id: pending.id }, { port: info.port, noSpawn: true });
      if (claim && claim.consumed) parked = pending.envelope.content;
    }
  } catch {}

  let health = null;
  try {
    health = await client.get('/api/health', { port: info.port, root, noSpawn: true });
  } catch {}

  // Only one additionalContext frame can be emitted per hook, so everything
  // worth saying goes into it. A parked delivery is more useful to say than
  // "nobody is watching", so it wins over that; otherwise tell Claude if nothing
  // is watching, since a render nobody sees is the failure mode this hook exists
  // to prevent. A build skew rides along with either.
  const parts = [];
  if (parked) parts.push(PARKED_PREFIX + parked);
  else if (health && health.viewers === 0) parts.push(NO_VIEWER_CONTEXT);
  const skew = skewLine(health);
  if (skew) {
    let first = true;
    try { first = firstTimeFor(root, `${health.pid}|${health.package_version || ''}|${packageVersion()}`, payload.session_id); } catch {}
    if (first) parts.push(skew);
  }
  if (parts.length) emitContext(parts.join('\n\n'));
};

module.exports.skewLine = skewLine;
