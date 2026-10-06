// The two snapshot holes Q-D does not cover (spec §15.3, C-REV-1 items 3 and
// 4, U79), and the project's HEAD on every snapshot and record (ruling
// U43-U79@head-on-record, B1 a), in lib/server/mirror/codediff.js.
//
// Pinned, on scratch repositories from test-support/treesnap-fixture.js:
//   * hole 1: an assume-unchanged file and a skip-worktree file present on disk
//     are captured with their real bytes; a skip-worktree file absent from disk
//     keeps its entry (never recorded as deleted); the project's own index
//     keeps both bits and every file under .git is byte-identical;
//   * hole 2: a nested repository with a commit, one without, one inside an
//     untracked directory, a tracked gitlink and a git worktree under
//     .claude/worktrees/<name> are listed in the snapshot's `nested`, the
//     snapshot succeeds, and nothing inside them enters the tree; under a
//     root below the toplevel only the nested repositories inside it count;
//   * the head: a snapshot answers the project's HEAD, null on an unborn
//     branch; a record keeps before.head and after.head; a commit between two
//     turns gives the next record another after.head; the head travels with its
//     tree — a reused in-flight before carries the reused snapshot's head, a
//     'previous-turn-close' before the previous after's, also after
//     persistState → restoreState.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { withTempHome, waitUntil } = require('../test-support/helpers');
const { treesnapRepo, gitDirDigest } = require('../test-support/treesnap-fixture');
const { createRedactor } = require('../lib/core/redact');
const { projectPaths } = require('../lib/core/paths');
const { runGit } = require('../lib/server/git-run');
const { createShadowStore, createCodediffSource } = require('../lib/server/mirror/codediff');

const S1 = '11111111-1111-4111-8111-111111111111';

const storeFor = (repo, opts = {}) => createShadowStore({ root: repo.root, paths: projectPaths(repo.root), ...opts });

function treePaths(repo, tree) {
  return repo.git(['ls-tree', '-r', '--name-only', '-z', '--full-tree', tree], {
    env: { PATH: process.env.PATH, HOME: process.env.HOME, GIT_DIR: repo.shadow },
  }).toString().split('\0').filter(Boolean);
}

// A runner over the real one whose calls `hold(args)` names wait for the
// test's release(), inside held slots too.
function gatedRunner(hold) {
  const gates = [];
  const wrap = (fn) => async (args, opts = {}) => {
    if (hold(args)) await new Promise((r) => gates.push(r));
    return fn(args, opts);
  };
  const r = wrap(runGit);
  r.exclusive = (fn) => runGit.exclusive((git) => fn(wrap(git)));
  r.features = () => runGit.features();
  r.gates = gates;
  r.release = async () => {
    await waitUntil(() => gates.length, { timeout: 10000, what: 'a held git call' });
    gates.shift()();
  };
  return r;
}

// The codediff source on a minimal engine: the hooks are called directly.
function sourceOn(t, repo, { runGit: runner = null, enabled = true } = {}) {
  const headers = new Map();
  const open = new Map();
  const engine = {
    root: repo.root, paths: projectPaths(repo.root), now: Date.now, log: () => {}, graph: null,
    redactor: createRedactor(),
    timers: { setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (h) => clearTimeout(h) },
    model: {
      turn: (id) => headers.get(id) || null,
      resolveTurn: (id) => id,
      turnsOf: () => [...headers.values()],
      openTurnOf: (cid) => open.get(cid) || null,
      patchTurn: (id, p) => { const h = { id, ...(headers.get(id) || {}), ...p }; headers.set(id, h); return h; },
    },
    conversations: { list: () => [{ id: S1 }], bySession: (sid) => (sid === S1 ? { id: S1 } : null) },
    live: { noteActivity: () => {} },
  };
  const src = createCodediffSource({ enabled, ...(runner ? { runGit: runner } : {}) }).attach(engine);
  t.after(() => src.stop());
  const snaps = () => src.diagnostics().git.snapshots;
  const h = {
    src,
    snaps,
    open(id) {
      headers.set(id, { id, conversation_id: S1, code: null });
      open.set(S1, id);
      src.onTurnOpened({ id, conversation_id: S1, session_id: S1, started_at: Date.now() });
    },
    close(id) {
      open.delete(S1);
      src.onTurnClosed({ id, conversation_id: S1, session_id: S1, ended_at: Date.now(), counts: { tools: 1 } });
    },
    settled: (id) => waitUntil(() => {
      const c = headers.get(id) && headers.get(id).code;
      return c && c.status !== 'pending' ? c : null;
    }, { timeout: 20000, what: `turn ${id}'s code` }),
    record: (id) => JSON.parse(fs.readFileSync(projectPaths(repo.root).mirrorDiff(id), 'utf8')),
    // One whole turn: open, wait for its before, edit, close, settle.
    async run(id, edit) {
      const n = snaps();
      h.open(id);
      await waitUntil(() => snaps() >= n + 1, { timeout: 20000, what: `${id}'s before` });
      if (edit) await edit();
      h.close(id);
      return h.settled(id);
    },
  };
  return h;
}

