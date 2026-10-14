// Tranche 4 of the chat mirror, end to end: the control layer (design spec
// §11.7, "End-to-end checks (U66a)", §15.2-§15.6; rulings B1-B6, E-confirm
// (4)). The daemon exactly as createServer wires it — the control domain
// registered as kind 'control' on the answer surface, the revert rows over the
// one shadow store the codediff source snapshots through, the fork row — and
// Claude Code played by its hooks' code, a sessions file and an MCP presence
// row (test-support/claude-home), a synthetic transcript, a scratch git
// repository (test-support/treesnap-fixture), and a stub `claude` first on
// PATH (helpers fakeBin) that answers `agents --json` and a fork and records
// its argv: no real Claude Code runs here, and no opt-in gate.
//
// Pinned, a test per clause:
//   * an interrupt posted through the answer origin with its nonce, for a
//     working conversation whose MCP row says tty, puts ONE control event with
//     target_pid and a 2 s expiry on an SSE consumer; a second within 1.5 s is
//     refused rate_limited;
//   * the same request marked remote: the answer surface refuses it over HTTP
//     (403, until tranche 7's U74), and through control.invoke(…, {remote:
//     true}) it writes the halt flag; the halt script then prints its halt
//     output for that session; the flag is gone once the turn closes, and the
//     node that turn commits says ended_by 'hook';
//   * an accepted tty interrupt, then the turn closing interrupted: its node
//     says ended_by 'web';
//   * the same POST from the chrome's origin, or with no Origin, is refused;
//   * a restore is refused while the lock is held, applied byte for byte when
//     idle, undone byte for byte, and the next turn-begin carries its notice
//     exactly once;
//   * a fork against the stub claude answers the resume command, and its argv
//     holds no user text;
//   * GET /api/mirror at local carries the six provided capabilities true in a
//     git repository (git ≥ 2.40), and code_revert false with
//     WEB_CHAT_MIRROR_DIFFS=0;
//   * the server leaves no open handle through srv.stop() and through
//     gracefulShutdown(), with an ask pending, a control frame's surface up, an
//     index build in flight and the release scheduler holding a queued message.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const { createHook } = require('node:async_hooks');

const { withServer, withTempHome, tmpRoot, waitUntil, wsConnect, openSSE, fakeBin } = require('../test-support/helpers');
const { claudeHome } = require('../test-support/claude-home');
const { createRecords } = require('../test-support/claude-records');
const { treesnapRepo, gitDirDigest } = require('../test-support/treesnap-fixture');
const client = require('../lib/client');
const { hookEnvelope } = require('../lib/hooks/envelope');
const { sessionFields } = require('../lib/hooks/turn-begin');
const { postEnvelope } = require('../lib/hooks/mirror');
const { projectPaths, userPaths, PACKAGE_ROOT } = require('../lib/core/paths');
const { sampleProcs, formatProcStart } = require('../lib/core/portfiles');
const { SAME_TARGET_MS } = require('../lib/server/control/revert');

const HOOK_BIN = path.join(PACKAGE_ROOT, 'bin', 'claude-web-chat-hook.js');
const HALT_SCRIPT = path.join(PACKAGE_ROOT, 'lib', 'hooks', 'claude-web-chat-hook-halt.sh');
const HALT_PRE = '{"continue":false,"stopReason":"Stopped from the web-chat page","hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"The user stopped this turn from the web-chat page."}}';
const S1 = '11111111-1111-4111-8111-111111111111';
const FORKED = '99999999-9999-4999-8999-999999999999';
const CALL_TIMEOUT_MS = 15000;
const WAIT = { timeout: 15000, interval: 10 };
const SETTLE_WAIT = { timeout: 25000, interval: 10 };
const PROVIDED = ['answer', 'task_stop', 'queue_message', 'interrupt', 'code_revert', 'fork'];

// ── the stub claude ──────────────────────────────────────────────────────────

