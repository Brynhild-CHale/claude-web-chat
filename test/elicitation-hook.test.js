// The elicit hook (lib/hooks/elicitation.js, spec §15.7, tranche 6): an MCP
// server's form request, answerable from the web-chat page while a local
// viewer is connected, for at most ELICIT_WAIT_MS, and otherwise the
// terminal's dialog at once.
//
// Four parts:
//
//   1. buildElicitationOutput, pure: accept's content typed by the hook's OWN
//      copy of the schema, decline and cancel, terminal and the unmappable.
//   2. THE DISPATCHER AS A SUBPROCESS against a stub daemon on loopback (the
//      sandbox's HOME, lib/client's posts): every way out that is not a
//      decision exits 0 printing nothing, and the ones before the create post
//      nothing at all; a decision prints exactly buildElicitationOutput's
//      line; SIGTERM withdraws; hook.log holds ids and outcomes only.
//   3. IN PROCESS with a fake clock: the deadline withdraws and prints
//      nothing; the create body; the per-module hard exit.
//   4. THE TEMPLATE AND REGISTRATION: the Elicitation entry, counted under
//      the bridge role by inspect, doctor and status; apply/remove round-trip
//      it; a project missing only Elicitation names it with its own words.

require('../test-support/sandbox');

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { Writable } = require('stream');
const { spawn } = require('child_process');
const { EventEmitter } = require('events');

const elicit = require('../lib/hooks/elicitation');
const { buildElicitationOutput, formSchema, ELICIT_WAIT_MS } = elicit;
const { hookEnvelope } = require('../lib/hooks/envelope');
const { writePortfileAt } = require('../lib/core/portfiles');
const mf = require('../lib/update/managed-files');
const reg = require('../lib/setup/registration');
const { claudePaths } = require('../lib/core/paths');
const { tmpRoot, waitUntil, withTempHome } = require('../test-support/helpers');

const HOOK_BIN = path.join(__dirname, '..', 'bin', 'claude-web-chat-hook.js');
const SID = '7c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f';
const ID = 'ask_00aa11bb22cc';
const SECRET = 'S3CRET-for-this-elicitation';
const NOW = 1791000000456;
const ENV = { CLAUDE_PID: '4243', CLAUDE_CODE_ENTRYPOINT: 'cli' };
const CREATED = { ok: true, id: ID, secret: SECRET, wait: true, poll_ms: 2000, deadline_ms: ELICIT_WAIT_MS };
const HANG = Symbol('hang');

const SCHEMA = {
  type: 'object',
  properties: {
    name: { type: 'string', title: 'Your name', default: 'Ada' },
    count: { type: 'number', minimum: 0 },
    ok: { type: 'boolean' },
    size: { type: 'string', enum: ['small', 'large'] },
    seats: { type: 'integer' },
  },
  required: ['name'],
};

function payload(root, extra = {}) {
  return {
    session_id: SID,
    transcript_path: `/Users/someone/.claude/projects/-p/${SID}.jsonl`,
    cwd: root,
    hook_event_name: 'Elicitation',
    mcp_server_name: 'scratch',
    message: 'Who is asking?',
    mode: 'form',
    elicitation_id: 'el-42',
    requested_schema: SCHEMA,
    ...extra,
  };
}

// ── the rig ─────────────────────────────────────────────────────────────────

// A daemon stand-in for the asks routes the hook calls. `poll(n)` answers the
// nth decision poll (a body, or HANG to hold it open). Every request is kept.
async function asksStub(t, { create = CREATED, poll = () => ({ state: 'pending' }) } = {}) {
  const requests = [];
  const sockets = new Set();
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', async () => {
      let body = null;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch {}
      const url = new URL(req.url, 'http://stub');
      requests.push({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), headers: req.headers, body });
      res.on('error', () => {});
      const send = (answer) => {
        if (answer === HANG) return;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(answer));
      };
      if (req.method === 'POST' && url.pathname === '/api/asks') return send(create);
      if (url.pathname.endsWith('/decision')) return send(await poll(requests.filter((r) => r.path === url.pathname).length));
      return send({ ok: true });
    });
  });
  server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => {
    for (const s of sockets) s.destroy();
    return new Promise((r) => server.close(r));
  });
  return {
    port: server.address().port,
    requests,
    created: () => requests.filter((r) => r.path === '/api/asks'),
    polls: () => requests.filter((r) => r.path.endsWith('/decision')),
    withdraws: () => requests.filter((r) => r.path.endsWith('/withdraw')),
    handed: () => requests.filter((r) => r.path.endsWith('/handed')),
  };
}

