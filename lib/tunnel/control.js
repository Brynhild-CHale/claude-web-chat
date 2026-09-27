// The tunnel's lifecycle — `tunnel up`, `down`, the forced bounce `update`
// runs, and the status read — as one shared library, so every caller runs
// the SAME machinery: the CLI (lib/cli/commands/tunnel), and the daemon's
// browser setup page (lib/server/tunnel-setup), whose "Bring it up" is this
// `up`, not a second one. It lived in the CLI command until the page needed it;
// an entry point cannot import another's internals, so it moved down a layer.
//
//   up       preflight everything that would make the tunnel unsafe or broken,
//            then start the portal detached (`portal run`), which supervises
//            cloudflared. Waits for the portal's /api/health. A running portal
//            from an older build, or one not enforcing tunnel.json as it is,
//            or one whose cloudflared runs on a connector token the file no
//            longer holds, is restarted instead.
//   down     ask the portal to stop (SIGTERM to the pid its own /api/health
//            reported); cloudflared dies with it. Returns only once both are
//            GONE (settleStopped), not merely silent — every restart is a
//            down, so the next portal never meets the old connector.
//   restartPortal  `up`'s bounce, forced — what `update` runs.
//   collectStatus  config, portal, connector readiness, exposed sessions.
//
// Every failure is a userFacing throw, worded for a person.

const fs = require('fs');
const path = require('path');
const { userPaths } = require('../core/paths');
const { readJson } = require('../core/fsjson');
const { isLoopbackBind } = require('../core/cors');
const client = require('../client');
const { isPortalCurrent, PORTAL_PROTOCOL_VERSION } = require('../core/versions');
const { isPidAlive } = require('../core/portfiles');
const { readInstances } = require('../util/registry');
const { spawnDetached } = require('../util/daemon');
const {
  loadConfig, configFingerprint, sessionHost, publicOrigin, portalPort, hiddenReason,
} = require('./config');
const {
  checkBinary, readToken, tokenFingerprint, probeReady, isStrayConnector, isConnectorProcess, stopConnector, commandOf,
} = require('./cloudflared');

// How long `down` waits for a stopped portal and its connector to exit before
// it stops the connector itself. The portal gives cloudflared STOP_GRACE_MS
// then SIGKILLs it, and exits within a second of SIGTERM; this is the margin
// for a machine too loaded to manage that.
const SETTLE_MS = 10000;

function fail(msg) {
  const e = new Error(msg);
  e.userFacing = true;
  throw e;
}

// Every reason not to start, as a userFacing throw. Returns what `up` needs.
function preflight({ env, check = checkBinary }) {
  const config = loadConfig();
  if (!config.tunnel) fail('tunnel.json names no tunnel — run `claude-web-chat tunnel setup` (a NAMED tunnel; quick tunnels cannot sit behind Access)');
  const host = env.WEB_CHAT_HOST;
  if (host && !isLoopbackBind(host)) {
    fail(`WEB_CHAT_HOST=${host} — your daemons are listening on the network with no authentication, so a tunnel in front of them would guard one door of an open house. Unset WEB_CHAT_HOST (loopback only) first.`);
  }
  const bin = check({ env });
  if (!bin.ok) fail(`${bin.error} — ${bin.hint}`);
  if (config.tunnel.kind === 'token' && !readToken()) {
    fail(`no connector token in ${userPaths().tunnelToken} — run \`claude-web-chat tunnel setup\` (or --token-file <file>)`);
  }
  if (config.tunnel.credentialsFile && !fs.existsSync(config.tunnel.credentialsFile)) {
    fail(`tunnel.credentialsFile ${config.tunnel.credentialsFile} does not exist — \`cloudflared tunnel create ${config.tunnel.name}\` writes it`);
  }
  return { config, bin };
}

// Is the running portal's cloudflared on a connector token other than the one
// in the file now? Only a token-kind tunnel has one, and only a portal that
// reports its token (health.token, this build on) can be asked. An older one
// is left alone here: `update` bounces a running portal onto the new build.
function tokenStale(health, config) {
  if (!health || !health.token || !config || !config.tunnel || config.tunnel.kind !== 'token') return false;
  return health.token.fp !== tokenFingerprint(readToken());
}

