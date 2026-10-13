const { findProjectRoot } = require('../../core/paths');
const portfiles = require('../../core/portfiles');
const registry = require('../../util/registry');
const client = require('../../client');
const { SHUTDOWN_HEADER, SHUTDOWN_HEADER_VALUE } = require('../../core/cors');

// Stopping the daemon used to be `process.kill(pid, 'SIGTERM')` followed by
// hope. A signal carries no reply, so `stop` could not distinguish "drained,
// snapshotted, exited" from "died" — its own failure text said as much ("may not
// have shut down cleanly"). That matters because gracefulShutdown is where the
// uncommitted surface gets written to draft.json; losing it is silent.
//
// So: ASK first (POST /api/shutdown — acknowledged before the process exits),
// and keep the signal as the fallback for a daemon that is too old, too wedged,
// or too broken to answer. Whichever path ran is reported honestly, because
// "stopped cleanly" and "killed" are different facts about the user's state.

// How long to wait after an ACKNOWLEDGED request. The daemon's own worst case is
// LOCK_DRAIN_TIMEOUT_MS (30s waiting out a live turn) + INFLIGHT_DRAIN (5s) +
// CLOSE_DRAIN (up to 2s hanging up on sockets that answer nothing), so anything
// under ~37s would time out on a daemon that is behaving correctly — and then
// SIGTERM it mid-drain, aborting the very snapshot we asked for. That worst case
// is a real number only because every one of those three steps is bounded; the
// final close used to have no ceiling at all, so no budget here could be right.
const ACK_WAIT_MS = 40_000;
// The point at which a still-running drain stops looking instant and starts
// deserving an explanation.
const ACK_QUIET_MS = 2_000;
// A signal is delivered instantly; a daemon that hasn't dropped its portfile in
// five seconds is not going to.
const SIGNAL_WAIT_MS = 5_000;

// Ask the daemon to shut itself down. Never spawns: `stop` resurrecting a daemon
// would be an absurd outcome, and lib/client's spawn is opt-in for exactly that
// reason (opts.noSpawn is belt-and-braces on top of the default).
async function requestShutdown(info, root) {
  try {
    const body = await client.post('/api/shutdown', { reason: 'cli stop' }, {
      port: info.port,
      root,
      noSpawn: true,
      timeout: 5_000,
      // The route's second gate. Read from lib/core/cors so the name can never
      // drift out of sync with the check that enforces it.
      headers: { [SHUTDOWN_HEADER]: SHUTDOWN_HEADER_VALUE },
    });
    if (body && body.ok) return { acked: true };
    return { acked: false, error: `daemon answered without an ack: ${JSON.stringify(body)}` };
  } catch (e) {
    return { acked: false, error: e && e.message ? e.message : String(e) };
  }
}

// Poll until a pid is gone: the wait for a daemon found with no portfile to
// watch (a registry row, a port that answered). Not to be pointed at a pid this
// process cannot see exit — its own, or a child it never reaps.
async function waitPidGone(pid, maxMs) {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    if (!portfiles.isPidAlive(pid)) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return !portfiles.isPidAlive(pid);
}

// Is the daemon on `port` still the process `pid`? /api/health is the answering
// process naming itself; a signal is never aimed at a pid that has not just
// answered for itself on the port it was found on.
async function answersAs(probe, port, pid) {
  let h = null;
  try { h = await probe(port, 400); } catch { h = null; }
  return Boolean(h && h.ok !== false && h.pid === pid);
}

// Path 1 for either kind of daemon: ask, then wait out the drain with the
// caller's `waitGone`. Returns { result } when the ask settled it (stopped, or
// acknowledged and still draining on a caller that may not signal), else
// { acked, error } for the caller's signal path.
async function askFirst(d, root, { log, ackWaitMs, signalAfterAck, waitGone, cleanly }) {
  const asked = await requestShutdown(d, root);
  if (!asked.acked) return { acked: false, error: asked.error };
  let gone = await waitGone(Math.min(ACK_QUIET_MS, ackWaitMs));
  if (!gone && ackWaitMs > ACK_QUIET_MS) {
    log('  … shutdown acknowledged; draining (a live turn can hold this for up to 30s)');
    gone = await waitGone(ackWaitMs - ACK_QUIET_MS);
  }
  if (gone) {
    log(cleanly);
    return { result: { ok: true, path: 'request', pid: d.pid } };
  }
  if (!signalAfterAck) {
    // The budget was the CALLER's, not the daemon's. It said yes and is still
    // working; signalling now would abort its snapshot. Report and move on —
    // it exits on its own, and the next listing will not show it.
    log(`  … ${d.pid} acknowledged the shutdown and is still draining after ${Math.round(ackWaitMs / 1000)}s — it will finish and exit on its own (not signalling: that would abort its draft snapshot)`);
    return { result: { ok: false, path: 'request', pid: d.pid, reason: 'draining' } };
  }
  // Acknowledged but still here after its own worst-case drain window: the
  // drain is wedged, so the signal is now the right escalation rather than an
  // interruption of work in progress.
  log(`(pid ${d.pid} acknowledged the shutdown but is still running after ${Math.round(ackWaitMs / 1000)}s — escalating to SIGTERM)`);
  return { acked: true };
}

