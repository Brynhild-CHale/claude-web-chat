// Tranche 6 of the chat mirror, end to end: the mod (design spec §11.9's
// "End-to-end check (U94a)", §15.1, §15.2, §15.6, §15.7, §6.1). The daemon
// exactly as createServer wires it — the bridge (ctx.bridge) and its routes,
// mod-live among the mirror's SOURCES, the mod's control rows and the
// interrupt's mod path, the session controls, the asks' mod transport, the
// queue's message transport and the composer's adapters — and Claude Code
// played by a FAKE MOD CLIENT over the bridge routes (test-support/fake-mod.js,
// U87's), its hooks' code, a sessions file and a synthetic transcript. No real
// Claude Code runs here, and no opt-in gate: a fork runs a stub `claude`.
//
// Pinned, a test per clause of §11.9:
//   * the fake mod's events reach the stream once each: a tool.call gives a
//     running card before any transcript record, and the tailer's later copy
//     of that tool_use lands on the same item;
//   * an interrupt of its conversation through the answer origin queues ONE
//     abort op (via 'mod', no tty or hook on top); the mod's own result names
//     the backgrounded Bash it TaskStopped (U88/U89: that stop is the mod's,
//     inside the abort — the daemon queues no op for it);
//   * a Kill through the stopper's control frame (the 'task-stop' row) queues
//     ONE taskStop op, and the pane-callable POST /api/queue/task-stop still
//     only queues the stop-request message — no op;
//   * a composer message goes as ONE submit op carrying the marked block, and
//     its receipt confirms from the transcript;
//   * /plan goes as a command op; /model is refused;
//   * the in-place resume is refused without WEB_CHAT_REWIND_IN_PLACE and,
//     with it and a confirm, queues command: resume (and the prompt's fill);
//   * a bridge call from a browser, a remote viewer or a network peer is
//     refused, and one with a wrong token too;
//   * with no mod every path takes tier 1;
//   * the server exits with no open handles through srv.stop() and through
//     gracefulShutdown(), with a mod attached, its op long-poll held open, a
//     mod ask pending, a context reading held and the transport set;
//     state.messageTransport is null and the readings are empty after either.
// Beyond §11.9 (as U66a added four, notes-C D9):
//   * an Elicitation hook subprocess (bin/claude-web-chat-hook.js elicit)
//     against the daemon with a local viewer: a decision posted through the
//     answer origin with its nonce prints exactly buildElicitationOutput's
//     line; with no viewer it prints nothing at once;
//   * with the mod's permission wait raised (the test-only createServer option
//     modPermissionWait; the shipped wait is 0 until V41), a permission request
//     the fake mod reports joins the asks — one mirror:ask open, the same
//     answer document — and its web decision comes back as ONE
//     permissionDecision op with no updatedPermissions; with the shipped wait
//     the hello answers permission_wait_ms 0;
//   * an image POSTed to /api/attachments and named in a message passes
//     validation, and the submit op's block carries its File line;
//   * the lock and the committed node of a turn a mod-submitted message opened
//     say 'web message m-…', never the text (U91's turn-begin line);
//   * GET /api/mirror at local: capabilities.mod true with the fake mod
//     attached (and the conversation's process.mod) and false after its pid
//     dies; rewind_in_place true only with the flag and a mod; and the mod's
//     session.measure on the real tap reaches GET /api/mirror/context (U93's
//     readings and route, as createServer wires them);
//   * test/bus-golden.test.js is byte-identical.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const { createHook } = require('node:async_hooks');

const { withServer, withTempHome, tmpRoot, waitUntil, wsConnect, openSSE, fakeBin } = require('../test-support/helpers');
const { claudeHome } = require('../test-support/claude-home');
const { createRecords } = require('../test-support/claude-records');
const { fakeMod } = require('../test-support/fake-mod');
const client = require('../lib/client');
const { createServer } = require('../lib/server');
const { hookEnvelope } = require('../lib/hooks/envelope');
const { sessionFields } = require('../lib/hooks/turn-begin');
const { postEnvelope } = require('../lib/hooks/mirror');
const { buildElicitationOutput, formSchema } = require('../lib/hooks/elicitation');
const { PACKAGE_ROOT } = require('../lib/core/paths');
const { sampleProcs, formatProcStart } = require('../lib/core/portfiles');
const { PNG_SIGNATURE } = require('../lib/core/png');
const { OPS } = require('../lib/core/mod-protocol');
const { classify } = require('../lib/core/remote-policy');

const REPO = path.resolve(__dirname, '..');
const HOOK_BIN = path.join(PACKAGE_ROOT, 'bin', 'claude-web-chat-hook.js');
const S1 = '11111111-1111-4111-8111-111111111111';
const FORKED = '99999999-9999-4999-8999-999999999999';
const CALL_TIMEOUT_MS = 15000;
const WAIT = { timeout: 15000, interval: 10 };
const SECRET_TEXT = 'PLEASE-KEEP-THIS-MESSAGE-TEXT-6620';
const FLAG = 'WEB_CHAT_REWIND_IN_PLACE';
const HOST_HINT = classify('POST', '/api/bridge/hello').hint;
const PEER = '192.168.1.23';
const RAISED_WAIT_MS = 60000;

// ── the stub claude (a fork, §15.6) ──────────────────────────────────────────

const FAKE_CLAUDE = `
const fs = require('fs');
const argv = process.argv.slice(2);
fs.appendFileSync(process.env.ARGV_LOG, JSON.stringify(argv) + '\\n');
if (argv[0] === 'agents') process.stdout.write('[]\\n');
else if (argv.includes('--fork-session')) process.stdout.write(JSON.stringify({ type: 'result', session_id: ${JSON.stringify(FORKED)} }) + '\\n');
`;

function stubClaude(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-t6-claude-'));
  const script = path.join(dir, 'fake-claude.js');
  const log = path.join(dir, 'argv.log');
  fs.writeFileSync(script, FAKE_CLAUDE);
  fs.writeFileSync(log, '');
  const fake = fakeBin(t, { name: 'claude', script, env: { ARGV_LOG: log } });
  const before = process.env.PATH;
  process.env.PATH = `${fake.dir}${path.delimiter}${before}`;
  t.after(() => { process.env.PATH = before; fs.rmSync(dir, { recursive: true, force: true }); });
  return { argvs: () => fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) };
}

