// The instance guard: a running daemon keeps looking at its own records.
//
// A daemon used to look at its portfile and its state directory once, at boot
// (lib/server/index.js start() writes the portfile and registers, and never
// reads either again). So (design/tools/t567-inputs/lifecycle-bugs.md bugs 1
// and 2):
//   * a deleted portfile was never restored, and every spawn path that read the
//     portfile alone saw no daemon;
//   * two daemons on one root both kept serving, and writing, one .web-chat/;
//   * a daemon whose .web-chat/ the user deleted re-created it: the chat
//     mirror's writers mkdir as they persist, and a graceful stop writes
//     draft.json.
//
// Every GUARD_INTERVAL_MS (5 s, ruled A-defaults (a), U106@cadence) one pass
// asks, in order:
//   (a) is <root>/.web-chat/ still the directory this daemon booted into (the
//       same dev and inode)? Gone, or removed and re-created by anyone (this
//       daemon's own writers included) → onExit('state-removed'). Deleting the
//       folder is the user saying stop (ruled A6 (b)): the caller stops at once
//       without writing anything into the project. A folder re-created in the
//       seconds before the pass noticed is LEFT on disk, and the exit line
//       names it — nothing here deletes user-visible state.
//   (b) does the portfile name this pid? → nothing.
//   (c) is it missing, unreadable, naming a dead pid, or a COPY of another
//       project's record (its `root` is not this one: lib/core/portfiles reads
//       it as absent — the daemon it names has its own portfile at its own
//       root)? → re-read it right before writing, and re-write it
//       (lib/core/portfiles writePortfile) only if it is STILL nobody's —
//       never over a file that appeared meanwhile.
//   (d) does it name ANOTHER live pid whose /api/health answers with that pid
//       and this root's instance id (lib/util/registry answersFor, with
//       strictInstance: a build that names no instance proves nothing)? →
//       this daemon is the orphan →
//       onExit('orphan'). A probe that does not answer, or answers for someone
//       else, is no proof: the file is left alone and looked at again next
//       pass — unless the record carries the `proc_start` its writer stamped
//       and ONE async sample (lib/core/portfiles sampleProcs, at most once per
//       distinct pid + proc_start; never the synchronous ps on a daemon tick)
//       says that pid started at another time: a reused pid, someone else's
//       process now, so the record is nobody's and (c)'s re-write runs.
//       Without a proc_start (an older daemon's record) an unanswered probe
//       alone still proves nothing.
// Whenever the portfile names this daemon (after (b) or (c)), a registry entry
// for this root that is missing or names a dead pid is registered again.
//
// What the guard never does: write into .web-chat/ unless the directory is
// still the one it booted into (the write that re-creates a portfile is preceded
// by the same identity check, in the same tick), delete anything, or end the
// process itself — onExit is the caller's (lib/cli/commands/start.js exits
// without persisting). It relies on one invariant of the daemon's own shutdown
// (lib/server/index.js runShutdown): registry release() is its last synchronous
// step and process.exit follows with no await between, so during a shutdown the
// portfile names this pid (rule (b)) until the moment the process ends.

const fs = require('fs');
const portfiles = require('../core/portfiles');
const { projectPaths } = require('../core/paths');
const registry = require('../util/registry');

const GUARD_INTERVAL_MS = 5000;

// The identity of a directory, or null when there is none (gone, or not a
// directory any more).
function dirIdentity(dir) {
  let st;
  try { st = fs.statSync(dir); } catch { return null; }
  if (!st.isDirectory()) return null;
  return { dev: st.dev, ino: st.ino };
}

function sameIdentity(a, b) {
  return !!(a && b) && a.dev === b.dev && a.ino === b.ino;
}