// `claude agents --json` answers no session; a fork answers a new session id
// as `--output-format json` does. Every argv is appended to $ARGV_LOG.
const FAKE_CLAUDE = `
const fs = require('fs');
const argv = process.argv.slice(2);
fs.appendFileSync(process.env.ARGV_LOG, JSON.stringify(argv) + '\\n');
if (argv[0] === 'agents') process.stdout.write('[]\\n');
else if (argv.includes('--fork-session')) process.stdout.write(JSON.stringify({ type: 'result', session_id: ${JSON.stringify(FORKED)} }) + '\\n');
`;

// The stub, first on PATH for this test (findClaude reads PATH at each call).
function stubClaude(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-t4ctl-claude-'));
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

// A project, a private Claude tier and its daemon. `session`: this process
// plays the Claude Code process of S1 (its sessions file, a live procStart);
// `tty`: its MCP server's presence row says it can inject an Esc. HOME is the
// test's own before anything reads it (the registry, the halt flags).
async function daemon(t, { git = false, files, session = false, tty = false, env = {} } = {}) {
  const home = withTempHome(t);
  const claude = stubClaude(t);
  let ctx = null;
  t.after(async () => { if (ctx) await ctx.stop(); });
  const saved = {};
  for (const [k, v] of Object.entries(env)) { saved[k] = process.env[k]; process.env[k] = v; }
  t.after(() => { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });
  const repo = git ? treesnapRepo(t, { files: files || { 'README.md': 'scratch\n' } }) : null;
  const dir = repo ? repo.root : tmpRoot('wc-t4ctl-');
  const ch = claudeHome(t, { root: dir, isolate: true });
  let procStart = null;
  if (session) {
    procStart = formatProcStart((await sampleProcs([process.pid])).get(process.pid).startedAt);
    ch.writeSession({ pid: process.pid, procStart, sessionId: S1, status: 'idle' });
  }
  if (tty) ch.addMcp({ pid: process.pid, ppid: process.pid, root: ch.cwd, interrupt: 'tty' });
  ctx = await withServer(t, { root: dir, writePortfile: true });
  await ctx.srv.controlStarted;
  return driver(ctx, { ch, repo, home: typeof home === 'string' ? home : process.env.HOME, claude, procStart });
}

function driver(ctx, { ch, repo, home, claude, procStart }) {
  const call = { port: ctx.port, noSpawn: true, timeout: CALL_TIMEOUT_MS };
  const env = { CLAUDE_CODE_ENTRYPOINT: 'cli', CLAUDE_PID: String(process.pid) };
  let clock = Date.now();
  const stamp = () => { clock = Math.max(clock + 1, Date.now()); return clock; };
  const envelope = (event, extra = {}, sid = S1) => hookEnvelope({ hook_event_name: event, session_id: sid,
    transcript_path: ch.transcript(sid), cwd: ch.cwd, permission_mode: 'default', ...extra }, env, { now: stamp() });
  const d = {
    ...ctx,
    ch,
    repo,
    home,
    claude,
    procStart,
    call,
    get: (p) => client.get(p, call),
    post: (p, body) => client.post(p, body, call),
    async fire(event, extra, sid) {
      assert.equal(await postEnvelope(envelope(event, extra, sid), { root: ctx.root, timeout: CALL_TIMEOUT_MS }), 'posted', event);
    },
    turnBegin(promptId, text, sid = S1) {
      const e = envelope('UserPromptSubmit', { prompt: text, prompt_id: promptId }, sid);
      return client.post('/api/turn-begin', { message: text, author: 'user', ...sessionFields(e), prompt: e.prompt }, call);
    },
    turnEnd(reply, { sid = S1 } = {}) {
      const e = envelope('Stop', { last_assistant_message: reply }, sid);
      return client.post('/api/turn-end', { author: 'claude', reply, ended: 'stop', ...sessionFields(e),
        last_assistant_message: e.stop.last_assistant_message }, call);
    },
    async edit(file, useId) {
      const input = { file_path: file, old_string: 'a', new_string: 'b' };
      await d.fire('PreToolUse', { tool_name: 'Edit', tool_use_id: useId, tool_input: input });
      await d.fire('PostToolUse', { tool_name: 'Edit', tool_use_id: useId, tool_input: input, tool_response: { filePath: file }, duration_ms: 3 });
    },
    conversation: async (cid = S1) => ((await client.get('/api/mirror', call)).conversations || []).find((c) => c.id === cid) || null,
    async snapshots() {
      const s = await client.get('/api/mirror', call);
      return (s.diagnostics && s.diagnostics.git && s.diagnostics.git.snapshots) || 0;
    },
    // Esc in the terminal: Claude Code writes idle to its sessions file and fires no Stop.
    escInTerminal() {
      const at = Date.now();
      ch.writeSession({ pid: process.pid, procStart, sessionId: S1, status: 'idle', updatedAt: at, statusUpdatedAt: at });
    },
    hookEnv(extra = {}) {
      const e = { ...process.env, CLAUDE_PID: String(process.pid), CLAUDE_CODE_ENTRYPOINT: 'cli', ...extra };
      delete e.WEB_CHAT_HOOK_LOG;
      return e;
    },
  };
  return d;
}

// A turn underway: S1's process busy, a prompt (the lock), a tool running and
// a pane rendered (so the turn has a node to commit), the mirror seeing it work.
async function working(d, promptId = 'p-work') {
  d.ch.writeSession({ pid: process.pid, procStart: d.procStart || null, sessionId: S1, status: 'busy' });
  await d.fire('SessionStart', { source: 'startup', model: 'claude-test' });
  await d.turnBegin(promptId, 'run the slow tests');
  await d.fire('PreToolUse', { tool_name: 'Bash', tool_use_id: `toolu_01${promptId.replace(/\W/g, '')}`, tool_input: { command: 'npm test' } });
  await d.post('/api/render', { id: `t4ctl-${promptId}`, html: '<p>running</p>' });
  return waitUntil(async () => {
    const c = await d.conversation();
    return c && c.process && c.process.pid === process.pid && c.live && c.live.state === 'working' ? c : null;
  }, { ...WAIT, what: 'the mirror to see S1 working, with its process' });
}

// A hook subcommand as Claude Code runs it: a child, the payload on stdin.
function runHook(d, sub, payload) {
  const child = spawn(process.execPath, [HOOK_BIN, sub], { cwd: d.root, env: d.hookEnv() });
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
    child.on('close', (status, signal) => { clearTimeout(killer); resolve({ status, signal, stdout, stderr }); });
  });
  child.stdin.end(JSON.stringify(payload));
  return { child, done };
}
const promptPayload = (d, promptId, prompt) => ({ session_id: S1, transcript_path: d.ch.transcript(S1), cwd: d.ch.cwd,
  hook_event_name: 'UserPromptSubmit', prompt, prompt_id: promptId, permission_mode: 'default' });

