// Code revert behind the control layer (lib/server/control/revert.js, spec
// §15.3 "Gates and actions" and "Claude is told", §15.5; C-REV-2, C-REV-3's
// notice half; rulings B4 (b), B5 (a), U43@diffs-off-capability), on
// test-support/treesnap-fixture.js's scratch repository (B2 b) with the REAL
// restore engine over a real shadow store, and a fake mirror whose diff
// answers carry real snapshot trees and heads.
//
// Pinned:
//   * a preview of a turn's before lists the rewritten, re-created and deleted
//     paths and notCovered; a restore through control.invoke('restore', …)
//     writes the earlier tree byte for byte; undo returns the later tree byte
//     for byte; the project's .git is unchanged throughout;
//   * the gates: the graph lock → 'locked'; a conversation working, waiting,
//     asking or compacting → 'busy'; `claude agents --json` listing a busy
//     session in a subdirectory → 'nested-busy' naming the relative path only;
//     one in another project passes; claude missing passes with a note;
//     garbage, an unreadable status or a timeout → 'agents-unknown'; the
//     preview's `blocked` carries the same reason; nothing is written;
//   * stale: a file edited after the preview → 'stale', nothing written; an
//     undo after a later edit → 'stale'; a pruned target → 'tree-missing';
//   * targets (B4 b): a turn's own before-tree, a 'folded' turn's own included;
//     pending, unavailable or absent records → 'no-record'; a node → its first
//     ready turn's before-tree and head; point=after → the after-tree;
//   * headMoved in the preview, describe() and the answer;
//   * features(): diffs-off, git-too-old, not-a-git-repo, and the passive
//     'no-snapshots' that never makes the shadow store;
//   * the restores record: one entry per restore and undo, newest first, at
//     most 20, no contents; a corrupt record is renamed aside;
//   * the notice: one pending notice for the turn's conversation; an undo
//     replaces it; a claim takes it once and the record says claimed; start()
//     re-puts a pending one; nothing for a refused restore;
//   * limits and events: a second restore within 5 s is rate_limited, an undo
//     right after a restore is not; one content-free control event per apply;
//     the preview's rate shape;
//   * ONE NAME PER TARGET: the REAL confirm document for restore, undo and
//     fork, mounted on the real answer surface, POSTs control-confirm.js's
//     bodyOf(query) through the real handler and gets past bad-target.
// Nothing here runs a real `claude`.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const { withTempHome, fakeBin } = require('../test-support/helpers');
const { fakeSecrets } = require('../test-support/fake-secrets');
const { runClaudeAsync } = require('../lib/core/claude-cli');
const { home: SANDBOX } = require('../test-support/sandbox');
const { treesnapRepo, gitDirDigest } = require('../test-support/treesnap-fixture');
const { createBus } = require('../lib/core/bus');
const { projectPaths } = require('../lib/core/paths');
const { request } = require('../lib/client');
const { runGit } = require('../lib/server/git-run');
const { createShadowStore } = require('../lib/server/mirror/codediff');
const { createRestore } = require('../lib/server/control/restore');
const { createControl, NOTICE_MAX } = require('../lib/server/control');
const { installFork } = require('../lib/server/control/fork');
const { createAnswerSurface } = require('../lib/server/answer-surface');
const {
  installRevert, parseAgents, noticeText, HINTS, RECORD_KEEP, AGENTS_TIMEOUT_MS,
} = require('../lib/server/control/revert');

const S1 = '11111111-1111-4111-8111-111111111111';
const S2 = '22222222-2222-4222-8222-222222222222';
const SECRET_BODY = 'CONTENT-NEVER-RECORDED-6631';

// ── fixtures ────────────────────────────────────────────────────────────────

function fakeClock(start = Date.now()) {
  let t = start;
  return { now: () => t, tick(ms) { t += ms; return t; } };
}

function conv(id, { state = 'idle', sid = S1 } = {}) {
  return { id, current_session_id: sid, sessions: [{ session_id: sid, reason: 'startup', started_at: 1 }], process: null, live: { state } };
}

// The facade's methods revert reads: diff, turn, snapshot (+ what the control
// domain subscribes to).
function fakeMirror({ records = {}, nodes = {}, headers = {}, conversations = [conv('c1')] } = {}) {
  const m = {
    records, nodes, headers, conversations, diffsOff: false, diffCalls: [],
    async diff(q) {
      m.diffCalls.push(q);
      if (m.diffsOff) return { unavailable: true };
      if (typeof q.turn === 'string') return Object.hasOwn(m.records, q.turn) ? m.records[q.turn] : null;
      if (q.node != null) return Object.hasOwn(m.nodes, q.node) ? m.nodes[q.node] : null;
      return null;
    },
    async turn(id) { return Object.hasOwn(m.headers, id) ? { turn: m.headers[id], items: [] } : null; },
    snapshot: () => ({ conversations: m.conversations }),
    subscribe: () => () => {},
    conversationOfPid: () => null,
  };
  return m;
}

const side = (s, extra = {}) => ({ tree: s.tree, at: s.at, head: s.head, ...extra });
function record(turnId, before, after, { cid = 'c1' } = {}) {
  return {
    v: 1, turn_id: turnId, conversation_id: cid, status: 'ready',
    before: side(before, { source: 'turn-open' }), after: side(after),
    files: [], totals: { files: 0, additions: 0, deletions: 0 }, attr_exact: true, created_at: after.at,
  };
}

async function snap(shadow) {
  const s = await shadow.snapshot();
  assert.equal(s.ok, true, JSON.stringify(s));
  return s;
}

