// The composer's `@` file index (lib/server/project-files.js, spec §6.2, U57).
//
// What is pinned:
//   * git mode on a scratch repository (test-support/treesnap-fixture): tracked
//     and untracked files are offered; a .gitignore'd file, a dotenv, a key,
//     .web-chat/ entries, a symlink and a symlinked directory never are; the
//     one ls-files call goes through the git runner with the brief's argv and
//     options; source 'git';
//   * max-buffer → the same call with --cached only, truncated;
//   * not a repository (a non-zero exit, and real git in a plain directory)
//     and git missing (createGitRunner on a binary that is on no PATH): the
//     bounded walk — WALK_SKIP, the depth, the entry count, the time budget,
//     no link followed or listed; source 'walk';
//   * ranking: the six classes in order, every token must match, the shorter
//     path wins a tie, then path order; an empty query is shallowest first;
//   * the type filter at search time: only the candidates returned are
//     lstat()ed, a candidate replaced by a symlink after the build is skipped
//     and back-filled, bytes is the file's size, at most 4 × limit extra lstats;
//   * check(): every why code of §6.2, in its order; a file created after the
//     build is found after one rebuild, and a second miss does not rebuild
//     within the TTL;
//   * the TTL on an injected clock, one shared build for concurrent searches,
//     the module runner's queue (a build waits on runGit.exclusive);
//   * stop(): an in-flight build is aborted through the signal, a real git
//     child is gone, and a search after it answers no files.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { home: SANDBOX } = require('../test-support/sandbox');
const { treesnapRepo } = require('../test-support/treesnap-fixture');
const { runGit, createGitRunner, GitRunError } = require('../lib/server/git-run');
const {
  createProjectFiles, WALK_SKIP, TTL_MS, MAX_PATHS, WALK_MAX_DEPTH, WALK_MAX_ENTRIES, WALK_MAX_MS,
  Q_MAX, LIMIT_DEFAULT, LIMIT_MAX, SCORE, GIT_TIMEOUT_MS, GIT_MAX_BUFFER,
} = require('../lib/server/project-files');

const LS_ARGS = ['ls-files', '-z', '--cached', '--others', '--exclude-standard'];

// A plain directory (no repository) under the sandbox, removed after the test.
function plainDir(t, files = {}) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(SANDBOX, 'wc-files-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const [rel, data] of Object.entries(files)) writeAt(dir, rel, data);
  return dir;
}

function writeAt(dir, rel, data = '') {
  const p = path.join(dir, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, data);
}

// A runGit that answers `listing` (an array of paths, or a function of the
// call) and records every call.
function fakeGit(listing, { code = 0 } = {}) {
  const calls = [];
  const fn = async (args, opts) => {
    calls.push({ args, opts });
    const v = typeof listing === 'function' ? await listing(args, opts, calls.length) : listing;
    if (v && v.code !== undefined) return v;
    return { stdout: v.map((p) => `${p}\0`).join(''), stderr: '', code };
  };
  fn.calls = calls;
  return fn;
}

// A runGit that counts the calls it passes to the module runner.
function countingGit(inner = runGit) {
  const calls = [];
  const fn = (args, opts) => { calls.push(args); return inner(args, opts); };
  fn.calls = calls;
  return fn;
}

const pathsOf = (r) => r.files.map((f) => f.path);

// Count fs.promises.lstat calls (by absolute path) for the test's duration.
function spyLstat(t) {
  const seen = [];
  const orig = fs.promises.lstat;
  fs.promises.lstat = function (p, ...rest) { seen.push(String(p)); return orig.call(this, p, ...rest); };
  t.after(() => { fs.promises.lstat = orig; });
  return seen;
}

test('the limits and weights are the spec\'s', () => {
  assert.equal(TTL_MS, 15000);
  assert.equal(MAX_PATHS, 100000);
  assert.equal(WALK_MAX_DEPTH, 12);
  assert.equal(WALK_MAX_ENTRIES, 20000);
  assert.equal(WALK_MAX_MS, 1500);
  assert.equal(Q_MAX, 200);
  assert.equal(LIMIT_DEFAULT, 20);
  assert.equal(LIMIT_MAX, 50);
  assert.equal(GIT_TIMEOUT_MS, 5000);
  assert.equal(GIT_MAX_BUFFER, 32 * 1024 * 1024);
  assert.deepStrictEqual(SCORE, {
    EXACT_BASENAME: 100, BASENAME_PREFIX: 80, BASENAME_SUBSTRING: 60, SEGMENT_PREFIX: 40, PATH_SUBSTRING: 30, SUBSEQUENCE: 10,
  });
  assert.deepStrictEqual([...WALK_SKIP], ['.git', 'node_modules', '.web-chat', 'dist', 'build', 'out', '.next', '.nuxt',
    'target', '.venv', 'venv', '__pycache__', '.cache', 'coverage', '.turbo', '.parcel-cache']);
});