function raw(port, { method = 'GET', path: p = '/', headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const data = body == null ? null : (typeof body === 'string' ? body : JSON.stringify(body));
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
// A control frame's document (its nonce), as the chrome's mountControlFrame loads it.
async function controlFrame(d, action, params, layout) {
  const ao = await answerOrigin(d);
  const q = new URLSearchParams({ ...params, layout, mode: 'light' });
  const doc = await raw(ao.port, { path: `/answer/control/${action}?${q}` });
  assert.equal(doc.status, 200, `${action}'s document: ${doc.text.slice(0, 200)}`);
  const nonce = /name="wc-answer-nonce" content="([^"]*)"/.exec(doc.text)[1];
  assert.ok(nonce, 'a nonce minted for this action and target');
  return { ...ao, nonce };
}
function act(f, action, body, { origin = f.origin, headers = {} } = {}) {
  return raw(f.port, {
    method: 'POST',
    path: `/answer/api/control/${action}`,
    headers: {
      ...(origin ? { origin } : {}), 'sec-fetch-site': 'same-origin', 'content-type': 'application/json',
      'x-wc-answer': f.nonce, ...headers,
    },
    body,
  });
}

// The node the turn guard committed for a turn closed with no Stop (it waits
// the settle window for one first).
async function guardNode(t, d) {
  const added = [];
  const ws = wsConnect(d.port, '/ws');
  t.after(() => { try { ws.terminate(); } catch {} });
  ws.on('message', (data) => { try { const f = JSON.parse(data.toString()); if (f.type === 'node-added') added.push(f); } catch {} });
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  return async () => {
    const f = await waitUntil(() => added.at(-1), { ...SETTLE_WAIT, what: 'the guard\'s commit' });
    return d.get(`/api/graph/node/${encodeURIComponent(f.node.id)}`);
  };
}

