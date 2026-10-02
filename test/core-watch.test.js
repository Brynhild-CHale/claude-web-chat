// The file-watch engine (lib/core/watch.js): one debounced, single-flight
// onTrigger fed by a file watch that follows the inode, an optional directory
// watch, and a mandatory poll.
//
// No test here opens a real DIRECTORY watcher. On macOS that is FSEvents, whose
// close() blocked the event loop for up to ~25 s under load when it was measured
// for the chat mirror, so the directory watch is driven through a stand-in
// fs.watch (fakeWatch). File watches are real (kqueue on macOS, inotify on
// Linux, both cheap to close). A test that needs an event from one waits for
// armed() first: kqueue registers a new watch with the kernel only at the
// loop's next poll phase, and an append made before that is never reported.
//
// Every watch a test awaits is persistent (the default), or awaited through
// waitUntil and sleeps, whose timers are ref'd: on Node 22 a test awaiting a
// promise that only unref'd handles can resolve is cancelled.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { execFile } = require('child_process');
const { waitUntil } = require('../test-support/helpers');
const { watchFile } = require('../lib/core/watch');

const WATCH_JS = path.join(__dirname, '..', 'lib', 'core', 'watch.js');
const NEVER = 60_000; // a poll that does not fire during a test
const WAIT = { timeout: 10_000 };

function tmpDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-watch-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Two turns of the loop, so a poll phase has run since the engine opened its
// watch (two check phases always have one between them): only then is a new
// kqueue watch in the kernel.
const armed = () => new Promise((resolve) => setImmediate(() => setImmediate(resolve)));

// Replace `file` the way writeJsonAtomic and most editors do: a sibling file
// renamed over it, so the path names a new inode.
function replaceFile(file, text) {
  const next = `${file}.next`;
  fs.writeFileSync(next, text);
  fs.renameSync(next, file);
}

// A watch whose onTrigger records each call's source and the file's size then
// (null while it does not exist).
function recorder(t, file, opts) {
  const calls = [];
  const w = watchFile(file, (src) => {
    let size = null;
    try { size = fs.statSync(file).size; } catch {}
    calls.push({ src, size });
  }, opts);
  t.after(() => w.stop());
  return { w, calls };
}

const fileEvents = (w) => w.stats.triggers.file || 0;

// A stand-in for fs.watch: it records each call and hands back a watcher the
// test drives by hand (fire(event, name), emit('error')), so no real watcher —
// and no FSEvents close — is involved.
function fakeWatch(t) {
  const opened = [];
  t.mock.method(fs, 'watch', (target, opts, listener) => {
    const w = new EventEmitter();
    Object.assign(w, { target, opts, closed: 0 });
    w.close = () => { w.closed += 1; };
    w.fire = (event, name) => listener(event, name);
    opened.push(w);
    return w;
  });
  return opened;
}

// The handles that keep the event loop alive, by kind.
function liveHandles() {
  const n = { FSEventWrap: 0, Timeout: 0, Immediate: 0 };
  for (const kind of process.getActiveResourcesInfo()) if (kind in n) n[kind] += 1;
  return n;
}
const handleDelta = (from, to) => Object.fromEntries(Object.keys(from).map((k) => [k, to[k] - from[k]]));

