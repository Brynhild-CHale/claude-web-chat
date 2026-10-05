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
//
// From 0.8.5 the turn hooks also carry the session they speak for (spec §3.1,
// §1.3): envelope v1's identity fields beside the lock's own, the prompt section
// on turn-begin, and `ended`, `error`, the background tasks and the final reply
// on turn-end — all bounded in the hook — and every daemon call they make has
// its own 3 s timeout. Those are tested in process, and again as a subprocess
// run the way Claude Code runs it (the real bin, the payload on stdin), against
// a stub daemon and a wedged one. Then the other half: the turn routes
// (lib/server/routes/graph.js), mounted on a bare Express app with a fake ctx
// (spec §10.1) — the real audience with no opt-in and a real hook tap — publish
// a HOST request's envelope on the tap before their lock logic, and a page's, a
// remote viewer's or a network peer's request publishes nothing and stays
// session-less, the lock behaving exactly as in 0.8.0.

const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const express = require('express');
const { spawnSync, spawn } = require('child_process');
const { tmpRoot, withTempHome, withServer, waitUntil } = require('../test-support/helpers');
const { writePortfileAt: writePortfile } = require('../lib/core/portfiles');
const { request } = require('../lib/client');
const { projectPaths } = require('../lib/core/paths');
const { createBus } = require('../lib/core/bus');
const { summarizeReply } = require('../lib/core/reply');
const { hookEnvelope, CAPS } = require('../lib/hooks/envelope');
const { createHookTap } = require('../lib/server/hook-tap');
const { ENVELOPE_KEYS, MAX_BODY_BYTES } = require('../lib/server/routes/hooks');
const { mountGraphRoutes } = require('../lib/server/routes/graph');
const { createAudience } = require('../lib/server/audience');
const { createGraph } = require('../lib/server/graph');
const { createState } = require('../lib/server/state');
const { resolvePaths } = require('../lib/server/paths');
const turnBegin = require('../lib/hooks/turn-begin');
const turnEnd = require('../lib/hooks/turn-end');

const HOOK_BIN = path.join(__dirname, '..', 'bin', 'claude-web-chat-hook.js');
// A probe budget no loaded CI box can miss. The hooks read it from ctx; prod
// keeps the 500ms default.
const PROBE = { probeMs: 5000 };
const HTML = '<html><head><title>Doc</title></head><body><p>hi</p></body></html>';
// When a hook "read stdin" (ctx.now), so a body is exact.
const NOW = 1790000000123;
const SID = '9d1e2f3a-4b5c-4d6e-8f70-81a2b3c4d5e6';
// The only two values envelope v1 reads from a hook's environment.
const ENV = { CLAUDE_PID: '4242', CLAUDE_CODE_ENTRYPOINT: 'cli' };
const PERF = process.env.WEB_CHAT_PERF === '1';

