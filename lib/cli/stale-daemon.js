// A daemon still serving an OLDER build than the CLI that just ran.
//
// An update flips ~/.web-chat/current and restarts the daemon of the project it
// was typed in — nothing else. Every other project with a surface open keeps
// its old process: a daemon only exits on its WS grace timer, and an attached
// tab never lets that fire. The reopened Claude Code there runs the NEW MCP and
// rules against the OLD daemon, so a tool the old build never had (0.8.0's
// write_markdown → POST /api/markdown) 404s and `render({after, place})` is
// silently ignored. Nothing noticed.
//
// So the commands a user runs in a project after an update — `install`, `open`,
// `start --daemon` — ask the running daemon which build it serves and, when it is
// not this one, bounce it through `restart` (the one stop + start engine), with
// one line saying so. `update` asks the same question of every OTHER running
// project (runningBuild), to list them or, with --restart-all, bounce them and
// refresh the managed files of each one web-chat is registered in.
//
// Which build: `package_version` on GET /api/health (cheap, no network) where the daemon
// has it, else GET /api/version's `current`, which every build back to 0.7.x
// serves — but which may first refresh the GitHub release cache (a 2.5s fetch),
// hence the longer timeout. A daemon that answers neither is "unknown", and an
// unknown build is never restarted: a restart is only ever for a daemon that
// said, in its own words, that it is some other version.
//
// `exact: false` settles for "older than 0.8" where naming the exact release
// would cost that second request: every 0.8 build names its release on health,
// so a daemon that answers there and names none is a pre-0.8 build — what the
// registry calls legacy_build, reported as its LEGACY_BUILD. `restart` asks it
// that way (isLegacyBuild) of the daemon it is about to replace, in front of
// every stop, and must not spend a GitHub fetch doing it.

const client = require('../client');
const portfiles = require('../core/portfiles');
const { packageVersion } = require('../core/versions');
const registry = require('../util/registry');

const { LEGACY_BUILD } = registry;

const HEALTH_TIMEOUT_MS = 800;
const VERSION_TIMEOUT_MS = 6_000;

// The package version the daemon on `port` is running, or null — or, with
// `exact: false`, LEGACY_BUILD for a daemon too old to say it on health. With
// `pid`, a health answer naming any other pid is null: the port is no longer
// the daemon the caller verified, and its build is nobody's business here.
async function runningBuild(port, { root, pid, timeoutMs = VERSION_TIMEOUT_MS, exact = true, probeHealth = portfiles.probeHealth, get = client.get } = {}) {
  if (!port) return null;
  const h = await probeHealth(port, HEALTH_TIMEOUT_MS);
  if (!h || h.ok === false) return null;
  if (pid != null && h.pid !== pid) return null;
  if (typeof h.package_version === 'string' && h.package_version) return h.package_version;
  if (!exact) return LEGACY_BUILD;
  try {
    const v = await get('/api/version', { port, root, noSpawn: true, timeout: timeoutMs });
    return v && typeof v.current === 'string' && v.current ? v.current : null;
  } catch {
    return null;
  }
}

// Restart this project's daemon when it is serving a build other than
// `expected` (this CLI's, by default). Returns { restarted, build, ok }.
// `restart` is injectable (tests); its own output is swallowed — the caller
// gets one line, not stop's and start's four.
//
// WHICH daemon: only one /api/health has just shown is this root's — `daemon`,
// the record lib/util/registry daemonFor verified (`open` passes the one it
// adopted), else daemonFor asked here (`start` and `install` pass none). Never
// the portfile read raw: a .web-chat/ copied from another project carries a
// portfile naming THAT project's daemon, and when it ran an older build the
// bounce used to restart it — stop asked it to shut down, by the pid and port
// read out of the file — while this root's own daemon, found through the
// registry, was left alone. The build is asked of that record's port and pid,
// and the restart is handed the record as stop's `target`, so it stops exactly
// that pid (stop re-checks it answers as itself first) and nothing the portfile
// names.
async function restartIfStale(root, { log = console.log, expected = packageVersion(), restart, daemon, daemonFor = registry.daemonFor, build: buildOf = runningBuild, isLegacy = isLegacyBuild } = {}) {
  if (!root) return { restarted: false, build: null };
  let d = daemon;
  if (d === undefined) {
    try { d = await daemonFor(root); } catch { d = null; }
  }
  if (!d || !Number.isInteger(d.pid) || !Number.isInteger(d.port)) return { restarted: false, build: null };
  const build = await buildOf(d.port, { root, pid: d.pid });
  if (!build || build === expected) return { restarted: false, build };
  const run = restart || require('./commands/restart');
  const target = { pid: d.pid, port: d.port, url: d.url, source: d.source };
  // restart asks "was it a pre-0.8 build?" (for its post-update checklist) of
  // the portfile's port; pointed here at the same verified daemon instead.
  const legacy = (_port, o = {}) => isLegacy(d.port, { ...o, pid: d.pid });
  let r = null;
  try { r = await run([], { root, log: () => {}, target, isLegacyBuild: legacy }); } catch (e) { r = { ok: false, error: e && e.message }; }
  if (r && r.ok) {
    log(`Restarted the web-chat server on v${expected} — it was still running v${build}.`);
    return { restarted: true, build, ok: true };
  }
  log(`⚠ The web-chat server here is running v${build}, not v${expected}, and could not be restarted — run \`claude-web-chat restart\`.`);
  return { restarted: false, build, ok: false };
}

// Is the daemon on `port` a build older than 0.8? False for one that does not
// answer: an unknown build is never called old.
async function isLegacyBuild(port, opts = {}) {
  return (await runningBuild(port, { ...opts, exact: false })) === LEGACY_BUILD;
}

module.exports = { runningBuild, isLegacyBuild, restartIfStale };
