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

const http = require('http');
const portfiles = require('../core/portfiles');
const { findProjectRoot } = require('../core/paths');
const { spawnDaemon } = require('../util/daemon');

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

// Auto-spawn the daemon at most once per process (memoized so a burst of
// concurrent callers all await the same spawn, and a flapping server never forks
// a daemon per request).
let spawnPromise = null;
function ensureDaemon(root) {
  if (!spawnPromise) {
    const r = root || findProjectRoot(process.cwd()) || process.cwd();
    spawnPromise = spawnDaemon(r).then((info) => (info ? info.port : null));
  }
  return spawnPromise;
}

// Low-level JSON request. Never throws on an HTTP status (returns {status,body});
// rejects only on a socket error/timeout. Timeout is opt-in (no default).
function request(port, method, pathStr, body, { headers, timeout } = {}) {
  return new Promise((resolve, reject) => {
    const data = body != null ? (typeof body === 'string' ? body : JSON.stringify(body)) : null;
    const h = {
      ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}),
      ...(headers || {}),
    };
    const opts = { hostname: 'localhost', port, path: pathStr, method, headers: h };
    if (timeout != null) opts.timeout = timeout;
    const req = http.request(opts, (res) => {
      let chunks = '';
      res.on('data', (c) => { chunks += c; });
      res.on('end', () => {
        let parsed = null;
        try { parsed = chunks ? JSON.parse(chunks) : null; } catch { parsed = chunks; }
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    req.on('error', reject);
    if (timeout != null) req.on('timeout', () => { req.destroy(new Error('request timeout')); });
    if (data) req.write(data);
    req.end();
  });
}

function isConnRefused(e) {
  return e && (e.code === 'ECONNREFUSED' || e.code === 'ECONNRESET');
}

function checkStatus(r, method, pathStr) {
  if (r.status >= 400) {
    const errBody = typeof r.body === 'string' ? r.body : JSON.stringify(r.body);
    throw new Error(`${method} ${pathStr} → ${r.status}: ${errBody}`);
  }
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
    hostname: 'localhost', port: resolvedPort, path: pathStr, method: 'GET',
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