// ── git mode ────────────────────────────────────────────────────────────────

function gitFixture(t) {
  const repo = treesnapRepo(t, {
    files: { 'src/app.js': 'console.log(1);\n', 'README.md': '# hi\n', '.gitignore': 'debug.log\n' },
  });
  repo.write('notes/todo.md', 'todo\n');            // untracked
  repo.write('debug.log', 'ignored\n');            // ignored
  repo.write('.env', 'TOKEN=x\n');                  // dotenv
  repo.write('certs/a.pem', 'not a key\n');         // key
  repo.write('.web-chat/state.json', '{}\n');       // web-chat
  repo.symlink('link.js', 'src/app.js');            // a link to a file
  repo.symlink('linkdir', 'src');                   // a link to a directory
  return repo;
}

test('git mode: tracked and untracked files are offered; ignored, sensitive, .web-chat and links never are', async (t) => {
  const repo = gitFixture(t);
  const git = countingGit();
  const pf = createProjectFiles({ root: repo.root, runGit: git });
  t.after(() => pf.stop());
  const r = await pf.search('', { limit: LIMIT_MAX });
  assert.equal(r.source, 'git');
  assert.equal(r.truncated, false);
  assert.ok(Number.isFinite(r.indexed_at));
  assert.deepStrictEqual(pathsOf(r).sort(), ['.gitignore', 'README.md', 'notes/todo.md', 'src/app.js']);
  const app = r.files.find((f) => f.path === 'src/app.js');
  assert.equal(app.bytes, Buffer.byteLength('console.log(1);\n'));
  for (const q of ['debug', 'env', 'pem', 'state', 'link']) {
    assert.deepStrictEqual(pathsOf(await pf.search(q)), [], `q=${q}`);
  }
  assert.deepStrictEqual(git.calls, [['-C', repo.root, ...LS_ARGS]], 'one ls-files call, the brief\'s argv');
});

test('git mode: the call carries the timeout, the buffer and an abort signal', async (t) => {
  const dir = plainDir(t, { 'a.txt': 'a' });
  const git = fakeGit(['a.txt']);
  const pf = createProjectFiles({ root: dir, runGit: git });
  t.after(() => pf.stop());
  await pf.search('a');
  assert.equal(git.calls.length, 1);
  const { args, opts } = git.calls[0];
  assert.deepStrictEqual(args, ['-C', dir, ...LS_ARGS]);
  assert.equal(opts.timeoutMs, 5000);
  assert.equal(opts.maxBuffer, 32 * 1024 * 1024);
  assert.ok(opts.signal instanceof AbortSignal);
});

test('max-buffer: a second call with --cached only, and the answer says truncated', async (t) => {
  const dir = plainDir(t, { 'a.txt': 'a', 'b.txt': 'bb' });
  const git = fakeGit((args, opts, n) => {
    if (n === 1) throw new GitRunError('max-buffer', 'git: output exceeded maxBuffer');
    return ['a.txt'];
  });
  const pf = createProjectFiles({ root: dir, runGit: git });
  t.after(() => pf.stop());
  const r = await pf.search('');
  assert.equal(git.calls.length, 2);
  assert.deepStrictEqual(git.calls[1].args, ['-C', dir, 'ls-files', '-z', '--cached']);
  assert.ok(!git.calls[1].args.includes('--others'));
  assert.equal(r.truncated, true);
  assert.equal(r.source, 'git');
  assert.deepStrictEqual(pathsOf(r), ['a.txt']);
});

test('a git that times out keeps no walk: nothing ignored is offered in its place', async (t) => {
  const dir = plainDir(t, { 'a.txt': 'a' });
  const git = fakeGit(() => { throw new GitRunError('timeout', 'git: timed out'); });
  const pf = createProjectFiles({ root: dir, runGit: git });
  t.after(() => pf.stop());
  const r = await pf.search('');
  assert.deepStrictEqual(r.files, []);
  assert.equal(r.truncated, true);
  assert.equal(r.source, 'git');
});

