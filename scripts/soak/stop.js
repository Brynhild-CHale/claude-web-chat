'use strict';
// scripts/soak/stop.js — stop the soak's daemon (H.11, U579).
//
// SIGTERMs the pid lib/util/registry daemonFor verified for the soak's project
// (a record whose pid answered /api/health as itself and this root's instance;
// never a pid read out of a file alone), waits for that pid to exit (the
// daemon's own installSignalHandlers drain it and keep draft.json), then — at
// the soak's end, not on drive.js's restarts — waits for the soak's hub to
// leave the soak HOME's registry and its port (it exits once the registry has
// been empty for lib.js HUB_IDLE_MS). Whatever it could not verify, it prints.
//
//   node scripts/soak/stop.js --root R
//   exit 0: no daemon and no hub left; 1: something is still there (printed).

const { enter, parseArgs, runMain } = require('./lib');
const registry = require('../../lib/util/registry');
const { isPidAlive } = require('../../lib/core/portfiles');
const { probeHub } = require('../../lib/util/hub');

const EXIT_WAIT_MS = 20 * 1000;
const HUB_WAIT_MS = 25 * 1000;
const POLL_MS = 100;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function until(test, maxMs) {
  const deadline = Date.now() + maxMs;
  for (;;) {
    if (await test()) return true;
    if (Date.now() >= deadline) return false;
    await sleep(POLL_MS);
  }
}

// → {stopped: [pid], left: [what], hub: 'gone'|'left'|'not-waited'}
async function stopSoak(cfg, { waitHub = true, exitMs = EXIT_WAIT_MS, hubMs = HUB_WAIT_MS, log = console.log } = {}) {
  const out = { stopped: [], left: [], hub: 'not-waited' };
  const d = await registry.daemonFor(cfg.project);
  if (!d) log(`soak stop: no daemon of ${cfg.project} could be verified`);
  else {
    try { process.kill(d.pid, 'SIGTERM'); } catch (e) { if (e.code !== 'ESRCH') out.left.push(`daemon pid ${d.pid}: SIGTERM failed (${e.code})`); }
    if (await until(() => !isPidAlive(d.pid), exitMs)) out.stopped.push(d.pid);
    else out.left.push(`daemon pid ${d.pid} on port ${d.port} still running after ${exitMs} ms`);
  }
  // Any other daemon of the root a record names (never a port scan).
  const rest = await registry.daemonsFor(cfg.project, { scan: false });
  for (const x of rest.daemons) out.left.push(`daemon pid ${x.pid} on port ${x.port} (${x.source}) still answers for ${cfg.project}`);
  if (waitHub) {
    const gone = await until(async () => !registry.readHubEntry() && !(await probeHub(cfg.hubPort)), hubMs);
    out.hub = gone ? 'gone' : 'left';
    if (!gone) {
      const e = registry.readHubEntry();
      out.left.push(`the soak's hub ${e ? `pid ${e.pid} ` : ''}still on port ${cfg.hubPort} after ${hubMs} ms`);
    }
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cfg = enter(args.root);
  const r = await stopSoak(cfg, { waitHub: args.noHub !== true });
  for (const pid of r.stopped) console.log(`soak stop: daemon pid ${pid} exited`);
  if (r.hub === 'gone') console.log('soak stop: the soak\'s hub has left');
  for (const l of r.left) console.error(`soak stop: could not verify a clean stop — ${l}`);
  return r.left.length ? 1 : 0;
}

if (require.main === module) runMain(main);

module.exports = { stopSoak, EXIT_WAIT_MS, HUB_WAIT_MS };
