// Smoke coverage for lib/hooks: turn-begin / turn-end tested in-process against a
// recording stub server, and the index.js dispatcher + toggle gate tested as a
// subprocess (it calls process.exit, so an in-process require would kill the test
// runner). Fully isolated: tmp roots, HOME redirected, portfiles point at the
// stub with a LIVE pid (readPortfile gates on process.kill(pid,0)). No real
// daemon is ever spawned.

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
  try { pending = turnBegin({ prompt: 'hi' }, { root }); } finally { process.stdout.write = orig; }
  await pending;
  const parsed = JSON.parse(out);
  assert.equal(parsed.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
  assert.match(parsed.hookSpecificOutput.additionalContext, /does not have a web-chat tab open/);
});

test('turn-begin: reachable server -> POST /api/turn-begin', async (t) => {
  withTempHome(t);
  const stub = await stubServer();
  t.after(() => stub.close());
  const root = tmpRoot('wc-hook-');
  writePortfile(path.join(root, '.web-chat'), { pid: process.pid, port: stub.port });
  await turnBegin({ prompt: 'hello' }, { root });
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
  await turnBegin({ user_prompt: 'from-user_prompt' }, { root });
  const post = stub.requests.filter((r) => r.url === '/api/turn-begin').pop();
  assert.equal(post.body.message, 'from-user_prompt');
});

test('turn-begin: delivers a parked wake as context, then consumes it', async (t) => {
  withTempHome(t);
  const { api, root } = await withServer(t, { writePortfile: true });
  // A capture enqueues; a Push with NO channel connected PARKS the wake.
  await api.post('/api/capture', { url: 'https://example.com/doc', title: 'Doc', html: HTML });
  assert.equal((await api.post('/api/queue/push', {})).json.mode, 'parked');

  const out = await captureStdout(() => turnBegin({ prompt: 'back to it' }, { root }));
  const parsed = JSON.parse(out);
  assert.equal(parsed.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
  assert.match(parsed.hookSpecificOutput.additionalContext, /Parked delivery/);
  assert.match(parsed.hookSpecificOutput.additionalContext, /example\.com/);

  // Consumed: a second prompt gets nothing (the park is cleared).
  assert.equal((await api.get('/api/queue/pending')).json.pending, null, 'the park was consumed');
});

test('turn-begin: reachable server with NO parked wake emits nothing extra', async (t) => {
  withTempHome(t);
  const { api, root } = await withServer(t, { writePortfile: true });
  const out = await captureStdout(() => turnBegin({ prompt: 'hi' }, { root }));
  assert.equal(out.trim(), '', 'no park → no additionalContext on the reachable path');
  // Sanity: the turn-begin lock was still acquired (the primary hook effect).
  assert.equal((await api.get('/api/queue/pending')).json.pending, null);
});

// --- turn-end (in-process) ---

test('turn-end: no portfile -> no-op, does not throw', async (t) => {
  withTempHome(t);
  const root = tmpRoot('wc-hook-');
  await assert.doesNotReject(() => turnEnd({}, { root }));
});

test('turn-end: reachable server -> POST /api/turn-end', async (t) => {
  withTempHome(t);
  const stub = await stubServer();
  t.after(() => stub.close());
  const root = tmpRoot('wc-hook-');
  writePortfile(path.join(root, '.web-chat'), { pid: process.pid, port: stub.port });
  await turnEnd({}, { root });
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
  await assert.doesNotReject(() => turnEnd({}, { root }));
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
  assert.match(parsed.hookSpecificOutput.additionalContext, /does not have a web-chat tab open/);
});