// args/deps are optional; deps exists so callers (restart, reap, uninstall,
// tests) can inject the project root, redirect output, and shorten the waits.
//
// `signalAfterAck` (default true) is the escape hatch for a caller running on a
// SHORTER budget than the daemon's own worst case. An ack is proof that
// gracefulShutdown is already running: if the budget expires while it is still
// draining, the honest outcome is "draining", not a SIGTERM — interrupting a
// drain that is going fine buys nothing. `stop` itself waits out the full worst
// case (ACK_WAIT_MS), so for it an expiry really does mean wedged and the
// escalation is right; `lib/cli/reap.js` cannot spend 40s per project and passes
// false. The fallback for an UNACKNOWLEDGED request is unaffected either way —
// nothing is draining there.
//
// (It used to cost more than a pointless wait: a SIGTERM mid-drain re-entered the
// boolean-guarded gracefulShutdown, returned instantly and process.exit()ed
// before release() — leaving the portfile and the registry entry behind, which
// this command then reported as "survived both". A second trigger awaits the
// in-flight shutdown now, and that shutdown is bounded; the reasoning above is
// unchanged either way.)
//
// Which daemons. By default the one the root's portfile names — all that
// `restart` and `ls --reap` want, and no port but the portfile's is probed for
// them — and only once /api/health on that port has shown it is this root's
// (lib/util/registry answersFor, tolerant: that pid, an instance, and this
// root's instance id or, from a build before 0.8.5, none). A portfile naming
// another project's daemon (a .web-chat/ copied from that project) or a pid that
// does not answer at all is left alone, with a kill hint: never a request, never
// a signal to a pid read out of a file and not heard from.
//   deps.target = {pid, port}  that one daemon instead, for one with no portfile
//                 (reap's registry row, a daemon the scan found) or the one the
//                 stale-build bounce verified (lib/cli/stale-daemon): the same
//                 ask, then a wait on the pid. Its fallback signal goes only to
//                 a pid whose /api/health answered as that pid a moment ago.
//   deps.scan: true  after the portfile's daemon, EVERY other daemon rooted here
//                 that lib/util/registry daemonsFor finds — its registry rows,
//                 and every port of `deps.scanPorts` (default 5173..5272) whose
//                 /api/health names this root's instance — each stopped as a
//                 target, one line each. A daemon of an older build answers with
//                 no instance and could be anybody's: it is named with a kill
//                 hint and never signalled. The CLI entry (`stop.cli`) and
//                 `uninstall` set it; lifecycle-bugs.md bug 2 is why (deleting
//                 .web-chat/ under a daemon, then starting another, left two
//                 daemons on one root, and only one of them had a portfile).
//   deps.probeHealth  the /api/health probe (test seam; lib/core/portfiles).
//
// Returns {ok, path: 'request'|'signal'|'none', pid, reason?} for the first
// daemon it acted on — reason 'identity' when the portfile's did not answer as
// this root's; with `scan`, also `results` (one per daemon, that one first),
// `unknown` (daemonsFor's), and `left_alone` for a portfile daemon that did not
// answer as this root's, and `ok` is every result's.
async function stop(args = [], deps = {}) {
  const log = deps.log || console.log;
  const root = deps.root !== undefined ? deps.root : findProjectRoot(process.cwd());
  const o = {
    log,
    ackWaitMs: deps.ackWaitMs != null ? deps.ackWaitMs : ACK_WAIT_MS,
    signalWaitMs: deps.signalWaitMs != null ? deps.signalWaitMs : SIGNAL_WAIT_MS,
    signalAfterAck: deps.signalAfterAck !== false,
    probe: deps.probeHealth || portfiles.probeHealth,
  };

  if (deps.target) return stopTarget(deps.target, root, o);

  if (!root) {
    log('(no server running)');
    return { ok: true, path: 'none', pid: null };
  }
  const info = portfiles.readPortfile('server', { root });
  let first = null;
  if (info) {
    first = await registry.answersFor(info, registry.instanceId(root), { probe: o.probe })
      ? await stopPortfileDaemon(info, root, o)
      : notThisRoot(info, o);
  }
  if (deps.scan) {
    // The scan goes on to this root's own daemons; a portfile daemon left alone
    // is named (above), like an older build nobody can place, and is not one of
    // this root's results.
    const leftAlone = first && first.reason === 'identity' ? first : null;
    return stopTheRest(root, leftAlone ? null : first, deps, o, leftAlone);
  }
  if (!first) {
    log('(no server running)');
    return { ok: true, path: 'none', pid: null };
  }
  return first;
}

