// Smoke coverage for lib/hooks: turn-begin / turn-end tested in-process against a
// recording stub server, and the index.js dispatcher + toggle gate tested as a
// subprocess (it calls process.exit, so an in-process require would kill the test
// runner).
//
// What is actually isolated, and how: every hook call is given an explicit tmp
// `root` and HOME is redirected, so portfile discovery and ~/.web-chat both land
// in throwaway dirs; the portfiles point at a stub HTTP server with a LIVE pid
// (readPortfile gates on process.kill(pid,0)).
//
// The isolation that does NOT come for free is the retry path: lib/mcp/client
// defaults spawn:true, and lib/client's respawn-on-ECONNREFUSED resolves its root
// from process.cwd() when the caller passes none — which, under the test runner,
// is THIS checkout. The hooks therefore pass {root, noSpawn} on every call, and
// the test below pins that. Without it a stub that dies mid-call would have the
// hook POST /api/turn-begin to the developer's own daemon, or fork a real one
// into this repo's .web-chat.
//
// The 500ms liveness probe is a wall-clock budget, so the tests pass a generous
// one through ctx (HOOK_CTX) rather than betting the suite on a loaded machine.

const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');
const { tmpRoot, withTempHome, withServer } = require('../test-support/helpers');
const { writePortfileAt: writePortfile } = require('../lib/core/portfiles');
const turnBegin = require('../lib/hooks/turn-begin');
const turnEnd = require('../lib/hooks/turn-end');

const HOOK_BIN = path.join(__dirname, '..', 'bin', 'claude-web-chat-hook.js');
// A probe budget no loaded CI box can miss. The hooks read it from ctx; prod
// keeps the 500ms default.
const PROBE = { probeMs: 5000 };
const HTML = '<html><head><title>Doc</title></head><body><p>hi</p></body></html>';

// Capture stdout across an async hook run (the parked-delivery frame is written
// AFTER the daemon round-trip, so the patch must span the awaits). The hook writes
// STRINGS (JSON.stringify); node:test's own subprocess reporter writes Buffers
// (V8-serialized protocol) — so capture string chunks only and pass Buffers through,
// or we'd swallow the runner's protocol stream and corrupt the report.
async function captureStdout(fn) {
  const orig = process.stdout.write.bind(process.stdout);
  let out = '';
  process.stdout.write = (chunk, ...rest) => {
    if (typeof chunk === 'string') { out += chunk; return true; }
    return orig(chunk, ...rest);
  };
  try { await fn(); } finally { process.stdout.write = orig; }
  return out;
}

function mkTmp(prefix = 'wc-hk-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// Recording HTTP stub: answers everything 200 (so probeReachable's HEAD
// /api/health passes) and records each request's method/url/parsed body.
function stubServer() {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      let json = null; try { json = body ? JSON.parse(body) : null; } catch {}
      requests.push({ method: req.method, url: req.url, body: json });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, () => resolve({
      port: server.address().port,
      requests,
      close: () => new Promise((r) => server.close(r)),
    }));
  });
}

function runHook(subcmd, { cwd, home, input }) {
  return spawnSync(process.execPath, [HOOK_BIN, subcmd], {
    cwd,
    input: input != null ? JSON.stringify(input) : '',
    env: { ...process.env, HOME: home, USERPROFILE: home },
    encoding: 'utf8',
  });
}

// --- turn-begin (in-process) ---

