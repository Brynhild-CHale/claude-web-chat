// Per-turn code diffs (lib/server/mirror/codediff.js, spec §2.7, Q-D): the
// shadow store's snapshots and diffs, and the codediff source on a real
// createMirror fed hook envelopes.
//
// Pinned, on scratch repositories in the sandbox (git init with a fixed
// -c user.name / user.email and commit.gpgsign=false, never the developer's
// config — HOME is a throwaway, and the repositories are built by the small
// private builder below, ruling U43-U79@fixture-builder):
//   * a snapshot leaves every file under .git byte-identical; the shadow's
//     at and duration_ms start in its held slot, so time queued behind
//     other git work never marks it slow;
//     alternates line is relative; a sha256 repository snapshots too;
//   * Q-D fix 1: a same-second same-size edit is captured — the blob equals the
//     file's bytes — and with limits.keepIndexTimes: false it is missed (the
//     regression the fix closes);
//   * Q-D fix 2: under `*.txt text eol=crlf` a CRLF+LF file is stored byte for
//     byte, also with core.autocrlf=true in HOME's .gitconfig;
//   * a git without --attr-source (features() says 2.39, real git underneath):
//     no call carries it, init passes no --object-format on a sha1 project nor
//     when --show-object-format fails, and the record says attr_exact: false;
//   * a root below the toplevel: inside captured, outside in no record, through
//     add, diff-tree and ls-files alike; .web-chat/ is never in a tree;
//   * an untracked .env never enters the shadow store, and a turn that changes
//     it lists it withheld 'sensitive' with no counts; a tracked sensitive file
//     is withheld with its counts and no hunk; a large untracked file is
//     excluded and listed;
//   * the source: code pending → ready with its totals, the record on disk in
//     §2.7's shape with a fake key masked in the file itself, the bar's last
//     turn reading the totals at once, mirror.diff({turn}) through the facade
//     with host paths masked; no tool → no record and code null; a catch-up
//     turn is never snapshotted; outside and returned_to; concurrent_sessions;
//     before_racy (Edit sets it, WebFetch does not); the guards; not a
//     repository and git missing; lazy init; WEB_CHAT_MIRROR_DIFFS=0; node
//     diffs and their cache; stop() during a snapshot; a restart.
//   * the before (ruling U43@before-snapshot-timing): a snapshot in flight under
//     REUSE_MS serves a second turn's before; a failed one falls back to the
//     previous after-tree (previous-turn-close); a sensitive name holding glob
//     characters is still excluded (its exclude line escaped).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { home: SANDBOX } = require('../test-support/sandbox');
const { claudeHome } = require('../test-support/claude-home');
const { withTempHome, waitUntil } = require('../test-support/helpers');
const { fakeSecrets, findLeaks } = require('../test-support/fake-secrets');
const { createRedactor } = require('../lib/core/redact');
const { createBus } = require('../lib/core/bus');
const { projectPaths } = require('../lib/core/paths');
const { createHookTap } = require('../lib/server/hook-tap');
const { createMirror, SOURCES } = require('../lib/server/mirror');
const { runGit, createGitRunner, GitRunError } = require('../lib/server/git-run');
const {
  createShadowStore, createCodediffSource, LIMITS, READ_ONLY_KINDS,
} = require('../lib/server/mirror/codediff');

const S1 = '11111111-1111-4111-8111-111111111111';
const S2 = '22222222-2222-4222-8222-222222222222';
const LIVE_ONLY = SOURCES.filter((s) => s.name === 'live');

// ── the scratch-repository builder (private to this file) ────────────────────

const GIT_ID = ['-c', 'user.name=wc-test', '-c', 'user.email=wc-test@example.com', '-c', 'commit.gpgsign=false', '-c', 'init.defaultBranch=main'];

function gitIn(cwd, args, opts = {}) {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith('GIT_')) delete env[k];
  return execFileSync('git', [...GIT_ID, ...args], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], ...opts });
}

// files: {rel: content}; returns {top, root, git, write, read}.
function scratchRepo(t, { files = { 'a.txt': 'alpha\n' }, sub = '', objectFormat = null, webChat = true } = {}) {
  const top = fs.realpathSync(fs.mkdtempSync(path.join(SANDBOX, 'wc-codediff-')));
  t.after(() => fs.rmSync(top, { recursive: true, force: true }));
  gitIn(top, ['init', '-q', ...(objectFormat ? [`--object-format=${objectFormat}`] : [])]);
  const write = (rel, data) => {
    const p = path.join(top, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, data);
  };
  for (const [rel, data] of Object.entries(files)) write(rel, data);
  gitIn(top, ['add', '-A']);
  gitIn(top, ['commit', '-q', '-m', 'init']);
  const root = sub ? path.join(top, sub) : top;
  fs.mkdirSync(root, { recursive: true });
  if (webChat) fs.mkdirSync(path.join(root, '.web-chat'), { recursive: true });
  return {
    top,
    root,
    git: (args, opts) => gitIn(top, args, opts),
    write,
    read: (rel) => fs.readFileSync(path.join(top, rel)),
  };
}

// sha256 of every file under dir, by relative path.
function digestTree(dir) {
  const out = {};
  const walk = (d) => {
    for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, ent.name);
      if (ent.isDirectory()) walk(p);
      else if (ent.isFile()) out[path.relative(dir, p)] = crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
    }
  };
  walk(dir);
  return out;
}

// The bytes a tree holds at a toplevel-relative path, from the shadow.
async function blobAt(store, tree, topRel) {
  const r = await runGit(['cat-file', 'blob', `${tree}:${topRel}`], { env: { GIT_DIR: store.info().shadow }, encoding: 'buffer' });
  return r.code === 0 ? r.stdout : null;
}
async function treePaths(store, tree) {
  const r = await runGit(['ls-tree', '-r', '--name-only', '-z', tree], { env: { GIT_DIR: store.info().shadow } });
  return r.stdout.split('\0').filter(Boolean);
}
async function inShadow(store, id) {
  const r = await runGit(['cat-file', '-e', id], { env: { GIT_DIR: store.info().shadow } });
  return r.code === 0;
}

const storeFor = (repo, opts = {}) => createShadowStore({ root: repo.root, paths: projectPaths(repo.root), ...opts });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Wait until the wall clock is just past a second boundary.
async function nextSecond(after = 15) {
  await sleep(1000 - (Date.now() % 1000) + after);
}

// A runner over the real one: records every call, can answer some calls itself
// (`answer(args, opts)` → a result or undefined) and can delay some
// (`delay(args, opts)` → a promise or undefined), inside held slots too.
function wrapRunner(real = runGit, { features, answer, delay } = {}) {
  const calls = [];
  const wrap = (fn) => async (args, opts = {}) => {
    calls.push({ args, opts });
    if (delay) { const d = delay(args, opts); if (d) await d; }
    if (answer) { const a = answer(args, opts); if (a) return a; }
    return fn(args, opts);
  };
  const r = wrap(real);
  r.exclusive = (fn) => real.exclusive((git) => fn(wrap(git)));
  r.features = features || (() => real.features());
  r.calls = calls;
  return r;
}

// ── the mirror harness ───────────────────────────────────────────────────────

