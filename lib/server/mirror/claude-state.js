// lib/server/mirror/claude-state.js — follows the sessions file of every Claude
// Code process the conversation registry has linked (spec §2.6, "The sessions
// file"; the registry is conversations.js).
//
// Claude Code rewrites <sessions>/<pid>.json when the process's status changes
// (busy, waiting, idle; `waitingFor` while it waits), when it switches session
// (/clear, an in-place /resume or /fork: `sessionId` moves, the pid stays), and
// removes it at exit (V10, V14, F7). It is not a heartbeat — it changes only on
// a status change — so this file never ages a status: it reports what the file
// says, the moment it says it, and leaves every judgement to its consumers (the
// live-state machine reads the status, the registry reads the session).
//
// ONE WATCH PER LINKED PROCESS, through lib/core/watch `watchFile`: a file watch
// on the inode (re-armed when the file is replaced) and a mandatory poll, every
// ACTIVE_POLL_MS (1 s) while the conversation is not idle and IDLE_POLL_MS (5 s)
// while it is. Never a directory watch: FSEvents' close() blocked the event loop
// for up to ~25 s under load (V17), and the mirror creates none. The cadence is
// read from `stateOf(cid)` (the live state; `idle` polls slowly) after every
// read, and again on `retune()`; a change re-creates the watch with the new poll.
// A process's file is read only while the registry keeps that process linked to
// a conversation: `link(cid, pid)` starts the watch and reads the file at once,
// `unlink(cid)` stops it.
//
// Every read goes through lib/core/claude-sessions `readSessionState` — the one
// reader, which never opens the `.key` beside each file — and a record is
// handed on only when it differs from the last one read for that conversation
// (a first read that finds a file always does): `onRecord(cid, pid, record |
// null, {first})`, null once a file that was there is gone (the process is
// exiting; that is not a verdict on the process, which only the live machine's
// samples give). `first` marks the read made at link time: it reports what the
// file held then, not a change seen happening.
//
//   createClaudeState({ onRecord, stateOf, readSessionState, watchFile,
//                       activeMs, idleMs, persistent, log })
//     link(cid, pid) → Promise      resolves once the first read has run
//     unlink(cid) → Promise         resolves once a read in flight has settled
//     retune(cid?)                  re-reads the cadence (one, or every watch)
//     read(cid) → Promise           a read now, as a change would trigger
//     recordOf(cid) → record|null   the last record read
//     linked() → [{cid, pid, pollMs}]
//     stop() → Promise              idempotent; nothing is read after it
//
// `persistent` (default true) keeps the polls ref'd, like the mirror's tailers:
// on Node 22 a test awaiting work held only by unref'd handles is cancelled
// (V17), and the daemon is held open by its server anyway. stop() clears them.
//
// Dependency direction: server; imports lib/core only.

const { watchFile: defaultWatchFile } = require('../../core/watch');
const claudeSessions = require('../../core/claude-sessions');
const { userClaudePaths } = require('../../core/paths');
const { stableKey } = require('../../core/stable-json');

// §2.6: "a 1 s poll while the conversation is not idle, 5 s otherwise".
const ACTIVE_POLL_MS = 1000;
const IDLE_POLL_MS = 5000;