// ── the daemon, and Claude Code's side of it ─────────────────────────────────

// A project, a private Claude tier and its daemon. `pid`: the Claude Code
// process of S1 (its sessions file, a live procStart; this process by
// default); `env`: daemon environment set before it boots (the flag is read
// once); `waitMs`: the mod's permission wait (createServer's test-only option).
async function daemon(t, { pid = process.pid, env = {}, waitMs, claude = false } = {}) {
  withTempHome(t);
  if (claude) stubClaude(t);
  let ctx = null;
  t.after(async () => { if (ctx) await ctx.stop(); });
  const saved = {};
  for (const [k, v] of Object.entries(env)) { saved[k] = process.env[k]; process.env[k] = v; }
  t.after(() => { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });
  const dir = tmpRoot('wc-t6e2e-');
  const ch = claudeHome(t, { root: dir, isolate: true });
  const procStart = formatProcStart((await sampleProcs([pid])).get(pid).startedAt);
  ch.writeSession({ pid, procStart, sessionId: S1, status: 'idle' });
  const make = waitMs === undefined ? undefined : (o) => createServer({ ...o, modPermissionWait: waitMs });
  ctx = await withServer(t, { root: dir, writePortfile: true, ...(make ? { createServer: make } : {}) });
  await ctx.srv.controlStarted;
  return driver(t, ctx, { ch, pid, procStart });
}

function driver(t, ctx, { ch, pid, procStart }) {
  const call = { port: ctx.port, noSpawn: true, timeout: CALL_TIMEOUT_MS };
  const env = { CLAUDE_CODE_ENTRYPOINT: 'cli', CLAUDE_PID: String(pid) };
  let clock = Date.now();
  const stamp = () => { clock = Math.max(clock + 1, Date.now()); return clock; };
  const envelope = (event, extra = {}) => hookEnvelope({ hook_event_name: event, session_id: S1,
    transcript_path: ch.transcript(S1), cwd: ch.cwd, permission_mode: 'default', ...extra }, env, { now: stamp() });
  const d = {
    ...ctx,
    ch,
    pid,
    procStart,
    call,
    get: (p) => client.get(p, call),
    post: (p, body) => client.post(p, body, call),
    request: (method, p, body, headers) => client.request(ctx.port, method, p, body, { headers, timeout: CALL_TIMEOUT_MS }),
    async fire(event, extra) {
      assert.equal(await postEnvelope(envelope(event, extra), { root: ctx.root, timeout: CALL_TIMEOUT_MS }), 'posted', event);
    },
    turnBegin(promptId, text) {
      const e = envelope('UserPromptSubmit', { prompt: text, prompt_id: promptId });
      return client.post('/api/turn-begin', { message: text, author: 'user', ...sessionFields(e), prompt: e.prompt }, call);
    },
    turnEnd(reply) {
      const e = envelope('Stop', { last_assistant_message: reply });
      return client.post('/api/turn-end', { author: 'claude', reply, ended: 'stop', ...sessionFields(e),
        last_assistant_message: e.stop.last_assistant_message }, call);
    },
    snapshot: () => client.get('/api/mirror', call),
    conversation: async () => ((await client.get('/api/mirror', call)).conversations || []).find((c) => c.id === S1) || null,
    send: (body) => client.post('/api/queue/message', { send: 'now', conversation_id: S1, ...body }, call),
    receipt: async (msgId) => ((await client.get('/api/queue', call)).receipts || []).find((r) => r.msg_id === msgId) || null,
    hookEnv(extra = {}) {
      const e = { ...process.env, CLAUDE_PID: String(pid), CLAUDE_CODE_ENTRYPOINT: 'cli', ...extra };
      delete e.WEB_CHAT_HOOK_LOG;
      return e;
    },
    // The fake mod for S1 (or another session), closed with the test.
    mod(sessionId = S1) {
      const m = fakeMod({ port: ctx.port, sessionId, root: ctx.root });
      t.after(() => m.close());
      return m;
    },
    // A fake mod that said hello and answers every op from `handlers`,
    // recording each op it was handed: {mod, ops, hello}.
    async attach(handlers = {}, sessionId = S1) {
      const m = d.mod(sessionId);
      const hello = await m.hello();
      assert.equal(hello.status, 200, JSON.stringify(hello.body));
      const ops = [];
      const wrapped = {};
      for (const name of OPS) {
        wrapped[name] = (args, op) => {
          ops.push({ op: op.op, args });
          return typeof handlers[name] === 'function' ? handlers[name](args, op) : {};
        };
      }
      m.runOps(wrapped, { wait: 200 });
      return { mod: m, ops, hello };
    },
  };
  return d;
}

// S1 at work: its process busy, a prompt (the lock), a tool running and a pane
// rendered, the mirror seeing it work.
async function working(d, promptId = 'p-work') {
  d.ch.writeSession({ pid: d.pid, procStart: d.procStart, sessionId: S1, status: 'busy' });
  await d.fire('SessionStart', { source: 'startup', model: 'claude-test' });
  await d.turnBegin(promptId, 'run the slow tests');
  await d.fire('PreToolUse', { tool_name: 'Bash', tool_use_id: `toolu_01${promptId.replace(/\W/g, '')}`, tool_input: { command: 'npm test' } });
  await d.post('/api/render', { id: `t6-${promptId}`, html: '<p>running</p>' });
  return waitUntil(async () => {
    const c = await d.conversation();
    return c && c.process && c.process.pid === d.pid && c.live && c.live.state === 'working' ? c : null;
  }, { ...WAIT, what: 'the mirror to see S1 working, with its process' });
}

