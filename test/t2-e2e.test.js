// Tranche 2 of the chat mirror, end to end (design spec §11.5, "End-to-end check
// (U40)"): the conversation through the daemon exactly as createServer wires it
// — the transcripts source over its turn index and the rewinds source in
// SOURCES, the content routes mounted, graph.redactText set, the turn guard
// built after the mirror and bound to the graph routes' endTurn, every handle
// stopped by both teardown paths — and through the real chrome, public/app/
// main.js with the dock, panel, stream, tool cards and favicon it now inits.
//
// The daemon is the real one (withServer). Claude Code is played by its own
// hooks' code (envelope v1 from lib/hooks/envelope.js, posted by the mirror
// hook's postEnvelope; the turn hooks' bodies with lib/hooks/turn-begin's
// session fields) and by a synthetic transcript (test-support/claude-records,
// test-support/rewind-fixtures) in a private Claude tier (test-support/
// claude-home). A remote viewer is `X-WC-Remote: 1` from loopback.
//
// Pinned, a test per clause:
//   * the server boots with tranche 2's sources registered and started, the
//     content routes mounted and the turn guard on the server;
//   * a synthetic transcript and its hooks give one closed turn with one tool
//     group and the transcript's markdown reply, sent as mirror:stream frames to
//     a socket whose chat is open; the jsdom panel (below) draws it;
//   * a restart resumes the index: no turn twice, none missing;
//   * a branch and a first-prompt reset each supersede the turns after them
//     under one rewound notice, and no graph node file changes; the jsdom
//     stream (below) dims them under the notice;
//   * an Esc (the sessions file going busy → idle with no Stop: the mirror's
//     turn-closed {by:'status'}) commits the turn's node once the guard's
//     settle window has passed, ended 'interrupted' by 'terminal', and the late
//     Stop that follows is reconciled onto that node, not committed;
//   * `tunnel mirror on` moves a remote socket from basic to full;
//   * a prompt holding a fake key commits a node whose trigger shows the mask,
//     and no file under the graph holds the clear value;
//   * the server leaves no open handle through srv.stop() and through
//     gracefulShutdown() with a linked process, a tailed transcript and the
//     turn guard armed; test/bus-golden.test.js is byte-identical;
//   * U95, through the real commands with a `claude` on PATH (a fakeBin playing
//     Claude Code on the sandbox's $CLAUDE_CONFIG_DIR/.claude.json): install in
//     a fresh non-git project registers at local scope with no .mcp.json entry
//     and writes .web-chat/mcp-registration.json, and status says so; a 0.8.2
//     .mcp.json entry rejected in settings.local.json reads REJECTED, and
//     doctor with no terminal reports it without registering; an entry
//     disabled through /mcp reads disabled and is not repaired; apply() driven
//     the way 0.8.2's updater drives it never runs `claude` for a resolvable
//     entry; the turn-begin hook's no-daemon context is conditional on the
//     tool list;
//   * the real main.js in jsdom: it calls exactly initChatDock, initChatPanel,
//     initChatStream, initChatTools and initFavicon after initChatBar, in that
//     order, and calling them again adds nothing; the panel draws the recorded
//     turn; the stream dims superseded turns under the notice; the tab icon
//     follows the browser's scheme, takes the project's mark from a project
//     frame and wears the waiting badge (its compositing stubbed, as
//     test/favicon.test.js does: jsdom has no canvas), and the title never
//     changes for any of it; the chat's attachment limit equals the daemon's.
//
// Wall-clock bounds (the guard's settle window plus 100 ms, the opt-in's 3.5 s)
// are asserted only under WEB_CHAT_PERF=1 (spec §10.1); the default run asserts
// the behaviour and logs the measurement.

const test = require('node:test');
const { describe, before, after } = test;
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { createHook } = require('node:async_hooks');
const { withServer, tmpRoot, waitUntil, wsConnect, fakeBin } = require('../test-support/helpers');
const { claudeHome } = require('../test-support/claude-home');
const { createRecords } = require('../test-support/claude-records');
const fx = require('../test-support/rewind-fixtures');
const { fakeSecrets, findLeaks } = require('../test-support/fake-secrets');
const { bootShell } = require('../test-support/chrome-shell');
const { encodePng, solid } = require('../test-support/png-encode');
const client = require('../lib/client');
const { hookEnvelope } = require('../lib/hooks/envelope');
const { sessionFields } = require('../lib/hooks/turn-begin');
const { postEnvelope } = require('../lib/hooks/mirror');
const { MASK, RULES } = require('../lib/core/redact');
const { projectPaths, userPaths, claudePaths, userClaudePaths } = require('../lib/core/paths');
const { writeJsonAtomic } = require('../lib/core/fsjson');
const { sampleProcs, formatProcStart } = require('../lib/core/portfiles');
const { ATTACHMENT_MAX_BYTES: TRANSCRIPT_ATTACHMENT_MAX } = require('../lib/server/mirror/transcripts');
const { ATTACHMENT_MAX_BYTES: ROUTE_ATTACHMENT_MAX } = require('../lib/server/routes/mirror-content');
const reg = require('../lib/setup/registration');
const { stableBin } = require('../lib/update/managed-files');

// install destructures spawnDaemon at load: patched out first, so no test here
// forks a background server (test/mcp-local-scope-commands.test.js does the same).
const daemonMod = require('../lib/util/daemon');
const realSpawnDaemon = daemonMod.spawnDaemon;
daemonMod.spawnDaemon = async () => null;
const install = require('../lib/cli/commands/install');
daemonMod.spawnDaemon = realSpawnDaemon;
const doctor = require('../lib/cli/commands/doctor');
const status = require('../lib/cli/commands/status');
const tunnel = require('../lib/cli/commands/tunnel');

const REPO = path.resolve(__dirname, '..');
const HOOK_BIN = path.join(REPO, 'bin', 'claude-web-chat-hook.js');

// Sessions (uuids, so every id is safe as a file name).
const S1 = '11111111-1111-4111-8111-111111111111';
const SB = '22222222-2222-4222-8222-222222222222';
const SR = '33333333-3333-4333-8333-333333333333';
const PROMPT_MARK = 'T2E2E-PROMPT-MARK';
const PROMPT = `${PROMPT_MARK} read the paths module`;
// The reply as the transcript has it (chat markdown) and as the Stop hook saw it.
const REPLY_MD = '**Done.** The `paths` module reads cleanly.';
const REPLY_MARK = 'T2E2E-REPLY-MARK';
const REPLY = `${REPLY_MARK} the import paths are fixed`;
const READ_ID = 'toolu_01ReadPaths';
// The turn guard's settle window, as createServer builds it (createTurnGuard's
// default): how long it waits for a Stop after the mirror closed a turn.
const SETTLE_MS = 5000;
// A tunnel.json `tunnel setup` could have written (no opt-in yet).
const TUNNEL = Object.freeze({
  hostname: 'wc.example.test',
  style: 'flat',
  access: { team: 'testteam', aud: 'test-aud-0123456789' },
  allow: { emails: ['me@example.com'], domains: [] },
});
const PERF = process.env.WEB_CHAT_PERF === '1';
const CALL_TIMEOUT_MS = 15000;
const WAIT = { timeout: 15000, interval: 10 };
const PANE = 't2e2e-pane';

