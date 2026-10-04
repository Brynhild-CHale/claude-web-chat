// The hook tap (lib/server/hook-tap.js) and its intake, POST /api/hooks/event
// (lib/server/routes/hooks.js) — spec §1.4, §5.4, §5.7 (class P1).
//
// The route is mounted on a BARE Express app with a fake ctx (spec §10.1): a
// fake audience that decides exactly as lib/server/audience.js's isHost does
// (§5.4: a loopback peer, not a remote viewer, sending no Origin or
// Sec-Fetch-*), and a real tap. Tranche 1's integration unit proves the wired
// path with withServer.
//
// Who is refused, and how each is simulated:
//   a browser (a pane's fetch)  Node's fetch, which sends sec-fetch-mode, or an
//                               explicit Origin
//   a remote viewer             X-WC-Remote: 1 from loopback, what the portal sends
//   a network peer (Q9)         a peer address the fake audience reads from a
//                               test header in place of req.socket.remoteAddress
// and none of them can publish on the tap. A hook's own request, through
// lib/client, is the host — including the real mirror hook, run as Claude Code
// runs it, at the end.
//
// Two hosts: one with the daemon's global JSON parser in front (express.json at
// 200 MB, as lib/server/index.js mounts it), where the route must still hold its
// 64 KB cap, and one without, where the route parses for itself.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const express = require('express');
const { spawn } = require('child_process');

const { createHookTap, TAP_MAX } = require('../lib/server/hook-tap');
const {
  mountHookRoutes, checkEnvelope, INTAKE_EVENTS, ENVELOPE_KEYS, MAX_BODY_BYTES,
} = require('../lib/server/routes/hooks');
const { hookEnvelope, EVENTS } = require('../lib/hooks/envelope');
const { MIRROR_EVENTS } = require('../lib/hooks/mirror');
const { request } = require('../lib/client');
const { isBrowserRequest, isRemoteRequest } = require('../lib/core/cors');
const { classify } = require('../lib/core/remote-policy');
const { hookHandlers } = require('../lib/setup/registration');
const { writePortfileAt } = require('../lib/core/portfiles');
const { tmpRoot, waitUntil } = require('../test-support/helpers');

const HOOK_BIN = path.join(__dirname, '..', 'bin', 'claude-web-chat-hook.js');
const SID = '9d1e2f3a-4b5c-4d6e-8f70-81a2b3c4d5e6';

// ── the fake audience (spec §5.4) ───────────────────────────────────────────

function isLoopback(addr) {
  return typeof addr === 'string' && (/^127\./.test(addr) || addr === '::1' || /^::ffff:127\./i.test(addr));
}

function fakeAudience() {
  const peerOf = (req) => req.headers['x-test-peer'] || (req.socket && req.socket.remoteAddress);
  const levelOf = (req) => {
    if (!isLoopback(peerOf(req))) return 'basic'; // a network peer, always (Q9)
    if (isRemoteRequest(req)) return 'basic'; // a remote viewer of a project that has not opted in
    return 'local';
  };
  return { levelOf, isHost: (req) => levelOf(req) === 'local' && !isBrowserRequest(req.headers) };
}

// ── the host ────────────────────────────────────────────────────────────────