// A real createMirror over the repository's root with `live`, the codediff
// source and a probe source that hands the test the engine (for synchronous
// reads of the model). Envelopes go in through mirror.ingest.
async function mirrorOn(t, repo, { source = {}, graph = null, root = repo.root, start = true } = {}) {
  withTempHome(t);
  const ch = claudeHome(t, { root, isolate: true });
  const hooks = createHookTap();
  const mainBus = createBus();
  const mirrorBus = createBus({ maxEvents: 2000 });
  const frames = [];
  mirrorBus.setBroadcaster((f) => frames.push(f));
  const redactor = createRedactor();
  const logs = [];
  const box = { engine: null };
  const probe = { name: 'probe', attach: (engine) => { box.engine = engine; return { start: async () => {}, stop: async () => {} }; } };
  const mirror = createMirror({
    root, hooks, mainBus, mirrorBus, redactor, graph, log: (...a) => logs.push(a.join(' ')),
    sampleProcs: async (pids) => new Map(pids.map((p) => [p, { alive: true, startedAt: null, cpuMs: 0, state: 'S' }])),
    sources: [...LIVE_ONLY, { name: 'codediff', attach: createCodediffSource(source).attach }, probe],
  });
  t.after(() => mirror.stop());
  if (start) await mirror.start();
  let tick = 0;
  const h = { repo, ch, mirror, frames, logs, box, root };
  h.env = (event, extra = {}, sid = S1) => ({
    v: 1, event, ts: Date.now() + (tick++ % 2), session_id: sid, transcript_path: ch.transcript(sid), cwd: ch.cwd,
    prompt_id: null, claude_pid: null, entrypoint: 'cli', permission_mode: 'default', agent: null, tool: null,
    result: null, session: null, compact: null, stop: null, prompt: null, ask: null, ...extra,
  });
  h.send = (event, extra, sid) => mirror.ingest(h.env(event, extra, sid));
  h.session = (sid = S1) => h.send('SessionStart', { session: { source: 'startup' } }, sid);
  h.prompt = (pid, sid = S1, extra = {}) => h.send('UserPromptSubmit', { prompt_id: pid, prompt: { author: 'user', text: `prompt ${pid}` }, ...extra }, sid);
  h.tool = (event, name, kind, useId, sid = S1) => h.send(event, {
    tool: { name, kind, use_id: useId, label: name, call: name, input: {}, input_hash: `h-${useId}` },
    ...(event === 'PreToolUse' ? {} : { result: { ok: true, duration_ms: 3, interrupted: false, error: null, fields: {} } }),
  }, sid);
  h.stop = (sid = S1) => h.send('Stop', { stop: { last_assistant_message: 'Done.', agent_transcript_path: null, background_tasks: [], error: null } }, sid);
  h.turn = (id) => h.box.engine.model.turn(h.box.engine.model.resolveTurn(id) || id);
  h.diag = () => h.mirror.snapshot({ level: 'local' }).diagnostics.git;
  h.snapshots = (n) => waitUntil(() => h.diag() && h.diag().snapshots >= n, { timeout: 20000, what: `${n} snapshot(s)` });
  h.settled = (id) => waitUntil(() => {
    const c = h.turn(id) && h.turn(id).code;
    return c && c.status !== 'pending' ? c : null;
  }, { timeout: 20000, what: `turn ${id}'s code` });
  h.record = (id) => JSON.parse(fs.readFileSync(projectPaths(root).mirrorDiff(id), 'utf8'));
  // One whole turn: open, wait for the before, run `edit` between a PreToolUse
  // and its PostToolUse, stop, and wait for the code to settle.
  h.run = async (id, edit, { sid = S1, name = 'Edit', kind = 'Edit', waitBefore = true } = {}) => {
    const before = h.diag() ? h.diag().snapshots : 0;
    h.prompt(id, sid);
    if (waitBefore) await h.snapshots(before + 1);
    h.tool('PreToolUse', name, kind, `tu-${id}`, sid);
    if (edit) await edit();
    h.tool('PostToolUse', name, kind, `tu-${id}`, sid);
    h.stop(sid);
    return h.settled(id);
  };
  return h;
}

// ── the shadow store ─────────────────────────────────────────────────────────

test('a snapshot leaves every file under .git byte-identical, and the alternates line is relative', async (t) => {
  withTempHome(t);
  const repo = scratchRepo(t, { files: { 'a.txt': 'alpha\n', 'lib/b.js': 'module.exports = 1;\n' } });
  repo.write('a.txt', 'alpha two\n');
  repo.write('new.txt', 'new\n');
  const before = digestTree(path.join(repo.top, '.git'));
  const store = storeFor(repo);
  const a = await store.snapshot();
  assert.equal(a.ok, true, JSON.stringify(a));
  repo.write('lib/b.js', 'module.exports = 2;\n');
  const b = await store.snapshot();
  const d = await store.diff(a.tree, b.tree);
  assert.equal(d.ok, true);
  assert.deepEqual(digestTree(path.join(repo.top, '.git')), before, 'the project .git (index, HEAD, refs, objects, config) is untouched');
  const alt = fs.readFileSync(path.join(store.info().shadow, 'objects', 'info', 'alternates'), 'utf8').trim();
  assert.ok(!path.isAbsolute(alt) && alt.startsWith('..'), `relative alternates (${alt})`);
  assert.deepEqual(fs.readdirSync(projectPaths(repo.root).mirrorTmp), [], 'the index copy is gone');
  assert.deepEqual(await blobAt(store, b.tree, 'new.txt'), Buffer.from('new\n'));
});

test('a sha256 repository snapshots too, into a sha256 shadow', async (t) => {
  withTempHome(t);
  const repo = scratchRepo(t, { objectFormat: 'sha256' });
  repo.write('a.txt', 'beta\n');
  const store = storeFor(repo);
  const s = await store.snapshot();
  assert.equal(s.ok, true, JSON.stringify(s));
  assert.equal(store.info().objectFormat, 'sha256');
  assert.equal(s.tree.length, 64);
  assert.deepEqual(await blobAt(store, s.tree, 'a.txt'), Buffer.from('beta\n'));
  const head = repo.git(['rev-parse', 'HEAD^{tree}']).toString().trim();
  const d = await store.diff(head, s.tree);
  assert.deepEqual(d.files.map((f) => [f.path, f.status, f.additions, f.deletions]), [['a.txt', 'M', 1, 1]]);
});

test('a snapshot inside a slot the caller holds (U79\'s restore) initialises through that slot, no deadlock', async (t) => {
  withTempHome(t);
  const repo = scratchRepo(t);
  repo.write('a.txt', 'held\n');
  const store = storeFor(repo);
  const s = await runGit.exclusive((git) => store.snapshot({ git }));
  assert.equal(s.ok, true, JSON.stringify(s));
  assert.deepEqual(await blobAt(store, s.tree, 'a.txt'), Buffer.from('held\n'));
});