// A background shell of S1, running (its transcript and its output file).
async function startShell(d, id) {
  await d.fire('SessionStart', { source: 'startup', model: 'claude-test' });
  const file = d.ch.writeTaskOutput(S1, id, '');
  const r = createRecords({ seed: 7, sessionId: S1, cwd: d.ch.cwd, start: Date.now() - 5000, step: 10 });
  r.prompt(`run ${id}`, { promptId: `p-${id}` });
  const useId = `toolu_01${id}`;
  r.assistant([{ type: 'tool_use', name: 'Bash', input: { command: 'npm run dev', description: 'Start the dev server',
    run_in_background: true }, id: useId }]);
  r.toolResult(useId, `Command running in background with ID: ${id}. Output is being written to: ${file}.`, { taskId: id });
  d.ch.writeTranscript(S1, r.records);
  return waitUntil(async () => {
    const got = await client.get('/api/mirror/tasks', d.call);
    return (got.tasks || []).find((x) => x.id === id && x.status === 'running') || null;
  }, { ...WAIT, what: `the running shell ${id}` });
}

// A WebSocket that records every frame (a local viewer; `full` opens its chat).
async function socket(t, port, { full = false } = {}) {
  const ws = wsConnect(port, '/ws');
  t.after(() => { try { ws.terminate(); } catch {} });
  const frames = [];
  ws.on('message', (data) => { try { frames.push(JSON.parse(data.toString())); } catch {} });
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  await waitUntil(() => frames.some((f) => f.type === 'hello'), { ...WAIT, what: 'the hello' });
  if (full) ws.send(JSON.stringify({ type: 'client', mirror: 'full' }));
  return { ws, frames, of: (type) => frames.filter((f) => f.type === type) };
}

// One raw request, so the test sets Origin, Sec-Fetch-* and the body itself.
function raw(port, { method = 'GET', path: p = '/', headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const data = body == null ? null : (Buffer.isBuffer(body) || typeof body === 'string' ? body : JSON.stringify(body));
    const r = http.request({
      host: '127.0.0.1', port, method, path: p, agent: false,
      headers: { ...(data != null ? { 'content-length': Buffer.byteLength(data) } : {}), ...headers },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch {}
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
      res.on('error', reject);
    });
    r.on('error', reject);
    if (data != null) r.write(data);
    r.end();
  });
}