async function intakeHost(t, { globalJson = true, ctx } = {}) {
  const tap = createHookTap();
  const app = express();
  let lastRes = null;
  const bodies = [];
  app.use((req, res, next) => { lastRes = res; next(); });
  if (globalJson) {
    app.use(express.json({ limit: '200mb' }));
    app.use((req, res, next) => { if (req.method === 'POST') bodies.push(req.body); next(); });
  }
  mountHookRoutes(app, ctx || { audience: fakeAudience(), hooks: tap });
  // The daemon has no error handler of its own: Express answers the global
  // parser's refusals with their status. The same status here, without
  // Express printing each stack to the test's stderr.
  app.use((err, req, res, next) => { res.status(err.status || 500).json({ ok: false }); }); // eslint-disable-line no-unused-vars
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => server.close(r)));
  const port = server.address().port;
  return {
    port,
    tap,
    bodies,
    lastRes: () => lastRes,
    // A host process: lib/client, no Origin, no Sec-Fetch-*.
    post: (body, headers) => request(port, 'POST', '/api/hooks/event', body, { headers }),
    // A page: Node's fetch sends sec-fetch-mode, like any browser.
    fetch: async (body, headers = {}) => {
      const r = await fetch(`http://127.0.0.1:${port}/api/hooks/event`, {
        method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body),
      });
      let json = null;
      try { json = await r.json(); } catch {}
      return { status: r.status, body: json };
    },
    // A body with no Content-Length (Transfer-Encoding: chunked).
    chunked: (text) => new Promise((resolve, reject) => {
      const req = http.request({
        hostname: '127.0.0.1', port, path: '/api/hooks/event', method: 'POST',
        headers: { 'content-type': 'application/json', 'transfer-encoding': 'chunked' },
      }, (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { data += c; });
        res.on('end', () => { let json = null; try { json = JSON.parse(data); } catch {} resolve({ status: res.statusCode, body: json }); });
      });
      req.on('error', reject);
      for (let i = 0; i < text.length; i += 8192) req.write(text.slice(i, i + 8192));
      req.end();
    }),
  };
}

function envelope(event = 'PreToolUse', extra = {}) {
  const payload = {
    session_id: SID, transcript_path: `/u/.claude/projects/-u-p/${SID}.jsonl`, cwd: '/u/p', prompt_id: 'pr-1',
    hook_event_name: event, tool_name: 'Bash', tool_input: { command: 'npm test' }, tool_use_id: 'toolu_1',
    tool_response: { backgroundTaskId: 'b1' }, duration_ms: 4, source: 'startup', reason: 'other', trigger: 'auto',
    agent_id: 'a1', agent_type: 'Explore', last_assistant_message: 'ok', background_tasks: [], error: 'x', prompt: 'hi',
  };
  return { ...hookEnvelope(payload, { CLAUDE_PID: '4242', CLAUDE_CODE_ENTRYPOINT: 'cli' }, { now: 1790000000123 }), ...extra };
}

// ── the tap ─────────────────────────────────────────────────────────────────

test('tap: a three-function adapter over a bus with no broadcaster', () => {
  const tap = createHookTap();
  assert.deepEqual(Object.keys(tap), ['publish', 'subscribe', 'recent']);
  assert.equal(TAP_MAX, 200);
  assert.equal(typeof tap.setBroadcaster, 'undefined', 'nothing can bind a socket to it');
});

test('tap: an entry keeps the envelope\'s own ts; seq and kind are the tap\'s', () => {
  const tap = createHookTap();
  const env = envelope();
  const built = tap.publish(env);
  assert.equal(built.ts, env.ts, 'when the hook read stdin, not when the daemon heard of it');
  assert.equal(built.seq, 1);
  assert.equal(built.kind, 'hook');
  assert.equal(built.event, 'PreToolUse');
  assert.deepEqual(tap.recent(), [built]);

  const forged = tap.publish({ ...envelope(), seq: 999, kind: 'store' });
  assert.equal(forged.seq, 2, 'an envelope cannot move the ring\'s cursor');
  assert.equal(forged.kind, 'hook');

  const before = Date.now();
  const bare = tap.publish({ v: 1, event: 'SessionStart' });
  assert.ok(bare.ts >= before, 'an envelope without one gets the bus\'s');

  for (const v of [null, undefined, 'x', 7, [envelope()]]) assert.equal(tap.publish(v), null);
  assert.equal(tap.recent().length, 3);
});

