// The restore engine (lib/server/control/restore.js, spec §15.3, C44, Q-D;
// design/chat-mirror-control.md C-REV-1), on scratch repositories from
// test-support/treesnap-fixture.js and the real git through
// lib/server/git-run.js.
//
// Pinned:
//   * C-REV-1's matrix (modified text, binary, exec bit, symlink, delete, a new
//     directory pruned, a same-second same-size edit, a `text eol=crlf` file),
//     each restored to the earlier snapshot after the later edits: every
//     planned path's bytes (bytesAt and the file itself, readlink for a link,
//     the mode for the exec bit) equal the target's, ok with no residual;
//     preview's lists are apply's; undo returns the later tree byte for byte
//     and the undo of the undo the earlier one; the project's .git is
//     byte-identical after every snapshot, preview, apply and undo — and the
//     same with the root a subdirectory of the toplevel and the process's
//     working directory at the root;
//   * never touched, and listed: an ignored file ('ignored'), a symlinked
//     directory leading out of the root ('outside'), an over-cap untracked
//     file ('over-cap'), nested repositories and a worktree ('nested-repo');
//     a file outside the root is byte-identical afterwards;
//   * refusals: 'stale' (nothing written, no safety ref), 'tree-missing',
//     'unknown', 'bad-tree'; features(): ok, git-too-old (2.39), not-a-git-repo,
//     git-missing — and preview/apply/undo refuse with the same reason;
//   * residuals: a concurrent write between the write and the verify; an
//     EACCES part way stops, reports residuals, and undo restores every file;
//   * headMoved; safety refs (the 21st apply leaves 20, newest first) and
//     `git gc --prune=now` in the shadow keeping every tree a ref names;
//   * a wall-clock bound only under WEB_CHAT_PERF=1.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { withTempHome } = require('../test-support/helpers');
const { home: SANDBOX } = require('../test-support/sandbox');
const { treesnapRepo, gitDirDigest, digestTree, MATRIX } = require('../test-support/treesnap-fixture');
const { projectPaths } = require('../lib/core/paths');
const { runGit, createGitRunner } = require('../lib/server/git-run');
const { createShadowStore } = require('../lib/server/mirror/codediff');
const { createRestore, SAFETY_KEEP, SAFETY_REF_PREFIX } = require('../lib/server/control/restore');

function engineFor(repo, { runGit: runner = runGit, limits = {} } = {}) {
  const paths = projectPaths(repo.root);
  const shadow = createShadowStore({ root: repo.root, paths, runGit: runner, limits });
  const restore = createRestore({ root: repo.root, paths, shadow, runGit: runner });
  return { shadow, restore, paths };
}

async function snap(shadow) {
  const s = await shadow.snapshot();
  assert.equal(s.ok, true, JSON.stringify(s));
  return s;
}

// Every planned path of `paths` holds exactly what `tree` holds there.
function assertMatches(repo, tree, rels, what) {
  for (const rel of rels) {
    const entry = repo.entryAt(tree, rel);
    const abs = path.join(repo.root, rel);
    if (!entry) {
      assert.throws(() => fs.lstatSync(abs), { code: 'ENOENT' }, `${what}: ${rel} is absent`);
      continue;
    }
    const want = repo.bytesAt(tree, rel);
    const st = fs.lstatSync(abs);
    if (entry.mode === '120000') {
      assert.ok(st.isSymbolicLink(), `${what}: ${rel} is a symlink`);
      assert.equal(fs.readlinkSync(abs), want.toString(), `${what}: ${rel}'s link target`);
    } else {
      assert.ok(st.isFile(), `${what}: ${rel} is a file`);
      assert.deepEqual(fs.readFileSync(abs), want, `${what}: ${rel}'s bytes`);
      assert.equal((st.mode & 0o111) !== 0, entry.mode === '100755', `${what}: ${rel}'s exec bit`);
    }
  }
}

function shadowGit(repo, args) {
  return repo.git(args, { env: { PATH: process.env.PATH, HOME: process.env.HOME, GIT_DIR: repo.shadow } }).toString();
}

