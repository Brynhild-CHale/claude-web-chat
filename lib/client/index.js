// The one way to talk to a running web-chat daemon. Promoted from the best of the
// scattered HTTP clients (lib/mcp/client.js) and given the three things the others
// had that it lacked: opt-in per-request timeout + headers, an exported low-level
// non-throwing request(), and the SSE subscriber (from lib/driver.js). The
// liveness probes are re-exported from lib/core/portfiles (they can't live here —
// core must not import the client).
//
// Two policies preserved from the copies it replaces:
//   * spawn defaults FALSE — driver/hub/cli must never resurrect a closed daemon;
//     only the lib/mcp/client shim opts in (spawn:true) to keep auto-spawn for
//     the 23 tools + hooks. opts.noSpawn always wins.
//   * NO default socket timeout — a driver's /api/wait long-poll (lib/driver.js
//     waitFor) runs for up to timeout_ms; a blanket socket timeout would break it.
//     timeout is opt-in. (Claude no longer long-polls: channels-only wake —
//     /api/wait is now a driver-only endpoint.)
//
// The outcome contract, which every caller may rely on:
//   * get/post resolve with the parsed body, or throw. A non-2xx is an
//     HttpError carrying {status, body} — branch on it, don't parse the message.
//   * a socket that dies is ALWAYS a rejection, including a response cut off
//     mid-body (ECONNRESET, so api()'s respawn path picks it up). Nothing hangs.
//   * request() is the low-level escape hatch for the handful of callers that
//     RELAY a status rather than act on it (the hub's forward, the export CLI).
//     It still never throws on a status — but it, too, rejects on a dead socket.

const http = require('http');
const portfiles = require('../core/portfiles');
const { findProjectRoot } = require('../core/paths');
const { spawnDaemon } = require('../util/daemon');
const { LOOPBACK } = require('../core/cors');

class NoServerError extends Error {
  constructor(hint) {
    super(hint || 'web-chat server is not running and could not be auto-started — try `claude-web-chat doctor`');
    this.code = 'NO_SERVER';
  }
}

// explicit port -> WEB_CHAT_PORT (opt-in) -> portfile. env defaults true here
// because the client's callers (mcp tools, driver) honor WEB_CHAT_PORT today; the
// CLI's own no-env discovery uses portfiles.readPortfile directly.
function discoverPort({ port, root, env = true } = {}) {
  return portfiles.discoverPort({ role: 'server', port, root, env });
}

// Auto-spawn the daemon, memoizing only the IN-FLIGHT spawn: a burst of
// concurrent callers all await the same one, but the settled result is never
// cached. Caching it would wedge the process forever once the daemon dies (the
// respawn-and-retry in api() would keep getting the same dead port back) and
// would let one failed spawn poison every later call. spawnDaemon is itself
// idempotent — it re-reads the portfile and probes before forking — so a repeat
// call while a daemon is up is a cheap no-op.
let spawnPromise = null;
function ensureDaemon(root) {
  if (!spawnPromise) {
    const r = root || findProjectRoot(process.cwd()) || process.cwd();
    const p = spawnDaemon(r).then((info) => (info ? info.port : null));
    spawnPromise = p;
    const clear = () => { if (spawnPromise === p) spawnPromise = null; };
    p.then(clear, clear);
  }
  return spawnPromise;
}

// A non-2xx answer from the daemon, as a TYPED error. `get`/`post` used to throw
// a bare Error whose only content was a formatted message, so a caller that
// wanted to branch on "404 means unknown ref" had no way to ask — the two
// documented outcomes (a 404 body vs. a dead socket) were indistinguishable, and
// call sites guessed in both directions (profile reload printed success on a 404,
// the export tool carried an unreachable `r.error` branch). The message is
// byte-identical to what it replaced; `status` and `body` are the new part.
class HttpError extends Error {
  constructor(status, body, method, pathStr) {
    const errBody = typeof body === 'string' ? body : JSON.stringify(body);
    super(`${method} ${pathStr} → ${status}: ${errBody}`);
    this.name = 'HttpError';
    this.status = status;
    this.body = body;
    this.method = method;
    this.path = pathStr;
  }
}

// Low-level JSON request. Never throws on an HTTP status (returns {status,body});
// rejects only on a socket error/timeout — INCLUDING a response that never
// completes. Timeout is opt-in (no default).
function request(port, method, pathStr, body, { headers, timeout } = {}) {
  return new Promise((resolve, reject) => {
    const data = body != null ? (typeof body === 'string' ? body : JSON.stringify(body)) : null;
    const h = {
      ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}),
      ...(headers || {}),
    };
    const opts = { hostname: LOOPBACK, port, path: pathStr, method, headers: h };
    if (timeout != null) opts.timeout = timeout;
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };
    const fail = (e) => { if (!settled) { settled = true; reject(e); } };
    const req = http.request(opts, (res) => {
      let chunks = '';
      res.on('data', (c) => { chunks += c; });
      res.on('end', () => {
        let parsed = null;
        try { parsed = chunks ? JSON.parse(chunks) : null; } catch { parsed = chunks; }
        done({ status: res.statusCode, body: parsed });
      });
      // The promise used to settle ONLY on 'end'. A daemon that dies, restarts or
      // resets the socket after the headers but before the body completes tears
      // the response down with an error and a 'close' carrying
      // res.complete === false — and Node routes that error to the RESPONSE, for
      // which there was no listener here, so neither settle path ran. Verified:
      // against the old code a server that wrote a partial body and destroyed the
      // socket left `request()` pending forever, and because this module
      // deliberately has no default socket timeout, every MCP tool call, hook and
      // CLI command behind api() hung with it.
      //
      // ECONNRESET is the deliberate code: isConnRefused() folds it into api()'s
      // respawn-and-retry, so a mid-response death behaves like a refused
      // connection rather than as a novel error class every caller must learn.
      // Node's own message for it is the bare word "aborted", which names neither
      // the call nor the cause, so both paths report ours.
      const cutOff = () => {
        const e = new Error(`${method} ${pathStr} → connection closed before the response completed`);
        e.code = 'ECONNRESET';
        return e;
      };
      res.on('error', (e) => fail(res.complete ? e : cutOff()));
      res.on('close', () => { if (!res.complete) fail(cutOff()); });
    });
    req.on('error', fail);
    // Settle with the timeout error HERE rather than leaving it to req.destroy's
    // 'error': destroying the request also closes an in-flight response, and the
    // 'close' handler above would otherwise race it and win with ECONNRESET —
    // which lib/hub's forward() maps to 502 instead of the 504 it owes a slow
    // instance.
    if (timeout != null) {
      req.on('timeout', () => {
        const e = new Error('request timeout');
        req.destroy(e);
        fail(e);
      });
    }
    if (data) req.write(data);
    req.end();
  });
}