test('tap: subscribers run in registration order, each in its own try/catch', () => {
  const tap = createHookTap();
  const seen = [];
  tap.subscribe((e) => seen.push(`a${e.seq}`));
  tap.subscribe(() => { throw new Error('a subscriber that throws'); });
  const off = tap.subscribe((e) => seen.push(`c${e.seq}`));
  tap.subscribe((e) => seen.push(`d${e.seq}`));
  assert.doesNotThrow(() => tap.publish(envelope()));
  assert.doesNotThrow(() => tap.publish(envelope()));
  assert.deepEqual(seen, ['a1', 'c1', 'd1', 'a2', 'c2', 'd2']);
  off();
  tap.publish(envelope());
  assert.deepEqual(seen.slice(6), ['a3', 'd3'], 'unsubscribed');
});

test('tap: a ring of 200, read back as copies', () => {
  const tap = createHookTap();
  for (let i = 0; i < 205; i++) tap.publish({ v: 1, event: 'PreToolUse', ts: i + 1 });
  const all = tap.recent();
  assert.equal(all.length, 200);
  assert.equal(all[0].seq, 6, 'the oldest five fell off');
  assert.deepEqual(tap.recent(3).map((e) => e.seq), [203, 204, 205]);
  assert.deepEqual(tap.recent(0), []);
  assert.deepEqual(tap.recent(-2), []);
  assert.equal(tap.recent(500).length, 200);
  all.length = 0;
  assert.equal(tap.recent().length, 200, 'a copy: the caller cannot empty the ring');
  assert.equal(createHookTap({ max: 5 }).recent().length, 0);
  const small = createHookTap({ max: 5 });
  for (let i = 0; i < 9; i++) small.publish({ v: 1 });
  assert.deepEqual(small.recent().map((e) => e.seq), [5, 6, 7, 8, 9]);
});

// ── the intake: what it takes ───────────────────────────────────────────────

test('intake: the events it takes are exactly those the mirror and ask hooks post', () => {
  const posted = [...new Set(hookHandlers().filter((h) => h.sub === 'mirror' || h.sub === 'ask').map((h) => h.event))].sort();
  assert.deepEqual([...INTAKE_EVENTS].sort(), posted);
  assert.deepEqual([...INTAKE_EVENTS].sort(), [...MIRROR_EVENTS, 'PermissionRequest'].sort());
  for (const e of INTAKE_EVENTS) assert.ok(EVENTS.includes(e), `${e} is an envelope v1 event`);
});

test('intake: envelope v1\'s fields are the ones hookEnvelope builds, and every envelope a hook posts passes', () => {
  for (const event of EVENTS) {
    const env = envelope(event);
    assert.deepEqual(Object.keys(env), [...ENVELOPE_KEYS], event);
    if (INTAKE_EVENTS.includes(event)) assert.equal(checkEnvelope(env), null, `${event} passes`);
    else assert.equal(checkEnvelope(env), 'not an event this intake takes', `${event} reaches the tap only through the turn routes`);
  }
  // The wire form too: what survives JSON is what arrives.
  for (const event of INTAKE_EVENTS) assert.equal(checkEnvelope(JSON.parse(JSON.stringify(envelope(event)))), null);
});

test('intake: its path is refused remotely, by the route table', () => {
  const v = classify('POST', '/api/hooks/event');
  assert.equal(v.allow, false);
  assert.ok(v.hint);
});

// ── the intake: who may post ────────────────────────────────────────────────

test('intake: the host gets {ok: true}, then exactly one publish, after the response', async (t) => {
  const h = await intakeHost(t);
  const published = [];
  h.tap.subscribe((e) => published.push({ e, answered: h.lastRes().writableEnded }));
  const env = envelope('PostToolUse');
  const r = await h.post(env);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { ok: true });
  await waitUntil(() => published.length === 1, { what: 'the publish' });
  assert.equal(published[0].answered, true, 'the hook had its answer before any subscriber ran');
  const { seq, kind, ...rest } = published[0].e;
  assert.equal(seq, 1);
  assert.equal(kind, 'hook');
  assert.deepEqual(rest, env, 'the envelope as posted, its ts included');
  // Give a stray second publish every chance to land: there must be none.
  await new Promise((r2) => setTimeout(r2, 50));
  assert.equal(h.tap.recent().length, 1);
});