// ── interrupt (§15.2) ────────────────────────────────────────────────────────

test('an interrupt through the answer origin puts ONE tty control event with target_pid and a 2 s expiry; a second within 1.5 s is refused', async (t) => {
  const d = await daemon(t, { session: true, tty: true });
  const c = await working(d);
  assert.equal(c.process.interrupt, 'tty', 'the MCP row says the session can take an Esc');
  const sse = await openSSE(d.port, { kinds: ['control'] });
  t.after(() => sse.close());
  const f = await controlFrame(d, 'interrupt', { conversation_id: S1 }, 'stop');
  const t0 = Date.now();
  const r = await act(f, 'interrupt', { conversation_id: S1, mode: 'now' });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.ok, true);
  assert.equal(r.json.accepted, true);
  assert.equal(r.json.via, 'tty');
  const ev = await waitUntil(() => sse.events.find((e) => e.kind === 'control' && e.op === 'interrupt'), { ...WAIT, what: 'the control event' });
  assert.equal(ev.via, 'tty');
  assert.equal(ev.target_pid, process.pid, 'addressed to the Claude Code process');
  assert.equal(ev.conversation_id, S1);
  assert.ok(ev.expires_at - t0 > 1500 && ev.expires_at - Date.now() <= 2000, `a 2 s expiry (${ev.expires_at - t0} ms after the click)`);

  const again = await act(await controlFrame(d, 'interrupt', { conversation_id: S1 }, 'stop'), 'interrupt', { conversation_id: S1, mode: 'now' });
  assert.equal(again.status, 429, again.text);
  assert.equal(again.json.refused, 'rate_limited');
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(sse.events.filter((e) => e.kind === 'control').length, 1, 'exactly one control event');
});

test('an accepted tty interrupt, then the turn closing interrupted: its node says ended_by \'web\'', async (t) => {
  const d = await daemon(t, { session: true, tty: true });
  await working(d);
  const nodeOf = await guardNode(t, d);
  const f = await controlFrame(d, 'interrupt', { conversation_id: S1 }, 'stop');
  const r = await act(f, 'interrupt', { conversation_id: S1, mode: 'now' });
  assert.equal(r.json.via, 'tty', r.text);
  d.escInTerminal(); // the injected Esc lands: busy → idle, and no Stop
  const node = await nodeOf();
  assert.equal(node.trigger.ended, 'interrupted');
  assert.equal(node.trigger.ended_by, 'web', 'the page stopped it');
});