// The one line the exit path logs, so the reason and a left-over folder are
// said the same way wherever the guard is wired.
function describeExit(reason, info = {}) {
  if (reason === 'state-removed') {
    const where = info.dir || '.web-chat/';
    return info.recreated
      ? `web-chat: ${where} was removed and has been re-created since (left on disk, not deleted) — this daemon stops without writing into the project`
      : `web-chat: ${where} was removed — this daemon stops without writing into the project`;
  }
  if (reason === 'orphan') {
    const other = info.other ? ` (pid ${info.other.pid}, port ${info.other.port})` : '';
    return `web-chat: another daemon${other} owns this project's portfile and answers for it — this daemon is the orphan and stops without writing into the project`;
  }
  return `web-chat: the instance guard stopped this daemon (${reason})`;
}

// root: the project root (the one createServer was given). pid/port: this
// daemon's (pid defaults to process.pid; a test passes another). probeHealth:
// lib/core/portfiles probeHealth unless injected; sampleProcs likewise (the
// reused-pid check's one async sample). onExit(reason, info): called
// at most once, after which the guard is stopped. log: one line per thing the
// guard did or saw, never per quiet pass.
function createInstanceGuard({
  root, pid = process.pid, port, intervalMs = GUARD_INTERVAL_MS,
  probeHealth = portfiles.probeHealth, onExit = () => {}, log = (...a) => console.error(...a),
  probeTimeoutMs = 400, sampleProcs = portfiles.sampleProcs,
} = {}) {
  if (!root) throw new TypeError('createInstanceGuard: root is required');
  const paths = projectPaths(root);
  const id = registry.instanceId(paths.root);

  let baseline = null;     // the dev/ino .web-chat/ had when the guard started
  let timer = null;
  let stopped = false;
  let exited = false;
  let inflight = null;     // the pass now running (check() joins it)
  let lastNote = null;     // the last unconfirmed-owner line, said once per change
  const sampled = new Set(); // the pid:proc_start records already sampled once

  function note(msg) {
    try { log(msg); } catch {}
  }

  function record() {
    if (!baseline) baseline = dirIdentity(paths.dir);
  }

  // (a): null while .web-chat/ is still the one this daemon booted into, else
  // what became of it.
  function stateGone() {
    const now = dirIdentity(paths.dir);
    if (sameIdentity(now, baseline)) return null;
    return { dir: paths.dir, recreated: !!now };
  }

  function exit(reason, info) {
    if (exited || stopped) return reason;
    exited = true;
    stopTimer();
    try { onExit(reason, info); } catch (e) { note(`web-chat: instance guard onExit failed (${e && e.message})`); }
    return reason;
  }

  // Through the engine, without includeForeign: a copy of another project's
  // record reads as null, i.e. nobody's (rule (c)).
  function readPf() {
    try { return portfiles.readPortfile('server', { root: paths.root, checkLiveness: false }); } catch { return null; }
  }

  // Rule (d)'s second question, for a live pid that did not answer: is it the
  // process the record's writer was? Only a record with a proc_start can say,
  // and each such record is sampled once (async, bounded). true: it started at
  // another time (or is gone) — a reused pid. Anything else is no verdict.
  async function reusedPid(rec) {
    if (rec.proc_start == null) return false;
    const key = `${rec.pid}:${rec.proc_start}`;
    if (sampled.has(key)) return false;
    sampled.add(key);
    let sample = null;
    try { sample = await sampleProcs([rec.pid]); } catch { sample = null; }
    if (!(sample instanceof Map)) return false;
    return portfiles.isPidAlive(rec.pid, { startedAt: rec.proc_start, sample }) === false;
  }

  // (c)'s write: re-read first (`stillNobodys` says whether what is there now
  // is still nobody's), and only into the directory this daemon booted into.
  function rewrite(stillNobodys, why) {
    const again = readPf();
    if (!stillNobodys(again)) return 'raced';
    const goneNow = stateGone();
    if (goneNow) return exit('state-removed', goneNow);
    try {
      portfiles.writePortfile('server', { root: paths.root, pid, port });
    } catch (e) {
      note(`web-chat: instance guard could not re-write the portfile (${e && e.message})`);
      return 'error';
    }
    note(`web-chat: instance guard re-wrote the portfile (${why}) for pid ${pid}, port ${port}`);
    lastNote = null;
    ensureRegistered();
    return 'rewrote';
  }

  // Missing, unreadable, or naming a pid that is not alive: a record nobody owns.
  function unowned(rec) {
    return !rec || typeof rec.pid !== 'number' || !portfiles.isPidAlive(rec.pid);
  }

  // A registry entry for this root that is missing or names a dead pid is put
  // back; one naming another live pid is that daemon's and is left alone.
  function ensureRegistered() {
    let mine = null;
    try {
      mine = registry.readAllEntries().find((e) => (e.role || 'instance') === 'instance' && e.id === id) || null;
    } catch { mine = null; }
    if (mine && typeof mine.pid === 'number' && portfiles.isPidAlive(mine.pid)) return false;
    try {
      registry.registerInstance({ root: paths.root, port, pid, url: `http://localhost:${port}` });
      note(`web-chat: instance guard re-registered this daemon (pid ${pid}, port ${port}) in the machine's instance list`);
      return true;
    } catch (e) {
      note(`web-chat: instance guard could not re-register this daemon (${e && e.message})`);
      return false;
    }
  }

  async function pass() {
    if (stopped || exited) return stopped ? 'stopped' : 'exited';
    record();

    // (a) the state directory.
    const gone = stateGone();
    if (gone) return exit('state-removed', gone);

    const rec = readPf();

    // (b) mine.
    if (rec && rec.pid === pid) {
      lastNote = null;
      return ensureRegistered() ? 're-registered' : 'ok';
    }

    // (c) nobody's: put this daemon's note back on the door — re-read first,
    // and only into the directory this daemon booted into.
    if (unowned(rec)) {
      return rewrite(unowned, rec ? `it named pid ${rec.pid}, not running` : 'it was missing or unreadable, or another project\'s copy');
    }

    // (d) another live pid: is it the daemon of this root, answering? The one
    // identity check (lib/util/registry answersFor), strict: only an answer
    // that names this root's instance proves this daemon the orphan.
    const answers = await registry.answersFor(rec, id, { strictInstance: true, probe: probeHealth, timeoutMs: probeTimeoutMs });
    if (stopped || exited) return stopped ? 'stopped' : 'exited';
    if (answers) return exit('orphan', { other: { pid: rec.pid, port: rec.port } });
    // A reused pid (alive, but started at another time than the record's
    // proc_start) is nobody's too: re-write, unless the file changed meanwhile.
    if (await reusedPid(rec)) {
      if (stopped || exited) return stopped ? 'stopped' : 'exited';
      const same = (r) => unowned(r) || (r.pid === rec.pid && r.proc_start === rec.proc_start);
      return rewrite(same, `it named pid ${rec.pid}, which is another process now`);
    }
    const msg = `web-chat: the portfile names pid ${rec.pid} (port ${rec.port}), which did not answer for this project — left alone, looking again in ${Math.round(intervalMs / 1000)} s`;
    if (msg !== lastNote) { lastNote = msg; note(msg); }
    return 'unconfirmed';
  }

  // One pass now; a pass already running is joined, not doubled. Resolves to
  // what it did: 'ok' | 're-registered' | 'rewrote' | 'raced' | 'unconfirmed' |
  // 'state-removed' | 'orphan' | 'error' | 'stopped' | 'exited'.
  function check() {
    if (inflight) return inflight;
    inflight = pass()
      .catch((e) => { note(`web-chat: instance guard pass failed (${e && e.message})`); return 'error'; })
      .finally(() => { inflight = null; });
    return inflight;
  }

  function stopTimer() {
    if (timer) { clearInterval(timer); timer = null; }
  }

  function start() {
    if (stopped || exited || timer) return;
    record();
    timer = setInterval(() => { check(); }, intervalMs);
    if (timer.unref) timer.unref();
  }

  function stop() {
    stopped = true;
    stopTimer();
  }

  return {
    start, stop, check,
    get running() { return !!timer; },
  };
}

module.exports = { createInstanceGuard, describeExit, GUARD_INTERVAL_MS };
