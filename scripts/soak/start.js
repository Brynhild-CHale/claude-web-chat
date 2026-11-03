'use strict';
// scripts/soak/start.js — start the soak's daemon and return (H.11, U579).
//
// Spawns daemon.js detached through lib/util/daemon spawnDetached (one log fd,
// closed once the child owns its copy: <out>/daemon.log) with the soak's
// isolated environment (lib.js soakEnv), then waits for THIS root's daemon
// through lib/util/daemon waitForDaemon — lib/util/registry daemonFor, the
// portfile or registry entry accepted only once /api/health answers with its
// pid and this root's instance — never a raw portfile loop. A daemon of the
// root already answering is reported and left alone (one daemon per root).
//
//   node scripts/soak/start.js --root R [--max-ms 15000]
//   exit 0: the daemon answers (its pid and port printed); 1: it did not.

const path = require('path');
const { enter, soakEnv, parseArgs, runMain } = require('./lib');
const { spawnDetached, waitForDaemon } = require('../../lib/util/daemon');
const registry = require('../../lib/util/registry');

const START_WAIT_MS = 15 * 1000;
const DAEMON_BIN = path.join(__dirname, 'daemon.js');

// → {pid, port, url, source, already?} or null when no daemon answered in time.
async function startSoak(cfg, { maxMs = START_WAIT_MS, not = null } = {}) {
  const live = await registry.daemonFor(cfg.project);
  if (live && !(not && live.pid === not.pid && live.port === not.port)) return { ...live, already: true };
  spawnDetached({
    bin: DAEMON_BIN,
    args: ['--root', cfg.root],
    log: path.join(cfg.out, 'daemon.log'),
    cwd: cfg.project,
    env: soakEnv(cfg),
  });
  return waitForDaemon(cfg.project, { maxMs, not });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cfg = enter(args.root);
  const maxMs = args.maxMs !== undefined ? Number(args.maxMs) : START_WAIT_MS;
  const d = await startSoak(cfg, { maxMs });
  if (!d) {
    console.error(`soak start: no daemon of ${cfg.project} answered within ${maxMs} ms — see ${path.join(cfg.out, 'daemon.log')}`);
    return 1;
  }
  console.log(`soak start: daemon pid ${d.pid} on port ${d.port}${d.already ? ' (already running)' : ''}`);
  return 0;
}

if (require.main === module) runMain(main);

module.exports = { startSoak, START_WAIT_MS, DAEMON_BIN };