test('intake: a browser, a remote viewer and a network peer are refused, and publish nothing', async (t) => {
  for (const globalJson of [true, false]) {
    const h = await intakeHost(t, { globalJson });
    const env = envelope();
    const refused = [
      ['a pane\'s fetch', await h.fetch(env)],
      ['a page naming its Origin', await h.post(env, { Origin: `http://127.0.0.1:${h.port}` })],
      ['a fetch-metadata header alone', await h.post(env, { 'Sec-Fetch-Site': 'same-origin' })],
      ['a remote viewer', await h.post(env, { 'X-WC-Remote': '1' })],
      ['a network peer', await h.post(env, { 'x-test-peer': '192.168.1.20' })],
      ['a network peer (IPv6)', await h.post(env, { 'x-test-peer': 'fe80::1' })],
    ];
    for (const [who, r] of refused) {
      assert.equal(r.status, 403, `${who} (global parser: ${globalJson})`);
      assert.equal(r.body.ok, false);
      assert.equal(r.body.hint, classify('POST', '/api/hooks/event').hint, 'the route table\'s own words');
    }
    // The host gate comes first: a browser learns nothing about the body.
    if (!globalJson) {
      assert.equal((await h.fetch({ huge: 'x'.repeat(MAX_BODY_BYTES * 2) })).status, 403);
      assert.equal((await h.fetch({ synthetic: true })).status, 403);
    }
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(h.tap.recent(), [], 'nothing reached the tap');
    assert.equal((await h.post(env, { 'x-test-peer': '127.0.0.1' })).status, 200, 'a loopback peer that is no browser is the host');
    await waitUntil(() => h.tap.recent().length === 1, { what: 'the host\'s one publish' });
  }
});

test('intake: without an audience it refuses everyone; without a tap it says so', async (t) => {
  const noAudience = await intakeHost(t, { ctx: { hooks: createHookTap() } });
  assert.equal((await noAudience.post(envelope())).status, 403, 'fails closed, never open');
  const tap = createHookTap();
  for (const audience of [
    { isHost: () => { throw new Error('an audience that throws'); } },
    { isHost: () => 'yes' },
    { isHost: () => 1 },
    { levelOf: () => 'local' },
  ]) {
    const h = await intakeHost(t, { ctx: { audience, hooks: tap } });
    assert.equal((await h.post(envelope())).status, 403, 'only a plain true lets a request through');
  }
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(tap.recent(), []);
  const noTap = await intakeHost(t, { ctx: { audience: fakeAudience() } });
  const r = await noTap.post(envelope());
  assert.equal(r.status, 503);
  assert.equal(r.body.ok, false);
});

// ── the intake: what it refuses ─────────────────────────────────────────────