// ── the walk ────────────────────────────────────────────────────────────────

function walkFixture(t) {
  const dir = plainDir(t, { 'a.txt': 'aaa', 'sub/d.txt': 'd', '.env': 'X=1', 'keys/id_rsa': 'k' });
  for (const name of WALK_SKIP) {
    if (name === '.git') continue; // a .git directory would make this a repository
    writeAt(dir, `${name}/skipped.txt`, 's');
  }
  writeAt(dir, 'deep/.git-not/x.txt', 'x');
  fs.symlinkSync(path.join(dir, 'sub'), path.join(dir, 'ln'));
  fs.symlinkSync(path.join(dir, 'a.txt'), path.join(dir, 'lf'));
  const outside = plainDir(t, { 'far.txt': 'far' });
  fs.symlinkSync(outside, path.join(dir, 'far-link'));
  return dir;
}

async function assertWalked(t, pf) {
  const r = await pf.search('', { limit: LIMIT_MAX });
  assert.equal(r.source, 'walk');
  assert.deepStrictEqual(pathsOf(r).sort(), ['a.txt', 'deep/.git-not/x.txt', 'sub/d.txt']);
  assert.equal(r.files.find((f) => f.path === 'a.txt').bytes, 3);
  assert.deepStrictEqual(pathsOf(await pf.search('far')), [], 'a symlinked directory is not followed');
  assert.deepStrictEqual(pathsOf(await pf.search('skipped')), [], 'WALK_SKIP directories are not entered');
}

test('not a repository (a non-zero exit): the walk runs', async (t) => {
  const dir = walkFixture(t);
  const git = fakeGit({ code: 128, stdout: '', stderr: 'fatal: not a git repository' });
  const pf = createProjectFiles({ root: dir, runGit: git });
  t.after(() => pf.stop());
  await assertWalked(t, pf);
});

test('not a repository, with the real git: the walk runs', async (t) => {
  const dir = walkFixture(t);
  const pf = createProjectFiles({ root: dir });
  t.after(() => pf.stop());
  await assertWalked(t, pf);
});

test('git missing (a binary on no PATH): the walk runs', async (t) => {
  const dir = walkFixture(t);
  const missing = createGitRunner({ bin: 'wc-no-such-git-binary-u57' });
  const pf = createProjectFiles({ root: dir, runGit: missing });
  t.after(() => pf.stop());
  await assertWalked(t, pf);
});

test('the walk stops at WALK_MAX_DEPTH path segments', async (t) => {
  const dir = plainDir(t);
  let rel = '';
  for (let i = 1; i <= WALK_MAX_DEPTH + 2; i++) {
    rel = rel ? `${rel}/d${i}` : `d${i}`;
    writeAt(dir, `${rel}/f${i}.txt`, 'f');
  }
  const pf = createProjectFiles({ root: dir, runGit: fakeGit({ code: 128, stdout: '', stderr: '' }) });
  t.after(() => pf.stop());
  const r = await pf.search('', { limit: LIMIT_MAX });
  const depths = pathsOf(r).map((p) => p.split('/').length);
  assert.equal(Math.max(...depths), WALK_MAX_DEPTH, 'the deepest listed path has WALK_MAX_DEPTH segments');
  assert.equal(r.files.length, WALK_MAX_DEPTH - 1);
  assert.equal(r.truncated, true);
});

test('the walk reads at most WALK_MAX_ENTRIES entries', async (t) => {
  const dir = plainDir(t);
  for (let i = 0; i < 40; i++) writeAt(dir, `many/f${String(i).padStart(2, '0')}.txt`, 'x');
  const pf = createProjectFiles({ root: dir, runGit: fakeGit({ code: 128, stdout: '', stderr: '' }),
    limits: { WALK_MAX_ENTRIES: 25 } });
  t.after(() => pf.stop());
  const r = await pf.search('', { limit: LIMIT_MAX });
  assert.equal(r.files.length, 24, 'the root\'s one entry and 24 of the directory\'s');
  assert.equal(r.truncated, true);
});