// ── hole 1: assume-unchanged and skip-worktree ───────────────────────────────

test('hole 1: assume-unchanged and present skip-worktree files are captured byte for byte; an absent skip-worktree file is not a deletion; the project index keeps both bits', async (t) => {
  withTempHome(t);
  const repo = treesnapRepo(t, { files: { 'au.txt': 'au one\n', 'sw.txt': 'sw one\n', 'gone.txt': 'out of cone\n', 'both.txt': 'both one\n' } });
  repo.assumeUnchanged('au.txt');
  repo.skipWorktree('sw.txt');
  repo.skipWorktree('gone.txt', { present: false });
  repo.assumeUnchanged('both.txt');
  repo.skipWorktree('both.txt');
  repo.write('au.txt', 'au two, longer\n');
  repo.write('sw.txt', 'sw two, longer\n');
  repo.write('both.txt', 'both two, longer\n');
  const bitsBefore = ['au.txt', 'sw.txt', 'gone.txt', 'both.txt'].map((p) => repo.bits(p));
  assert.deepEqual(bitsBefore, ['h', 'S', 'S', 's'], 'the fixture set the bits');
  const digest = gitDirDigest(repo);
  const store = storeFor(repo);
  const s = await store.snapshot();
  assert.equal(s.ok, true, JSON.stringify(s));
  assert.deepEqual(repo.bytesAt(s.tree, 'au.txt'), repo.read('au.txt'), 'assume-unchanged: the bytes on disk');
  assert.deepEqual(repo.bytesAt(s.tree, 'sw.txt'), repo.read('sw.txt'), 'skip-worktree present: the bytes on disk');
  assert.deepEqual(repo.bytesAt(s.tree, 'both.txt'), repo.read('both.txt'), 'both bits: the bytes on disk');
  assert.deepEqual(repo.bytesAt(s.tree, 'gone.txt'), Buffer.from('out of cone\n'), 'skip-worktree absent: its entry stands');
  // Against HEAD's tree, the absent file is not deleted.
  const headTree = repo.git(['rev-parse', 'HEAD^{tree}']).toString().trim();
  const d = await store.diff(headTree, s.tree, { withPatch: false });
  assert.deepEqual(d.files.map((f) => [f.path, f.status]).sort(), [['au.txt', 'M'], ['both.txt', 'M'], ['sw.txt', 'M']]);
  assert.deepEqual(['au.txt', 'sw.txt', 'gone.txt', 'both.txt'].map((p) => repo.bits(p)), bitsBefore, 'the project index keeps both bits');
  assert.deepEqual(gitDirDigest(repo), digest, 'every file under .git is byte-identical');
  assert.deepEqual(fs.readdirSync(projectPaths(repo.root).mirrorTmp), [], 'the index copy is gone');
});

// ── hole 2: nested repositories and worktrees ───────────────────────────────