// ── the daemon, and Claude Code's side of it ─────────────────────────────────

// A fresh project with a private Claude Code tier and its daemon (its portfile
// written, so the mirror hook finds it). `root` reuses a project (a restart).
async function daemon(t, { seed, root = null, ch = null } = {}) {
  let ctx = null;
  // Registered first, so it runs first: the daemon stops before claudeHome's
  // cleanup takes its Claude tier away (t.after runs in registration order).
  t.after(async () => { if (ctx) await ctx.stop(); });
  const dir = root || tmpRoot('wc-t2e2e-');
  const tier = ch || claudeHome(t, { root: dir, isolate: true });
  ctx = await withServer(t, { root: dir, writePortfile: true, seed });
  return driver(ctx, tier);
}

function driver(ctx, ch) {
  const call = { port: ctx.port, noSpawn: true, timeout: CALL_TIMEOUT_MS };
  const env = { CLAUDE_CODE_ENTRYPOINT: 'cli' };
  let clock = Date.now();
  const stamp = () => { clock = Math.max(clock + 1, Date.now()); return clock; };
  const sessionOf = (sid) => ({ session_id: sid, transcript_path: ch.transcript(sid), cwd: ch.cwd, permission_mode: 'default' });
  const envelope = (event, extra = {}, sid = S1) => hookEnvelope({ hook_event_name: event, ...sessionOf(sid), ...extra }, env,
    { now: stamp() });
  async function post(e) {
    const r = await postEnvelope(e, { root: ctx.root, timeout: CALL_TIMEOUT_MS });
    assert.equal(r, 'posted', `${e.event} reached the hook intake`);
  }
  const file = path.join(ch.cwd, 'lib', 'paths.js');
  const input = { file_path: file, old_string: "require('../core')", new_string: "require('../core/paths')" };
  function turnBeginBody(promptId, text, sid = S1) {
    const e = envelope('UserPromptSubmit', { prompt: text, prompt_id: promptId }, sid);
    return { message: text, author: 'user', ...sessionFields(e), prompt: e.prompt };
  }
  return {
    ...ctx,
    ch,
    call,
    env,
    file,
    envelope,
    post,
    fire: (event, extra, sid) => post(envelope(event, extra, sid)),
    edit: (useId) => ({ tool_name: 'Edit', tool_use_id: useId, tool_input: input }),
    read: (useId = READ_ID) => ({ tool_name: 'Read', tool_use_id: useId, tool_input: { file_path: file } }),
    readDone: (useId = READ_ID) => ({ tool_name: 'Read', tool_use_id: useId, tool_input: { file_path: file },
      tool_response: { type: 'text', file: { filePath: file } }, duration_ms: 7 }),
    turnBegin: (promptId, text, sid) => client.post('/api/turn-begin', turnBeginBody(promptId, text, sid), call),
    turnEnd(reply, sid = S1) {
      const e = envelope('Stop', { last_assistant_message: reply }, sid);
      return client.post('/api/turn-end', {
        author: 'claude', reply, ended: 'stop', ...sessionFields(e), last_assistant_message: e.stop.last_assistant_message,
      }, call);
    },
    render: (html = '<p>a pane</p>') => client.post('/api/render', { id: PANE, html }, call),
    snapshot: () => client.get('/api/mirror', call),
    turns: (cid, items = 'full') => client.get(`/api/mirror/conversations/${encodeURIComponent(cid)}/turns?limit=50&items=${items}`, call),
    request: (method, p, body, headers) => client.request(ctx.port, method, p, body, { headers, timeout: CALL_TIMEOUT_MS }),
  };
}

// A WebSocket that records every frame it gets, each stamped with when it came.
// `headers` go on its upgrade; `full` opens its chat (the stream posture).
async function socket(t, port, { headers, full = false } = {}) {
  const ws = wsConnect(port, '/ws', headers ? { headers } : undefined);
  t.after(() => { try { ws.terminate(); } catch {} });
  const frames = [];
  const at = new WeakMap();
  ws.on('message', (data) => {
    try { const f = JSON.parse(data.toString()); at.set(f, Date.now()); frames.push(f); } catch {}
  });
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  await waitUntil(() => frames.some((f) => f.type === 'hello'), { ...WAIT, what: 'the hello' });
  if (full) ws.send(JSON.stringify({ type: 'client', mirror: 'full' }));
  return { ws, frames, at: (f) => at.get(f), of: (type) => frames.filter((f) => f.type === type) };
}

// The transcript of one turn: the prompt, a narration and one Read, its result,
// then the reply in chat markdown, closed by its turn_duration.
function oneReadTurn(ch, sid, promptId, { seed = 40, prompt = PROMPT, file } = {}) {
  const r = createRecords({ seed, sessionId: sid, cwd: ch.cwd, start: Date.now() - 30000, step: 10 });
  r.prompt(prompt, { promptId });
  r.assistant(['I will read it first.', { type: 'tool_use', name: 'Read', input: { file_path: file }, id: READ_ID }]);
  r.toolResult(READ_ID, 'line one\nline two');
  r.assistant([REPLY_MD]);
  r.turnDuration({ durationMs: 120, messageCount: 4 });
  return r;
}

// Claude Code runs that turn: the hooks, and the transcript it writes.
async function runReadTurn(d, { sid = S1, promptId = 'p1' } = {}) {
  await d.fire('SessionStart', { source: 'startup', model: 'claude-test' }, sid);
  await d.turnBegin(promptId, PROMPT, sid);
  await d.fire('PreToolUse', d.read(), sid);
  await d.fire('PostToolUse', d.readDone(), sid);
  const r = oneReadTurn(d.ch, sid, promptId, { file: d.file });
  d.ch.writeTranscript(sid, r.records);
  await d.turnEnd(REPLY_MD, sid);
  return r;
}

// The page once the turn is closed and the transcript's reply has replaced the Stop's.
async function closedTurnPage(d, cid, n = 1) {
  return waitUntil(async () => {
    const p = await d.turns(cid);
    return p && p.total === n && p.turns.every((x) => x.status !== 'open')
      && p.turns.every((x) => (x.items || []).some((it) => it.kind === 'reply' && it.source === 'transcript')) ? p : null;
  }, { ...WAIT, what: `${n} closed turn(s) of ${cid} with the transcript's reply` });
}

// A rewind fixture played into the daemon: its hooks first (a SessionStart
// precedes what it starts), then its transcript; the page once every turn has
// settled.
async function playFixture(d, f) {
  const base = { sessionId: f.sessionId, transcriptPath: d.ch.transcript(f.sessionId), cwd: d.ch.cwd };
  for (const hook of f.hooks) await d.post(fx.envelope(hook, base));
  d.ch.writeTranscript(f.sessionId, f.records);
  return waitUntil(async () => {
    const p = await d.turns(f.sessionId);
    if (!p || p.total !== f.turns.length || !p.turns.every((x) => x.status !== 'open')) return null;
    return f.expect.superseded.every((id) => p.turns.find((x) => x.id === id && x.superseded)) ? p : null;
  }, { ...WAIT, what: `the ${f.name} fixture's ${f.turns.length} turns, ${f.expect.superseded.length} superseded` });
}
const fixture = (name, sessionId, opts = {}) => fx[name]({ sessionId, start: Date.now() - 120000, ...opts });
const notices = (page) => page.turns.flatMap((t) => (t.items || [])
  .filter((it) => it.kind === 'notice' && it.notice === 'rewound').map((it) => ({ turn: t.id, reason: it.reason })));