test('the walk stops at WALK_MAX_MS on its clock', async (t) => {
  const dir = plainDir(t);
  for (let i = 0; i < 10; i++) writeAt(dir, `f${i}.txt`, 'x');
  let clock = 0;
  const now = () => { clock += 1000; return clock; };
  const pf = createProjectFiles({ root: dir, runGit: fakeGit({ code: 128, stdout: '', stderr: '' }), now, ttlMs: 1e12 });
  t.after(() => pf.stop());
  const r = await pf.search('', { limit: LIMIT_MAX });
  assert.ok(r.files.length < 10, `stopped early (${r.files.length})`);
  assert.equal(r.truncated, true);
});

test('at most MAX_PATHS paths are kept', async (t) => {
  const names = Array.from({ length: 30 }, (_, i) => `f${String(i).padStart(2, '0')}.txt`);
  const dir = plainDir(t, Object.fromEntries(names.map((n) => [n, 'x'])));
  const pf = createProjectFiles({ root: dir, runGit: fakeGit(names), limits: { MAX_PATHS: 10 } });
  t.after(() => pf.stop());
  const r = await pf.search('', { limit: LIMIT_MAX });
  assert.equal(r.files.length, 10);
  assert.equal(r.truncated, true);
});

// ── ranking ─────────────────────────────────────────────────────────────────

async function ranked(t, names, q, limit = LIMIT_MAX) {
  const dir = plainDir(t, Object.fromEntries(names.map((n) => [n, 'x'])));
  const pf = createProjectFiles({ root: dir, runGit: fakeGit(names) });
  t.after(() => pf.stop());
  return pathsOf(await pf.search(q, { limit }));
}

test('ranking: exact basename > basename prefix > basename substring > segment prefix > path substring > subsequence', async (t) => {
  const order = ['x/app', 'x/apple.txt', 'x/snapp.txt', 'apps/z.txt', 'happy/z1.txt', 'a/p/p.txt'];
  const shuffled = [order[3], order[5], 'zzz.txt', order[0], order[4], order[2], order[1]];
  assert.deepStrictEqual(await ranked(t, shuffled, 'APP'), order, 'case-insensitive, by class');
});

test('ranking: a two-token query needs both tokens', async (t) => {
  assert.deepStrictEqual(await ranked(t, ['src/app.js', 'lib/app.js', 'src/main.js'], 'src  app'), ['src/app.js']);
});

test('ranking: a longer path loses a tie, and equal scores go by path', async (t) => {
  assert.deepStrictEqual(await ranked(t, ['abc/foo.js', 'b/foo.js', 'a/foo.js'], 'foo.js'), ['a/foo.js', 'b/foo.js', 'abc/foo.js']);
});

test('ranking: an empty query answers the shallowest paths', async (t) => {
  assert.deepStrictEqual(await ranked(t, ['a/b/c.txt', 'z.txt', 'a/b.txt', 'm.txt'], ''), ['m.txt', 'z.txt', 'a/b.txt', 'a/b/c.txt']);
  assert.deepStrictEqual(await ranked(t, ['a/b/c.txt', 'z.txt', 'a/b.txt', 'm.txt'], '   ', 2), ['m.txt', 'z.txt']);
});

// ── the type filter at search time ──────────────────────────────────────────

test('search lstats only what it returns; a candidate replaced by a symlink is skipped and back-filled', async (t) => {
  const names = ['f1.txt', 'f2.txt', 'f3.txt', 'f4.txt', 'f5.txt', 'f6.txt'];
  const dir = plainDir(t, Object.fromEntries(names.map((n, i) => [n, 'x'.repeat(i + 1)])));
  const pf = createProjectFiles({ root: dir, runGit: fakeGit(names) });
  t.after(() => pf.stop());
  await pf.refresh();
  const seen = spyLstat(t);
  const r = await pf.search('f', { limit: 2 });
  assert.deepStrictEqual(r.files, [{ path: 'f1.txt', bytes: 1 }, { path: 'f2.txt', bytes: 2 }]);
  assert.deepStrictEqual(seen.map((p) => path.basename(p)), ['f1.txt', 'f2.txt'], 'only the two it returned');

  // f1 becomes a link after the build: skipped, f3 back-fills it.
  fs.rmSync(path.join(dir, 'f1.txt'));
  fs.symlinkSync(path.join(dir, 'f6.txt'), path.join(dir, 'f1.txt'));
  seen.length = 0;
  const r2 = await pf.search('f', { limit: 2 });
  assert.deepStrictEqual(r2.files, [{ path: 'f2.txt', bytes: 2 }, { path: 'f3.txt', bytes: 3 }]);
  assert.deepStrictEqual(seen.map((p) => path.basename(p)), ['f1.txt', 'f2.txt', 'f3.txt']);
});