// The portfile's daemon: ask, wait for the portfile to go, else signal.
async function stopPortfileDaemon(info, root, o) {
  const { log, signalWaitMs } = o;
  // ── path 1: ask ──────────────────────────────────────────────────────────
  const asked = await askFirst(info, root, {
    ...o,
    waitGone: (maxMs) => portfiles.waitUntilGone({ role: 'server', root, maxMs }),
    cleanly: `web-chat server stopped cleanly (pid ${info.pid}) — shutdown acknowledged, uncommitted surface state saved to .web-chat/draft.json`,
  });
  if (asked.result) return asked.result;
  if (!asked.acked) log(`(shutdown request failed: ${asked.error} — falling back to SIGTERM)`);

  // ── path 2: signal ───────────────────────────────────────────────────────
  try {
    sigterm(info);
  } catch (e) {
    // No such process: the daemon is already gone and only its portfile is left.
    // readPortfile gates on a live pid, so getting here means it died between
    // that read and now.
    return reapDeadOwner(root, info.pid, log, `could not be signalled (${e.message})`);
  }
  const gone = await portfiles.waitUntilGone({ role: 'server', root, maxMs: signalWaitMs });
  if (gone) {
    log(`web-chat server stopped (pid ${info.pid}) via SIGTERM — the shutdown request was not acknowledged, so a clean draft snapshot is not guaranteed`);
    return { ok: true, path: 'signal', pid: info.pid };
  }
  // A present portfile is not a running daemon. Distinguish the two before
  // saying anything: a pid that is GONE means the daemon exited without
  // releasing its records, which is a stale record to reap, not a wedge.
  if (!portfiles.isPidAlive(info.pid)) {
    return reapDeadOwner(root, info.pid, log, 'exited without releasing its records');
  }
  log(`(pid ${info.pid} survived both a shutdown request and SIGTERM — the process is still running and the portfile is still present. Try \`claude-web-chat doctor\`, or \`kill -9 ${info.pid}\`)`);
  return { ok: false, path: 'signal', pid: info.pid };
}

// The portfile names a live pid that /api/health did not show is this root's.
// Nothing is asked of it or sent to it. Not ok: a pid that holds the record may
// hold the port too, and `restart` must not start on top of it.
function notThisRoot(info, o) {
  o.log(`(the portfile names pid ${info.pid} on port ${info.port}, which does not answer as this project's daemon — left alone. If it really is this project's: kill ${info.pid})`);
  return { ok: false, path: 'none', pid: info.pid, reason: 'identity' };
}

// The ONE signal this command sends, for the portfile's daemon and for a
// target alike (test/doc-truth.test.js reads this line as the unacknowledged
// fallback: it stays after the 'falling back to SIGTERM' message above).
function sigterm(info) {
  process.kill(info.pid, 'SIGTERM');
}

const FOUND_BY = { portfile: 'its portfile', registry: 'the instance registry', scan: 'the port scan' };