// Every file under the project's graph directory, by name, as bytes.
function graphFiles(root) {
  const dir = projectPaths(root).graphDir;
  const out = {};
  for (const name of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
    const p = path.join(dir, name);
    if (fs.statSync(p).isFile()) out[name] = fs.readFileSync(p).toString('base64');
  }
  return out;
}

// ── open handles ─────────────────────────────────────────────────────────────

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
// Every timer and handle made while it is on, ref'd or not (test/t1-e2e.test.js
// has the same tracker, and says why each half is read the way it is).
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

const liveStart = async () => formatProcStart((await sampleProcs([process.pid])).get(process.pid).startedAt);

// The daemon with all of tranche 2 running — a linked process (this one, its
// sessions file watched and sampled), a tailed transcript under its turn index,
// the rewinds source hearing it, and (with `lock`) a held turn whose claude_pid
// arms the turn guard's pid check — then `teardown`; then nothing of the
// daemon's may be left.
async function exitsClean(t, teardown, { lock = false } = {}) {
  const procStart = await liveStart();
  const base = refCounts();
  const tracker = trackHandles();
  t.after(() => tracker.stop());
  // Should the teardown under test leave the server up, it is stopped here, so
  // a failure is reported rather than holding this file open. (Not through
  // gracefulShutdown: with a turn held it would wait out its 30 s lock drain.)
  let d = null;
  t.after(async () => {
    if (d && d.server.listening) await d.srv.stop();
  });
  d = await daemon(t);
  d.ch.writeSession({ pid: process.pid, procStart, sessionId: S1, status: 'busy' });
  d.env.CLAUDE_PID = String(process.pid);
  await runReadTurn(d);
  await closedTurnPage(d, S1);
  const linked = async () => (await d.snapshot()).conversations.find((c) => c.process && c.process.pid === process.pid);
  await waitUntil(linked, { ...WAIT, what: 'the mirror to link the session\'s process' });
  assert.deepEqual(d.srv.mirror.stats().sources.map((s) => [s.name, s.started]),
    [['live', true], ['transcripts', true], ['rewinds', true]], 'tranche 2\'s sources are running');
  if (lock) {
    await d.turnBegin('p2', 'one more thing');
    await waitUntil(async () => (await client.get('/api/graph', d.call)).lock, { ...WAIT, what: 'the held lock' });
  }
  await teardown(d);
  assert.equal(d.server.listening, false, 'the server is closed');
  // Nothing is let through: a held lock's stale timer (lib/server/domain/
  // turns.js syncStaleTimer) is cleared by the graph's own stop (stopGraph),
  // which both teardown paths call, and the turn guard's (its pid check) too.
  const opened = () => tracker.open();
  const left = await waitUntil(() => {
    const open = opened();
    const more = excess(base);
    return open.length === 0 && more.length === 0 ? 'clean' : null;
  }, { timeout: 15000, interval: 20 });
  assert.ok(left, `left behind — handles and timers: [${opened().join(', ')}]; keeping the loop alive beyond the baseline: [${excess(base).join(', ')}]`);
}

// ── the daemon ───────────────────────────────────────────────────────────────

test('the server boots with tranche 2\'s sources running, the content routes mounted and the turn guard on it', async (t) => {
  const d = await daemon(t);
  await d.srv.mirror.ready;
  assert.deepEqual(d.srv.mirror.stats().sources.map((s) => s.name), ['live', 'transcripts', 'rewinds'],
    'SOURCES: live, then transcripts, then rewinds (it hears only what transcripts applied)');
  for (const m of ['bindEndTurn', 'ended', 'closedRecently', 'reconcileLateStop', 'noteEnded', 'stop']) {
    assert.equal(typeof d.srv.turnGuard[m], 'function', `the server's turn guard has ${m}`);
  }
  const unknown = await d.request('GET', `/api/mirror/conversations/${S1}/turns`);
  assert.equal(unknown.status, 404, 'GET /api/mirror/conversations/:cid/turns is the content route (404 for an unknown conversation)');
  assert.equal(typeof unknown.body, 'object', 'answered as JSON by the route, not by Express\'s fallback');
  const far = await d.request('GET', `/api/mirror/conversations/${S1}/turns`, null, { 'X-WC-Remote': '1' });
  assert.equal(far.status, 403, 'and gated at read: a remote viewer of a project that has not opted in is refused');
  assert.equal(far.body.mirror, 'basic');
});

test('a synthetic transcript and its hooks give one closed turn, one tool group and the markdown reply, as stream frames', async (t) => {
  const d = await daemon(t);
  const local = await socket(t, d.port, { full: true });
  const quiet = await socket(t, d.port);
  await runReadTurn(d);
  const page = await closedTurnPage(d, S1);
  const [turn] = page.turns;
  assert.equal(turn.id, 'p1');
  assert.equal(turn.status, 'done');
  assert.equal(turn.groups.length, 1, 'one tool group');
  assert.deepEqual(turn.tool_names, ['Read']);
  const reply = turn.items.filter((it) => it.kind === 'reply').at(-1);
  assert.equal(reply.text, REPLY_MD, 'the transcript\'s reply, its markdown as written');
  assert.equal(reply.source, 'transcript');

  await waitUntil(() => local.of('mirror:stream').some((f) => f.conversation_id === S1
    && (f.items || []).some((it) => it.kind === 'reply' && it.text === REPLY_MD)), { ...WAIT, what: 'the reply on a stream frame' });
  await waitUntil(() => local.of('mirror:stream').some((f) => (f.items || []).some((it) => it.kind === 'tool_call' && it.tool_kind === 'Read')),
    { ...WAIT, what: 'the Read went out as a stream item' });
  assert.equal(quiet.of('mirror:stream').length, 0, 'a socket whose chat is closed gets no stream frames (posture)');
});