test('search spends at most 4 × limit extra lstats', async (t) => {
  const names = Array.from({ length: 12 }, (_, i) => `d${String(i).padStart(2, '0')}`);
  const dir = plainDir(t);
  for (const n of names) fs.mkdirSync(path.join(dir, n));
  const pf = createProjectFiles({ root: dir, runGit: fakeGit(names) });
  t.after(() => pf.stop());
  await pf.refresh();
  const seen = spyLstat(t);
  const r = await pf.search('d', { limit: 2 });
  assert.deepStrictEqual(r.files, [], 'a directory is never offered');
  assert.equal(seen.length, 2 + 4 * 2);
});

// ── check ───────────────────────────────────────────────────────────────────

test('check: every why code, in §6.2\'s order', async (t) => {
  const repo = gitFixture(t);
  repo.write('real.txt', 'ok');
  const outside = plainDir(t, { 'x.txt': 'x' });
  fs.symlinkSync(outside, path.join(repo.root, 'escape'));
  const pf = createProjectFiles({ root: repo.root });
  t.after(() => pf.stop());
  const outsides = ['../x', '/etc/passwd', 'a\\b', 'a\0b', 'a\u0001b', 'a\u007fb', '', 42, null, 'escape/x.txt', 'src/../../x'];
  for (const p of outsides) assert.deepStrictEqual(await pf.check(p), { ok: false, why: 'outside' }, JSON.stringify(p));
  assert.deepStrictEqual(await pf.check('.env'), { ok: false, why: 'sensitive', category: 'dotenv' });
  assert.deepStrictEqual(await pf.check('certs/a.pem'), { ok: false, why: 'sensitive', category: 'key' });
  assert.deepStrictEqual(await pf.check('.web-chat/state.json'), { ok: false, why: 'sensitive', category: 'web-chat' });
  assert.deepStrictEqual(await pf.check('.git/config'), { ok: false, why: 'sensitive', category: 'git' });
  assert.deepStrictEqual(await pf.check('link.js'), { ok: false, why: 'symlink' });
  assert.deepStrictEqual(await pf.check('linkdir/app.js'), { ok: false, why: 'symlink' }, 'a link on the way');
  assert.deepStrictEqual(await pf.check('src'), { ok: false, why: 'not-a-file' });
  assert.deepStrictEqual(await pf.check('nope.txt'), { ok: false, why: 'missing' });
  assert.deepStrictEqual(await pf.check('debug.log'), { ok: false, why: 'ignored' });
  assert.deepStrictEqual(await pf.check('src/app.js'), { ok: true, path: 'src/app.js', bytes: 16 });
  assert.deepStrictEqual(await pf.check('real.txt'), { ok: true, path: 'real.txt', bytes: 2 });
});

test('check: a file created after the build is found after one rebuild; a second miss does not rebuild', async (t) => {
  const repo = gitFixture(t);
  const git = countingGit();
  const pf = createProjectFiles({ root: repo.root, runGit: git });
  t.after(() => pf.stop());
  await pf.search('');
  assert.equal(git.calls.length, 1);
  repo.write('fresh.txt', 'new');
  assert.deepStrictEqual(await pf.check('fresh.txt'), { ok: true, path: 'fresh.txt', bytes: 3 });
  assert.equal(git.calls.length, 2, 'one rebuild for the miss');
  assert.deepStrictEqual(await pf.check('fresh.txt'), { ok: true, path: 'fresh.txt', bytes: 3 });
  assert.equal(git.calls.length, 2, 'a hit rebuilds nothing');

  assert.deepStrictEqual(await pf.check('debug.log'), { ok: false, why: 'ignored' });
  assert.equal(git.calls.length, 3, 'the first miss rebuilds once');
  assert.deepStrictEqual(await pf.check('debug.log'), { ok: false, why: 'ignored' });
  assert.equal(git.calls.length, 3, 'a second miss within the TTL does not');
});

test('check before any search builds once and does not rebuild for its own miss', async (t) => {
  const repo = gitFixture(t);
  const git = countingGit();
  const pf = createProjectFiles({ root: repo.root, runGit: git });
  t.after(() => pf.stop());
  assert.deepStrictEqual(await pf.check('debug.log'), { ok: false, why: 'ignored' });
  assert.equal(git.calls.length, 1);
});

// ── the TTL, sharing, the queue ─────────────────────────────────────────────