test('the remote request: the answer surface\'s own HTTP route refuses it below `full` (a remote viewer comes in only through the portal\'s answer host); through control.invoke it writes the halt flag, the halt script halts, the flag goes with the turn, ended_by \'hook\'', async (t) => {
  const d = await daemon(t, { session: true, tty: true });
  await working(d);
  const f = await controlFrame(d, 'interrupt', { conversation_id: S1 }, 'stop');
  const http403 = await act(f, 'interrupt', { conversation_id: S1, mode: 'now' }, { headers: { 'x-wc-remote': '1' } });
  assert.equal(http403.status, 403, 'the answer surface refuses every X-WC-Remote request in tranche 4');
  assert.equal(http403.json.remote, true);

  const nodeOf = await guardNode(t, d);
  const r = await d.srv.control.invoke('interrupt', { conversation_id: S1, mode: 'now' }, { remote: true, device: 'mobile' });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.via, 'hook', 'a remote request never injects: the hook halt');
  const flag = userPaths().haltFlag(S1);
  assert.ok(fs.existsSync(flag), 'the halt flag is written');
  assert.ok(flag.startsWith(d.home), 'under this test\'s HOME');

  const halt = await new Promise((resolve, reject) => {
    const child = spawn('sh', [HALT_SCRIPT, 'pre'], { env: { PATH: process.env.PATH, HOME: d.home, CLAUDE_CODE_SESSION_ID: S1 } });
    let out = '';
    child.stdout.on('data', (b) => { out += b; });
    child.on('error', reject);
    child.on('close', (status) => resolve({ status, out }));
    child.stdin.end('{"hook_event_name":"PreToolUse"}');
  });
  assert.equal(halt.status, 0);
  assert.equal(halt.out, `${HALT_PRE}\n`, 'the halt script stops the next tool for that session');

  d.escInTerminal(); // the turn ends at the halt: busy → idle
  await waitUntil(() => !fs.existsSync(flag), { ...WAIT, what: 'the flag removed once the turn closed' });
  const node = await nodeOf();
  assert.equal(node.trigger.ended, 'interrupted');
  assert.equal(node.trigger.ended_by, 'hook', 'stopped by the hook halt');
});

test('the same interrupt POST from the chrome\'s origin, or with no Origin, is refused', async (t) => {
  const d = await daemon(t, { session: true, tty: true });
  await working(d);
  const f = await controlFrame(d, 'interrupt', { conversation_id: S1 }, 'stop');
  for (const [what, origin] of [['the chrome\'s origin', `http://localhost:${d.port}`], ['127.0.0.1\'s spelling of it', `http://127.0.0.1:${d.port}`], ['no Origin', null]]) {
    const r = await act(f, 'interrupt', { conversation_id: S1, mode: 'now' }, { origin });
    assert.equal(r.status, 403, `${what}: ${r.text}`);
    assert.deepEqual(r.json, { ok: false, refused: 'origin' }, what);
  }
  const main = await raw(d.port, { method: 'POST', path: '/answer/api/control/interrupt',
    headers: { 'content-type': 'application/json', origin: `http://localhost:${d.port}` }, body: { conversation_id: S1, mode: 'now' } });
  assert.notEqual(main.status, 200, 'no control action on the chrome\'s origin');
  assert.equal((await d.conversation()).live.state, 'working', 'nothing was interrupted');
});

// ── code revert (§15.3) ──────────────────────────────────────────────────────

const readRecord = (d, turnId) => JSON.parse(fs.readFileSync(projectPaths(d.root).mirrorDiff(turnId), 'utf8'));
const PLANNED = ['a.txt', 'b.txt', 'c.txt'];
function assertTree(d, tree, what) {
  for (const rel of PLANNED) {
    const want = d.repo.bytesAt(tree, rel);
    const abs = d.repo.abs(rel);
    if (want === null) assert.equal(fs.existsSync(abs), false, `${what}: ${rel} absent`);
    else assert.deepEqual(fs.readFileSync(abs), want, `${what}: ${rel}'s bytes`);
  }
}