test('a snapshot queued behind slow git work is not marked slow: at and duration_ms start in its held slot', async (t) => {
  withTempHome(t);
  const repo = scratchRepo(t);
  // A private queue whose diff-tree holds the slot until the test lets it go,
  // and moves the store's clock past SLOW_SNAPSHOT_MS while it holds it.
  // The guard's threshold, injected small: the source marks a snapshot slow
  // when its duration_ms is over SLOW_SNAPSHOT_MS.
  const SLOW = 1000;
  let clock = 1e12;
  const base = createGitRunner();
  let started = false;
  let release = null;
  const gate = new Promise((r) => { release = r; });
  const slowDiff = Object.assign((args, opts) => (args.includes('diff-tree')
    ? base.exclusive(async (git) => { started = true; await gate; clock += 5 * SLOW; return git(args, opts); })
    : base(args, opts)), { exclusive: base.exclusive, features: base.features });
  const runner = wrapRunner(slowDiff);
  const store = storeFor(repo, { runGit: runner, now: () => clock });
  const first = await store.snapshot();
  assert.equal(first.ok, true, JSON.stringify(first));
  const d = store.diff(first.tree, first.tree);
  await waitUntil(() => started, { timeout: 10000, what: 'the diff-tree slot' });
  const queued = store.snapshot();
  await sleep(50);
  assert.equal(runner.calls.filter((c) => c.args.includes('write-tree')).length, 1, 'the second snapshot waits for the slot');
  release();
  assert.equal((await d).ok, true);
  const s = await queued;
  assert.equal(s.ok, true, JSON.stringify(s));
  assert.ok(s.duration_ms <= SLOW, `not slow: duration_ms ${s.duration_ms}`);
  assert.equal(s.at, clock, 'at is the start of the held slot');
});

test('Q-D fix 1: a same-second same-size edit is captured byte for byte; without the index times it is missed', async (t) => {
  withTempHome(t);
  const repo = scratchRepo(t, { files: { 'a.txt': 'aaaa\n' } });
  await nextSecond();
  // Within one second: an edit the index caches, then a same-size edit.
  repo.write('a.txt', 'cccc\n');
  repo.git(['add', 'a.txt']);
  repo.write('a.txt', 'dddd\n');
  await nextSecond(60);
  const kept = storeFor(repo);
  const s = await kept.snapshot();
  assert.equal(s.ok, true, JSON.stringify(s));
  assert.deepEqual(await blobAt(kept, s.tree, 'a.txt'), repo.read('a.txt'), 'the blob is the bytes on disk');
  const fresh = storeFor(repo, { limits: { keepIndexTimes: false } });
  const m = await fresh.snapshot();
  assert.equal(m.ok, true);
  assert.deepEqual(await blobAt(fresh, m.tree, 'a.txt'), Buffer.from('cccc\n'), 'a fresh mtime on the copy hides the edit (the regression)');
});

test('Q-D fix 2: under text eol=crlf a CRLF+LF file is stored byte for byte, also with core.autocrlf=true', async (t) => {
  const home = withTempHome(t);
  const repo = scratchRepo(t, { files: { '.gitattributes': '*.txt text eol=crlf\n', 'm.txt': 'one\n' } });
  const bytes = Buffer.from('first\r\nsecond\nthird\r\nfourth\n');
  repo.write('m.txt', bytes);
  const s1 = await storeFor(repo).snapshot();
  assert.equal(s1.ok, true);
  const st1 = storeFor(repo);
  const r1 = await st1.snapshot();
  assert.deepEqual(await blobAt(st1, r1.tree, 'm.txt'), bytes);
  fs.writeFileSync(path.join(home, '.gitconfig'), '[core]\n\tautocrlf = true\n');
  repo.write('m.txt', Buffer.from('first\r\nsecond\nthird\r\nfifth\n'));
  const st2 = storeFor(repo);
  const r2 = await st2.snapshot();
  assert.equal(r2.ok, true);
  assert.deepEqual(await blobAt(st2, r2.tree, 'm.txt'), repo.read('m.txt'), 'the user\'s autocrlf converts nothing');
  // And the diff reads the same bytes back.
  const d = await st2.diff(r1.tree, r2.tree);
  assert.match(d.files[0].patch, /-fourth\n\+fifth\n/);
});

test('a root below the toplevel: inside captured, outside in no answer, through add, diff-tree and ls-files', async (t) => {
  withTempHome(t);
  const repo = scratchRepo(t, { files: { 'sub/in.txt': 'in\n', 'out.txt': 'out\n' }, sub: 'sub' });
  const store = storeFor(repo);
  const a = await store.snapshot();
  assert.equal(a.ok, true, JSON.stringify(a));
  assert.equal(store.info().prefix, 'sub/');
  repo.write('sub/in.txt', 'in two\n');
  repo.write('out.txt', 'out two\n');
  repo.write('sub/fresh.txt', 'fresh\n');
  repo.write('stray.txt', 'stray\n');
  // The process's own cwd at the root, as a daemon's may be.
  const prev = process.cwd();
  process.chdir(repo.root);
  t.after(() => process.chdir(prev));
  const b = await store.snapshot();
  const paths = await treePaths(store, b.tree);
  assert.ok(paths.includes('sub/fresh.txt'), 'an untracked file inside the root is listed and stored');
  assert.ok(!paths.includes('stray.txt'), 'an untracked file outside is not');
  assert.deepEqual(await blobAt(store, b.tree, 'sub/in.txt'), Buffer.from('in two\n'));
  assert.deepEqual(await blobAt(store, b.tree, 'out.txt'), Buffer.from('out\n'), 'outside the root the tree keeps the index\'s entry');
  const d = await store.diff(a.tree, b.tree);
  assert.deepEqual(d.files.map((f) => f.path).sort(), ['fresh.txt', 'in.txt'], 'paths are root-relative, and nothing outside appears');
});

test('.web-chat/ is never in a tree, untracked or tracked', async (t) => {
  withTempHome(t);
  const repo = scratchRepo(t, { files: { 'a.txt': 'a\n', '.web-chat/tracked.json': '{}\n' } });
  repo.write('.web-chat/untracked.json', '{"x":1}\n');
  const store = storeFor(repo);
  const s = await store.snapshot();
  assert.equal(s.ok, true);
  const paths = await treePaths(store, s.tree);
  assert.deepEqual(paths.filter((p) => p.includes('.web-chat')), []);
  assert.ok(paths.includes('a.txt'));
  // A tracked .web-chat/ file the daemon has since rewritten (a committed
  // theme.json, a component): the index copy differs from the worktree, and
  // the snapshot still succeeds with no .web-chat path in its tree.
  repo.write('.web-chat/tracked.json', '{"rewritten":true}\n');
  const s2 = await store.snapshot();
  assert.equal(s2.ok, true, JSON.stringify(s2));
  const paths2 = await treePaths(store, s2.tree);
  assert.deepEqual(paths2.filter((p) => p.includes('.web-chat')), []);
  assert.ok(paths2.includes('a.txt'));
});