// The answer origin, started as the chrome starts it (GET /api/asks?ensure=1).
async function answerOrigin(d) {
  const a = await d.get('/api/asks?ensure=1');
  assert.ok(a.answer && Number.isInteger(a.answer.port), `the answer surface listens: ${JSON.stringify(a.answer)}`);
  return { port: a.answer.port, origin: `http://127.0.0.1:${a.answer.port}` };
}
const nonceOf = (doc) => /name="wc-answer-nonce" content="([^"]*)"/.exec(doc.text)[1];
// A control frame's document (its nonce), as the chrome's mountControlFrame loads it.
async function controlFrame(d, action, params, layout = 'confirm') {
  const ao = await answerOrigin(d);
  const q = new URLSearchParams({ ...params, layout, mode: 'light' });
  const doc = await raw(ao.port, { path: `/answer/control/${action}?${q}` });
  assert.equal(doc.status, 200, `${action}'s document: ${doc.text.slice(0, 200)}`);
  const nonce = nonceOf(doc);
  assert.ok(nonce, 'a nonce minted for this action and target');
  return { ...ao, nonce };
}
function act(f, action, body) {
  return raw(f.port, {
    method: 'POST',
    path: `/answer/api/control/${action}`,
    headers: { origin: f.origin, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json', 'x-wc-answer': f.nonce },
    body,
  });
}
// An ask's frame: the document (its nonce) and the display view (its version).
async function askFrame(d, id) {
  const { port, origin } = await answerOrigin(d);
  const doc = await raw(port, { path: `/answer/ask/${id}?layout=card&mode=light` });
  assert.equal(doc.status, 200, doc.text.slice(0, 200));
  const nonce = nonceOf(doc);
  const view = await raw(port, { path: `/answer/api/asks/${id}?v=0`, headers: { 'x-wc-answer': nonce } });
  assert.equal(view.status, 200, view.text);
  return { port, origin, nonce, view: view.json };
}
function decide(f, id, decision) {
  return raw(f.port, {
    method: 'POST',
    path: `/answer/api/asks/${id}/decide`,
    headers: { origin: f.origin, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json', 'x-wc-answer': f.nonce },
    body: { decision, version: f.view.version, device: 'desktop' },
  });
}

// A hook subcommand as Claude Code runs it: a child, the payload on stdin.
function runHook(d, sub, payload, { env } = {}) {
  const started = Date.now();
  const child = spawn(process.execPath, [HOOK_BIN, sub], { cwd: d.root, env: env || d.hookEnv() });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (c) => { stdout += c; });
  child.stderr.on('data', (c) => { stderr += c; });
  child.stdin.on('error', () => {});
  const killer = setTimeout(() => child.kill('SIGKILL'), 30000);
  const done = new Promise((resolve, reject) => {
    child.on('error', (e) => { clearTimeout(killer); reject(e); });
    child.on('close', (status, signal) => { clearTimeout(killer); resolve({ status, signal, stdout, stderr, ms: Date.now() - started }); });
  });
  child.stdin.end(JSON.stringify(payload));
  return { child, done };
}

// Requests carrying x-test-peer arrive from that address (§10.1's network
// peer): their socket's remoteAddress is stubbed before the app sees them.
function stubPeers(server) {
  const onRequest = (req, res) => {
    const addr = req.headers['x-test-peer'];
    if (!addr) return;
    Object.defineProperty(req.socket, 'remoteAddress', { value: addr, configurable: true });
    res.once('close', () => { delete req.socket.remoteAddress; });
  };
  server.prependListener('request', onRequest);
  return () => server.off('request', onRequest);
}

const opsOf = (ops, name) => ops.filter((o) => o.op === name);
const settle = (ms = 300) => new Promise((resolve) => setTimeout(resolve, ms));

// ── the live feed (§15.7) ────────────────────────────────────────────────────

test('the fake mod\'s events reach the stream once each: a tool.call is a running card before any transcript record, and the tailer\'s copy lands on the same item', async (t) => {
  const d = await daemon(t);
  const local = await socket(t, d.port, { full: true });
  const { mod } = await d.attach();
  await d.fire('SessionStart', { source: 'startup', model: 'claude-test' });
  // The session's catch-up (index mode: no stream frame) ends with one reset.
  await waitUntil(() => local.of('mirror:reset').some((f) => f.conversation_id === S1), { ...WAIT, what: 'the catch-up' });
  await d.turnBegin('p-live', 'run the tests');
  const input = { command: 'npm test' };
  const sent = await mod.events([
    { kind: 'turn.start', at: Date.now(), turn_id: 'mt-1' },
    { kind: 'tool.call', at: Date.now(), tool_use_id: 'toolu_01ModBash', tool: 'Bash', input },
  ]);
  assert.deepEqual(sent.body, { ok: true, accepted: 2, dropped: 0 });
  const cardFrames = () => local.of('mirror:stream').filter((f) => (f.items || []).some((it) => it.id === 'toolu_01ModBash'));
  const card = await waitUntil(() => {
    const f = cardFrames()[0];
    return f ? f.items.find((it) => it.id === 'toolu_01ModBash') : null;
  }, { ...WAIT, what: 'the running card on a stream frame' });
  assert.equal(fs.existsSync(d.ch.transcript(S1)), false, 'no transcript record yet');
  assert.deepEqual([card.kind, card.status, card.tool, card.turn_id], ['tool_call', 'running', 'Bash', 'p-live']);
  const st = (await d.get('/api/bridge/status')).sessions.find((s) => s.session_id === S1);
  assert.ok(st, 'the bridge reports the session');
  const counters = d.srv.bridge.status().counters;
  assert.equal(counters.events_published, 2, 'each event published on the tap once');
  await settle(200);
  assert.equal(cardFrames().length, 1, 'the card reached the stream once');

  await mod.events([{ kind: 'tool.done', at: Date.now(), tool_use_id: 'toolu_01ModBash', ok: true, duration_ms: 1200 }]);
  await waitUntil(() => cardFrames().some((f) => f.items.some((it) => it.id === 'toolu_01ModBash' && it.status === 'done')),
    { ...WAIT, what: 'the card done' });

  // The tailer's later copy of the same tool_use.
  const r = createRecords({ seed: 61, sessionId: S1, cwd: d.ch.cwd, start: Date.now() - 2000, step: 10 });
  r.prompt('run the tests', { promptId: 'p-live' });
  r.assistant([{ type: 'tool_use', name: 'Bash', input, id: 'toolu_01ModBash' }]);
  r.toolResult('toolu_01ModBash', 'all green');
  d.ch.writeTranscript(S1, r.records);
  const page = await waitUntil(async () => {
    const p = await d.get(`/api/mirror/conversations/${S1}/turns?limit=50&items=full`);
    const items = (p.turns || []).flatMap((x) => x.items || []);
    const it = items.find((x) => x.id === 'toolu_01ModBash');
    return it && it.source === 'transcript' ? items : null;
  }, { ...WAIT, what: 'the transcript\'s copy of the call' });
  assert.equal(page.filter((it) => it.id === 'toolu_01ModBash').length, 1, 'one item, not two: the tailer\'s copy dropped onto it');
});

// ── control on the mod (§15.2 path 1, §6.9) ──────────────────────────────────

test('an interrupt of its conversation through the answer origin queues ONE abort op, via mod, and nothing on top', async (t) => {
  const d = await daemon(t);
  const { ops } = await d.attach({ abort: () => ({ aborted: true, stopped: ['b1a2c3d4'] }) });
  await working(d);
  const sse = await openSSE(d.port, { kinds: ['control'] });
  t.after(() => sse.close());
  const f = await controlFrame(d, 'interrupt', { conversation_id: S1 }, 'stop');
  const r = await act(f, 'interrupt', { conversation_id: S1, mode: 'now' });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual([r.json.ok, r.json.accepted, r.json.via], [true, true, 'mod']);
  const ev = await waitUntil(() => sse.events.find((e) => e.kind === 'control' && e.op === 'interrupt'), { ...WAIT, what: 'the control event' });
  assert.equal(ev.via, 'mod');
  assert.equal(ev.target_pid, undefined, 'no Esc is addressed');
  await settle();
  assert.equal(opsOf(ops, 'abort').length, 1, 'one abort op');
  assert.deepEqual(opsOf(ops, 'abort')[0].args, {});
  assert.equal(opsOf(ops, 'taskStop').length, 0, 'the backgrounded Bash is the mod\'s own TaskStop, inside the abort');
  assert.equal(sse.events.filter((e) => e.kind === 'control').length, 1, 'one control event: no tty or hook path on top');
});

test('a Kill through the stopper\'s control frame queues ONE taskStop op; POST /api/queue/task-stop still only queues the message', async (t) => {
  const d = await daemon(t);
  const { ops } = await d.attach({ taskStop: () => ({ stopped: true }) });
  await startShell(d, 'b7f3k2q9');
  const f = await controlFrame(d, 'task-stop', { task_id: 'b7f3k2q9' });
  const r = await act(f, 'task-stop', { task_id: 'b7f3k2q9' });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual([r.json.ok, r.json.via], [true, 'mod']);
  await waitUntil(() => opsOf(ops, 'taskStop').length === 1, { ...WAIT, what: 'the taskStop op' });
  assert.deepEqual(opsOf(ops, 'taskStop')[0].args, { task_id: 'b7f3k2q9' });

  // The pane-callable route: the same as a pane's fetch from the chrome.
  const before = ops.length;
  for (const headers of [{}, { Origin: `http://localhost:${d.port}` }]) {
    const q = await d.request('POST', '/api/queue/task-stop', { task_id: 'b7f3k2q9' }, headers);
    assert.equal(q.status, 200, JSON.stringify(q.body));
    assert.equal(q.body.ok, true, JSON.stringify(q.body));
  }
  const queued = await d.get('/api/queue');
  assert.ok((queued.items || []).some((it) => it.source === 'task-stop' && it.task_id === 'b7f3k2q9')
    || (await d.get('/api/queue/pending')).pending, 'the stop request is a message (queued or parked)');
  await settle();
  assert.equal(ops.length, before, 'the pane-callable route never reaches the mod');
});

// ── the composer on the mod (§15.7, §6.1) ────────────────────────────────────

test('a composer message goes as ONE submit op carrying the marked block, and its receipt confirms from the transcript', async (t) => {
  const d = await daemon(t);
  const { ops } = await d.attach({ submit: () => ({ submitted: true }) });
  await d.fire('SessionStart', { source: 'startup', model: 'claude-test' });
  const sent = await d.send({ text: SECRET_TEXT });
  assert.equal(sent.ok, true, JSON.stringify(sent));
  const submit = await waitUntil(() => opsOf(ops, 'submit')[0], { ...WAIT, what: 'the submit op' });
  await settle();
  assert.equal(opsOf(ops, 'submit').length, 1, 'one op');
  assert.ok(submit.args.text.includes(`Message from the user [web-chat message ${sent.msg_id}]:`), submit.args.text);
  assert.ok(submit.args.text.includes(SECRET_TEXT), 'the user\'s words, quoted');
  assert.ok(!submit.args.text.startsWith('/'), 'never a slash command as the user');
  assert.equal((await d.receipt(sent.msg_id)).state, 'sent');
  // Claude Code records the submitted prompt in the transcript: it confirms.
  const r = createRecords({ seed: 62, sessionId: S1, cwd: d.ch.cwd, start: Date.now() - 1000, step: 10 });
  r.prompt(submit.args.text, { promptId: 'p-web' });
  d.ch.writeTranscript(S1, r.records);
  await waitUntil(async () => (await d.receipt(sent.msg_id)).state === 'confirmed', { ...WAIT, what: 'the confirmed receipt' });
});

test('/plan goes as a command op; /model is refused', async (t) => {
  const d = await daemon(t);
  const { ops } = await d.attach({ command: () => ({ ran: true }) });
  await d.fire('SessionStart', { source: 'startup', model: 'claude-test' });
  const plan = await d.send({ text: '/plan' });
  assert.equal(plan.ok, true, JSON.stringify(plan));
  const cmd = await waitUntil(() => opsOf(ops, 'command')[0], { ...WAIT, what: 'the command op' });
  assert.deepEqual(cmd.args, { name: 'plan' });
  await waitUntil(async () => (await d.receipt(plan.msg_id)).state === 'confirmed', { ...WAIT, what: 'the command confirmed on the mod\'s ok' });
  const model = await d.send({ text: '/model opus' });
  assert.equal(model.ok, false, JSON.stringify(model));
  assert.equal(model.refused, 'builtin_command');
  await settle();
  assert.equal(opsOf(ops, 'command').length, 1, '/model queued nothing');
  assert.equal(opsOf(ops, 'submit').length, 0);
});

test('an image POSTed to /api/attachments and named in a message passes validation, and the submit op\'s block carries its File line', async (t) => {
  const d = await daemon(t);
  const { ops } = await d.attach({ submit: () => ({ submitted: true }) });
  await d.fire('SessionStart', { source: 'startup', model: 'claude-test' });
  const png = Buffer.concat([PNG_SIGNATURE, Buffer.alloc(40, 7)]);
  const up = await raw(d.port, { method: 'POST', path: '/api/attachments', headers: { 'content-type': 'image/png' }, body: png });
  assert.equal(up.status, 200, up.text);
  assert.match(up.json.path, /^\.web-chat\/attachments\/\d{8}-[0-9a-f]{8}\.png$/);
  const sent = await d.send({ text: 'what is in this screenshot?', files: [up.json.path] });
  assert.equal(sent.ok, true, JSON.stringify(sent));
  const submit = await waitUntil(() => opsOf(ops, 'submit')[0], { ...WAIT, what: 'the submit op' });
  assert.ok(submit.args.text.includes(`File attached: ${up.json.path}`), submit.args.text);
});

test('the lock and the committed node of a turn a mod-submitted message opened say \'web message m-…\', never the text', async (t) => {
  const d = await daemon(t);
  const { ops } = await d.attach({ submit: () => ({ submitted: true }) });
  await d.fire('SessionStart', { source: 'startup', model: 'claude-test' });
  const sent = await d.send({ text: SECRET_TEXT });
  const submit = await waitUntil(() => opsOf(ops, 'submit')[0], { ...WAIT, what: 'the submit op' });
  assert.equal((await d.get('/api/graph')).lock, null, 'the transport took no wake lock');
  // Claude Code runs the submitted prompt: its UserPromptSubmit hook.
  const out = await runHook(d, 'turn-begin', { session_id: S1, transcript_path: d.ch.transcript(S1), cwd: d.ch.cwd,
    hook_event_name: 'UserPromptSubmit', prompt: submit.args.text, prompt_id: 'p-web', permission_mode: 'default' }).done;
  assert.equal(out.status, 0, out.stderr);
  const g = await d.get('/api/graph');
  assert.equal(g.lock && g.lock.message, `web message ${sent.msg_id}`);
  assert.ok(!JSON.stringify(g).includes(SECRET_TEXT), 'the graph never holds the text');
  await d.post('/api/render', { id: 't6-web', html: '<p>answered</p>' });
  const end = await d.turnEnd('Done.');
  assert.ok(end.node_id, `the turn committed a node: ${JSON.stringify(end)}`);
  const node = await d.get(`/api/graph/node/${encodeURIComponent(end.node_id)}`);
  assert.equal(node.trigger.message, `web message ${sent.msg_id}`);
  assert.ok(!JSON.stringify(node).includes(SECRET_TEXT), 'the node never holds the text');
});

// ── the in-place resume (§15.6) ──────────────────────────────────────────────

// Two closed turns of S1, idle, in its transcript.
async function twoTurns(d) {
  const r = createRecords({ seed: 31, sessionId: S1, cwd: d.ch.cwd, start: Date.now() - 60000, step: 10 });
  r.prompt('first prompt', { promptId: 'pf-1' });
  r.assistant(['reply one']);
  r.turnDuration({ durationMs: 30 });
  r.prompt('second prompt, refill me', { promptId: 'pf-2' });
  r.assistant(['reply two']);
  r.turnDuration({ durationMs: 30 });
  d.ch.writeTranscript(S1, r.records);
  await d.fire('SessionStart', { source: 'startup', model: 'claude-test' });
  await waitUntil(async () => {
    const p = await d.get(`/api/mirror/conversations/${S1}/turns?limit=50&items=summary`);
    return p && (p.turns || []).filter((x) => x.status !== 'open').length === 2;
  }, { ...WAIT, what: 'the two closed turns' });
}

test('the in-place resume is refused without WEB_CHAT_REWIND_IN_PLACE, and with it and a confirm queues command: resume', async (t) => {
  // Off (the shipped default): refused 'off', no op.
  const off = await daemon(t, { claude: true });
  const a = await off.attach({ command: () => ({ ran: true }), fill: () => ({ filled: true }) });
  await twoTurns(off);
  assert.equal((await off.snapshot()).capabilities.rewind_in_place, false, 'not offered without the flag');
  const refused = await act(await controlFrame(off, 'resume', { turn_id: 'pf-2' }), 'resume', { turn_id: 'pf-2' });
  assert.notEqual(refused.status, 200, refused.text);
  assert.equal(refused.json.refused, 'off');
  await settle();
  assert.equal(a.ops.length, 0, 'nothing queued');

  // On: one confirm → command resume to the fork, then the prompt's fill.
  const on = await daemon(t, { claude: true, env: { [FLAG]: '1' } });
  const b = await on.attach({ command: () => ({ ran: true }), fill: () => ({ filled: true }) });
  await twoTurns(on);
  assert.equal((await on.snapshot()).capabilities.rewind_in_place, true, 'offered: the flag and a mod');
  const ok = await act(await controlFrame(on, 'resume', { turn_id: 'pf-2' }), 'resume', { turn_id: 'pf-2' });
  assert.equal(ok.status, 200, ok.text);
  assert.deepEqual([ok.json.ok, ok.json.via, ok.json.filled], [true, 'mod', true]);
  assert.deepEqual(opsOf(b.ops, 'command').map((o) => o.args), [{ name: 'resume', args: FORKED }]);
  await waitUntil(() => opsOf(b.ops, 'fill').length === 1, { ...WAIT, what: 'the fill' });
  assert.deepEqual(opsOf(b.ops, 'fill')[0].args, { text: 'second prompt, refill me' });
});

// ── who may call the bridge (§15.7, §5.7 P1) ─────────────────────────────────

test('a bridge call from a browser, a remote viewer or a network peer is refused, and one with a wrong token too', async (t) => {
  const d = await daemon(t);
  t.after(stubPeers(d.server));
  const m = d.mod();
  const body = {
    v: 1, protocol: 1, session_id: S1, cwd: d.root, cc_version: '2.1.296', mod_version: '0.8.5-test',
    ops: [...OPS], events: [], root: d.root,
  };
  for (const [who, headers] of [
    ['a browser', { Origin: `http://localhost:${d.port}` }],
    ['a browser\'s fetch metadata', { 'Sec-Fetch-Site': 'same-origin', 'Sec-Fetch-Mode': 'cors' }],
    ['a remote viewer', { 'X-WC-Remote': '1' }],
    ['a network peer', { 'x-test-peer': PEER }],
  ]) {
    const r = await m.request('POST', '/api/bridge/hello', body, headers);
    assert.equal(r.status, 403, `${who}: ${JSON.stringify(r.body)}`);
    assert.deepEqual(r.body, { ok: false, hint: HOST_HINT }, who);
  }
  assert.equal(d.srv.bridge.attached(S1), false, 'no hello attached anything');
  const hi = await m.hello();
  assert.equal(hi.status, 200, 'the host\'s own hello');
  const good = m.token;
  m.token = crypto.randomBytes(24).toString('hex');
  for (const [method, p, b] of [['GET', '/api/bridge/ops?wait=0', null], ['POST', '/api/bridge/result', { id: 'x', ok: true }],
    ['POST', '/api/bridge/events', { events: [] }]]) {
    const r = await m.request(method, p, b, { 'X-WC-Bridge': m.token });
    assert.equal(r.status, 401, `${method} ${p} with a wrong token`);
    assert.equal(r.body.refused, 'token');
  }
  m.token = good;
  assert.equal((await m.poll({ wait: 0 })).status, 200, 'the right token still works');
});

// ── tier 1 (§15.1) ───────────────────────────────────────────────────────────

test('with no mod every path takes tier 1: the hook halt, the queue\'s message, refusals naming the mod, no op', async (t) => {
  const d = await daemon(t, { claude: true, env: { [FLAG]: '1' } });
  await startShell(d, 'b0000001');
  const c = await working(d);
  assert.equal(c.process.mod, false, 'process.mod false');
  const caps = (await d.snapshot()).capabilities;
  assert.deepEqual([caps.mod, caps.rewind_in_place], [false, false]);
  assert.equal(d.srv.messageTransport !== null, true, 'the transport is wired, and declines with no mod');
  // The interrupt: no tty row, no mod → the hook halt.
  const stop = await act(await controlFrame(d, 'interrupt', { conversation_id: S1 }, 'stop'), 'interrupt', { conversation_id: S1, mode: 'now' });
  assert.equal(stop.json.via, 'hook', stop.text);
  // A message: the channel or the park (no channel here: parked), never an op.
  const sent = await d.send({ text: 'when you are free' });
  assert.equal(sent.ok, true, JSON.stringify(sent));
  assert.notEqual(sent.mode, 'transported', JSON.stringify(sent));
  // /plan is refused with the mod's hint.
  const plan = await d.send({ text: '/plan' });
  assert.deepEqual([plan.ok, plan.refused], [false, 'builtin_command']);
  // The stopper's row refuses 'no-mod' (the tray's Kill keeps the message).
  const kill = await act(await controlFrame(d, 'task-stop', { task_id: 'b0000001' }), 'task-stop', { task_id: 'b0000001' });
  assert.notEqual(kill.status, 200, kill.text);
  assert.equal(kill.json.refused, 'no-mod', kill.text);
  // The bridge has nobody; its status says so.
  assert.deepEqual((await d.get('/api/bridge/status')).sessions, []);
});

// ── the asks on the mod, and the elicitation hook (beyond §11.9) ─────────────

test('with the permission wait raised, a request the fake mod reports joins the asks and its web decision is ONE permissionDecision op; shipped, the hello says 0', async (t) => {
  const shipped = await daemon(t);
  const plain = await shipped.attach();
  assert.equal(plain.hello.body.permission_wait_ms, 0, 'the shipped wait: the mod passes every prompt on');

  const d = await daemon(t, { waitMs: RAISED_WAIT_MS });
  const local = await socket(t, d.port, { full: true });
  const { mod, ops, hello } = await d.attach();
  assert.equal(hello.body.permission_wait_ms, RAISED_WAIT_MS);
  await d.fire('SessionStart', { source: 'startup', model: 'claude-test' });
  await mod.events([{ kind: 'permission.request', at: Date.now(), request_id: 'pr_t6_1', tool: 'Bash', input: { command: 'npm run build' } }]);
  const ask = await waitUntil(async () => ((await d.get('/api/asks')).asks || []).find((a) => a.state === 'pending') || null,
    { ...WAIT, what: 'the mod\'s ask' });
  assert.equal(d.srv.asks.get(ask.id).transport, 'mod');
  assert.equal(ask.answerable, true, 'a local viewer: the page may answer it');
  const opens = local.of('mirror:ask').filter((f) => f.op === 'open');
  assert.equal(opens.length, 1, 'one mirror:ask open');
  assert.equal(opens[0].ask.id, ask.id);
  const f = await askFrame(d, ask.id);
  const r = await decide(f, ask.id, { behavior: 'allow' });
  assert.equal(r.status, 200, r.text);
  const dec = await waitUntil(() => opsOf(ops, 'permissionDecision')[0], { ...WAIT, what: 'the decision op' });
  assert.deepEqual(dec.args, { request_id: 'pr_t6_1', decision: { behavior: 'allow' } });
  assert.ok(!JSON.stringify(ops).includes('updatedPermissions'), 'no updatedPermissions');
  await settle();
  assert.equal(opsOf(ops, 'permissionDecision').length, 1, 'one op');
});

const ELICIT_SCHEMA = { type: 'object', properties: { name: { type: 'string', title: 'Name' } }, required: ['name'] };
const elicitPayload = (d, id) => ({
  session_id: S1, transcript_path: d.ch.transcript(S1), cwd: d.ch.cwd, hook_event_name: 'Elicitation',
  mcp_server_name: 'scratch', message: 'Who is asking?', mode: 'form', elicitation_id: id, requested_schema: ELICIT_SCHEMA,
});

test('the Elicitation hook against the daemon: with a local viewer a decision through the answer origin prints exactly buildElicitationOutput\'s line; with none it prints nothing at once', async (t) => {
  const d = await daemon(t);
  await d.fire('SessionStart', { source: 'startup', model: 'claude-test' });
  // No viewer: the hook does not wait (the terminal's dialog shows).
  const alone = await runHook(d, 'elicit', elicitPayload(d, 'el-alone')).done;
  assert.deepEqual([alone.status, alone.stdout], [0, ''], alone.stderr);
  if (process.env.WEB_CHAT_PERF === '1') assert.ok(alone.ms < 1000, `out within 1 s (${alone.ms} ms)`);
  else t.diagnostic(`no viewer: the hook exited in ${alone.ms} ms`);
  assert.equal(((await d.get('/api/asks')).asks || []).filter((a) => a.state === 'pending' && a.answerable).length, 0,
    'nothing the page could answer: the hook did not wait');

  const viewer = await socket(t, d.port);
  assert.ok(viewer);
  const run = runHook(d, 'elicit', elicitPayload(d, 'el-42'));
  const ask = await waitUntil(async () => ((await d.get('/api/asks')).asks || []).find((a) => a.kind === 'elicitation' && a.state === 'pending' && a.answerable) || null,
    { ...WAIT, what: 'the elicitation ask' });
  const f = await askFrame(d, ask.id);
  const decision = { behavior: 'accept', content: { name: 'Grace' } };
  const r = await decide(f, ask.id, decision);
  assert.equal(r.status, 200, r.text);
  const out = await run.done;
  assert.equal(out.status, 0, out.stderr);
  assert.equal(out.stdout, buildElicitationOutput(decision, formSchema(ELICIT_SCHEMA)));
  assert.equal(out.stdout, '{"hookSpecificOutput":{"hookEventName":"Elicitation","action":"accept","content":{"name":"Grace"}}}');
});

// ── the capabilities (§15.1, §15.6) ──────────────────────────────────────────

test('GET /api/mirror at local: capabilities.mod (and process.mod) true with the fake mod attached, false after its pid dies; rewind_in_place only with the flag and a mod', async (t) => {
  // S1's Claude Code is a child process this test can kill.
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1e9)'], { stdio: 'ignore' });
  const exited = new Promise((resolve) => child.once('exit', resolve));
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited; } });
  const d = await daemon(t, { pid: child.pid, env: { [FLAG]: '1' } });
  // S1 at work, so the live machine samples its process every 5 s (two
  // samples that find it gone make it gone: GONE_SAMPLES).
  d.ch.writeSession({ pid: child.pid, procStart: d.procStart, sessionId: S1, status: 'busy' });
  await d.fire('SessionStart', { source: 'startup', model: 'claude-test' });
  await d.fire('PreToolUse', { tool_name: 'Bash', tool_use_id: 'toolu_01Caps', tool_input: { command: 'npm test' } });
  await waitUntil(async () => { const c = await d.conversation(); return c && c.process && c.process.pid === child.pid; },
    { ...WAIT, what: 'S1\'s process' });
  let s = await d.snapshot();
  assert.deepEqual([s.capabilities.mod, s.capabilities.rewind_in_place], [false, false], 'no mod yet');
  assert.equal(s.conversations.find((c) => c.id === S1).process.mod, false);

  const { mod } = await d.attach();
  s = await waitUntil(async () => {
    const x = await d.snapshot();
    const c = x.conversations.find((y) => y.id === S1);
    return x.capabilities.mod === true && c.process && c.process.mod === true ? x : null;
  }, { ...WAIT, what: 'capabilities.mod and process.mod true' });
  assert.equal(s.capabilities.rewind_in_place, true, 'the flag and a mod');
  // The context meter's reading (U93): the mod's session.measure on the real
  // tap reaches the readings createServer wired, and GET /api/mirror/context
  // is mounted on the daemon (503 unwired; 404 unmounted).
  assert.deepEqual(await d.get(`/api/mirror/context?conversation=${S1}`), { ok: true, context: null }, 'no reading yet');
  await mod.events([{ kind: 'session.measure', at: Date.now(), changed: ['context'], context: { tokens: 76000, window: 200000 } }]);
  const ctxRead = await waitUntil(async () => {
    const r = await d.get(`/api/mirror/context?conversation=${S1}`);
    return r.ok === true && r.context ? r : null;
  }, { ...WAIT, what: 'the reading on GET /api/mirror/context' });
  assert.deepEqual([ctxRead.context.tokens, ctxRead.context.window, ctxRead.context.percent], [76000, 200000, 38]);

  child.kill('SIGKILL');
  await exited;
  s = await waitUntil(async () => {
    const x = await d.snapshot();
    return x.capabilities.mod === false ? x : null;
  }, { timeout: 30000, interval: 50, what: 'capabilities.mod false once its pid died (two 5 s samples)' });
  assert.equal(s.capabilities.rewind_in_place, false, 'no mod: no in-place resume');
  assert.equal(d.srv.bridge.attached(S1), false, 'the bridge detached the session');
});