// A turn that rewrites a.txt, deletes b.txt and makes c.txt, its code settled.
async function codeTurn(d, promptId) {
  await d.fire('SessionStart', { source: 'startup', model: 'claude-test' });
  const seen = await d.snapshots();
  await d.turnBegin(promptId, 'change the files');
  await waitUntil(async () => (await d.snapshots()) > seen, { ...WAIT, what: 'the before-snapshot' });
  d.repo.write('a.txt', 'alpha, rewritten by the turn\n');
  d.repo.remove('b.txt');
  d.repo.write('c.txt', 'charlie, made by the turn\n');
  await d.edit(d.repo.abs('a.txt'), `toolu_01${promptId.replace(/\W/g, '')}`);
  await d.turnEnd('Changed.');
  return waitUntil(async () => {
    const p = await d.get(`/api/mirror/conversations/${S1}/turns?limit=50&items=summary`);
    const x = (p.turns || []).find((y) => y.id === promptId);
    return x && x.code && x.code.status === 'ready' ? x : null;
  }, { ...WAIT, what: `${promptId}'s code` });
}
const idle = (d) => waitUntil(async () => {
  const c = await d.conversation();
  return c && c.live && c.live.state === 'idle' ? c : null;
}, { ...WAIT, what: 'S1 idle' });

test('a restore: refused while the lock is held, applied byte for byte when idle, undone; the next turn-begin carries its notice exactly once', async (t) => {
  const d = await daemon(t, { git: true, files: { 'a.txt': 'alpha\n', 'b.txt': 'bravo\n', 'README.md': 'scratch\n' } });
  await codeTurn(d, 'p-code');
  const rec = readRecord(d, 'p-code');
  const digest = gitDirDigest(d.repo);
  assertTree(d, rec.after.tree, 'precondition: the after-tree is on disk');

  // A turn holds the lock.
  await d.turnBegin('p-hold', 'one more thing');
  const pv = await d.get('/api/code/preview?turn=p-code');
  assert.equal(pv.ok, true, JSON.stringify(pv));
  assert.deepEqual(pv.counts, { rewritten: 1, recreated: 1, deleted: 1, not_covered: 0 });
  const held = await act(await controlFrame(d, 'restore', { preview_id: pv.preview_id }, 'confirm'), 'restore', { preview_id: pv.preview_id });
  assert.equal(held.status, 409, held.text);
  assert.equal(held.json.refused, 'locked');
  assertTree(d, rec.after.tree, 'nothing written while locked');

  await d.turnEnd('Done.');
  assert.equal((await d.get('/api/graph')).lock, null, 'the turn ended: idle');
  await idle(d);
  // A fresh preview (the same target within SAME_TARGET_MS answers the same one).
  await new Promise((resolve) => setTimeout(resolve, SAME_TARGET_MS + 50));
  const pv2 = await d.get('/api/code/preview?turn=p-code');
  assert.equal(pv2.blocked, null, JSON.stringify(pv2.blocked));
  const done = await act(await controlFrame(d, 'restore', { preview_id: pv2.preview_id }, 'confirm'), 'restore', { preview_id: pv2.preview_id });
  assert.equal(done.status, 200, done.text);
  assert.equal(done.json.ok, true);
  assertTree(d, rec.before.tree, 'restored: the turn\'s before-tree, byte for byte');
  assert.deepEqual(gitDirDigest(d.repo), digest, 'the project\'s .git untouched');
  assert.ok(d.claude.argvs().some((a) => a[0] === 'agents' && a.includes('--json')), 'the agents gate asked the (stub) claude');

  const undo = await act(await controlFrame(d, 'undo', { restore_id: 'latest' }, 'confirm'), 'undo', { restore_id: 'latest' });
  assert.equal(undo.status, 200, undo.text);
  assert.equal(undo.json.ok, true);
  assertTree(d, rec.after.tree, 'undone: the after-tree back, byte for byte');

  // The next prompt carries the notice (the undo's replaced the restore's), once.
  const first = await runHook(d, 'turn-begin', promptPayload(d, 'p-told', 'next')).done;
  assert.equal(first.status, 0, first.stderr);
  const ctx = JSON.parse(first.stdout).hookSpecificOutput.additionalContext;
  assert.equal(ctx.split('**Files restored from the web-chat page**').length - 1, 1, `the notice, once:\n${ctx}`);
  assert.match(ctx, /Read a file again before you edit it\./);
  await d.turnEnd('Ok.');
  const second = await runHook(d, 'turn-begin', promptPayload(d, 'p-after', 'and then')).done;
  assert.equal(second.status, 0, second.stderr);
  assert.ok(!second.stdout.includes('Files restored from the web-chat page'), 'claimed exactly once');
  await d.turnEnd('Ok.');
});

