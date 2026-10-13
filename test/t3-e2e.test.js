// Tranche 3 of the chat mirror, end to end (design spec §11.6, "End-to-end
// check (U51)"): the daemon exactly as createServer wires it — tranche 3's
// sources in SOURCES after tranche 2's (tasks, agents, workflows, codediff,
// graph-link), graph.mirror set to the facade so commitNode attaches each
// closed turn, the work and code routes mounted, every handle stopped by both
// teardown paths — and the identity CLI run against it. The chrome's half (the
// chips, the tray, the bar's "Done · 1 file changed", the inspector's turns,
// the favicon, main.js's inits) is test/t3-e2e-chrome.test.js: bootShell
// replaces the globals a running daemon needs, so it replays what a daemon
// sent, recorded first.
//
// The daemon is the real one (withServer). Claude Code is played by its own
// hooks' code (envelope v1 from lib/hooks/envelope.js, posted by the mirror
// hook's postEnvelope; the turn hooks' bodies with lib/hooks/turn-begin's
// session fields), by a synthetic transcript (test-support/claude-records) in a
// private Claude tier (test-support/claude-home), and by edits in a scratch git
// repository (test-support/treesnap-fixture: a fixed identity, no GIT_*
// variable, commit.gpgsign=false). A remote viewer is `X-WC-Remote: 1` from
// loopback.
//
// Pinned, a test per clause:
//   * the server boots with tranche 3's sources registered and started after
//     tranche 2's, the work and code routes mounted (read and above), and no
//     git run at boot (codediff's shadow store is made at the first fresh turn);
//   * a synthetic background shell → a running shell row (GET
//     /api/mirror/tasks) → an Output tail ending on `[exited with code 3]`;
//   * a turn that edits one file in a scratch git repository → a diff record on
//     disk and the conversation's last turn reading code ready with 1 file
//     (the bar's "Done · 1 file changed"), a fake key in the edit masked in the
//     record on disk and in GET /api/mirror/diff;
//   * a same-second same-size edit and a `text eol=crlf` file are captured byte
//     for byte: each blob of the turn's after-tree equals the file's bytes;
//   * the restore engine (lib/server/control/restore, over the daemon's runGit)
//     applies the turn's before-tree byte for byte and its undo returns the
//     after-tree, the project's .git (objects, index, HEAD, refs) byte-identical;
//     headMoved (B1 a): preview passed the record's before.head answers false,
//     and true once a commit lands in the repository;
//   * the committed node carries node.mirror.turns (commit and folded); its
//     preview, export and replay carry no mirror key; a remote GET
//     /api/graph/node/:id below read carries none;
//   * the guarded commit role (C1 a′): a locked turn-end Stop whose prompt_id
//     names no pending turn gives the session's most recently ended turn
//     'commit'; the same Stop through the lockless path gives every turn
//     'folded';
//   * the identity CLI (bin/claude-web-chat.js, a child process) against the
//     running daemon: `identity logo <png> --dark auto` sends one project frame
//     per image and GET /project/mark?mode=dark serves the generated dark
//     bytes; `identity favicon` sets the touch icon; `identity logo … --dry-run
//     --preview` mounts identity-preview with the identity_pick signal;
//   * the server leaves no open handle through srv.stop() (a lock held: no
//     stale-timer let-through) and through gracefulShutdown(), with every
//     tranche-3 source running, in a git repository (a snapshot in flight at
//     the stop) and in a non-git root; test/bus-golden.test.js is unchanged.
//
// gracefulShutdown() with a lock held waits out its lock drain
// (LOCK_DRAIN_TIMEOUT_MS, 30 s) by design, so its lock case is the shared
// stopMirror() — stopGraph is called there, for both paths — and the
// srv.stop() case below holds the lock.

const test = require('node:test');
const { describe, before, after } = test;
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { createHook } = require('node:async_hooks');
const { withServer, tmpRoot, waitUntil, wsConnect } = require('../test-support/helpers');
const { claudeHome } = require('../test-support/claude-home');
const { createRecords } = require('../test-support/claude-records');
const { fakeSecrets, findLeaks } = require('../test-support/fake-secrets');
const { treesnapRepo, gitDirDigest, MATRIX } = require('../test-support/treesnap-fixture');
const client = require('../lib/client');
const { hookEnvelope } = require('../lib/hooks/envelope');
const { sessionFields } = require('../lib/hooks/turn-begin');
const { postEnvelope } = require('../lib/hooks/mirror');
const { MASK, RULES } = require('../lib/core/redact');
const { projectPaths } = require('../lib/core/paths');
const { sampleProcs, formatProcStart } = require('../lib/core/portfiles');
const { SOURCES } = require('../lib/server/mirror');
const { runGit } = require('../lib/server/git-run');
const { createShadowStore } = require('../lib/server/mirror/codediff');
const { createRestore } = require('../lib/server/control/restore');
const icon = require('../lib/core/icon');
const identityCmd = require('../lib/cli/commands/identity');

