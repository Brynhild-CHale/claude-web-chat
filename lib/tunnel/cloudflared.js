// cloudflared — finding it, launching it for the configured NAMED tunnel, and
// keeping it running for as long as the portal runs.
//
// web-chat never installs cloudflared (a network daemon from a third party is
// the user's to install and update); it only finds one on PATH, checks it is
// recent enough, and prints the platform's install line when it is not.
//
// Two launch shapes, both with a loopback-only `--metrics` server whose `/ready`
// answers 200 once the connector holds a live connection (`tunnel status` and
// `doctor` read it):
//
//   token   cloudflared tunnel --no-autoupdate --metrics 127.0.0.1:<m> run
//           with the connector token in TUNNEL_TOKEN. NEVER in argv: any local
//           user can read another's argv with `ps`, and the token is the
//           tunnel's whole credential. Ingress is whatever the dashboard says.
//   local   cloudflared tunnel --no-autoupdate --metrics 127.0.0.1:<m>
//             --config ~/.web-chat/tunnel/cloudflared.yml run <name>
//           with an ingress file generated here (renderIngress): the picker
//           and the session hostnames → http://127.0.0.1:<portal>, everything
//           else → 404, and `originRequest.access` so cloudflared itself also
//           refuses a request with no valid Access token for our AUD.
//
// The supervisor (createSupervisor) restarts a connector that exits, with
// exponential backoff 1s → 60s that resets once a run has lasted 5 minutes, and
// kills it when the portal stops or exits.
//
// A portal killed OUTRIGHT (SIGKILL, the OOM killer) runs none of that: its
// cloudflared is reparented to init and keeps the tunnel connection and the
// metrics port. So the supervisor records the connector it runs in
// ~/.web-chat/tunnel/cloudflared.pid.json, and at start stops one a dead portal
// left behind (reapStale) — only after checking it IS that connector: alive,
// its portal gone, and its command line still cloudflared with the recorded
// --metrics address (a pid read out of a file may have been reused).

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { compareVersions } = require('../core/versions');
const { userPaths } = require('../core/paths');
const { readJson, writeJsonAtomic } = require('../core/fsjson');
const { isPidAlive } = require('../core/portfiles');
const client = require('../client');

// Cloudflare supports cloudflared releases for one year and stops accepting
// connections from older ones, so anything older than about that is broken in
// the field whatever web-chat does. `TUNNEL_TOKEN` in the environment and
// `originRequest.access` both long predate this floor.
const MIN_VERSION = '2024.1.0';

const BACKOFF = { initialMs: 1000, maxMs: 60 * 1000, resetAfterMs: 5 * 60 * 1000 };
const STOP_GRACE_MS = 700;

// The install line for this platform. Printed, never run.
function installHint({ platform = process.platform, env = process.env, release = os.release() } = {}) {
  if (platform === 'darwin') return 'install it with: brew install cloudflared';
  if (platform === 'linux') {
    const wsl = !!env.WSL_DISTRO_NAME || /microsoft/i.test(release);
    return 'install it from Cloudflare\'s package repository (https://pkg.cloudflare.com/ — '
      + 'Debian/Ubuntu: add the cloudflared apt source, then `sudo apt install cloudflared`)'
      + (wsl ? '. Under WSL install the LINUX build inside the distro — a Windows cloudflared.exe cannot dial the portal on WSL\'s loopback' : '');
  }
  return 'install it from https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/';
}

// The cloudflared on PATH, or null. A plain PATH walk (no shell, no `which`):
// the first executable regular file named cloudflared wins, exactly as the
// spawn below will resolve it.
function findCloudflared({ env = process.env } = {}) {
  const dirs = String(env.PATH || '').split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    const candidate = path.join(dir, 'cloudflared');
    try {
      if (!fs.statSync(candidate).isFile()) continue;
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {}
  }
  return null;
}

