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
//   2. The Access JWT (access-jwt.js): 401 / 403 / 503. A client that keeps
//      failing it is answered 429 for a while before any check runs
//      (throttle.js).
//   3. Apex → the picker (picker.js). Session → the registry lookup (memoised
//      for 1s); no such running instance — or one the operator hid
//      (tunnel.json expose.exclude, the project's .web-chat/no-remote) → the
//      friendly 404.
//   4. The remote route policy (lib/core/remote-policy): default deny, 403
//      with a hint naming what to run on the host.
//   5. CSRF. Any Origin present must be exactly the session's public origin; a
//      non-GET/HEAD must carry one; Sec-Fetch-Site cross-site (or same-site —
//      another session, or the picker) is refused except a top-level
//      navigation to `/`.
//   6. Proxy (proxy.js, streamed) or WebSocket relay (ws-relay.js) to
//      127.0.0.1:<port>, Host rewritten, headers allowlisted, X-WC-Remote: 1
//      added so the daemon can tell the page it is being viewed remotely.
//
// Every write and every socket upgrade that got past step 2 — let through or
// refused — is a line in the remote access log (access-log.js).
//
// The portal never spawns a daemon: a session that is not running is a 404,
// not a reason to start one.

const http = require('http');
const { LOOPBACK } = require('../core/cors');
const { PROTOCOL_VERSION, PORTAL_PROTOCOL_VERSION } = require('../core/versions');
const { classify, refusalBody } = require('../core/remote-policy');
const {
  readInstances, sessions: registrySessions, instanceId, registerRole, deregisterRole,
} = require('../util/registry');
const { userPaths } = require('../core/paths');
const { parseHost, sessionHost, publicOrigin, hiddenReason, portalPort } = require('../tunnel/config');
const { createJwksCache } = require('../tunnel/jwks');
const { createVerifier, tokenFrom, MESSAGES } = require('./access-jwt');
const { proxyHttp, securityHeaders, pathnameOf } = require('./proxy');
const { createWsRelay, refuseUpgrade } = require('./ws-relay');
const { servePicker, sessionNotFound } = require('./picker');
const { createAccessLog, isLoggedRequest } = require('./access-log');
const { createThrottle, clientKey } = require('./throttle');