// One daemon with no portfile to watch: {pid, port, source?}. Nothing is asked
// of, or sent to, a port that does not answer as that pid right now.
async function stopTarget(target, root, o) {
  const { log, signalWaitMs, probe } = o;
  const pid = target && target.pid;
  const port = target && target.port;
  if (!Number.isInteger(pid) || !Number.isInteger(port) || port <= 0) {
    log('(nothing to stop: the daemon named has no pid and port)');
    return { ok: false, path: 'none', pid: Number.isInteger(pid) ? pid : null, reason: 'invalid-target' };
  }
  const name = `pid ${pid} on port ${port}${FOUND_BY[target.source] ? `, found by ${FOUND_BY[target.source]}` : ''}`;
  // A daemon in this very process (a test's in-process server) can be neither
  // waited out nor signalled from here.
  if (pid === process.pid) {
    log(`(${name} is this process — not stopping it from here)`);
    return { ok: false, path: 'none', pid, reason: 'self' };
  }
  // `path` is how far it got: 'none' (not even asked) or 'request'.
  const leftAlone = (path) => {
    log(`(${name}: the port no longer answers as that pid — left alone. If it really is this project's daemon: kill ${pid})`);
    return { ok: false, path, pid, reason: 'identity' };
  };
  const exited = (how) => {
    // Its own shutdown releases its records; one that died first leaves them
    // naming a dead pid, which pid:null reaps and nothing else does.
    if (root) { try { registry.release({ root, pid: null }); } catch {} }
    log(`web-chat server stopped (${name}) — ${how}`);
  };
  if (!(await answersAs(probe, port, pid))) {
    if (!portfiles.isPidAlive(pid)) {
      log(`(${name} has already exited)`);
      return { ok: true, path: 'none', pid, reason: 'gone' };
    }
    return leftAlone('none');
  }

  // ── path 1: ask, then wait on the pid ────────────────────────────────────
  const asked = await askFirst({ pid, port }, root, {
    ...o,
    waitGone: (maxMs) => waitPidGone(pid, maxMs),
    cleanly: `web-chat server stopped cleanly (${name}) — shutdown acknowledged`,
  });
  if (asked.result) return asked.result;

  // ── path 2: signal, only a pid that answered for itself a moment ago ─────
  if (!asked.acked) {
    if (!(await answersAs(probe, port, pid))) {
      if (!portfiles.isPidAlive(pid)) {
        exited('it exited without acknowledging the shutdown request, so a clean draft snapshot is not guaranteed');
        return { ok: true, path: 'request', pid, reason: 'unacknowledged-exit' };
      }
      return leftAlone('request');
    }
    log(`(shutdown request to ${name} failed: ${asked.error} — falling back to SIGTERM)`);
  }
  try {
    sigterm({ pid });
  } catch (e) {
    exited(`it could not be signalled (${e.message}), and is gone`);
    return { ok: true, path: 'signal', pid, reason: 'stale-record' };
  }
  if (await waitPidGone(pid, signalWaitMs)) {
    exited('via SIGTERM; the shutdown request was not acknowledged, so a clean draft snapshot is not guaranteed');
    return { ok: true, path: 'signal', pid };
  }
  log(`(${name} survived both a shutdown request and SIGTERM — try \`kill -9 ${pid}\`)`);
  return { ok: false, path: 'signal', pid };
}

// deps.scan: the portfile's daemon is stopped (or there was none); now every
// other daemon rooted here, and the older builds nobody can place.
async function stopTheRest(root, first, deps, o, leftAlone = null) {
  const { log } = o;
  const found = await registry.daemonsFor(root, { scan: true, ports: deps.scanPorts, probe: o.probe });
  const results = first ? [first] : [];
  for (const d of found.daemons) {
    if (first && d.pid === first.pid) continue;
    results.push(await stopTarget(d, root, o));
  }
  for (const u of found.unknown) {
    log(`pid ${u.pid} on port ${u.port} is a web-chat daemon of an older build; if it is this project's: kill ${u.pid}`);
  }
  const extra = leftAlone ? { left_alone: leftAlone } : {};
  if (!results.length) {
    if (!found.unknown.length && !leftAlone) log('(no server running)');
    return { ok: true, path: 'none', pid: null, results, unknown: found.unknown, ...extra };
  }
  return { ...results[0], ok: results.every((r) => r.ok), results, unknown: found.unknown, ...extra };
}

// The daemon is gone but its records are not. Both of them — the portfile and
// the ~/.web-chat registry entry — name a pid nobody is running, which is the
// state the portfile ownership rule exists to contain, so reap them through it
// with `pid:null`: "remove only what names a dead process". A second daemon that
// has since claimed this root keeps its own records and is reported instead.
//
// This branch used to print the wedged-daemon message, which is wrong twice
// over: it reported a server that had stopped as still running, and it advised
// `kill -9 <pid>` on a pid that is not running — noise at best, and once the OS
// has recycled that pid, aimed at somebody else's process.
function reapDeadOwner(root, pid, log, why) {
  const removed = registry.release({ root, pid: null });
  if (!removed.portfile && portfiles.readPortfile('server', { root })) {
    log(`(pid ${pid} ${why}, but another live daemon has since claimed ${root} — its records were left alone)`);
    return { ok: false, path: 'signal', pid, reason: 'reclaimed' };
  }
  log(`web-chat server stopped (pid ${pid}) — it ${why}; the stale record has been cleared. The shutdown was not acknowledged, so a clean draft snapshot is not guaranteed`);
  return { ok: true, path: 'signal', pid, reason: 'stale-record' };
}

module.exports = stop;
// The CLI entry (lib/cli/index.js): `claude-web-chat stop` reaches every daemon
// of the project, the port scan included. restart and reap call stop() itself.
module.exports.cli = (args) => stop(args, { scan: true });
module.exports.ACK_WAIT_MS = ACK_WAIT_MS;
module.exports.SIGNAL_WAIT_MS = SIGNAL_WAIT_MS;
