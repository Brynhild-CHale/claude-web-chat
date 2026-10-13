// The daemon's one git runner (lib/server/git-run.js, spec §2.7).
//
// Pinned, against a fake git (a Node script behind test-support/helpers
// fakeBin, written into the test's own temp dir) that records the argv and the
// environment of every call:
//   * GIT_FLAGS come first, --attr-source sits after them and before the
//     subcommand, and the caller's args follow untouched;
//   * every inherited GIT_* variable is gone, GIT_OPTIONAL_LOCKS=0 and
//     GIT_TERMINAL_PROMPT=0 are set, and a caller's own GIT_* variable passes;
//   * two calls never overlap and run in the order they were made; exclusive
//     holds the queue while a third call waits;
//   * `input` reaches stdin; encoding 'buffer' answers a Buffer; a non-zero
//     exit is an answer, not a throw; output past maxBuffer rejects max-buffer;
//   * a missing bin rejects git-missing, a sleeping fake rejects timeout with a
//     short timeoutMs, an abort rejects aborted and leaves no child behind, and
//     an abort while queued never starts the call;
//   * features() parses the version, says attrSource for 2.40 and newer, and
//     probes once.
// The real git is touched once, for features() (the machine's own version).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { fakeBin, waitUntil } = require('../test-support/helpers');
const { home: SANDBOX } = require('../test-support/sandbox');
const { isPidAlive } = require('../lib/core/portfiles');
const {
  runGit, createGitRunner, GitRunError, GIT_FLAGS, parseVersion, gitEnv,
} = require('../lib/server/git-run');

// The fake git. Each call writes call-<pid>-<n>.json = {argv, env, cwd}; the
// last argument picks a behaviour.
const FAKE_GIT = `
const fs = require('fs');
const path = require('path');
const dir = process.env.FAKE_GIT_DIR;
const argv = process.argv.slice(2);
const rec = path.join(dir, 'call-' + process.pid + '-' + process.hrtime.bigint() + '.json');
fs.writeFileSync(rec, JSON.stringify({ argv, env: process.env, cwd: process.cwd() }));
const mode = argv[argv.length - 1];
const log = (s) => fs.appendFileSync(path.join(dir, 'log'), s + '\\n');
if (argv.includes('--version')) { process.stdout.write('git version ' + (process.env.FAKE_GIT_VERSION || '2.39.1') + '\\n'); }
else if (mode === 'sleep') { fs.writeFileSync(path.join(dir, 'pid'), String(process.pid)); setTimeout(() => {}, 30000); }
else if (mode === 'stdin') { const chunks = []; process.stdin.on('data', (c) => chunks.push(c)); process.stdin.on('end', () => process.stdout.write(Buffer.concat(chunks))); }
else if (mode === 'bytes') { process.stdout.write(Buffer.from([0, 255, 10, 128])); }
else if (mode === 'big') { process.stdout.write(Buffer.alloc(65536, 97)); }
else if (mode === 'fail') { process.stderr.write('nope'); process.exitCode = 3; }
else if (mode.startsWith('busy')) {
  const busy = path.join(dir, 'busy');
  if (fs.existsSync(busy)) log('overlap ' + mode);
  fs.writeFileSync(busy, mode);
  log('start ' + mode);
  setTimeout(() => { log('end ' + mode); fs.rmSync(busy, { force: true }); }, 120);
}
`;

function fakeGit(t, { version } = {}) {
  const dir = fs.mkdtempSync(path.join(SANDBOX, 'wc-fakegit-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const script = path.join(dir, 'fake-git.js');
  fs.writeFileSync(script, FAKE_GIT);
  const env = { FAKE_GIT_DIR: dir, ...(version ? { FAKE_GIT_VERSION: version } : {}) };
  const { bin } = fakeBin(t, { name: 'git', script, env });
  const calls = () => fs.readdirSync(dir).filter((f) => f.startsWith('call-')).sort()
    .map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));
  const log = () => { try { return fs.readFileSync(path.join(dir, 'log'), 'utf8').trim().split('\n'); } catch { return []; } };
  return { bin, dir, calls, log, runner: createGitRunner({ bin }) };
}

// Set process.env for the test, restored after.
function withEnv(t, vars) {
  const prev = {};
  for (const k of Object.keys(vars)) { prev[k] = process.env[k]; process.env[k] = vars[k]; }
  t.after(() => { for (const k of Object.keys(prev)) { if (prev[k] === undefined) delete process.env[k]; else process.env[k] = prev[k]; } });
}

