// Shared test harness. Deliberately OUTSIDE test/ because `node --test` collects
// every *.js under a test/ directory and would run this (test-less) file as a
// phantom passing "test", inflating the count. From here it is imported via
// require('../test-support/helpers') and never auto-collected. It is not scanned
// by the conventions tripwire (that scans lib/ + public/), so it may use raw
// http/ws/fetch freely.
//
// The point of withServer over the copy-pasted per-file scaffolding is a
// SIDE-EFFECT-FREE lifecycle plus teardown registered on the test context, so a
// failing assertion can't leak the port/handle: createServer + server.listen(0)
// (never start() with a portfile, so no hub spawn / no ~/.web-chat registry
// writes), and an idempotent t.after stop.
//
// Beyond booting a server this file owns five more things every test needs and
// a dozen files used to hand-roll: ONE deadline poll (`waitUntil`), ONE SSE opener
// that can actually FAIL (`openSSE`), a WS connect that can send headers
// (`wsConnect`, so the Origin gate is reachable), a deaf raw-socket WS client
// (`deafWs`, the connection that never answers a close frame), and a hub boot
// (`withHub`). `test/harness-conventions.test.js` ratchets those back here.

// The throwaway-HOME preload. `--import ./test-support/sandbox.js` in the npm
// script gets it in before ANY require; requiring it here is the belt for a
// runner that doesn't propagate the flag to its per-file children, and for
// anyone who runs a single file with a bare `node --test test/x.test.js`. The
// module is idempotent — a second load is a no-op.
require('./sandbox');

const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const crypto = require('crypto');
const WebSocket = require('ws');
const { writePortfileAt: writePortfile } = require('../lib/core/portfiles');
const { LISTEN_HOST } = require('../lib/core/cors');
const { subscribeSSE } = require('../lib/client');

// Resolved LAZILY, not at require time. lock-ttl.test.js sets
// WEB_CHAT_LOCK_TTL_MS and then deletes four require.cache entries so the TTL is
// re-read at module load; a binding captured up here would hand that test the
// STALE module and it would pass while exercising the wrong code. `opts.createServer`
// lets a caller inject one outright.
function resolveCreateServer(injected) {
  return injected || require('../lib/server').createServer;
}
function resolveCreateHub(injected) {
  return injected || require('../lib/hub').createHub;
}

// Fresh isolated project root with an empty .web-chat/. OS tmp is left to the OS
// to reap; withServer also rm's the roots it mints.
function tmpRoot(prefix = 'wc-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.mkdirSync(path.join(dir, '.web-chat'), { recursive: true });
  return dir;
}

// Redirect HOME (and USERPROFILE) to a throwaway dir so os.homedir()-based tiers
// (~/.web-chat: theme system scope, toggle user/session scopes) don't read or
// write the dev machine. Two forms:
//   withTempHome(t)               -> returns home; restores + rm's on t.after
//   withTempHome(async home => …) -> sets, awaits, restores in finally
// The sandbox currently in effect, so withServer can join an existing one
// instead of shadowing it with a second (which would strand a caller that
// seeded ~/.web-chat before booting the server). Null when HOME is not redirected.
let activeTempHome = null;

function withTempHome(tOrFn) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-home-'));
  const prevHome = process.env.HOME;
  const prevUserProfile = process.env.USERPROFILE;
  const prevActive = activeTempHome;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  activeTempHome = home;
  const restore = () => {
    if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
    if (prevUserProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = prevUserProfile;
    activeTempHome = prevActive;
    try { fs.rmSync(home, { recursive: true, force: true }); } catch {}
  };
  if (typeof tOrFn === 'function') {
    return (async () => { try { return await tOrFn(home); } finally { restore(); } })();
  }
  tOrFn.after(restore);
  return home;
}