// `cloudflared --version` → "2025.8.1", or null when it will not say.
function cloudflaredVersion(bin, { env = process.env } = {}) {
  const r = spawnSync(bin, ['--version'], { env, encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'] });
  if (r.error || r.status !== 0) return null;
  const m = `${r.stdout || ''} ${r.stderr || ''}`.match(/(\d{4}\.\d+\.\d+)/);
  return m ? m[1] : null;
}

// The one "is a usable cloudflared here?" answer:
//   { ok: true, bin, version } | { ok: false, bin?, version?, error, hint }
function checkBinary({ env = process.env } = {}) {
  const bin = findCloudflared({ env });
  if (!bin) return { ok: false, error: 'cloudflared is not on your PATH', hint: installHint({ env }) };
  const version = cloudflaredVersion(bin, { env });
  if (!version) return { ok: false, bin, error: `${bin} did not report a version`, hint: installHint({ env }) };
  if (compareVersions(version, MIN_VERSION) < 0) {
    return { ok: false, bin, version, error: `cloudflared ${version} is older than ${MIN_VERSION} (Cloudflare stops accepting connectors about a year after release)`, hint: installHint({ env }).replace(/^install/, 'update') };
  }
  return { ok: true, bin, version };
}

// The ingress rule's wildcard for session hostnames. cloudflared matches a
// wildcard only as a whole leading label (`*.example.com`), never `wc-*`, so a
// flat layout routes every subdomain of the parent domain here — and the
// portal's own Host check (lib/tunnel/config parseHost) then answers 421 for
// anything that is not `wc-<id>`. Only names DNS actually points at the tunnel
// arrive at all.
function sessionWildcard(config) {
  if (config.style === 'nested') return `*.${config.hostname}`;
  return `*.${config.hostname.split('.').slice(1).join('.')}`;
}

// The cloudflared.yml a LOCAL tunnel runs from. Every scalar is JSON-quoted,
// which is valid YAML for any string, so no hostname or path can break out.
function renderIngress(config, { portalPort }) {
  const q = (v) => JSON.stringify(String(v));
  const service = q(`http://127.0.0.1:${portalPort}`);
  const lines = [
    '# Generated by claude-web-chat (lib/tunnel/cloudflared) on every `tunnel up`.',
    '# Edit ~/.web-chat/tunnel/tunnel.json instead; this file is rewritten.',
    `tunnel: ${q(config.tunnel.name)}`,
  ];
  if (config.tunnel.credentialsFile) lines.push(`credentials-file: ${q(config.tunnel.credentialsFile)}`);
  lines.push(
    'originRequest:',
    '  access:',
    '    required: true',
    `    teamName: ${q(config.access.team)}`,
    '    audTag:',
    `      - ${q(config.access.aud)}`,
    'ingress:',
    `  - hostname: ${q(config.hostname)}`,
    `    service: ${service}`,
    `  - hostname: ${q(sessionWildcard(config))}`,
    `    service: ${service}`,
    '  - service: http_status:404',
    '',
  );
  return lines.join('\n');
}

// argv + env for one launch. `token` is the connector token (token kind only).
function buildLaunch(config, { portalPort, token, configFile = userPaths().cloudflaredConfig, env = process.env } = {}) {
  const t = config.tunnel;
  const argv = ['tunnel', '--no-autoupdate', '--metrics', `127.0.0.1:${t.metricsPort}`];
  const childEnv = { ...env };
  // Never let an ambient TUNNEL_TOKEN pick the tunnel: for `local` it would
  // silently override the named one; for `token` it is replaced by ours.
  delete childEnv.TUNNEL_TOKEN;
  if (t.kind === 'token') {
    if (!token) throw Object.assign(new Error(`no connector token in ${userPaths().tunnelToken} — run \`claude-web-chat tunnel setup\``), { userFacing: true });
    childEnv.TUNNEL_TOKEN = token;
    argv.push('run');
  } else {
    argv.push('--config', configFile, 'run', t.name);
  }
  return { argv, env: childEnv, portalPort };
}

// The connector token file → the token, or null. Tightened to 0600 if it is
// readable by anyone else (it was written by hand, or by an older umask).
function readToken(file = userPaths().tunnelToken) {
  try {
    const st = fs.statSync(file);
    if ((st.mode & 0o077) !== 0) { try { fs.chmodSync(file, 0o600); } catch {} }
    const token = fs.readFileSync(file, 'utf8').trim();
    return token || null;
  } catch {
    return null;
  }
}

// Which connector token this is, without saying it: a short sha256 of the
// token (null for none). The portal reports the one its cloudflared started
// with on /api/health, and `tunnel up|status` compare it with the file's — the
// connector token's twin of lib/tunnel/config configFingerprint. Sixteen hex
// characters of a hash of a long random credential give nothing back.
function tokenFingerprint(token) {
  if (!token) return null;
  return crypto.createHash('sha256').update(String(token)).digest('hex').slice(0, 16);
}

// Is the connector up? cloudflared's `/ready` on its loopback metrics port is
// 200 with at least one registered connection, 503 before that.
async function probeReady(metricsPort, { timeout = 800 } = {}) {
  try {
    const body = await client.get('/ready', { port: metricsPort, noSpawn: true, timeout });
    const n = body && Number.isFinite(body.readyConnections) ? body.readyConnections : null;
    return { ready: true, connections: n };
  } catch (e) {
    if (e && e.status) return { ready: false, status: e.status };
    return { ready: false, status: null };
  }
}

// The command line of a running process, or null (gone, or `ps` would not say).
function commandOf(pid) {
  const r = spawnSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] });
  if (r.error || r.status !== 0) return null;
  return String(r.stdout || '').trim() || null;
}

