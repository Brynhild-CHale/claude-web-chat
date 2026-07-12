// Capture hub server — the single fixed-port endpoint the browser extension
// talks to. It is stateless: it reads the instance registry to list what's
// running and forwards each capture POST to the instance the user picked. All
// distillation/storage still happens in that instance's own /api/capture.

const express = require('express');
const http = require('http');
const client = require('../client');
const { setCors } = require('../core/cors');
const { readInstances, registerHub, deregisterHub } = require('../util/registry');
const { hubPort, probeHub } = require('../util/hub');
const { PROTOCOL_VERSION } = require('../core/versions');

// Self-shutdown when no instances remain. A grace window keeps the hub alive
// across the moments the registry is legitimately empty: right after boot
// (before the instance that spawned us has registered) and during a `restart`'s
// stop→start gap. Tunable for tests.
const IDLE_GRACE_MS = Number(process.env.WEB_CHAT_HUB_IDLE_MS) || 15000;
const POLL_MS = Number(process.env.WEB_CHAT_HUB_POLL_MS) || 5000;

// Public view of an instance (no pid/root leakage to the browser beyond what's
// useful for the picker).
function publicInstance(e) {
  return { id: e.id, title: e.title, port: e.port, url: e.url, started_at: e.started_at };
}

// Resolve which instance a capture targets. Explicit key (id | port | root)
// wins; with no key, a lone running instance is used implicitly. Returns
// { instance } or { error, status, instances }.
function resolveTarget(key, instances) {
  if (key != null && key !== '') {
    const k = String(key);
    const hit = instances.find((e) => e.id === k || String(e.port) === k || e.root === k);
    if (hit) return { instance: hit };
    return { error: `no running instance matches "${k}"`, status: 404, instances };
  }
  if (instances.length === 1) return { instance: instances[0] };
  if (instances.length === 0) return { error: 'no running web-chat instances', status: 503, instances };
  return { error: 'multiple instances running — specify one with ?instance=<id>', status: 409, instances };
}

// Forward a request to the chosen instance, relaying its status + JSON back to the
// extension. Never rejects: a socket error maps to 502, a timeout to 504. Serves
// both the capture POST (body = the capture) and the read-only profile-match GET
// (body = null; the path carries the query string).
async function forward(instance, method, reqPath, body, token) {
  try {
    const { status, body: json } = await client.request(
      instance.port, method, reqPath, body,
      { headers: token ? { 'X-WC-Token': token } : {}, timeout: 15000 },
    );
    return { status: status || 502, json };
  } catch (e) {
    if (e && e.message === 'request timeout') return { status: 504, json: { ok: false, error: 'instance timed out' } };
    return { status: 502, json: { ok: false, error: `forward failed: ${e.message}` } };
  }
}

function createHub({ port = hubPort() } = {}) {
  const app = express();
  // Match the instance's body limit (lib/server/index.js): every capture now
  // flows extension → hub → instance, so a cap here smaller than the instance's
  // would 413 heavy-app DOMs (e.g. Gmail) before they ever reach it. Same env
  // var keeps the two in lockstep.
  app.use(express.json({ limit: process.env.WEB_CHAT_BODY_LIMIT || '200mb' }));

  app.get('/api/health', (req, res) => {
    res.json({ ok: true, role: 'hub', version: PROTOCOL_VERSION, pid: process.pid, port });
  });

  app.options('/api/instances', (req, res) => { setCors(req, res); res.status(204).end(); });
  app.get('/api/instances', (req, res) => {
    setCors(req, res);
    res.json({ instances: readInstances().map(publicInstance) });
  });

  app.options('/api/capture', (req, res) => { setCors(req, res); res.status(204).end(); });
  app.post('/api/capture', async (req, res) => {
    setCors(req, res);
    const key = req.query.instance || (req.body && (req.body.instance || req.body.instance_id));
    const instances = readInstances();
    const target = resolveTarget(key, instances);
    if (target.error) {
      return res.status(target.status).json({ ok: false, error: target.error, instances: target.instances.map(publicInstance) });
    }
    // Strip routing-only fields so the instance sees a clean capture body.
    const { instance, instance_id, ...body } = req.body || {};
    const token = req.headers['x-wc-token'];
    const { status, json } = await forward(target.instance, 'POST', '/api/capture', body, token);
    res.status(status).json({ ...json, instance: publicInstance(target.instance) });
  });

  // Profile match — forwarded to the instance (only it knows its project/global
  // profile dirs). Read-only; the extension calls it to label the capture buttons.
  app.options('/api/profile-match', (req, res) => { setCors(req, res); res.status(204).end(); });
  app.get('/api/profile-match', async (req, res) => {
    setCors(req, res);
    const target = resolveTarget(req.query.instance, readInstances());
    if (target.error) {
      return res.status(target.status).json({ ok: false, error: target.error, instances: target.instances.map(publicInstance) });
    }
    const url = String(req.query.url || '');
    const token = req.headers['x-wc-token'];
    const { status, json } = await forward(target.instance, 'GET', `/api/profile-match?url=${encodeURIComponent(url)}`, null, token);
    res.status(status).json({ ...json, instance: publicInstance(target.instance) });
  });

  const server = http.createServer(app);

  let monitorTimer = null;
  let lastNonEmpty = 0;
  let exiting = false;

  // Watch the registry; once it's been empty past the grace window, exit. The
  // next instance to start will spawn a fresh hub (ensureHub), so this is safe.
  function startMonitor() {
    lastNonEmpty = Date.now(); // startup grace
    monitorTimer = setInterval(() => {
      if (readInstances().length > 0) { lastNonEmpty = Date.now(); return; }
      if (Date.now() - lastNonEmpty >= IDLE_GRACE_MS) {
        console.log('hub idle (no instances registered) — shutting down');
        shutdown(0);
      }
    }, POLL_MS);
    if (monitorTimer.unref) monitorTimer.unref();
  }

  function shutdown(code) {
    if (exiting) return;
    exiting = true;
    if (monitorTimer) clearInterval(monitorTimer);
    deregisterHub();
    server.close(() => process.exit(code));
    // Don't let a hung connection wedge shutdown.
    setTimeout(() => process.exit(code), 1000).unref();
  }

  async function start() {
    // Fixed port: if it's already a live hub, we lost the spawn race — exit 0 so
    // the idempotent ensureHub caller treats it as success.
    if (await probeHub(port)) {
      console.log(`hub already running on ${port} — exiting`);
      process.exit(0);
    }
    await new Promise((resolve, reject) => {
      const onError = (e) => {
        server.off('error', onError);
        if (e && e.code === 'EADDRINUSE') {
          console.error(`hub port ${port} is in use by a non-hub process — set WEB_CHAT_HUB_PORT to relocate`);
          process.exit(1);
        }
        reject(e);
      };
      server.once('error', onError);
      server.listen(port, () => { server.off('error', onError); resolve(); });
    });
    registerHub({ pid: process.pid, port });
    console.log(`web-chat hub listening on http://localhost:${port}`);
    startMonitor();
  }

  function stop() {
    if (monitorTimer) clearInterval(monitorTimer);
    return new Promise((resolve) => server.close(() => resolve()));
  }

  function installSignalHandlers() {
    process.on('SIGTERM', () => shutdown(0));
    process.on('SIGINT', () => shutdown(0));
  }

  return { app, server, start, stop, installSignalHandlers, port };
}

module.exports = { createHub };