test('turn-begin: no portfile -> emits no-server notice', async (t) => {
  withTempHome(t);
  const root = tmpRoot('wc-hook-');
  // The no-portfile path runs synchronously to the emit (readPortfile is sync,
  // no await when info is null), so capture then restore BEFORE the first await —
  // otherwise the patched stdout would also swallow the test runner's own output.
  const orig = process.stdout.write.bind(process.stdout);
  let out = '';
  process.stdout.write = (chunk) => { out += chunk.toString(); return true; };
  let pending;
  try { pending = turnBegin({ prompt: 'hi' }, { root, ...PROBE }); } finally { process.stdout.write = orig; }
  await pending;
  const parsed = JSON.parse(out);
  assert.equal(parsed.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
  assert.match(parsed.hookSpecificOutput.additionalContext, /No web-chat daemon is running/);
  assert.match(parsed.hookSpecificOutput.additionalContext, /MCP tools still work/,
    'it must not claim the render tools will fail — they auto-spawn the daemon and succeed');
});

test('turn-begin: reachable server -> POST /api/turn-begin', async (t) => {
  withTempHome(t);
  const stub = await stubServer();
  t.after(() => stub.close());
  const root = tmpRoot('wc-hook-');
  writePortfile(path.join(root, '.web-chat'), { pid: process.pid, port: stub.port });
  await turnBegin({ prompt: 'hello' }, { root, ...PROBE });
  const posts = stub.requests.filter((r) => r.method === 'POST' && r.url === '/api/turn-begin');
  assert.equal(posts.length, 1);
  assert.deepEqual(posts[0].body, { message: 'hello', author: 'user' });
});

test('turn-begin: message falls back through user_prompt when prompt is absent', async (t) => {
  withTempHome(t);
  const stub = await stubServer();
  t.after(() => stub.close());
  const root = tmpRoot('wc-hook-');
  writePortfile(path.join(root, '.web-chat'), { pid: process.pid, port: stub.port });
  await turnBegin({ user_prompt: 'from-user_prompt' }, { root, ...PROBE });
  const post = stub.requests.filter((r) => r.url === '/api/turn-begin').pop();
  assert.equal(post.body.message, 'from-user_prompt');
});

test('turn-begin: delivers a parked wake as context, then consumes it', async (t) => {
  withTempHome(t);
  const { api, root } = await withServer(t, { writePortfile: true });
  // A capture enqueues; a Push with NO channel connected PARKS the wake.
  await api.post('/api/capture', { url: 'https://example.com/doc', title: 'Doc', html: HTML });
  assert.equal((await api.post('/api/queue/push', {})).json.mode, 'parked');

  const out = await captureStdout(() => turnBegin({ prompt: 'back to it' }, { root, ...PROBE }));
  const parsed = JSON.parse(out);
  assert.equal(parsed.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
  assert.match(parsed.hookSpecificOutput.additionalContext, /Parked delivery/);
  assert.match(parsed.hookSpecificOutput.additionalContext, /example\.com/);

  // Consumed: a second prompt gets nothing (the park is cleared).
  assert.equal((await api.get('/api/queue/pending')).json.pending, null, 'the park was consumed');
});

test('turn-begin: a running daemon with NO browser watching says so', async (t) => {
  withTempHome(t);
  const { api, root } = await withServer(t, { writePortfile: true });
  // No WS client is connected, so nothing is watching: a render would succeed and
  // commit, and be seen by nobody. That is the warning worth giving.
  const out = await captureStdout(() => turnBegin({ prompt: 'hi' }, { root, ...PROBE }));
  assert.match(JSON.parse(out).hookSpecificOutput.additionalContext, /no browser is watching/);
  // Sanity: the turn-begin lock was still acquired (the primary hook effect).
  assert.equal((await api.get('/api/queue/pending')).json.pending, null);
});

test('turn-begin: with a browser watching, it stays quiet', async (t) => {
  withTempHome(t);
  const ctx = await withServer(t, { writePortfile: true });
  const sock = ctx.ws();
  await new Promise((r, j) => { sock.on('message', (d) => { if (JSON.parse(d).type === 'hello') r(); }); sock.on('error', j); });
  t.after(() => { try { sock.close(); } catch {} });
  const out = await captureStdout(() => turnBegin({ prompt: 'hi' }, { root: ctx.root, ...PROBE }));
  assert.equal(out.trim(), '', 'nothing to warn about — someone is looking');
});

test('turn-begin/turn-end: every daemon call is pinned to THIS root and never spawns', async (t) => {
  withTempHome(t);
  const stub = await stubServer();
  t.after(() => stub.close());
  const root = tmpRoot('wc-hook-');
  writePortfile(path.join(root, '.web-chat'), { pid: process.pid, port: stub.port });

  // Record the opts each hook hands the client. The alternative — letting a
  // dying stub trigger the real retry — would spawn a daemon into whatever
  // project the runner's cwd sits in, which is exactly the bug being fenced.
  const client = require('../lib/mcp/client');
  const portfiles = require('../lib/core/portfiles');
  const calls = [];
  const probes = [];
  const origPost = client.post;
  const origProbe = portfiles.probeReachable;
  client.post = (p, b, o) => { calls.push({ path: p, opts: o || {} }); return origPost(p, b, o); };
  portfiles.probeReachable = (port, ms) => { probes.push(ms); return origProbe(port, ms); };
  t.after(() => { client.post = origPost; portfiles.probeReachable = origProbe; });

  await turnBegin({ prompt: 'hi' }, { root, ...PROBE });
  await turnEnd({}, { root, ...PROBE });

  assert.ok(calls.length >= 2, 'both hooks called the daemon');
  for (const c of calls) {
    assert.equal(c.opts.root, root, `${c.path} must pin the root it was fired for`);
    assert.equal(c.opts.noSpawn, true, `${c.path} must never auto-spawn a daemon`);
    assert.equal(c.opts.port, stub.port);
  }
  assert.deepEqual(probes, [5000, 5000], 'the probe budget comes from ctx, not a hardcoded 500ms');
});

// --- turn-end (in-process) ---

test('turn-end: no portfile -> no-op, does not throw', async (t) => {
  withTempHome(t);
  const root = tmpRoot('wc-hook-');
  await assert.doesNotReject(() => turnEnd({}, { root, ...PROBE }));
});

test('turn-end: reachable server -> POST /api/turn-end', async (t) => {
  withTempHome(t);
  const stub = await stubServer();
  t.after(() => stub.close());
  const root = tmpRoot('wc-hook-');
  writePortfile(path.join(root, '.web-chat'), { pid: process.pid, port: stub.port });
  await turnEnd({}, { root, ...PROBE });
  const posts = stub.requests.filter((r) => r.method === 'POST' && r.url === '/api/turn-end');
  assert.equal(posts.length, 1);
  assert.deepEqual(posts[0].body, { author: 'claude' });
});

test('turn-end: live pid but unreachable -> best-effort unlock, does not throw', async (t) => {
  withTempHome(t);
  const stub = await stubServer();
  const port = stub.port;
  await stub.close(); // nothing listens on `port` now
  const root = tmpRoot('wc-hook-');
  writePortfile(path.join(root, '.web-chat'), { pid: process.pid, port });
  await assert.doesNotReject(() => turnEnd({}, { root, ...PROBE }));
});

// --- index.js dispatcher + gate (subprocess) ---

test('hook index: unknown subcommand -> exit 0, empty stdout', () => {
  const r = runHook('bogus', { cwd: mkTmp(), home: mkTmp() });
  assert.equal(r.status, 0);
  assert.equal(r.stdout.trim(), '');
});

test('hook index: disabled project short-circuits turn-begin (exit 0, empty)', () => {
  const home = mkTmp();       // no ~/.web-chat/disabled -> user enabled
  const cwd = mkTmp();        // no .web-chat -> project not installed -> disabled
  const r = runHook('turn-begin', { cwd, home, input: { prompt: 'hi', cwd } });
  assert.equal(r.status, 0);
  assert.equal(r.stdout.trim(), '');
});

test('hook index: enabled + no server -> emits no-server notice (exit 0)', () => {
  const home = mkTmp();
  const cwd = mkTmp();
  fs.mkdirSync(path.join(cwd, '.web-chat'), { recursive: true }); // installed -> enabled
  const r = runHook('turn-begin', { cwd, home, input: { prompt: 'hi', cwd } });
  assert.equal(r.status, 0);
  const parsed = JSON.parse(r.stdout);
  assert.equal(parsed.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
  assert.match(parsed.hookSpecificOutput.additionalContext, /No web-chat daemon is running/);
  assert.match(parsed.hookSpecificOutput.additionalContext, /MCP tools still work/,
    'it must not claim the render tools will fail — they auto-spawn the daemon and succeed');
});
