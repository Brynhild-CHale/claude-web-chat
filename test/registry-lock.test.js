// The registry's write lock (R8-4).
//
// ~/.web-chat/instances.json has a writer per daemon, the hub, the portal, one
// per Claude Code session (register, throttled updates, exit) and any reader
// that prunes a dead row. Each change is a read-modify-write; lib/core/fsjson
// makes every WRITE whole, not the sequence, so two writers that both read
// before either wrote used to write back a list without the other's row — a
// daemon's own row included, which it writes once per life. Pinned here:
//   * eight real processes released at one barrier, each registering a
//     presence row, updating it, registering a daemon row (half of them then
//     releasing it), lose no row, no update and no known project — three runs;
//   * a stale lock (its holder's pid gone, or older than LOCK_STALE_MS) is
//     broken, said on stderr, and the write lands at once;
//   * a live lock is waited on for LOCK_WAIT_MS at most — then the write goes
//     ahead without it and says so, and the lock is left to its holder;
//   * a failed write still releases the lock, a no-op never takes it (nor
//     creates ~/.web-chat to hold it), and registerInstance holds it across
//     both files without waiting on itself;
//   * breaking a stale lock never moves a lock it did not judge (F-16): every
//     interleaving of a second waiter and a third writer with the breaker
//     leaves one holder at most, on the file it created; a lock moved in the
//     one window left (a live holder letting go mid-break) is put back or
//     kept, never deleted; a break another waiter has claimed is waited for,
//     and a claim whose breaker died is cleared.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const { withTempHome, waitUntil } = require('../test-support/helpers');
const registry = require('../lib/util/registry');
const { userPaths } = require('../lib/core/paths');

const REGISTRY_MODULE = path.join(__dirname, '..', 'lib', 'util', 'registry.js');
const DEAD_PID = 2 ** 30;
const WRITERS = 8;
const UPDATES = 25;

const lockFile = () => userPaths().instancesLock;

function project(t, name) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `wc-rlock-${name}-`)));
  fs.mkdirSync(path.join(dir, '.web-chat'), { recursive: true });
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} });
  return dir;
}

// Everything the registry says on stderr while `fn` runs (it is synchronous, so
// nothing else can write in between).
function stderrOf(fn) {
  const lines = [];
  const orig = process.stderr.write;
  process.stderr.write = (chunk, ...rest) => { lines.push(String(chunk)); return true; };
  let value;
  try { value = fn(); } finally { process.stderr.write = orig; }
  return { value, text: lines.join('') };
}

// One writer: says `ready`, waits for `go <at>`, sleeps to that instant, then
// does a session's and a daemon's worth of registry writes and says `done`. It
// stays alive (its rows need a live pid) until the test closes its stdin.
const WORKER = `
const reg = require(${JSON.stringify(REGISTRY_MODULE)});
const [root, index, updates] = [process.argv[1], Number(process.argv[2]), Number(process.argv[3])];
let buf = '';
let went = false;
process.stdin.on('data', (d) => {
  if (went) return;
  buf += d;
  const m = /go (\\d+)/.exec(buf);
  if (!m) return;
  went = true;
  // Sleep (synchronously, to the millisecond) to the shared instant.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.max(0, Number(m[1]) - Date.now()));
  reg.registerMcp({ root, pid: process.pid });
  for (let k = 1; k <= updates; k++) reg.updateMcp(process.pid, { last_tool_at: k });
  reg.registerInstance({ root, port: 41000 + index, pid: process.pid });
  if (index % 2) reg.deregisterInstance(root, { pid: process.pid });
  process.stdout.write('done\\n');
});
process.stdin.on('end', () => process.exit(0));
process.stdout.write('ready\\n');
`;