test('an untracked .env never enters the shadow store; a large untracked file is excluded and listed', async (t) => {
  withTempHome(t);
  const repo = scratchRepo(t);
  const env = 'API_TOKEN=abc123never-stored\n';
  repo.write('.env', env);
  repo.write('big.bin', Buffer.alloc(2048, 7));
  const store = storeFor(repo, { limits: { LARGE_UNTRACKED_BYTES: 1024 } });
  const s = await store.snapshot();
  assert.equal(s.ok, true);
  assert.deepEqual(s.excluded.large, ['big.bin']);
  assert.deepEqual(s.excluded.sensitive.map((x) => x.path), ['.env']);
  assert.equal(s.excluded.sensitive[0].size, env.length);
  const id = gitIn(repo.top, ['hash-object', '--stdin'], { input: env }).toString().trim();
  assert.equal(await inShadow(store, id), false, 'the .env blob is not in the shadow');
  const paths = await treePaths(store, s.tree);
  assert.ok(!paths.includes('.env') && !paths.includes('big.bin'));
  // A sensitive name holding gitignore glob characters: its exclude line must
  // be escaped, or `/server[1].key` matches only `server1.key` and the key's
  // bytes enter the shadow store.
  const key = '-----KEY never-stored-either-----\n';
  repo.write('server[1].key', key);
  const s2 = await store.snapshot();
  assert.equal(s2.ok, true);
  assert.deepEqual(s2.excluded.sensitive.map((x) => x.path).sort(), ['.env', 'server[1].key']);
  const keyId = gitIn(repo.top, ['hash-object', '--stdin'], { input: key }).toString().trim();
  assert.equal(await inShadow(store, keyId), false, 'the glob-named key\'s blob is not in the shadow');
  assert.ok(!(await treePaths(store, s2.tree)).includes('server[1].key'));
});

test('a git without --attr-source: no call carries it, init passes no --object-format, and the shadow initialises', async (t) => {
  withTempHome(t);
  const repo = scratchRepo(t);
  const old = wrapRunner(runGit, { features: async () => ({ version: '2.39.0', attrSource: false, missing: false }) });
  const store = storeFor(repo, { runGit: old });
  const s = await store.snapshot();
  assert.equal(s.ok, true, JSON.stringify(s));
  assert.equal(s.attr_exact, false);
  for (const c of old.calls) {
    assert.ok(!c.opts.attrSource, `no attrSource on ${c.args.join(' ')}`);
    assert.ok(!c.args.some((a) => a.startsWith('--attr-source')));
  }
  const init = old.calls.find((c) => c.args[0] === 'init');
  assert.ok(init, 'the shadow was initialised through the runner');
  assert.ok(!init.args.some((a) => a.startsWith('--object-format')), 'sha1: no --object-format');

  // --show-object-format refused (a git older than 2.29): sha1, still no option.
  const repo2 = scratchRepo(t);
  const older = wrapRunner(runGit, {
    features: async () => ({ version: '2.28.0', attrSource: false, missing: false }),
    answer: (args) => (args.includes('--show-object-format') ? { stdout: '', stderr: 'unknown option', code: 129 } : undefined),
  });
  const store2 = storeFor(repo2, { runGit: older });
  const s2 = await store2.snapshot();
  assert.equal(s2.ok, true);
  const init2 = older.calls.find((c) => c.args[0] === 'init');
  assert.ok(!init2.args.some((a) => a.startsWith('--object-format')));
  assert.equal(store2.info().objectFormat, 'sha1');
});

test('a git without --attr-source still gets its turn\'s diff, with attr_exact: false', async (t) => {
  const repo = scratchRepo(t);
  const old = wrapRunner(runGit, { features: async () => ({ version: '2.39.0', attrSource: false, missing: false }) });
  const h = await mirrorOn(t, repo, { source: { runGit: old } });
  h.session();
  assert.equal((await h.run('pOld', () => repo.write('a.txt', 'older git\n'))).status, 'ready');
  const rec = h.record('pOld');
  assert.equal(rec.attr_exact, false);
  assert.deepEqual(rec.files.map((f) => [f.path, f.status]), [['a.txt', 'M']]);
  assert.match(rec.patch, /\+older git/);
  assert.ok(old.calls.every((c) => !c.opts.attrSource && !c.args.some((a) => a.startsWith('--attr-source'))));
});

test('housekeeping: tmp emptied of other processes\' copies, old records deleted, a full shadow turns the source off', async (t) => {
  withTempHome(t);
  const repo = scratchRepo(t);
  const paths = projectPaths(repo.root);
  const store = storeFor(repo);
  assert.equal((await store.snapshot()).ok, true);
  fs.mkdirSync(paths.mirrorTmp, { recursive: true });
  fs.writeFileSync(path.join(paths.mirrorTmp, 'index-1-1'), 'stale');
  fs.writeFileSync(path.join(paths.mirrorTmp, `index-${process.pid}-999`), 'mine');
  fs.mkdirSync(paths.mirrorDiffsDir, { recursive: true });
  const oldRec = paths.mirrorDiff('tOld');
  const newRec = paths.mirrorDiff('tNew');
  fs.writeFileSync(oldRec, '{}');
  fs.writeFileSync(newRec, '{}');
  const long = (Date.now() - 40 * 24 * 3600 * 1000) / 1000;
  fs.utimesSync(oldRec, long, long);
  assert.deepEqual(await store.housekeep(), { ok: true, full: false });
  assert.deepEqual(fs.readdirSync(paths.mirrorTmp), [`index-${process.pid}-999`]);
  assert.equal(fs.existsSync(oldRec), false);
  assert.equal(fs.existsSync(newRec), true);
  assert.deepEqual(await storeFor(repo, { limits: { SHADOW_MAX_BYTES: 1 } }).housekeep(), { ok: true, full: true });

  const repo2 = scratchRepo(t);
  const h = await mirrorOn(t, repo2, { source: { limits: { SHADOW_MAX_BYTES: 1 } } });
  h.session();
  await h.run('pFull1', () => repo2.write('a.txt', 'one\n'));
  await waitUntil(() => h.diag().state === 'shadow-store-full', { timeout: 10000, what: 'the size check' });
  h.prompt('pFull2');
  h.tool('PreToolUse', 'Edit', 'Edit', 'tu-full');
  h.stop();
  assert.deepEqual(await h.settled('pFull2'), { status: 'unavailable', reason: 'shadow-store-full' });
});

test('the store\'s limits and a failing git answer reasons, never throws', async (t) => {
  withTempHome(t);
  const repo = scratchRepo(t);
  assert.deepEqual(await storeFor(repo, { limits: { MAX_INDEX_BYTES: 10 } }).snapshot(), { ok: false, reason: 'index-too-large' });
  repo.write('u1.txt', '1');
  repo.write('u2.txt', '2');
  assert.deepEqual(await storeFor(repo, { limits: { MAX_UNTRACKED: 1 } }).snapshot(), { ok: false, reason: 'too-many-untracked' });
  const failing = wrapRunner(runGit, { answer: (args) => (args.includes('add') ? { stdout: '', stderr: 'boom', code: 128 } : undefined) });
  assert.deepEqual(await storeFor(repo, { runGit: failing }).snapshot(), { ok: false, reason: 'snapshot-failed' });
  const plain = fs.mkdtempSync(path.join(SANDBOX, 'wc-plain-'));
  t.after(() => fs.rmSync(plain, { recursive: true, force: true }));
  const none = createShadowStore({ root: plain, paths: projectPaths(plain) });
  assert.deepEqual(await none.snapshot(), { ok: false, reason: 'not-a-git-repo' });
  const missing = createShadowStore({ root: repo.root, paths: projectPaths(repo.root), runGit: createGitRunner({ bin: path.join(plain, 'no-git') }) });
  assert.deepEqual(await missing.snapshot(), { ok: false, reason: 'git-missing' });
});