// A runner over the real one; `after(args)` runs once a slot call returns.
function hookedRunner({ after = null, features = null } = {}) {
  const wrap = (fn) => async (args, opts) => {
    const r = await fn(args, opts);
    if (after) await after(args, r);
    return r;
  };
  const r = wrap(runGit);
  r.exclusive = (fn) => runGit.exclusive((git) => fn(wrap(git)));
  r.features = features || (() => runGit.features());
  return r;
}

// ── C-REV-1's matrix ─────────────────────────────────────────────────────────

async function runMatrix(t, { sub = '' } = {}) {
  withTempHome(t);
  const repo = treesnapRepo(t, { sub, files: { [`${sub ? `${sub}/` : ''}keep.txt`]: 'keep\n', 'top-level.txt': 'top\n' } });
  if (sub) {
    const cwd = process.cwd();
    process.chdir(repo.root);
    t.after(() => process.chdir(cwd));
  }
  const { shadow, restore } = engineFor(repo);
  for (const c of MATRIX) await c.earlier(repo);
  const earlier = await snap(shadow);
  for (const c of MATRIX) await c.later(repo);
  if (sub) repo.write('top-level.txt', 'top, changed outside the root\n');
  const later = await snap(shadow);
  assert.notEqual(earlier.tree, later.tree);
  const planned = MATRIX.flatMap((c) => c.paths);
  const digest = gitDirDigest(repo);
  assert.equal((await restore.features()).ok, true);

  const pv = await restore.preview(earlier.tree);
  assert.equal(pv.ok, true, JSON.stringify(pv));
  assert.equal(pv.current_tree, later.tree, 'the preview\'s current tree is a fresh snapshot');
  assert.deepEqual(gitDirDigest(repo), digest, 'preview: .git untouched');
  const touched = [...pv.written.map((w) => w.path), ...pv.deleted].sort();
  assert.deepEqual(touched, [...planned].sort(), 'the plan is the matrix\'s paths');
  assert.deepEqual(pv.notCovered, []);
  assert.deepEqual(pv.deleted.sort(), ['newdir/deep/x.txt', 'newdir/y.txt']);
  const status = Object.fromEntries(pv.written.map((w) => [w.path, w.status]));
  assert.equal(status['del/gone.txt'], 'A');
  assert.equal(status['link/was-file'], 'T');
  assert.equal(status['text/m.txt'], 'M');

  const res = await restore.apply(earlier.tree, { expect: pv.current_tree });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.deepEqual(res.residual, []);
  assert.match(res.restore_id, /^rs_[0-9a-z]+$/);
  assert.equal(res.safety_tree, later.tree);
  assert.equal(res.after_tree, earlier.tree, 'every path back: the trees agree too');
  assert.deepEqual(res.written, pv.written, 'preview and apply give the same lists');
  assert.deepEqual(res.deleted, pv.deleted);
  assert.equal(res.headMoved, false);
  assert.ok(Number.isFinite(res.duration_ms));
  assertMatches(repo, earlier.tree, planned, 'apply');
  assert.equal(fs.existsSync(path.join(repo.root, 'newdir')), false, 'the new directory is pruned');
  assert.ok(fs.existsSync(path.join(repo.root, 'del')), 'a directory that keeps a file stays');
  assert.ok(fs.existsSync(repo.root), 'never the root');
  assert.deepEqual(gitDirDigest(repo), digest, 'apply: .git untouched');
  assert.deepEqual(fs.readdirSync(projectPaths(repo.root).mirrorTmp), [], 'the index copies are gone');
  if (sub) assert.deepEqual(repo.read('top-level.txt'), Buffer.from('top, changed outside the root\n'), 'outside the root: untouched');

  const un = await restore.undo(res.restore_id);
  assert.equal(un.ok, true, JSON.stringify(un));
  assert.equal(un.undo_of, res.restore_id);
  assert.equal(un.after_tree, later.tree);
  assertMatches(repo, later.tree, planned, 'undo');
  assert.deepEqual(gitDirDigest(repo), digest, 'undo: .git untouched');

  const again = await restore.undo(un.restore_id);
  assert.equal(again.ok, true, JSON.stringify(again));
  assert.equal(again.after_tree, earlier.tree);
  assertMatches(repo, earlier.tree, planned, 'undo of the undo');
  assert.deepEqual(gitDirDigest(repo), digest, 'undo of the undo: .git untouched');
  const refs = await restore.safetyRefs();
  assert.deepEqual(refs.map((r) => r.restore_id), [again.restore_id, un.restore_id, res.restore_id], 'newest first');
  assert.deepEqual(refs.map((r) => r.tree), [later.tree, earlier.tree, later.tree], 'each safety tree is the working tree that restore replaced');
}

