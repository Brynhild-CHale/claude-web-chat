// The tunnel portal — the one process a Cloudflare tunnel may reach, standing
// between the public hostnames and the loopback daemons.
//
// NOT the hub. The hub (lib/hub) is a convenience router for the browser
// extension: stateless, spawned on demand, idle-exits, trusts localhost. The
// portal is the opposite posture — it assumes every request is hostile until a
// Cloudflare Access JWT proves otherwise — and the opposite lifecycle: it runs
// exactly as long as the operator's `tunnel up` says so. Sharing a process
// would mean sharing a failure mode.
//
// It binds LOOPBACK only (cloudflared dials it locally), on a fixed port
// (WEB_CHAT_PORTAL_PORT, default 5171) so the tunnel's ingress can name it, and
// registers itself as the registry's `role:'portal'` entry.
//
// Per request, in this order — every step fails closed:
//   1. Host. The configured apex (the picker) or a session hostname
//      (config.js) — anything else is 421. A loopback Host reaches only
//      GET /api/health (the `tunnel up`/`status` probe), never a session.
//   2. The Access JWT (access-jwt.js): 401 / 403 / 503.
//   3. Apex → the picker (picker.js). Session → the registry lookup (memoised
//      for 1s); no such running instance → the friendly 404.
//   4. The remote route policy (lib/core/remote-policy): default deny, 403
//      with a hint naming what to run on the host.
//   5. CSRF. Any Origin present must be exactly the session's public origin; a
//      non-GET/HEAD must carry one; Sec-Fetch-Site cross-site (or same-site —
//      another session, or the picker) is refused except a top-level
//      navigation to `/`.
//   6. Proxy (proxy.js, streamed) or WebSocket relay (ws-relay.js) to
//      127.0.0.1:<port>, Host rewritten, headers allowlisted.
//
// The portal never spawns a daemon: a session that is not running is a 404,
// not a reason to start one.

const http = require('http');
const { LOOPBACK } = require('../core/cors');
const { PROTOCOL_VERSION } = require('../core/versions');
const { classify, refusalBody } = require('../core/remote-policy');
const { readInstances, registerRole, deregisterRole } = require('../util/registry');
const { parseHost, sessionHost, publicOrigin } = require('./config');
const { createJwksCache } = require('./jwks');
const { createVerifier, tokenFrom, MESSAGES } = require('./access-jwt');
const { proxyHttp, securityHeaders, pathnameOf } = require('./proxy');
const { createWsRelay, refuseUpgrade } = require('./ws-relay');
const { servePicker, sessionNotFound } = require('./picker');

const DEFAULT_PORTAL_PORT = 5171;
const REGISTRY_MEMO_MS = 1000;

function portalPort() {
  const env = parseInt(process.env.WEB_CHAT_PORTAL_PORT || '', 10);
  return Number.isFinite(env) && env > 0 ? env : DEFAULT_PORTAL_PORT;
}

// Is this request the one cross-site request a session admits: the browser
// opening the surface from a link (an email, a chat, the picker)?
function isTopLevelNavToRoot(req) {
  const h = req.headers;
  return (req.method === 'GET' || req.method === 'HEAD')
    && pathnameOf(req.url) === '/'
    && h['sec-fetch-mode'] === 'navigate'
    && (h['sec-fetch-dest'] == null || h['sec-fetch-dest'] === 'document');
}

// Step 5. Returns null when the request may proceed, else a refusal
// { status, body }. `upgrade` for the WebSocket handshake, which must always
// carry the exact origin.
function csrfRefusal(req, sessionOrigin, { upgrade = false } = {}) {
  const origin = req.headers.origin;
  if (origin != null && origin !== sessionOrigin) {
    return { status: 403, body: { ok: false, remote: true, error: 'cross-origin request refused' } };
  }
  const safe = req.method === 'GET' || req.method === 'HEAD';
  if ((upgrade || !safe) && origin == null) {
    return { status: 403, body: { ok: false, remote: true, error: 'a request that changes something must come from the session\'s own page' } };
  }
  const site = req.headers['sec-fetch-site'];
  if ((site === 'cross-site' || site === 'same-site') && !(upgrade ? false : isTopLevelNavToRoot(req))) {
    return { status: 403, body: { ok: false, remote: true, error: `${site} request refused` } };
  }
  return null;
}

