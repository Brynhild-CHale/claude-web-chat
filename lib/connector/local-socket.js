// The connector's one local socket (tranche 6, U731; contract 05 C-05.47 and
// C-05.26a as A-05.3 amends them; 06 C-06.26a, ruled SW3): the seam through
// which this machine's CLI (`connect ls|open|shell|code`, and U727's
// `connect disconnect` asking connector.release-all) reaches the running
// connector, holding no credential of its own.
//
// THE SOCKET. `~/.web-chat/connector/<hub-id>.sock` (lib/core/paths userPaths
// connectorSocket), a Unix domain socket, mode 0600, in the 0700 connector
// directory owned by this user. The 0700 directory is the guard (C-05.47): the
// directory is refused, never repaired, when its mode or owner is not that. It
// is never a TCP or UDP socket, never a port and never a Linux abstract name:
// the server is bound to a filesystem path and nothing else. This is the ONLY
// listening socket the connector opens (the conventions ratchet counts the
// server-creating and binding calls under lib/connector and allows the two
// below, here alone).
//
//   * The path must fit the platform's sun_path (SUN_PATH_MAX: 104 bytes with
//     its NUL on macOS, 108 on Linux; C-06.26a's arithmetic). A longer path is
//     refused before anything is created, naming its length and the limit.
//   * A socket file already there is probed: no answer (ECONNREFUSED, ENOENT)
//     makes it stale and it is removed; an answer means another connector holds
//     it, and this one refuses to start. Anything at the path that is not a
//     socket (a file, a symlink) is refused, never removed.
//   * Removed at stop when it is still the file this process bound.
//
// THE PROTOCOL. One request per connection: one line of JSON, at most
// MAX_REQUEST_BYTES, `{type, params}` with `params` an object; one line of
// JSON back, then the connection closes.
//
//   * HUB_REQUEST_TYPES — ListMachines, ListChats, GetChatAttach: THE closed
//     list (C-05.26a; V15@no-preempt: a later locked amendment adds a row here,
//     and nowhere else). Forwarded as one `control` hub.request carrying
//     `{request: {type, params}}` whole (link.request, 30 s); the hub.response's
//     `response` is written back AS RECEIVED. Nothing is cached, kept or run;
//     pause does not withhold these reads (C-05.27). A hub.response whose `re`
//     names no open request is the link's own `not_allowed` (U716).
//   * LOCAL_REQUEST_TYPES — connector.release-all and connector.leave (U716b:
//     link.leave(), the machine.leave frame `connect disconnect` asks for
//     first): a SEPARATE table, never a
//     hub.request type and never forwarded (U727-U731@via-connector-socket-op,
//     ruled (a)). Answered in this process, with the link up or down, by
//     ctx.releaseAll() (U790 wires the lifecycle/supervisor's release of every
//     hold and stop of every daemon the connector started or owns).
//   * Anything else — a type in neither table, `params` not an object — is
//     answered here `{ok: false, local: true, error: 'only ListMachines,
//     ListChats and GetChatAttach'}` and nothing is sent: a fourth type on the
//     link would fail 05-hub-request.json and close it fatally (A-05.3).
//   * The link not up → `{ok: false, local: true, error: 'the connector is not
//     connected to the hub'}`.
//
// A local answer always carries `local: true`, so the CLI can tell the
// connector's own refusal from the hub's (10's `{ok, type, request_id, …}`).
// No credential crosses the socket: the CLI never sees the key or a session.
//
//   install(ctx, opts) → Promise<stop()>     (CONNECTOR@install-seam; U790 wires it)
//     ctx.link (U716's link: state, request), ctx.releaseAll, ctx.log; the
//     socket's path from opts.path, else ctx.socketPath, else
//     (ctx.paths || userPaths()).connectorSocket(ctx.hubId || ctx.record.hub.id).
//     Rejects with a coded error (ESOCKETPATH, ESOCKETDIR, ESOCKETBUSY) after
//     logging the code. Sets ctx.localSocket = { path, stop }.
//
//   askConnector({path, request, timeoutMs}) → Promise<the answer object>
//     The CLI's half. No connector answering → an error (code ENOCONNECTOR)
//     whose message names `claude-web-chat connect status` and the hub page's
//     Copy commands; the CLI prints it and exits non-zero (C-06.26a).

const fs = require('fs');
const net = require('net');
const path = require('path');
const { userPaths } = require('../core/paths');
const setup = require('../setup/connector');