test('intake: 400 for anything that is not envelope v1, and nothing is published', async (t) => {
  const base = envelope('PreToolUse');
  const cases = [
    ['an array', [base]],
    ['a string', '"PreToolUse"'],
    ['null', 'null'],
    ['not JSON', '{"v":1,'],
    ['synthetic', { ...base, synthetic: true }],
    ['synthetic false', { ...base, synthetic: false }],
    ['a synthetic PermissionResolved', { ...base, event: 'PermissionResolved', synthetic: true }],
    ['a PermissionResolved', { ...base, event: 'PermissionResolved' }],
    ['no version', (({ v, ...rest }) => rest)(base)],
    ['version 2', { ...base, v: 2 }],
    ['version "1"', { ...base, v: '1' }],
    ['an unknown event', { ...base, event: 'Bogus' }],
    ['no event', { ...base, event: undefined }],
    ['a turn route\'s event (Stop)', envelope('Stop')],
    ['a turn route\'s event (UserPromptSubmit)', envelope('UserPromptSubmit')],
    ['a turn route\'s event (StopFailure)', envelope('StopFailure')],
    ['a field v1 does not have', { ...base, extra: 1 }],
    ['a ring seq', { ...base, seq: 7 }],
    ['a bus kind', { ...base, kind: 'store' }],
    ['a __proto__ key', `{"__proto__":{"x":1},${JSON.stringify(base).slice(1)}`],
    ['an ask', { ...base, ask: { id: 'k1', kind: 'permission' } }],
    ['no ts', { ...base, ts: undefined }],
    ['a negative ts', { ...base, ts: -1 }],
    ['a string ts', { ...base, ts: '1790000000123' }],
    ['a numeric session id', { ...base, session_id: 42 }],
    ['an object cwd', { ...base, cwd: {} }],
    ['a pid of 1', { ...base, claude_pid: 1 }],
    ['a fractional pid', { ...base, claude_pid: 4.5 }],
    ['a string section', { ...base, tool: 'Bash' }],
    ['an array section', { ...base, agent: ['a1'] }],
    ['an array input', { ...base, tool: { ...base.tool, input: ['x'] } }],
    ['an object in result.fields', { ...envelope('PostToolUse'), result: { ...envelope('PostToolUse').result, fields: { agentId: { x: 1 } } } }],
    ['a null in result.fields', { ...envelope('PostToolUse'), result: { ok: true, fields: { n: null } } }],
    ['background tasks that are not objects', { ...envelope('SubagentStop'), stop: { background_tasks: ['b1'] } }],
    ['background tasks that are not a list', { ...envelope('SubagentStop'), stop: { background_tasks: { id: 'b1' } } }],
  ];
  for (const globalJson of [true, false]) {
    const h = await intakeHost(t, { globalJson });
    for (const [what, body] of cases) {
      const r = await h.post(typeof body === 'string' ? body : JSON.stringify(body));
      if (globalJson && (what === 'not JSON' || what === 'null' || what === 'a string')) {
        // The daemon's own parser refuses these before the route runs.
        assert.equal(r.status, 400, `${what} (global parser)`);
        continue;
      }
      assert.equal(r.status, 400, `${what} (global parser: ${globalJson})`);
      assert.equal(r.body.ok, false, what);
      assert.equal(typeof r.body.error, 'string', what);
    }
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(h.tap.recent(), [], 'not one of them was published');
  }
});

test('intake: a 400 names the field, never echoes a value', async (t) => {
  const h = await intakeHost(t);
  const r = await h.post({ ...envelope(), 'VALUE-MARKER\nforged line': 1 });
  assert.equal(r.status, 400);
  assert.equal(r.body.error, 'unknown field', 'a key that is not a plain word is not repeated');
  assert.equal((await h.post({ ...envelope(), extra_field: 1 })).body.error, 'unknown field extra_field');
  assert.doesNotMatch(JSON.stringify((await h.post({ ...envelope(), session_id: { secret: 'VALUE-MARKER' } })).body), /VALUE-MARKER/);
});

test('intake: 413 over 64 KB, declared or not, with or without the daemon\'s own parser', async (t) => {
  // An envelope whose cwd pads the body to exactly `size` bytes of JSON: the
  // route checks the shape and the size, not each field's cap (the hook does).
  const sized = (size) => {
    const env = envelope();
    env.cwd = '';
    env.cwd = 'c'.repeat(size - Buffer.byteLength(JSON.stringify(env)));
    const text = JSON.stringify(env);
    assert.equal(Buffer.byteLength(text), size);
    return text;
  };
  for (const globalJson of [true, false]) {
    const h = await intakeHost(t, { globalJson });
    const at = await h.post(sized(MAX_BODY_BYTES));
    assert.equal(at.status, 200, `exactly 64 KB is taken (global parser: ${globalJson})`);
    const over = await h.post(sized(MAX_BODY_BYTES + 1));
    assert.equal(over.status, 413, `one byte over is refused (global parser: ${globalJson})`);
    assert.equal(over.body.ok, false);
    assert.equal((await h.post(sized(5 * MAX_BODY_BYTES))).status, 413);
    const chunked = await h.chunked(sized(MAX_BODY_BYTES + 100));
    assert.equal(chunked.status, 413, `no Content-Length (global parser: ${globalJson})`);
    assert.equal((await h.chunked(sized(MAX_BODY_BYTES - 100))).status, 200);
    await waitUntil(() => h.tap.recent().length === 2, { what: 'the two bodies within the cap' });
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(h.tap.recent().length, 2, 'nothing over the cap was published');
  }
  assert.equal(MAX_BODY_BYTES, 64 * 1024);
});

