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

const fs = require('fs');
const os = require('os');
const path = require('path');
const WebSocket = require('ws');
const { createServer } = require('../lib/server');
const { writePortfileAt: writePortfile } = require('../lib/core/portfiles');

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
function withTempHome(tOrFn) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-home-'));
  const prevHome = process.env.HOME;
  const prevUserProfile = process.env.USERPROFILE;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  const restore = () => {
    if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
    if (prevUserProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = prevUserProfile;
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

function wsConnect(port, pathStr = '/ws') {
  return new WebSocket(`ws://localhost:${port}${pathStr}`);
}

// Open a socket, resolve the first {type:'hello'} frame, then close it.
function wsHello(port, pathStr = '/ws') {
  return new Promise((resolve, reject) => {
    const sock = wsConnect(port, pathStr);
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
// Returns ctx { srv, server, port, baseUrl, root, webChatDir, api, ws, wsHello,
// stop, graceful }; also passed to fn if given.
async function withServer(t, opts, fn) {
  if (typeof opts === 'function') { fn = opts; opts = {}; }
  opts = opts || {};

  const root = opts.root || tmpRoot();
  const webChatDir = path.join(root, '.web-chat');
  fs.mkdirSync(webChatDir, { recursive: true });
  if (opts.seed) await opts.seed({ root, webChatDir });

  const srv = createServer({ root, port: opts.mode === 'start' ? 'auto' : 0 });

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
    api: makeApi(baseUrl),
    ws: (pathStr = '/ws') => wsConnect(port, pathStr),
    wsHello: (pathStr = '/ws') => wsHello(port, pathStr),
    stop: () => safeStop(srv),
    graceful: () => srv.gracefulShutdown(),
  };

  if (fn) await fn(ctx);
  return ctx;
}

module.exports = { withServer, tmpRoot, withTempHome, makeApi, wsConnect, wsHello, safeStop };