test('a restart resumes the index: every turn exactly once, the one written while the daemon was down included', async (t) => {
  const root = tmpRoot('wc-t2e2e-restart-');
  const ch = claudeHome(t, { root, isolate: true });
  const a = await daemon(t, { root, ch });
  const r = createRecords({ seed: 41, sessionId: S1, cwd: ch.cwd, start: Date.now() - 60000, step: 10 });
  const closed = (id, count) => {
    r.prompt(`prompt ${id}`, { promptId: id });
    r.assistant([`reply to ${id}`]);
    r.turnDuration({ durationMs: 40, messageCount: count });
  };
  closed('rs-1', 2);
  closed('rs-2', 4);
  ch.writeTranscript(S1, r.records);
  await a.fire('SessionStart', { source: 'startup', model: 'claude-test' });
  await closedTurnsOf(a, S1, ['rs-1', 'rs-2']);
  await a.stop();

  const indexFile = projectPaths(root).mirrorIndex(S1);
  const index = JSON.parse(fs.readFileSync(indexFile, 'utf8'));
  const size = fs.statSync(ch.transcript(S1)).size;
  assert.equal(index.resume && index.resume.offset, size, 'stop flushed an index whose resume point is the end of the file');
  assert.deepEqual(index.turns.map((x) => x.id), ['rs-1', 'rs-2']);

  // A turn written while no daemon ran; then a daemon over the same project.
  const n0 = r.records.length;
  closed('rs-3', 6);
  ch.appendTranscript(S1, r.records.slice(n0));
  const b = await daemon(t, { root, ch });
  await b.fire('SessionStart', { source: 'resume', model: 'claude-test' });
  const page = await closedTurnsOf(b, S1, ['rs-1', 'rs-2', 'rs-3']);
  assert.deepEqual(page.turns.map((x) => x.id), ['rs-1', 'rs-2', 'rs-3'], 'no duplicate, no gap');
  const seqs = page.turns.flatMap((x) => x.items.map((it) => it.seq));
  assert.deepEqual(seqs, [...seqs].sort((p, q) => p - q), 'items in file order');
  assert.equal(new Set(seqs).size, seqs.length, 'no item twice');
});

async function closedTurnsOf(d, cid, ids) {
  return waitUntil(async () => {
    const p = await d.turns(cid);
    return p && p.total === ids.length && p.turns.every((x) => x.status !== 'open')
      && JSON.stringify(p.turns.map((x) => x.id)) === JSON.stringify(ids) ? p : null;
  }, { ...WAIT, what: `turns ${ids.join(', ')} of ${cid}` });
}

// Each fixture in a project of its own: both name their turns rw-1 … rw-4 (the
// fixture's promptIds), and a turn id is the conversation's prompt id, so in one
// daemon the second would read as a copy of the first (the fork filter).
test('a branch and a first-prompt reset each supersede the turns after them, under one notice, and no graph node file changes', async (t) => {
  for (const [name, sid] of [['branch', SB], ['reset', SR]]) {
    const d = await daemon(t);
    await d.srv.mirror.ready;
    const before = graphFiles(d.root);
    const f = fixture(name, sid);
    assert.equal(f.expect.reason, name, `precondition: the ${name} fixture is a rewind`);
    const page = await playFixture(d, f);
    assert.deepEqual(page.turns.filter((x) => x.superseded).map((x) => x.id), f.expect.superseded, `${name}: the superseded turns`);
    assert.deepEqual(page.turns.filter((x) => !x.superseded).map((x) => x.id), f.expect.live, `${name}: the live ones`);
    assert.deepEqual(notices(page), [{ turn: f.expect.superseded[0], reason: name }], `${name}: one notice, on the first abandoned turn`);
    assert.deepEqual(graphFiles(d.root), before, `${name}: a rewind in the terminal writes no graph node file`);
  }
});

test('an Esc (busy → idle, no Stop) commits the node after the settle window, ended_by terminal; the late Stop is reconciled', async (t) => {
  const d = await daemon(t);
  const procStart = await liveStart();
  d.ch.writeSession({ pid: process.pid, procStart, sessionId: S1, status: 'busy' });
  d.env.CLAUDE_PID = String(process.pid);
  const local = await socket(t, d.port);
  const closes = [];
  t.after(d.srv.mirror.subscribe((e) => { if (e && e.op === 'turn-closed') closes.push({ ...e, seenAt: Date.now() }); }));

  await d.fire('SessionStart', { source: 'startup', model: 'claude-test' });
  await d.turnBegin('p1', PROMPT);
  await d.fire('PreToolUse', d.edit('toolu_1'));
  await d.render();
  const lock = (await client.get('/api/graph', d.call)).lock;
  assert.ok(lock && lock.claude_pid === process.pid, 'the lock records the session\'s process');
  await waitUntil(async () => {
    const c = (await d.snapshot()).conversations.find((x) => x.id === S1);
    return c && c.process && c.process.pid === process.pid && c.live.state === 'working';
  }, { ...WAIT, what: 'the mirror to link the process and see it working' });

  // Esc in the terminal: Claude Code writes idle to its sessions file and fires no Stop.
  const at = Date.now();
  d.ch.writeSession({ pid: process.pid, procStart, sessionId: S1, status: 'idle', updatedAt: at, statusUpdatedAt: at });
  const close = await waitUntil(() => closes.find((e) => e.by === 'status' && e.turn_id === 'p1'),
    { timeout: 20000, interval: 10, what: 'the mirror\'s turn-closed {by: status}' });
  assert.equal(close.outcome, 'interrupted');
  assert.equal(close.ended_by, 'terminal', 'an interruption the status machine observed, with no control request: terminal');

  const added = await waitUntil(() => local.of('node-added').at(-1), { timeout: SETTLE_MS + 15000, interval: 5, what: 'the guard\'s commit' });
  const took = local.at(added) - close.seenAt;
  t.diagnostic(`the guard committed ${took} ms after the turn closed (settle window ${SETTLE_MS} ms)`);
  assert.ok(took >= SETTLE_MS - 50, `the guard waited the settle window for a Stop before it committed (${took} ms)`);
  if (PERF) assert.ok(took <= SETTLE_MS + 100, `committed within settleMs + 100 ms (${took} ms)`);
  const nodeId = added.node.id;
  const node = await client.get(`/api/graph/node/${encodeURIComponent(nodeId)}`, d.call);
  assert.equal(node.trigger.ended, 'interrupted');
  assert.equal(node.trigger.ended_by, 'terminal', 'the node records who interrupted its turn');
  assert.equal((await client.get('/api/graph', d.call)).lock, null, 'and the lock is released');

  // The Stop that finally arrives for that turn: reconciled onto its node.
  const count = (await client.get('/api/graph', d.call)).nodes.length;
  const late = await d.turnEnd(REPLY);
  assert.equal(late.ok, true);
  assert.equal(late.reconciled, nodeId, 'the late Stop names the node it was reconciled onto');
  assert.equal((await client.get('/api/graph', d.call)).nodes.length, count, 'and committed no node of its own');
  const after = await client.get(`/api/graph/node/${encodeURIComponent(nodeId)}`, d.call);
  assert.ok(JSON.stringify(after.trigger).includes(REPLY_MARK), 'the node now carries the Stop\'s reply');
});

test('`tunnel mirror on` moves a remote socket from basic to full', async (t) => {
  const d = await daemon(t, { seed: () => writeJsonAtomic(userPaths().tunnelConfig, TUNNEL) });
  const remote = await socket(t, d.port, { headers: { 'X-WC-Remote': '1' } });
  const before = await d.request('GET', '/api/mirror/access', null, { 'X-WC-Remote': '1' });
  assert.equal(before.body.level, 'basic', 'a project that has not opted in: the heartbeat only');

  const t0 = Date.now();
  const r = await tunnel(['mirror', 'on'], { log: () => {}, cwd: d.root });
  assert.equal(r.level, 'full');
  const access = await waitUntil(() => remote.of('mirror:access').find((f) => f.level === 'full'),
    { timeout: PERF ? 3500 : 15000, interval: 10, what: 'the remote socket to be told it is full' });
  const took = remote.at(access) - t0;
  t.diagnostic(`the remote socket was full ${took} ms after \`tunnel mirror on\``);
  if (PERF) assert.ok(took <= 3500, `within 3.5 s (${took} ms)`);
  const far = await d.request('GET', '/api/mirror/access', null, { 'X-WC-Remote': '1' });
  assert.equal(far.body.level, 'full', 'and a remote request is judged full too');
});