test('C-REV-1 matrix: each case restores byte for byte, undo returns the later tree, undo of undo the earlier; .git untouched', async (t) => {
  await runMatrix(t);
});

test('C-REV-1 matrix with the root a subdirectory of the toplevel and the process\'s working directory at the root', async (t) => {
  await runMatrix(t, { sub: 'proj' });
});

test('the user\'s core.autocrlf=true converts nothing: a CRLF+LF file under text eol=crlf restores byte for byte', async (t) => {
  const home = withTempHome(t);
  const repo = treesnapRepo(t, { files: { '.gitattributes': '*.txt text eol=crlf\n', 'm.txt': 'one\n' } });
  fs.writeFileSync(path.join(home, '.gitconfig'), '[core]\n\tautocrlf = true\n\teol = crlf\n');
  const { shadow, restore } = engineFor(repo);
  const bytes = Buffer.from('first\r\nsecond\nthird\r\n');
  repo.write('m.txt', bytes);
  const earlier = await snap(shadow);
  repo.write('m.txt', Buffer.from('changed\n'));
  const res = await restore.apply(earlier.tree);
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.deepEqual(repo.read('m.txt'), bytes);
});

// ── never touched ───────────────────────────────────────────────────────────

test('an ignored file, a symlinked directory leading out and an over-cap file are left byte-identical and listed', async (t) => {
  withTempHome(t);
  const repo = treesnapRepo(t, { sub: 'proj', files: { 'proj/keep.txt': 'keep one\n', 'outside.txt': 'outside one\n' } });
  const { shadow, restore } = engineFor(repo, { limits: { LARGE_UNTRACKED_BYTES: 1024 } });
  repo.write('proj/cache.tmp', 'old cache\n');
  repo.write('proj/data/f.txt', 'inside\n');
  repo.write('proj/big.bin', Buffer.alloc(100, 1));
  repo.write('proj/:colon[1].txt', 'colon one\n'); // no pathspec magic, no glob
  const earlier = await snap(shadow);
  repo.ignore('*.tmp');
  repo.write('proj/cache.tmp', 'new cache, ignored now\n');
  repo.remove('proj/data');
  repo.write('elsewhere/f.txt', 'outside bytes\n');
  repo.symlink('proj/data', '../elsewhere');
  repo.overCap('proj/big.bin', 4096);
  repo.write('outside.txt', 'outside two\n');
  repo.write('proj/keep.txt', 'keep two\n');
  repo.write('proj/:colon[1].txt', 'colon two\n');
  const digest = gitDirDigest(repo);
  const pv = await restore.preview(earlier.tree);
  assert.equal(pv.ok, true, JSON.stringify(pv));
  assert.deepEqual(pv.notCovered, [
    { path: 'big.bin', reason: 'over-cap' },
    { path: 'cache.tmp', reason: 'ignored' },
    { path: 'data/f.txt', reason: 'outside' },
  ]);
  const res = await restore.apply(earlier.tree);
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.deepEqual(res.notCovered, pv.notCovered);
  assert.deepEqual(repo.read('proj/keep.txt'), Buffer.from('keep one\n'), 'the covered file is restored');
  assert.deepEqual(repo.read('proj/:colon[1].txt'), Buffer.from('colon one\n'), 'a name starting \':\' is restored too');
  assert.deepEqual(repo.read('proj/cache.tmp'), Buffer.from('new cache, ignored now\n'), 'ignored: untouched');
  assert.deepEqual(repo.read('elsewhere/f.txt'), Buffer.from('outside bytes\n'), 'outside: untouched');
  assert.deepEqual(repo.read('proj/big.bin'), Buffer.alloc(4096, 0x5a), 'over-cap: untouched');
  assert.deepEqual(repo.read('outside.txt'), Buffer.from('outside two\n'), 'a file outside the root: untouched');
  assert.deepEqual(gitDirDigest(repo), digest);
});