test('GIT_FLAGS come first, --attr-source sits before the subcommand, the args follow', async (t) => {
  const g = fakeGit(t);
  await g.runner(['status', '--porcelain', 'plain'], { attrSource: '4b825dc642cb6eb9a060e54bf8d69288fbee4904' });
  await g.runner(['ls-files', 'plain']);
  const [a, b] = g.calls();
  const withAttr = [...GIT_FLAGS, '--attr-source=4b825dc642cb6eb9a060e54bf8d69288fbee4904', 'status', '--porcelain', 'plain'];
  const calls = [a.argv, b.argv].sort((x, y) => x.length - y.length);
  assert.deepEqual(calls[1], withAttr);
  assert.deepEqual(calls[0], [...GIT_FLAGS, 'ls-files', 'plain']);
  assert.deepEqual(GIT_FLAGS.slice(0, 2), ['-c', 'core.fsmonitor=false']);
  assert.ok(GIT_FLAGS.includes('filter.lfs.process=') && GIT_FLAGS.includes('filter.lfs.required=false'));
});

test('every inherited GIT_* variable is gone, the two fixed ones are set, and the caller\'s own pass', async (t) => {
  withEnv(t, {
    GIT_DIR: '/nowhere/.git', GIT_INDEX_FILE: '/nowhere/index', GIT_WORK_TREE: '/nowhere',
    GIT_CEILING_DIRECTORIES: '/', GIT_OPTIONAL_LOCKS: '1', WC_UNRELATED: 'kept',
  });
  const g = fakeGit(t);
  await g.runner(['rev-parse', 'plain'], { env: { GIT_INDEX_FILE: '/mine/index' } });
  const [{ env }] = g.calls();
  for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_CEILING_DIRECTORIES']) assert.equal(env[k], undefined, `${k} is scrubbed`);
  assert.equal(env.GIT_OPTIONAL_LOCKS, '0');
  assert.equal(env.GIT_TERMINAL_PROMPT, '0');
  assert.equal(env.GIT_INDEX_FILE, '/mine/index', 'a caller\'s own GIT_* variable is set');
  assert.equal(env.WC_UNRELATED, 'kept', 'everything else is inherited');
  // The pure half, without a process.
  const pure = gitEnv({ GIT_DIR: '/shadow' });
  assert.equal(pure.GIT_DIR, '/shadow');
  assert.equal(pure.GIT_WORK_TREE, undefined);
});

test('two calls never overlap and run in the order they were made', async (t) => {
  const g = fakeGit(t);
  await Promise.all([g.runner(['x', 'busy-1']), g.runner(['x', 'busy-2']), g.runner(['x', 'busy-3'])]);
  assert.deepEqual(g.log(), ['start busy-1', 'end busy-1', 'start busy-2', 'end busy-2', 'start busy-3', 'end busy-3']);
});

test('exclusive holds the queue: a third call waits until the held sequence ends', async (t) => {
  const g = fakeGit(t);
  const order = [];
  const held = g.runner.exclusive(async (git) => {
    order.push('held:start');
    await git(['x', 'busy-a']);
    await new Promise((r) => setTimeout(r, 50));
    await git(['x', 'busy-b']);
    order.push('held:end');
    return 'done';
  });
  const third = g.runner(['x', 'busy-c']).then(() => order.push('third'));
  assert.equal(await held, 'done', 'exclusive answers what its callback returns');
  await third;
  assert.deepEqual(order, ['held:start', 'held:end', 'third']);
  assert.deepEqual(g.log(), ['start busy-a', 'end busy-a', 'start busy-b', 'end busy-b', 'start busy-c', 'end busy-c']);
  // A throw inside the slot rejects exclusive and frees the queue.
  await assert.rejects(g.runner.exclusive(async () => { throw new Error('boom'); }), /boom/);
  const r = await g.runner(['x', 'busy-d']);
  assert.equal(r.code, 0);
});