async function waitFor(pred, maxMs, interval = 100) {
  const deadline = Date.now() + maxMs;
  for (;;) {
    const v = await pred();
    if (v || Date.now() >= deadline) return v;
    await new Promise((r) => setTimeout(r, interval));
  }
}

function tail(file, n) {
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch { return []; }
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines.slice(-n);
}

// `restart` (a log line, or null) forces the bounce below for a portal that is
// current in every way `up` can see — restartPortal's reason, which is that the
// portal's CODE was just replaced under it.
async function up(flags, { log, env, check, waitMs = 8000, kill, settleMs, restart = null }) {
  const { config, bin } = preflight({ env, check });
  const port = portalPort(env);
  const picker = `${publicOrigin(config.hostname)}/`;
  let current = await client.probeHealth(port);
  if (current && current.role === 'portal' && restart) {
    log(`${restart} (pid ${current.pid})`);
    await down({}, { log: () => {}, note: log, env, waitMs, kill, settleMs });
    current = null;
  } else if (current && current.role === 'portal' && !isPortalCurrent(current)) {
    // A portal from an older build is still enforcing that build's rules (see
    // PORTAL_PROTOCOL_VERSION): stop it and start this one, rather than report
    // "already up" over it.
    log(`restarting an older portal (pid ${current.pid}, protocol ${current.portal_protocol || 1} → ${PORTAL_PROTOCOL_VERSION})`);
    await down({}, { log: () => {}, note: log, env, waitMs, kill, settleMs });
    current = null;
  } else if (current && current.role === 'portal' && current.config_fp !== configFingerprint(config)) {
    // The portal reloads tunnel.json live, but keeps the hostname, style and
    // tunnel it started with (they need a new cloudflared) — and an edit made
    // a moment ago may not have been noticed yet. Either way, restart it.
    log(`restarting the portal (pid ${current.pid}): ${userPaths().tunnelConfig} changed `
      + (current.config && current.config.restart && current.config.restart.length
        ? `${current.config.restart.join(', ')}, which a running portal cannot apply`
        : 'since it last read it'));
    await down({}, { log: () => {}, note: log, env, waitMs, kill, settleMs });
    current = null;
  } else if (current && current.role === 'portal' && tokenStale(current, config)) {
    // The token is cloudflared's, handed over at its launch: a new one in the
    // file (a re-run `tunnel setup`) needs a new connector.
    log(`restarting the portal (pid ${current.pid}): the connector token in ${userPaths().tunnelToken} changed since cloudflared started`);
    await down({}, { log: () => {}, note: log, env, waitMs, kill, settleMs });
    current = null;
  }
  if (current && current.role === 'portal') {
    log(`tunnel already up — portal pid ${current.pid} on 127.0.0.1:${port}`);
    log(`picker: ${picker}`);
    return { already: true, health: current };
  }
  if (current) fail(`port ${port} is answering but it is not the portal (role ${current.role || 'unknown'}) — set WEB_CHAT_PORTAL_PORT and route the tunnel there`);

  // No portal, yet cloudflared's metrics port answers: a connector outlived
  // the portal that ran it (killed outright). One the portal recorded is
  // stopped by the new portal as it starts (lib/tunnel/cloudflared
  // reapStale); anything else is not ours to signal, so say what to do.
  const metrics = config.tunnel.metricsPort;
  const occupant = await probeReady(metrics);
  if (occupant.ready || occupant.status != null) {
    const rec = readJson(userPaths().cloudflaredPid);
    if (!(rec.ok && isStrayConnector(rec.value))) {
      fail(`something already answers on cloudflared's metrics port 127.0.0.1:${metrics} with no portal running — `
        + 'most likely a connector left behind by a portal that was killed. Find it (`ps -ax | grep cloudflared`), stop it, '
        + 'and run `claude-web-chat tunnel up` again (or give tunnel.metricsPort another port)');
    }
    log(`stopping a cloudflared left running by a portal that is gone (pid ${rec.value.pid}) before starting`);
  }

  spawnDetached({ args: ['portal', 'run'], log: userPaths().portalLog, env });
  const health = await waitFor(async () => {
    const h = await client.probeHealth(port);
    return h && h.role === 'portal' ? h : null;
  }, waitMs);
  if (!health) {
    const last = tail(userPaths().portalLog, 8).map((l) => `    ${l}`).join('\n');
    fail(`the portal did not come up on 127.0.0.1:${port} — see ${userPaths().portalLog}${last ? `:\n${last}` : ''}`);
  }
  log(`✓ portal up — pid ${health.pid} on 127.0.0.1:${port} (cloudflared ${bin.version}, ${config.tunnel.kind} tunnel${config.tunnel.name ? ` "${config.tunnel.name}"` : ''})`);
  log(`  picker: ${picker}`);
  log('  `claude-web-chat tunnel status` shows when the connector is ready; `tunnel down` stops both.');
  return { already: false, health };
}