test('a prompt holding a fake key commits a node whose trigger shows the mask; no graph file holds the clear value', async (t) => {
  const fake = fakeSecrets({ seed: 11 }).find((f) => f.id === 'github-ghp');
  const label = RULES.find((rule) => rule.id === fake.rule).label;
  const prompt = `${PROMPT_MARK} push with ${fake.secrets[0]} please`;
  const d = await daemon(t);
  const local = await socket(t, d.port);
  await d.fire('SessionStart', { source: 'startup', model: 'claude-test' });
  await d.turnBegin('p1', prompt);
  await d.render();
  const end = await d.turnEnd(REPLY);
  assert.ok(end.node_id, 'the turn committed a node');
  const node = await client.get(`/api/graph/node/${encodeURIComponent(end.node_id)}`, d.call);
  assert.ok(node.trigger.message.includes(PROMPT_MARK), 'the prompt is kept');
  assert.ok(node.trigger.message.includes(MASK(label)), `the trigger shows the mask: ${node.trigger.message}`);
  assert.deepEqual(findLeaks(node, [fake]), [], 'the node as served holds no part of the key');
  const lockFrames = local.of('lock').filter((f) => f.lock);
  assert.ok(lockFrames.length > 0 && lockFrames.every((f) => !findLeaks(f, [fake]).length), 'nor did the lock frames');
  const onDisk = Object.values(graphFiles(d.root)).map((b) => Buffer.from(b, 'base64').toString('utf8')).join('\n');
  assert.ok(onDisk.includes(MASK(label)), 'the node file stores the mask');
  assert.deepEqual(findLeaks(onDisk, [fake]), [], 'and no graph file stores the clear value');
});

test('srv.stop() leaves no open handle: the turn guard (armed), the sources, the mirror and every socket stop with it', async (t) => {
  await exitsClean(t, (d) => d.srv.stop(), { lock: true });
});

test('gracefulShutdown() leaves no open handle: the turn guard, the sources, the mirror and every socket stop with it', async (t) => {
  await exitsClean(t, (d) => d.srv.gracefulShutdown());
});

// §2.9 and §10.2: the core bus API and its golden are unchanged by the mirror,
// for the whole release (test/t1-e2e.test.js pins the same bytes).
const BUS_GOLDEN_SHA256 = '235cabffa00d1a76c0e29f77c4380f30e3361248f8221d2ebffc8c585e23216a';

test('test/bus-golden.test.js is byte-identical', () => {
  const src = fs.readFileSync(path.join(REPO, 'test', 'bus-golden.test.js'), 'utf8').replace(/\r\n/g, '\n');
  assert.equal(crypto.createHash('sha256').update(src).digest('hex'), BUS_GOLDEN_SHA256,
    'test/bus-golden.test.js changed: the spec holds the bus wire and its golden byte-identical for 0.8.5 (§2.9, §10.2)');
});

// ── U95: web-chat's MCP server at Claude Code's local scope ──────────────────
//
// Through the real commands, and the real lookup of `claude` (lib/core/
// claude-cli: PATH first): a fakeBin `claude` stands in for Claude Code. It
// logs every call and plays `claude mcp add|remove` on the sandbox's
// $CLAUDE_CONFIG_DIR/.claude.json, keyed by the physical folder it runs in (a
// non-git project's key, as Claude Code keys one).

const FAKE_CLAUDE_SRC = `
const fs = require('fs');
const path = require('path');
const argv = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify({ argv, cwd: process.cwd() }) + '\\n');
const file = path.join(process.env.CLAUDE_CONFIG_DIR, '.claude.json');
let cfg = {};
try { cfg = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
const key = fs.realpathSync(process.cwd());
cfg.projects = cfg.projects || {};
const p = (cfg.projects[key] = cfg.projects[key] || {});
p.mcpServers = p.mcpServers || {};
if (argv[0] === 'mcp' && argv[1] === 'add') {
  const name = argv[2];
  if (p.mcpServers[name]) { process.stderr.write('MCP server ' + name + ' already exists in local config\\n'); process.exit(1); }
  const env = {};
  for (let i = 0; i < argv.length; i++) if (argv[i] === '-e') { const kv = argv[++i]; env[kv.split('=')[0]] = kv.slice(kv.indexOf('=') + 1); }
  const dash = argv.indexOf('--');
  p.mcpServers[name] = { type: 'stdio', command: argv[dash + 1], args: argv.slice(dash + 2), env };
} else if (argv[0] === 'mcp' && argv[1] === 'remove') {
  if (!p.mcpServers[argv[2]]) { process.stderr.write('No MCP server named ' + argv[2] + '\\n'); process.exit(1); }
  delete p.mcpServers[argv[2]];
} else {
  process.stderr.write('fake claude: ' + argv.join(' ') + ' is not played here\\n');
  process.exit(2);
}
fs.mkdirSync(path.dirname(file), { recursive: true });
fs.writeFileSync(file, JSON.stringify(cfg, null, 2));
`;

// A private Claude tier (CLAUDE_CONFIG_DIR), a `claude` on PATH, and the hub
// port pinned where nothing listens (doctor probes it).
function claudeOnPath(t) {
  const root = tmpRoot('wc-t2e2e-cfg-');
  claudeHome(t, { root, isolate: true });
  const dir = tmpRoot('wc-t2e2e-fakeclaude-');
  const script = path.join(dir, 'claude.js');
  const log = path.join(dir, 'calls.jsonl');
  fs.writeFileSync(script, FAKE_CLAUDE_SRC);
  fs.writeFileSync(log, '');
  const { dir: binDir } = fakeBin(t, { name: 'claude', script, env: { FAKE_CLAUDE_LOG: log } });
  const prev = { PATH: process.env.PATH, WEB_CHAT_HUB_PORT: process.env.WEB_CHAT_HUB_PORT };
  process.env.PATH = `${binDir}${path.delimiter}${process.env.PATH}`;
  process.env.WEB_CHAT_HUB_PORT = '65531';
  t.after(() => {
    for (const [k, v] of Object.entries(prev)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  });
  return {
    calls: () => fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)),
    config: () => { try { return JSON.parse(fs.readFileSync(userClaudePaths().claudeJson, 'utf8')); } catch { return {}; } },
    writeConfig: (cfg) => {
      const f = userClaudePaths().claudeJson;
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, JSON.stringify(cfg, null, 2));
    },
  };
}

// What a command prints on stdout, and its answer.
async function printed(fn) {
  const lines = [];
  const prev = console.log;
  console.log = (...a) => lines.push(a.join(' '));
  let out;
  try { out = await fn(); } finally { console.log = prev; }
  return { out, text: lines.join('\n') };
}
const NO_TTY = Object.freeze({ interactive: false, confirm: async () => { throw new Error('asked a question with no terminal'); }, close() {} });
const mcpLineOf = (text) => (text.split('\n').find((l) => l.startsWith('MCP:')) || '').replace(/^MCP:\s+/, '');
const BIN = () => stableBin('claude-web-chat-mcp');
const freshProject = (prefix) => fs.realpathSync(tmpRoot(prefix));