// Every path in `rels` holds exactly what `tree` holds there (absent when the
// tree has none): the bytes, read back from disk.
function assertTree(repo, tree, rels, what) {
  for (const rel of rels) {
    const want = repo.bytesAt(tree, rel);
    const abs = path.join(repo.root, rel);
    if (want === null) {
      assert.equal(fs.existsSync(abs), false, `${what}: ${rel} is absent`);
      continue;
    }
    assert.deepEqual(fs.readFileSync(abs), want, `${what}: ${rel}'s bytes`);
  }
}

const PLANNED = ['a.txt', 'b.txt', 'c.txt', 'keep.txt'];

// A scratch repository with two states: s1 (turn t1's before) and s2 (its
// after). From s2 back to s1: a.txt rewritten, b.txt re-created, c.txt
// deleted, cfg.local not covered (ignored now).
async function rig(t, {
  agents = () => ({ ok: true, stdout: JSON.stringify([]) }),
  claude = '/fake/bin/claude',
  runner = runGit,
  conversations,
  surface = false,
  start = true,
  realClaude = false,
} = {}) {
  withTempHome(t);
  const repo = treesnapRepo(t, { files: { 'a.txt': 'alpha\n', 'b.txt': 'bravo\n', 'keep.txt': 'keep\n' } });
  const paths = projectPaths(repo.root);
  const shadow = createShadowStore({ root: repo.root, paths, runGit: runner });
  const engine = createRestore({ root: repo.root, paths, shadow, runGit: runner });
  // The real engine, its preview's arguments recorded (the engine is frozen).
  const previewCalls = [];
  const restore = { ...engine, preview: async (tree, opts) => { previewCalls.push({ tree, ...opts }); return engine.preview(tree, opts); } };
  repo.write('cfg.local', 'local settings\n');
  const s1 = await snap(shadow);
  repo.write('a.txt', 'alpha, edited by the turn\n');
  repo.remove('b.txt');
  repo.write('c.txt', 'charlie, made by the turn\n');
  repo.remove('cfg.local');
  repo.ignore('cfg.local');
  const s2 = await snap(shadow);

  const mirror = fakeMirror({
    records: { t1: record('t1', s1, s2) },
    headers: { t1: { id: 't1', conversation_id: 'c1', session_id: S1, started_at: s1.at, node: { id: 'node-a', label: 'n1.4' } } },
    conversations: conversations || [conv('c1')],
  });
  const clock = fakeClock();
  const bus = createBus();
  const events = [];
  bus.subscribe((e) => { if (e && e.kind === 'control') events.push(e); });
  const graph = { lock: null };
  let ans = null;
  if (surface) {
    ans = createAnswerSurface({ asks: { pending: () => [], displayView: () => null, waitView: async () => null, decide: () => ({ ok: false }), noteRefusal() {} }, mainPort: () => 54321, root: repo.root, audience: { levelOf: () => 'local' } });
  }
  const control = createControl({ root: repo.root, bus, mirror, graph, now: clock.now, answerSurface: ans, getViewers: () => ({ local: 1 }) });
  const agentCalls = [];
  const deps = {
    restore, mirror, graph, root: repo.root, paths, bus, now: clock.now,
    findClaude: () => (typeof claude === 'function' ? claude() : claude),
    runClaudeAsync: realClaude
      ? async (argv, opts) => { agentCalls.push({ argv, opts }); return runClaudeAsync(argv, opts); }
      : async (argv, opts) => { agentCalls.push({ argv, opts }); return agents(); },
  };
  const revert = installRevert(control, deps);
  t.after(async () => { await revert.stop(); await control.stop(); if (ans) await ans.close(); });
  if (start) {
    await control.start();
    await revert.start();
  }
  return { repo, paths, shadow, restore, previewCalls, s1, s2, mirror, clock, bus, events, graph, control, revert, agentCalls, deps, surface: ans };
}

const restoreVia = (r, previewId) => r.control.invoke('restore', { preview_id: previewId }, { device: 'desktop' });
const undoVia = (r, restoreId) => r.control.invoke('undo', { restore_id: restoreId }, { device: 'desktop' });
const readRecord = (r) => JSON.parse(fs.readFileSync(r.paths.controlRestores, 'utf8'));

// ── the round trip ──────────────────────────────────────────────────────────

test('preview → restore → undo: the lists, the earlier tree byte for byte, the later tree back; .git untouched', async (t) => {
  const r = await rig(t);
  const digest = gitDirDigest(r.repo);

  const pv = await r.revert.preview({ turn: 't1' });
  assert.equal(pv.ok, true, JSON.stringify(pv));
  assert.match(pv.preview_id, /^pv_[0-9a-z]+[0-9a-f]{4}$/);
  assert.deepEqual(pv.target, { turn_id: 't1', node_id: 'node-a', label: 'n1.4', point: 'before', conversation_id: 'c1', at: r.s1.at });
  assert.deepEqual(pv.written.slice().sort((a, b) => a.path.localeCompare(b.path)), [{ path: 'a.txt', status: 'M' }, { path: 'b.txt', status: 'A' }]);
  assert.deepEqual(pv.deleted, ['c.txt']);
  assert.deepEqual(pv.notCovered, [{ path: 'cfg.local', reason: 'ignored' }]);
  assert.deepEqual(pv.counts, { rewritten: 1, recreated: 1, deleted: 1, not_covered: 1 });
  assert.equal(pv.headMoved, false);
  assert.equal(pv.blocked, null);
  assert.deepEqual(pv.notes, []);
  assert.deepEqual(gitDirDigest(r.repo), digest, 'preview: .git untouched');

  const a = await restoreVia(r, pv.preview_id);
  assert.equal(a.ok, true, JSON.stringify(a));
  assert.match(a.restore_id, /^rs_/);
  assert.deepEqual(a.counts, { rewritten: 1, recreated: 1, deleted: 1, not_covered: 1 });
  assert.deepEqual(a.residual, []);
  assertTree(r.repo, r.s1.tree, PLANNED, 'restored');
  assert.equal(fs.existsSync(r.repo.abs('cfg.local')), false, 'an ignored path is never written');
  assert.deepEqual(gitDirDigest(r.repo), digest, 'restore: .git untouched');

  // The preview is consumed.
  assert.equal((await restoreVia(r, pv.preview_id)).refused, 'rate_limited', 'the limiter answers first');
  r.clock.tick(5001);
  assert.equal((await restoreVia(r, pv.preview_id)).refused, 'stale-preview');

  const u = await undoVia(r, a.restore_id);
  assert.equal(u.ok, true, JSON.stringify(u));
  assert.equal(u.undo_of, a.restore_id);
  assertTree(r.repo, r.s2.tree, PLANNED, 'undone');
  assert.deepEqual(gitDirDigest(r.repo), digest, 'undo: .git untouched');
  assert.equal((await undoVia(r, a.restore_id)).refused, 'rate_limited');
  r.clock.tick(5001);
  assert.equal((await undoVia(r, a.restore_id)).refused, 'unknown', 'an undone restore is not undone twice');
});