test('input reaches stdin; encoding buffer answers a Buffer; a non-zero exit is an answer', async (t) => {
  const g = fakeGit(t);
  const r = await g.runner(['x', 'stdin'], { input: 'a\0b\0' });
  assert.equal(r.stdout, 'a\0b\0');
  assert.equal(r.code, 0);
  const b = await g.runner(['x', 'bytes'], { encoding: 'buffer' });
  assert.ok(Buffer.isBuffer(b.stdout));
  assert.deepEqual([...b.stdout], [0, 255, 10, 128]);
  const f = await g.runner(['x', 'fail']);
  assert.equal(f.code, 3);
  assert.equal(f.stderr, 'nope');
  await assert.rejects(g.runner(['x', 'big'], { maxBuffer: 1024 }), (e) => e instanceof GitRunError && e.code === 'max-buffer');
  assert.equal((await g.runner(['x', 'plain'])).code, 0, 'the queue moves on');
});

test('a missing bin rejects git-missing, and features() says missing', async (t) => {
  const dir = fs.mkdtempSync(path.join(SANDBOX, 'wc-nogit-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const runner = createGitRunner({ bin: path.join(dir, 'no-such-git') });
  await assert.rejects(runner(['status']), (e) => e instanceof GitRunError && e.code === 'git-missing');
  assert.deepEqual(await runner.features(), { version: null, attrSource: false, missing: true });
  const onPath = createGitRunner({ bin: 'wc-no-such-git-on-any-path' });
  await assert.rejects(onPath(['status']), (e) => e.code === 'git-missing');
});

test('a sleeping git rejects timeout with a short timeoutMs, and the queue moves on', async (t) => {
  const g = fakeGit(t);
  // The fake writes its pid before it sleeps 30 s; 2 s leaves a Node child's
  // start-up under load room to get there before the runner kills it.
  await assert.rejects(g.runner(['x', 'sleep'], { timeoutMs: 2000 }), (e) => e instanceof GitRunError && e.code === 'timeout');
  const pid = Number(fs.readFileSync(path.join(g.dir, 'pid'), 'utf8'));
  assert.equal(isPidAlive(pid), false, 'the timed-out child is gone');
  assert.equal((await g.runner(['x', 'plain'])).code, 0);
});

test('an abort rejects aborted and leaves no child; an abort while queued never starts the call', async (t) => {
  const g = fakeGit(t);
  const ac = new AbortController();
  const running = g.runner(['x', 'sleep'], { signal: ac.signal });
  const queuedAc = new AbortController();
  const queued = g.runner(['x', 'never-runs'], { signal: queuedAc.signal });
  const pidFile = path.join(g.dir, 'pid');
  await waitUntil(() => fs.existsSync(pidFile), { timeout: 10000, what: 'the fake to start' });
  const pid = Number(fs.readFileSync(pidFile, 'utf8'));
  queuedAc.abort();
  await assert.rejects(queued, (e) => e.code === 'aborted');
  ac.abort();
  await assert.rejects(running, (e) => e instanceof GitRunError && e.code === 'aborted');
  assert.equal(isPidAlive(pid), false, 'the aborted child is gone');
  await g.runner(['x', 'plain']);
  assert.equal(g.calls().filter((c) => c.argv.includes('never-runs')).length, 0, 'the queued call never started');
  // Aborted before the call: no process at all.
  const before = g.calls().length;
  await assert.rejects(g.runner(['x', 'plain'], { signal: AbortSignal.abort() }), (e) => e.code === 'aborted');
  assert.equal(g.calls().length, before);
});

test('features() parses the version, says attrSource for 2.40 and newer, and probes once', async (t) => {
  assert.deepEqual(parseVersion('git version 2.39.1'), { version: '2.39.1', attrSource: false });
  assert.deepEqual(parseVersion('git version 2.40.0'), { version: '2.40.0', attrSource: true });
  assert.deepEqual(parseVersion('git version 2.50.1 (Apple Git-155)'), { version: '2.50.1', attrSource: true });
  assert.deepEqual(parseVersion('git version 3.0'), { version: '3.0', attrSource: true });
  assert.deepEqual(parseVersion('nonsense'), { version: null, attrSource: false });

  const old = fakeGit(t, { version: '2.39.5' });
  assert.deepEqual(await old.runner.features(), { version: '2.39.5', attrSource: false, missing: false });
  await old.runner.features();
  assert.equal(old.calls().length, 1, 'one probe, memoised');
  const fresh = fakeGit(t, { version: '2.45.2' });
  assert.deepEqual(await fresh.runner.features(), { version: '2.45.2', attrSource: true, missing: false });

  // The daemon's own runner, on this machine's git.
  const real = await runGit.features();
  assert.equal(real.missing, false);
  assert.match(real.version, /^\d+\.\d+/);
  assert.equal(typeof runGit.exclusive, 'function');
});