const HUB_REQUEST_TYPES = Object.freeze(['ListMachines', 'ListChats', 'GetChatAttach']);
const LOCAL_REQUEST_TYPES = Object.freeze(['connector.release-all', 'connector.leave']);

const MAX_REQUEST_BYTES = 64 * 1024;
const MAX_ANSWER_BYTES = 2 * 1024 * 1024;   // a hub.response is one frame, at most 1 MiB
const HUB_TIMEOUT_MS = 30 * 1000;
const ASK_TIMEOUT_MS = HUB_TIMEOUT_MS + 5 * 1000;
const READ_TIMEOUT_MS = 10 * 1000;          // a connection that never sends its line
const PROBE_TIMEOUT_MS = 2 * 1000;
const MAX_CONNECTIONS = 16;
const SUN_PATH_MAX = Object.freeze({ darwin: 104, linux: 108 });
const DIR_MODE = 0o700;
const SOCKET_MODE = 0o600;

const ONLY_THREE = 'only ListMachines, ListChats and GetChatAttach';
const NOT_CONNECTED = 'the connector is not connected to the hub';
const NO_CONNECTOR = 'no connector is answering on this machine: run `claude-web-chat connect status`, '
  + 'or use the Copy commands on the hub\'s page';

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function socketError(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}

// The platform's sun_path size, NUL included (104 for any platform not named:
// the BSDs' size, the smaller of the two).
function sunPathMax(platform = process.platform) {
  return SUN_PATH_MAX[platform] || SUN_PATH_MAX.darwin;
}

// null when `file` fits, else the refusal's message.
function pathTooLong(file, platform = process.platform) {
  const bytes = Buffer.byteLength(file);
  const max = sunPathMax(platform);
  if (bytes + 1 <= max) return null;
  return `the connector's socket path is ${bytes} bytes and ${platform} allows ${max - 1} `
    + `(sun_path is ${max} with its NUL): ${file}; use a shorter home directory or hub id`;
}

// ── the server half ────────────────────────────────────────────────────────

function socketPathOf(ctx, opts) {
  if (typeof opts.path === 'string') return opts.path;
  if (typeof ctx.socketPath === 'string') return ctx.socketPath;
  const hubId = ctx.hubId || (ctx.record && ctx.record.hub && ctx.record.hub.id);
  const p = (ctx.paths && typeof ctx.paths.connectorSocket === 'function' ? ctx.paths : userPaths()).connectorSocket(hubId);
  if (!p) throw socketError('ESOCKETPATH', 'the connector\'s socket needs a hub id');
  return p;
}

// The directory must be a real directory, 0700, owned by this user. An absent
// one is made through lib/setup/connector (0700); a present one is never
// repaired: a wider mode is a refusal (C-05.47's guard).
function checkDirectory(dir, { ensureDir }) {
  let st;
  try { st = fs.lstatSync(dir); } catch (e) {
    if (e.code !== 'ENOENT') throw socketError('ESOCKETDIR', `the connector directory cannot be read: ${dir}`);
    ensureDir();
    st = fs.lstatSync(dir);
  }
  if (!st.isDirectory()) throw socketError('ESOCKETDIR', `the connector directory is not a directory: ${dir}`);
  const mode = st.mode & 0o777;
  if (mode !== DIR_MODE) {
    throw socketError('ESOCKETDIR', `the connector directory is mode ${mode.toString(8).padStart(4, '0')}, not 0700: ${dir}`);
  }
  if (typeof process.getuid === 'function' && st.uid !== process.getuid()) {
    throw socketError('ESOCKETDIR', `the connector directory is not owned by this user: ${dir}`);
  }
}

// Whether something answers on the socket file: true (live), false (stale:
// refused or gone), or null (no verdict in time).
function probe(file, timeoutMs = PROBE_TIMEOUT_MS) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { sock.destroy(); } catch { /* gone */ }
      resolve(v);
    };
    const sock = net.connect({ path: file });
    const timer = setTimeout(() => finish(null), timeoutMs);
    sock.on('connect', () => finish(true));
    sock.on('error', (e) => finish(e && (e.code === 'ECONNREFUSED' || e.code === 'ENOENT') ? false : null));
  });
}

async function clearStale(file) {
  let st;
  try { st = fs.lstatSync(file); } catch (e) {
    if (e.code === 'ENOENT') return;
    throw socketError('ESOCKETPATH', `the connector's socket path cannot be read: ${file}`);
  }
  if (!st.isSocket()) throw socketError('ESOCKETPATH', `something that is not a socket is at the connector's socket path: ${file}`);
  const live = await probe(file);
  if (live === true) throw socketError('ESOCKETBUSY', `another connector is listening on ${file}`);
  if (live === null) throw socketError('ESOCKETBUSY', `the socket at ${file} neither answered nor refused`);
  try { fs.unlinkSync(file); } catch (e) {
    if (e.code !== 'ENOENT') throw socketError('ESOCKETPATH', `the stale socket could not be removed: ${file}`);
  }
}