test('TTL: a search older than ttlMs rebuilds once', async (t) => {
  const dir = plainDir(t, { 'a.txt': 'a' });
  let clock = 1_000_000;
  const git = fakeGit(['a.txt']);
  const pf = createProjectFiles({ root: dir, runGit: git, now: () => clock, ttlMs: 1000 });
  t.after(() => pf.stop());
  const r1 = await pf.search('a');
  assert.equal(git.calls.length, 1);
  assert.equal(r1.indexed_at, 1_000_000);
  clock += 1000;
  await pf.search('a');
  assert.equal(git.calls.length, 1, 'at the TTL, still fresh');
  clock += 1;
  const r2 = await pf.search('a');
  assert.equal(git.calls.length, 2, 'older than the TTL: one rebuild');
  assert.equal(r2.indexed_at, 1_001_001);
  await pf.search('a');
  assert.equal(git.calls.length, 2);
});

test('two concurrent searches share one build', async (t) => {
  const dir = plainDir(t, { 'a.txt': 'a', 'b.txt': 'b' });
  const git = fakeGit(['a.txt', 'b.txt']);
  const pf = createProjectFiles({ root: dir, runGit: git });
  t.after(() => pf.stop());
  const [r1, r2] = await Promise.all([pf.search('a'), pf.search('b'), pf.refresh()]);
  assert.equal(git.calls.length, 1);
  assert.deepStrictEqual(pathsOf(r1), ['a.txt']);
  assert.deepStrictEqual(pathsOf(r2), ['b.txt']);
});

test('the shared queue: while runGit.exclusive holds the slot, a build waits', async (t) => {
  const repo = gitFixture(t);
  const pf = createProjectFiles({ root: repo.root }); // the module runner
  t.after(() => pf.stop());
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  let entered;
  const inSlot = new Promise((resolve) => { entered = resolve; });
  const slot = runGit.exclusive(async () => { entered(); await held; });
  await inSlot;
  let settled = false;
  const search = pf.search('app').then((r) => { settled = true; return r; });
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(settled, false, 'the build is queued behind the held slot');
  release();
  await slot;
  const r = await search;
  assert.deepStrictEqual(pathsOf(r), ['src/app.js']);
});

// ── stop ────────────────────────────────────────────────────────────────────

test('stop(): an in-flight build is aborted through the signal; a search after it answers no files', async (t) => {
  const dir = plainDir(t, { 'a.txt': 'a' });
  let signal;
  const git = fakeGit((args, opts) => {
    signal = opts.signal;
    return new Promise((resolve, reject) => {
      opts.signal.addEventListener('abort', () => reject(new GitRunError('aborted', 'git: aborted')), { once: true });
    });
  });
  const pf = createProjectFiles({ root: dir, runGit: git });
  const pending = pf.search('a');
  await Promise.resolve();
  assert.equal(git.calls.length, 1);
  pf.stop();
  assert.equal(signal.aborted, true);
  assert.deepStrictEqual((await pending).files, []);
  assert.deepStrictEqual((await pf.search('a')).files, []);
  assert.deepStrictEqual(await pf.check('a.txt'), { ok: false, why: 'missing' });
  await pf.refresh();
  assert.equal(git.calls.length, 1, 'nothing runs after stop()');
});

test('stop(): a real git child is killed and the search settles', async (t) => {
  const dir = plainDir(t, { 'a.txt': 'a' });
  const bin = path.join(dir, 'slow-git');
  fs.writeFileSync(bin, '#!/bin/sh\nexec sleep 30\n', { mode: 0o755 });
  const slow = createGitRunner({ bin });
  const pf = createProjectFiles({ root: dir, runGit: slow });
  const pending = pf.search('a');
  await new Promise((resolve) => setTimeout(resolve, 100));
  const started = Date.now();
  pf.stop();
  const r = await pending;
  assert.deepStrictEqual(r.files, []);
  assert.ok(Date.now() - started < 10000, 'settled long before the child\'s 30 s');
});

test('stop() ends a walk', async (t) => {
  const dir = plainDir(t);
  for (let i = 0; i < 50; i++) writeAt(dir, `d${i}/f.txt`, 'x');
  const pf = createProjectFiles({ root: dir, runGit: fakeGit({ code: 128, stdout: '', stderr: '' }) });
  const pending = pf.search('');
  pf.stop();
  assert.deepStrictEqual((await pending).files, []);
});