// ── the source, on a real createMirror ───────────────────────────────────────

test('a live turn that edits a file: code pending → ready, the record on disk, the bar reads it at once', async (t) => {
  const repo = scratchRepo(t, { files: { 'app.js': 'const a = 1;\n' } });
  const h = await mirrorOn(t, repo);
  h.session();
  const fake = fakeSecrets().find((f) => f.id === 'sk-anthropic-api');
  h.prompt('pA');
  await h.snapshots(1);
  h.tool('PreToolUse', 'Edit', 'Edit', 'tu-1');
  repo.write('app.js', `const a = 2;\n// ${fake.text}\n// ${h.root}/notes\n`);
  h.tool('PostToolUse', 'Edit', 'Edit', 'tu-1');
  h.stop();
  assert.deepEqual(h.turn('pA').code, { status: 'pending' }, 'pending as the turn closes');
  const code = await h.settled('pA');
  assert.deepEqual(code, { status: 'ready', files: 1, additions: 3, deletions: 1 });
  const raw = fs.readFileSync(projectPaths(h.root).mirrorDiff('pA'), 'utf8');
  assert.deepEqual(findLeaks(raw, [fake]), [], 'the fake key is masked in the record file itself');
  assert.ok(!raw.includes(h.root), 'no host path on disk');
  const rec = JSON.parse(raw);
  assert.deepEqual(Object.keys(rec).sort(), ['after', 'attr_exact', 'before', 'conversation_id', 'created_at', 'files', 'flags',
    'outside', 'patch', 'patch_truncated', 'status', 'totals', 'turn_id', 'v'].sort());
  assert.equal(rec.v, 1);
  assert.equal(rec.turn_id, 'pA');
  assert.equal(rec.conversation_id, S1);
  assert.equal(rec.status, 'ready');
  assert.equal(rec.before.source, 'turn-open');
  assert.match(rec.before.tree, /^[0-9a-f]{40}$/);
  assert.notEqual(rec.before.tree, rec.after.tree);
  assert.deepEqual(rec.files, [{ path: 'app.js', status: 'M', additions: 3, deletions: 1, binary: false }]);
  assert.deepEqual(rec.totals, { files: 1, additions: 3, deletions: 1 });
  assert.match(rec.patch, /^diff --git a\/app\.js b\/app\.js/);
  assert.equal(rec.patch_truncated, false);
  assert.deepEqual(rec.flags, { concurrent_sessions: false, before_racy: false, skipped_large_untracked: [] });
  assert.equal(rec.outside, null);
  assert.equal(rec.attr_exact, true);
  assert.equal('head' in rec, false, 'no head key (U43-U79@head-on-record is held)');
  // The bar's last turn, without a process sample.
  assert.equal(h.mirror.liveOf(S1).last_turn.code.files, 1);
  // Through the facade: host paths masked on the way out.
  const viaFacade = await h.mirror.diff({ turn: 'pA' });
  assert.equal(viaFacade.turn_id, 'pA');
  assert.equal(viaFacade.totals.files, 1);
  assert.ok(!JSON.stringify(viaFacade).includes(h.root));
  assert.equal(await h.mirror.diff({ turn: 'no-such-turn' }), null);
  assert.equal(h.mirror.snapshot({ level: 'local' }).capabilities.turn_diff, true);
});

test('a turn that ran no tool has no record and code null; a catch-up turn is never snapshotted', async (t) => {
  const repo = scratchRepo(t);
  const h = await mirrorOn(t, repo);
  h.session();
  h.prompt('pQuiet');
  await h.snapshots(1);
  h.stop();
  await sleep(200);
  assert.equal(h.turn('pQuiet').code, null);
  assert.equal(fs.existsSync(projectPaths(h.root).mirrorDiff('pQuiet')), false);
  // An hour-old turn (a catch-up replay through the same hooks).
  const snaps = h.diag().snapshots;
  const old = Date.now() - 3600 * 1000;
  h.mirror.ingest({ ...h.env('UserPromptSubmit', { prompt_id: 'pOld', prompt: { author: 'user', text: 'old' } }), ts: old });
  h.mirror.ingest({ ...h.env('PreToolUse', { tool: { name: 'Edit', kind: 'Edit', use_id: 'tu-old', label: 'Edit', call: 'Edit', input: {}, input_hash: 'x' } }), ts: old + 1 });
  h.mirror.ingest({ ...h.env('Stop', { stop: { last_assistant_message: 'x', agent_transcript_path: null, background_tasks: [], error: null } }), ts: old + 2 });
  await sleep(200);
  assert.equal(h.diag().snapshots, snaps, 'no snapshot for a catch-up turn');
  assert.equal(h.turn('pOld').code, null);
});

test('outside: an edit between turns gives outside counts; returning the tree to an earlier state names that turn', async (t) => {
  const repo = scratchRepo(t, { files: { 'a.txt': 'a1\n', 'b.txt': 'b1\n' } });
  const h = await mirrorOn(t, repo);
  h.session();
  await h.run('p1', () => repo.write('a.txt', 'a2\n'));
  assert.equal(h.record('p1').outside, null);
  repo.write('b.txt', 'b2\nb3\n'); // the user, between turns
  await h.run('p2', () => repo.write('a.txt', 'a3\n'));
  assert.deepEqual(h.record('p2').outside, { files: 1, additions: 2, deletions: 1 });
  // Back to the state before p1 (a code-only rewind, §15.4 case d).
  repo.write('a.txt', 'a1\n');
  repo.write('b.txt', 'b1\n');
  await h.run('p3', null, { name: 'Read', kind: 'Read' });
  const rec = h.record('p3');
  assert.equal(rec.outside.returned_to, 'p1');
  assert.equal(rec.totals.files, 0);
});

test('concurrent_sessions: another conversation\'s turn open in the window', async (t) => {
  const repo = scratchRepo(t);
  const h = await mirrorOn(t, repo);
  h.session(S1);
  h.session(S2);
  h.prompt('pOne', S1);
  await h.snapshots(1);
  h.prompt('pTwo', S2);
  h.tool('PreToolUse', 'Edit', 'Edit', 'tu-c', S1);
  repo.write('a.txt', 'changed\n');
  h.stop(S1);
  await h.settled('pOne');
  assert.equal(h.record('pOne').flags.concurrent_sessions, true);
});