function project(t, port) {
  const root = tmpRoot('wc-elicit-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, '.web-chat'), { recursive: true });
  if (port) writePortfileAt(path.join(root, '.web-chat'), { pid: process.pid, port });
  return root;
}

function hookEnv(t, extra = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-elicit-home-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const env = { ...process.env, HOME: home, USERPROFILE: home, CLAUDE_CODE_ENTRYPOINT: 'cli', ...extra };
  delete env.WEB_CHAT_HOOK_LOG;
  return env;
}

function spawnHook({ cwd, env, input, killAfterMs = 20000 }) {
  const started = Date.now();
  const child = spawn(process.execPath, [HOOK_BIN, 'elicit'], { cwd, env });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (c) => { stdout += c; });
  child.stderr.on('data', (c) => { stderr += c; });
  child.stdin.on('error', () => {});
  const killer = setTimeout(() => child.kill('SIGKILL'), killAfterMs);
  const done = new Promise((resolve, reject) => {
    child.on('error', (e) => { clearTimeout(killer); reject(e); });
    child.on('close', (status, signal) => {
      clearTimeout(killer);
      resolve({ status, signal, stdout, stderr, ms: Date.now() - started });
    });
  });
  child.stdin.end(JSON.stringify(input));
  return { child, done };
}

function capture() {
  const chunks = [];
  const stream = new Writable({ write(chunk, enc, cb) { chunks.push(String(chunk)); cb(); } });
  return { stream, text: () => chunks.join('') };
}

// ── 1. the output ───────────────────────────────────────────────────────────

test('output: accept prints the content typed by the hook\'s own schema; a key it lacks is dropped', () => {
  const schema = formSchema(SCHEMA);
  const line = buildElicitationOutput({
    behavior: 'accept',
    content: { name: 'Grace', count: '3', ok: 'true', size: 'large', seats: '12', extra: 'never sent' },
  }, schema);
  assert.equal(line, JSON.stringify({
    hookSpecificOutput: { hookEventName: 'Elicitation', action: 'accept', content: { name: 'Grace', count: 3, ok: true, size: 'large', seats: 12 } },
  }));
  assert.equal(buildElicitationOutput({ behavior: 'accept', content: { name: 'x', count: 2.5 } }, schema),
    '{"hookSpecificOutput":{"hookEventName":"Elicitation","action":"accept","content":{"name":"x","count":2.5}}}');
});

test('output: decline and cancel print their actions; terminal and the unmappable print nothing', () => {
  const schema = formSchema(SCHEMA);
  assert.equal(buildElicitationOutput({ behavior: 'decline' }, schema), '{"hookSpecificOutput":{"hookEventName":"Elicitation","action":"decline"}}');
  assert.equal(buildElicitationOutput({ behavior: 'cancel' }, schema), '{"hookSpecificOutput":{"hookEventName":"Elicitation","action":"cancel"}}');
  assert.equal(buildElicitationOutput({ behavior: 'terminal' }, schema), null);
  assert.equal(buildElicitationOutput({ behavior: 'allow' }, schema), null, 'no other behavior');
  assert.equal(buildElicitationOutput(null, schema), null);
  // Accept the local copy cannot type: never a silent wrong answer.
  assert.equal(buildElicitationOutput({ behavior: 'accept', content: { name: 'x', size: 'medium' } }, schema), null, 'an enum miss');
  assert.equal(buildElicitationOutput({ behavior: 'accept', content: { name: 'x', count: 'three' } }, schema), null, 'no number');
  assert.equal(buildElicitationOutput({ behavior: 'accept', content: { name: 'x', seats: '1.5' } }, schema), null, 'no integer');
  assert.equal(buildElicitationOutput({ behavior: 'accept', content: { count: 1 } }, schema), null, 'a required key missing');
  assert.equal(buildElicitationOutput({ behavior: 'accept', content: { name: 7 } }, schema), null, 'a string is a string');
  assert.equal(buildElicitationOutput({ behavior: 'accept' }, schema), null, 'no content');
});