// ── teardown ─────────────────────────────────────────────────────────────────

function refCounts() {
  const out = {};
  for (const type of process.getActiveResourcesInfo()) out[type] = (out[type] || 0) + 1;
  return out;
}
function excess(base, now = refCounts()) {
  return Object.keys(now).filter((type) => now[type] > (base[type] || 0)).map((type) => `${type} ×${now[type] - (base[type] || 0)}`);
}
const HANDLE_TYPES = new Set(['TCPWRAP', 'TCPSERVERWRAP', 'PIPEWRAP', 'PIPESERVERWRAP', 'PROCESSWRAP', 'FSEVENTWRAP',
  'STATWATCHER', 'SIGNALWRAP', 'UDPWRAP']);
function trackHandles() {
  const timers = new Set();
  const handles = new Map();
  const hook = createHook({
    init(id, type, _trigger, resource) {
      if (type === 'Timeout') timers.add(resource);
      else if (HANDLE_TYPES.has(type)) handles.set(id, type);
    },
    destroy(id) { handles.delete(id); },
  }).enable();
  return {
    open() {
      const out = [...handles.values()];
      for (const tm of timers) {
        assert.equal(typeof tm._destroyed, 'boolean', 'a Timeout says whether it is spent (Node internals moved: update trackHandles)');
        if (!tm._destroyed) out.push(`Timeout(${tm._idleTimeout} ms${tm._repeat ? ', repeating' : ''}${tm.hasRef() ? '' : ', unref\'d'})`);
      }
      return out;
    },
    stop() { hook.disable(); },
  };
}