test('before_racy: a mutating PreToolUse during the before-snapshot sets it; a WebFetch does not', async (t) => {
  // The before-snapshot's add is held until the test lets it go.
  const gates = [];
  const slow = () => wrapRunner(runGit, {
    delay: (args) => (args.includes('add') ? new Promise((r) => gates.push(r)) : undefined),
  });
  const release = async () => { await waitUntil(() => gates.length, { timeout: 10000, what: 'the add' }); gates.shift()(); };

  const repo = scratchRepo(t);
  const h = await mirrorOn(t, repo, { source: { runGit: slow() } });
  h.session();
  h.prompt('pR');
  await waitUntil(() => gates.length, { timeout: 10000, what: 'the before-snapshot' });
  h.tool('PreToolUse', 'Edit', 'Edit', 'tu-r');
  await release();
  await h.snapshots(1);
  repo.write('a.txt', 'racy\n');
  h.stop();
  await release();
  await h.settled('pR');
  assert.equal(h.record('pR').flags.before_racy, true);

  const repo2 = scratchRepo(t);
  const h2 = await mirrorOn(t, repo2, { source: { runGit: slow() } });
  h2.session();
  h2.prompt('pW');
  await waitUntil(() => gates.length, { timeout: 10000, what: 'the before-snapshot' });
  h2.tool('PreToolUse', 'WebFetch', 'Web', 'tu-w');
  await release();
  await h2.snapshots(1);
  h2.stop();
  await release();
  await h2.settled('pW');
  assert.equal(h2.record('pW').flags.before_racy, false);
  assert.ok(READ_ONLY_KINDS.includes('Web') && !READ_ONLY_KINDS.includes('WebFetch'), 'kinds, never tool names');
});

test('the before (U43@before-snapshot-timing): one in flight under REUSE_MS is reused; a failed one falls back to the previous after-tree', async (t) => {
  // Reuse: S2's turn opens while S1's before-snapshot is held at its add.
  const gates = [];
  const slow = wrapRunner(runGit, {
    delay: (args) => (args.includes('add') ? new Promise((r) => gates.push(r)) : undefined),
  });
  const release = async () => { await waitUntil(() => gates.length, { timeout: 10000, what: 'the add' }); gates.shift()(); };
  const writeTrees = () => slow.calls.filter((c) => c.args.includes('write-tree')).length;
  const repo = scratchRepo(t, { files: { 'a.txt': 'a1\n', 'b.txt': 'b1\n' } });
  const h = await mirrorOn(t, repo, { source: { runGit: slow } });
  h.session(S1);
  h.session(S2);
  h.prompt('pA', S1);
  await waitUntil(() => gates.length, { timeout: 10000, what: 'the before-snapshot' });
  h.prompt('pB', S2);
  await release();
  await h.snapshots(1);
  await sleep(150);
  assert.equal(gates.length, 0, 'no second before-snapshot was started');
  assert.equal(writeTrees(), 1, 'one snapshot served both befores');
  h.tool('PreToolUse', 'Edit', 'Edit', 'tu-a', S1);
  repo.write('a.txt', 'a2\n');
  h.stop(S1);
  await release();
  await h.settled('pA');
  h.tool('PreToolUse', 'Edit', 'Edit', 'tu-b', S2);
  repo.write('b.txt', 'b2\n');
  h.stop(S2);
  await release();
  await h.settled('pB');
  assert.equal(h.record('pB').before.tree, h.record('pA').before.tree);
  assert.equal(h.record('pB').before.source, 'turn-open');

  // Fallback: the next before-snapshot's write-tree fails.
  let failNext = false;
  const flaky = wrapRunner(runGit, {
    answer: (args) => {
      if (failNext && args.includes('write-tree')) { failNext = false; return { stdout: '', stderr: 'injected', code: 1 }; }
      return undefined;
    },
  });
  const repo2 = scratchRepo(t, { files: { 'a.txt': 'a1\n' } });
  const h2 = await mirrorOn(t, repo2, { source: { runGit: flaky } });
  h2.session();
  await h2.run('p1', () => repo2.write('a.txt', 'a2\n'));
  failNext = true;
  h2.prompt('p2');
  await waitUntil(() => !failNext, { timeout: 10000, what: 'the failed before-snapshot' });
  await sleep(50);
  h2.tool('PreToolUse', 'Edit', 'Edit', 'tu-2');
  repo2.write('a.txt', 'a3\n');
  h2.tool('PostToolUse', 'Edit', 'Edit', 'tu-2');
  h2.stop();
  assert.equal((await h2.settled('p2')).status, 'ready');
  const rec = h2.record('p2');
  assert.equal(rec.before.source, 'previous-turn-close');
  assert.equal(rec.before.tree, h2.record('p1').after.tree);
  assert.equal(rec.totals.files, 1);
  assert.equal(rec.outside, null);
});

test('sensitive and large files in a turn: withheld, with and without counts, no hunk', async (t) => {
  const repo = scratchRepo(t, { files: { 'a.txt': 'a\n', 'deploy/credentials.json': '{"k":"v1"}\n' } });
  const h = await mirrorOn(t, repo, { source: { limits: { LARGE_UNTRACKED_BYTES: 1024 } } });
  h.session();
  await h.run('pS', () => {
    repo.write('.env', 'SECRET_THING=never-in-a-record\n');
    repo.write('deploy/credentials.json', '{"k":"v2-not-in-the-patch"}\n');
    repo.write('huge.log', Buffer.alloc(4096, 65));
    repo.write('a.txt', 'a2\n');
  });
  const rec = h.record('pS');
  const by = Object.fromEntries(rec.files.map((f) => [f.path, f]));
  assert.deepEqual(by['.env'], { path: '.env', status: 'A', withheld: 'sensitive' }, 'untracked sensitive: no counts');
  assert.deepEqual(by['deploy/credentials.json'], { path: 'deploy/credentials.json', status: 'M', additions: 1, deletions: 1, binary: false, withheld: 'sensitive' });
  assert.deepEqual(by['huge.log'], { path: 'huge.log', status: 'A', withheld: 'large' });
  assert.deepEqual(rec.flags.skipped_large_untracked, ['huge.log']);
  const raw = fs.readFileSync(projectPaths(h.root).mirrorDiff('pS'), 'utf8');
  assert.ok(!raw.includes('never-in-a-record') && !raw.includes('v2-not-in-the-patch'));
  assert.match(rec.patch, /\+a2/);
  assert.deepEqual(rec.totals, { files: 4, additions: 2, deletions: 2 });
  // The untracked .env changed in place, then gone: still withheld, still no counts.
  await h.run('pS2', () => repo.write('.env', 'SECRET_THING=changed-and-longer-never-in-a-record\n'));
  assert.deepEqual(h.record('pS2').files, [{ path: '.env', status: 'M', withheld: 'sensitive' }]);
  await h.run('pS3', () => fs.rmSync(path.join(repo.top, '.env')));
  assert.deepEqual(h.record('pS3').files, [{ path: '.env', status: 'D', withheld: 'sensitive' }]);
  for (const id of ['pS2', 'pS3']) {
    const r = fs.readFileSync(projectPaths(h.root).mirrorDiff(id), 'utf8');
    assert.ok(!r.includes('never-in-a-record'), `${id}: no .env content on disk`);
  }
});

