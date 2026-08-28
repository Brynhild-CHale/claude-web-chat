const { findProjectRoot } = require('../../core/paths');
const portfiles = require('../../core/portfiles');
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

// args/deps are optional; deps exists so callers (restart, tests) can inject the
// project root, redirect output, and shorten the waits.
//
// `signalAfterAck` (default true) is the escape hatch for a caller running on a
// SHORTER budget than the daemon's own worst case. An ack is proof that
// gracefulShutdown is already running: if the budget expires while it is still
// draining, the honest outcome is "draining", not a SIGTERM. The signal would
// re-enter gracefulShutdown, find `shuttingDown` already true and go straight to
// process.exit — destroying the draft snapshot the request asked for. `stop`
// itself waits out the full worst case (ACK_WAIT_MS), so for it an expiry really
// does mean wedged and the escalation is right; `lib/cli/reap.js` cannot spend
// 40s per project and passes false. The fallback for an UNACKNOWLEDGED request is
// unaffected either way — nothing is draining there.
async function stop(args = [], deps = {}) {
  const log = deps.log || console.log;
  const root = deps.root !== undefined ? deps.root : findProjectRoot(process.cwd());
  const ackWaitMs = deps.ackWaitMs != null ? deps.ackWaitMs : ACK_WAIT_MS;
  const signalWaitMs = deps.signalWaitMs != null ? deps.signalWaitMs : SIGNAL_WAIT_MS;
  const signalAfterAck = deps.signalAfterAck !== false;

  if (!root) {
    log('(no server running)');
    return { ok: true, path: 'none', pid: null };
  }
  const info = portfiles.readPortfile('server', { root });
  if (!info) {
    log('(no server running)');
    return { ok: true, path: 'none', pid: null };
  }

  // ── path 1: ask ──────────────────────────────────────────────────────────
  const asked = await requestShutdown(info, root);
  if (asked.acked) {
    let gone = await portfiles.waitUntilGone({ role: 'server', root, maxMs: Math.min(ACK_QUIET_MS, ackWaitMs) });
    if (!gone && ackWaitMs > ACK_QUIET_MS) {
      log('  … shutdown acknowledged; draining (a live turn can hold this for up to 30s)');
      gone = await portfiles.waitUntilGone({ role: 'server', root, maxMs: ackWaitMs - ACK_QUIET_MS });
    }
    if (gone) {
      log(`web-chat server stopped cleanly (pid ${info.pid}) — shutdown acknowledged, uncommitted surface state saved to .web-chat/draft.json`);
      return { ok: true, path: 'request', pid: info.pid };
    }
    if (!signalAfterAck) {
      // The budget was the CALLER's, not the daemon's. It said yes and is still
      // working; signalling now would abort its snapshot. Report and move on —
      // it exits on its own, and the next listing will not show it.
      log(`  … ${info.pid} acknowledged the shutdown and is still draining after ${Math.round(ackWaitMs / 1000)}s — it will finish and exit on its own (not signalling: that would abort its draft snapshot)`);
      return { ok: false, path: 'request', pid: info.pid, reason: 'draining' };
    }
    // Acknowledged but still here after its own worst-case drain window: the
    // drain is wedged, so the signal is now the right escalation rather than an
    // interruption of work in progress.
    log(`(pid ${info.pid} acknowledged the shutdown but is still running after ${Math.round(ackWaitMs / 1000)}s — escalating to SIGTERM)`);
  } else {
    log(`(shutdown request failed: ${asked.error} — falling back to SIGTERM)`);
  }

  // ── path 2: signal ───────────────────────────────────────────────────────
  try {
    process.kill(info.pid, 'SIGTERM');
  } catch (e) {
    // No such process: the daemon is already gone and only its portfile is left.
    // readPortfile gates on a live pid, so getting here means it died between
    // that read and now.
    log(`(could not signal pid ${info.pid}: ${e.message})`);
    return { ok: false, path: 'signal', pid: info.pid };
  }
  const gone = await portfiles.waitUntilGone({ role: 'server', root, maxMs: signalWaitMs });
  if (gone) {
    log(`web-chat server stopped (pid ${info.pid}) via SIGTERM — the shutdown request was not acknowledged, so a clean draft snapshot is not guaranteed`);
    return { ok: true, path: 'signal', pid: info.pid };
  }
  log(`(pid ${info.pid} survived both a shutdown request and SIGTERM — the portfile is still present. Try \`claude-web-chat doctor\`, or \`kill -9 ${info.pid}\`)`);
  return { ok: false, path: 'signal', pid: info.pid };
}

module.exports = stop;
module.exports.ACK_WAIT_MS = ACK_WAIT_MS;
module.exports.SIGNAL_WAIT_MS = SIGNAL_WAIT_MS;