test('a write under a file the plan deletes still goes to check-ignore: ignored now, it is listed and never written; undo puts the file back', async (t) => {
  withTempHome(t);
  const repo = treesnapRepo(t, { files: { 'keep.txt': 'keep\n' } });
  const { shadow, restore } = engineFor(repo);
  repo.write('a/b.log', 'log then\n');
  const earlier = await snap(shadow);
  repo.remove('a');
  repo.write('a', 'now a file\n');
  repo.ignore('*.log');
  const later = await snap(shadow);
  const digest = gitDirDigest(repo);
  const pv = await restore.preview(earlier.tree);
  assert.equal(pv.ok, true, JSON.stringify(pv));
  assert.deepEqual(pv.notCovered, [{ path: 'a/b.log', reason: 'ignored' }]);
  assert.deepEqual(pv.written, []);
  assert.deepEqual(pv.deleted, ['a']);
  const res = await restore.apply(earlier.tree, { expect: pv.current_tree });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.deepEqual(res.residual, []);
  assert.deepEqual(res.notCovered, pv.notCovered);
  assert.throws(() => fs.lstatSync(path.join(repo.root, 'a/b.log')), { code: 'ENOENT' }, 'the ignored path is not written');
  const un = await restore.undo(res.restore_id);
  assert.equal(un.ok, true, JSON.stringify(un));
  assert.deepEqual(un.residual, []);
  assert.ok(fs.lstatSync(path.join(repo.root, 'a')).isFile(), '\'a\' is a file again');
  assert.deepEqual(repo.read('a'), Buffer.from('now a file\n'));
  assert.deepEqual(repo.read('a'), repo.bytesAt(later.tree, 'a'));
  assert.deepEqual(gitDirDigest(repo), digest);
});

test('a sub root: the directories a restore prunes never include the root', async (t) => {
  withTempHome(t);
  const repo = treesnapRepo(t, { sub: 'proj', files: { 'proj/keep.txt': 'keep\n' } });
  const { shadow, restore } = engineFor(repo);
  const earlier = await snap(shadow);
  repo.write('proj/x.txt', 'directly in the root\n');
  repo.write('proj/n/y.txt', 'in a new directory\n');
  const rootReal = fs.realpathSync(repo.root);
  const tried = [];
  const rmdirSync = fs.rmdirSync;
  t.mock.method(fs, 'rmdirSync', function (d, ...rest) {
    tried.push(path.resolve(d));
    return rmdirSync.call(fs, d, ...rest);
  });
  const res = await restore.apply(earlier.tree);
  t.mock.restoreAll();
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.deepEqual(res.deleted.sort(), ['n/y.txt', 'x.txt']);
  assert.ok(tried.includes(path.join(rootReal, 'n')), 'the new directory is on the list');
  assert.equal(tried.some((d) => d === rootReal || d === repo.root), false, `never the root: ${JSON.stringify(tried)}`);
  assert.equal(fs.existsSync(path.join(repo.root, 'n')), false);
  assert.ok(fs.statSync(repo.root).isDirectory());
});

test('nested repositories and a worktree: listed nested-repo, nothing written inside them, the rest restored', async (t) => {
  withTempHome(t);
  const repo = treesnapRepo(t, { files: { 'a.txt': 'a1\n' } });
  const { shadow, restore } = engineFor(repo);
  repo.write('vendor/with-commit/x.txt', 'plain then\n');
  repo.write('vendor/no-commit/x.txt', 'plain then\n');
  repo.write('.claude/worktrees/w1/x.txt', 'plain then\n');
  const earlier = await snap(shadow);
  repo.remove('vendor');
  repo.remove('.claude/worktrees/w1');
  repo.nestedRepo('vendor/with-commit', { files: { 'x.txt': 'nested now\n' } });
  repo.nestedRepo('vendor/no-commit', { commit: false, files: { 'x.txt': 'nested now\n' } });
  const wt = repo.worktree('w1');
  repo.write('a.txt', 'a2\n');
  const later = await snap(shadow);
  assert.deepEqual(later.nested, ['.claude/worktrees/w1', 'vendor/no-commit', 'vendor/with-commit']);
  const nestedDigests = () => ['vendor/with-commit', 'vendor/no-commit'].map((d) => digestTree(path.join(repo.root, d))).concat([digestTree(wt)]);
  const before = nestedDigests();
  const digest = gitDirDigest(repo);
  const res = await restore.apply(earlier.tree);
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.deepEqual(res.notCovered, [
    { path: '.claude/worktrees/w1/x.txt', reason: 'nested-repo' },
    { path: 'vendor/no-commit/x.txt', reason: 'nested-repo' },
    { path: 'vendor/with-commit/x.txt', reason: 'nested-repo' },
  ]);
  assert.deepEqual(res.written, [{ path: 'a.txt', status: 'M' }]);
  assert.deepEqual(repo.read('a.txt'), Buffer.from('a1\n'));
  assert.deepEqual(nestedDigests(), before, 'nothing inside a nested repository or worktree was written');
  assert.deepEqual(gitDirDigest(repo), digest);
});