test('the patch caps: a file over PATCH_FILE_MAX is cut at a line end and marked, the whole stays under PATCH_MAX', async (t) => {
  const repo = scratchRepo(t, { files: { 'big.txt': 'b\n', 'small1.txt': 's1\n', 'small2.txt': 's2\n' } });
  const h = await mirrorOn(t, repo, { source: { limits: { PATCH_FILE_MAX: 200, PATCH_MAX: 300 } } });
  h.session();
  await h.run('pCap', () => {
    repo.write('big.txt', Array.from({ length: 60 }, (_, i) => `line ${String(i).padStart(3, '0')} of the big file`).join('\n') + '\n');
    repo.write('small1.txt', 'small one changed\n');
    repo.write('small2.txt', 'small two changed\n');
  });
  const rec = h.record('pCap');
  const by = Object.fromEntries(rec.files.map((f) => [f.path, f]));
  assert.equal(by['big.txt'].truncated, true, 'the big file is marked truncated');
  assert.equal(by['big.txt'].additions, 60, 'its counts are whole');
  assert.equal('truncated' in by['small1.txt'], false);
  assert.equal(rec.patch_truncated, true, 'the whole patch hit PATCH_MAX');
  assert.ok(Buffer.byteLength(rec.patch) <= 300, `patch ${Buffer.byteLength(rec.patch)} bytes`);
  assert.match(rec.patch, /^diff --git a\/big\.txt b\/big\.txt/);
  assert.ok(rec.patch.endsWith('\n'), 'cut at a line end');
  assert.ok(!rec.patch.includes('small2.txt'), 'a file past PATCH_MAX has no hunk');
  assert.deepEqual(rec.totals, { files: 3, additions: 62, deletions: 3 });
});

test('guards: index-too-large and too-many-untracked make that turn unavailable; two slow snapshots turn it off', async (t) => {
  const repo = scratchRepo(t);
  const h = await mirrorOn(t, repo, { source: { limits: { MAX_INDEX_BYTES: 10 } } });
  h.session();
  h.prompt('pI');
  h.tool('PreToolUse', 'Edit', 'Edit', 'tu-i');
  h.stop();
  assert.deepEqual(await h.settled('pI'), { status: 'unavailable', reason: 'index-too-large' });
  assert.equal(fs.existsSync(projectPaths(h.root).mirrorDiff('pI')), false);

  const repo2 = scratchRepo(t);
  repo2.write('u1.txt', '1');
  repo2.write('u2.txt', '2');
  const h2 = await mirrorOn(t, repo2, { source: { limits: { MAX_UNTRACKED: 1 } } });
  h2.session();
  h2.prompt('pU');
  h2.tool('PreToolUse', 'Edit', 'Edit', 'tu-u');
  h2.stop();
  assert.deepEqual(await h2.settled('pU'), { status: 'unavailable', reason: 'too-many-untracked' });

  const repo3 = scratchRepo(t);
  const h3 = await mirrorOn(t, repo3, { source: { limits: { SLOW_SNAPSHOT_MS: -1 } } });
  h3.session();
  assert.equal((await h3.run('pSlow1', () => repo3.write('a.txt', 'x\n'))).status, 'ready', 'the turn whose snapshots tripped it keeps its record');
  assert.equal(h3.diag().state, 'slow-repo');
  h3.prompt('pSlow2');
  h3.tool('PreToolUse', 'Edit', 'Edit', 'tu-s2');
  h3.stop();
  assert.deepEqual(await h3.settled('pSlow2'), { status: 'unavailable', reason: 'slow-repo' });
  assert.equal(h3.diag().snapshots, 2, 'nothing more is snapshotted');
});