// The daemon with tranche 6's handles all busy — a mod attached, its op
// long-poll held open, a mod ask pending (a local viewer, the wait raised) and
// the message transport set — then `teardown`; then nothing of the daemon's
// may be left, and the transport is gone.
async function exitsClean(t, teardown) {
  const base = refCounts();
  const tracker = trackHandles();
  t.after(() => tracker.stop());
  const d = await daemon(t, { waitMs: RAISED_WAIT_MS });
  t.after(async () => { if (d.server.listening) await d.srv.stop(); });
  const ws = wsConnect(d.port, '/ws'); // a local viewer: the mod's ask waits for the page
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  const mod = d.mod();
  assert.equal((await mod.hello()).status, 200);
  await d.fire('SessionStart', { source: 'startup', model: 'claude-test' });
  await mod.events([{ kind: 'permission.request', at: Date.now(), request_id: 'pr_t6_down', tool: 'Bash', input: { command: 'rm -rf dist' } }]);
  await waitUntil(async () => ((await d.get('/api/asks')).asks || []).some((a) => a.state === 'pending'), { ...WAIT, what: 'the pending mod ask' });
  assert.equal(typeof d.srv.messageTransport, 'function', 'the transport is set');
  await mod.events([{ kind: 'session.measure', at: Date.now(), changed: ['context'], context: { tokens: 1000, window: 200000 } }]);
  await waitUntil(() => d.srv.contextReadings.size() === 1, { ...WAIT, what: 'the context reading held' });
  const held = mod.poll({ wait: 20000 }).catch((e) => ({ error: e })); // the op long-poll, held open
  await waitUntil(() => d.srv.bridge.status().sessions.some((s) => s.polling), { ...WAIT, what: 'the long-poll held' });

  await teardown(d);
  ws.terminate();
  await held; // the long-poll ended with the bridge
  assert.equal(d.server.listening, false, 'the server is closed');
  assert.equal(d.srv.messageTransport, null, 'state.messageTransport is back to null');
  assert.equal(d.srv.bridge.any(), false, 'no mod attached');
  assert.equal(d.srv.bridge.status().running, false, 'the bridge stopped');
  assert.equal(d.srv.contextReadings.size(), 0, 'the readings stopped: their tap subscription is off and the readings forgotten');
  const left = await waitUntil(() => (tracker.open().length === 0 && excess(base).length === 0 ? 'clean' : null), { timeout: 15000, interval: 20 })
    .catch(() => null);
  assert.ok(left, `left behind — handles and timers: [${tracker.open().join(', ')}]; beyond the baseline: [${excess(base).join(', ')}]`);
}

test('srv.stop() leaves no open handle: a mod attached, its op long-poll held, a mod ask pending, the transport set', async (t) => {
  await exitsClean(t, (d) => d.srv.stop());
});

test('gracefulShutdown() leaves no open handle: a mod attached, its op long-poll held, a mod ask pending, the transport set', async (t) => {
  await exitsClean(t, (d) => d.srv.gracefulShutdown());
});

// ── the bus wire ─────────────────────────────────────────────────────────────

// test/bus-golden.test.js's sha256, as tranches 1-3's end-to-end files hold it.
const BUS_GOLDEN_SHA256 = '235cabffa00d1a76c0e29f77c4380f30e3361248f8221d2ebffc8c585e23216a';

test('test/bus-golden.test.js is byte-identical', () => {
  const src = fs.readFileSync(path.join(REPO, 'test', 'bus-golden.test.js'), 'utf8').replace(/\r\n/g, '\n');
  assert.equal(crypto.createHash('sha256').update(src).digest('hex'), BUS_GOLDEN_SHA256,
    'test/bus-golden.test.js changed: the spec holds the bus wire and its golden byte-identical for 0.8.5 (§2.9, §10.2)');
});