// ── the gates ───────────────────────────────────────────────────────────────

test('gates: the lock, then a busy conversation in each active state; the preview\'s blocked says the same; nothing is written', async (t) => {
  const r = await rig(t);
  const before = fs.readFileSync(r.repo.abs('a.txt'));
  r.graph.lock = { base: null, started_at: Date.now(), author: 'claude' };
  let pv = await r.revert.preview({ turn: 't1' });
  assert.equal(pv.blocked.reason, 'locked');
  assert.match(pv.blocked.hint, /claude-web-chat unlock/);
  let a = await restoreVia(r, pv.preview_id);
  assert.deepEqual([a.ok, a.refused], [false, 'locked']);
  assert.deepEqual(fs.readFileSync(r.repo.abs('a.txt')), before, 'nothing written');
  r.graph.lock = null;

  for (const [state, word] of [['working', 'working'], ['waiting', 'waiting on you'], ['question', 'asking'], ['compacting', 'compacting']]) {
    r.mirror.conversations = [conv('c1'), conv('c2', { state, sid: S2 })];
    r.clock.tick(1001);
    pv = await r.revert.preview({ turn: 't1' });
    assert.equal(pv.blocked.reason, 'busy', state);
    assert.match(pv.blocked.hint, new RegExp(word), state);
    a = await restoreVia(r, pv.preview_id);
    assert.deepEqual([a.ok, a.refused], [false, 'busy'], state);
  }
  assert.deepEqual(fs.readFileSync(r.repo.abs('a.txt')), before, 'nothing written');
  assert.deepEqual(r.control.notices.pending(), [], 'no notice for a refused restore');
  assert.equal(fs.existsSync(r.paths.controlRestores), false, 'no record for a refused restore');
  assert.deepEqual(r.events, [], 'no event for a refused restore');
});

test('gates: claude agents --json — a busy session in a subdirectory names only its relative path; another project passes; garbage and timeouts refuse', async (t) => {
  let answer = { ok: true, stdout: '[]' };
  const r = await rig(t, { agents: () => answer });
  fs.mkdirSync(path.join(r.repo.root, 'pkg', 'inner'), { recursive: true });
  const other = fs.realpathSync(fs.mkdtempSync(path.join(SANDBOX, 'wc-other-project-')));
  t.after(() => fs.rmSync(other, { recursive: true, force: true }));
  const before = fs.readFileSync(r.repo.abs('a.txt'));
  const preview = async () => { r.clock.tick(1001); return r.revert.preview({ turn: 't1' }); };

  answer = { ok: true, stdout: JSON.stringify([{ cwd: path.join(r.repo.root, 'pkg', 'inner'), status: 'busy', name: 'other-name' }]) };
  let pv = await preview();
  assert.equal(pv.blocked.reason, 'nested-busy');
  assert.match(pv.blocked.hint, new RegExp(`pkg${path.sep === '/' ? '/' : '\\\\'}inner`));
  assert.ok(!pv.blocked.hint.includes(r.repo.root), 'never the absolute path');
  assert.ok(!pv.blocked.hint.includes('other-name'), 'never a name');
  const a = await restoreVia(r, pv.preview_id);
  assert.deepEqual([a.refused, a.hint], ['nested-busy', pv.blocked.hint]);
  assert.deepEqual(r.agentCalls.at(-1).argv, ['agents', '--json']);
  assert.equal(r.agentCalls.at(-1).opts.cwd, r.repo.root);
  assert.equal(r.agentCalls.at(-1).opts.timeoutMs, AGENTS_TIMEOUT_MS);
  assert.equal(AGENTS_TIMEOUT_MS, 3000);

  // The wrappers, an idle session in the root and a busy one elsewhere pass.
  for (const stdout of [
    JSON.stringify({ agents: [{ cwd: r.repo.root, status: 'idle' }, { cwd: other, status: 'busy' }] }),
    JSON.stringify({ sessions: [{ cwd: other, status: 'waiting' }] }),
    JSON.stringify([{ status: 'busy' }]),
  ]) {
    answer = { ok: true, stdout };
    pv = await preview();
    assert.equal(pv.blocked, null, stdout);
  }

  // Unreadable answers refuse.
  for (const bad of [
    { ok: true, stdout: 'not json' },
    { ok: true, stdout: JSON.stringify({ something: 'else' }) },
    { ok: true, stdout: JSON.stringify([{ cwd: r.repo.root }]) },
    { ok: false, timedOut: true, stderr: '' },
    { ok: false, code: 1, stderr: 'boom' },
  ]) {
    answer = bad;
    pv = await preview();
    assert.equal(pv.blocked.reason, 'agents-unknown', JSON.stringify(bad));
    assert.equal(pv.blocked.hint, HINTS['agents-unknown']);
  }
  assert.deepEqual(fs.readFileSync(r.repo.abs('a.txt')), before, 'nothing written');
});

