// The file-watch engine — one home for "tell me when this file may have
// changed". lib/portal/config-watch.js (the tunnel portal's tunnel.json and
// connector token) is a thin wrapper over it, and any other watcher of a file
// in lib/ — the daemon's follower of tunnel.json, the chat mirror's tailers — is
// built on it, never beside it.
//
//   watchFile(file, onTrigger, { pollMs = 2000, debounceMs = 0, dirWatch = false,
//                                fileWatch = true, persistent = true, log } = {})
//     → { trigger(src), retarget(file), stop(), stats }
//
// It never says WHAT changed. Every source — a file-watch event, a
// directory-watch event, the poll, a consumer's own trigger(src) — funnels into
// ONE debounced, single-flight call of onTrigger(src), and onTrigger goes and
// looks (stat, read, compare). `src` names the source for diagnostics only;
// nothing here branches on an event's name, because the names do not mean what
// they say: measured for the chat mirror (macOS, 2026-09), FSEvents reported
// most appends as `rename`, kqueue fired a spurious `rename` during a plain
// append burst, and both coalesced a burst into a handful of events.
//
// The sources:
//
//   * a file watch on `file` while it exists (`fileWatch`, the default).
//     kqueue (macOS) and inotify (Linux) bind the INODE, not the path: after an
//     atomic replace (a temp file renamed over it, which is how writeJsonAtomic
//     and most editors write) or a delete and re-create, a watch left alone stays
//     on the old inode and never fires again. So before every call the engine
//     stats the path and opens a new watch whenever the file's (dev, ino)
//     changed, it appeared, or its watcher errored; a file that is gone has none.
//     Only a regular file is watched: fs.watch on a directory is an FSEvents
//     watcher on macOS (below).
//
//   * a mandatory poll every `pollMs`, which triggers a call like any event.
//     fs.watch is best effort: a network or container filesystem may never fire
//     it; a new kqueue watch reaches the kernel only at the loop's next poll
//     phase, so a write before then is never reported; an inode number reused by
//     a delete and re-create (ext4 does that) looks like the inode already
//     watched; and a file that does not exist yet cannot be watched at all. It is
//     found by the poll's stat, never by a directory watcher opened to wait for it.
//
//   * with `dirWatch`, ONE long-lived fs.watch on the file's directory, filtered
//     to the basename (a platform that names no file counts as a match). Only
//     config-watch uses it. On macOS that is FSEvents, whose close() is
//     synchronous and, in the same measurements, blocked the event loop for up
//     to ~25 s under load. So it is opened once, at the start, and closed only by
//     stop() or a retarget to another directory. A directory missing at the
//     start, or a watcher that errored, is left to the poll and the file watch:
//     never re-opened on a timer.
//
// The funnel. A trigger opens a window of `debounceMs` (0: the next turn of the
// loop) and every trigger until it fires joins it, so one save's burst of events
// is one call. The window does not slide: a steady stream of triggers still gets
// a call per window instead of none until the stream stops (the poll rides this
// funnel too, and must not be starved by it). Calls run one at a time: a window
// that fires while onTrigger's promise is pending becomes ONE follow-up call,
// made as soon as it settles, however many triggers arrived meanwhile. A throw or
// a rejection is counted and logged, and the funnel carries on. onTrigger must
// settle; while it does not, nothing else is called.
//
// trigger(src) returns a promise that resolves once a call that BEGAN after it
// has settled — how a consumer waits for "read up to now" — or at stop(). It
// never rejects. The engine makes no call of its own at the start: a consumer
// that wants one asks (`await w.trigger('start')`).
//
// `persistent: false` unrefs everything (both watchers, the poll, the window),
// so the watch never holds a process open: config-watch's mode, in a portal
// whose server does that. Keep the default while something awaits what the
// watch delivers — a daemon's tailer, a test: on Node 22 (not 24 or 26), a
// node:test awaiting a promise that only unref'd handles can resolve is
// cancelled ("Promise resolution is still pending but the event loop has
// already resolved").
//
// stop() is idempotent. It closes both watchers, clears the poll and the window,
// drops a pending follow-up, resolves every trigger() still waiting, and returns
// a promise that resolves once a call in flight has settled (never await it from
// inside onTrigger, which that call is waiting on). Nothing is called after it.
//
// retarget(file) moves the watch to another path, and the directory watcher
// with it when the directory changes (a close: config-watch never retargets, and
// the mirror sets no directory watch), then triggers 'retarget' and returns that
// trigger's promise.
//
// `stats` is live; read it, never write it: calls, coalesced (triggers that
// joined an open window or a pending follow-up instead of starting a call),
// errors (onTrigger's throws and rejections), triggers (a count per source),
// fileWatches and dirWatches (watchers opened), watchErrors (watchers that
// failed to open or errored), and what is watched now: `watching` (the file
// watch's "dev:ino", or null) and `watchingDir`.
//
// Dependency rule: a lib/core leaf — Node built-ins only.