// Restart a RUNNING portal onto this build: `up`'s own bounce, forced. It is
// what `claude-web-chat update` calls — out of the NEW build's copy of this
// file (versions/<target>), so spawnDetached starts `portal run` from the code
// just installed and the new remote policy is in force at once, rather than
// whenever someone next thinks to run `tunnel up`. No portal answering is
// nothing to do; preflight refusing (a broken tunnel.json, cloudflared gone)
// throws BEFORE the old portal is stopped, so it keeps running.
async function restartPortal({ log = () => {}, env = process.env, check, waitMs, kill, settleMs } = {}) {
  const before = await client.probeHealth(portalPort(env));
  if (!(before && before.role === 'portal')) return { restarted: false };
  const r = await up({}, { log, env, check, waitMs, kill, settleMs, restart: 'restarting the portal on this build' });
  return { restarted: true, before, health: r.health };
}

// The connector a running portal runs — asked BEFORE it is stopped, since an
// orderly stop deletes the pidfile. Its /api/health says (cloudflared.pid and
// .metrics); for a portal that does not, the pidfile's record counts only if
// it names THIS portal as the one that ran it.
function connectorOf(health) {
  const cf = health.cloudflared;
  if (cf && Number.isInteger(cf.pid) && typeof cf.metrics === 'string') return { pid: cf.pid, metrics: cf.metrics };
  const rec = readJson(userPaths().cloudflaredPid);
  const v = rec.ok ? rec.value : null;
  if (v && Number.isInteger(v.pid) && v.portal_pid === health.pid && typeof v.metrics === 'string') return { pid: v.pid, metrics: v.metrics };
  return null;
}

// After the portal stops answering: wait (≤ settleMs) until it has EXITED, and
// so has the connector it ran, and that connector's metrics port is free. A
// portal closes its listener at once but gives cloudflared up to its stop
// grace to go, so a restart that only waited for the listener found the old
// connector still on the metrics port, with its portal still alive — which
// `up` cannot tell from a connector someone else left there, and refused.
// A connector that outlives the wait is stopped here (SIGTERM → SIGKILL): it
// is the one the portal we just stopped reported, so it is no stranger — but
// only once `ps` still shows it as that connector (a pid can be reused).
async function settleStopped(health, connector, { note, kill, settleMs = SETTLE_MS, alive = isPidAlive, command = commandOf }) {
  const metricsPort = connector ? Number(connector.metrics.slice(connector.metrics.lastIndexOf(':') + 1)) : null;
  const settled = await waitFor(async () => {
    if (alive(health.pid)) return false;
    if (!connector) return true;
    if (alive(connector.pid)) return false;
    const o = await probeReady(metricsPort);
    return !(o.ready || o.status != null);
  }, settleMs);
  if (settled || !connector || !alive(connector.pid) || !isConnectorProcess(connector.pid, connector.metrics, { command })) return;
  note(`cloudflared (pid ${connector.pid}) was still running ${Math.round(settleMs / 1000)}s after its portal (pid ${health.pid}) was stopped; stopping it`);
  if (await stopConnector(connector.pid, { kill, alive })) return;
  fail(`cloudflared (pid ${connector.pid}), the connector of the portal just stopped (pid ${health.pid}), is still running after SIGTERM and SIGKILL `
    + `and holds its metrics port ${connector.metrics} — stop it by hand (\`kill -9 ${connector.pid}\`), then run \`claude-web-chat tunnel up\``);
}