// fetch-based request helper. Reads the body once as text and parses JSON
// best-effort, so a caller can assert on either .json (null if not JSON) or the
// raw .text. Per-request headers override the default JSON Content-Type (e.g. the
// capture token gate passes { 'X-WC-Token': … }).
function makeApi(baseUrl) {
  async function req(method, p, body, headers) {
    const init = { method, headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(headers || {}) } };
    if (body !== undefined) init.body = typeof body === 'string' ? body : JSON.stringify(body);
    const res = await fetch(baseUrl + p, init);
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch {}
    return { status: res.status, json, text, headers: res.headers };
  }
  return {
    base: baseUrl,
    get: (p, headers) => req('GET', p, undefined, headers),
    post: (p, body, headers) => req('POST', p, body, headers),
    patch: (p, body, headers) => req('PATCH', p, body, headers),
    del: (p, headers) => req('DELETE', p, undefined, headers),
    // Escape hatch for full control (HEAD, streaming, custom body) — returns the
    // raw Response.
    raw: (p, init) => fetch(baseUrl + p, init),
  };
}

// ── waitUntil — the ONE deadline poll ────────────────────────────────────────
//
// It replaced eight private copies with three mutually incompatible contracts
// (throw-with-a-label / return-false / re-check-then-return; boolean vs
// first-truthy-value; one that called its predicate synchronously). The union,
// spelled out because every clause has a caller that needs it:
//
//   * the predicate is AWAITED — a synchronous one still works, the reverse
//     does not;
//   * it resolves with the FIRST TRUTHY VALUE, not `true`, so a caller can read
//     the thing it was waiting for straight out (a nonce off a trust prompt, a
//     pid off the store) instead of fetching it again;
//   * after the deadline it evaluates ONCE more, so a predicate that only just
//     became true is not lost to the last sleep;
//   * on final failure it THROWS `timed out waiting for <what>` when `what` is
//     given, and otherwise returns `false` — because ~17 call sites are
//     `assert.ok(await waitUntil(…), 'message')` and want the assertion's
//     message, not a raw throw.
async function waitUntil(pred, { timeout = 2000, interval = 25, what } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const v = await pred();
    if (v) return v;
    const left = deadline - Date.now();
    if (left <= 0) break;
    await new Promise((r) => setTimeout(r, Math.min(interval, left)));
  }
  const last = await pred();
  if (last) return last;
  if (what) throw new Error(`timed out waiting for ${what}`);
  return false;
}

// ── openSSE — the ONE event-stream opener, and it can FAIL ───────────────────
//
// The three private copies all passed `onOpen` alone, so every failure path in
// lib/client's subscribeSSE (non-200, request error, close) left the promise
// pending FOREVER — the shape behind the suite's mystery hangs. This one rejects
// on all three plus a deadline.
//
//   openSSE(port, { kinds, since, onEvent, timeout, awaitChannel })
//     → { close(), events }
//
// `events` accumulates every event the stream delivers (so a test can assert on
// the tail without wiring its own collector). `awaitChannel: api` is the
// stronger readiness the queue tests need: `onOpen` only means HTTP 200 came
// back, so it polls /api/queue/policy until the server counts this stream as the
// connected channel.
//
// It deliberately does NOT subsume test/events-sse.test.js, whose raw client
// asserts on `:` heartbeat comments and `id:` lines that subscribeSSE discards.
async function openSSE(port, { kinds, since, onEvent, timeout = 5000, awaitChannel } = {}) {
  const events = [];
  let opened = false;
  let resolveOpen, rejectOpen;
  const openedP = new Promise((res, rej) => { resolveOpen = res; rejectOpen = rej; });
  const handle = subscribeSSE({
    port,
    kinds,
    since,
    onOpen: () => { opened = true; resolveOpen(); },
    onEvent: (e) => { events.push(e); if (onEvent) { try { onEvent(e); } catch {} } },
    onError: (e) => { if (!opened) rejectOpen(e instanceof Error ? e : new Error(String(e))); },
    onClose: () => { if (!opened) rejectOpen(new Error('SSE stream closed before it opened')); },
  });

  let timer;
  const deadline = new Promise((_res, rej) => {
    timer = setTimeout(() => rej(new Error(`SSE stream did not open within ${timeout}ms`)), timeout);
  });
  try {
    await Promise.race([openedP, deadline]);
  } catch (e) {
    try { handle.close(); } catch {}
    throw e;
  } finally {
    clearTimeout(timer);
  }

  const stream = { events, close: () => { try { handle.close(); } catch {} } };
  if (awaitChannel) {
    const live = await waitUntil(
      async () => (await awaitChannel.get('/api/queue/policy')).json.channel_connected,
      { timeout, interval: 15 },
    );
    if (!live) { stream.close(); throw new Error('SSE opened but the server never counted it as a connected channel'); }
  }
  return stream;
}

