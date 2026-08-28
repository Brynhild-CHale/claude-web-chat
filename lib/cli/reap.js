// Clearing up other projects' surfaces — the one place that decides what may be
// stopped, what may be deleted, and what must be left alone.
//
// `ls --reap` used to do this itself: a raw SIGTERM to any row whose pid was
// alive, then unlink the portfile. Two things were wrong with it.
//
//   1. A pid being alive is not the same as it being OURS. ~/.web-chat is a
//      user-scope file that outlives every daemon, so after a reboot its pids
//      belong to whatever the OS handed them to next. The row `ls` itself
//      printed as "(not answering)" — pid alive, port silent — is exactly the
//      recycled-pid case, and it was the one being signalled.
//   2. A raw signal skips the /api/shutdown ask, and that ask is what guarantees
//      gracefulShutdown runs and writes .web-chat/draft.json. restart dropped
//      its own hand-rolled SIGTERM for precisely this reason; reap kept it, so
//      every reaped project silently lost its uncommitted surface.
//
// So: a row is stopped only when a daemon ANSWERS on its port and reports our
// pid, and it is stopped through the same acknowledged-shutdown engine `stop`
// uses. A row whose pid is alive but whose port is silent is printed with a
// `kill` hint and left alone — the honest outcome, since we cannot tell a wedged
// daemon from a stranger's process. A row whose pid is gone is a ghost record,
// and only its records are removed, under the pid:null "reap only what names a
// dead process" rule.
//
// And nothing here EVER signals. The per-row budget below is shorter than the
// daemon's own worst-case drain (a live turn can hold gracefulShutdown for 30s),
// so an ack that has not turned into an exit yet means "still working", not
// "wedged" — which is why every stop() from here passes `signalAfterAck:false`.
// SIGTERM mid-drain re-enters the guarded gracefulShutdown and process.exit()s
// before writeDraft, i.e. destroys exactly the snapshot the ask was for.
//
// This lives in lib/cli, not in lib/util/registry: reaping needs the stop engine,
// which needs lib/client, and a shared library may not reach up into a CLI
// command (docs/extending.md's direction rule).

const portfiles = require('../core/portfiles');
const registry = require('../util/registry');
const stop = require('./commands/stop');

// `stop`'s own budget is 40s — the daemon's worst-case drain for ONE daemon the
// user is waiting on. A reap is a serial loop over every other project on the
// machine, so 40s each is minutes of silence. 5s is long enough for an idle
// daemon's acknowledged shutdown and short enough that N of them stay bearable;
// a daemon that needs longer is reported as `draining` and left to finish — the
// budget is ours, and it is not evidence of anything about the daemon.
const ROW_ACK_WAIT_MS = 5_000;
const ROW_SIGNAL_WAIT_MS = 2_000;

// Stop ONE row. Never signals a pid we have not heard answer for itself.
// Returns stop()'s shape ({ok, path, pid}) plus a `reason` when it declined.
async function stopRow(row, {
  log = () => {},
  ackWaitMs = ROW_ACK_WAIT_MS,
  signalWaitMs = ROW_SIGNAL_WAIT_MS,
} = {}) {
  const pid = row.pid == null ? null : row.pid;
  if (!row.reachable) return { ok: false, path: 'none', pid, reason: 'unreachable' };
  // Identity, not liveness: /api/health is the answering process telling us who
  // it is. If it is not the pid the registry named, this row describes something
  // else and nothing here may act on it.
  const health = await portfiles.probeHealth(row.port, 400);
  if (!health || health.pid !== row.pid) {
    return { ok: false, path: 'none', pid, reason: 'identity' };
  }
  // signalAfterAck:false — see the header. A shortened budget may not be turned
  // into a reason to kill.
  return stop([], { root: row.root, log, ackWaitMs, signalWaitMs, signalAfterAck: false });
}

function nameOf(row) {
  return row.title || row.root || `port ${row.port}`;
}

// Reap a set of rows() (from lib/util/registry). `here` is the project the user
// is standing in, which is never touched. Consumed by `ls --reap` and by init's
// remediation, so the two cannot drift.
async function reap(rows, { here = null, log = console.log, ackWaitMs, signalWaitMs } = {}) {
  let stopped = 0;
  let cleared = 0;
  const skipped = [];

  for (const r of rows) {
    if (here && r.root === here) continue; // never reap the project you are standing in

    if (!r.pid_alive) {
      // A ghost: the process it described is gone. Remove both records — but
      // under pid:null, so a daemon that started since the listing keeps its own.
      const removed = registry.release({ root: r.root, pid: null });
      if (removed.registry || removed.portfile) cleared++;
      continue;
    }

    const res = await stopRow(r, { log, ackWaitMs, signalWaitMs });
    // `path:'none'` is stop() finding no live portfile for the root — the daemon
    // answered as this pid a moment ago and is still up, so counting it as a
    // stopped surface would be a lie about the user's machine.
    if (res.ok && res.path !== 'none') { stopped++; continue; }
    const reason = res.reason || (res.path === 'none' ? 'no-portfile' : 'failed');
    skipped.push({ row: r, reason });
    if (reason === 'unreachable') {
      log(`  ${nameOf(r)} — pid ${r.pid} is alive but nothing answers on port ${r.port}. Left alone: that pid may belong to an unrelated process now. If it really is a wedged daemon: kill ${r.pid}`);
    } else if (reason === 'identity') {
      log(`  ${nameOf(r)} — port ${r.port} answers, but not as pid ${r.pid}. The registry entry is out of date; left alone.`);
    } else if (reason === 'draining') {
      log(`  ${nameOf(r)} — asked and acknowledged; still draining. It will exit on its own.`);
    } else if (reason === 'no-portfile') {
      log(`  ${nameOf(r)} — answers on port ${r.port} but has no portfile at ${r.root}, so there is nothing to ask through. Left running.`);
    }
  }

  return { stopped, cleared, skipped };
}

module.exports = { reap, stopRow, ROW_ACK_WAIT_MS, ROW_SIGNAL_WAIT_MS };
