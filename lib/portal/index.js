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
//      While tunnel.json is invalid (below) everything else is 503 here.
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
// A relay outlives its handshake, so while any is open the portal re-asks
// steps 2–3 every REGISTRY_MEMO_MS and closes (4403) each relay whose account
// is no longer allowlisted or whose project was hidden or stopped since — the
// no-remote marker or a revoked email cuts a viewer who is already on the
// surface, not only the next one.
//
// Every write and every socket upgrade that got past step 2 — let through or
// refused — is a line in the remote access log (access-log.js).
//
// tunnel.json is LIVE (given `configFile`; config-watch.js notices an edit
// within a poll, usually at once). A valid edit applies on the spot: the
// allowlist, the Access team/AUD, expose.exclude, remote.allowDestructive and
// showRoots — and within a second (the relay sweep below) every open relay
// whose account left the allowlist or whose project is now hidden is cut
// (4403). What names the hostnames cloudflared
// routes — hostname, style, the tunnel section — is NOT hot-applied (the
// connector and its ingress would have to be rebuilt mid-flight): the portal
// keeps the ones it started with, logs "restart needed", and health reports
// them, which `tunnel status` turns into "run `tunnel up`". A file that is
// missing, unreadable or invalid makes the portal FAIL CLOSED — every request
// but its own loopback health is 503 and every relay is cut (4503) — until
// the file is valid again; it is never read as "keep the last good one".
//
// The connector token file (given `tokenFile`, for a token-kind tunnel) is
// watched the same way, but never applied: the token is cloudflared's
// credential, handed over at its launch. A token that differs from the one the
// portal started with (a new one from `tunnel setup`, or the file removed) is
// logged and reported on health as `token.state: 'restart-needed'` — `tunnel
// status` says "restart needed (connector token changed)" and `tunnel up`,
// comparing `token.fp` with the file itself, restarts the portal.
//
// A session that is not running is a 404, not a reason to start one: routing
// never spawns a daemon. The one thing that does is the picker's explicit
// start (start.js) — POST /api/sessions/<id>/start on the APEX, for a project
// already known on this machine, looked up by id (never a path), never a hidden
// one, rate-limited, under the apex's exact Origin, and in the access log.

const http = require('http');
const { LOOPBACK } = require('../core/cors');
const { PROTOCOL_VERSION, PORTAL_PROTOCOL_VERSION } = require('../core/versions');
const { classify, refusalBody } = require('../core/remote-policy');
const {
  readInstances, sessions: registrySessions, instanceId, registerRole, deregisterRole,
} = require('../util/registry');
const { userPaths } = require('../core/paths');
const {
  parseHost, sessionHost, publicOrigin, hiddenReason, portalPort, configFingerprint, loadConfig,
} = require('../tunnel/config');
const { createJwksCache } = require('../tunnel/jwks');
const { createVerifier, tokenFrom, emailAllowed, MESSAGES } = require('./access-jwt');
const { proxyHttp, securityHeaders, pathnameOf } = require('./proxy');
const { createWsRelay, refuseUpgrade, CLOSE_UNAVAILABLE } = require('./ws-relay');
const { watchConfigFile } = require('./config-watch');
const { readToken, tokenFingerprint } = require('../tunnel/cloudflared');
const { servePicker, sessionNotFound } = require('./picker');
const { createAccessLog, isLoggedRequest } = require('./access-log');
const { createThrottle, clientKey } = require('./throttle');
const { createStarter, startTarget } = require('./start');