function answerLine(sock, value) {
  let text;
  try { text = JSON.stringify(value === undefined ? null : value); } catch {
    text = JSON.stringify({ ok: false, local: true, error: 'the answer could not be written' });
  }
  try { sock.end(`${text}\n`); } catch { /* the asker went away */ }
}

const local = (error) => ({ ok: false, local: true, error });

// One parsed request → its answer object (never throws).
async function answer(req, ctx) {
  if (!isPlainObject(req) || typeof req.type !== 'string' || !isPlainObject(req.params)) return local(ONLY_THREE);
  if (LOCAL_REQUEST_TYPES.includes(req.type)) {
    if (req.type === 'connector.release-all') {
      if (typeof ctx.releaseAll !== 'function') return local('this connector cannot release its daemons');
      try {
        const result = await ctx.releaseAll();
        return { ok: true, local: true, type: req.type, result: result === undefined ? null : result };
      } catch (e) {
        return local(`the release failed${e && typeof e.code === 'string' ? ` (${e.code})` : ''}`);
      }
    }
    // connector.leave (U716b): the link's machine.leave, sent by this process
    // (`connect disconnect` asks it before connector.release-all); with no
    // link up nothing is sent and the hub keeps the machine.
    if (req.type === 'connector.leave') {
      const link = ctx.link;
      if (!link || link.state !== 'up' || typeof link.leave !== 'function') return local(NOT_CONNECTED);
      try {
        const result = await link.leave();
        if (!result || !result.sent) return local(NOT_CONNECTED);
        return { ok: true, local: true, type: req.type, result: { sent: true, closed: Boolean(result.closed) } };
      } catch {
        return local('the leave could not be sent');
      }
    }
  }
  if (!HUB_REQUEST_TYPES.includes(req.type)) return local(ONLY_THREE);
  const link = ctx.link;
  if (!link || link.state !== 'up' || typeof link.request !== 'function') return local(NOT_CONNECTED);
  let frame;
  try {
    frame = await link.request('control', 'hub.request', { request: { type: req.type, params: req.params } }, { timeoutMs: HUB_TIMEOUT_MS });
  } catch (e) {
    if (e && e.code === 'ETIMEDOUT') return local(`the hub did not answer within ${HUB_TIMEOUT_MS / 1000} s`);
    if (e && e.code === 'ELINKDOWN') return local(NOT_CONNECTED);
    return local('the request could not be sent to the hub');
  }
  if (frame && frame.kind === 'hub.response' && isPlainObject(frame.response)) return frame.response;
  const code = frame && typeof frame.code === 'string' && /^[a-z_]{1,32}$/.test(frame.code) ? ` (${frame.code})` : '';
  return local(`the hub refused the request${code}`);
}

function serve(sock, ctx, say) {
  let buf = Buffer.alloc(0);
  let taken = false;
  sock.setTimeout(READ_TIMEOUT_MS, () => { if (!taken) sock.destroy(); });
  sock.on('error', () => { /* the asker went away */ });
  sock.on('data', (chunk) => {
    if (taken) return;
    buf = Buffer.concat([buf, chunk]);
    const nl = buf.indexOf(0x0a);
    if (nl === -1 && buf.length <= MAX_REQUEST_BYTES) return;
    taken = true;
    sock.setTimeout(0);
    if (nl === -1 || nl > MAX_REQUEST_BYTES) {
      say('local socket refused code=too_large');
      answerLine(sock, local(`a request is at most ${MAX_REQUEST_BYTES} bytes`));
      return;
    }
    let req;
    try { req = JSON.parse(buf.subarray(0, nl).toString('utf8')); } catch {
      answerLine(sock, local(ONLY_THREE));
      return;
    }
    answer(req, ctx).then((value) => answerLine(sock, value));
  });
}