async function race(t, run) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), `wc-rlock-home${run}-`));
  t.after(() => { try { fs.rmSync(home, { recursive: true, force: true }); } catch {} });
  const roots = Array.from({ length: WRITERS }, (_, i) => project(t, `r${run}w${i}`));
  const kids = roots.map((root, i) => {
    const child = spawn(process.execPath, ['-e', WORKER, root, String(i), String(UPDATES)], {
      env: { ...process.env, HOME: home, USERPROFILE: home },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const k = { child, root, index: i, out: '', err: '' };
    child.stdout.on('data', (d) => { k.out += d; });
    child.stderr.on('data', (d) => { k.err += d; });
    return k;
  });
  const cleanup = () => { for (const k of kids) { try { k.child.kill('SIGKILL'); } catch {} } };
  t.after(cleanup);
  try {
    await waitUntil(() => kids.every((k) => k.out.includes('ready')), { timeout: 20000, what: `run ${run}: every writer ready` });
    const at = Date.now() + 150;
    for (const k of kids) k.child.stdin.write(`go ${at}\n`);
    await waitUntil(() => kids.every((k) => k.out.includes('done')), { timeout: 20000, what: `run ${run}: every writer done` });

    const prevHome = process.env.HOME;
    process.env.HOME = home;
    let all; let known;
    try {
      all = registry.readAllEntries();
      known = JSON.parse(fs.readFileSync(registry.knownPath(), 'utf8')).projects;
    } finally { process.env.HOME = prevHome; }
    const errs = kids.map((k) => k.err).join('');

    const mcp = all.filter((e) => e.role === 'mcp');
    assert.deepStrictEqual(mcp.map((e) => e.pid).sort(), kids.map((k) => k.child.pid).sort(),
      `run ${run}: every session's presence row survives (stderr: ${errs || 'none'})`);
    for (const e of mcp) assert.strictEqual(e.last_tool_at, UPDATES, `run ${run}: pid ${e.pid}'s last update landed`);

    const instances = all.filter((e) => e.role === 'instance');
    const kept = kids.filter((k) => k.index % 2 === 0);
    assert.deepStrictEqual(instances.map((e) => e.root).sort(), kept.map((k) => k.root).sort(),
      `run ${run}: every daemon row that was not released survives, and every released one is gone`);

    assert.deepStrictEqual(known.map((p) => p.root).sort(), roots.slice().sort(),
      `run ${run}: every booted project is remembered in projects.json`);
    assert.ok(!fs.existsSync(path.join(home, '.web-chat', 'instances.json.lock')), `run ${run}: no lock left behind`);
    assert.doesNotMatch(errs, /web-chat registry/, `run ${run}: no writer broke a lock or wrote without one`);
  } finally {
    for (const k of kids) { try { k.child.stdin.end(); } catch {} }
    await waitUntil(() => kids.every((k) => k.child.exitCode !== null || k.child.signalCode !== null), { timeout: 5000 });
    cleanup();
  }
}

test('eight writers released at one barrier lose no row, update or known project — three runs', { timeout: 90000 }, async (t) => {
  for (let run = 1; run <= 3; run++) await race(t, run);
});

test('a lock whose holder is gone is broken, said, and the write lands at once', (t) => {
  withTempHome(t);
  const root = project(t, 'dead');
  fs.mkdirSync(path.dirname(lockFile()), { recursive: true });
  fs.writeFileSync(lockFile(), `${DEAD_PID}\n`);
  const started = Date.now();
  const { text } = stderrOf(() => registry.registerMcp({ root }));
  assert.ok(Date.now() - started < registry.LOCK_WAIT_MS / 2, 'no wait for a dead holder');
  assert.match(text, new RegExp(`broke a stale instances\\.json\\.lock \\(its holder, pid ${DEAD_PID}, is gone\\)`));
  assert.ok(!fs.existsSync(lockFile()), 'the broken lock is gone and ours released');
  assert.ok(registry.readAllEntries().some((e) => e.id === registry.mcpId(process.pid)), 'the row was written');
  assert.deepStrictEqual(fs.readdirSync(path.dirname(lockFile())).filter((f) => f.includes('.lock')), [], 'no aside file left');
});

test('a lock older than LOCK_STALE_MS is broken even when its pid is alive', (t) => {
  withTempHome(t);
  const root = project(t, 'old');
  fs.mkdirSync(path.dirname(lockFile()), { recursive: true });
  fs.writeFileSync(lockFile(), `${process.pid}\n`);
  const then = (Date.now() - registry.LOCK_STALE_MS - 5000) / 1000;
  fs.utimesSync(lockFile(), then, then);
  const started = Date.now();
  const { text } = stderrOf(() => registry.registerMcp({ root }));
  assert.ok(Date.now() - started < registry.LOCK_WAIT_MS / 2, 'no wait for a stale lock');
  assert.match(text, /broke a stale instances\.json\.lock \(it is \d+s old\)/);
  assert.ok(!fs.existsSync(lockFile()));
  assert.ok(registry.readAllEntries().some((e) => e.id === registry.mcpId(process.pid)));
});

test('a live lock is waited on for LOCK_WAIT_MS at most, then the write goes ahead without it and says so', (t) => {
  withTempHome(t);
  const root = project(t, 'held');
  fs.mkdirSync(path.dirname(lockFile()), { recursive: true });
  const holder = `${process.pid}\n`;
  fs.writeFileSync(lockFile(), holder);
  const started = Date.now();
  const { text } = stderrOf(() => registry.registerMcp({ root }));
  const waited = Date.now() - started;
  assert.ok(waited >= registry.LOCK_WAIT_MS - 50, `waited ${waited}ms, the whole bounded wait`);
  assert.ok(waited < registry.LOCK_WAIT_MS + 1500, `waited ${waited}ms, not much past the bound`);
  assert.match(text, new RegExp(`instances\\.json\\.lock still held after ${registry.LOCK_WAIT_MS}ms; writing without it`));
  assert.ok(registry.readAllEntries().some((e) => e.id === registry.mcpId(process.pid)), 'the write went ahead');
  assert.strictEqual(fs.readFileSync(lockFile(), 'utf8'), holder, "the holder's lock is left alone");
});

test('a write that fails still releases the lock', (t) => {
  withTempHome(t);
  const root = project(t, 'fail');
  // A directory where the file goes: the read falls back to empty, the atomic
  // rename onto it throws, and registerMcp swallows that as it always has.
  fs.mkdirSync(registry.registryPath(), { recursive: true });
  const { text } = stderrOf(() => registry.registerMcp({ root }));
  assert.strictEqual(text, '');
  assert.ok(!fs.existsSync(lockFile()), 'released on the throw');
  assert.strictEqual(registry.updateMcp(process.pid, { channel: true }), false);
  assert.ok(!fs.existsSync(lockFile()));
});

test('nothing to change takes no lock and creates no ~/.web-chat', (t) => {
  const home = withTempHome(t);
  assert.strictEqual(registry.deregisterMcp({ pid: process.pid }), false);
  assert.strictEqual(registry.updateMcp(process.pid, { last_tool_at: 1 }), false);
  assert.strictEqual(registry.deregisterInstance(path.join(home, 'nowhere'), { pid: process.pid }), false);
  assert.deepStrictEqual(registry.readAllLive(), []);
  assert.deepStrictEqual(fs.readdirSync(home), [], 'the user tier is not first-touched');
});

test('registerInstance holds one lock across both files without waiting on itself', (t) => {
  withTempHome(t);
  const root = project(t, 'boot');
  const started = Date.now();
  const { text, value } = stderrOf(() => registry.registerInstance({ root, port: 41999, pid: process.pid }));
  assert.ok(Date.now() - started < registry.LOCK_WAIT_MS / 2, 'no self-wait');
  assert.strictEqual(text, '', 'nothing to say');
  assert.ok(!fs.existsSync(lockFile()));
  assert.ok(registry.readAllEntries().some((e) => e.id === value.id), 'the daemon row');
  assert.ok(registry.sessions().some((r) => r.root === root && r.known), 'and the known project');
  // A dead row read by a later reader is pruned under the lock too.
  const raw = JSON.parse(fs.readFileSync(registry.registryPath(), 'utf8'));
  raw.instances.push({ id: 'deadbeef', role: 'instance', root: '/nowhere', port: 1, pid: DEAD_PID });
  fs.writeFileSync(registry.registryPath(), JSON.stringify(raw));
  assert.deepStrictEqual(registry.readInstances().map((e) => e.id), [value.id]);
  assert.deepStrictEqual(registry.readAllEntries().map((e) => e.id), [value.id], 'the prune was written');
  assert.ok(!fs.existsSync(lockFile()));
});

// ── F-16: a break never moves a lock it did not judge ───────────────────────
// breakIfStale judges a lock stale, then moves what is at its path aside. Two
// waiters judging one dead lock is the ordinary case (sessions starting at
// once), and the code it replaced let the second move the FRESH lock the first
// had taken in the meantime: the path stood empty, a third writer took the lock
// there, the move could not be undone, and the fresh lock was deleted — two
// writers inside the lock at once. The interleavings are driven here step by
// step, in one process, by hooking the fs calls the breaker (B) makes: no sleep
// and no real race.
//
//   A  another waiter, run just before the B call `before` picks: one turn of
//      acquireLock (create the lock; else break a stale one, then create it);
//   C  a third writer, which creates the lock the instant B leaves the path
//      empty (unless `third: false`).
//
// `holders` maps each writer that created a lock to that file's inode.

function driveBreak({ before, a, third = true }) {
  const file = lockFile();
  const dir = path.dirname(file);
  const real = { openSync: fs.openSync, renameSync: fs.renameSync, linkSync: fs.linkSync, unlinkSync: fs.unlinkSync };
  const inDir = (p) => path.dirname(path.resolve(String(p))) === dir;
  // The calls that change the lock directory, which is all an interleaving is made of.
  const changes = {
    openSync: (p, flags) => flags === 'wx' && inDir(p),
    renameSync: (p) => inDir(p),
    linkSync: (p) => inDir(p),
    unlinkSync: (p) => inDir(p),
  };
  const holders = new Map();
  const create = (who) => {
    let fd;
    try { fd = fs.openSync(file, 'wx'); } catch (e) { if (e.code === 'EEXIST') return false; throw e; }
    fs.writeSync(fd, `${process.pid}\n`);
    fs.closeSync(fd);
    holders.set(who, fs.statSync(file).ino);
    return true;
  };
  const turn = (who) => create(who) || (registry.breakIfStale(file) && create(who));
  let hooked = true;
  let count = 0;
  let injected = false;
  const others = (fn) => { hooked = false; try { fn(); } finally { hooked = true; } };
  for (const [name, isChange] of Object.entries(changes)) {
    fs[name] = function hookedCall(...args) {
      if (!hooked || !isChange(...args)) return real[name].apply(fs, args);
      count++;
      if (!injected && before(name, args, count)) {
        injected = true;
        others(() => (a ? a({ file, turn, create }) : turn('A')));
      }
      try {
        return real[name].apply(fs, args);
      } finally {
        if (third && !holders.has('C') && !fs.existsSync(file)) others(() => create('C'));
      }
    };
  }
  let out;
  try {
    out = stderrOf(() => registry.breakIfStale(file));
  } finally {
    Object.assign(fs, real);
  }
  const left = fs.readdirSync(dir).filter((f) => f.startsWith(path.basename(file))).sort();
  return { result: out.value, text: out.text, holders, injected, changes: count, left };
}

function freshStaleLock(body = `${DEAD_PID}\n`) {
  const dir = path.dirname(lockFile());
  fs.mkdirSync(dir, { recursive: true });
  for (const f of fs.readdirSync(dir)) fs.rmSync(path.join(dir, f), { force: true });
  fs.writeFileSync(lockFile(), body);
}

const inodeOf = (f) => fs.statSync(f).ino;

test('F-16: a waiter that judged a lock stale never moves the fresh lock that replaced it', (t) => {
  withTempHome(t);
  freshStaleLock();
  // A breaks the dead lock and takes a fresh one after B judged it, before B
  // has changed anything; C is ready to take the lock the moment the path is empty.
  const r = driveBreak({ before: (name, args, n) => n === 1 });
  assert.ok(r.injected, 'A ran');
  assert.ok(r.holders.has('A'), 'A broke the dead lock and took the lock');
  assert.deepStrictEqual([...r.holders.keys()], ['A'], 'and no second writer got the lock beside it');
  assert.strictEqual(inodeOf(lockFile()), r.holders.get('A'), "the lock is still the file A created — never moved, never deleted");
  assert.deepStrictEqual(r.left, ['instances.json.lock'], 'nothing is left beside it');
  assert.strictEqual(r.result, false, 'B waits for A');
});

test('F-16: wherever the other waiter acts, one writer at most holds the lock, on the file it created', (t) => {
  withTempHome(t);
  for (let k = 1; ; k++) {
    freshStaleLock();
    const r = driveBreak({ before: (name, args, n) => n === k });
    const who = [...r.holders.keys()];
    assert.ok(who.length <= 1, `A before B's change ${k}: ${who.join(' and ')} both hold the lock`);
    if (who.length) {
      assert.strictEqual(inodeOf(lockFile()), r.holders.get(who[0]), `A before B's change ${k}: ${who[0]}'s lock was moved`);
      assert.deepStrictEqual(r.left, ['instances.json.lock'], `A before B's change ${k}: left beside the lock`);
    } else {
      assert.deepStrictEqual(r.left, [], `A before B's change ${k}: left behind`);
    }
    if (!r.injected) break; // B made fewer than k changes: every point is covered
  }
});

test('a lock whose live holder lets go between the look and the move is put back, not deleted', (t) => {
  withTempHome(t);
  // Stale by age only: its holder (this process) is alive. Just before B moves
  // it, the holder releases it and A takes the lock — so what B moves is A's.
  const aged = () => {
    freshStaleLock(`${process.pid}\n`);
    const then = (Date.now() - registry.LOCK_STALE_MS - 5000) / 1000;
    fs.utimesSync(lockFile(), then, then);
  };
  const beforeMove = (name, args) => name === 'renameSync' && path.resolve(String(args[0])) === lockFile();
  const releaseThenA = ({ file, turn }) => { fs.unlinkSync(file); turn('A'); };

  aged();
  const back = driveBreak({ before: beforeMove, a: releaseThenA, third: false });
  assert.ok(back.injected && back.holders.has('A'));
  assert.strictEqual(inodeOf(lockFile()), back.holders.get('A'), "A's lock is back where A created it, the same file");
  assert.deepStrictEqual(back.left, ['instances.json.lock']);
  assert.strictEqual(back.result, false);

  // And when a third writer took the empty path before it could go back, A's
  // lock is kept beside it and said, never deleted.
  aged();
  const kept = driveBreak({ before: beforeMove, a: releaseThenA });
  assert.ok(kept.holders.has('A') && kept.holders.has('C'));
  assert.strictEqual(inodeOf(lockFile()), kept.holders.get('C'));
  const dir = path.dirname(lockFile());
  const asideA = kept.left.find((f) => f !== 'instances.json.lock' && inodeOf(path.join(dir, f)) === kept.holders.get('A'));
  assert.ok(asideA, `A's lock was deleted (left: ${kept.left.join(', ')})`);
  assert.match(kept.text, new RegExp(`kept it as ${asideA.replace(/[.]/g, '\\.')}`));
});

test('a break another waiter has claimed is left to it: the lock and the claim stay, and this one waits', (t) => {
  withTempHome(t);
  freshStaleLock();
  const claim = `${lockFile()}.break`;
  fs.writeFileSync(claim, `${process.pid}\n`); // a live waiter's claim, just taken
  const { value, text } = stderrOf(() => registry.breakIfStale(lockFile()));
  assert.strictEqual(value, false, 'wait for the waiter breaking it');
  assert.strictEqual(fs.readFileSync(lockFile(), 'utf8'), `${DEAD_PID}\n`, 'the stale lock is that waiter\'s to break');
  assert.ok(fs.existsSync(claim), 'and its claim is not touched');
  assert.strictEqual(text, '');
});

test('a claim left by a breaker that died is cleared, then the stale lock is broken and the write lands', (t) => {
  withTempHome(t);
  const root = project(t, 'claim');
  freshStaleLock();
  fs.writeFileSync(`${lockFile()}.break`, `${DEAD_PID + 1}\n`);
  const started = Date.now();
  const { text } = stderrOf(() => registry.registerMcp({ root }));
  assert.ok(Date.now() - started < registry.LOCK_WAIT_MS / 2, 'no wait for a dead breaker');
  assert.match(text, new RegExp(`broke a stale instances\\.json\\.lock\\.break \\(its holder, pid ${DEAD_PID + 1}, is gone\\)`));
  assert.match(text, new RegExp(`broke a stale instances\\.json\\.lock \\(its holder, pid ${DEAD_PID}, is gone\\)`));
  assert.ok(registry.readAllEntries().some((e) => e.id === registry.mcpId(process.pid)), 'the row was written');
  assert.deepStrictEqual(fs.readdirSync(path.dirname(lockFile())).filter((f) => f.includes('.lock')), [], 'no lock, claim or aside file left');
});

test('a break whose rename fails for another reason than ENOENT leaves the lock alone, and waits', (t) => {
  withTempHome(t);
  freshStaleLock();
  const real = fs.renameSync;
  fs.renameSync = function renameRefused(from, ...rest) {
    if (path.resolve(String(from)) === lockFile()) throw Object.assign(new Error('EPERM: operation not permitted, rename'), { code: 'EPERM' });
    return real.call(fs, from, ...rest);
  };
  let out;
  try { out = stderrOf(() => registry.breakIfStale(lockFile())); } finally { fs.renameSync = real; }
  // "Gone, retry at once" here would be a lie the next turn repeats: the lock
  // is still there, and the same rename will fail the same way.
  assert.strictEqual(out.value, false, 'wait');
  assert.strictEqual(fs.readFileSync(lockFile(), 'utf8'), `${DEAD_PID}\n`, 'the lock is untouched');
  assert.deepStrictEqual(fs.readdirSync(path.dirname(lockFile())).filter((f) => f.startsWith('instances.json.lock')),
    ['instances.json.lock'], 'and the claim is released, no aside left');
  assert.strictEqual(out.text, '');
});
