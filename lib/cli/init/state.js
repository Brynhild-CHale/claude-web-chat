// One state object, two renderings.
//
// `claude-web-chat init` prints prose for a human and `--json` prints a machine
// block for the `/web-chat init` slash command (and for CI). Both read THIS
// object, so the report a human sees and the report Claude reads can never
// disagree about what is installed, what is running, or what is broken.
//
// gatherState COMPUTES NOTHING NEW. Every field is sourced from an existing
// engine — paths, the toggle policy, portfiles, the daemon HTTP client, the
// mcp-seen verdict, the managed-file reconciler, the instance registry, the
// release check. If a fact needs a new rule, the rule belongs in the engine that
// owns it, not here.
//
// Every daemon call passes spawn:false. Looking at a project must never be the
// thing that starts a daemon in it.

const fs = require('fs');
const path = require('path');
const { projectPaths, userPaths } = require('../../core/paths');
const { resolve: resolveToggle } = require('../../toggle/policy');
const portfiles = require('../../core/portfiles');
const client = require('../../client');
const { readMcpSeen, mcpWrittenAt, describeRestart } = require('../../core/mcp-seen');
const { reconcileManagedFiles } = require('../../update/managed-files');
const { rows: collectRows } = require('../../util/registry');

// Managed-file actions that mean "this project's file is not what the package
// ships". `up-to-date`/`kept-edited` are settled states: neither is drift ON ITS
// OWN — read on, because one of them can still leave unfinished business.
const DRIFT_ACTIONS = new Set(['created', 'updated', 'differs', 'conflict']);

// That business is a `pending` row (an unmerged `<dest>.new` beside the file),
// which DOES count here even though its action is the settled `kept-edited`.
// This state feeds `init`'s orientation report, whose whole job is "here is the
// unfinished business in this project" — an offer the user has neither merged
// nor dismissed is exactly that, and the sidecar path is the only thing they
// need to act on it.
function isDrift(r) {
  return DRIFT_ACTIONS.has(r.action) || Boolean(r.pending);
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function schemaVersion(p) {
  const v = readJson(p.version);
  return v && Number.isFinite(v.version) ? v.version : null;
}

function nodeCount(p) {
  try {
    return fs.readdirSync(p.graphDir).filter((f) => f.endsWith('.json') && f !== '_meta.json').length;
  } catch {
    return 0;
  }
}

// Never throws: an unreachable daemon is a state, not an error.
async function quiet(fn, fallback = null) {
  try { return await fn(); } catch { return fallback; }
}

// { root, mode, doctorSummary, latest? } -> the one state object.
// `latest` is a resolveLatest() result (or null); init kicks that HTTPS call off
// concurrently and hands the settled value in, so the 2.5s timeout overlaps the
// local surveys instead of serializing behind them.
async function gatherState({ root, mode, doctorSummary = null, latest = null, deps = {} } = {}) {
  const http = deps.client || client;
  const rows = deps.collectRows || collectRows;
  const pkg = require('../../../package.json');
  const p = projectPaths(root);
  const installed = fs.existsSync(p.dir);

  // Toggle — the three scopes, resolved by the one policy engine.
  //
  // One wrinkle worth naming: the project scope reports DISABLED for a project
  // with no .web-chat/ at all (opt-in per project — an uninstalled project is a
  // silent no-op, see lib/toggle/scopes). True, but reported bare it reads as an
  // alarm on the one screen where it is expected: a first-run report. So a fresh
  // project says 'not-installed' rather than 'disabled by the project scope'.
  const user = userPaths();
  const decision = resolveToggle({ cwd: root, sessionId: process.env.CLAUDE_SESSION_ID });
  const toggle = {
    user: fs.existsSync(user.disabled) ? 'disabled' : 'enabled',
    project: !installed ? 'not-installed' : (fs.existsSync(p.disabled) ? 'disabled' : 'enabled'),
    effective: !installed ? 'not-installed' : (decision.enabled ? 'enabled' : `disabled:${decision.by}`),
  };

  // Daemon — portfile + a liveness probe, never a spawn.
  const info = installed ? portfiles.readPortfile('server', { root }) : null;
  const reachable = info ? await portfiles.probeReachable(info.port, 500) : false;
  const daemon = {
    running: Boolean(info && reachable),
    port: info ? info.port : null,
    url: info ? info.url : null,
  };

  // Live daemon facts. Both endpoints are read-only and both are optional.
  let viewers = null;
  let channel_connected = false;
  let pending_services = [];
  let health = null;
  if (daemon.running) {
    health = await quiet(() => http.get('/api/health', { port: daemon.port, root, noSpawn: true }));
    if (health && typeof health.viewers === 'number') viewers = health.viewers;
    const policy = await quiet(() => http.get('/api/queue/policy', { port: daemon.port, root, noSpawn: true }));
    channel_connected = Boolean(policy && policy.channel_connected);
    const pend = await quiet(() => http.get('/api/services/pending', { port: daemon.port, root, noSpawn: true }));
    if (pend && Array.isArray(pend.pending)) {
      pending_services = pend.pending.map((s) => ({
        name: s.name,
        sha256: s.hash || null,
        params: s.params || {},
      }));
    }
  }

  // "Has Claude Code restarted since .mcp.json changed?" — the tri-state verdict,
  // read from the same engine doctor and status use.
  const restart = describeRestart({
    seen: (health && health.mcp_seen) || (installed ? readMcpSeen(root) : null),
    mcpWrittenAt: mcpWrittenAt(root),
  });

  // Managed-file drift — the one health fact doctor does not cover. dryRun, so
  // looking never rewrites a template.
  let drift = [];
  if (installed) {
    const results = await quiet(async () => reconcileManagedFiles(root, { dryRun: true }), []);
    drift = (results || [])
      .filter(isDrift)
      .map((r) => ({
        dest: r.dest,
        action: r.action,
        ...(r.sidecar ? { sidecar: r.sidecar } : {}),
        ...(r.pending ? { pending: true } : {}),
      }));
  }

  // Every surface on this machine — the explicit half of "tell me what web-chats
  // exist on my system".
  const here = path.resolve(root);
  const surfaces = (await quiet(() => rows(), []) || []).map((r) => ({
    title: r.title || (r.root ? path.basename(r.root) : '?'),
    root: r.root || null,
    url: r.url || (r.port ? `http://127.0.0.1:${r.port}` : null),
    pid_alive: Boolean(r.pid_alive),
    reachable: Boolean(r.reachable),
    mine: Boolean(r.root && path.resolve(r.root) === here),
  }));

  const doctor = doctorSummary
    ? {
      ok: doctorSummary.ok || 0,
      repaired: doctorSummary.repaired || 0,
      problems: doctorSummary.problems || 0,
      checks: doctorSummary.checks || [],
    }
    : { ok: 0, repaired: 0, problems: 0, checks: [] };

  return {
    mode,
    root,
    version: pkg.version,
    latest: latest && latest.latest
      ? { version: latest.latest, url: latest.releaseUrl, newer: Boolean(latest.updateAvailable) }
      : null,
    toggle,
    schema: installed ? schemaVersion(p) : null,
    nodes: installed ? nodeCount(p) : 0,
    daemon,
    viewers,
    restart: { state: restart.state, line: restart.line },
    channel_connected,
    drift,
    pending_services,
    surfaces,
    doctor,
  };
}

module.exports = { gatherState, DRIFT_ACTIONS };
