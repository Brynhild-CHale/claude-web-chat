// One portfile reader/writer/discovery/probe engine. Depends DOWN on core/paths
// only (+ node http/fs) — imports nothing from lib/client or lib/util/daemon, so
// it is the dependency leaf that breaks the client->daemon->client cycle. The two
// HTTP probes MUST stay here (core may not import lib/client), which is why this
// file is a second allowed home for http.request in the conventions tripwire.
//
// Absorbs lib/util/portfile.js (whole) and the read/write/probe halves of
// lib/util/hub.js, plus the ~9 inline "env -> findProjectRoot -> readPortfile"
// discovery dances and the wait-for-portfile loops. Phase 6 finished the format
// merge: hub.json folded into the shared registry (lib/util/registry, a
// role:'hub' entry), so `server.json` is the only role-based portfile left here.

const fs = require('fs');
const path = require('path');
const http = require('http');
const { projectPaths } = require('./paths');

function isPidAlive(pid) {
  if (typeof pid !== 'number') return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

// --- file-level primitives ---

// checkLiveness:true (default) gates on a live pid (today's readPortfile /
// readHubPortfile); false skips the pid gate and tolerates a missing pid (the
// driver's readPortfileRaw). Normalizes url + started_at so all callers see one
// shape.
function readPortfileFile(filePath, { checkLiveness = true } = {}) {
  if (!fs.existsSync(filePath)) return null;
  let data;
  try { data = JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch { return null; }
  if (!data || typeof data.port !== 'number') return null;
  if (checkLiveness && (typeof data.pid !== 'number' || !isPidAlive(data.pid))) return null;
  return {
    pid: data.pid,
    port: data.port,
    url: data.url || `http://localhost:${data.port}`,
    started_at: data.started_at || null,
  };
}

function writePortfileFile(filePath, { pid, port }) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const data = { pid, port, url: `http://localhost:${port}`, started_at: Date.now() };
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
  return data;
}

function deletePortfileFile(filePath) {
  try { fs.unlinkSync(filePath); } catch {}
}

// --- webChatDir-based (backward-compatible with the old lib/util/portfile API) ---

const portfilePathAt = (webChatDir) => path.join(webChatDir, 'server.json');
const readPortfileAt = (webChatDir, opts) => readPortfileFile(portfilePathAt(webChatDir), opts);
const writePortfileAt = (webChatDir, rec) => writePortfileFile(portfilePathAt(webChatDir), rec);
const deletePortfileAt = (webChatDir) => deletePortfileFile(portfilePathAt(webChatDir));

// --- role-based (server -> <root>/.web-chat/server.json) ---
// `server` is the only role-based portfile now; the hub moved into the shared
// registry (lib/util/registry, a role:'hub' entry) in Phase 6. The role param is
// kept for signature stability across the 15+ readPortfile('server') call sites.

function portfilePathFor(role, root) {
  return projectPaths(root != null ? root : process.cwd()).serverJson;
}
const readPortfile = (role, { root, checkLiveness } = {}) => readPortfileFile(portfilePathFor(role, root), { checkLiveness });
const writePortfile = (role, { root, pid, port } = {}) => writePortfileFile(portfilePathFor(role, root), { pid, port });
const deletePortfile = (role, { root } = {}) => deletePortfileFile(portfilePathFor(role, root));

// Resolve the port to talk to: explicit port -> env (opt-in) -> portfile (no
// liveness gate, matching the driver's discovery). Only the sites that honor
// WEB_CHAT_PORT today should pass env:true.
function discoverPort({ role = 'server', root, port, env = false } = {}) {
  if (port) return typeof port === 'string' ? parseInt(port, 10) : port;
  if (env && process.env.WEB_CHAT_PORT) return parseInt(process.env.WEB_CHAT_PORT, 10);
  const info = readPortfileFile(portfilePathFor(role, root), { checkLiveness: false });
  return info ? info.port : null;
}

// --- probes (the two http.request sites; cannot move to lib/client) ---

function probeOnce(port, pathStr, timeoutMs) {
  return new Promise((resolve) => {
    const req = http.request({ hostname: 'localhost', port, path: pathStr, method: 'HEAD', timeout: timeoutMs }, (res) => {
      res.resume();
      // 404 => a server answered but predates this route; report "not found here"
      // so the caller can fall back, but any other 2xx-4xx still proves it's alive.
      if (res.statusCode === 404) return resolve('notfound');
      resolve(res.statusCode >= 200 && res.statusCode < 500);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.end();
  });
}

// Prefer /api/health; fall back to /api/graph so older daemons still validate.
async function probeReachable(port, timeoutMs = 500) {
  const r = await probeOnce(port, '/api/health', timeoutMs);
  if (r === 'notfound') return (await probeOnce(port, '/api/graph', timeoutMs)) === true;
  return r === true;
}

// Parsed /api/health JSON (or null) — exposes role + version for hub self-heal.
function probeHealth(port, timeoutMs = 400) {
  return new Promise((resolve) => {
    const req = http.request({ hostname: 'localhost', port, path: '/api/health', method: 'GET', timeout: timeoutMs }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch { resolve(null); } });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.end();
  });
}

function probeHub(port, timeoutMs = 400) {
  return probeHealth(port, timeoutMs).then((h) => !!(h && h.role === 'hub'));
}

// --- wait loops ---

// Poll until the portfile appears AND the bound port answers. Absorbs
// daemon.waitForPortfile.
async function waitUntilReachable({ role = 'server', root, maxMs = 8000 } = {}) {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    const info = readPortfile(role, { root });
    if (info && (await probeReachable(info.port, 250))) return info;
    await new Promise((r) => setTimeout(r, 100));
  }
  return null;
}

// Poll until the portfile is gone (a stopped/restarting daemon).
async function waitUntilGone({ role = 'server', root, maxMs = 8000 } = {}) {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    if (!readPortfile(role, { root, checkLiveness: false })) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

module.exports = {
  isPidAlive,
  readPortfileFile, writePortfileFile, deletePortfileFile,
  portfilePathAt, readPortfileAt, writePortfileAt, deletePortfileAt,
  portfilePathFor, readPortfile, writePortfile, deletePortfile,
  discoverPort,
  probeReachable, probeHealth, probeHub,
  waitUntilReachable, waitUntilGone,
};