test('formSchema: a flat form of string, number, integer, boolean and string-enum fields, at most 20; else null', () => {
  const s = formSchema(SCHEMA);
  assert.deepEqual(Object.keys(s.properties), ['name', 'count', 'ok', 'size', 'seats']);
  assert.deepEqual(s.required, ['name']);
  assert.equal(s.properties.name.default, 'Ada', 'a default is kept, for the placeholder');
  assert.deepEqual(formSchema({ properties: { a: { type: 'string', enumNames: ['A'], enum: ['a'] } } }).properties.a, { type: 'string', enum: ['a'] },
    'annotations the page does not draw are left out');
  const bad = [
    null, {}, { type: 'array', properties: { a: { type: 'string' } } },
    { properties: {} },
    { properties: { a: { type: 'object', properties: {} } } },
    { properties: { a: { type: 'array', items: { type: 'string' } } } },
    { properties: { a: { type: 'number', enum: [1, 2] } } },
    { properties: { a: { type: 'string', enum: [] } } },
    { properties: { a: { oneOf: [{ const: 'x' }] } } },
    { properties: { a: { type: 'string' } }, required: ['b'] },
    { properties: Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`f${i}`, { type: 'string' }])) },
  ];
  for (const b of bad) assert.equal(formSchema(b), null, JSON.stringify(b));
  assert.ok(formSchema({ properties: Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`f${i}`, { type: 'boolean' }])) }), '20 fields');
});

// ── 2. the dispatcher, as a subprocess ──────────────────────────────────────

test('dispatcher: no daemon, an SDK entrypoint, mode url and an unsupported schema exit 0, print nothing, post nothing', async (t) => {
  const stub = await asksStub(t);
  const bare = project(t, null);
  let r = await spawnHook({ cwd: bare, env: hookEnv(t), input: payload(bare) }).done;
  assert.deepEqual([r.status, r.stdout, r.stderr], [0, '', ''], 'no daemon');

  const root = project(t, stub.port);
  const cases = [
    ['an SDK entrypoint', payload(root), { CLAUDE_CODE_ENTRYPOINT: 'sdk-cli' }],
    ['mode url', payload(root, { mode: 'url', url: 'https://example.invalid/login', requested_schema: undefined }), {}],
    ['a nested schema', payload(root, { requested_schema: { type: 'object', properties: { a: { type: 'object' } } } }), {}],
    ['an array field', payload(root, { requested_schema: { type: 'object', properties: { a: { type: 'array' } } } }), {}],
    ['no schema', payload(root, { requested_schema: undefined }), {}],
  ];
  for (const [what, input, extra] of cases) {
    r = await spawnHook({ cwd: root, env: hookEnv(t, extra), input }).done;
    assert.deepEqual([r.status, r.signal, r.stdout, r.stderr], [0, null, '', ''], what);
  }
  assert.equal(stub.requests.length, 0, 'nothing was posted');
  assert.equal(fs.existsSync(path.join(root, '.web-chat', 'hook.log')), false, 'and nothing logged');
});

test('dispatcher: wait false prints nothing, at once — the terminal dialog shows', async (t) => {
  const stub = await asksStub(t, { create: { ok: true, id: ID, wait: false, reason: 'no-viewer' } });
  const root = project(t, stub.port);
  const r = await spawnHook({ cwd: root, env: hookEnv(t), input: payload(root) }).done;
  assert.deepEqual([r.status, r.stdout, r.stderr], [0, '', '']);
  assert.equal(stub.requests.length, 1, 'only the create');
  t.diagnostic(`wait false → exit in ${r.ms} ms`);
});

test('dispatcher: accept prints exactly buildElicitationOutput\'s line, typed by the hook\'s schema; then handed', async (t) => {
  const content = { name: 'Grace', count: '3', unknown: 'dropped' };
  const stub = await asksStub(t, { poll: () => ({ state: 'decided', decision: { behavior: 'accept', content } }) });
  const root = project(t, stub.port);
  const r = await spawnHook({ cwd: root, env: hookEnv(t), input: payload(root) }).done;
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '{"hookSpecificOutput":{"hookEventName":"Elicitation","action":"accept","content":{"name":"Grace","count":3}}}');
  assert.equal(r.stdout, buildElicitationOutput({ behavior: 'accept', content }, formSchema(SCHEMA)));
  assert.equal(r.stderr, '');
  assert.equal(stub.handed().length, 1);
  assert.equal(stub.polls()[0].headers['x-wc-ask-secret'], SECRET);
});