// ── refusals ────────────────────────────────────────────────────────────────

test('stale: a working tree changed after the preview is refused, nothing written, no safety ref', async (t) => {
  withTempHome(t);
  const repo = treesnapRepo(t, { files: { 'a.txt': 'a1\n', 'b.txt': 'b1\n' } });
  const { shadow, restore } = engineFor(repo);
  const earlier = await snap(shadow);
  repo.write('a.txt', 'a2\n');
  const pv = await restore.preview(earlier.tree);
  assert.equal(pv.ok, true);
  repo.write('b.txt', 'b2, after the preview\n');
  const res = await restore.apply(earlier.tree, { expect: pv.current_tree });
  assert.equal(res.ok, false);
  assert.equal(res.refused, 'stale');
  assert.deepEqual(repo.read('a.txt'), Buffer.from('a2\n'), 'nothing written');
  assert.deepEqual(repo.read('b.txt'), Buffer.from('b2, after the preview\n'));
  assert.deepEqual(await restore.safetyRefs(), []);
});

test('tree-missing (a tree pruned from the shadow), bad-tree, and an unknown restore id', async (t) => {
  withTempHome(t);
  const repo = treesnapRepo(t);
  const { shadow, restore } = engineFor(repo);
  repo.write('a.txt', 'only in the shadow\n');
  const s = await snap(shadow);
  repo.write('a.txt', 'alpha\n');
  // Prune the snapshot's tree (a loose object in the shadow).
  fs.rmSync(path.join(repo.shadow, 'objects', s.tree.slice(0, 2), s.tree.slice(2)));
  assert.deepEqual(await restore.preview(s.tree), { ok: false, refused: 'tree-missing' });
  assert.deepEqual(await restore.apply(s.tree), { ok: false, refused: 'tree-missing' });
  assert.deepEqual(await restore.apply('f'.repeat(40)), { ok: false, refused: 'tree-missing' });
  assert.deepEqual(await restore.apply('not a tree'), { ok: false, refused: 'bad-tree' });
  assert.deepEqual(await restore.undo('rs_zzzzzzz0000'), { ok: false, refused: 'unknown' });
  assert.deepEqual(await restore.undo('../../HEAD'), { ok: false, refused: 'unknown' });
  assert.deepEqual(await restore.undo(undefined), { ok: false, refused: 'unknown' });
  assert.deepEqual(repo.read('a.txt'), Buffer.from('alpha\n'));
});