// Run a script in a fresh node with watch.js's path and `args` as its argv, and
// say how it ended. A child that does not exit on its own is killed at the
// timeout, which is the failure the callers look for.
function runChild(script, args) {
  return new Promise((resolve) => {
    execFile(process.execPath, ['-e', script, WATCH_JS, ...args], { timeout: 30_000 }, (error, stdout, stderr) => {
      resolve({ error, stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

test('an append triggers onTrigger, through the file watch alone', async (t) => {
  const file = path.join(tmpDir(t), 'log.jsonl');
  fs.writeFileSync(file, 'one\n');
  const { w, calls } = recorder(t, file, { pollMs: NEVER });
  assert.ok(w.stats.watching, 'a file that exists is watched from the start');
  assert.equal(w.stats.fileWatches, 1);
  assert.equal(calls.length, 0, 'the engine makes no call of its own at the start');

  await armed();
  fs.appendFileSync(file, 'two\n');
  await waitUntil(() => calls.length > 0, { ...WAIT, what: 'a call after the append' });
  assert.deepEqual([...new Set(calls.map((c) => c.src))], ['file'], 'the poll never fired: the watch did');
  assert.equal(calls.at(-1).size, 8, 'and the call came after the append');
});

test('an atomic replace (a new inode) is followed: the watch moves to the new inode', async (t) => {
  const file = path.join(tmpDir(t), 'state.json');
  fs.writeFileSync(file, '{"a":1}');
  const { w, calls } = recorder(t, file, { pollMs: 100 });
  const first = w.stats.watching;
  assert.ok(first);

  await armed();
  replaceFile(file, '{"a":2,"b":3}');
  await waitUntil(() => w.stats.watching && w.stats.watching !== first, { ...WAIT, what: 'a watch on the new inode' });
  assert.equal(w.stats.fileWatches, 2, 'one new watch, for the new inode');
  assert.ok(calls.some((c) => c.size === 13), 'and a call that saw the new content');

  // The old watch was closed, so an event now can only be the new inode's.
  await armed();
  const before = fileEvents(w);
  fs.appendFileSync(file, '\n');
  await waitUntil(() => fileEvents(w) > before, { ...WAIT, what: 'an event from the new inode\'s watch' });
});

test('a delete then a re-create is followed', async (t) => {
  const file = path.join(tmpDir(t), 'out.log');
  fs.writeFileSync(file, 'one\n');
  const { w, calls } = recorder(t, file, { pollMs: 100 });
  assert.ok(w.stats.watching);

  fs.unlinkSync(file);
  await waitUntil(() => w.stats.watching === null, { ...WAIT, what: 'the watch dropped while the file is gone' });
  assert.equal(calls.at(-1).size, null, 'the call saw it gone');

  // Possibly the same inode number again (ext4 reuses them): the watch was
  // dropped in between, so a new one is opened whatever its number.
  fs.writeFileSync(file, 'again\n');
  await waitUntil(() => w.stats.watching !== null, { ...WAIT, what: 'a watch on the re-created file' });
  assert.equal(w.stats.fileWatches, 2);
  assert.equal(calls.at(-1).size, 6, 'the call that re-opened it saw the new file');

  await armed();
  const before = fileEvents(w);
  fs.appendFileSync(file, 'more\n');
  await waitUntil(() => fileEvents(w) > before, { ...WAIT, what: 'an event from the re-created file\'s watch' });
});

test('a file that does not exist yet (nor its directory) is polled until it appears, then watched', async (t) => {
  const file = path.join(tmpDir(t), 'later', 'x.jsonl');
  const { w, calls } = recorder(t, file, { pollMs: 50 });
  assert.equal(w.stats.watching, null, 'nothing to watch yet');
  await waitUntil(() => calls.length >= 2, { ...WAIT, what: 'polls while it is absent' });
  assert.ok(calls.every((c) => c.src === 'poll' && c.size === null), JSON.stringify(calls));

  fs.mkdirSync(path.dirname(file));
  fs.writeFileSync(file, 'hello\n');
  await waitUntil(() => calls.some((c) => c.size === 6), { ...WAIT, what: 'the poll finding it' });
  assert.ok(w.stats.watching, 'from then on it is watched');
  assert.equal(w.stats.dirWatches, 0, 'with no directory watcher opened to wait for it');

  await armed();
  const before = fileEvents(w);
  fs.appendFileSync(file, 'world\n');
  await waitUntil(() => fileEvents(w) > before, { ...WAIT, what: 'an event from the new file\'s watch' });
});

test('the window: triggers inside one are one call, and a steady stream still gets a call per window', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'setImmediate'] });
  const file = path.join(tmpDir(t), 'absent');
  const calls = [];
  const w = watchFile(file, (src) => { calls.push(src); }, { pollMs: 10_000, debounceMs: 50, fileWatch: false });
  t.after(() => w.stop());

  w.trigger('a');
  w.trigger('b');
  w.trigger('c');
  t.mock.timers.tick(49);
  assert.deepEqual(calls, [], 'still inside the window');
  t.mock.timers.tick(1);
  assert.deepEqual(calls, ['a'], 'one call, named for the trigger that opened the window');
  assert.equal(w.stats.coalesced, 2);

  // A trigger every 20 ms for 200 ms: a window that slid on each one would not
  // fire until the stream stopped.
  for (let i = 0; i < 10; i += 1) {
    w.trigger('s');
    t.mock.timers.tick(20);
  }
  assert.deepEqual(calls, ['a', 's', 's', 's'], 'a call per 50 ms window, mid-stream');
  t.mock.timers.tick(30);
  assert.equal(calls.length, 5, 'and the last window fires after the stream');

  // 280 ms in: the poll fires at 10 s and opens a window like any trigger
  // (MockTimers runs a timer set inside a tick only on a later tick).
  t.mock.timers.tick(10_000 - 280);
  assert.equal(calls.length, 5);
  t.mock.timers.tick(50);
  assert.deepEqual(calls.slice(5), ['poll'], 'the poll rides the same window');
  const triggered = Object.values(w.stats.triggers).reduce((a, b) => a + b, 0);
  assert.equal(triggered, w.stats.calls + w.stats.coalesced, 'every trigger is a call or joined one');
});

test('single flight: triggers that arrive during a slow onTrigger become exactly one follow-up call', async (t) => {
  const file = path.join(tmpDir(t), 'absent');
  const srcs = [];
  const gates = [];
  let active = 0;
  let most = 0;
  const w = watchFile(file, (src) => {
    srcs.push(src);
    active += 1;
    most = Math.max(most, active);
    return new Promise((resolve) => {
      let open = true;
      gates.push(() => { if (open) { open = false; active -= 1; resolve(); } });
    });
  }, { pollMs: NEVER, fileWatch: false });
  t.after(async () => { for (const release of gates) release(); await w.stop(); });

  const first = w.trigger('first');
  await waitUntil(() => srcs.length === 1, { ...WAIT, what: 'the first call' });
  let laterSettled = false;
  const later = Promise.all([w.trigger('a'), w.trigger('b')]).then(() => { laterSettled = true; });
  await sleep(20); // their window fires while 'first' still runs
  const last = w.trigger('c'); // and so does this one's, later
  await sleep(20);
  assert.deepEqual(srcs, ['first'], 'nothing runs beside a call in flight');

  gates[0]();
  await first;
  await waitUntil(() => srcs.length === 2, { ...WAIT, what: 'the follow-up call' });
  assert.deepEqual(srcs, ['first', 'a'], 'ONE follow-up for all three, named for the first of them');
  assert.equal(laterSettled, false, 'a trigger waits for a call that began after it, not the one in flight');

  gates[1]();
  await later;
  await last;
  await sleep(50);
  assert.equal(srcs.length, 2, 'and nothing after it');
  assert.equal(most, 1, 'never two at once');
  assert.equal(w.stats.calls, 2);
  assert.equal(w.stats.coalesced, 2, 'b joined a\'s window; c\'s window joined the pending follow-up');
});

test('a throw or a rejection from onTrigger is counted and logged, and the funnel carries on', async (t) => {
  const file = path.join(tmpDir(t), 'absent');
  const lines = [];
  let n = 0;
  const w = watchFile(file, () => {
    n += 1;
    if (n === 1) throw new Error('sync boom');
    if (n === 2) return Promise.reject(new Error('async boom'));
    return undefined;
  }, { pollMs: NEVER, fileWatch: false, log: (line) => lines.push(line) });
  t.after(() => w.stop());

  await w.trigger('one');
  await w.trigger('two');
  await w.trigger('three');
  assert.equal(n, 3);
  assert.equal(w.stats.errors, 2);
  assert.ok(lines.some((l) => /sync boom/.test(l)) && lines.some((l) => /async boom/.test(l)), lines.join('\n'));
});

test('fileWatch:false runs on the poll alone', async (t) => {
  const file = path.join(tmpDir(t), 'polled.txt');
  fs.writeFileSync(file, 'a\n');
  const watch = t.mock.method(fs, 'watch'); // a spy: the real fs.watch underneath
  const { w, calls } = recorder(t, file, { pollMs: 50, fileWatch: false });

  fs.appendFileSync(file, 'b\n');
  await waitUntil(() => calls.some((c) => c.size === 4), { ...WAIT, what: 'the poll seeing the append' });
  assert.equal(watch.mock.callCount(), 0, 'no watcher of any kind');
  assert.deepEqual(Object.keys(w.stats.triggers), ['poll']);
  assert.equal(w.stats.fileWatches, 0);
  assert.equal(w.stats.watching, null);
});

test('retarget moves the watch to another file, and makes a call for it', async (t) => {
  const dir = tmpDir(t);
  const a = path.join(dir, 'a.jsonl');
  const b = path.join(dir, 'b.jsonl');
  fs.writeFileSync(a, 'a\n');
  fs.writeFileSync(b, 'bb\n');
  const srcs = [];
  const w = watchFile(a, (src) => { srcs.push(src); }, { pollMs: NEVER });
  t.after(() => w.stop());
  const onA = w.stats.watching;

  await w.retarget(b);
  assert.deepEqual(srcs, ['retarget'], 'the call it asked for has run');
  assert.ok(w.stats.watching && w.stats.watching !== onA, 'it watches b now');

  await armed();
  fs.appendFileSync(a, 'not ours\n');
  await sleep(100);
  assert.deepEqual(srcs, ['retarget'], 'a is no longer watched');
  fs.appendFileSync(b, 'ours\n');
  await waitUntil(() => srcs.length > 1, { ...WAIT, what: 'a call from b\'s watch' });
  assert.ok(srcs.slice(1).every((s) => s === 'file'), srcs.join());
});

test('dirWatch: ONE directory watcher for the life of the watch, filtered to the basename; an error closes it for good', async (t) => {
  const dir = tmpDir(t);
  const file = path.join(dir, 'tunnel.json');
  const opened = fakeWatch(t);
  const { w, calls } = recorder(t, file, { dirWatch: true, fileWatch: false, pollMs: 20 });
  assert.equal(opened.length, 1);
  const [dw] = opened;
  assert.equal(dw.target, dir, 'the file\'s directory');
  assert.deepEqual(dw.opts, { persistent: true });
  assert.equal(w.stats.watchingDir, true);
  await waitUntil(() => calls.length >= 3, { ...WAIT, what: 'a few polls' });
  assert.equal(opened.length, 1, 'the poll never opens another');

  // Counted as they enter the funnel. (Which source names the call they become
  // depends on whether a poll's window is open: the retarget test below, with
  // no poll, sees the call itself.)
  const dirTriggers = () => w.stats.triggers.dir || 0;
  dw.fire('rename', 'other.json');
  dw.fire('change', 'tunnel.json.4242.next');
  assert.equal(dirTriggers(), 0, 'another file in the directory is not this one');
  dw.fire('rename', 'tunnel.json');
  dw.fire('change', null); // a platform that names no file: check rather than miss it
  dw.fire('change', '');
  assert.equal(dirTriggers(), 3, 'its own name, or no name, is a trigger');

  dw.emit('error', Object.assign(new Error('gone'), { code: 'EPERM' }));
  assert.equal(dw.closed, 1, 'an erroring directory watcher is closed');
  assert.equal(w.stats.watchingDir, false);
  assert.equal(w.stats.watchErrors, 1);
  const n = calls.length;
  await waitUntil(() => calls.length >= n + 3, { ...WAIT, what: 'polls after the error' });
  assert.equal(opened.length, 1, 'and never re-opened: the poll carries on alone');
  await w.stop();
  assert.equal(dw.closed, 1, 'stop() does not close it a second time');
});

test('retarget keeps the one directory watcher within its directory, and moves it to another', async (t) => {
  const d1 = tmpDir(t);
  const d2 = tmpDir(t);
  const opened = fakeWatch(t);
  const { w, calls } = recorder(t, path.join(d1, 'a.json'), { dirWatch: true, fileWatch: false, pollMs: NEVER });

  await w.retarget(path.join(d1, 'b.json'));
  assert.equal(opened.length, 1, 'same directory, same watcher');
  opened[0].fire('change', 'a.json');
  opened[0].fire('change', 'b.json');
  await waitUntil(() => calls.some((c) => c.src === 'dir'), { ...WAIT, what: 'a call for b' });
  assert.equal(w.stats.triggers.dir, 1, 'the filter follows the new name');

  await w.retarget(path.join(d2, 'c.json'));
  assert.equal(opened.length, 2);
  assert.equal(opened[0].closed, 1, 'the old directory\'s watcher is closed');
  assert.equal(opened[1].target, d2);
});

test('only a regular file gets a file watch: fs.watch on a directory would be an FSEvents watcher', async (t) => {
  const dir = tmpDir(t);
  const opened = fakeWatch(t);
  const { w, calls } = recorder(t, dir, { pollMs: 20 });
  await waitUntil(() => calls.length >= 2, { ...WAIT, what: 'polls' });
  assert.equal(opened.length, 0);
  assert.equal(w.stats.watching, null);
});

test('persistent:false reaches both watchers, and leaves no ref\'d handle', async (t) => {
  const dir = tmpDir(t);
  const file = path.join(dir, 'tunnel.json');
  fs.writeFileSync(file, '{}');

  // Both watchers are asked for persistent:false (seen through the stand-in,
  // so no real directory watcher is opened).
  {
    const opened = fakeWatch(t);
    const w = watchFile(file, () => {}, { dirWatch: true, persistent: false, pollMs: NEVER });
    w.stop();
    assert.deepEqual(opened.map((o) => [o.target, o.opts]), [[dir, { persistent: false }], [file, { persistent: false }]]);
    t.mock.restoreAll();
  }

  // The real file watch, the poll and an open window: none of them is ref'd.
  const before = liveHandles();
  const w = watchFile(file, () => {}, { pollMs: 50, debounceMs: 10, persistent: false });
  w.trigger('open the window');
  const during = liveHandles();
  const watched = w.stats.watching;
  w.stop();
  assert.ok(watched, 'a real file watch was open');
  assert.deepEqual(handleDelta(before, during), { FSEventWrap: 0, Timeout: 0, Immediate: 0 });

  // The control: the same watch, persistent, holds the loop through each of
  // them until stop() lets go.
  const before2 = liveHandles();
  const held = watchFile(file, () => {}, { pollMs: 50, debounceMs: 10 });
  held.trigger('open the window');
  assert.deepEqual(handleDelta(before2, liveHandles()), { FSEventWrap: 1, Timeout: 2, Immediate: 0 },
    'the file watch, the poll and the window');
  await held.stop();
  await waitUntil(() => {
    const d = handleDelta(before2, liveHandles());
    return d.FSEventWrap <= 0 && d.Timeout <= 0;
  }, { ...WAIT, what: 'every handle released' });
});

test('persistent:false never holds a process open', async (t) => {
  const file = path.join(tmpDir(t), 'cfg.json');
  fs.writeFileSync(file, '{}');
  const script = `
    const [, watchJs, file] = process.argv;
    const w = require(watchJs).watchFile(file, () => {}, { pollMs: 20, debounceMs: 5, persistent: false });
    w.trigger('start');
    process.stdout.write(JSON.stringify({ watching: Boolean(w.stats.watching) }));
  `;
  const r = await runChild(script, [file]);
  assert.equal(r.error, null, `the child exited on its own — ${r.error && r.error.message} ${r.stderr}`);
  assert.deepEqual(JSON.parse(r.stdout), { watching: true });
});

// The child holds a file watch, a 20 ms poll and a 60 s window the poll opened
// (only stop() can clear it), all ref'd: if any of them outlived stop(), the
// child would not exit before the timeout.
test('stop() twice is harmless, and it stops every timer: a persistent watch\'s process then exits', async (t) => {
  const file = path.join(tmpDir(t), 'cfg.json');
  fs.writeFileSync(file, '{}');
  const script = `
    const [, watchJs, file] = process.argv;
    const w = require(watchJs).watchFile(file, () => {}, { pollMs: 20, debounceMs: 60000 });
    setTimeout(() => {
      const held = { watching: Boolean(w.stats.watching), windowOpen: w.stats.triggers.poll > 0 && w.stats.calls === 0 };
      w.stop();
      w.stop();
      process.stdout.write(JSON.stringify({ held, after: w.stats.watching }));
    }, 100);
  `;
  const r = await runChild(script, [file]);
  assert.equal(r.error, null, `a handle outlived stop() — ${r.error && r.error.message} ${r.stderr}`);
  assert.deepEqual(JSON.parse(r.stdout), { held: { watching: true, windowOpen: true }, after: null });
});

test('stop() waits for the call in flight, drops its follow-up, and nothing is called after it', async (t) => {
  const file = path.join(tmpDir(t), 'busy.log');
  fs.writeFileSync(file, 'x\n');
  let calls = 0;
  let release;
  const w = watchFile(file, () => {
    calls += 1;
    return calls === 1 ? new Promise((resolve) => { release = resolve; }) : undefined;
  }, { pollMs: 10, debounceMs: 5 });
  t.after(() => { if (release) release(); return w.stop(); });

  w.trigger('go');
  await waitUntil(() => calls === 1, { ...WAIT, what: 'a call in flight' });
  await waitUntil(() => w.stats.triggers.poll >= 3, { ...WAIT, what: 'polls arriving meanwhile' });
  let stopped = false;
  const first = w.stop().then(() => { stopped = true; });
  const second = w.stop();
  assert.equal(w.stats.watching, null, 'the watch is closed at once');
  await sleep(30);
  assert.equal(stopped, false, 'stop() waits for the call in flight');

  release();
  await first;
  await second;
  await sleep(60);
  assert.equal(calls, 1, 'the pending follow-up was dropped, and the poll is gone');
  await w.trigger('late');
  await w.retarget(path.join(path.dirname(file), 'other'));
  assert.equal(calls, 1, 'trigger and retarget after stop() resolve at once and call nothing');
  assert.equal(w.stats.watching, null);
});

test('bad arguments throw at once', () => {
  assert.throws(() => watchFile('', () => {}), TypeError);
  assert.throws(() => watchFile('/x', null), TypeError);
  for (const pollMs of [0, -1, Infinity, NaN, '100', 2 ** 31]) {
    assert.throws(() => watchFile('/x', () => {}, { pollMs }), RangeError, `pollMs ${String(pollMs)}`);
  }
  assert.throws(() => watchFile('/x', () => {}, { debounceMs: -1 }), RangeError);
});