test('gates: claude not found skips the agents check with a note, in the preview and the answer', async (t) => {
  const r = await rig(t, { claude: null, agents: () => { throw new Error('never run'); } });
  const pv = await r.revert.preview({ turn: 't1' });
  assert.equal(pv.blocked, null);
  assert.equal(pv.notes.length, 1);
  assert.match(pv.notes[0], /claude was not found/);
  const a = await restoreVia(r, pv.preview_id);
  assert.equal(a.ok, true);
  assert.deepEqual(a.notes, pv.notes);
  assert.equal(r.agentCalls.length, 0);
});

test('gates: through the real runClaudeAsync — a stub claude\'s idle listing passes, one that outlives 3 s refuses agents-unknown', async (t) => {
  const dir = fs.mkdtempSync(path.join(SANDBOX, 'wc-agents-stub-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const script = path.join(dir, 'stub.js');
  const mode = path.join(dir, 'mode');
  fs.writeFileSync(script, `const fs = require('fs');
if (fs.readFileSync(process.env.MODE_FILE, 'utf8') === 'slow') setTimeout(() => {}, 60000);
else process.stdout.write(JSON.stringify([{ cwd: process.cwd(), status: 'idle', kind: 'interactive' }]));
`);
  fs.writeFileSync(mode, 'fast');
  const stub = fakeBin(t, { name: 'claude', script, env: { MODE_FILE: mode } });
  const r = await rig(t, { claude: stub.bin, realClaude: true });
  const pv = await r.revert.preview({ turn: 't1' });
  assert.equal(pv.blocked, null, JSON.stringify(pv.blocked));
  assert.deepEqual(pv.notes, []);
  fs.writeFileSync(mode, 'slow');
  r.clock.tick(1001);
  const t0 = Date.now();
  const slow = await r.revert.preview({ turn: 't1' });
  assert.equal(slow.blocked.reason, 'agents-unknown');
  assert.ok(Date.now() - t0 >= AGENTS_TIMEOUT_MS - 50, 'it waited the 3 s');
});

test('a residual: ok false, refused residual, the residual paths redacted in the answer and the record', async (t) => {
  const r = await rig(t);
  const ghp = fakeSecrets({ seed: 7 }).find((f) => f.id === 'github-ghp');
  const leaky = `notes-${ghp.secrets[0]}.txt`;
  const real = r.restore.apply;
  r.restore.apply = async (tree, opts) => {
    const out = await real(tree, opts);
    return { ...out, ok: false, residual: [{ path: leaky, reason: 'mismatch' }] };
  };
  const pv = await r.revert.preview({ turn: 't1' });
  const a = await restoreVia(r, pv.preview_id);
  assert.deepEqual([a.ok, a.refused, a.hint], [false, 'residual', HINTS.residual]);
  assert.match(a.restore_id, /^rs_/, 'the restore id, for the frame\'s Undo');
  assert.equal(a.residual.length, 1);
  assert.ok(!a.residual[0].path.includes(ghp.secrets[0]), 'masked in the answer');
  assert.ok(!fs.readFileSync(r.paths.controlRestores, 'utf8').includes(ghp.secrets[0]), 'masked in the record');
  assert.deepEqual(r.events.map((e) => [e.op, e.outcome]), [['restore', 'residual']]);
  const u = await undoVia(r, a.restore_id);
  assert.equal(u.ok, true, 'a residual restore is undoable');
  assertTree(r.repo, r.s2.tree, PLANNED, 'undone');
});

test('parseAgents: an array or a wrapper; anything else is unreadable', () => {
  assert.deepEqual(parseAgents('[{"cwd":"/x","status":"idle","kind":"interactive"}]'), { ok: true, sessions: [{ cwd: '/x', status: 'idle' }] });
  assert.deepEqual(parseAgents('{"agents":[{"cwd":"/x","status":"shell"}]}').sessions, [{ cwd: '/x', status: 'shell' }]);
  assert.deepEqual(parseAgents('{"sessions":[{"status":"busy"}]}').sessions, [{ cwd: null, status: 'busy' }]);
  for (const bad of ['', 'nope', '{}', '{"agents":{}}', '42', 'null']) assert.deepEqual(parseAgents(bad), { ok: false }, bad);
});

// ── stale and missing ───────────────────────────────────────────────────────

test('stale: an edit after the preview refuses the restore, an edit after the restore refuses the undo; a pruned tree is tree-missing', async (t) => {
  const r = await rig(t);
  const pv = await r.revert.preview({ turn: 't1' });
  r.repo.write('a.txt', 'edited after the preview\n');
  const a = await restoreVia(r, pv.preview_id);
  assert.deepEqual([a.ok, a.refused], [false, 'stale']);
  assert.equal(a.hint, HINTS.stale);
  assert.equal(r.repo.read('a.txt').toString(), 'edited after the preview\n', 'nothing written');
  assert.ok(r.repo.read('c.txt'), 'nothing deleted');
  assert.equal(r.events.length, 0);

  r.clock.tick(1001);
  const pv2 = await r.revert.preview({ turn: 't1' });
  const ok = await restoreVia(r, pv2.preview_id);
  assert.equal(ok.ok, true, JSON.stringify(ok));
  r.repo.write('keep.txt', 'a newer edit after the restore\n');
  const u = await undoVia(r, ok.restore_id);
  assert.deepEqual([u.ok, u.refused], [false, 'stale']);
  assert.equal(r.repo.read('keep.txt').toString(), 'a newer edit after the restore\n', 'never a silent revert of newer edits');
  assertTree(r.repo, r.s1.tree, ['a.txt', 'b.txt', 'c.txt'], 'still restored');

  r.mirror.records.gone = record('gone', { tree: 'f'.repeat(40), at: r.s1.at, head: r.s1.head }, r.s2);
  r.clock.tick(1001);
  const g = await r.revert.preview({ turn: 'gone' });
  assert.deepEqual([g.ok, g.refused, g.hint], [false, 'tree-missing', HINTS['tree-missing']]);
});

// ── targets (ruling B4 b) ───────────────────────────────────────────────────

test('targets: a turn\'s own tree (a folded turn\'s included); no-record for pending, unavailable, absent; a node\'s first ready turn; point=after', async (t) => {
  const r = await rig(t);
  const calls = r.previewCalls;
  const s3 = await snap(r.shadow); // the state now (s2)
  r.mirror.records.t2 = record('t2', s3, r.s2); // a folded turn of node-a with its own ready record
  r.mirror.headers.t2 = { id: 't2', conversation_id: 'c1', session_id: S1, node: { id: 'node-a', label: 'n1.4' }, role: 'folded' };
  r.mirror.records.tp = { v: 1, turn_id: 'tp', status: 'pending' };
  r.mirror.records.tu = { v: 1, turn_id: 'tu', status: 'unavailable', reason: 'slow-repo' };
  r.mirror.nodes['n1.4'] = { node: { id: 'node-a', label: 'n1.4' }, turns: [{ v: 1, turn_id: 'tp', status: 'pending' }, r.mirror.records.t1, r.mirror.records.t2], combined: null };
  r.mirror.nodes['n1.9'] = { node: { id: 'node-b', label: 'n1.9' }, turns: [{ v: 1, turn_id: 'tp', status: 'pending' }], combined: null };
  const look = async (q) => { r.clock.tick(1001); return r.revert.preview(q); };

  assert.equal((await look({ turn: 't2' })).ok, true);
  assert.deepEqual(calls.at(-1), { tree: s3.tree, targetHead: s3.head }, 'the folded turn\'s OWN before-tree');
  for (const id of ['tp', 'tu', 'nope']) {
    const n = await look({ turn: id });
    assert.deepEqual([n.ok, n.refused, n.hint], [false, 'no-record', HINTS['no-record']], id);
  }
  const node = await look({ node: 'n1.4' });
  assert.equal(node.ok, true);
  assert.deepEqual(calls.at(-1), { tree: r.s1.tree, targetHead: r.s1.head }, 'the node\'s first READY turn\'s before');
  assert.deepEqual(node.target, { turn_id: 't1', node_id: 'node-a', label: 'n1.4', point: 'before', conversation_id: 'c1', at: r.s1.at });
  assert.equal((await look({ node: 'n1.9' })).refused, 'no-record');
  assert.equal((await look({ node: 'n9.9' })).refused, 'unknown');

  const after = await look({ turn: 't1', point: 'after' });
  assert.equal(after.ok, true);
  assert.deepEqual(calls.at(-1), { tree: r.s2.tree, targetHead: r.s2.head });
  assert.deepEqual([after.written, after.deleted], [[], []], 'the after-tree is the working tree now');
  await look({ node: 'n1.4', point: 'after' });
  assert.deepEqual(calls.at(-1), { tree: r.s2.tree, targetHead: r.s2.head }, 'a node\'s after: its last ready turn\'s');
  assert.deepEqual((await look({ turn: 't1', point: 'sideways' })).refused, 'bad-target');
  assert.deepEqual((await look({ turn: 't1', node: 'n1.4' })).refused, 'bad-target');
});

test('headMoved: a commit after the target snapshot shows in the preview, describe() and the answer', async (t) => {
  const r = await rig(t, { surface: true });
  r.repo.commit('a commit after the turn');
  const pv = await r.revert.preview({ turn: 't1' });
  assert.equal(pv.headMoved, true);
  const { port } = await r.surface.ensure();
  const doc = await request(port, 'GET', `/answer/control/restore?preview_id=${pv.preview_id}&layout=confirm&mode=light`);
  assert.equal(doc.status, 200);
  const meta = descOf(doc.body);
  assert.equal(meta.title, 'Restore files');
  assert.equal(meta.summary, 'Restore 3 files to before turn n1.4: 1 rewritten · 1 deleted · 1 re-created · HEAD has moved since then');
  assert.deepEqual(meta.lines.slice().sort(), ['delete c.txt', 'edits made since that turn, yours included, are reverted too', 're-create b.txt', 'rewrite a.txt'].sort());
  const a = await restoreVia(r, pv.preview_id);
  assert.equal(a.ok, true);
  assert.equal(a.headMoved, true);
  assert.equal(readRecord(r).restores[0].headMoved, true);
});

// ── features ────────────────────────────────────────────────────────────────

test('features(): diffs-off first; then git-too-old and not-a-git-repo; the passive probe never makes the shadow store', async (t) => {
  const r = await rig(t);
  assert.deepEqual(r.revert.features(), { ok: true }, 'the shadow store exists: the passive probe asks restore');
  assert.deepEqual(r.control.features().code_revert, { ok: true });
  r.mirror.diffsOff = true;
  assert.deepEqual(await r.revert.refresh(), { ok: false, reason: 'diffs-off' });
  assert.deepEqual(r.revert.features(), { ok: false, reason: 'diffs-off' });
  assert.deepEqual(r.control.features().code_revert, { ok: false, reason: 'diffs-off' });
  r.clock.tick(1001);
  assert.deepEqual(await r.revert.preview({ turn: 't1' }), { ok: false, unavailable: true, reason: 'diffs-off' });

  // git 2.39: no --attr-source.
  const old = async (args, opts) => runGit(args, opts);
  old.exclusive = (fn) => runGit.exclusive(fn);
  old.features = async () => ({ version: '2.39.0', attrSource: false, missing: false });
  const o = await rig(t, { runner: old });
  assert.deepEqual(await o.revert.refresh(), { ok: false, reason: 'git-too-old' });
  assert.deepEqual(o.control.features().code_revert, { ok: false, reason: 'git-too-old' });

  // A plain directory: not a git repository.
  const plain = fs.realpathSync(fs.mkdtempSync(path.join(SANDBOX, 'wc-plain-')));
  t.after(() => fs.rmSync(plain, { recursive: true, force: true }));
  const pp = projectPaths(plain);
  const ps = createShadowStore({ root: plain, paths: pp });
  const control = createControl({ root: plain });
  const rv = installRevert(control, { restore: createRestore({ root: plain, paths: pp, shadow: ps }), mirror: fakeMirror(), root: plain, paths: pp, findClaude: () => null });
  t.after(async () => { await rv.stop(); await control.stop(); });
  await rv.start();
  assert.deepEqual(rv.features(), { ok: false, reason: 'no-snapshots' }, 'passive: no store, no git');
  assert.equal(fs.existsSync(pp.mirrorGit), false, 'the passive probe made no shadow store');
  assert.deepEqual(await rv.refresh(), { ok: false, reason: 'not-a-git-repo' });
  assert.deepEqual(await rv.refresh({ passive: true }), { ok: false, reason: 'not-a-git-repo' }, 'a full answer stands');
  assert.deepEqual(control.features().code_revert, { ok: false, reason: 'not-a-git-repo' });
});

test('features(): a fresh repository whose turns never opened reads no-snapshots and spawns no git until a preview', async (t) => {
  withTempHome(t);
  const repo = treesnapRepo(t);
  const paths = projectPaths(repo.root);
  const gitCalls = [];
  const counting = async (args, opts) => { gitCalls.push(args); return runGit(args, opts); };
  counting.exclusive = (fn) => runGit.exclusive((git) => { gitCalls.push(['exclusive']); return fn(git); });
  counting.features = async () => { gitCalls.push(['--version']); return runGit.features(); };
  const shadow = createShadowStore({ root: repo.root, paths, runGit: counting });
  const control = createControl({ root: repo.root });
  const rv = installRevert(control, { restore: createRestore({ root: repo.root, paths, shadow, runGit: counting }), mirror: fakeMirror(), root: repo.root, paths, findClaude: () => null });
  t.after(async () => { await rv.stop(); await control.stop(); });
  await rv.start();
  assert.deepEqual(rv.features(), { ok: false, reason: 'no-snapshots' });
  assert.deepEqual(control.features().code_revert, { ok: false, reason: 'no-snapshots' });
  assert.deepEqual(gitCalls, [], 'no git at all');
  assert.equal(fs.existsSync(paths.mirrorGit), false);
  assert.deepEqual(await rv.refresh(), { ok: true }, 'a full probe makes the store');
});

// ── the restores record ─────────────────────────────────────────────────────

test('the restores record: one entry per restore and undo, newest first, ids and lists only', async (t) => {
  const r = await rig(t);
  fs.writeFileSync(r.repo.abs('c.txt'), `${SECRET_BODY}\n`);
  const s = await snap(r.shadow);
  r.mirror.records.t1 = record('t1', r.s1, s);
  const pv = await r.revert.preview({ turn: 't1' });
  const a = await restoreVia(r, pv.preview_id);
  const u = await undoVia(r, a.restore_id);
  const rec = readRecord(r);
  assert.equal(rec.v, 1);
  assert.deepEqual(rec.restores.map((e) => [e.restore_id, e.kind, e.undo_of]), [[u.restore_id, 'undo', a.restore_id], [a.restore_id, 'restore', undefined]]);
  const [eu, er] = rec.restores;
  assert.deepEqual(Object.keys(er).sort(), ['after_tree', 'at', 'conversation_id', 'deleted', 'headMoved', 'kind', 'notCovered', 'notice', 'residual', 'restore_id', 'safety_tree', 'session_ids', 'target', 'target_tree', 'written']);
  assert.equal(er.target_tree, r.s1.tree);
  assert.equal(er.safety_tree, s.tree);
  assert.equal(eu.target_tree, s.tree, 'an undo goes back to its restore\'s safety tree');
  assert.equal(er.conversation_id, 'c1');
  assert.deepEqual(er.session_ids, [S1]);
  assert.deepEqual(er.deleted, ['c.txt']);
  assert.ok(!JSON.stringify(rec).includes(SECRET_BODY), 'never a file\'s contents');
  assert.ok(!JSON.stringify(rec).includes('alpha'), 'never a file\'s contents');
  assert.deepEqual(r.revert.restores(), rec.restores);
});

test('the restores record keeps the last 20; a corrupt one is renamed aside and the next write starts fresh', async (t) => {
  const r = await rig(t, { start: false });
  fs.mkdirSync(path.dirname(r.paths.controlRestores), { recursive: true });
  const seeded = Array.from({ length: RECORD_KEEP }, (_, i) => ({
    restore_id: `rs_${(1000 + i).toString(36)}abcd`, kind: 'restore', at: i, target: { label: 'n1.1', point: 'before' },
    target_tree: 'a'.repeat(40), safety_tree: 'b'.repeat(40), after_tree: 'c'.repeat(40),
    written: [], deleted: [], notCovered: [], residual: [], headMoved: false, conversation_id: null, session_ids: [], notice: 'none',
  })).reverse();
  fs.writeFileSync(r.paths.controlRestores, JSON.stringify({ v: 1, restores: seeded }));
  await r.control.start();
  await r.revert.start();
  const pv = await r.revert.preview({ turn: 't1' });
  const a = await restoreVia(r, pv.preview_id);
  assert.equal(a.ok, true);
  const rec = readRecord(r).restores;
  assert.equal(rec.length, 20);
  assert.equal(rec[0].restore_id, a.restore_id, 'newest first');
  assert.deepEqual(rec.slice(1).map((e) => e.restore_id), seeded.slice(0, 19).map((e) => e.restore_id), 'the oldest dropped');

  // Corrupt: a fresh revert over the same root.
  fs.writeFileSync(r.paths.controlRestores, '{"v": 1, "restores": [tor');
  const control = createControl({ root: r.repo.root, mirror: r.mirror, now: r.clock.now });
  const rv = installRevert(control, { ...r.deps, now: r.clock.now });
  t.after(async () => { await rv.stop(); await control.stop(); });
  await control.start();
  await rv.start();
  r.clock.tick(1001);
  r.repo.write('a.txt', 'alpha, edited by the turn\n');
  const pv2 = await rv.preview({ turn: 't1' });
  const b = await control.invoke('restore', { preview_id: pv2.preview_id }, {});
  assert.equal(b.ok, true, JSON.stringify(b));
  const dir = path.dirname(r.paths.controlRestores);
  assert.ok(fs.readdirSync(dir).some((f) => f.startsWith('restores.json.corrupt-')), 'renamed aside');
  assert.deepEqual(readRecord(r).restores.map((e) => e.restore_id), [b.restore_id], 'started fresh');
});

// ── the notice ──────────────────────────────────────────────────────────────

test('the notice: one pending notice for the turn\'s conversation; an undo replaces it; a claim takes it once; start() re-puts a pending one', async (t) => {
  const r = await rig(t);
  const pv = await r.revert.preview({ turn: 't1' });
  const a = await restoreVia(r, pv.preview_id);
  let pending = r.control.notices.pending();
  assert.equal(pending.length, 1);
  const n = pending[0];
  assert.equal(n.conversation_id, 'c1');
  assert.deepEqual(n.session_ids, [S1]);
  assert.equal(n.source, a.restore_id);
  assert.match(n.text, /^\*\*Files restored from the web-chat page\*\* to before turn n1\.4 \(/);
  assert.match(n.text, /\nRewritten: a\.txt\n/);
  assert.match(n.text, /\nDeleted: c\.txt\n/);
  assert.match(n.text, /\nRe-created: b\.txt\n/);
  assert.match(n.text, /\nRead a file again before you edit it\.$/);
  assert.ok(!n.text.includes('cfg.local'), 'a path not restored is not listed');
  assert.ok(!n.text.includes('alpha'), 'never contents');
  assert.equal(readRecord(r).restores[0].notice, 'pending');

  const u = await undoVia(r, a.restore_id);
  pending = r.control.notices.pending();
  assert.equal(pending.length, 1, 'replaced, never stacked');
  assert.equal(pending[0].source, u.restore_id);
  assert.match(pending[0].text, /the restore to before turn n1\.4 was undone/);
  assert.deepEqual(readRecord(r).restores.map((e) => e.notice), ['pending', 'replaced']);

  // A restart: a new control domain re-puts the record's pending notice.
  const control2 = createControl({ root: r.repo.root, mirror: r.mirror, now: r.clock.now });
  const rv2 = installRevert(control2, { ...r.deps });
  t.after(async () => { await rv2.stop(); await control2.stop(); });
  assert.deepEqual(control2.notices.pending(), []);
  await rv2.start();
  assert.deepEqual(control2.notices.pending().map((x) => [x.source, x.conversation_id]), [[u.restore_id, 'c1']]);

  const got = r.control.notices.claim({ session_id: S1, max_chars: 5000 });
  assert.deepEqual(got.map((x) => x.text), [pending[0].text]);
  assert.deepEqual(r.control.notices.claim({ session_id: S1, max_chars: 5000 }), [], 'once');
  assert.deepEqual(readRecord(r).restores.map((e) => e.notice), ['claimed', 'replaced']);
});

test('the notice: nothing is put when nothing was restored; a long one fits the cap with "and N more"', async (t) => {
  const r = await rig(t);
  const pv = await r.revert.preview({ turn: 't1', point: 'after' });
  assert.deepEqual([pv.written, pv.deleted], [[], []]);
  const a = await restoreVia(r, pv.preview_id);
  assert.equal(a.ok, true);
  assert.deepEqual(r.control.notices.pending(), [], 'nothing restored, nothing put');
  assert.equal(readRecord(r).restores[0].notice, 'none');

  const many = Array.from({ length: 120 }, (_, i) => `src/some/long/directory/name/file-${String(i).padStart(3, '0')}.js`);
  const text = noticeText({ head: '**Files restored from the web-chat page** to before turn n1.2 (2026-10-07 10:00).', rewritten: many, deleted: many.slice(0, 50), recreated: [] });
  assert.ok(text.length <= NOTICE_MAX, `${text.length} ≤ ${NOTICE_MAX}`);
  assert.match(text, /\nRewritten: src\/some.*, and \d+ more\n/);
  assert.match(text, /\nDeleted: src\/some.*, and \d+ more\n/);
  assert.match(text, /Read a file again before you edit it\.$/);
  const short = noticeText({ head: 'h', rewritten: Array.from({ length: 45 }, (_, i) => `f${i}.js`), deleted: [], recreated: [] });
  assert.match(short, /, and 5 more\n/, 'at most 40 paths per list');
});

// ── limits and events ───────────────────────────────────────────────────────

test('limits and events: a second restore within 5 s is rate_limited, an undo right after is not; one content-free event per apply', async (t) => {
  const r = await rig(t);
  const pv = await r.revert.preview({ turn: 't1' });
  const a = await restoreVia(r, pv.preview_id);
  assert.equal(a.ok, true);
  r.clock.tick(1001);
  const pv2 = await r.revert.preview({ turn: 't1', point: 'after' });
  assert.equal((await restoreVia(r, pv2.preview_id)).refused, 'rate_limited');
  const u = await undoVia(r, a.restore_id);
  assert.equal(u.ok, true, 'an undo is its own bucket');
  r.clock.tick(5000);
  r.clock.tick(1);
  const pv3 = await r.revert.preview({ turn: 't1' });
  const b = await restoreVia(r, pv3.preview_id);
  assert.equal(b.ok, true, JSON.stringify(b));

  assert.deepEqual(r.events.map((e) => [e.op, e.id, e.outcome]), [['restore', a.restore_id, 'ok'], ['undo', u.restore_id, 'ok'], ['restore', b.restore_id, 'ok']]);
  for (const e of r.events) {
    for (const k of Object.keys(e)) assert.ok(['kind', 'op', 'id', 'outcome', 'seq', 'ts', 'at'].includes(k), `event key ${k}`);
    assert.ok(!JSON.stringify(e).includes('.txt'), 'no path on the event');
  }
  const audit = fs.readFileSync(r.paths.controlAudit, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(audit.map((l) => [l.action, l.outcome]), [['restore', 'accepted'], ['restore', 'refused:rate_limited'], ['undo', 'accepted'], ['restore', 'accepted']]);
});

test('the preview\'s rate shape: the same target within 1 s is the same preview_id; another target is rate_limited', async (t) => {
  const r = await rig(t);
  const [p1, p2] = await Promise.all([r.revert.preview({ turn: 't1' }), r.revert.preview({ turn: 't1' })]);
  assert.equal(p1.preview_id, p2.preview_id, 'joined while in flight');
  r.clock.tick(500);
  assert.equal((await r.revert.preview({ turn: 't1' })).preview_id, p1.preview_id, 'within 1 s');
  assert.deepEqual(await r.revert.preview({ turn: 't1', point: 'after' }), { ok: false, refused: 'rate_limited', hint: HINTS.rate_limited });
  r.clock.tick(1001);
  const p3 = await r.revert.preview({ turn: 't1' });
  assert.notEqual(p3.preview_id, p1.preview_id, 'a fresh preview after the window');
});

// ── one name per target (U85@confirm-fields-vs-params) ──────────────────────

let CONFIRM = null;
test.before(async () => {
  CONFIRM = await import(pathToFileURL(path.join(__dirname, '..', 'lib', 'server', 'answer-surface', 'public', 'control-confirm.js')).href);
});

const nonceOf = (html) => /name="wc-answer-nonce" content="([^"]*)"/.exec(html)[1];
function descOf(html) {
  const m = /<meta name="wc-control" content="([^"]*)">/.exec(html);
  const raw = m[1].replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  return JSON.parse(raw);
}