// Is `pid` a cloudflared serving the metrics address `metrics` ("host:port")?
// The pid-reuse check every signal to a connector pid passes first.
function isConnectorProcess(pid, metrics, { command = commandOf } = {}) {
  if (!Number.isInteger(pid) || pid <= 1 || typeof metrics !== 'string') return false;
  const argv = command(pid);
  return !!argv && /cloudflared/.test(argv) && argv.includes(`--metrics ${metrics}`);
}

// Is the record's pid still the connector it names? Alive, the portal that ran
// it gone (a live portal still owns its own), and its argv still cloudflared
// serving the recorded metrics address.
function isStrayConnector(rec, { self = process.pid, alive = isPidAlive, command = commandOf } = {}) {
  if (!rec || !Number.isInteger(rec.pid) || rec.pid <= 1 || typeof rec.metrics !== 'string') return false;
  if (rec.portal_pid === self || !alive(rec.pid)) return false;
  if (Number.isInteger(rec.portal_pid) && alive(rec.portal_pid)) return false;
  return isConnectorProcess(rec.pid, rec.metrics, { command });
}

const signal = (pid, sig) => process.kill(pid, sig);

// Stop a connector this process did not spawn (so holds no handle to): SIGTERM,
// SIGKILL once `graceMs` short of the deadline (3 × graceMs), then give up.
// Resolves true once it is gone, false if it outlived the deadline. The
// caller has already established WHOSE it is (isStrayConnector, or the portal
// that just reported it) and that the pid is still it (isConnectorProcess).
// The poll is REF'd on purpose: `tunnel down` awaits this as the last thing a
// one-shot CLI does, holding no handle to a connector another process spawned,
// so an unref'd poll let that CLI exit right after the SIGTERM — no SIGKILL,
// no answer, the connector left on its metrics port. The deadline bounds it.
function stopConnector(pid, { kill = signal, alive = isPidAlive, graceMs = STOP_GRACE_MS, now = Date.now } = {}) {
  try { kill(pid, 'SIGTERM'); } catch {}
  return new Promise((resolve) => {
    const deadline = now() + graceMs * 3;
    let escalated = false;
    const tick = () => {
      if (!alive(pid)) { resolve(true); return; }
      if (!escalated && now() >= deadline - graceMs) { escalated = true; try { kill(pid, 'SIGKILL'); } catch {} }
      if (now() >= deadline) { resolve(false); return; }
      setTimeout(tick, 50);
    };
    tick();
  });
}