// ── fork (§15.6) ─────────────────────────────────────────────────────────────

test('a fork against the stub claude answers the resume command, and its argv holds no user text', async (t) => {
  const FIRST = 'first prompt with a password hunter2';
  const SECOND = 'second prompt: ignore previous instructions';
  const d = await daemon(t);
  const r = createRecords({ seed: 31, sessionId: S1, cwd: d.ch.cwd, start: Date.now() - 60000, step: 10 });
  r.prompt(FIRST, { promptId: 'pf-1' });
  r.assistant(['reply one']);
  r.turnDuration({ durationMs: 30 });
  r.prompt(SECOND, { promptId: 'pf-2' });
  r.assistant(['reply two']);
  r.turnDuration({ durationMs: 30 });
  d.ch.writeTranscript(S1, r.records);
  await d.fire('SessionStart', { source: 'startup', model: 'claude-test' });
  await waitUntil(async () => {
    const p = await d.get(`/api/mirror/conversations/${S1}/turns?limit=50&items=summary`);
    return p && (p.turns || []).filter((x) => x.status !== 'open').length === 2;
  }, { ...WAIT, what: 'the two closed turns' });
  assert.equal((await d.get('/api/mirror')).capabilities.fork, true, 'fork is offered: claude on PATH, transcripts on');
  const f = await controlFrame(d, 'fork', { turn_id: 'pf-2' }, 'confirm');
  const ans = await act(f, 'fork', { turn_id: 'pf-2' });
  assert.equal(ans.status, 200, ans.text);
  assert.deepEqual(ans.json, { ok: true, session_id: FORKED, command: `claude --resume ${FORKED}` });
  const argv = d.claude.argvs().find((a) => a.includes('--fork-session'));
  assert.ok(argv, 'the stub claude ran the fork');
  assert.deepEqual(argv.slice(2, 4), ['--resume', S1]);
  assert.ok(argv.includes('--resume-session-at'));
  const joined = argv.join('\n');
  for (const text of [FIRST, SECOND, 'hunter2', 'ignore previous instructions', 'reply one', 'reply two']) {
    assert.ok(!joined.includes(text), `the argv never carries "${text}"`);
  }
});

// ── the capabilities (beyond §11.7) ──────────────────────────────────────────