// The confirm document for `action` with `query`, then its POST of
// bodyOf(query) — exactly what control-confirm.js sends.
async function confirmThrough(port, origin, action, query) {
  const qs = `${query}&layout=confirm&mode=light&size=compact`;
  const doc = await request(port, 'GET', `/answer/control/${action}?${qs}`);
  assert.equal(doc.status, 200, `${action}: the document (${JSON.stringify(doc.body).slice(0, 200)})`);
  const body = CONFIRM.bodyOf(Object.fromEntries(new URLSearchParams(qs)));
  const res = await request(port, 'POST', `/answer/api/control/${action}?device=desktop`, body, {
    headers: { origin, 'sec-fetch-site': 'same-origin', 'x-wc-answer': nonceOf(doc.body) },
  });
  return { body, res, desc: descOf(doc.body) };
}

test('one name per target: the real confirm documents for restore, undo and fork POST bodyOf(query) past bad-target', async (t) => {
  const r = await rig(t, { surface: true });
  installFork(r.control, { mirror: r.mirror, graph: r.graph, root: r.repo.root, findClaude: () => null, bus: r.bus });
  const { origin, port } = await r.surface.ensure();

  const pv = await r.revert.preview({ turn: 't1' });
  const rs = await confirmThrough(port, origin, 'restore', `preview_id=${pv.preview_id}`);
  assert.deepEqual(rs.body, { preview_id: pv.preview_id });
  assert.equal(rs.res.status, 200, JSON.stringify(rs.res.body));
  assert.equal(rs.res.body.ok, true);
  assertTree(r.repo, r.s1.tree, PLANNED, 'restored through the frame');

  const un = await confirmThrough(port, origin, 'undo', 'restore_id=latest');
  assert.deepEqual(un.body, { restore_id: 'latest' });
  assert.match(un.desc.summary, /^Undo the restore of 3 files \(before turn n1\.4, \d+ s ago\)$/);
  assert.equal(un.res.status, 200, JSON.stringify(un.res.body));
  assert.equal(un.res.body.undo_of, rs.res.body.restore_id, "'latest' bound the concrete restore at mint");
  assertTree(r.repo, r.s2.tree, PLANNED, 'undone through the frame');

  const fk = await confirmThrough(port, origin, 'fork', 'turn_id=t1');
  assert.deepEqual(fk.body, { turn_id: 't1' });
  assert.notEqual(fk.res.status, 400, JSON.stringify(fk.res.body));
  assert.notEqual(fk.res.status, 403, JSON.stringify(fk.res.body));
  assert.equal(fk.res.body.refused, 'no-transcripts', 'the action\'s own refusal');

  // The tripwire: a document mounted under another name (the alias params()
  // accepts) still mints, but its bodyOf names no field of the row, so the
  // POST binds no nonce: the gate refuses it before the handler.
  r.clock.tick(5001);
  const pv2 = await r.revert.preview({ turn: 't1' });
  const alias = await confirmThrough(port, origin, 'restore', `preview=${pv2.preview_id}`);
  assert.deepEqual(alias.body, { preview: pv2.preview_id });
  assert.deepEqual([alias.res.status, alias.res.body.refused], [403, 'nonce'], 'a mount param that is not the row\'s field never acts');
});