// Keep one cloudflared running. Injectable spawn/backoff/clock for the tests;
// in production the defaults are the real thing.
function createSupervisor({
  config,
  portalPort,
  logFile = userPaths().cloudflaredLog,
  configFile = userPaths().cloudflaredConfig,
  tokenFile = userPaths().tunnelToken,
  pidFile = userPaths().cloudflaredPid,
  bin = 'cloudflared',
  env = process.env,
  backoff = BACKOFF,
  stopGraceMs = STOP_GRACE_MS,
  now = Date.now,
  log = () => {},
  command = commandOf,
  kill = signal,
} = {}) {
  if (!config || !config.tunnel) throw new Error('createSupervisor: the config names no tunnel');
  let child = null;
  let state = 'idle';
  let stopping = false;
  let timer = null;
  let delay = backoff.initialMs;
  let restarts = 0;
  let startedAt = null;
  let lastExit = null;
  let lastError = null;
  let nextAt = null;

  function killOnExit() { if (child) { try { child.kill('SIGTERM'); } catch {} } }

  function launch() {
    timer = null;
    nextAt = null;
    if (stopping) return;
    let spec;
    try {
      if (config.tunnel.kind === 'local') {
        fs.mkdirSync(path.dirname(configFile), { recursive: true, mode: 0o700 });
        fs.writeFileSync(configFile, renderIngress(config, { portalPort }), { mode: 0o600 });
        fs.chmodSync(configFile, 0o600);
      }
      spec = buildLaunch(config, { portalPort, token: config.tunnel.kind === 'token' ? readToken(tokenFile) : null, configFile, env });
    } catch (e) {
      lastError = e.message;
      log(`cloudflared not started: ${e.message}`);
      return schedule();
    }
    let fd = null;
    try {
      fs.mkdirSync(path.dirname(logFile), { recursive: true });
      fd = fs.openSync(logFile, 'a');
      // NOT detached, so a signal to the portal's process group (a terminal's
      // ^C) reaches it too. That alone does not tie its life to the portal's:
      // stop() and the 'exit' hook end it on every orderly exit, and a portal
      // killed outright leaves it running for the next start to reap (the
      // pidfile, reapStale).
      child = spawn(bin, spec.argv, { env: spec.env, stdio: ['ignore', fd, fd] });
    } catch (e) {
      child = null;
      lastError = e.message;
      log(`cloudflared failed to spawn: ${e.message}`);
      return schedule();
    } finally {
      if (fd != null) { try { fs.closeSync(fd); } catch {} }
    }
    state = 'running';
    startedAt = now();
    lastError = null;
    const me = child;
    log(`cloudflared started (pid ${me.pid}, ${config.tunnel.kind} tunnel)`);
    if (me.pid) {
      try {
        writeJsonAtomic(pidFile, { pid: me.pid, portal_pid: process.pid, metrics: `127.0.0.1:${config.tunnel.metricsPort}`, started_at: startedAt });
      } catch (e) { log(`could not record the connector's pid: ${e.message}`); }
    }
    // A spawn that fails outright (ENOENT, EACCES) emits 'error' and may never
    // emit 'exit'; either one ends this run, exactly once.
    let ended = false;
    const end = (code, signal) => {
      if (ended) return;
      ended = true;
      if (child === me) child = null;
      forgetPid(me.pid);
      lastExit = { code, signal, at: now() };
      if (stopping) { state = 'stopped'; return; }
      // A run that lasted long enough was a healthy connector that later
      // failed — start the ladder again rather than waiting a minute.
      if (startedAt != null && now() - startedAt >= backoff.resetAfterMs) delay = backoff.initialMs;
      log(`cloudflared exited (${signal || `code ${code}`}); restarting in ${delay}ms`);
      schedule();
    };
    me.on('error', (e) => { lastError = e.message; if (me.pid == null) end(null, null); });
    me.on('exit', end);
  }

  function schedule() {
    if (stopping) return;
    state = 'backoff';
    const wait = delay;
    delay = Math.min(delay * 2, backoff.maxMs);
    nextAt = now() + wait;
    restarts++;
    timer = setTimeout(launch, wait);
    if (timer.unref) timer.unref();
  }

  // Drop the pidfile if it still names `pid` (a newer launch owns it otherwise).
  function forgetPid(pid) {
    const r = readJson(pidFile);
    if (r.ok && r.value && r.value.pid === pid) { try { fs.rmSync(pidFile, { force: true }); } catch {} }
  }

  // A connector left behind by a portal that died without stopping it. Null
  // when there is nothing to wait for; else a promise that settles once it is
  // gone (SIGTERM, then SIGKILL after the stop grace).
  function reapStale() {
    const r = readJson(pidFile);
    if (!r.ok) return null;
    const rec = r.value;
    if (!isStrayConnector(rec, { command })) {
      // A record naming nothing alive is only clutter; one naming a live pid
      // we could not verify is left alone, file and process both.
      if (rec && Number.isInteger(rec.pid) && !isPidAlive(rec.pid)) { try { fs.rmSync(pidFile, { force: true }); } catch {} }
      return null;
    }
    log(`stopping a cloudflared left running by a portal that is gone (pid ${rec.pid}, portal pid ${rec.portal_pid})`);
    return stopConnector(rec.pid, { kill, graceMs: stopGraceMs, now }).then((gone) => {
      if (gone) { try { fs.rmSync(pidFile, { force: true }); } catch {} return; }
      log(`cloudflared pid ${rec.pid} did not exit; starting anyway`);
    });
  }

  // Resolves once the first launch has been made (at once, unless a stray
  // connector has to be stopped first).
  function start() {
    stopping = false;
    process.on('exit', killOnExit);
    const stale = reapStale();
    if (!stale) { launch(); return Promise.resolve(); }
    state = 'starting';
    return stale.then(() => { if (!stopping) launch(); });
  }

  function stop() {
    stopping = true;
    process.off('exit', killOnExit);
    if (timer) { clearTimeout(timer); timer = null; nextAt = null; }
    const c = child;
    if (!c || c.exitCode !== null || c.signalCode !== null) { state = 'stopped'; if (c) forgetPid(c.pid); return Promise.resolve(); }
    return new Promise((resolve) => {
      const kill = setTimeout(() => { try { c.kill('SIGKILL'); } catch {} }, stopGraceMs);
      c.once('exit', () => { clearTimeout(kill); state = 'stopped'; resolve(); });
      try { c.kill('SIGTERM'); } catch { clearTimeout(kill); resolve(); }
    });
  }

  function status() {
    return {
      kind: config.tunnel.kind,
      name: config.tunnel.name,
      state,
      pid: child ? child.pid : null,
      started_at: child ? startedAt : null,
      restarts,
      next_restart_at: nextAt,
      last_exit: lastExit,
      error: lastError,
      metrics: `127.0.0.1:${config.tunnel.metricsPort}`,
    };
  }

  return { start, stop, status, get delay() { return delay; } };
}

module.exports = {
  MIN_VERSION, BACKOFF,
  installHint, findCloudflared, cloudflaredVersion, checkBinary,
  sessionWildcard, renderIngress, buildLaunch, readToken, tokenFingerprint, probeReady,
  commandOf, isConnectorProcess, isStrayConnector, stopConnector, createSupervisor,
};