// `opts` is passed straight to the ws client. Two server-side gates depend on it,
// and neither is reachable from a URL: the Origin gate (lib/server/ws.js
// verifyClient) — Node's ws client sends no Origin, so before this every test
// connection took the `!origin` branch and deleting the gate still passed the
// suite — and the Host gate on the upgrade, which the browser-side APIs forbid
// setting at all.
function wsConnect(port, pathStr = '/ws', opts) {
  return new WebSocket(`ws://localhost:${port}${pathStr}`, opts);
}

// A tab that has gone DEAF: a raw socket that completes the WebSocket upgrade by
// hand and then ignores everything sent to it, the polite close frame included.
//
// It has to be a raw socket. The `ws` client answers a close frame — that is the
// whole point of it — so `wsConnect` cannot stand in: the connection under test
// is the one that will NOT let go, which is what pins gracefulShutdown's final
// `server.close()` and makes the daemon's own drain budget the assertion. Node
// also drops a socket from the HTTP server's connection list the moment it is
// upgraded, so `closeAllConnections()` cannot reach this one either.
//
// Resolves once the 101 is seen, so the socket is genuinely upgraded before the
// test proceeds; teardown is on t.after, so a failed assertion cannot leak it.
function deafWs(t, port, pathStr = '/ws') {
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, '127.0.0.1', () => {
      const key = crypto.randomBytes(16).toString('base64');
      sock.write(
        `GET ${pathStr} HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n`
        + `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
      );
    });
    sock.on('data', (d) => { if (/101/.test(d.toString().slice(0, 16))) resolve(sock); });
    sock.on('error', reject);
    t.after(() => { try { sock.destroy(); } catch {} });
  });
}

// Open a socket, resolve the first {type:'hello'} frame, then close it.
// A REFUSED upgrade rejects with an error carrying .statusCode — ws only skips
// its own 'error' for an unexpected response when something is listening for it,
// so a refusal is an assertable outcome here instead of a hang.
function wsHello(port, pathStr = '/ws', opts = {}) {
  return new Promise((resolve, reject) => {
    const sock = wsConnect(port, pathStr, opts);
    sock.on('unexpected-response', (_req, res) => {
      res.resume();
      const err = new Error(`ws upgrade refused: HTTP ${res.statusCode}`);
      err.statusCode = res.statusCode;
      try { sock.terminate(); } catch {}
      reject(err);
    });
    sock.on('message', (data) => {
      let msg = null;
      try { msg = JSON.parse(data.toString()); } catch {}
      if (msg && msg.type === 'hello') { sock.close(); resolve(msg); }
    });
    sock.on('error', reject);
  });
}

// Idempotent stop — server.close() throws ERR_SERVER_NOT_RUNNING on an already
// closed server (restart / graceful-as-assertion tests close it themselves), so
// guard on .listening. closeAllConnections nudges undici keep-alive sockets so
// close() resolves promptly instead of waiting on idle pooled connections.
async function safeStop(srv) {
  if (!srv.server.listening) return;
  try {
    const closing = srv.stop();
    srv.server.closeAllConnections?.();
    await closing;
  } catch {}
}

// Stand up an in-process server for a test and own its teardown.
//   withServer(t)              withServer(t, opts)
//   withServer(t, fn)          withServer(t, opts, fn)
// opts: { root, seed({root,webChatDir}), mode:'start', writePortfile }
//   - root:     reuse an existing populated root (restart tests); default a fresh tmpRoot()
//   - seed:     write into .web-chat BEFORE createServer (profiles, tokens, a bogus draft)
//   - mode:     'start' binds the real 5173+ range via start({writePortfile:false})
//               (port-walk only); default listens on an ephemeral port
//   - writePortfile: write server.json into the tmp root so a watch/discovery
//               path can find this server
//   - createServer: inject a module (a require.cache-busted one, for the lock
//               TTL tests); default is a LAZY require of lib/server
// Returns ctx { srv, server, port, baseUrl, root, webChatDir, api, ws, wsHello,
// stop, graceful }; also passed to fn if given.
async function withServer(t, opts, fn) {
  if (typeof opts === 'function') { fn = opts; opts = {}; }
  opts = opts || {};

  // Sandbox HOME for every server test. The daemon touches user-tier state on
  // boot and during a run — the cross-project instance registry, user-tier
  // components/themes, and (since service consent moved out of the project, so a
  // repo can't ship its own approval) the service TRUST STORE. Without this the
  // suite wrote all of that into the developer's real ~/.web-chat, which for the
  // trust store would mean tests silently granting host-execution approvals on
  // the dev machine. Skipped when the caller already sandboxed HOME itself.
  // A caller that already called withTempHome (to seed ~/.web-chat before boot)
  // keeps its own sandbox — creating a second one here would strand that seed.
  const home = opts.home === false ? null : (activeTempHome || withTempHome(t));
  const userWebChat = home ? path.join(home, '.web-chat') : null;

  const root = opts.root || tmpRoot();
  const webChatDir = path.join(root, '.web-chat');
  fs.mkdirSync(webChatDir, { recursive: true });
  if (opts.seed) await opts.seed({ root, webChatDir, home, userWebChat });

  const srv = resolveCreateServer(opts.createServer)({ root, port: opts.mode === 'start' ? 'auto' : 0 });

  if (opts.mode === 'start') {
    await srv.start({ writePortfile: false });
  } else {
    await new Promise((resolve, reject) => {
      const onError = (e) => { srv.server.off('error', onError); reject(e); };
      srv.server.once('error', onError);
      srv.server.listen(0, () => { srv.server.off('error', onError); resolve(); });
    });
  }

  const port = srv.server.address().port;
  const baseUrl = `http://localhost:${port}`;
  if (opts.writePortfile) writePortfile(webChatDir, { pid: process.pid, port });

  // Runs even when the body throws — the leak fix over end-of-body stop().
  t.after(async () => {
    await safeStop(srv);
    try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
  });

  const ctx = {
    srv,
    server: srv.server,
    port,
    baseUrl,
    root,
    webChatDir,
    home,
    userWebChat,
    api: makeApi(baseUrl),
    ws: (pathStr = '/ws', wsOpts) => wsConnect(port, pathStr, wsOpts),
    wsHello: (pathStr = '/ws', wsOpts) => wsHello(port, pathStr, wsOpts),
    sse: (sseOpts) => openSSE(port, sseOpts),
    stop: () => safeStop(srv),
    graceful: () => srv.gracefulShutdown(),
  };

  if (fn) await fn(ctx);
  return ctx;
}

// Stand up the capture HUB for a test and own its teardown — withServer's
// missing sibling. Four hand-rolled `createHub + listen(0)` boots (hub.test.js
// twice, profile-match.test.js, doctor.test.js) had nowhere else to go, and each
// stopped the hub at the END of the test body, so a failed assertion leaked a
// listening handle. It binds LISTEN_HOST because a test hub should be reachable
// exactly where a real one is — but the bind below is the HARNESS's, so asserting
// on it says nothing about lib/hub's own start(). The production bind is pinned
// by 'hub.start(): binds LISTEN_HOST' in test/harness.test.js, which drives the
// real start() in-process.
//   withHub(t)                 — ephemeral port
//   withHub(t, { port: 5170 }) — the pinned port (doctor's hub-is-up branch)
async function withHub(t, { port = 0, createHub } = {}) {
  const hub = resolveCreateHub(createHub)({ port });
  await new Promise((resolve, reject) => {
    const onError = (e) => { hub.server.off('error', onError); reject(e); };
    hub.server.once('error', onError);
    hub.server.listen(port, LISTEN_HOST, () => { hub.server.off('error', onError); resolve(); });
  });
  const bound = hub.server.address().port;
  const baseUrl = `http://localhost:${bound}`;
  // Idempotent: hub.stop() resolves off server.close(), which never fires on an
  // already-closed server, so guard on .listening exactly as safeStop does.
  const stop = async () => {
    if (!hub.server.listening) return;
    try {
      const closing = hub.stop();
      hub.server.closeAllConnections?.();
      await closing;
    } catch {}
  };
  t.after(stop);
  return { hub, server: hub.server, port: bound, baseUrl, api: makeApi(baseUrl), stop };
}

module.exports = {
  withServer, withHub, tmpRoot, withTempHome, makeApi,
  waitUntil, openSSE, wsConnect, wsHello, deafWs, safeStop,
};