async function install(ctx, opts = {}) {
  if (!ctx || typeof ctx !== 'object') throw new TypeError('install: a context object is required');
  if (ctx.localSocket) throw new Error('install: the local socket is already installed');
  const say = (line) => { try { if (typeof ctx.log === 'function') ctx.log(line); } catch { /* the log's own failure */ } };
  const platform = opts.platform || process.platform;
  const ensureDir = opts.ensureDir || setup.ensureConnectorDir;
  let file;
  let server;
  let bound = null;
  const open = new Set();
  try {
    file = socketPathOf(ctx, opts);
    if (!path.isAbsolute(file)) throw socketError('ESOCKETPATH', 'the connector\'s socket path is not absolute');
    const long = pathTooLong(file, platform);
    if (long) throw socketError('ESOCKETPATH', long);
    checkDirectory(path.dirname(file), { ensureDir });
    await clearStale(file);
    server = net.createServer({ allowHalfOpen: false }, (sock) => {
      open.add(sock);
      sock.on('close', () => open.delete(sock));
      serve(sock, ctx, say);
    });
    server.maxConnections = MAX_CONNECTIONS;
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(file, () => { server.removeListener('error', reject); resolve(); });
    });
    fs.chmodSync(file, SOCKET_MODE);
    bound = fs.lstatSync(file).ino;
  } catch (e) {
    if (server) { try { server.close(); } catch { /* not listening */ } }
    const code = e && typeof e.code === 'string' ? e.code : 'ESOCKET';
    say(`local socket refused code=${code}`);
    throw e && e.code ? e : socketError('ESOCKET', 'the connector\'s socket could not be opened');
  }
  server.on('error', (e) => say(`local socket error code=${e && e.code ? e.code : 'unknown'}`));
  say('local socket listening');

  let stopping = null;
  function stop() {
    if (stopping) return stopping;
    stopping = new Promise((resolve) => {
      server.close(() => resolve());
      // An ask still waiting on the hub is cut: the CLI sees the connection end.
      for (const sock of open) { try { sock.destroy(); } catch { /* gone */ } }
      // Remove the file only while it is still the one this process bound.
      try {
        const st = fs.lstatSync(file);
        if (st.isSocket() && st.ino === bound) fs.unlinkSync(file);
      } catch { /* already gone */ }
    }).then(() => {
      if (ctx.localSocket && ctx.localSocket.stop === stop) ctx.localSocket = null;
    });
    return stopping;
  }
  ctx.localSocket = { path: file, stop };
  return stop;
}

// ── the client half ────────────────────────────────────────────────────────

function askConnector({ path: file, request, timeoutMs = ASK_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    if (typeof file !== 'string' || !file) { reject(socketError('ENOCONNECTOR', NO_CONNECTOR)); return; }
    let line;
    try { line = `${JSON.stringify(request)}\n`; } catch {
      reject(socketError('EASK', 'the request could not be written'));
      return;
    }
    let done = false;
    let connected = false;
    let buf = Buffer.alloc(0);
    const sock = net.connect({ path: file });
    const timer = setTimeout(() => fail(socketError('ETIMEDOUT', 'the connector did not answer in time')), timeoutMs);
    function finish() {
      clearTimeout(timer);
      try { sock.destroy(); } catch { /* gone */ }
    }
    function fail(e) {
      if (done) return;
      done = true;
      finish();
      reject(e);
    }
    function take() {
      if (done) return;
      const nl = buf.indexOf(0x0a);
      const text = (nl === -1 ? buf : buf.subarray(0, nl)).toString('utf8');
      let value;
      try { value = JSON.parse(text); } catch {
        fail(socketError('EASK', 'the connector\'s answer is not JSON'));
        return;
      }
      done = true;
      finish();
      resolve(value);
    }
    sock.on('connect', () => { connected = true; sock.write(line); });
    sock.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (buf.length > MAX_ANSWER_BYTES) { fail(socketError('EASK', 'the connector\'s answer is too large')); return; }
      if (buf.indexOf(0x0a) !== -1) take();
    });
    sock.on('end', () => { if (!done) { if (buf.length) take(); else fail(socketError('EASK', 'the connector closed without answering')); } });
    sock.on('error', (e) => {
      if (!connected) fail(socketError('ENOCONNECTOR', NO_CONNECTOR));
      else fail(socketError('EASK', `the connection to the connector failed${e && e.code ? ` (${e.code})` : ''}`));
    });
  });
}

module.exports = {
  install,
  askConnector,
  answer,
  pathTooLong,
  sunPathMax,
  HUB_REQUEST_TYPES,
  LOCAL_REQUEST_TYPES,
  MAX_REQUEST_BYTES,
  HUB_TIMEOUT_MS,
  ASK_TIMEOUT_MS,
  SUN_PATH_MAX,
  SOCKET_MODE,
  ONLY_THREE,
  NOT_CONNECTED,
  NO_CONNECTOR,
};