test('dispatcher: decline and cancel print their actions; terminal prints nothing', async (t) => {
  for (const [behavior, expected] of [
    ['decline', '{"hookSpecificOutput":{"hookEventName":"Elicitation","action":"decline"}}'],
    ['cancel', '{"hookSpecificOutput":{"hookEventName":"Elicitation","action":"cancel"}}'],
    ['terminal', ''],
  ]) {
    const stub = await asksStub(t, { poll: () => ({ state: 'decided', decision: { behavior } }) });
    const root = project(t, stub.port);
    const r = await spawnHook({ cwd: root, env: hookEnv(t), input: payload(root) }).done;
    assert.equal(r.status, 0, behavior);
    assert.equal(r.stdout, expected, behavior);
    assert.equal(stub.handed().length, 1, `${behavior}: handed`);
  }
});

test('dispatcher: SIGTERM withdraws {reason: sigterm} and exits 0, printing nothing', async (t) => {
  const stub = await asksStub(t, { poll: () => HANG });
  const root = project(t, stub.port);
  const run = spawnHook({ cwd: root, env: hookEnv(t), input: payload(root) });
  await waitUntil(() => stub.polls().length === 1, { what: 'the hook to start polling', timeout: 10000 });
  run.child.kill('SIGTERM');
  const r = await run.done;
  assert.deepEqual([r.signal, r.status, r.stdout], [null, 0, '']);
  const [w] = stub.withdraws();
  assert.deepEqual(w.body, { reason: 'sigterm' });
  assert.equal(w.headers['x-wc-ask-secret'], SECRET);
});

test('dispatcher: an accept the hook cannot type prints nothing, and hook.log names only ids and the outcome', async (t) => {
  const SECRETISH = 'hunter2-PASSWORD-VALUE';
  const stub = await asksStub(t, {
    poll: () => ({ state: 'decided', decision: { behavior: 'accept', content: { name: SECRETISH, size: 'medium' } } }),
  });
  const root = project(t, stub.port);
  const r = await spawnHook({ cwd: root, env: hookEnv(t), input: payload(root) }).done;
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '', 'the terminal dialog stands');
  assert.equal(stub.handed().length, 0);
  const log = fs.readFileSync(path.join(root, '.web-chat', 'hook.log'), 'utf8');
  const lines = log.trim().split('\n');
  assert.equal(lines.length, 1);
  assert.match(lines[0], new RegExp(`^\\[[0-9T:.Z-]+\\] elicit Elicitation session=${SID} error ELICIT_UNMAPPED$`));
  for (const v of [SECRETISH, 'medium', 'Who is asking', 'scratch', 'Your name']) assert.ok(!log.includes(v), `no ${v} in hook.log`);
});

// ── 3. in process ───────────────────────────────────────────────────────────

test('in process: the create body is the envelope, kind elicitation and the form as the page may draw it', async (t) => {
  const stub = await asksStub(t, { create: { ok: true, id: ID, wait: false, reason: 'no-viewer' } });
  const root = project(t, stub.port);
  const p = payload(root);
  const out = capture();
  const result = await elicit(p, { root, now: NOW, env: ENV, stdout: out.stream });
  assert.equal(result, 'no-wait');
  const [c] = stub.created();
  assert.deepEqual(Object.keys(c.body).sort(), ['elicitation', 'envelope', 'kind', 'v']);
  assert.equal(c.body.kind, 'elicitation');
  assert.deepEqual(c.body.envelope, JSON.parse(JSON.stringify(hookEnvelope(p, ENV, { now: NOW }))));
  assert.equal(c.body.envelope.event, 'Elicitation');
  assert.equal(c.body.envelope.tool, null);
  assert.deepEqual(c.body.elicitation, {
    server: 'scratch', message: 'Who is asking?', mode: 'form', elicitation_id: 'el-42', schema: formSchema(SCHEMA),
  });
  assert.equal(out.text(), '');
});

test('in process: no decision within ELICIT_WAIT_MS (a fake clock) withdraws deadline and prints nothing', async (t) => {
  const clock = { t: 1000 };
  const stub = await asksStub(t, {
    poll: (n) => { clock.t += n === 1 ? 20_000 : 30_000; return { state: 'pending' }; },
  });
  const root = project(t, stub.port);
  const out = capture();
  const result = await elicit(payload(root), {
    root, now: NOW, env: ENV, stdout: out.stream, clock: () => clock.t, sleep: async () => {}, signals: new EventEmitter(),
  });
  assert.equal(result, 'deadline');
  assert.equal(out.text(), '');
  assert.equal(stub.polls().length, 2, 'it stopped asking once the wait had run out');
  const [w] = stub.withdraws();
  assert.deepEqual(w.body, { reason: 'deadline' });
  assert.ok(stub.polls().every((p) => Number(p.query.wait) <= 2000), 'each poll waits at most 2 s');
});