const REPO = path.resolve(__dirname, '..');
const CLI = path.join(REPO, 'bin', 'claude-web-chat.js');
const ICON = path.join(REPO, 'test', 'fixtures', 'icon', 'web-chat-dev-icon.png');

const S1 = '11111111-1111-4111-8111-111111111111';
const CALL_TIMEOUT_MS = 15000;
const WAIT = { timeout: 15000, interval: 10 };
const TRANCHE2 = ['live', 'transcripts', 'rewinds'];
const TRANCHE3 = ['tasks', 'agents', 'workflows', 'codediff', 'graph-link'];
// Tranche 6's source, registered after tranche 3's (U94a): every boot runs it too.
const TRANCHE6 = ['mod-live'];

// ── the daemon, and Claude Code's side of it ─────────────────────────────────

// A fresh project with a private Claude Code tier and its daemon (portfile
// written, so the hooks and the CLI find it). `git` makes the project a scratch
// repository (treesnapRepo, `files` committed as 'init').
async function daemon(t, { git = false, files } = {}) {
  let ctx = null;
  // Registered first, so it runs first: the daemon stops before the repository
  // and the Claude tier are taken away (t.after runs in registration order).
  t.after(async () => { if (ctx) await ctx.stop(); });
  const repo = git ? treesnapRepo(t, { files: files || { 'README.md': 'scratch\n' } }) : null;
  // The real path: a CLI child's cwd is, and it acts only on a daemon that
  // answers as that root's (lib/util/registry daemonFor).
  const dir = repo ? repo.root : fs.realpathSync(tmpRoot('wc-t3e2e-'));
  const ch = claudeHome(t, { root: dir, isolate: true });
  ctx = await withServer(t, { root: dir, writePortfile: true });
  return driver(ctx, ch, repo);
}

function driver(ctx, ch, repo) {
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
  const d = {
    ...ctx,
    ch,
    repo,
    call,
    envelope,
    post,
    fire: (event, extra, sid) => post(envelope(event, extra, sid)),
    turnBegin(promptId, text, sid = S1) {
      const e = envelope('UserPromptSubmit', { prompt: text, prompt_id: promptId }, sid);
      return client.post('/api/turn-begin', { message: text, author: 'user', ...sessionFields(e), prompt: e.prompt }, call);
    },
    turnEnd(reply, { sid = S1, promptId } = {}) {
      const e = envelope('Stop', { last_assistant_message: reply, ...(promptId ? { prompt_id: promptId } : {}) }, sid);
      return client.post('/api/turn-end', {
        author: 'claude', reply, ended: 'stop', ...sessionFields(e), last_assistant_message: e.stop.last_assistant_message,
      }, call);
    },
    // A mutating tool call, as Claude Code's PreToolUse and PostToolUse send it.
    async edit(file, useId) {
      const input = { file_path: file, old_string: 'a', new_string: 'b' };
      await d.fire('PreToolUse', { tool_name: 'Edit', tool_use_id: useId, tool_input: input });
      await d.fire('PostToolUse', { tool_name: 'Edit', tool_use_id: useId, tool_input: input,
        tool_response: { filePath: file }, duration_ms: 3 });
    },
    render: (id = 't3e2e-pane', html = '<p>a pane</p>') => client.post('/api/render', { id, html }, call),
    snapshot: () => client.get('/api/mirror', call),
    request: (method, p, body, headers) => client.request(ctx.port, method, p, body, { headers, timeout: CALL_TIMEOUT_MS }),
    // codediff's count of finished snapshots (the snapshot's diagnostics).
    async snapshots() {
      const s = await d.snapshot();
      return (s.diagnostics && s.diagnostics.git && s.diagnostics.git.snapshots) || 0;
    },
    async turn(cid, id) {
      const p = await client.get(`/api/mirror/conversations/${encodeURIComponent(cid)}/turns?limit=50&items=summary`, call);
      return p && p.turns ? p.turns.find((x) => x.id === id) || null : null;
    },
    node: (id, headers) => d.request('GET', `/api/graph/node/${encodeURIComponent(id)}`, null, headers),
  };
  return d;
}