function createClaudeState({
  onRecord = () => {},
  stateOf = () => null,
  readSessionState = claudeSessions.readSessionState,
  watchFile = defaultWatchFile,
  activeMs = ACTIVE_POLL_MS,
  idleMs = IDLE_POLL_MS,
  persistent = true,
  log = () => {},
} = {}) {
  const entries = new Map(); // conversation id → { cid, pid, file, watcher, pollMs, read, key, record, started }
  const stopping = new Set(); // stop() promises of watches let go, so stop() can wait on them
  let stopped = false;

  function say(...args) { try { log(...args); } catch { /* a logger never breaks the watch */ } }

  function cadence(cid) {
    let state = null;
    try { state = stateOf(cid); } catch { state = null; }
    return state === 'idle' ? idleMs : activeMs;
  }

  function release(watcher) {
    if (!watcher) return Promise.resolve();
    let p;
    try { p = Promise.resolve(watcher.stop()); } catch { p = Promise.resolve(); }
    stopping.add(p);
    p.then(() => stopping.delete(p), () => stopping.delete(p));
    return p;
  }

  function arm(entry) {
    const pollMs = cadence(entry.cid);
    let watcher = null;
    try {
      watcher = watchFile(entry.file, () => readNow(entry, watcher), {
        pollMs,
        persistent,
        log: (msg) => say(`claude-state: ${msg}`),
      });
    } catch (e) {
      say('claude-state: cannot watch a sessions file:', e && e.message);
      watcher = null;
    }
    entry.watcher = watcher;
    entry.pollMs = pollMs;
    return watcher;
  }

  // A cadence change: let the old watch go (never awaited here: this may run
  // inside its own call) and open one with the new poll.
  function rearm(entry) {
    const old = entry.watcher;
    entry.watcher = null;
    release(old);
    arm(entry);
  }

  // One read, from a watch's call. A call from a watch this entry no longer
  // holds, or after unlink, does nothing.
  function readNow(entry, watcher) {
    if (stopped || entries.get(entry.cid) !== entry || entry.watcher !== watcher) return;
    let record = null;
    try { record = readSessionState({ pid: entry.pid }); } catch { record = null; }
    const key = record ? stableKey(record) : null;
    // A change, or a first read that found a file (one that found none has
    // nothing to report: there was no file to be gone).
    const first = !entry.read;
    const changed = first ? record !== null : key !== entry.key;
    entry.read = true;
    if (changed) {
      entry.key = key;
      entry.record = record;
      try {
        onRecord(entry.cid, entry.pid, record, { first });
      } catch (e) {
        say('claude-state: onRecord threw:', e && e.message);
      }
    }
    // onRecord may have unlinked or relinked this conversation.
    if (stopped || entries.get(entry.cid) !== entry || entry.watcher !== watcher) return;
    if (cadence(entry.cid) !== entry.pollMs) rearm(entry);
  }

  function link(cid, pid) {
    if (stopped || typeof cid !== 'string' || !cid) return Promise.resolve();
    let file = null;
    try { file = userClaudePaths().claudeSessionStateFile(pid); } catch { file = null; }
    if (!file) return Promise.resolve();
    const cur = entries.get(cid);
    if (cur && cur.pid === pid) {
      retune(cid);
      return cur.started;
    }
    if (cur) unlink(cid);
    const entry = { cid, pid, file, watcher: null, pollMs: null, read: false, key: undefined, record: null, started: null };
    entries.set(cid, entry);
    const watcher = arm(entry);
    entry.started = watcher ? watcher.trigger('start') : Promise.resolve();
    return entry.started;
  }

  function unlink(cid) {
    const entry = entries.get(cid);
    if (!entry) return Promise.resolve();
    entries.delete(cid);
    const watcher = entry.watcher;
    entry.watcher = null;
    return release(watcher);
  }

  function retune(cid) {
    if (stopped) return;
    const list = cid === undefined ? [...entries.values()] : [entries.get(cid)].filter(Boolean);
    for (const entry of list) {
      if (entry.watcher && cadence(entry.cid) !== entry.pollMs) rearm(entry);
    }
  }

  function read(cid) {
    const entry = entries.get(cid);
    if (stopped || !entry || !entry.watcher) return Promise.resolve();
    return entry.watcher.trigger('read');
  }

  function recordOf(cid) {
    const entry = entries.get(cid);
    return entry ? entry.record : null;
  }

  function linked() {
    return [...entries.values()].map((e) => ({ cid: e.cid, pid: e.pid, pollMs: e.pollMs }));
  }

  async function stop() {
    if (!stopped) {
      stopped = true;
      for (const cid of [...entries.keys()]) unlink(cid);
    }
    await Promise.all([...stopping]);
  }

  return { link, unlink, retune, read, recordOf, linked, stop };
}

module.exports = { createClaudeState, ACTIVE_POLL_MS, IDLE_POLL_MS };