const REGISTRY_MEMO_MS = 1000;
// The sections that name what cloudflared routes. A change to one needs a new
// connector, so the running portal keeps the values it started with.
const RESTART_FIELDS = ['hostname', 'style', 'tunnel'];

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

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
  config: initialConfig,
  configFile = null,
  tokenFile = null,
  configPollMs,
  configDebounceMs,
  fetchJwks,
  now = Date.now,
  instances = readInstances,
  sessions = registrySessions,
  enrich,
  wsGraceMs,
  sweepMs = REGISTRY_MEMO_MS,
  supervise = null,
  log = () => {},
  accessLog = null,
  throttle = null,
  spawnDaemon = null,
} = {}) {
  if (!initialConfig) throw new Error('createPortal: a normalised config is required (lib/tunnel/config normalizeConfig)');
  // What is in force. Replaced whole by reloadConfig; everything reads it at
  // the moment it needs it, never a copy taken at start.
  let config = initialConfig;
  let jwks = createJwksCache({ team: config.access.team, fetchJwks, now });
  const buildVerifier = () => createVerifier({ team: config.access.team, aud: config.access.aud, allow: config.allow, jwks, now });
  let verifier = buildVerifier();
  // tunnel.json as the running portal sees it: 'ok', 'restart-needed' (the
  // file names hostnames this process is not routing — `restart` lists the
  // sections), or 'invalid' (failing closed; `error` says why).
  let configState = { state: 'ok', error: null, restart: [], reloaded_at: null };
  let watcher = null;
  // The connector token: followed only for a token-kind tunnel (a local one
  // runs on its credentials file). `tokenFp` is the token cloudflared was
  // handed — read here, at the portal's start, as the supervisor reads it.
  const followToken = Boolean(tokenFile && initialConfig.tunnel && initialConfig.tunnel.kind === 'token');
  const tokenFp = followToken ? tokenFingerprint(readToken(tokenFile)) : null;
  let tokenState = { state: 'ok', changed_at: null };
  let tokenWatcher = null;
  const relay = createWsRelay({ now, graceMs: wsGraceMs });
  const audit = accessLog || createAccessLog({
    file: userPaths().remoteAccessLog,
    now,
    onError: (e) => log(`remote access log unwritable: ${e.message}`),
  });
  const failures = throttle || createThrottle({ now });
  const starter = createStarter({ spawn: spawnDaemon, now, log });
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
  // The start route's view of the registry: every row, inactive ones included
  // (the start looks its id up among the KNOWN ones and asks hiddenReason
  // itself).
  function allRows() {
    try { return sessions() || []; } catch { return []; }
  }
  function findSession(id) {
    return liveInstances().find((e) => e && e.id === id && Number.isInteger(e.port)) || null;
  }

  // Steps 2–3 again, for the relays already open: runs only while there is
  // one, and closes each the config in force would now refuse — its account
  // taken off the allowlist by a reload, or its project hidden or stopped.
  let sweeper = null;
  function sweep() {
    if (relay.size === 0) { clearInterval(sweeper); sweeper = null; return; }
    const revoked = relay.closeWhere((_id, pair) => !emailAllowed(pair.email, config.allow),
      undefined, 'this account is no longer allowed to reach this machine');
    if (revoked) log(`closed ${revoked} relay(s) for an account no longer on the allowlist`);
    const n = relay.closeWhere((id) => !findSession(id));
    if (n) log(`closed ${n} relay(s) into a session that is hidden or gone`);
  }

  // Re-read tunnel.json (config-watch calls this when its bytes change) and
  // bring what is in force in line with it — see the head of this file.
  function reloadConfig() {
    let next = null;
    let error = null;
    try { next = loadConfig(configFile); } catch (e) { error = e.message; }
    if (error) {
      const was = configState;
      configState = { ...was, state: 'invalid', error, reloaded_at: Date.now() };
      if (was.state !== 'invalid' || was.error !== error) {
        log(`FAILING CLOSED — ${error}. Every remote request is refused (503) until tunnel.json is valid again.`);
      }
      const n = relay.closeWhere(() => true, CLOSE_UNAVAILABLE, 'the portal\'s configuration is invalid');
      if (n) log(`closed ${n} relay(s): failing closed`);
      return;
    }
    const restart = RESTART_FIELDS.filter((k) => !same(next[k], initialConfig[k]));
    // The file's config with the connector's sections kept as started. Spread,
    // then overwritten in place, so the key order — and so the fingerprint —
    // matches normalizeConfig's when nothing needs a restart.
    const effective = { ...next };
    for (const k of RESTART_FIELDS) effective[k] = initialConfig[k];
    const wasInvalid = configState.state === 'invalid';
    const changed = configFingerprint(effective) !== configFingerprint(config);
    if (changed) {
      if (effective.access.team !== config.access.team) {
        jwks = createJwksCache({ team: effective.access.team, fetchJwks, now });
        jwks.refresh().catch((e) => log(`jwks warm-up failed: ${e.message}`));
      }
      config = effective;
      verifier = buildVerifier();
      forget();
    }
    const newlyRestart = restart.filter((k) => !configState.restart.includes(k));
    configState = { state: restart.length ? 'restart-needed' : 'ok', error: null, restart, reloaded_at: Date.now() };
    if (wasInvalid) log('tunnel.json is valid again — serving');
    if (changed) log('tunnel.json reloaded — its allowlist, Access check, hidden projects and remote settings are in force');
    if (newlyRestart.length) {
      log(`tunnel.json changed ${newlyRestart.join(', ')} — restart needed: this portal still routes the hostnames it started with; run \`claude-web-chat tunnel up\``);
    }
  }
  // The token file's bytes changed (tokenWatcher calls this; the first call, at
  // the start, finds the token the portal started with). Reported, never
  // applied — see the head of this file.
  function checkToken() {
    const changed = tokenFingerprint(readToken(tokenFile)) !== tokenFp;
    if (changed && tokenState.state !== 'restart-needed') {
      log('the connector token changed — restart needed: cloudflared still runs on the token it started with; run `claude-web-chat tunnel up`');
    } else if (!changed && tokenState.state === 'restart-needed') {
      log('the connector token is back to the one cloudflared runs on — no restart needed');
    }
    tokenState = changed ? { state: 'restart-needed', changed_at: tokenState.changed_at || Date.now() } : { state: 'ok', changed_at: null };
  }
  function armSweep() {
    if (sweeper) return;
    sweeper = setInterval(sweep, sweepMs);
    sweeper.unref();
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
      // What this portal enforces (lib/tunnel/config configFingerprint) — the
      // file itself once a reload has applied it, unless a section that needs
      // a restart changed. `tunnel up|status` compare it with the file now.
      config_fp: configFingerprint(config),
      // `live`: this portal is following the file (`portal run` always is).
      config: { ...configState, restart: [...configState.restart], live: Boolean(watcher) },
      // The connector token cloudflared was started with (`fp`, a hash — see
      // tokenFingerprint) and whether the file still holds it. Null for a
      // portal not following one (a local tunnel, or none).
      token: followToken ? { ...tokenState, fp: tokenFp, live: Boolean(tokenWatcher) } : null,
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
    if (target && target.kind === 'local') return { local: true };
    if (configState.state === 'invalid') {
      return { refuse: { status: 503, body: { ok: false, remote: true, error: 'this portal\'s configuration is invalid, so it refuses every request until tunnel.json is fixed on the host' } } };
    }
    if (!target) {
      return { refuse: { status: 421, body: { ok: false, error: 'host not allowed', host: req.headers.host || null } } };
    }

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
      // The picker's one write: start a known project. Carries the id it names
      // (so the access log records it) and the apex's own CSRF rule.
      const startId = startTarget(req.method, pathnameOf(req.url));
      if (startId != null) {
        const csrf = csrfRefusal(req, publicOrigin(config.hostname));
        if (csrf) return { email, id: startId, refuse: csrf };
        return { apex: true, email, id: startId, start: startId };
      }
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
    if (g.start) {
      const out = await starter.start(g.start, { config, rows: allRows, running: findSession, forget, email: g.email });
      res.writeHead(out.status, { ...common, ...(out.headers || {}), 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify(out.body));
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
      return relay.relay(req, socket, head, {
        port: g.session.port,
        id: g.id,
        email: g.email,
        expSec: g.exp,
        onStatus: (code) => { if (code === 101) armSweep(); done(code); },
      });
    }).catch(() => refuseUpgrade(socket, 500, { ok: false, error: 'portal error' }));
  });

  // Start following `configFile` and the connector token (each a no-op
  // without one, or when already watching). start() calls it; a test that
  // binds the server itself does too.
  function watchConfig() {
    if (configFile && !watcher) {
      watcher = watchConfigFile(configFile, reloadConfig, { pollMs: configPollMs, debounceMs: configDebounceMs, log });
    }
    if (followToken && !tokenWatcher) {
      tokenWatcher = watchConfigFile(tokenFile, checkToken, {
        pollMs: configPollMs, debounceMs: configDebounceMs, log, label: 'connector token check',
      });
    }
  }

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
    watchConfig();
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
    if (watcher) { watcher.stop(); watcher = null; }
    if (tokenWatcher) { tokenWatcher.stop(); tokenWatcher = null; }
    if (sweeper) { clearInterval(sweeper); sweeper = null; }
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

  return { server, start, stop, shutdown, installSignalHandlers, health, watchConfig, port };
}

module.exports = { createPortal, csrfRefusal };