// What Claude Code hands each turn hook (V3): the common fields, and the
// event's own.
const transcriptOf = (sid) => `/u/.claude/projects/-u-p/${sid}.jsonl`;
const promptPayload = (root, extra = {}) => ({
  hook_event_name: 'UserPromptSubmit', session_id: SID, transcript_path: transcriptOf(SID), cwd: root,
  prompt_id: 'pr-1', permission_mode: 'acceptEdits', prompt: 'hello there', ...extra,
});
const stopPayload = (root, extra = {}) => ({
  hook_event_name: 'Stop', session_id: SID, transcript_path: transcriptOf(SID), cwd: root,
  prompt_id: 'pr-1', permission_mode: 'acceptEdits', stop_hook_active: false, session_crons: [],
  last_assistant_message: 'Done. The build passes.', background_tasks: [], ...extra,
});
// The session fields a turn hook sends for those payloads.
const SESSION = (root, ts = NOW) => ({
  ts, session_id: SID, transcript_path: transcriptOf(SID), cwd: root, prompt_id: 'pr-1',
  claude_pid: 4242, entrypoint: 'cli', permission_mode: 'acceptEdits',
});

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
// `routes` overrides the JSON body per `METHOD /url` (e.g. a fake GET
// /api/health naming some other build); everything else answers {ok:true}.
function stubServer(routes = {}) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      let json = null; try { json = body ? JSON.parse(body) : null; } catch {}
      requests.push({ method: req.method, url: req.url, body: json });
      const key = `${req.method} ${req.url}`;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(Object.prototype.hasOwnProperty.call(routes, key) ? routes[key] : { ok: true }));
    });
  });
  return new Promise((resolve) => {
    // Loopback, never the wildcard: a wildcard listen(0) can be given a port
    // another process already holds on 127.0.0.1, and the hook then talks to
    // that process. See test-support/helpers.js's withServer bind.
    server.listen(0, '127.0.0.1', () => resolve({
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
  await turnBegin({ prompt: 'hello' }, { root, ...PROBE, env: {}, now: NOW });
  const posts = stub.requests.filter((r) => r.method === 'POST' && r.url === '/api/turn-begin');
  assert.equal(posts.length, 1);
  // A payload with no session: the lock's message and author, as in 0.8.0, and
  // of envelope v1 only when the hook read stdin and the prompt section.
  assert.deepEqual(posts[0].body, {
    message: 'hello', author: 'user', ts: NOW,
    prompt: { author: 'user', text: 'hello', task_summary: null },
  });
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
  const origGet = client.get;
  const origProbe = portfiles.probeReachable;
  client.post = (p, b, o) => { calls.push({ path: p, opts: o || {} }); return origPost(p, b, o); };
  client.get = (p, o) => { calls.push({ path: p, opts: o || {} }); return origGet(p, o); };
  portfiles.probeReachable = (port, ms) => { probes.push(ms); return origProbe(port, ms); };
  t.after(() => { client.post = origPost; client.get = origGet; portfiles.probeReachable = origProbe; });

  await turnBegin({ prompt: 'hi' }, { root, ...PROBE });
  await turnEnd({}, { root, ...PROBE });
  // A probe that misses: turn-end's best-effort unlock is pinned the same way.
  portfiles.probeReachable = async (port, ms) => { probes.push(ms); return false; };
  await turnEnd({}, { root, ...PROBE });

  assert.deepEqual(calls.map((c) => c.path), ['/api/turn-begin', '/api/queue/pending', '/api/health', '/api/turn-end', '/api/unlock'],
    'every daemon call either hook makes');
  for (const c of calls) {
    assert.equal(c.opts.root, root, `${c.path} must pin the root it was fired for`);
    assert.equal(c.opts.noSpawn, true, `${c.path} must never auto-spawn a daemon`);
    assert.equal(c.opts.port, stub.port);
    // Spec §1.3: an explicit timeout on every call, so a wedged daemon never
    // holds the prompt (or the turn's end) for Claude Code's whole hook budget.
    assert.equal(c.opts.timeout, turnBegin.CALL_TIMEOUT_MS, `${c.path} has its own timeout`);
  }
  assert.equal(turnBegin.CALL_TIMEOUT_MS, 3000, 'three seconds a call');
  assert.deepEqual(probes, [5000, 5000, 5000], 'the probe budget comes from ctx, not a hardcoded 500ms');
});

// --- turn-begin: the daemon runs another build (H-2) ---
//
// The hook runs from ~/.web-chat/current, so after an update it is the NEW
// build, while another project's daemon can stay on the old one for as long as
// a tab is attached. /api/health names the daemon's release from 0.8 on; a
// web-chat instance that answers without one is older than 0.8.

const { packageVersion } = require('../lib/core/versions');

function instanceHealth(extra) {
  return { ok: true, role: 'instance', version: 1, pid: 4242, viewers: 1, ...extra };
}

async function skewStub(t, routes) {
  withTempHome(t);
  const stub = await stubServer(routes);
  t.after(() => stub.close());
  const root = tmpRoot('wc-hook-skew-');
  t.after(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch {} });
  writePortfile(path.join(root, '.web-chat'), { pid: process.pid, port: stub.port });
  return { stub, root };
}

// Exactly one hook frame on stdout, parsed; null when the hook said nothing.
function oneFrame(out) {
  if (!out.trim()) return null;
  const parsed = JSON.parse(out); // throws on two concatenated frames
  return parsed.hookSpecificOutput.additionalContext;
}

test('turn-begin: a pre-0.8 daemon (health names no release) gets one restart line', async (t) => {
  const { root } = await skewStub(t, { 'GET /api/health': instanceHealth({}) });
  const ctx = oneFrame(await captureStdout(() => turnBegin({ prompt: 'hi', session_id: 's1' }, { root, ...PROBE })));
  assert.ok(ctx, 'a browser is watching, so the skew line is the whole frame');
  assert.match(ctx, /surface is running a build older than 0\.8/);
  assert.ok(ctx.includes(`not the installed v${packageVersion()}`));
  assert.match(ctx, /`claude-web-chat restart` in this project/);
  assert.equal(ctx.split('\n').length, 1, 'one line');
});

test('turn-begin: a daemon on another release is named, and rides in the SAME frame as the no-viewer notice', async (t) => {
  const { root } = await skewStub(t, { 'GET /api/health': instanceHealth({ package_version: '0.0.1-old', viewers: 0 }) });
  const ctx = oneFrame(await captureStdout(() => turnBegin({ prompt: 'hi', session_id: 's1' }, { root, ...PROBE })));
  assert.match(ctx, /no browser is watching/, 'the frame the hook already emitted');
  assert.match(ctx, /surface is running v0\.0\.1-old, not the installed v/, 'extended, not a second frame');
});

test('turn-begin: the skew line rides with a parked delivery too', async (t) => {
  const { root } = await skewStub(t, {
    'GET /api/health': instanceHealth({ package_version: '0.0.1-old' }),
    'GET /api/queue/pending': { pending: { id: 'p1', envelope: { content: 'PARKED-SUMMARY' } } },
    'POST /api/queue/pending/consume': { consumed: true },
  });
  const ctx = oneFrame(await captureStdout(() => turnBegin({ prompt: 'hi', session_id: 's1' }, { root, ...PROBE })));
  assert.match(ctx, /Parked delivery/);
  assert.match(ctx, /PARKED-SUMMARY/);
  assert.match(ctx, /claude-web-chat restart/);
});

test('turn-begin: a daemon on THIS build says nothing about builds', async (t) => {
  const { root } = await skewStub(t, { 'GET /api/health': instanceHealth({ package_version: packageVersion() }) });
  const out = await captureStdout(() => turnBegin({ prompt: 'hi', session_id: 's1' }, { root, ...PROBE }));
  assert.equal(out.trim(), '');
});

test('turn-begin: the skew line is said once per session per daemon, not every prompt', async (t) => {
  const { root } = await skewStub(t, { 'GET /api/health': instanceHealth({ package_version: '0.0.1-old' }) });
  const run = (sid) => captureStdout(() => turnBegin({ prompt: 'hi', session_id: sid }, { root, ...PROBE }));
  assert.match(oneFrame(await run('s1')), /claude-web-chat restart/);
  assert.equal((await run('s1')).trim(), '', 'the same session already has it in context');
  assert.match(oneFrame(await run('s2')), /claude-web-chat restart/, 'another session has not seen it');
});

test('skewLine: only a web-chat instance that answered is judged; a match is silent', () => {
  const { skewLine } = turnBegin;
  assert.equal(skewLine(null, '0.8.0'), null, 'no health, no claim');
  assert.equal(skewLine({ ok: true }, '0.8.0'), null, 'not an instance health: never guess a build');
  assert.equal(skewLine({ ok: true, role: 'hub' }, '0.8.0'), null);
  assert.equal(skewLine(instanceHealth({ package_version: '0.8.0' }), '0.8.0'), null);
  assert.match(skewLine(instanceHealth({ package_version: '0.8.1' }), '0.8.0'), /running v0\.8\.1, not the installed v0\.8\.0/);
  assert.match(skewLine(instanceHealth({}), '0.8.0'), /running a build older than 0\.8, not the installed v0\.8\.0/);
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
  await turnEnd({}, { root, ...PROBE, env: {}, now: NOW });
  const posts = stub.requests.filter((r) => r.method === 'POST' && r.url === '/api/turn-end');
  assert.equal(posts.length, 1);
  // A payload with no session: 0.8.0's author, and of 0.8.5's fields only how
  // the turn ended (a Stop) and when the hook read stdin.
  assert.deepEqual(posts[0].body, { author: 'claude', ended: 'stop', ts: NOW });
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

// --- the session a turn hook speaks for (in process; spec §3.1, §1.3) ---

test('turn-begin: the post carries the session and the prompt section; a typed prompt\'s lock message and author stay 0.8.0\'s, a task notification\'s are the task\'s', async (t) => {
  withTempHome(t);
  const stub = await stubServer();
  t.after(() => stub.close());
  const root = tmpRoot('wc-hook-');
  writePortfile(path.join(root, '.web-chat'), { pid: process.pid, port: stub.port });
  const posted = async (payload, env = ENV) => {
    await turnBegin(payload, { root, ...PROBE, env, now: NOW });
    return stub.requests.filter((r) => r.method === 'POST' && r.url === '/api/turn-begin').pop().body;
  };

  assert.deepEqual(await posted(promptPayload(root)), {
    message: 'hello there', author: 'user', ...SESSION(root),
    prompt: { author: 'user', text: 'hello there', task_summary: null },
  });

  // A background task's completion arrives as a prompt (V3, V5): the envelope
  // says so — authored 'task', with its <summary> on one line — and from
  // tranche 2 (U30, spec §3.1 step 2) so does the lock: author 'task', message
  // `background task: <summary>`. (Until U30 this asserted the lock kept
  // 0.8.0's author 'user' and the raw notification as its message.)
  const note = '<task-notification>\n<task-id>b7</task-id>\n<summary>Background command "npm test"\n  completed</summary>\n</task-notification>';
  const task = await posted(promptPayload(root, { prompt: note }));
  assert.equal(task.message, 'background task: Background command "npm test" completed');
  assert.equal(task.author, 'task');
  assert.deepEqual(task.prompt, { author: 'task', text: note, task_summary: 'Background command "npm test" completed' });

  // A prompt past the envelope's cap: the lock keeps it whole, as it always
  // has; the envelope's copy is cut to 16 KiB.
  const long = `${'x'.repeat(CAPS.prompt_text)}TAIL`;
  const big = await posted(promptPayload(root, { prompt: long }));
  assert.equal(big.message, long);
  assert.equal(big.prompt.text, 'x'.repeat(CAPS.prompt_text));

  // The environment gives the pid and the entrypoint, and nothing else rides.
  await posted(promptPayload(root), { ...ENV, CLAUDE_CODE_MESSAGING_TOKEN: 'MESSAGING-TOKEN-VALUE', SECRET_THING: 'S3CR3T' });
  const wire = JSON.stringify(stub.requests);
  assert.ok(!wire.includes('MESSAGING-TOKEN-VALUE') && !wire.includes('S3CR3T'), 'no other environment value leaves the hook');
});

test('turn-end: a Stop posts ended "stop", the session, the bounded background tasks and the final reply; a StopFailure posts "failed" and its error', async (t) => {
  withTempHome(t);
  const stub = await stubServer();
  t.after(() => stub.close());
  const root = tmpRoot('wc-hook-');
  writePortfile(path.join(root, '.web-chat'), { pid: process.pid, port: stub.port });
  const posted = async (payload) => {
    await turnEnd(payload, { root, ...PROBE, env: ENV, now: NOW });
    return stub.requests.filter((r) => r.method === 'POST' && r.url === '/api/turn-end').pop().body;
  };

  // Sixty tasks still running, each over its caps, and a reply past 4,000
  // characters (V3: Stop's own fields).
  const tasks = Array.from({ length: 60 }, (_, i) => ({
    id: `b${i}`, type: 'shell', status: 'running', description: 'd'.repeat(250), command: null, agent_type: 'a'.repeat(70), extra: 'not v1',
  }));
  const reply = `${'r'.repeat(CAPS.last_assistant_message)}TAIL`;
  const stop = await posted(stopPayload(root, { last_assistant_message: reply, background_tasks: tasks }));
  assert.deepEqual(Object.keys(stop), ['author', 'reply', 'ended', ...Object.keys(SESSION(root)), 'background_tasks', 'last_assistant_message']);
  assert.equal(stop.author, 'claude');
  assert.equal(stop.reply, summarizeReply(reply), 'the node\'s reply summary is unchanged (hooks/reply.js)');
  assert.equal(stop.ended, 'stop');
  for (const [k, v] of Object.entries(SESSION(root))) assert.deepEqual(stop[k], v, k);
  assert.equal(stop.background_tasks.length, CAPS.background_tasks, 'at most 50');
  assert.deepEqual(stop.background_tasks[49], {
    id: 'b49', type: 'shell', status: 'running', description: 'd'.repeat(CAPS.task_description), command: null,
    agent_type: 'a'.repeat(CAPS.task_agent_type),
  }, 'each task in v1\'s shape, its strings cut to their caps');
  assert.equal(stop.last_assistant_message, 'r'.repeat(CAPS.last_assistant_message), 'the final reply, at most 4,000 characters');

  // The API failed instead (V3: StopFailure carries `error`).
  const failed = await posted(stopPayload(root, {
    hook_event_name: 'StopFailure', error: `model_not_found: ${'e'.repeat(1000)}`, last_assistant_message: 'API Error', background_tasks: undefined,
  }));
  assert.equal(failed.ended, 'failed');
  assert.equal(failed.error, `model_not_found: ${'e'.repeat(CAPS.stop_error - 17)}`, 'the error, at most 500 characters');
  assert.equal(failed.background_tasks, undefined, 'none reported, none sent');
  assert.equal(failed.last_assistant_message, 'API Error');
});

// --- run as Claude Code runs them (subprocess) ---

// The real bin, the payload on stdin, the environment given. Resolves when it
// exits, or SIGKILLs it past killAfterMs (the dispatcher's hard exit is 20 s,
// so by default a hook is never killed before it could end itself).
function runHookAsync(args, { cwd, env, input, nodeArgs = [], killAfterMs = 25000 }) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const child = spawn(process.execPath, [...nodeArgs, HOOK_BIN, ...args], { cwd, env: { ...process.env, ...env } });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (c) => { stdout += c; });
    child.stderr.on('data', (c) => { stderr += c; });
    child.stdin.on('error', () => {});
    const killer = setTimeout(() => child.kill('SIGKILL'), killAfterMs);
    child.on('error', (e) => { clearTimeout(killer); reject(e); });
    child.on('close', (status, signal) => { clearTimeout(killer); resolve({ status, signal, stdout, stderr, ms: Date.now() - started }); });
    child.stdin.end(JSON.stringify(input));
  });
}

