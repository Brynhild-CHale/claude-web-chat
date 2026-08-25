const { findProjectRoot } = require('../../core/paths');
const stop = require('./stop');
const start = require('./start');

// restart = stop + start, and `stop` is the ONE engine for stopping a daemon.
// This used to hand-roll its own `process.kill(pid,'SIGTERM')` + wait — a second
// copy of the mechanism, which meant the acknowledged-shutdown path could be
// fixed in `stop` and silently miss `restart`, the command most likely to be
// bouncing a daemon with unsaved surface state on it.
async function restart(args = [], deps = {}) {
  const log = deps.log || console.log;
  const root = deps.root !== undefined
    ? deps.root
    : (findProjectRoot(process.cwd()) || process.cwd());
  // Injectable so a test can assert WHETHER we start, without spawning a real
  // detached daemon (which would also bring up the hub and the user registry).
  const startFn = deps.start || start;

  const stopped = await stop(args, { ...deps, root, log });

  // A daemon that survived both a request and a signal still holds the port and
  // the portfile. Starting now would either lose the race to it or make `start`
  // print "already running — use restart", i.e. tell the user to run the command
  // they just ran. Say the true thing instead.
  if (!stopped.ok) {
    log('restart aborted — the old daemon is still running. Clear it first (`claude-web-chat doctor`), then retry.');
    return { ok: false, stopped, started: false };
  }

  await startFn(['--daemon']);
  return { ok: true, stopped, started: true };
}

module.exports = restart;