test('features(): ok on a real git; git-too-old (2.39); not-a-git-repo on a plain directory; git-missing — and each refuses the actions', async (t) => {
  withTempHome(t);
  const repo = treesnapRepo(t);
  assert.deepEqual(await engineFor(repo).restore.features(), { ok: true });

  const old = hookedRunner({ features: async () => ({ version: '2.39.0', attrSource: false, missing: false }) });
  const tooOld = engineFor(repo, { runGit: old });
  assert.deepEqual(await tooOld.restore.features(), { ok: false, reason: 'git-too-old' });
  const s = await snap(tooOld.shadow);
  assert.deepEqual(await tooOld.restore.preview(s.tree), { ok: false, refused: 'git-too-old' });
  assert.deepEqual(await tooOld.restore.apply(s.tree), { ok: false, refused: 'git-too-old' });
  assert.deepEqual(await tooOld.restore.undo('rs_zzzzzzz0000'), { ok: false, refused: 'git-too-old' });

  const plain = fs.realpathSync(fs.mkdtempSync(path.join(SANDBOX, 'wc-plain-')));
  t.after(() => fs.rmSync(plain, { recursive: true, force: true }));
  const pp = projectPaths(plain);
  const ps = createShadowStore({ root: plain, paths: pp });
  assert.deepEqual(await createRestore({ root: plain, paths: pp, shadow: ps }).features(), { ok: false, reason: 'not-a-git-repo' });

  const none = createGitRunner({ bin: path.join(plain, 'no-such-git') });
  const ms = createShadowStore({ root: repo.root, paths: projectPaths(repo.root), runGit: none });
  assert.deepEqual(await createRestore({ root: repo.root, paths: projectPaths(repo.root), shadow: ms, runGit: none }).features(), { ok: false, reason: 'git-missing' });
  assert.throws(() => createRestore({ root: repo.root, paths: projectPaths(repo.root) }), TypeError);
});

// ── residuals ───────────────────────────────────────────────────────────────

test('a concurrent write between the write and the verify is a residual, and ok is false', async (t) => {
  withTempHome(t);
  const repo = treesnapRepo(t, { files: { 'a.txt': 'a1\n', 'b.txt': 'b1\n' } });
  let armed = false;
  const runner = hookedRunner({
    after: (args) => {
      if (armed && args.includes('checkout-index')) { armed = false; repo.write('a.txt', 'written by someone else\n'); }
    },
  });
  const { shadow, restore } = engineFor(repo, { runGit: runner });
  const earlier = await snap(shadow);
  repo.write('a.txt', 'a2\n');
  repo.write('b.txt', 'b2\n');
  armed = true;
  const res = await restore.apply(earlier.tree);
  assert.equal(armed, false, 'the hook ran');
  assert.equal(res.ok, false);
  assert.deepEqual(res.residual, [{ path: 'a.txt', reason: 'mismatch' }]);
  assert.deepEqual(repo.read('b.txt'), Buffer.from('b1\n'));
  // The safety ref is there: undo puts the pre-apply tree back.
  const un = await restore.undo(res.restore_id);
  assert.equal(un.ok, true, JSON.stringify(un));
  assert.deepEqual(repo.read('a.txt'), Buffer.from('a2\n'));
  assert.deepEqual(repo.read('b.txt'), Buffer.from('b2\n'));
});

test('an EACCES part way (a read-only directory) stops, reports residuals, and undo restores every file', { skip: process.getuid && process.getuid() === 0 ? 'root ignores directory modes' : false }, async (t) => {
  withTempHome(t);
  const repo = treesnapRepo(t, { files: { 'w.txt': 'w0\n' } });
  const { shadow, restore } = engineFor(repo);
  const earlier = await snap(shadow);
  repo.write('a-del.txt', 'a\n');
  repo.write('locked/f.txt', 'locked\n');
  repo.write('z-del.txt', 'z\n');
  repo.write('w.txt', 'w1\n');
  const later = await snap(shadow);
  fs.chmodSync(repo.abs('locked'), 0o555); // the fixture's cleanup opens it again
  const res = await restore.apply(earlier.tree);
  assert.equal(res.ok, false);
  assert.deepEqual(res.residual, [
    { path: 'w.txt', reason: 'mismatch' },
    { path: 'locked/f.txt', reason: 'error', code: 'EACCES' },
    { path: 'z-del.txt', reason: 'still-present' },
  ]);
  assert.equal(fs.existsSync(repo.abs('a-del.txt')), false, 'the deletion before the error happened');
  assert.deepEqual(repo.read('w.txt'), Buffer.from('w1\n'), 'nothing written after the error');
  fs.chmodSync(repo.abs('locked'), 0o755);
  const un = await restore.undo(res.restore_id);
  assert.equal(un.ok, true, JSON.stringify(un));
  assertMatches(repo, later.tree, ['a-del.txt', 'locked/f.txt', 'z-del.txt', 'w.txt'], 'undo');
});

// ── headMoved ───────────────────────────────────────────────────────────────