function createPortal({
  port = portalPort(),
  config,
  fetchJwks,
  now = Date.now,
  instances = readInstances,
  probe,
  wsGraceMs,
  log = () => {},
} = {}) {
  if (!config) throw new Error('createPortal: a normalised config is required (lib/portal/config normalizeConfig)');
  const jwks = createJwksCache({ team: config.access.team, fetchJwks, now });
  const verifier = createVerifier({ team: config.access.team, aud: config.access.aud, allow: config.allow, jwks, now });
  const relay = createWsRelay({ now, graceMs: wsGraceMs });
  const startedAt = Date.now();

  // The registry, read at most once a second: a page load is dozens of asset
  // requests, and each would otherwise re-read and re-prune the file.
  let memo = { at: -Infinity, list: [] };
  function liveInstances() {
    if (Date.now() - memo.at >= REGISTRY_MEMO_MS) memo = { at: Date.now(), list: instances() };
    return memo.list;
  }
  function forget() { memo = { at: -Infinity, list: [] }; }
  function findSession(id) {
    return liveInstances().find((e) => e && e.id === id && Number.isInteger(e.port)) || null;
  }

  function health() {
    return {
      ok: true,
      role: 'portal',
      version: PROTOCOL_VERSION,
      pid: process.pid,
      port: server.listening ? server.address().port : port,
      hostname: config.hostname,
      style: config.style,
      started_at: startedAt,
      allowlist: config.allow.emails.length + config.allow.domains.length,
      sessions: liveInstances().length,
      jwks: jwks.status(),
      relays: relay.size,
    };
  }

  // Steps 1–5, shared by HTTP and the upgrade. Resolves
  //   { local: true }                          loopback health probe
  //   { refuse: { status, body, headers? } }   answer with this
  //   { apex: true, email }                    serve the picker
  //   { notFound: id }                         the friendly 404
  //   { session, origin, exp, email }          proxy / relay to session.port
  async function gate(req, { upgrade = false } = {}) {
    const target = parseHost(config, req.headers.host);
    if (!target) {
      return { refuse: { status: 421, body: { ok: false, error: 'host not allowed', host: req.headers.host || null } } };
    }
    if (target.kind === 'local') return { local: true };

    const v = await verifier.verify(tokenFrom(req.headers));
    if (!v.ok) {
      log(`refused ${req.method} ${target.host}${pathnameOf(req.url)}: ${v.reason}`);
      return { refuse: { status: v.status, body: { ok: false, remote: true, error: MESSAGES[v.status] || 'refused' } } };
    }
    if (target.kind === 'apex') {
      if (upgrade) return { refuse: { status: 404, body: { ok: false, error: 'no socket here' } } };
      return { apex: true, email: v.email };
    }

    const session = findSession(target.id);
    if (!session) return { notFound: target.id };

    const verdict = classify(req.method, req.url, { allowDestructive: config.remote.allowDestructive });
    if (!verdict.allow || (upgrade && pathnameOf(req.url) !== '/ws')) {
      return { refuse: { status: 403, body: refusalBody(verdict) } };
    }
    const origin = publicOrigin(sessionHost(config, target.id));
    const csrf = csrfRefusal(req, origin, { upgrade });
    if (csrf) return { refuse: csrf };
    return { session, origin, exp: v.claims.exp, email: v.email };
  }

  async function handle(req, res) {
    const pathname = pathnameOf(req.url);
    const common = securityHeaders(pathname);
    let g;
    try {
      g = await gate(req);
    } catch (e) {
      log(`gate error: ${e && e.message}`);
      g = { refuse: { status: 500, body: { ok: false, error: 'portal error' } } };
    }
    if (g.local) {
      if (req.method === 'GET' && pathname === '/api/health') {
        res.writeHead(200, { ...common, 'content-type': 'application/json' });
        res.end(JSON.stringify(health()));
        return;
      }
      res.writeHead(421, { ...common, 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'the portal serves sessions on its public hostnames only' }));
      return;
    }
    if (g.refuse) {
      res.writeHead(g.refuse.status, { ...common, 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify(g.refuse.body));
      return;
    }
    if (g.apex) {
      await servePicker(req, res, { config, instances: liveInstances, common, probe, email: g.email });
      return;
    }
    if (g.notFound) {
      sessionNotFound(req, res, { config, common, id: g.notFound });
      return;
    }
    await proxyHttp(req, res, { port: g.session.port, origin: req.headers.origin != null, onUpstreamError: forget });
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch(() => { try { res.destroy(); } catch {} });
  });

  server.on('upgrade', (req, socket, head) => {
    socket.on('error', () => {});
    gate(req, { upgrade: true }).then((g) => {
      if (g.local) return refuseUpgrade(socket, 421, { ok: false, error: 'no socket here' }, 'Misdirected Request');
      if (g.refuse) return refuseUpgrade(socket, g.refuse.status, g.refuse.body);
      if (g.notFound) return refuseUpgrade(socket, 404, { ok: false, remote: true, error: 'no web-chat session is running under this name' }, 'Not Found');
      return relay.relay(req, socket, head, { port: g.session.port, expSec: g.exp });
    }).catch(() => refuseUpgrade(socket, 500, { ok: false, error: 'portal error' }));
  });

  let exiting = false;

  async function start() {
    await new Promise((resolve, reject) => {
      const onError = (e) => {
        server.off('error', onError);
        if (e && e.code === 'EADDRINUSE') {
          const err = new Error(`portal port ${port} is in use — set WEB_CHAT_PORTAL_PORT to relocate (and point the tunnel's ingress at it)`);
          err.userFacing = true;
          reject(err);
          return;
        }
        reject(e);
      };
      server.once('error', onError);
      // LOOPBACK, never LISTEN_HOST: WEB_CHAT_HOST relocates the daemons for a
      // deliberate LAN setup, but the portal is reached only by the local
      // cloudflared, and binding it wider would put the JWT check in front of
      // a network the operator did not mean to expose.
      server.listen(port, LOOPBACK, () => { server.off('error', onError); resolve(); });
    });
    registerRole('portal', { pid: process.pid, port: server.address().port });
    // A fixed-rate background refresh is not needed (an unknown kid refetches);
    // warming the key set now turns a Cloudflare outage at boot into a log
    // line instead of a first viewer's 503.
    jwks.refresh().catch((e) => log(`jwks warm-up failed: ${e.message}`));
  }

  function stop() {
    relay.closeAll();
    return new Promise((resolve) => {
      if (!server.listening) { resolve(); return; }
      server.close(() => resolve());
      if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
    });
  }

  function shutdown(code = 0) {
    if (exiting) return;
    exiting = true;
    deregisterRole('portal', { pid: process.pid });
    stop().then(() => process.exit(code));
    setTimeout(() => process.exit(code), 1000).unref();
  }

  function installSignalHandlers() {
    process.on('SIGTERM', () => shutdown(0));
    process.on('SIGINT', () => shutdown(0));
  }

  return { server, start, stop, shutdown, installSignalHandlers, health, port };
}

module.exports = { createPortal, portalPort, csrfRefusal, DEFAULT_PORTAL_PORT };