test('in process: the daemon\'s deadline_ms cannot stretch the wait past ELICIT_WAIT_MS', async (t) => {
  const clock = { t: 0 };
  const stub = await asksStub(t, {
    create: { ...CREATED, deadline_ms: 590_000 },
    poll: () => { clock.t += ELICIT_WAIT_MS / 2; return { state: 'pending' }; },
  });
  const root = project(t, stub.port);
  const result = await elicit(payload(root), {
    root, env: ENV, stdout: capture().stream, clock: () => clock.t, sleep: async () => {}, signals: new EventEmitter(),
  });
  assert.equal(result, 'deadline');
  assert.equal(stub.polls().length, 2);
});

test('in process: the wait is 45 s, the dispatcher\'s hard exit five more, the template\'s timeout above both', () => {
  assert.equal(ELICIT_WAIT_MS, 45_000);
  assert.equal(elicit.deadlineMs, ELICIT_WAIT_MS + 5000);
  const [g] = mf.hookTemplate().hooks.Elicitation;
  assert.ok(g.hooks[0].timeout * 1000 > elicit.deadlineMs, 'Claude Code never kills the hook before it gives up itself');
});

// ── 4. the template and registration ────────────────────────────────────────

test('template: Elicitation runs the elicit subcommand, after PermissionRequest, under the bridge role', () => {
  const tpl = mf.hookTemplate().hooks;
  assert.deepEqual(tpl.Elicitation, [{ hooks: [{ type: 'command', command: 'claude-web-chat-hook elicit', timeout: 90 }] }]);
  const events = Object.keys(tpl);
  assert.equal(events.indexOf('Elicitation'), events.indexOf('PermissionRequest') + 1);
  assert.equal(reg.hookEvents().length, 13);
  assert.equal(reg.hookHandlers().length, 15);
  assert.equal(reg.hookRole('claude-web-chat-hook elicit'), 'bridge');
  assert.deepEqual(reg.HOOK_ROLES.bridge.subcommands, ['ask', 'elicit']);
});

test('registration: apply registers the elicit handler, inspect reads it ok, remove takes it', (t) => {
  withTempHome(t);
  const root = project(t, null);
  reg.apply(root, { runClaude: () => ({ ok: true }) });
  const settings = () => JSON.parse(fs.readFileSync(claudePaths(root).settings, 'utf8'));
  const [h] = settings().hooks.Elicitation[0].hooks;
  assert.equal(h.command, mf.resolveHookCommand('claude-web-chat-hook elicit'));
  assert.equal(h.timeout, 90);
  const st = reg.inspect(root);
  assert.equal(st.hooks.Elicitation, 'ok');
  assert.deepEqual(st.handlers.filter((r) => r.sub === 'elicit').map((r) => [r.event, r.role, r.state]), [['Elicitation', 'bridge', 'ok']]);
  reg.remove(root, { runClaude: () => ({ ok: true }) });
  const after = fs.existsSync(claudePaths(root).settings) ? settings().hooks || {} : {};
  assert.equal(after.Elicitation, undefined, 'removed with the rest');
});

test('registration: a project missing only Elicitation names it under bridge with its own words', (t) => {
  withTempHome(t);
  const root = project(t, null);
  reg.apply(root, { runClaude: () => ({ ok: true }) });
  const file = claudePaths(root).settings;
  const s = JSON.parse(fs.readFileSync(file, 'utf8'));
  delete s.hooks.Elicitation;
  fs.writeFileSync(file, JSON.stringify(s, null, 2));
  const st = reg.inspect(root);
  assert.equal(st.hooks.Elicitation, 'missing');
  assert.equal(st.hooks.PermissionRequest, 'ok');
  assert.deepEqual(reg.hookProblems(st), [{
    role: 'bridge', state: 'missing', events: ['Elicitation'], differs: [],
    effect: 'MCP input requests cannot be answered from the browser',
  }]);
  assert.match(reg.driftLine(st), /missing: Elicitation\)/);
});