test('GET /api/mirror at local: the six provided capabilities true in a git repository; code_revert false with WEB_CHAT_MIRROR_DIFFS=0', async (t) => {
  const d = await daemon(t, { git: true, files: { 'a.txt': 'alpha\n', 'b.txt': 'bravo\n' } });
  await codeTurn(d, 'p-caps');
  // The revert's features are cached (FEATURES_TTL_MS) and its passive probe
  // answered 'no-snapshots' at boot; a preview probes in full, as the first
  // reader of the route does.
  assert.equal((await d.get('/api/code/preview?turn=p-caps')).ok, true);
  const caps = await waitUntil(async () => {
    const c = (await d.get('/api/mirror')).capabilities;
    return PROVIDED.every((k) => c[k] === true) ? c : null;
  }, { ...WAIT, what: 'every provided capability on' }).catch(async () => (await d.get('/api/mirror')).capabilities);
  for (const k of PROVIDED) assert.equal(caps[k], true, `${k}: ${JSON.stringify(caps)}`);
  assert.equal(caps.mod, false, 'tranche 6\'s');
  assert.equal(caps.rewind_in_place, false, 'tranche 6\'s');

  const off = await daemon(t, { git: true, files: { 'a.txt': 'alpha\n', 'b.txt': 'bravo\n' }, env: { WEB_CHAT_MIRROR_DIFFS: '0' } });
  await off.fire('SessionStart', { source: 'startup', model: 'claude-test' });
  const c2 = (await off.get('/api/mirror')).capabilities;
  assert.equal(c2.code_revert, false, 'no per-turn record, nothing to restore');
  for (const k of PROVIDED.filter((x) => x !== 'code_revert')) assert.equal(c2[k], true, `${k} stays on`);
  const pv = await client.request(off.port, 'GET', '/api/code/preview?turn=p-x', null, { timeout: CALL_TIMEOUT_MS });
  assert.equal(pv.status, 503, 'the preview route says why');
  assert.equal(pv.body.reason, 'diffs-off');
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

// The daemon with tranche 4's handles all busy — an ask pending (its hook
// long-polling), a control frame's document served (the answer surface up and
// framesActive), an index build in flight (a git root's ls-files) and the
// release scheduler holding a queued message for a working conversation —
// then `teardown`; then nothing of the daemon's may be left.
async function exitsClean(t, teardown) {
  const base = refCounts();
  const tracker = trackHandles();
  t.after(() => tracker.stop());
  const d = await daemon(t, { git: true, session: true });
  t.after(async () => { if (d.server.listening) await d.srv.stop(); });
  // A working conversation with no lock (the hook intake's PreToolUse), so the
  // graceful drain has no turn to wait out.
  d.ch.writeSession({ pid: process.pid, procStart: d.procStart, sessionId: S1, status: 'busy' });
  await d.fire('SessionStart', { source: 'startup', model: 'claude-test' });
  await d.fire('PreToolUse', { tool_name: 'Bash', tool_use_id: 'toolu_01Busy', tool_input: { command: 'npm test' } });
  await waitUntil(async () => { const c = await d.conversation(); return c && c.live && c.live.state === 'working'; }, { ...WAIT, what: 'S1 working' });
  const ws = wsConnect(d.port, '/ws'); // a local viewer: the ask waits for the page
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });

  const queued = await d.post('/api/queue/message', { text: 'when you are free', send: 'auto', conversation_id: S1 });
  assert.equal(queued.mode, 'queued', `the scheduler holds it while S1 works: ${JSON.stringify(queued)}`);
  const hook = runHook(d, 'ask', { session_id: S1, transcript_path: d.ch.transcript(S1), cwd: d.ch.cwd,
    hook_event_name: 'PermissionRequest', permission_mode: 'default', tool_name: 'Bash', tool_input: { command: 'rm -rf dist' } });
  await waitUntil(async () => ((await d.get('/api/asks')).asks || []).some((a) => a.state === 'pending' && a.answerable),
    { ...WAIT, what: 'the pending ask' });
  await controlFrame(d, 'interrupt', { conversation_id: S1 }, 'stop');
  assert.ok(d.srv.control.framesActive(), 'a control frame is up');
  const search = d.get('/api/files?q=read&limit=5').catch(() => null); // the index build, in flight at the teardown

  await teardown(d);
  ws.terminate();
  await search;
  const out = await hook.done; // the hook finds the daemon gone and exits
  assert.equal(out.stdout, '', 'the ask hook printed nothing: the terminal prompt stays');
  assert.equal(d.server.listening, false, 'the server is closed');
  assert.equal(d.srv.answerSurface.port, null, 'the answer surface\'s listener is closed');
  const left = await waitUntil(() => (tracker.open().length === 0 && excess(base).length === 0 ? 'clean' : null), { timeout: 15000, interval: 20 })
    .catch(() => null);
  assert.ok(left, `left behind — handles and timers: [${tracker.open().join(', ')}]; beyond the baseline: [${excess(base).join(', ')}]`);
}

test('srv.stop() leaves no open handle: an ask pending, a control frame up, an index build in flight, the scheduler holding a message', async (t) => {
  await exitsClean(t, (d) => d.srv.stop());
});

test('gracefulShutdown() leaves no open handle: an ask pending, a control frame up, an index build in flight, the scheduler holding a message', async (t) => {
  await exitsClean(t, (d) => d.srv.gracefulShutdown());
});