test('U95: install in a fresh non-git project registers at local scope, writes no .mcp.json entry, and status says so', async (t) => {
  const cc = claudeOnPath(t);
  const root = freshProject('wc-t2e2e-install-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const { text } = await printed(() => install([], {
    cwd: root, prompt: NO_TTY, restartIfStale: async () => ({ restarted: false }), nextSteps: false,
  }));
  assert.deepEqual(cc.calls().map((c) => c.argv), [reg.localAddArgv()], 'one `claude mcp add web-chat --scope local`');
  assert.equal(cc.calls()[0].cwd, root, 'run from the project root: local scope is per folder');
  assert.deepEqual(cc.config().projects[root].mcpServers['web-chat'], { type: 'stdio', command: 'node', args: [BIN()], env: {} });
  assert.match(text, /Claude Code \(local scope\) +web-chat's MCP server registered for this folder/);
  const mcpJson = path.join(root, '.mcp.json');
  assert.ok(!fs.existsSync(mcpJson) || !JSON.parse(fs.readFileSync(mcpJson, 'utf8')).mcpServers['web-chat'],
    'no web-chat entry in .mcp.json, so no approval dialog at launch');
  assert.ok(fs.existsSync(projectPaths(root).mcpRegistration), '.web-chat/mcp-registration.json records it');

  const st = await printed(() => status([], { cwd: root }));
  assert.match(mcpLineOf(st.text), /^registered for you \(local scope\)/, st.text);
  assert.equal(cc.calls().length, 1, 'status never runs `claude`');
});