// The dispatcher builds the hook's ctx itself, so the liveness probe runs on
// its 500 ms default there. A preload widens it to PROBE's budget, as ctx does
// in process: a wall-clock bet on a loaded machine is not what these test.
function probePreload(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-hook-preload-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'probe.js');
  fs.writeFileSync(file, [
    `const portfiles = require(${JSON.stringify(require.resolve('../lib/core/portfiles'))});`,
    'const probe = portfiles.probeReachable;',
    `portfiles.probeReachable = (port) => probe(port, ${PROBE.probeMs});`,
    '',
  ].join('\n'));
  return ['--require', file];
}

// A daemon for a hook process: answers every request {ok:true} (the liveness
// probe included) but those `wedge` names, which it reads and never answers.
// Records each request, when it arrived and when its socket closed.
async function hookDaemon(t, { wedge = () => false } = {}) {
  const requests = [];
  const sockets = new Set();
  const server = http.createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      let json = null;
      try { json = body ? JSON.parse(body) : null; } catch {}
      const rec = { method: req.method, url: req.url, headers: req.headers, body: json, arrivedAt: Date.now(), closedAt: null };
      requests.push(rec);
      req.socket.once('close', () => { rec.closedAt = Date.now(); });
      if (wedge(req)) return;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"ok":true}');
    });
  });
  server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => { for (const s of sockets) s.destroy(); return new Promise((r) => server.close(r)); });
  return { port: server.address().port, requests };
}