test('not a repository and git missing: code unavailable and no record', async (t) => {
  const plain = { root: fs.realpathSync(fs.mkdtempSync(path.join(SANDBOX, 'wc-plain-'))) };
  t.after(() => fs.rmSync(plain.root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(plain.root, '.web-chat'));
  const h = await mirrorOn(t, plain);
  h.session();
  h.prompt('pN');
  h.tool('PreToolUse', 'Edit', 'Edit', 'tu-n');
  h.stop();
  assert.deepEqual(await h.settled('pN'), { status: 'unavailable', reason: 'not-a-git-repo' });
  assert.equal(fs.existsSync(projectPaths(plain.root).mirrorDiff('pN')), false);
  const late = await h.run('pN2', null, { waitBefore: false });
  assert.deepEqual(late, { status: 'unavailable', reason: 'not-a-git-repo' }, 'off for the daemon\'s life');

  const repo = scratchRepo(t);
  const h2 = await mirrorOn(t, repo, { source: { runGit: createGitRunner({ bin: path.join(plain.root, 'no-git-here') }) } });
  h2.session();
  h2.prompt('pM');
  h2.tool('PreToolUse', 'Edit', 'Edit', 'tu-m');
  h2.stop();
  assert.deepEqual(await h2.settled('pM'), { status: 'unavailable', reason: 'git-missing' });
});

test('lazy init: a daemon whose turns never open fresh spawns no git at all', async (t) => {
  const repo = scratchRepo(t);
  const counting = wrapRunner(runGit, { features: async () => { counting.calls.push({ args: ['--version'], opts: {} }); return runGit.features(); } });
  const h = await mirrorOn(t, repo, { source: { runGit: counting } });
  h.session();
  // A catch-up's historical turn, replayed through the same hooks.
  const old = Date.now() - 3600 * 1000;
  h.mirror.ingest({ ...h.env('UserPromptSubmit', { prompt_id: 'pLazy', prompt: { author: 'user', text: 'x' } }), ts: old });
  h.mirror.ingest({ ...h.env('PreToolUse', { tool: { name: 'Edit', kind: 'Edit', use_id: 'tu-lazy', label: 'Edit', call: 'Edit', input: {}, input_hash: 'x' } }), ts: old + 1 });
  h.mirror.ingest({ ...h.env('Stop', { stop: { last_assistant_message: 'x', agent_transcript_path: null, background_tasks: [], error: null } }), ts: old + 2 });
  await sleep(200);
  assert.equal(counting.calls.length, 0, 'no git call, not even the version probe');
  assert.equal(fs.existsSync(projectPaths(h.root).mirrorGit), false, 'no shadow');
  assert.equal(h.diag().state, 'idle');
});

test('WEB_CHAT_MIRROR_DIFFS=0: no api, turn_diff and node_diff false, no header patched', async (t) => {
  const prev = process.env.WEB_CHAT_MIRROR_DIFFS;
  process.env.WEB_CHAT_MIRROR_DIFFS = '0';
  t.after(() => { if (prev === undefined) delete process.env.WEB_CHAT_MIRROR_DIFFS; else process.env.WEB_CHAT_MIRROR_DIFFS = prev; });
  const repo = scratchRepo(t);
  const h = await mirrorOn(t, repo);
  const caps = h.mirror.snapshot({ level: 'local' }).capabilities;
  assert.equal(caps.turn_diff, false);
  assert.equal(caps.node_diff, false);
  assert.deepEqual(await h.mirror.diff({ turn: 'x' }), { unavailable: true });
  h.session();
  h.prompt('pOff');
  h.tool('PreToolUse', 'Edit', 'Edit', 'tu-off');
  repo.write('a.txt', 'off\n');
  h.stop();
  await sleep(300);
  assert.equal(h.turn('pOff').code, null);
  assert.equal(fs.existsSync(projectPaths(h.root).mirrorGit), false, 'no shadow');
});

test('node diffs: turns without patch, a combined diff, cached; with a tree missing, combined is null', async (t) => {
  const graph = {
    nodes: new Map([['n5', { id: 'n5', mirror: { v: 1, turns: [{ turn_id: 'pN1' }, { turn_id: 'pN2' }] } }],
      ['n6', { id: 'n6', mirror: { v: 1, turns: [{ turn_id: 'pN1' }, { turn_id: 'pN2' }] } }]]),
    topology: new Map([['n5', { id: 'n5', parent_id: null, children: [], created_at: 1 }], ['n6', { id: 'n6', parent_id: null, children: [], created_at: 2 }]]),
    active: 'n5',
    snapshotLive: () => ({}),
  };
  const repo = scratchRepo(t, { files: { 'a.txt': 'one\n' } });
  const h = await mirrorOn(t, repo, { graph });
  h.session();
  await h.run('pN1', () => repo.write('a.txt', 'two\n'));
  await h.run('pN2', () => repo.write('b.txt', 'bee\n'));
  const out = await h.mirror.diff({ node: 'n5' });
  assert.deepEqual(out.node, { id: 'n5', label: 'n1.0' });
  assert.deepEqual(out.turns.map((x) => x.turn_id), ['pN1', 'pN2']);
  assert.ok(out.turns.every((x) => !('patch' in x)), 'turns without patch');
  assert.deepEqual(out.combined.files.map((f) => [f.path, f.status]), [['a.txt', 'M'], ['b.txt', 'A']]);
  assert.match(out.combined.patch, /\+two[\s\S]*\+bee/);
  assert.equal(out.combined.before.tree, h.record('pN1').before.tree);
  assert.equal(out.combined.after.tree, h.record('pN2').after.tree);
  const cache = projectPaths(h.root).mirrorNodeDiff('n5');
  assert.ok(fs.existsSync(cache), 'cached under mirrorNodeDiff');
  // Remove the after tree from the shadow: n6 (uncached) has no combined.
  const after = h.record('pN2').after.tree;
  fs.rmSync(path.join(projectPaths(h.root).mirrorGit, 'objects', after.slice(0, 2), after.slice(2)));
  const n6 = await h.mirror.diff({ node: 'n6' });
  assert.equal(n6.combined, null);
  assert.equal(n6.turns.length, 2);
  const again = await h.mirror.diff({ node: 'n5' });
  assert.ok(again.combined, 'n5 answers from its cache');
  assert.equal(await h.mirror.diff({ node: 'live' }), null);
  assert.equal(await h.mirror.diff({ node: 'n99' }), null);
});

test('stop() during a snapshot aborts it, removes the index copy and returns promptly', async (t) => {
  const repo = scratchRepo(t);
  let started = false;
  const stuck = wrapRunner(runGit, {
    delay: (args, opts) => (args.includes('add') ? new Promise((resolve, reject) => {
      started = true;
      const s = opts.signal;
      if (s) s.addEventListener('abort', () => reject(new GitRunError('aborted', 'aborted')), { once: true });
    }) : undefined),
  });
  const h = await mirrorOn(t, repo, { source: { runGit: stuck } });
  h.session();
  h.prompt('pStop');
  await waitUntil(() => started, { timeout: 10000, what: 'the stuck add' });
  const tmp = projectPaths(h.root).mirrorTmp;
  assert.equal(fs.readdirSync(tmp).length, 1, 'the copy exists while the add runs');
  const t0 = Date.now();
  await h.mirror.stop();
  assert.ok(Date.now() - t0 < 2000, 'within MIRROR_STOP_TIMEOUT_MS');
  assert.deepEqual(fs.readdirSync(tmp), [], 'the index copy is removed');
});

test('restart: a pending header becomes ready from its record, else unavailable daemon-restarted; the chain persists', async (t) => {
  const repo = scratchRepo(t);
  const paths = projectPaths(repo.root);
  fs.mkdirSync(paths.mirrorDiffsDir, { recursive: true });
  const tree = 'a'.repeat(40);
  fs.writeFileSync(paths.mirrorDiff('tDone'), JSON.stringify({ v: 1, turn_id: 'tDone', status: 'ready', totals: { files: 2, additions: 5, deletions: 1 } }));
  const headers = new Map([
    ['tDone', { id: 'tDone', session_id: S1, code: { status: 'pending' } }],
    ['tLost', { id: 'tLost', session_id: S1, code: { status: 'pending' } }],
    ['tFine', { id: 'tFine', session_id: S1, code: null }],
  ]);
  const patched = [];
  const timers = [];
  const engine = {
    root: repo.root, paths, now: Date.now, log: () => {}, graph: null,
    redactor: createRedactor(),
    timers: { setTimeout: (fn) => { timers.push(fn); return timers.length; }, clearTimeout: () => {} },
    model: {
      turnsOf: () => [...headers.values()], turn: (id) => headers.get(id) || null, resolveTurn: (id) => id,
      patchTurn: (id, p) => { patched.push([id, p]); return headers.get(id); }, openTurnOf: () => null,
    },
    conversations: { bySession: (sid) => (sid === S1 ? { id: S1 } : null), list: () => [{ id: S1 }] },
    live: { noteActivity: () => {} },
  };
  const src = createCodediffSource({ enabled: true }).attach(engine);
  src.restoreState(S1, { v: 1, chain: { after: { tree, at: 5, turn_id: 'tPrev' }, trees: [[tree, 'tPrev', 'after']] } });
  for (const fn of timers.splice(0)) fn();
  assert.deepEqual(patched, [
    ['tDone', { code: { status: 'ready', files: 2, additions: 5, deletions: 1 } }],
    ['tLost', { code: { status: 'unavailable', reason: 'daemon-restarted' } }],
  ]);
  assert.deepEqual(src.persistState(S1), { v: 1, chain: { after: { tree, at: 5, turn_id: 'tPrev' }, trees: [[tree, 'tPrev', 'after']] } });
  assert.deepEqual(src.persistState('unknown'), { v: 1, chain: null });
  assert.equal(JSON.stringify(src.persistState(S1)).includes(repo.root), false, 'repo-relative only');
  await src.stop();
});

test('the exported limits are the brief\'s', () => {
  assert.equal(LIMITS.LARGE_UNTRACKED_BYTES, 8 * 1024 * 1024);
  assert.equal(LIMITS.MAX_UNTRACKED, 5000);
  assert.equal(LIMITS.MAX_INDEX_BYTES, 20 * 1024 * 1024);
  assert.equal(LIMITS.SLOW_SNAPSHOT_MS, 5000);
  assert.equal(LIMITS.SLOW_SNAPSHOTS, 2);
  assert.equal(LIMITS.PATCH_MAX, 512 * 1024);
  assert.equal(LIMITS.PATCH_FILE_MAX, 128 * 1024);
  assert.equal(LIMITS.RECORD_MAX_DAYS, 30);
  assert.equal(LIMITS.PRUNE_EXPIRE, '7.days.ago');
  assert.equal(LIMITS.SHADOW_MAX_BYTES, 1024 * 1024 * 1024);
  assert.equal(LIMITS.REUSE_MS, 1000);
  assert.equal(LIMITS.FRESH_MS, 5000);
  assert.equal(LIMITS.RETURN_MAX, 200);
  assert.equal(LIMITS.keepIndexTimes, true);
  assert.deepEqual(READ_ONLY_KINDS, ['Read', 'Grep', 'Glob', 'Web', 'Search', 'Todo', 'Stop', 'Question', 'Plan']);
});