test('U95: a 0.8.2 .mcp.json entry rejected in settings.local.json reads REJECTED, and doctor with no terminal only reports it', async (t) => {
  const cc = claudeOnPath(t);
  const root = freshProject('wc-t2e2e-rejected-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(projectPaths(root).dir, { recursive: true });
  fs.writeFileSync(path.join(root, '.mcp.json'), `${JSON.stringify({ mcpServers: { 'web-chat': { command: 'node', args: [BIN()] } } }, null, 2)}\n`);
  fs.mkdirSync(claudePaths(root).dir, { recursive: true });
  fs.writeFileSync(claudePaths(root).settingsLocal, JSON.stringify({ disabledMcpjsonServers: ['web-chat'] }));

  const st = await printed(() => status([], { cwd: root }));
  assert.match(mcpLineOf(st.text), /^REJECTED — web-chat is in disabledMcpjsonServers/, st.text);

  const lines = [];
  const s = await doctor([], { cwd: root, prompt: NO_TTY, log: (l) => lines.push(l) });
  assert.deepEqual(cc.calls(), [], 'no terminal: nothing registered, `claude` never run');
  assert.equal(cc.config().projects, undefined, 'and Claude Code\'s config untouched');
  assert.ok(s.checks.some((c) => c.status === 'problem' && /^web-chat's MCP server is REJECTED/.test(c.m)), lines.join('\n'));
  assert.ok(s.checks.some((c) => /doctor --register-mcp/.test(c.m)), 'it names the flag that registers anyway');
});

test('U95: an entry disabled through /mcp reads as disabled, and doctor does not repair it', async (t) => {
  const cc = claudeOnPath(t);
  const root = freshProject('wc-t2e2e-disabled-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(projectPaths(root).dir, { recursive: true });
  cc.writeConfig({ projects: { [root]: { disabledMcpServers: ['web-chat'] } } });
  const before = JSON.stringify(cc.config());

  const st = await printed(() => status([], { cwd: root }));
  assert.match(mcpLineOf(st.text), /^disabled in Claude Code for this project \(\/mcp\)/, st.text);
  const s = await doctor(['--register-mcp'], { cwd: root, prompt: NO_TTY, log: () => {} });
  assert.deepEqual(cc.calls(), [], 'not repaired: `claude` never run, even with --register-mcp');
  assert.equal(JSON.stringify(cc.config()), before, 'Claude Code\'s config untouched');
  assert.ok(s.checks.some((c) => /disabled/i.test(c.m)), 'doctor says it is disabled');
});

test('U95: apply() driven the way 0.8.2\'s updater drives it never runs `claude` for a resolvable entry', (t) => {
  const cc = claudeOnPath(t);
  // 0.8.2's lib/cli/commands/update.js syncProject, in shape: the previous
  // build's `update --from` loads the NEW engine and hands it a runClaude that
  // records and fails, then says "cannot resolve" whenever it was called.
  const syncProject082 = (root) => {
    let localScope = null;
    const recordClaude = (argv) => { localScope = argv; return { ok: false, stderr: 'not attempted by update' }; };
    const applied = reg.apply(root, { force: false, runClaude: recordClaude });
    return { applied, localScope };
  };
  for (const [what, seed] of [
    ['a 0.8.2 project', (root) => fs.writeFileSync(path.join(root, '.mcp.json'),
      JSON.stringify({ mcpServers: { 'web-chat': { command: 'node', args: [BIN()] } } }))],
    ['no entry yet', () => {}],
    ['already at local scope', (root) => cc.writeConfig({ projects: { [root]: { mcpServers: { 'web-chat': { type: 'stdio', command: 'node', args: [BIN()], env: {} } } } } })],
  ]) {
    const root = freshProject('wc-t2e2e-update-');
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    fs.mkdirSync(projectPaths(root).dir, { recursive: true });
    seed(root);
    assert.equal(syncProject082(root).localScope, null, `${what}: the updater's runClaude was never called`);
  }
  assert.deepEqual(cc.calls(), [], 'nor was the real `claude`');
});

test('U95: the turn-begin hook\'s no-daemon context is conditional on the tool list and names doctor', (t) => {
  claudeHome(t, { root: tmpRoot('wc-t2e2e-hookcfg-'), isolate: true });
  const root = freshProject('wc-t2e2e-hook-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(projectPaths(root).dir, { recursive: true }); // installed, and no daemon running
  const r = spawnSync(process.execPath, [HOOK_BIN, 'turn-begin'], {
    cwd: root, input: JSON.stringify({ prompt: 'hi', session_id: S1, hook_event_name: 'UserPromptSubmit', cwd: root }),
    env: { ...process.env }, encoding: 'utf8', timeout: 20000,
  });
  assert.equal(r.status, 0, r.stderr);
  const context = JSON.parse(r.stdout).hookSpecificOutput.additionalContext;
  assert.match(context, /No web-chat daemon is running/);
  assert.match(context, /MCP tools still work if they are in your tool list \(mcp__web-chat__\*\)/, 'conditional on Claude\'s own tool list');
  assert.match(context, /If web-chat's tools are not in your tool list, its MCP server is not loaded in this session: tell the user to run `[^`]*claude-web-chat doctor` in this project, then restart Claude Code\./);
});

// ── the chrome ───────────────────────────────────────────────────────────────

// A scratch test context for the chrome's `before`, where node:test hands a
// suite context with no `after`: the recording's daemons and fixtures register
// their cleanups here, and they run (in order) once it is done.
async function scratch(fn) {
  const afters = [];
  try {
    return await fn({ after: (f) => afters.push(f), diagnostic: () => {} });
  } finally {
    for (const f of afters) await f();
  }
}

// One daemon's session, recorded for the chrome to replay: every frame a socket
// with its chat open got (hello first), what GET /api/mirror answered once it
// settled, and each conversation's first stream page as the content route
// answered it. The chrome cannot share a process with a running daemon (the
// shell stubs the timers the daemon would use), so it replays this afterwards.
async function recording(t, d, cids) {
  const local = await socket(t, d.port, { full: true });
  return {
    local,
    async take() {
      const pages = {};
      for (const cid of cids) pages[cid] = await client.get(`/api/mirror/conversations/${encodeURIComponent(cid)}/turns?limit=30&items=summary`, d.call);
      return { frames: local.frames.slice(), snapshot: await d.snapshot(), pages };
    },
  };
}

const LOGO = encodePng(solid(16, 16, [20, 40, 200]), 16, 16);
const DATA = 'data:image/png;base64,RkFLRQ==';
// A canvas whose 2d context records what is drawn (jsdom has none): the
// favicon's compositing step, stubbed as test/favicon.test.js stubs it.
function fakeCanvas() {
  const log = [];
  let gco = 'source-over';
  const ctx = {
    get globalCompositeOperation() { return gco; },
    set globalCompositeOperation(v) { gco = v; },
    fillStyle: '#000',
    clearRect: () => {}, drawImage: (...a) => log.push(['drawImage', ...a]), beginPath: () => {}, arc: () => {},
    fill: () => log.push(['fill', gco, ctx.fillStyle]),
  };
  return { width: 32, height: 32, log, getContext: (k) => (k === '2d' ? ctx : null), toDataURL: () => DATA };
}

describe('the real main.js in jsdom, on what the daemons sent', () => {
  let rec = null;
  let shell = null;
  let $ = null;
  const current = { mirror: null, identity: null, pages: {} };
  const canvases = [];
  const loads = [];
  const stubs = {
    createCanvas: () => { const c = fakeCanvas(); canvases.push(c); return c; },
    loadImage: async (src) => { loads.push(src); return { src }; },
  };
  let titleWrites = null;

  before(async () => {
    rec = await scratch(async (t) => {
      const out = {};
      // The conversation: a turn with one Read and a markdown reply, and the
      // project's square logo (its mark), recorded off one daemon.
      const d = await daemon(t);
      const r1 = await recording(t, d, [S1]);
      await runReadTurn(d);
      await closedTurnPage(d, S1);
      await waitUntil(() => r1.local.of('mirror:stream').some((f) => (f.items || []).some((it) => it.kind === 'reply' && it.text === REPLY_MD)),
        { ...WAIT, what: 'the reply\'s stream frame' });
      const put = await d.api.raw('/api/project/logo', { method: 'PUT', headers: { 'Content-Type': 'image/png' }, body: LOGO });
      assert.equal(put.status, 200, `PUT /api/project/logo: ${await put.text()}`);
      await waitUntil(() => r1.local.of('project').some((f) => f.identity && f.identity.mark), { ...WAIT, what: 'the mark\'s project frame' });
      out.turn = await r1.take();
      out.identity = await client.get('/api/project', d.call);
      // Each rewind in a project of its own (their fixtures share turn ids).
      for (const [name, sid] of [['branch', SB], ['reset', SR]]) {
        const dr = await daemon(t);
        const r = await recording(t, dr, [sid]);
        const f = fixture(name, sid);
        await playFixture(dr, f);
        out[name] = { ...(await r.take()), expect: f.expect };
      }
      return out;
    });

    shell = await bootShell({
      routes: {
        '/api/mirror': () => current.mirror,
        '/api/project': () => current.identity,
        '/api/mirror/conversations/*': (url) => {
          const cid = decodeURIComponent(url.split('?')[0].split('/')[4]);
          if (url.includes('before=')) return { conversation_id: cid, turns: [], next_before: null, total: 0, rev: 0 };
          return current.pages[cid] || { conversation_id: cid, turns: [], next_before: null, total: 0, rev: 0 };
        },
      },
      init: async (sh) => {
        // The favicon's two injected hooks (it is idempotent: a later call
        // swaps them and repaints): a fake canvas and an image loader.
        (await sh.importApp('favicon.js')).initFavicon(stubs);
        const W = sh.window;
        const desc = Object.getOwnPropertyDescriptor(W.Document.prototype, 'title');
        titleWrites = [];
        Object.defineProperty(sh.document, 'title', {
          configurable: true,
          get() { return desc.get.call(this); },
          set(v) { titleWrites.push({ value: String(v), stack: String(new Error().stack) }); desc.set.call(this, v); },
        });
      },
    });
    $ = shell.$;
  });

  after(() => (shell ? shell.restore() : undefined));

  // Replay one recorded session: its snapshot and pages answer the chrome's
  // reads, its frames arrive on the socket (the hello first).
  async function replay(session) {
    current.mirror = session.snapshot;
    current.pages = session.pages;
    for (const f of session.frames) shell.socket().receive(f);
    await shell.tick();
  }
  const writer = (stack) => {
    const line = stack.split('\n').find((l) => l.includes('/public/app/'));
    const m = line && /\/public\/app\/([\w-]+\.js)/.exec(line);
    return m ? m[1] : '(none)';
  };

  test('main.js calls exactly initChatDock, initChatPanel, initChatStream, initChatTools and initFavicon after initChatBar; again adds nothing', async () => {
    const calls = [...fs.readFileSync(path.join(REPO, 'public/app/main.js'), 'utf8').matchAll(/^(init\w+)\(/gm)].map((m) => m[1]);
    const at = calls.indexOf('initChatBar');
    assert.ok(at > calls.indexOf('initProject') && at > calls.indexOf('initChatState'), 'the bar after the project and the store');
    const tranche2 = ['initChatDock', 'initChatPanel', 'initChatStream', 'initChatTools', 'initFavicon'];
    assert.deepEqual(calls.slice(at + 1, at + 1 + tranche2.length), tranche2, 'the five, in that order, right after initChatBar');
    for (const name of tranche2) assert.equal(calls.filter((c) => c === name).length, 1, `${name} once`);

    const slots = await shell.importApp('chat-slots.js');
    const shape = () => ({
      views: slots.chatViews().map((v) => v.id),
      panels: shell.document.querySelectorAll('#chat-panel').length,
      streams: shell.document.querySelectorAll('#chat-stream .st-turns').length,
      intervals: shell.intervals().length,
      icons: [$('wc-favicon').getAttribute('href'), $('wc-favicon-dark').getAttribute('href')],
    });
    const once = shape();
    assert.deepEqual(once.views, ['dock'], 'the dock is the one chat view');
    assert.equal(once.panels, 1);
    assert.equal(once.streams, 1);
    (await shell.importApp('chat-dock.js')).initChatDock();
    (await shell.importApp('chat-panel.js')).initChatPanel();
    (await shell.importApp('chat-stream.js')).initChatStream();
    (await shell.importApp('chat-tools.js')).initChatTools();
    (await shell.importApp('favicon.js')).initFavicon(stubs);
    await shell.tick();
    assert.deepEqual(shape(), once, 'a second init of each adds no view, panel, stream, ticker or icon');
  });

  test('the chat\'s attachment limit is the daemon\'s: chat-turns ATTACHMENT_SHOW_MAX = transcripts and the content route', async () => {
    const turns = await shell.importApp('chat-turns.js');
    assert.equal(turns.ATTACHMENT_SHOW_MAX, TRANSCRIPT_ATTACHMENT_MAX);
    assert.equal(turns.ATTACHMENT_SHOW_MAX, ROUTE_ATTACHMENT_MAX);
    assert.equal(turns.ATTACHMENT_SHOW_MAX, 6242304, '6 MiB − 48 KiB (ruling U28b@attachment-limit)');
  });

  test('the panel draws the recorded turn: the prompt, one closed tool group with the Read, and the reply as chat markdown', async () => {
    const { bus } = await shell.importApp('bus.js');
    const S = await shell.importApp('chat-state.js');
    const dock = await shell.importApp('chat-dock.js');
    current.identity = rec.identity;
    await replay(rec.turn);
    assert.equal(rec.turn.frames[0].type, 'hello', 'the recording starts with the daemon\'s hello');
    assert.ok(rec.turn.frames.some((f) => f.type === 'mirror:stream' && f.conversation_id === S1), 'and holds the stream frames it sent');
    S.followConversation(S1);
    bus.emit('chat:open', { view: 'chat', focus: 'none' });
    await shell.tick();
    assert.ok(dock.isChatOpen(), 'the dock is open');
    const turnEl = await waitUntil(() => $('chat-stream').querySelector('.ct-turn[data-turn-id="p1"]'), { ...WAIT, what: 'the turn in the stream' });
    assert.ok(turnEl.closest('#chat-panel') && turnEl.closest('#chat-dock'), 'drawn in the panel, in the dock');
    assert.match(turnEl.querySelector('.ct-prompt .ct-bubble').textContent, new RegExp(PROMPT_MARK));
    const groups = turnEl.querySelectorAll('details.ct-group');
    assert.equal(groups.length, 1, 'one tool group');
    assert.match(groups[0].querySelector('summary').textContent, /1 tool call · Read/);
    const final = turnEl.querySelector('.ct-final div.md-chat');
    assert.ok(final, 'the reply is chat markdown');
    assert.equal(final.querySelector('strong').textContent, 'Done.');
    assert.equal(final.querySelector('code').textContent, 'paths');
    dock.closeChat({ returnFocus: false });
  });

  for (const name of ['branch', 'reset']) {
    test(`the stream dims the turns a ${name} superseded, under the rewound notice`, async () => {
      const { bus } = await shell.importApp('bus.js');
      const S = await shell.importApp('chat-state.js');
      const dock = await shell.importApp('chat-dock.js');
      const session = rec[name];
      const sid = name === 'branch' ? SB : SR;
      await replay(session);
      S.followConversation(sid);
      bus.emit('chat:open', { view: 'chat', focus: 'none' });
      await shell.tick();
      const all = session.expect.superseded.concat(session.expect.live);
      await waitUntil(() => all.every((id) => $('chat-stream').querySelector(`.ct-turn[data-turn-id="${id}"]`)),
        { ...WAIT, what: `the ${name} conversation's turns` });
      const el = (id) => $('chat-stream').querySelector(`.ct-turn[data-turn-id="${id}"]`);
      for (const id of session.expect.superseded) assert.ok(el(id).classList.contains('ct-superseded'), `${id} is dimmed`);
      for (const id of session.expect.live) assert.ok(!el(id).classList.contains('ct-superseded'), `${id} is not`);
      const first = el(session.expect.superseded[0]);
      const notice = first.querySelector('.ct-rewind');
      assert.ok(notice, 'the notice sits on the first superseded turn');
      assert.equal(first.firstElementChild, notice, 'above it');
      assert.equal($('chat-stream').querySelectorAll('.ct-rewind').length, 1, 'one notice');
      dock.closeChat({ returnFocus: false });
    });
  }

  test('the tab icon: the W by the browser\'s scheme, the project\'s mark from a project frame, the waiting badge; the title untouched', async () => {
    const icons = () => [$('wc-favicon').getAttribute('href'), $('wc-favicon-dark').getAttribute('href')];
    const both = (href) => [href, href];
    const project = await shell.importApp('project.js');
    const W = await waitUntil(() => project.getProject && project.getProject(), { ...WAIT, what: 'the project identity' });
    // Back to web-chat's own identity, no images: the default W.
    project.applyProject({ ...W, logo: null, logo_dark: null, favicon: null, favicon_dark: null, mark: null, mark_dark: false, touch: null });
    await shell.tick();
    const title = shell.document.title;
    titleWrites.length = 0;

    shell.setViewport({ dark: false });
    assert.deepEqual(icons(), both('/favicon.png'), 'a light browser: the default light image on both links');
    shell.setViewport({ dark: true });
    assert.deepEqual(icons(), both('/favicon-dark.png'), 'a dark browser: the default dark image on both');

    // The project frame the daemon sent when the logo went up.
    const frame = rec.turn.frames.filter((f) => f.type === 'project' && f.identity && f.identity.mark).at(-1);
    shell.socket().receive(frame);
    await shell.tick();
    const v = encodeURIComponent(frame.identity.logo.version);
    assert.deepEqual(icons(), both(`/project/mark?mode=dark&v=${v}`), 'dark: both links on the project\'s mark');
    shell.setViewport({ dark: false });
    assert.deepEqual(icons(), both(`/project/mark?v=${v}`), 'light: the same');

    const S = await shell.importApp('chat-state.js');
    let rev = 1e9;
    const status = async (state) => {
      shell.socket().receive({ type: 'mirror:status', rev: ++rev, now: Date.now(), aggregate: { state },
        conversations: [{ id: S1, state, since: Date.now() - 1000 }] });
      await shell.tick();
    };
    assert.equal(S.mirror.conn, 'live', 'precondition: the socket is live');
    for (const [state, ink] of [['waiting', '#cc592e'], ['question', '#c79a12']]) {
      canvases.length = 0;
      loads.length = 0;
      await status(state);
      await waitUntil(() => icons()[0] === DATA, { ...WAIT, what: `the ${state} badge` });
      assert.deepEqual(icons(), both(DATA), `${state}: both links wear the badged image`);
      assert.deepEqual(loads, [`/project/mark?v=${v}`], `${state}: composited onto the image that was showing`);
      assert.ok(canvases.at(-1).log.some((e) => e[0] === 'fill' && e[1] === 'destination-out'), `${state}: the ring`);
      assert.ok(canvases.at(-1).log.some((e) => e[0] === 'fill' && e[2] === ink), `${state}: the dot in ${ink}`);
      await status('idle');
      await waitUntil(() => icons()[0] !== DATA, { ...WAIT, what: 'the plain image back' });
      assert.deepEqual(icons(), both(`/project/mark?v=${v}`), `${state}: the wait over, the plain image is back`);
    }
    assert.equal(shell.document.title, title, 'the title never changed');
    assert.deepEqual(titleWrites.filter((w) => writer(w.stack) !== 'project.js'), [], 'and nothing but project.js wrote it');
  });
});
