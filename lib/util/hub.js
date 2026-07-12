const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const portfiles = require('../core/portfiles');
const { userPaths } = require('../core/paths');
const { PROTOCOL_VERSION, isProtocolCurrent } = require('../core/versions');

// The capture hub: a single, fixed-port router the browser extension always
// talks to. It holds no state of its own — it reads the instance registry and
// forwards captures to the instance the user picked. One per machine.
//
// Fixed port (default 5170) so the extension has a stable endpoint; chosen below
// the project-server range (5173+) to avoid colliding with them. The hub is a
// role:'hub' entry in the shared registry (registerHub/deregisterHub) — it no
// longer keeps its own portfile.

const DEFAULT_HUB_PORT = 5170;

// Hub wire-protocol version now lives in core/versions.js (PROTOCOL_VERSION), its
// single home. Kept here under the historical name for existing callers/tests.
const HUB_PROTOCOL_VERSION = PROTOCOL_VERSION;

function hubPort() {
  const env = parseInt(process.env.WEB_CHAT_HUB_PORT || '', 10);
  return Number.isFinite(env) && env > 0 ? env : DEFAULT_HUB_PORT;
}

function hubDir() {
  return userPaths().root;
}

// Fetch the hub's parsed /api/health JSON (or null on any failure). Unlike
// probeHub (boolean), this exposes the reported `version` so callers can detect a
// stale hub predating a protocol bump.
function probeHubHealth(port, timeoutMs = 400) {
  return portfiles.probeHealth(port, timeoutMs);
}

// Confirm a hub (not some other server) is answering on `port`.
function probeHub(port, timeoutMs = 400) {
  return portfiles.probeHub(port, timeoutMs);
}

function spawnHubProcess() {
  fs.mkdirSync(hubDir(), { recursive: true });
  const out = fs.openSync(userPaths().hubLog, 'a');
  const binPath = path.join(__dirname, '..', '..', 'bin', 'claude-web-chat.js');
  const child = spawn(process.execPath, [binPath, 'hub', 'run'], {
    detached: true,
    stdio: ['ignore', out, out],
    env: process.env,
  });
  child.unref();
  return child;
}

// Idempotent "make sure a CURRENT hub is up". Safe to call from every daemon
// start; concurrent callers either find it already listening or race on the fixed
// port and the loser exits cleanly (see lib/hub start()).
//
// Self-heal: if a hub is answering but reports a protocol version older than this
// build expects (a long-running daemon from before new routes landed — e.g. the
// stale-hub bug where /api/profile-match 404s), SIGTERM it, wait for the port to
// free, then spawn a fresh one. This makes a plain instance restart enough to
// upgrade the hub — no manual `hub stop` needed.
async function ensureHub({ maxMs = 6000 } = {}) {
  const port = hubPort();
  const health = await probeHubHealth(port);
  if (health && health.role === 'hub') {
    if (isProtocolCurrent(health)) return { port, url: `http://localhost:${port}` };
    // Stale hub — bounce it. Kill the pid the hub just reported on /api/health:
    // that's the live answering process, authoritative in a way a portfile pid is
    // not (a stale/recycled pid there could SIGTERM an innocent process). Then wait
    // for the port to actually free before respawning (else the new child loses the
    // start() race to the dying one and exits).
    if (health.pid) { try { process.kill(health.pid, 'SIGTERM'); } catch {} }
    const freeBy = Date.now() + maxMs;
    while (Date.now() < freeBy) {
      if (!(await probeHub(port))) break;
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  spawnHubProcess();
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    const h = await probeHubHealth(port);
    if (h && h.role === 'hub' && isProtocolCurrent(h)) return { port, url: `http://localhost:${port}` };
    await new Promise((r) => setTimeout(r, 100));
  }
  return null;
}

module.exports = {
  DEFAULT_HUB_PORT,
  HUB_PROTOCOL_VERSION,
  hubPort,
  hubDir,
  probeHub,
  probeHubHealth,
  spawnHubProcess,
  ensureHub,
};