function isConnRefused(e) {
  return e && (e.code === 'ECONNREFUSED' || e.code === 'ECONNRESET');
}

function checkStatus(r, method, pathStr) {
  if (r.status >= 400) throw new HttpError(r.status, r.body, method, pathStr);
  return r.body;
}

// High-level: discover -> (optionally spawn) -> request -> throw on >=400, with a
// single respawn+retry on connection-refused. opts: {port, root, spawn, noSpawn,
// headers, timeout, hint}.
async function api(method, pathStr, body, opts = {}) {
  const doSpawn = opts.spawn === true && opts.noSpawn !== true;
  let port = opts.port || discoverPort({ root: opts.root });
  if (!port) {
    if (!doSpawn) throw new NoServerError(opts.hint);
    port = await ensureDaemon(opts.root);
    if (!port) throw new NoServerError(opts.hint);
  }
  try {
    return checkStatus(await request(port, method, pathStr, body, opts), method, pathStr);
  } catch (e) {
    if (!isConnRefused(e)) throw e;
    if (!doSpawn) throw new NoServerError(opts.hint);
    // The discovered port refused — the daemon likely died. Respawn once, retry.
    const fresh = await ensureDaemon(opts.root);
    if (!fresh) throw new NoServerError(opts.hint);
    try {
      return checkStatus(await request(fresh, method, pathStr, body, opts), method, pathStr);
    } catch (e2) {
      if (isConnRefused(e2)) throw new NoServerError(opts.hint);
      throw e2;
    }
  }
}

// Subscribe to the live SSE event stream. Lifted verbatim from the driver's
// streamEvents — a long-lived stream must NOT be routed through request() (which
// buffers to end). Returns a handle with .close(). Opts: {port, root, since,
// kinds, onOpen, onEvent, onGap, onClose, onError}. onOpen fires once the stream
// returns HTTP 200 (a live-connection signal a consumer can use to reset backoff
// or to know the subscription is established).
function subscribeSSE({ port, root, since, kinds, onOpen, onEvent, onGap, onClose, onError } = {}) {
  const resolvedPort = port || discoverPort({ root });
  let endNotified = false;
  const notifyClose = () => { if (!endNotified) { endNotified = true; if (onClose) onClose(); } };
  if (!resolvedPort) {
    if (onError) onError(new NoServerError());
    notifyClose();
    return { close() {} };
  }
  const params = [];
  if (since != null) params.push(`since=${encodeURIComponent(since)}`);
  if (Array.isArray(kinds) && kinds.length) params.push(`kinds=${encodeURIComponent(kinds.join(','))}`);
  const pathStr = `/api/events/stream${params.length ? `?${params.join('&')}` : ''}`;
  let manuallyClosed = false;

  const req = http.request({
    hostname: LOOPBACK, port: resolvedPort, path: pathStr, method: 'GET',
    headers: { Accept: 'text/event-stream' },
  }, (res) => {
    if (res.statusCode !== 200) {
      res.resume();
      if (onError) onError(new Error(`stream failed: HTTP ${res.statusCode}`));
      notifyClose();
      return;
    }
    if (onOpen) { try { onOpen(); } catch {} }
    res.setEncoding('utf8');
    let buf = '';
    res.on('data', (chunk) => {
      buf += chunk;
      let m;
      while ((m = buf.match(/\r?\n\r?\n/))) {
        const frame = buf.slice(0, m.index);
        buf = buf.slice(m.index + m[0].length);
        let event = 'message';
        const data = [];
        for (const line of frame.split(/\r?\n/)) {
          if (line.startsWith(':') || line === '') continue;
          if (line.startsWith('event:')) event = line.slice(6).trim();
          else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
        }
        if (!data.length) continue;
        let payload;
        try { payload = JSON.parse(data.join('\n')); } catch { continue; }
        if (event === 'gap') { if (onGap) onGap(payload); }
        else if (onEvent) onEvent(payload);
      }
    });
    res.on('error', (e) => { if (onError && !manuallyClosed) onError(e); notifyClose(); });
    res.on('end', notifyClose);
    res.on('close', notifyClose);
  });
  req.on('error', (e) => { if (onError && !manuallyClosed) onError(e); notifyClose(); });
  req.end();
  return { close: () => { manuallyClosed = true; try { req.destroy(); } catch {} notifyClose(); } };
}

module.exports = {
  NoServerError,
  HttpError,
  discoverPort,
  ensureDaemon,
  request,
  api,
  get: (p, opts) => api('GET', p, null, opts),
  post: (p, body, opts) => api('POST', p, body, opts),
  probeReachable: portfiles.probeReachable,
  probeHealth: portfiles.probeHealth,
  subscribeSSE,
};