const REGISTRY_MEMO_MS = 1000;

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
  sessions = registrySessions,
  enrich,
  wsGraceMs,
  supervise = null,
  log = () => {},
  accessLog = null,
  throttle = null,
} = {}) {
  if (!config) throw new Error('createPortal: a normalised config is required (lib/tunnel/config normalizeConfig)');
  const jwks = createJwksCache({ team: config.access.team, fetchJwks, now });
  const verifier = createVerifier({ team: config.access.team, aud: config.access.aud, allow: config.allow, jwks, now });
  const relay = createWsRelay({ now, graceMs: wsGraceMs });
  const audit = accessLog || createAccessLog({
    file: userPaths().remoteAccessLog,
    now,
    onError: (e) => log(`remote access log unwritable: ${e.message}`),
  });
  const failures = throttle || createThrottle({ now });
  const startedAt = Date.now();
  // cloudflared's supervisor (lib/tunnel/cloudflared), built by `supervise(port)`
  // once the port is bound — the ingress has to name the port actually held.
  let supervisor = null;

  // The registry, read at most once a second: a page load is dozens of asset
  // requests, and each would otherwise re-read and re-prune the file. The
  // hidden projects are split off in the same pass (the no-remote marker is a
  // stat per project), so everything past here sees only what may be served.
  let memo = { at: -Infinity, list: [], hidden: 0 };
  function refreshMemo() {
    if (Date.now() - memo.at < REGISTRY_MEMO_MS) return;
    const list = [];
    let hidden = 0;
    for (const e of instances()) {
      if (hiddenReason(config, e)) hidden += 1;
      else list.push(e);
    }
    memo = { at: Date.now(), list, hidden };
  }
  function liveInstances() {
    refreshMemo();
    return memo.list;
  }
  function forget() { memo = { at: -Infinity, list: [], hidden: 0 }; }
  // The picker's rows: every project with a surface OR a Claude session
  // (registry sessions()), minus the hidden ones — the same hiddenReason the
  // routing memo applies, asked of the same (id, root) pair. Read per picker
  // request (a page polls every 10s), not memoised.
  function pickerRows() {
    let list = [];
    try { list = sessions(); } catch {}
    return list.filter((r) => r && r.root && !hiddenReason(config, { id: instanceId(r.root), root: r.root }));
  }
  function findSession(id) {
    return liveInstances().find((e) => e && e.id === id && Number.isInteger(e.port)) || null;
  }

  function health() {
    return {
      ok: true,
      role: 'portal',
      version: PROTOCOL_VERSION,
      portal_protocol: PORTAL_PROTOCOL_VERSION,
      pid: process.pid,
      port: server.listening ? server.address().port : port,
      hostname: config.hostname,
      style: config.style,
      started_at: startedAt,
      allowlist: config.allow.emails.length + config.allow.domains.length,
      sessions: liveInstances().length,
      hidden: memo.hidden,
      throttled: failures.blockedCount(),
      jwks: jwks.status(),
      relays: relay.size,
      cloudflared: supervisor ? supervisor.status() : null,
    };
  }

  // Steps 1–5, shared by HTTP and the upgrade. Resolves
  //   { local: true }                          loopback health probe
  //   { refuse: { status, body, headers? } }   answer with this
  //   { apex: true, email }                    serve the picker
  //   { notFound: id }                         the friendly 404
  //   { session, origin, exp, email }          proxy / relay to session.port
  // Past the sign-in check every result also carries `email` and, on a session
  // hostname, `id` — what the access log records.
  async function gate(req, { upgrade = false } = {}) {
    const target = parseHost(config, req.headers.host);
    if (!target) {
      return { refuse: { status: 421, body: { ok: false, error: 'host not allowed', host: req.headers.host || null } } };
    }
    if (target.kind === 'local') return { local: true };

    const who = clientKey(req);
    const wait = failures.retryAfter(who);
    if (wait) {
      return { refuse: {
        status: 429,
        headers: { 'retry-after': String(wait) },
        body: { ok: false, remote: true, error: 'too many failed sign-ins from this address — wait and try again' },
      } };
    }
    const v = await verifier.verify(tokenFrom(req.headers));
    if (!v.ok) {
      log(`refused ${req.method} ${target.host}${pathnameOf(req.url)}: ${v.reason}`);
      if (v.status === 401 && failures.fail(who)) log(`throttling ${who}: repeated failed sign-ins`);
      return { refuse: { status: v.status, body: { ok: false, remote: true, error: MESSAGES[v.status] || 'refused' } } };
    }
    const email = v.email;
    if (target.kind === 'apex') {
      if (upgrade) return { email, refuse: { status: 404, body: { ok: false, error: 'no socket here' } } };
      return { apex: true, email };
    }

    const id = target.id;
    const session = findSession(id);
    if (!session) return { notFound: id, email, id };

    const verdict = classify(req.method, req.url, { allowDestructive: config.remote.allowDestructive });
    if (!verdict.allow || (upgrade && pathnameOf(req.url) !== '/ws')) {
      return { email, id, refuse: { status: 403, body: refusalBody(verdict) } };
    }
    const origin = publicOrigin(sessionHost(config, id));
    const csrf = csrfRefusal(req, origin, { upgrade });
    if (csrf) return { email, id, refuse: csrf };
    return { session, origin, exp: v.claims.exp, email, id };
  }

  // One access-log line, for a write or upgrade that got past the sign-in.
  function audited(req, g, status, { upgrade = false } = {}) {
    if (!g || !g.email || !g.id || !isLoggedRequest(req.method, { upgrade })) return;
    audit.record({ email: g.email, instance: g.id, method: upgrade ? 'WS' : req.method, path: req.url, status });
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
    // Logged once the answer is on its way — proxied, refused or 404 alike —
    // with the status the viewer actually got (a connection that died before
    // any headers went out reads as 0).
    res.once('close', () => audited(req, g, res.headersSent ? res.statusCode : 0));
    if (g.refuse) {
      res.writeHead(g.refuse.status, { ...common, ...(g.refuse.headers || {}), 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify(g.refuse.body));
      return;
    }
    if (g.apex) {
      await servePicker(req, res, { config, rows: pickerRows, enrich, common, email: g.email });
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
      const done = (status) => audited(req, g, status, { upgrade: true });
      if (g.local) return refuseUpgrade(socket, 421, { ok: false, error: 'no socket here' }, 'Misdirected Request');
      if (g.refuse) { done(g.refuse.status); return refuseUpgrade(socket, g.refuse.status, g.refuse.body); }
      if (g.notFound) { done(404); return refuseUpgrade(socket, 404, { ok: false, remote: true, error: 'no web-chat session is running under this name' }, 'Not Found'); }
      return relay.relay(req, socket, head, { port: g.session.port, expSec: g.exp, onStatus: done });
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
    // The connector starts only once there is something for it to dial.
    if (supervise) {
      supervisor = supervise(server.address().port);
      supervisor.start();
    }
    // A fixed-rate background refresh is not needed (an unknown kid refetches);
    // warming the key set now turns a Cloudflare outage at boot into a log
    // line instead of a first viewer's 503.
    jwks.refresh().catch((e) => log(`jwks warm-up failed: ${e.message}`));
  }

  function stop() {
    relay.closeAll();
    // The tunnel goes first: a connector left running with no portal behind it
    // would answer every visitor with a 502 for as long as it lived.
    const connector = supervisor ? supervisor.stop() : Promise.resolve();
    const listener = new Promise((resolve) => {
      if (!server.listening) { resolve(); return; }
      server.close(() => resolve());
      if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
    });
    return Promise.all([connector, listener]).then(() => {});
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

module.exports = { createPortal, csrfRefusal };