async function down(flags, { log, note = log, env, waitMs = 5000, settleMs, kill = (pid, sig) => process.kill(pid, sig) }) {
  const port = portalPort(env);
  const health = await client.probeHealth(port);
  if (!health || health.role !== 'portal') { log('tunnel is not up'); return { stopped: false }; }
  const connector = connectorOf(health);
  // The pid the live portal just reported on /api/health — the same identity
  // gate the hub bounce uses — never one read out of a file.
  try { kill(health.pid, 'SIGTERM'); } catch (e) { fail(`could not signal the portal (pid ${health.pid}): ${e.code || e.message}`); }
  const gone = await waitFor(async () => {
    const h = await client.probeHealth(port);
    return !(h && h.role === 'portal');
  }, waitMs);
  if (!gone) fail(`the portal (pid ${health.pid}) is still answering on 127.0.0.1:${port}`);
  await settleStopped(health, connector, { note, kill, settleMs });
  const cf = health.cloudflared && health.cloudflared.pid ? `; cloudflared (pid ${health.cloudflared.pid}) stopped with it` : '';
  log(`✓ tunnel down — portal pid ${health.pid} stopped${cf}`);
  return { stopped: true, health };
}

// ── status ──────────────────────────────────────────────────────────────────

async function collectStatus({ env }) {
  const out = { configured: false, error: null, portal: { running: false }, cloudflared: null, sessions: [], hidden: [] };
  let config = null;
  try { config = loadConfig(); out.configured = true; } catch (e) { out.error = e.message; }
  const port = portalPort(env);
  const health = await client.probeHealth(port);
  const running = !!(health && health.role === 'portal');
  out.portal = running
    ? { running: true, pid: health.pid, port, started_at: health.started_at || null, config: health.config || null }
    : { running: false, port };
  // Does the running portal enforce the file as it is NOW? It reloads it live,
  // except the sections that need a restart (health.config.restart) — and an
  // older build does not reload at all. Everything below is the file's view,
  // so a stale portal must be said aloud.
  if (running && config) out.portal.config_current = health.config_fp === configFingerprint(config);
  // The same question for the connector token, asked of the file NOW (so an
  // edit the portal has not noticed yet counts too). Absent — not false — for
  // a portal that does not report one.
  if (running && config && health.token && config.tunnel && config.tunnel.kind === 'token') {
    out.portal.token_current = !tokenStale(health, config);
  }
  if (config) {
    out.hostname = config.hostname;
    out.style = config.style;
    out.picker = `${publicOrigin(config.hostname)}/`;
    out.signin = config.signin || null;
    out.allowlist = { emails: config.allow.emails.length, domains: config.allow.domains.length };
    out.tunnel = config.tunnel;
    if (config.tunnel) {
      const ready = await probeReady(config.tunnel.metricsPort);
      out.cloudflared = { ...(running && health.cloudflared ? health.cloudflared : { state: running ? 'unsupervised' : 'stopped', pid: null }), ...ready };
    }
    out.allowDestructive = config.remote.allowDestructive;
    // The same test the portal applies (lib/tunnel/config hiddenReason), so
    // what this lists as exposed is exactly what a remote viewer can open.
    for (const e of readInstances()) {
      const title = path.basename(String(e.root || e.title || e.id));
      const reason = hiddenReason(config, e);
      if (reason) out.hidden.push({ id: e.id, title, reason });
      else out.sessions.push({ id: e.id, title, port: e.port, url: `${publicOrigin(sessionHost(config, e.id))}/` });
    }
  }
  if (running && health.jwks) out.jwks = health.jwks;
  return out;
}

module.exports = { SETTLE_MS, preflight, tokenStale, waitFor, tail, up, down, restartPortal, collectStatus };