const fs = require('fs');
const path = require('path');

// setTimeout and setInterval turn a longer delay into 1 ms, so a "never" poll
// would become a busy one.
const MAX_DELAY_MS = 2 ** 31 - 1;

function checkDelay(name, value, min) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > MAX_DELAY_MS) {
    throw new RangeError(`watchFile: ${name} must be a number of milliseconds from ${min} to ${MAX_DELAY_MS}`);
  }
}

function checkPath(file, what) {
  if (typeof file !== 'string' || !file) throw new TypeError(`watchFile: ${what} must be a non-empty path`);
}

const codeOf = (e) => (e && e.code) || (e && e.message) || String(e);

function watchFile(file, onTrigger, {
  pollMs = 2000,
  debounceMs = 0,
  dirWatch = false,
  fileWatch = true,
  persistent = true,
  log,
} = {}) {
  checkPath(file, 'file');
  if (typeof onTrigger !== 'function') throw new TypeError('watchFile: onTrigger must be a function');
  checkDelay('pollMs', pollMs, 1);
  checkDelay('debounceMs', debounceMs, 0);
  // A consumer's logger must not be able to break the funnel.
  const note = (msg) => {
    if (typeof log !== 'function') return;
    try { log(msg); } catch {}
  };
  const hold = (handle) => {
    if (!persistent) handle.unref();
    return handle;
  };

  let target = path.resolve(file);
  let dir = path.dirname(target);
  let base = path.basename(target);

  const stats = {
    calls: 0,
    coalesced: 0,
    errors: 0,
    triggers: Object.create(null), // keyed by a consumer's src too: no prototype to collide with
    fileWatches: 0,
    dirWatches: 0,
    watchErrors: 0,
    watching: null,
    watchingDir: false,
  };

  let stopped = false;
  let fileWatcher = null;
  let dirWatcher = null;
  let fileFailure = null; // the last code a file watch failed to open with, so the poll logs it once
  let poller = null;
  let windowTimer = null; // the open debounce window: a Timeout, or an Immediate when debounceMs is 0
  let windowSrc = null;
  let running = false;
  let again = null; // the src of the one follow-up, while a call runs
  let inFlight = null; // resolves when the running call has settled
  let next = null; // { promise, resolve } for the trigger() calls waiting on the next call to begin

  // ── the file watch ──────────────────────────────────────────────────────────

  function closeFileWatch() {
    const w = fileWatcher;
    fileWatcher = null;
    stats.watching = null;
    if (w) { try { w.close(); } catch {} }
  }

  // Watch the inode the path names now, if that is a regular file not already
  // watched. Runs before every call, so a replace, a re-create or a watcher's
  // error is repaired by the next event, trigger or poll.
  function rearm() {
    if (!fileWatch || stopped) return;
    let st = null;
    try { st = fs.statSync(target, { bigint: true, throwIfNoEntry: false }) || null; } catch {}
    const id = st && st.isFile() ? `${st.dev}:${st.ino}` : null;
    if (fileWatcher && stats.watching === id) return;
    closeFileWatch();
    if (!id) return;
    let w;
    try {
      w = fs.watch(target, { persistent }, () => request('file'));
    } catch (e) {
      // ENOENT: gone since the stat. EMFILE, ENOSPC (inotify's limit): the
      // poll carries on, and the next call tries again.
      if (e && e.code === 'ENOENT') return;
      stats.watchErrors += 1;
      if (codeOf(e) !== fileFailure) note(`watch ${target}: cannot watch the file (${codeOf(e)}); polling every ${pollMs} ms`);
      fileFailure = codeOf(e);
      return;
    }
    fileFailure = null;
    w.on('error', (e) => {
      if (fileWatcher !== w) return;
      stats.watchErrors += 1;
      note(`watch ${target}: the file watch failed (${codeOf(e)}); it is re-opened at the next call`);
      closeFileWatch();
    });
    fileWatcher = w;
    stats.watching = id;
    stats.fileWatches += 1;
  }

  // ── the directory watch ─────────────────────────────────────────────────────

  function closeDirWatch() {
    const w = dirWatcher;
    dirWatcher = null;
    stats.watchingDir = false;
    if (w) { try { w.close(); } catch {} }
  }

  function openDirWatch() {
    if (!dirWatch || stopped || dirWatcher) return;
    let w;
    try {
      w = fs.watch(dir, { persistent }, (_event, name) => {
        // Some platforms do not say which file; check rather than miss one.
        if (!name || String(name) === base) request('dir');
      });
    } catch {
      return; // no directory: the poll and the file watch alone
    }
    w.on('error', (e) => {
      if (dirWatcher !== w) return;
      stats.watchErrors += 1;
      note(`watch ${dir}: the directory watch failed (${codeOf(e)}); the poll carries on`);
      closeDirWatch();
    });
    dirWatcher = w;
    stats.watchingDir = true;
    stats.dirWatches += 1;
  }

  // ── the funnel ──────────────────────────────────────────────────────────────

  function request(src) {
    if (stopped) return;
    stats.triggers[src] = (stats.triggers[src] || 0) + 1;
    if (windowTimer) {
      stats.coalesced += 1;
      return;
    }
    windowSrc = src;
    windowTimer = hold(debounceMs > 0 ? setTimeout(fire, debounceMs) : setImmediate(fire));
  }

  function fire() {
    windowTimer = null;
    const src = windowSrc;
    windowSrc = null;
    if (stopped) return;
    if (!running) {
      run(src);
    } else if (again === null) {
      again = src;
    } else {
      stats.coalesced += 1;
    }
  }

  function failed(e) {
    stats.errors += 1;
    note(`watch ${target}: onTrigger failed: ${(e && e.message) || e}`);
  }

  function run(src) {
    running = true;
    stats.calls += 1;
    const waiting = next;
    next = null;
    let settle;
    inFlight = new Promise((resolve) => { settle = resolve; });
    const done = () => {
      running = false;
      inFlight = null;
      settle();
      if (waiting) waiting.resolve();
      if (again !== null && !stopped) {
        const followUp = again;
        again = null;
        run(followUp);
      }
    };
    rearm();
    let result;
    try {
      result = onTrigger(src);
    } catch (e) {
      failed(e);
      done();
      return;
    }
    if (result && typeof result.then === 'function') {
      Promise.resolve(result).then(done, (e) => { failed(e); done(); });
    } else {
      done();
    }
  }

  // ── the API ─────────────────────────────────────────────────────────────────

  function trigger(src = 'trigger') {
    if (stopped) return Promise.resolve();
    if (!next) {
      let resolve;
      const promise = new Promise((r) => { resolve = r; });
      next = { promise, resolve };
    }
    const { promise } = next;
    request(String(src));
    return promise;
  }

  function retarget(nextFile) {
    checkPath(nextFile, 'retarget(file)');
    if (stopped) return Promise.resolve();
    const resolved = path.resolve(nextFile);
    if (resolved !== target) {
      const nextDir = path.dirname(resolved);
      target = resolved;
      base = path.basename(resolved);
      fileFailure = null;
      closeFileWatch();
      if (nextDir !== dir) {
        dir = nextDir;
        closeDirWatch();
        openDirWatch();
      }
      rearm();
    }
    return trigger('retarget');
  }

  function stop() {
    if (!stopped) {
      stopped = true;
      if (poller) { clearInterval(poller); poller = null; }
      if (windowTimer) {
        if (debounceMs > 0) clearTimeout(windowTimer);
        else clearImmediate(windowTimer);
        windowTimer = null;
        windowSrc = null;
      }
      again = null;
      closeFileWatch();
      closeDirWatch();
      if (next) { next.resolve(); next = null; }
    }
    return inFlight || Promise.resolve();
  }

  openDirWatch();
  rearm();
  poller = hold(setInterval(() => request('poll'), pollMs));

  return { trigger, retarget, stop, stats };
}

module.exports = { watchFile };