// A code-changing turn, start to end: the prompt (its before-snapshot waited
// for, so the edits land after it), `work` on disk, one Edit through the hooks,
// optionally a pane (so the Stop commits a node), the Stop, then the turn's
// code settled.
async function codeTurn(d, promptId, work, { render = false, reply = 'Done.', endPrompt } = {}) {
  const seen = await d.snapshots();
  await d.turnBegin(promptId, 'please make the change');
  await waitUntil(async () => (await d.snapshots()) > seen, { ...WAIT, what: `${promptId}'s before-snapshot` });
  await work();
  await d.edit(path.join(d.root, 'edited'), `toolu_01${promptId.replace(/\W/g, '')}`);
  if (render) await d.render();
  const end = await d.turnEnd(reply, { promptId: endPrompt });
  const t = await waitUntil(async () => {
    const x = await d.turn(S1, promptId);
    return x && x.code && x.code.status !== 'pending' ? x : null;
  }, { ...WAIT, what: `${promptId}'s code` });
  return { end, turn: t };
}

const readRecord = (d, turnId) => JSON.parse(fs.readFileSync(projectPaths(d.root).mirrorDiff(turnId), 'utf8'));

// A background shell, as the transcript records it: the prompt, a Bash call
// with run_in_background, Claude Code's start sentence as its result.
function shellTurn(d, { id, file, promptId, seed = 7 }) {
  const r = createRecords({ seed, sessionId: S1, cwd: d.ch.cwd, start: Date.now() - 5000, step: 10 });
  r.prompt(`run ${id}`, { promptId });
  const useId = `toolu_01${id}`;
  r.assistant([{ type: 'tool_use', name: 'Bash', input: { command: 'npm run dev', description: 'Start the dev server',
    run_in_background: true }, id: useId }]);
  r.toolResult(useId, `Command running in background with ID: ${id}. Output is being written to: ${file}.`, { taskId: id });
  return r;
}
async function startShell(d, id, { promptId = `p-${id}` } = {}) {
  await d.fire('SessionStart', { source: 'startup', model: 'claude-test' });
  const file = d.ch.writeTaskOutput(S1, id, '');
  d.ch.writeTranscript(S1, shellTurn(d, { id, file, promptId }).records);
  const row = await waitUntil(async () => {
    const r = await client.get('/api/mirror/tasks', d.call);
    return (r.tasks || []).find((x) => x.id === id && x.status === 'running') || null;
  }, { ...WAIT, what: `the running shell ${id}` });
  return { file, row };
}