// A project the hooks find from the payload's cwd, its portfile naming `port`.
function hookProject(t, port) {
  const root = tmpRoot('wc-hook-sub-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  writePortfile(path.join(root, '.web-chat'), { pid: process.pid, port });
  return root;
}

test('turn-begin and turn-end, run as Claude Code runs them, post the session fields, `ended`, `error` and the bounded background tasks', async (t) => {
  const home = withTempHome(t);
  const daemon = await hookDaemon(t);
  const root = hookProject(t, daemon.port);
  const env = { HOME: home, USERPROFILE: home, ...ENV, CLAUDE_CODE_MESSAGING_TOKEN: 'MESSAGING-TOKEN-VALUE' };
  const nodeArgs = probePreload(t);
  const run = (sub, input) => runHookAsync([sub], { cwd: root, env, input, nodeArgs });
  const post = (url) => daemon.requests.filter((r) => r.method === 'POST' && r.url === url);

  const before = Date.now();
  const begin = await run('turn-begin', promptPayload(root));
  assert.deepEqual([begin.status, begin.signal, begin.stdout, begin.stderr], [0, null, '', '']);
  assert.equal(post('/api/turn-begin').length, 1);
  const tb = post('/api/turn-begin')[0];
  assert.ok(tb.body.ts >= before && tb.body.ts <= Date.now(), 'ts: when the hook read stdin');
  assert.deepEqual(tb.body, {
    message: 'hello there', author: 'user', ...SESSION(root, tb.body.ts),
    prompt: { author: 'user', text: 'hello there', task_summary: null },
  });
  // Through lib/client: no Origin and no Sec-Fetch-*, which is what makes it
  // the host's request at the route (spec §5.4).
  assert.equal(tb.headers.origin, undefined);
  assert.equal(tb.headers['sec-fetch-mode'], undefined);

  const tasks = Array.from({ length: 55 }, (_, i) => ({ id: `b${i}`, type: 'subagent', status: 'running', description: 'x'.repeat(300), agent_type: 'Explore' }));
  const end = await run('turn-end', stopPayload(root, { background_tasks: tasks }));
  assert.deepEqual([end.status, end.signal, end.stdout], [0, null, '']);
  const te = post('/api/turn-end')[0].body;
  assert.equal(te.ended, 'stop');
  assert.equal(te.reply, 'Done. The build passes.');
  assert.equal(te.last_assistant_message, 'Done. The build passes.');
  assert.deepEqual({ ...te, ts: 0, background_tasks: [] }, {
    author: 'claude', reply: 'Done. The build passes.', ended: 'stop', ...SESSION(root, 0), background_tasks: [],
    last_assistant_message: 'Done. The build passes.',
  });
  assert.equal(te.background_tasks.length, CAPS.background_tasks);
  assert.deepEqual(te.background_tasks[0], {
    id: 'b0', type: 'subagent', status: 'running', description: 'x'.repeat(CAPS.task_description), command: null, agent_type: 'Explore',
  });

  const failure = await run('turn-end', stopPayload(root, { hook_event_name: 'StopFailure', error: 'e'.repeat(900), last_assistant_message: 'API Error' }));
  assert.deepEqual([failure.status, failure.signal], [0, null]);
  const tf = post('/api/turn-end')[1].body;
  assert.equal(tf.ended, 'failed');
  assert.equal(tf.error, 'e'.repeat(CAPS.stop_error));
  assert.equal(tf.session_id, SID);

  assert.ok(!JSON.stringify(daemon.requests).includes('MESSAGING-TOKEN-VALUE'), 'the messaging token never leaves a hook');
});

test('turn-begin and turn-end end themselves on a wedged daemon: every call has its own 3 s timeout', async (t) => {
  const home = withTempHome(t);
  // The probe is answered, so the daemon looks alive; the turn post is read
  // and never answered: a daemon wedged mid-request.
  const wedged = (req) => req.method === 'POST' && (req.url === '/api/turn-begin' || req.url === '/api/turn-end');
  const daemon = await hookDaemon(t, { wedge: wedged });
  const root = hookProject(t, daemon.port);
  const env = { HOME: home, USERPROFILE: home, ...ENV };
  const nodeArgs = probePreload(t);
  const run = (sub, input) => runHookAsync([sub], { cwd: root, env, input, nodeArgs });

  const [begin, end] = await Promise.all([run('turn-begin', promptPayload(root)), run('turn-end', stopPayload(root))]);
  for (const [name, r] of [['turn-begin', begin], ['turn-end', end]]) {
    assert.equal(r.signal, null, `${name}: it exited by itself`);
    assert.equal(r.status, 0, `${name}: exit 0, as every hook does`);
    assert.equal(r.stdout, '', `${name}: says nothing`);
  }
  // Only a call's own timeout writes these lines: the dispatcher's hard exit
  // (20 s) ends a process without a word, and before 0.8.5 nothing else would
  // have ended these two.
  const log = fs.readFileSync(path.join(root, '.web-chat', 'hook.log'), 'utf8');
  assert.match(log, new RegExp(`turn-begin UserPromptSubmit session=${SID} error timeout`));
  assert.match(log, new RegExp(`turn-end Stop session=${SID} error timeout`));
  assert.ok(!/hello there/.test(log), 'ids and outcomes only');

  const posts = daemon.requests.filter((r) => wedged(r));
  assert.deepEqual(posts.map((r) => r.url).sort(), ['/api/turn-begin', '/api/turn-end'], 'each posted once, never retried');
  await waitUntil(() => posts.every((r) => r.closedAt !== null), { what: 'the hooks\' sockets to close', timeout: 5000 });
  for (const r of posts) {
    const held = r.closedAt - r.arrivedAt;
    t.diagnostic(`${r.url}: request held ${held} ms (timeout ${turnBegin.CALL_TIMEOUT_MS} ms; hard exit 20000 ms)`);
    if (PERF) assert.ok(held < turnBegin.CALL_TIMEOUT_MS + 1500, `${r.url} held ${held} ms`);
  }
  t.diagnostic(`processes: turn-begin ${begin.ms} ms, turn-end ${end.ms} ms`);
});

// --- the turn routes' envelopes (lib/server/routes/graph.js; spec §1.4, §3.1, §5.7 P1′) ---

// The graph routes on a BARE Express app with a fake ctx (spec §10.1): a real
// graph, a real hook tap and the real audience with no opt-in. A request with
// x-test-peer is a network peer: its socket reports that address while the
// route runs (the turn routes answer synchronously), as in test/audience.test.js.
async function turnHost(t, { audience = createAudience({ configFile: null }), hooks = createHookTap() } = {}) {
  const root = tmpRoot('wc-turn-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const paths = resolvePaths(root);
  const state = createState();
  const bus = createBus();
  const graph = createGraph({ paths, state, draftPath: projectPaths(root).draft });
  graph.load();
  const app = express();
  app.use(express.json({ limit: '200mb' }));
  app.use((req, res, next) => {
    const addr = req.headers['x-test-peer'];
    if (!addr) return next();
    const real = req.socket;
    req.socket = { remoteAddress: addr };
    try { next(); } finally { req.socket = real; }
  });
  const ctx = { graph, paths, bus, broadcastReset: () => {}, audience, hooks };
  mountGraphRoutes(app, ctx);
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => { server.closeAllConnections(); server.close(r); }));
  const port = server.address().port;
  // Each envelope the tap took, with the lock and the node count it was taken
  // under.
  const seen = [];
  if (hooks && typeof hooks.subscribe === 'function') {
    hooks.subscribe((entry) => seen.push({ entry, lock: graph.lock ? { ...graph.lock } : null, nodes: graph.nodes.size }));
  }
  return {
    root, port, ctx, graph, state, bus, tap: hooks, seen,
    // A host process: lib/client, no Origin, no Sec-Fetch-*.
    post: (p, body, headers) => request(port, 'POST', p, body, { headers, timeout: 10000 }),
    // A page: Node's fetch sends sec-fetch-mode, as every browser does.
    fetch: async (p, body, headers = {}) => {
      const r = await fetch(`http://127.0.0.1:${port}${p}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body),
      });
      return { status: r.status, body: await r.json() };
    },
  };
}

// The envelope a tap entry carries: the entry without the tap's own seq and kind.
function envelopeOf(entry) {
  assert.equal(entry.kind, 'hook', 'a hook entry on the tap');
  const { seq: _seq, kind: _kind, ...envelope } = entry;
  return envelope;
}

// Envelope v1 for a turn event (lib/hooks/envelope.js's shape), all null but
// what is given.
const turnEnvelope = (fields) => ({
  v: 1, agent: null, tool: null, result: null, session: null, compact: null, stop: null, prompt: null, ask: null, ...fields,
});

const LOCK_0_8_0 = ['author', 'base', 'message', 'started_at'];
const RING_0_8_0 = ['base', 'kind', 'op', 'seq', 'stole_stale_lock', 'ts'];

test('turn routes: a host turn-begin publishes one UserPromptSubmit envelope before the lock logic, and a 409 still records its turn', async (t) => {
  const h = await turnHost(t);
  const A = { ...SESSION(h.root), session_id: 'sess-a', prompt_id: 'pr-a' };
  const promptA = { author: 'user', text: 'first prompt', task_summary: null };
  const r1 = await h.post('/api/turn-begin', { message: 'first prompt', author: 'user', ...A, prompt: promptA });
  assert.equal(r1.status, 200);
  assert.equal(h.seen.length, 1, 'one envelope');
  assert.equal(h.seen[0].lock, null, 'on the tap before the lock was taken: before the lock logic');
  const env = envelopeOf(h.seen[0].entry);
  assert.deepStrictEqual(env, turnEnvelope({ event: 'UserPromptSubmit', ...A, prompt: promptA }));
  assert.deepStrictEqual(Object.keys(env).sort(), [...ENVELOPE_KEYS].sort(), 'envelope v1, every key');
  assert.equal(h.seen[0].entry.ts, NOW, 'the hook\'s ts, not the tap\'s');
  assert.equal(h.graph.lock.message, 'first prompt');

  // A second session's prompt while the first turn holds the lock: 409, as in
  // 0.8.0 — and its turn is on the tap all the same.
  const B = { ...A, session_id: 'sess-b', prompt_id: 'pr-b', claude_pid: 5151 };
  const r2 = await h.post('/api/turn-begin', { message: 'second prompt', author: 'user', ...B, prompt: { ...promptA, text: 'second prompt' } });
  assert.equal(r2.status, 409);
  assert.equal(r2.body.lock.message, 'first prompt', 'a local caller is told the lock it ran into, as in 0.8.0');
  assert.equal(h.seen.length, 2, 'the concurrent session\'s turn is recorded');
  assert.equal(h.seen[1].lock.message, 'first prompt', 'published while the first turn held the lock');
  assert.deepStrictEqual(envelopeOf(h.seen[1].entry), turnEnvelope({ event: 'UserPromptSubmit', ...B, prompt: { ...promptA, text: 'second prompt' } }));
  assert.deepStrictEqual(h.tap.recent().map((e) => [e.event, e.session_id]), [['UserPromptSubmit', 'sess-a'], ['UserPromptSubmit', 'sess-b']]);
  assert.equal(h.graph.lock.message, 'first prompt', 'the lock is still the first turn\'s');
});

test('turn routes: a page\'s, a remote viewer\'s and a network peer\'s turn requests publish nothing and stay session-less; the lock is 0.8.0\'s', async (t) => {
  const callers = {
    'a page (fetch)': (h, p, body) => h.fetch(p, body),
    'a pane naming its Origin': (h, p, body) => h.post(p, body, { Origin: `http://127.0.0.1:${h.port}` }),
    'a remote viewer (the portal\'s label)': (h, p, body) => h.post(p, body, { 'X-WC-Remote': '1' }),
    'a network peer (Q9)': (h, p, body) => h.post(p, body, { 'x-test-peer': '10.0.0.7' }),
  };
  for (const [who, call] of Object.entries(callers)) {
    const h = await turnHost(t);
    const S = SESSION(h.root);
    const begin = await call(h, '/api/turn-begin', { message: 'a prompt', author: 'user', ...S, prompt: { author: 'user', text: 'a prompt', task_summary: null } });
    assert.equal(begin.status, 200, who);
    assert.deepStrictEqual(Object.keys(begin.body).sort(), ['lock', 'ok', 'stole_stale_lock'], `${who}: 0.8.0's answer`);
    assert.deepStrictEqual(Object.keys(h.graph.lock).sort(), LOCK_0_8_0, `${who}: the lock records no session`);
    assert.equal(h.graph.lock.message, 'a prompt');
    const ev = h.bus.events.find((e) => e.kind === 'graph' && e.op === 'turn-begin');
    assert.deepStrictEqual(Object.keys(ev).sort(), RING_0_8_0, `${who}: the ring event is 0.8.0's`);

    h.state.store.k = 1; // the turn changed the surface: turn-end commits it
    const end = await call(h, '/api/turn-end', { author: 'claude', reply: 'ok', ended: 'failed', error: 'e', ...S, background_tasks: [] });
    assert.equal(end.status, 200, who);
    assert.ok(end.body.node_id, `${who}: the turn committed, as in 0.8.0`);
    assert.equal(h.graph.lock, null);
    assert.deepStrictEqual(h.tap.recent(), [], `${who}: nothing on the tap`);
    const node = h.graph.nodes.get(end.body.node_id);
    assert.deepStrictEqual({ message: node.trigger.message, reply: node.trigger.reply }, { message: 'a prompt', reply: 'ok' });
  }
});

test('turn routes: a host turn-end publishes Stop — StopFailure for ended "failed" — before it commits; a page\'s publishes nothing', async (t) => {
  const h = await turnHost(t);
  const S = SESSION(h.root);
  await h.post('/api/turn-begin', { message: 'build it', author: 'user', ...S, prompt: { author: 'user', text: 'build it', task_summary: null } });
  h.state.store.k = 1;
  const tasks = [{ id: 'b1', type: 'shell', status: 'running', description: 'dev server', command: 'npm run dev', agent_type: null }];
  const r = await h.post('/api/turn-end', {
    author: 'claude', reply: 'Done.', ended: 'stop', ...S, ts: NOW + 5, background_tasks: tasks, last_assistant_message: 'Done. The build passes.',
  });
  assert.equal(r.status, 200);
  assert.ok(r.body.node_id, 'the turn committed its node, as in 0.8.0');
  const stop = h.seen[1];
  assert.equal(stop.lock && stop.lock.message, 'build it', 'on the tap while the turn still held the lock');
  assert.equal(stop.nodes, 0, 'and before its node was committed');
  assert.deepStrictEqual(envelopeOf(stop.entry), turnEnvelope({
    event: 'Stop', ...S, ts: NOW + 5,
    stop: { last_assistant_message: 'Done. The build passes.', agent_transcript_path: null, background_tasks: tasks, error: null },
  }));

  // StopFailure: a turn that changed nothing folds, as in 0.8.0, and its
  // failure is on the tap first.
  await h.post('/api/turn-begin', { message: 'again', author: 'user', ...S });
  const f = await h.post('/api/turn-end', { author: 'claude', ended: 'failed', error: 'model_not_found', ...S, last_assistant_message: 'API Error' });
  assert.deepStrictEqual([f.status, f.body.skipped], [200, 'no-change']);
  assert.deepStrictEqual(envelopeOf(h.seen[3].entry), turnEnvelope({
    event: 'StopFailure', ...S,
    stop: { last_assistant_message: 'API Error', agent_transcript_path: null, background_tasks: null, error: 'model_not_found' },
  }));

  // A Stop with no lock (the turn that spawned the daemon) is on the tap too.
  const lockless = await h.post('/api/turn-end', { author: 'claude', ended: 'stop', ...S });
  assert.deepStrictEqual([lockless.status, lockless.body.skipped], [200, 'no-lock']);
  assert.equal(h.tap.recent().length, 5);
  assert.equal(h.tap.recent()[4].event, 'Stop');

  // A page's turn changes the lock exactly as before and puts nothing on the tap.
  await h.fetch('/api/turn-begin', { message: 'from a page', ...S });
  await h.fetch('/api/turn-end', { author: 'claude', ended: 'failed', error: 'e', ...S });
  assert.equal(h.tap.recent().length, 5, 'a page publishes nothing');
});

test('turn routes: a session field of the wrong type is dropped; an oversized envelope, a missing tap or audience, or one that throws never stand in the lock\'s way', async (t) => {
  // Each field taken only at envelope v1's type; anything else is null.
  const h = await turnHost(t);
  const r = await h.post('/api/turn-begin', {
    message: 'm', session_id: 42, transcript_path: ['x'], cwd: { a: 1 }, prompt_id: null, claude_pid: 1,
    entrypoint: true, permission_mode: 7, ts: 'soon', prompt: { author: 'wake', text: 'm' },
  });
  assert.equal(r.status, 200);
  const env = envelopeOf(h.tap.recent()[0]);
  for (const k of ['session_id', 'transcript_path', 'cwd', 'prompt_id', 'claude_pid', 'entrypoint', 'permission_mode', 'prompt']) {
    assert.equal(env[k], null, k);
  }
  assert.ok(Number.isFinite(env.ts) && env.ts > NOW, 'a ts that is no time: now');
  for (const [pid, want] of [[1.5, null], [-3, null], [2, 2], [Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER], ['4242', null]]) {
    await h.post('/api/unlock', {});
    await h.post('/api/turn-begin', { message: 'm', claude_pid: pid });
    assert.equal(h.tap.recent().pop().claude_pid, want, `claude_pid ${JSON.stringify(pid)}`);
  }
  await h.post('/api/turn-end', { author: 'claude', ended: 'done', background_tasks: [{ id: 'b1' }, 'x'], last_assistant_message: 5, error: {} });
  const st = envelopeOf(h.tap.recent().pop());
  assert.equal(st.event, 'Stop', 'an `ended` that is not "failed" is a Stop');
  assert.deepStrictEqual(st.stop, { last_assistant_message: null, agent_transcript_path: null, background_tasks: null, error: null });

  // Over what the hook intake takes: not published; the lock is taken.
  const big = await turnHost(t);
  const rb = await big.post('/api/turn-begin', { message: 'm', prompt: { author: 'user', text: 'x'.repeat(MAX_BODY_BYTES), task_summary: null } });
  assert.equal(rb.status, 200);
  assert.ok(big.graph.lock, 'the lock is taken');
  assert.deepStrictEqual(big.tap.recent(), [], 'nothing published');

  // No tap: the lock works as ever.
  const noTap = await turnHost(t, { hooks: null });
  assert.equal((await noTap.post('/api/turn-begin', { message: 'm', session_id: SID })).status, 200);
  assert.equal((await noTap.post('/api/turn-end', { author: 'claude', session_id: SID })).status, 200);

  // No audience on ctx: no request is the host — fail closed.
  const noAudience = await turnHost(t, { audience: null });
  assert.equal((await noAudience.post('/api/turn-begin', { message: 'm', session_id: SID })).status, 200);
  assert.ok(noAudience.graph.lock);
  assert.deepStrictEqual(noAudience.tap.recent(), [], 'without an audience nothing is published');

  // An audience that throws is no host; a tap that throws is no publish.
  const throwing = await turnHost(t, { audience: { isHost() { throw new Error('boom'); }, levelOf() { throw new Error('boom'); } } });
  assert.equal((await throwing.post('/api/turn-begin', { message: 'm', session_id: SID })).status, 200);
  assert.deepStrictEqual(throwing.tap.recent(), []);
  const badTap = await turnHost(t, { hooks: { publish() { throw new Error('boom'); } } });
  assert.equal((await badTap.post('/api/turn-begin', { message: 'm', session_id: SID })).status, 200);
  assert.ok(badTap.graph.lock);
  assert.equal((await badTap.post('/api/turn-end', { author: 'claude', session_id: SID })).status, 200);
  assert.equal(badTap.graph.lock, null);
});

test('turn routes: the real turn hooks reach the tap through them, as the host, with exactly the envelope they built', async (t) => {
  withTempHome(t);
  const h = await turnHost(t);
  writePortfile(path.join(h.root, '.web-chat'), { pid: process.pid, port: h.port });
  await turnBegin(promptPayload(h.root), { root: h.root, ...PROBE, env: ENV, now: NOW });
  h.state.store.k = 1;
  const tasks = [{ id: 'b1', type: 'shell', status: 'running', description: 'dev server', command: 'npm run dev' }];
  await turnEnd(stopPayload(h.root, { background_tasks: tasks }), { root: h.root, ...PROBE, env: ENV, now: NOW + 9 });

  const [begin, end] = h.tap.recent();
  assert.deepStrictEqual(envelopeOf(begin), hookEnvelope(promptPayload(h.root), ENV, { now: NOW }),
    'UserPromptSubmit: what envelope.js builds for the payload, field for field');
  assert.deepStrictEqual(envelopeOf(end), hookEnvelope(stopPayload(h.root, { background_tasks: tasks }), ENV, { now: NOW + 9 }),
    'Stop: likewise');
  assert.ok(h.graph.nodes.size === 1 && h.graph.lock === null, 'and the turn committed its node');
});