test('intake: a body that is not JSON at all is malformed, not published', async (t) => {
  for (const globalJson of [true, false]) {
    const h = await intakeHost(t, { globalJson });
    const r = await request(h.port, 'POST', '/api/hooks/event', 'v=1&event=PreToolUse', {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });
    assert.equal(r.status, 400);
    assert.deepEqual(r.body, { ok: false, error: 'not JSON' });
    const empty = await request(h.port, 'POST', '/api/hooks/event', null);
    assert.equal(empty.status, 400, 'no body at all');
    await new Promise((r2) => setImmediate(r2));
    assert.deepEqual(h.tap.recent(), []);
  }
});

// ── a real hook, end to end ─────────────────────────────────────────────────

function runHook(args, { cwd, env, input }) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [HOOK_BIN, ...args], { cwd, env: { ...process.env, ...env } });
    let stdout = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (c) => { stdout += c; });
    child.stdin.on('error', () => {});
    const killer = setTimeout(() => child.kill('SIGKILL'), 20000);
    child.on('error', (e) => { clearTimeout(killer); reject(e); });
    child.on('close', (status, signal) => { clearTimeout(killer); resolve({ status, signal, stdout }); });
    child.stdin.end(JSON.stringify(input));
  });
}

test('intake: the real mirror and ask hooks reach the tap as the host, once each', async (t) => {
  const h = await intakeHost(t);
  const root = tmpRoot('wc-intake-');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-intake-home-'));
  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  });
  writePortfileAt(path.join(root, '.web-chat'), { pid: process.pid, port: h.port });
  const env = { HOME: home, USERPROFILE: home, CLAUDE_PID: '4242', CLAUDE_CODE_ENTRYPOINT: 'cli' };
  const common = { session_id: SID, transcript_path: `/u/.claude/projects/-u-p/${SID}.jsonl`, cwd: root };

  const pre = await runHook(['mirror'], {
    cwd: root, env, input: { ...common, hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_use_id: 'toolu_9',
      tool_input: { file_path: `${root}/a.js`, old_string: 'OLD-TEXT', new_string: 'NEW-TEXT' } },
  });
  assert.equal(pre.status, 0);
  assert.equal(pre.stdout, '');
  const asked = await runHook(['ask'], {
    cwd: root, env, input: { ...common, hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'ls' } },
  });
  assert.equal(asked.status, 0);
  assert.equal(asked.stdout, '');

  await waitUntil(() => h.tap.recent().length === 2, { what: 'both envelopes on the tap', timeout: 5000 });
  const [a, b] = h.tap.recent();
  assert.equal(a.kind, 'hook');
  assert.equal(a.event, 'PreToolUse');
  assert.equal(a.ts, h.bodies[0].ts, 'the hook\'s own ts');
  assert.equal(a.tool.label, 'Edit · a.js');
  assert.deepEqual(a.tool.input, { file_path: `${root}/a.js`, old_string_bytes: 8, new_string_bytes: 8 });
  assert.equal(a.claude_pid, 4242);
  assert.equal(b.event, 'PermissionRequest');
  assert.equal(b.tool.use_id, null);
  assert.doesNotMatch(JSON.stringify(h.tap.recent()), /OLD-TEXT|NEW-TEXT/);
});