// The daemon's CLI, as the user runs it (a child process: the daemon is this one).
function cli(cwd, args) {
  return new Promise((resolve) => {
    execFile(process.execPath, [CLI, ...args], { cwd, env: process.env, timeout: 30000 }, (err, stdout, stderr) => {
      resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

// A WebSocket that records every frame of one type.
async function frames(t, port, type) {
  const ws = wsConnect(port, '/ws');
  t.after(() => { try { ws.terminate(); } catch {} });
  const out = [];
  let hello = false;
  ws.on('message', (data) => {
    let f = null;
    try { f = JSON.parse(data.toString()); } catch {}
    if (!f) return;
    if (f.type === 'hello') hello = true;
    if (f.type === type) out.push(f);
  });
  await waitUntil(() => hello, { ...WAIT, what: 'the hello' });
  return out;
}

// ── open handles (test/t2-e2e.test.js has the same tracker, and says why) ────

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
  const made = new Set();
  const hook = createHook({
    init(id, type, _trigger, resource) {
      if (type === 'Timeout') timers.add(resource);
      else if (HANDLE_TYPES.has(type)) { handles.set(id, type); made.add(type); }
    },
    destroy(id) { handles.delete(id); },
  }).enable();
  return {
    made,
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

// The daemon with every tranche-3 source running — a linked process, a tailed
// transcript, a running background shell whose output file is watched, the
// agents and workflows sources started, codediff's store made by a closed turn
// (in a git root) and, with `lock`, a held turn whose before-snapshot is in
// flight — then `teardown`; then nothing of the daemon's may be left.
async function exitsClean(t, teardown, { git, lock = false }) {
  const procStart = await liveStart();
  const base = refCounts();
  const tracker = trackHandles();
  t.after(() => tracker.stop());
  let d = null;
  t.after(async () => { if (d && d.server.listening) await d.srv.stop(); });
  d = await daemon(t, { git });
  d.ch.writeSession({ pid: process.pid, procStart, sessionId: S1, status: 'busy' });
  await startShell(d, 'bclean1');
  const st = d.srv.mirror.stats().sources;
  assert.deepEqual(st.map((s) => [s.name, s.started]), [...TRANCHE2, ...TRANCHE3, ...TRANCHE6].map((n) => [n, true]),
    'every source is running');
  if (git) {
    await codeTurn(d, 'p-made', () => d.repo.write('made.txt', 'made\n'));
    const s = await d.snapshot();
    assert.equal(s.diagnostics.git.state, 'ready', 'codediff\'s store is made');
  }
  let inFlight = false;
  if (lock) {
    const before = await d.snapshots();
    await d.turnBegin('p-held', 'one more thing');
    if (git) {
      // The prompt's before-snapshot: git is running when the teardown starts.
      inFlight = Boolean(await waitUntil(() => tracker.open().includes('PROCESSWRAP') || null,
        { timeout: 3000, interval: 1 }).catch(() => null));
      t.diagnostic(`a git child was in flight at the teardown: ${inFlight} (snapshots before: ${before})`);
    }
  }
  await teardown(d);
  assert.equal(d.server.listening, false, 'the server is closed');
  const left = await waitUntil(() => {
    const more = excess(base);
    return tracker.open().length === 0 && more.length === 0 ? 'clean' : null;
  }, { timeout: 15000, interval: 20 });
  assert.ok(left, `left behind — handles and timers: [${tracker.open().join(', ')}]; keeping the loop alive beyond the baseline: [${excess(base).join(', ')}]`);
  if (git) assert.ok(tracker.made.has('PROCESSWRAP'), 'git ran in this daemon (codediff\'s snapshots)');
  return { inFlight };
}

// ── the daemon ───────────────────────────────────────────────────────────────

test('the server boots with tranche 3\'s sources running after tranche 2\'s, the work and code routes mounted, and no git at boot', async (t) => {
  assert.deepEqual(SOURCES.map((s) => s.name), [...TRANCHE2, ...TRANCHE3, ...TRANCHE6], 'SOURCES, in §2.12\'s order');
  const d = await daemon(t, { git: true });
  await d.srv.mirror.ready;
  assert.deepEqual(d.srv.mirror.stats().sources.map((s) => [s.name, s.started]), [...TRANCHE2, ...TRANCHE3, ...TRANCHE6].map((n) => [n, true]));
  const s = await d.snapshot();
  assert.equal(s.diagnostics.git.state, 'idle', 'codediff makes its shadow store at the first fresh turn, never at boot');
  assert.equal(s.diagnostics.git.snapshots, 0);
  assert.equal(fs.existsSync(projectPaths(d.root).mirrorGit), false, 'no shadow store on disk yet');
  for (const [p, want] of [['/api/mirror/tasks', 200], ['/api/mirror/nodes', 200], ['/api/mirror/node/live', 200],
    ['/api/mirror/tasks/nope/output', 404], ['/api/mirror/agents/nope', 404], ['/api/mirror/workflows/nope', 404],
    ['/api/mirror/diff?turn=nope', 404]]) {
    const r = await d.request('GET', p);
    assert.equal(r.status, want, `GET ${p}: ${JSON.stringify(r.body)}`);
    assert.equal(typeof r.body, 'object', `${p} is the route's JSON, not Express's fallback`);
    const far = await d.request('GET', p, null, { 'X-WC-Remote': '1' });
    assert.equal(far.status, 403, `${p} is gated at read for a remote viewer with no opt-in`);
  }
  const caps = s.capabilities || {};
  assert.equal(caps.turn_diff, true, 'the code routes answer: turn_diff');
  assert.equal(caps.node_diff, true, 'and node_diff');
});

test('a synthetic background shell: a running shell row, then an Output tail ending on [exited with code 3]', async (t) => {
  const d = await daemon(t);
  const id = 'bshell3';
  const { row } = await startShell(d, id);
  assert.equal(row.kind, 'shell');
  assert.equal(row.title, 'Start the dev server');
  assert.deepEqual(row.can, { output: true, open: false, stop: true });
  const snap = await d.snapshot();
  assert.deepEqual(snap.conversations.find((c) => c.id === S1).counts.shells, 1, 'the conversation counts one shell: the "1 shell" chip');
  d.ch.appendTaskOutput(S1, id, 'building\noops\n\n[exited with code 3]\n');
  const done = await waitUntil(async () => {
    const r = await client.get('/api/mirror/tasks', d.call);
    return (r.tasks || []).find((x) => x.id === id && x.status !== 'running') || null;
  }, { ...WAIT, what: 'the shell to end' });
  assert.equal(done.status, 'failed');
  assert.equal(done.exit_code, 3);
  const out = await client.get(`/api/mirror/tasks/${id}/output?tail=16384`, d.call);
  assert.ok(out.text.trimEnd().endsWith('[exited with code 3]'), `the tail ends on the footer: ${JSON.stringify(out.text)}`);
  assert.equal(out.footer, '[exited with code 3]');
  assert.equal(out.exit_code, 3);
  assert.ok(!JSON.stringify(out).includes(d.ch.tmpDir), 'the answer names no path');
});

describe('a scratch git repository: per-turn diffs, the restore engine and the graph link', () => {
  const afters = [];
  const t0 = { after: (f) => afters.push(f), diagnostic: () => {} };
  let d = null;
  let fake = null;
  let label = null;
  let one = null;     // the one-file turn
  let oneLive = null; // the conversation's live state right after it
  let matrix = null;  // the MATRIX turn, which commits a node

  before(async () => {
    fake = fakeSecrets({ seed: 31 }).find((f) => f.id === 'github-ghp');
    label = RULES.find((rule) => rule.id === fake.rule).label;
    d = await daemon(t0, { git: true, files: { 'README.md': 'scratch\n', 'src/config.js': 'module.exports = {};\n' } });
    await d.fire('SessionStart', { source: 'startup', model: 'claude-test' });
    // One file, a fake key in the edit; no pane, so the Stop commits nothing.
    one = await codeTurn(d, 'p-one', () => d.repo.write('src/config.js', `module.exports = { token: '${fake.secrets[0]}' };\n`));
    oneLive = (await d.snapshot()).conversations.find((c) => c.id === S1).live;
    // C-REV-1's matrix: its earlier states, then a turn that makes its later ones.
    for (const c of MATRIX) await c.earlier(d.repo);
    matrix = await codeTurn(d, 'p-matrix', async () => { for (const c of MATRIX) await c.later(d.repo); }, { render: true });
  });
  after(async () => { for (const f of afters.splice(0)) await f(); });

  test('a turn that edits one file: a diff record, code ready with 1 file ("Done · 1 file changed"), the fake key masked on disk', async () => {
    assert.equal(one.end.skipped, 'no-change', 'no pane changed: the Stop committed nothing');
    assert.deepEqual(one.turn.code, { status: 'ready', files: 1, additions: 1, deletions: 1 });
    const file = projectPaths(d.root).mirrorDiff('p-one');
    assert.ok(fs.existsSync(file), 'the record is on disk');
    const raw = fs.readFileSync(file, 'utf8');
    const rec = JSON.parse(raw);
    assert.equal(rec.status, 'ready');
    assert.deepEqual(rec.files.map((f) => [f.path, f.status]), [['src/config.js', 'M']]);
    assert.ok(raw.includes(MASK(label)), 'the record stores the mask');
    assert.deepEqual(findLeaks(raw, [fake]), [], 'and no part of the key');
    assert.ok(rec.before.tree && rec.after.tree && rec.before.tree !== rec.after.tree);
    assert.equal(rec.before.head, d.repo.head(), 'before.head is the project\'s HEAD (B1 a)');
    const served = await client.get('/api/mirror/diff?turn=p-one', d.call);
    assert.equal(served.turn_id, 'p-one');
    assert.deepEqual(findLeaks(served, [fake]), [], 'GET /api/mirror/diff holds no part of the key');
    // What the bar read for its last turn once it closed: chat-present's
    // "Done · 1 file changed" (test/t3-e2e-chrome.test.js draws it).
    assert.equal(oneLive.last_turn.id, 'p-one');
    assert.equal(oneLive.last_turn.code.files, 1);
  });

  test('a same-second same-size edit and a text eol=crlf file are captured byte for byte (Q-D)', async () => {
    assert.equal(matrix.turn.code.status, 'ready', JSON.stringify(matrix.turn.code));
    const rec = readRecord(d, 'p-matrix');
    for (const rel of ['race/r.txt', 'eol/e.crlf']) {
      const blob = d.repo.bytesAt(rec.after.tree, rel);
      assert.ok(blob, `${rel} is in the after-tree`);
      assert.deepEqual(blob, d.repo.read(rel), `${rel}: the blob is the file's bytes`);
      assert.notDeepEqual(d.repo.bytesAt(rec.before.tree, rel), blob, `${rel}: and differs from the before-tree's`);
    }
    assert.deepEqual(d.repo.read('race/r.txt'), Buffer.from('dddd\n'));
    assert.deepEqual(d.repo.read('eol/e.crlf'), Buffer.from('first\nsecond\r\nfourth\n'));
  });

  test('the restore engine applies the turn\'s before-tree byte for byte; its undo returns the after-tree; .git untouched', async () => {
    const rec = readRecord(d, 'p-matrix');
    const paths = projectPaths(d.root);
    const shadow = createShadowStore({ root: d.root, paths, runGit });
    const restore = createRestore({ root: d.root, paths, shadow, runGit });
    assert.equal((await restore.features()).ok, true);
    const digest = gitDirDigest(d.repo);
    const planned = MATRIX.flatMap((c) => c.paths);
    const matches = (tree, what) => {
      for (const rel of planned) {
        const entry = d.repo.entryAt(tree, rel);
        const abs = path.join(d.root, rel);
        if (!entry) { assert.throws(() => fs.lstatSync(abs), { code: 'ENOENT' }, `${what}: ${rel} is absent`); continue; }
        const want = d.repo.bytesAt(tree, rel);
        if (entry.mode === '120000') assert.equal(fs.readlinkSync(abs), want.toString(), `${what}: ${rel}'s link`);
        else {
          assert.deepEqual(fs.readFileSync(abs), want, `${what}: ${rel}'s bytes`);
          assert.equal((fs.statSync(abs).mode & 0o111) !== 0, entry.mode === '100755', `${what}: ${rel}'s exec bit`);
        }
      }
    };
    matches(rec.after.tree, 'before the restore');
    const pv = await restore.preview(rec.before.tree, { targetHead: rec.before.head });
    assert.equal(pv.ok, true, JSON.stringify(pv));
    assert.equal(pv.current_tree, rec.after.tree, 'nothing moved since the turn');
    const res = await restore.apply(rec.before.tree, { expect: pv.current_tree, targetHead: rec.before.head });
    assert.equal(res.ok, true, JSON.stringify(res));
    matches(rec.before.tree, 'restored');
    assert.deepEqual(gitDirDigest(d.repo), digest, 'restore: the project\'s .git is byte-identical');
    const back = await restore.undo(res.restore_id, { expect: res.after_tree });
    assert.equal(back.ok, true, JSON.stringify(back));
    matches(rec.after.tree, 'undone');
    assert.deepEqual(gitDirDigest(d.repo), digest, 'undo: the project\'s .git is byte-identical');
  });

  test('the committed node carries node.mirror.turns: the code turn commit, the no-change one folded', async () => {
    const id = matrix.end.node_id;
    assert.ok(id, `the MATRIX turn committed a node: ${JSON.stringify(matrix.end)}`);
    const r = await d.node(id);
    assert.equal(r.status, 200);
    assert.equal(r.body.mirror.v, 1);
    const roles = Object.fromEntries(r.body.mirror.turns.map((x) => [x.turn_id, x.role]));
    assert.deepEqual(roles, { 'p-one': 'folded', 'p-matrix': 'commit' });
    for (const x of r.body.mirror.turns) assert.equal(x.conversation_id, S1);
    const onDisk = JSON.parse(fs.readFileSync(path.join(projectPaths(d.root).graphDir, `${id}.json`), 'utf8'));
    assert.deepEqual(onDisk.mirror.turns.map((x) => x.turn_id).sort(), ['p-matrix', 'p-one'], 'the node file keeps it');
    const turns = await client.get(`/api/mirror/node/${encodeURIComponent(id)}`, d.call);
    assert.deepEqual(turns.turns.map((x) => [x.id, x.node.role]).sort(), [['p-matrix', 'commit'], ['p-one', 'folded']]);
    const sums = await client.get('/api/mirror/nodes', d.call);
    assert.equal(sums.nodes[id].turns, 2);
  });

  test('its preview, export and replay carry no mirror key; a remote GET /api/graph/node/:id below read carries none', async () => {
    const id = matrix.end.node_id;
    // The node's link, by what only it holds: its turn ids and its key as JSON.
    const has = (s) => ['"mirror":{', '"mirror": {', 'p-matrix', 'p-one'].find((n) => s.includes(n)) || null;
    const preview = await d.request('GET', `/preview/node/${encodeURIComponent(id)}`);
    assert.equal(preview.status, 200);
    assert.ok(preview.body.includes('t3e2e-pane'), 'the preview draws the node\'s page');
    assert.equal(has(preview.body), null, 'and no mirror');
    const exp = await d.request('GET', `/api/export/${encodeURIComponent(id)}`);
    assert.equal(exp.status, 200);
    assert.ok(exp.body.includes('t3e2e-pane'), 'the export draws the page');
    assert.equal(has(exp.body), null, 'the export carries no mirror');
    const first = (await client.get('/api/graph', d.call)).nodes.map((n) => n.id).find((n) => n !== id) || id;
    const replay = await d.request('GET', `/replay?from=${encodeURIComponent(first)}&to=${encodeURIComponent(id)}`);
    assert.equal(replay.status, 200, String(replay.body).slice(0, 300));
    assert.equal(has(replay.body), null, 'no replay frame carries it');
    const steps = await client.get(`/api/replay/path?from=${encodeURIComponent(first)}&to=${encodeURIComponent(id)}`, d.call);
    assert.equal(has(JSON.stringify(steps)), null, 'nor the replay path');
    const far = await d.node(id, { 'X-WC-Remote': '1' });
    assert.equal(far.status, 200);
    assert.equal('mirror' in far.body, false, 'a remote viewer below read gets the node without its mirror');
    assert.equal(has(JSON.stringify(far.body)), null);
  });

  test('headMoved (B1 a): preview of the earlier tree, passed its before.head, answers false, then true after a commit', async () => {
    const rec = readRecord(d, 'p-matrix');
    const paths = projectPaths(d.root);
    const shadow = createShadowStore({ root: d.root, paths, runGit });
    const restore = createRestore({ root: d.root, paths, shadow, runGit });
    assert.equal((await restore.preview(rec.before.tree, { targetHead: rec.before.head })).headMoved, false,
      'no commit since the snapshot: HEAD has not moved');
    d.repo.commit('moved on');
    const moved = await restore.preview(rec.before.tree, { targetHead: rec.before.head });
    assert.equal(moved.ok, true, JSON.stringify(moved));
    assert.equal(moved.headMoved, true, 'a commit in the repository: HEAD moved');
  });
});

test('C1 a′: a locked Stop naming no pending turn gives the session\'s last ended turn commit; the lockless one folds every turn', async (t) => {
  const d = await daemon(t);
  await d.fire('SessionStart', { source: 'startup', model: 'claude-test' });
  // Locked: c0 closes with no change (pending), c1 holds the lock and renders;
  // its Stop names a prompt the mirror never saw.
  await d.turnBegin('c0', 'look first');
  assert.equal((await d.turnEnd('ok', { promptId: 'c0' })).skipped, 'no-change');
  await d.turnBegin('c1', 'now render');
  await d.render('t3e2e-c1');
  const locked = await d.turnEnd('ok', { promptId: 'c-absorbed' });
  assert.ok(locked.node_id && !locked.unlocked, JSON.stringify(locked));
  const roles = async (id) => Object.fromEntries((await d.node(id)).body.mirror.turns.map((x) => [x.turn_id, x.role]));
  assert.deepEqual(await roles(locked.node_id), { c0: 'folded', c1: 'commit' }, 'the most recently ended turn is the commit');

  // Lockless: c2 closes with no change (pending); c3 opens, and its lock is
  // cleared (`claude-web-chat unlock`, POST /api/unlock) before the surface
  // changes; its Stop, naming no pending turn, finds no lock (endTurn's
  // no-lock branch).
  await d.turnBegin('c2', 'look again');
  assert.equal((await d.turnEnd('ok', { promptId: 'c2' })).skipped, 'no-change');
  await d.turnBegin('c3', 'no lock');
  assert.equal((await client.post('/api/unlock', {}, d.call)).cleared, true, 'the lock is cleared');
  await d.render('t3e2e-c3');
  const lockless = await d.turnEnd('ok', { promptId: 'c-absorbed-2' });
  assert.equal(lockless.unlocked, true, JSON.stringify(lockless));
  assert.deepEqual(await roles(lockless.node_id), { c2: 'folded', c3: 'folded' }, 'nothing inferred: every turn folded');
});

test('identity CLI: logo --dark auto sends one project frame per image, and GET /project/mark?mode=dark serves the generated dark bytes', async (t) => {
  const d = await daemon(t);
  const seen = await frames(t, d.port, 'project');
  const r = await cli(d.root, ['identity', 'logo', ICON, '--dark', 'auto']);
  assert.equal(r.code, 0, r.stderr || r.stdout);
  assert.match(r.stdout, /through the running surface/);
  // logo, logo-dark and (the square logo being the mark) the home-screen icon.
  await waitUntil(() => seen.length >= 3, { ...WAIT, what: 'three project frames' });
  await new Promise((res) => setTimeout(res, 100));
  assert.equal(seen.length, 3, 'one project frame per image');
  const id = seen.at(-1).identity;
  assert.equal(id.mark, 'logo');
  assert.equal(id.mark_dark, true);
  const prepared = icon.prepare(fs.readFileSync(ICON), { kind: 'logo', mode: 'auto', tile: null });
  const dark = icon.encode(icon.darkVariant(prepared.variants.transparent.image, { cell: prepared.cell }).image);
  const got = await d.api.raw('/project/mark?mode=dark');
  assert.equal(got.status, 200);
  assert.ok(Buffer.from(await got.arrayBuffer()).equals(dark), 'the dark mark is the pipeline\'s generated dark variant');
  const light = await d.api.raw('/project/mark');
  assert.ok(Buffer.from(await light.arrayBuffer()).equals(prepared.variants.transparent.bytes), 'and the light one the logo');
});

test('identity CLI: favicon sets the touch icon; logo --dry-run --preview mounts identity-preview with the identity_pick signal', async (t) => {
  const d = await daemon(t);
  const fav = await cli(d.root, ['identity', 'favicon', ICON]);
  assert.equal(fav.code, 0, fav.stderr || fav.stdout);
  const ident = await client.get('/api/project', d.call);
  assert.ok(ident.touch, `the home-screen icon is set: ${JSON.stringify(ident)}`);
  const touch = await d.api.raw('/project/touch-icon');
  assert.equal(touch.status, 200);
  const prepared = icon.prepare(fs.readFileSync(ICON), { kind: 'favicon', mode: 'auto', tile: null });
  assert.ok(Buffer.from(await touch.arrayBuffer()).equals(prepared.variants.touch.bytes), 'the favicon\'s touch variant');

  const pv = await cli(d.root, ['identity', 'logo', ICON, '--dark', 'auto', '--dry-run', '--preview']);
  assert.equal(pv.code, 0, pv.stderr || pv.stdout);
  assert.match(pv.stdout, /identity_pick/);
  const hello = await d.wsHello();
  const pane = hello.mounts.find((m) => m.id === identityCmd.PREVIEW_ID);
  assert.ok(pane, 'the preview pane is on the surface');
  assert.equal(identityCmd.PREVIEW_ID, 'identity-preview');
  assert.deepEqual(pane.params.signals, [{ key: identityCmd.PICK_SIGNAL, wake: 'queue' }]);
  assert.equal(identityCmd.PICK_SIGNAL, 'identity_pick');
});

test('srv.stop() with a lock held leaves no open handle, in a git repository with a snapshot in flight', async (t) => {
  await exitsClean(t, (d) => d.srv.stop(), { git: true, lock: true });
});

test('srv.stop() with a lock held leaves no open handle, in a non-git root', async (t) => {
  await exitsClean(t, (d) => d.srv.stop(), { git: false, lock: true });
});

test('gracefulShutdown() leaves no open handle, in a git repository', async (t) => {
  await exitsClean(t, (d) => d.srv.gracefulShutdown(), { git: true });
});

test('gracefulShutdown() leaves no open handle, in a non-git root', async (t) => {
  await exitsClean(t, (d) => d.srv.gracefulShutdown(), { git: false });
});

// §2.9 and §10.2: the core bus API and its golden are unchanged by the mirror,
// for the whole release (test/t1-e2e.test.js and t2-e2e pin the same bytes).
const BUS_GOLDEN_SHA256 = '235cabffa00d1a76c0e29f77c4380f30e3361248f8221d2ebffc8c585e23216a';

test('test/bus-golden.test.js is byte-identical', () => {
  const src = fs.readFileSync(path.join(REPO, 'test', 'bus-golden.test.js'), 'utf8').replace(/\r\n/g, '\n');
  assert.equal(crypto.createHash('sha256').update(src).digest('hex'), BUS_GOLDEN_SHA256,
    'test/bus-golden.test.js changed: the spec holds the bus wire and its golden byte-identical for 0.8.5 (§2.9, §10.2)');
});