test('headMoved: a commit made after the target snapshot sets it when targetHead is passed', async (t) => {
  withTempHome(t);
  const repo = treesnapRepo(t);
  const { shadow, restore } = engineFor(repo);
  const earlier = await snap(shadow);
  assert.equal(earlier.head, repo.head());
  repo.write('a.txt', 'committed later\n');
  const moved = repo.commit('later');
  assert.equal((await restore.preview(earlier.tree, { targetHead: earlier.head })).headMoved, true);
  assert.equal((await restore.preview(earlier.tree, { targetHead: moved })).headMoved, false);
  assert.equal((await restore.preview(earlier.tree)).headMoved, false, 'no targetHead: not moved');
  assert.equal((await restore.preview(earlier.tree, { targetHead: null })).headMoved, true, 'null against a sha');
  const res = await restore.apply(earlier.tree, { targetHead: earlier.head });
  assert.equal(res.ok, true);
  assert.equal(res.headMoved, true);
  assert.equal(repo.head(), moved, 'HEAD is never moved');

  const unborn = treesnapRepo(t);
  unborn.git(['symbolic-ref', 'HEAD', 'refs/heads/never-born']);
  const u = engineFor(unborn);
  const us = await snap(u.shadow);
  assert.equal(us.head, null);
  assert.equal((await u.restore.preview(us.tree, { targetHead: null })).headMoved, false, 'both null');
});

// ── safety refs ─────────────────────────────────────────────────────────────

test('safety refs: the 21st apply leaves 20, newest first; git gc --prune=now in the shadow keeps every tree a ref names', async (t) => {
  withTempHome(t);
  const repo = treesnapRepo(t);
  const { shadow, restore } = engineFor(repo);
  const earlier = await snap(shadow);
  const ids = [];
  for (let i = 0; i < SAFETY_KEEP + 1; i++) {
    repo.write('iter.txt', `iteration ${i}\n`);
    const res = await restore.apply(earlier.tree);
    assert.equal(res.ok, true, JSON.stringify(res));
    ids.push(res.restore_id);
  }
  const refs = await restore.safetyRefs();
  assert.equal(refs.length, SAFETY_KEEP);
  assert.deepEqual(refs.map((r) => r.restore_id), ids.slice(1).reverse(), 'the oldest went; newest first');
  assert.equal(shadowGit(repo, ['for-each-ref', '--format=%(refname)', SAFETY_REF_PREFIX]).trim().split('\n').length, SAFETY_KEEP);
  shadowGit(repo, ['gc', '--prune=now', '--quiet']);
  for (const [i, r] of refs.entries()) {
    assert.deepEqual(repo.bytesAt(r.tree, 'iter.txt'), Buffer.from(`iteration ${SAFETY_KEEP - i}\n`), `${r.restore_id}'s tree survives gc`);
  }
  assert.deepEqual(await restore.undo(ids[0]), { ok: false, refused: 'unknown' }, 'the pruned one is gone');
  const un = await restore.undo(ids[ids.length - 1]);
  assert.equal(un.ok, true);
  assert.deepEqual(repo.read('iter.txt'), Buffer.from(`iteration ${SAFETY_KEEP}\n`));
});

// ── the measured restore ────────────────────────────────────────────────────

test('a restore of a tree the size of web-chat-dev\'s (WEB_CHAT_PERF=1 only)', { skip: process.env.WEB_CHAT_PERF === '1' ? false : 'set WEB_CHAT_PERF=1' }, async (t) => {
  withTempHome(t);
  const files = {};
  for (let i = 0; i < 600; i++) files[`src/d${i % 20}/f${i}.js`] = `module.exports = ${i};\n`;
  const repo = treesnapRepo(t, { files });
  const { shadow, restore } = engineFor(repo);
  const earlier = await snap(shadow);
  for (let i = 0; i < 40; i++) repo.write(`src/d${i % 20}/f${i}.js`, `module.exports = ${i + 1};\n`);
  await snap(shadow);
  const res = await restore.apply(earlier.tree);
  assert.equal(res.ok, true);
  t.diagnostic(`apply: ${res.written.length} written in ${res.duration_ms} ms`);
  assert.ok(res.duration_ms < 1000, `duration_ms ${res.duration_ms}`);
});