test('hole 2: nested repositories (with and without a commit, inside an untracked directory, a tracked gitlink) and a worktree are listed, excluded, and the snapshot succeeds', async (t) => {
  withTempHome(t);
  const repo = treesnapRepo(t, { files: { 'a.txt': 'a\n' } });
  repo.nestedRepo('vendor/with-commit');
  repo.nestedRepo('vendor/no-commit', { commit: false });
  repo.nestedRepo('loose/deeper/inner');
  repo.write('loose/plain.txt', 'plain\n');
  const linked = repo.nestedRepo('mod');
  const modHead = repo.git(['rev-parse', 'HEAD'], { cwd: linked }).toString().trim();
  repo.git(['update-index', '--add', '--cacheinfo', `160000,${modHead},mod`]);
  repo.git(['commit', '-q', '-m', 'gitlink']);
  repo.worktree('w1');
  repo.write('a.txt', 'a2\n');
  const digest = gitDirDigest(repo);
  const store = storeFor(repo);
  const s = await store.snapshot();
  assert.equal(s.ok, true, JSON.stringify(s));
  assert.deepEqual(s.nested, ['.claude/worktrees/w1', 'loose/deeper/inner', 'mod', 'vendor/no-commit', 'vendor/with-commit']);
  const paths = treePaths(repo, s.tree);
  assert.ok(paths.includes('a.txt') && paths.includes('loose/plain.txt'), paths.join(','));
  assert.ok(paths.includes('mod'), 'a tracked gitlink stays a gitlink');
  for (const p of paths) {
    assert.ok(!/^(vendor|\.claude|loose\/deeper)\//.test(p) && !p.startsWith('mod/'), `nothing from inside a nested repository: ${p}`);
  }
  assert.deepEqual(repo.bytesAt(s.tree, 'a.txt'), Buffer.from('a2\n'));
  assert.deepEqual(gitDirDigest(repo), digest, 'the project .git is untouched');
  // A second snapshot answers the same list.
  const s2 = await store.snapshot();
  assert.equal(s2.tree, s.tree);
  assert.deepEqual(s2.nested, s.nested);
});

test('hole 2 under a root below the toplevel: only the nested repositories inside the root, root-relative', async (t) => {
  withTempHome(t);
  const repo = treesnapRepo(t, { files: { 'sub/in.txt': 'in\n', 'out.txt': 'out\n' }, sub: 'sub' });
  repo.nestedRepo('sub/inner', { commit: false });
  repo.nestedRepo('outside-root');
  const s = await storeFor(repo).snapshot();
  assert.equal(s.ok, true, JSON.stringify(s));
  assert.deepEqual(s.nested, ['inner']);
});

// ── the head ─────────────────────────────────────────────────────────────────

test('head: a snapshot answers the project\'s HEAD, read read-only; an unborn branch answers null', async (t) => {
  withTempHome(t);
  const repo = treesnapRepo(t);
  const store = storeFor(repo);
  const s = await store.snapshot();
  assert.equal(s.ok, true);
  assert.equal(s.head, repo.head());
  assert.match(s.head, /^[0-9a-f]{40}$/);
  const next = repo.commit('second');
  const s2 = await store.snapshot();
  assert.equal(s2.head, next);
  assert.notEqual(s2.head, s.head);

  const unborn = treesnapRepo(t);
  unborn.git(['symbolic-ref', 'HEAD', 'refs/heads/never-born']);
  unborn.write('a.txt', 'still here\n');
  const u = await storeFor(unborn).snapshot();
  assert.equal(u.ok, true, JSON.stringify(u));
  assert.equal(u.head, null);
});

test('head on the record: before and after equal HEAD; a commit between two turns gives the next record another after.head; an unborn repository records null', async (t) => {
  withTempHome(t);
  const repo = treesnapRepo(t);
  const h = sourceOn(t, repo);
  await h.run('p1', () => repo.write('a.txt', 'one\n'));
  const r1 = h.record('p1');
  const h1 = repo.head();
  assert.equal(r1.before.head, h1);
  assert.equal(r1.after.head, h1);
  assert.deepEqual(Object.keys(r1.before).sort(), ['at', 'head', 'source', 'tree']);
  assert.deepEqual(Object.keys(r1.after).sort(), ['at', 'head', 'tree']);
  const h2 = repo.commit('between turns');
  await h.run('p2', () => repo.write('a.txt', 'two\n'));
  const r2 = h.record('p2');
  assert.equal(r2.before.head, h2);
  assert.equal(r2.after.head, h2);
  assert.notEqual(r2.after.head, r1.after.head);

  const unborn = treesnapRepo(t);
  unborn.git(['symbolic-ref', 'HEAD', 'refs/heads/never-born']);
  const u = sourceOn(t, unborn);
  assert.equal((await u.run('pU', () => unborn.write('a.txt', 'x\n'))).status, 'ready');
  assert.equal(u.record('pU').before.head, null);
  assert.equal(u.record('pU').after.head, null);
});

test('head travels with its tree: a reused in-flight before carries the reused snapshot\'s head', async (t) => {
  withTempHome(t);
  const repo = treesnapRepo(t, { files: { 'a.txt': 'a1\n', 'b.txt': 'b1\n' } });
  let holding = true;
  const runner = gatedRunner((args) => holding && args.includes('add') && args.includes('-A'));
  const h = sourceOn(t, repo, { runGit: runner });
  const old = repo.head();
  h.open('pA');
  // The before-snapshot has read HEAD and waits at its add; the project moves on.
  await waitUntil(() => runner.gates.length, { timeout: 10000, what: 'the held before-snapshot' });
  const moved = repo.commit('while the snapshot is held');
  h.close('pA'); // its after waits for the held before
  holding = false;
  await runner.release();
  const codeA = await h.settled('pA');
  assert.equal(codeA.status, 'ready');
  const rA = h.record('pA');
  assert.equal(rA.before.head, old, 'the before keeps the head its own snapshot read');
  assert.equal(rA.after.head, moved, 'the after reads HEAD now');

  // Reuse: a turn that opens while a before-snapshot started under REUSE_MS
  // is in flight takes that snapshot, and with it that snapshot's head.
  const repo2 = treesnapRepo(t, { files: { 'a.txt': 'a1\n' } });
  let hold2 = true;
  const runner2 = gatedRunner((args) => hold2 && args.includes('add') && args.includes('-A'));
  const h2 = sourceOn(t, repo2, { runGit: runner2 });
  const before = repo2.head();
  h2.open('pX');
  await waitUntil(() => runner2.gates.length, { timeout: 10000, what: 'the held before-snapshot' });
  repo2.commit('moved');
  // pX closes with no before resolved yet; pY opens at once and reuses it.
  h2.close('pX');
  h2.open('pY');
  hold2 = false;
  await runner2.release();
  await h2.settled('pX');
  await waitUntil(() => h2.snaps() >= 2, { timeout: 20000, what: 'pX\'s after' });
  repo2.write('a.txt', 'a2\n');
  h2.close('pY');
  await h2.settled('pY');
  const rY = h2.record('pY');
  assert.equal(rY.before.head, before, 'the reused before carries the reused snapshot\'s head');
  assert.equal(rY.before.tree, h2.record('pX').before.tree, 'the same snapshot');
  assert.equal(rY.before.source, 'turn-open');
});

test('head travels with its tree: a previous-turn-close before carries the previous after\'s head, also after persistState → restoreState', async (t) => {
  withTempHome(t);
  const repo = treesnapRepo(t, { files: { 'a.txt': 'a1\n' } });
  let failNext = false;
  const flaky = Object.assign(async (args, opts) => runGit(args, opts), {
    features: () => runGit.features(),
    exclusive: (fn) => runGit.exclusive((git) => fn(async (args, opts) => {
      if (failNext && args.includes('write-tree')) { failNext = false; return { stdout: '', stderr: 'injected', code: 1 }; }
      return git(args, opts);
    })),
  });
  const h = sourceOn(t, repo, { runGit: flaky });
  await h.run('p1', () => repo.write('a.txt', 'a2\n'));
  const h1 = repo.head();
  assert.equal(h.record('p1').after.head, h1);
  const h2 = repo.commit('between');
  failNext = true;
  h.open('p2');
  await waitUntil(() => !failNext, { timeout: 10000, what: 'the failed before-snapshot' });
  repo.write('a.txt', 'a3\n');
  h.close('p2');
  assert.equal((await h.settled('p2')).status, 'ready');
  const r2 = h.record('p2');
  assert.equal(r2.before.source, 'previous-turn-close');
  assert.equal(r2.before.tree, h.record('p1').after.tree);
  assert.equal(r2.before.head, h1, 'the previous after\'s head');
  assert.equal(r2.after.head, h2);

  // persistState keeps it; a fresh source restored from it falls back with it.
  const state = h.src.persistState(S1);
  assert.equal(state.chain.after.head, h2);
  assert.equal(state.chain.after.tree, r2.after.tree);
  const h3 = repo.commit('after the restart');
  const fresh = sourceOn(t, repo, { runGit: flaky });
  fresh.src.restoreState(S1, JSON.parse(JSON.stringify(state)));
  failNext = true;
  fresh.open('p3');
  await waitUntil(() => !failNext, { timeout: 10000, what: 'the failed before-snapshot' });
  repo.write('a.txt', 'a4\n');
  fresh.close('p3');
  assert.equal((await fresh.settled('p3')).status, 'ready');
  const r3 = fresh.record('p3');
  assert.equal(r3.before.source, 'previous-turn-close');
  assert.equal(r3.before.head, h2, 'the restored chain\'s head');
  assert.equal(r3.after.head, h3);

  // restoreState validates the head: anything but a 40/64-hex id or null is dropped.
  const odd = sourceOn(t, repo, { runGit: flaky });
  odd.src.restoreState(S1, { v: 1, chain: { after: { tree: r2.after.tree, at: 1, turn_id: 'p2', head: 'not-a-sha' }, trees: [] } });
  assert.equal('head' in odd.src.persistState(S1).chain.after, false);
  const nul = sourceOn(t, repo, { runGit: flaky });
  nul.src.restoreState(S1, { v: 1, chain: { after: { tree: r2.after.tree, at: 1, turn_id: 'p2', head: null }, trees: [] } });
  assert.equal(nul.src.persistState(S1).chain.after.head, null);
});

test('the store exposes full(): false on a small shadow, true under an injected cap', async (t) => {
  withTempHome(t);
  const repo = treesnapRepo(t);
  const small = storeFor(repo);
  assert.equal((await small.snapshot()).ok, true);
  assert.equal(small.full(), false);
  const tiny = storeFor(repo, { limits: { SHADOW_MAX_BYTES: 1 } });
  assert.equal((await tiny.snapshot()).ok, true);
  assert.equal(tiny.full(), true);
  assert.ok(fs.existsSync(path.join(projectPaths(repo.root).mirrorGit, 'objects')));
});
