const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const registry = require('./registry');
const { projectPaths, userPaths, PACKAGE_ROOT } = require('../core/paths');

// The CLI bin every detached child is started from. Derived from PACKAGE_ROOT,
// not by walking __dirname: two spawners walked it independently, which is one
// directory move away from disagreeing.
const CLI_BIN = path.join(PACKAGE_ROOT, 'bin', 'claude-web-chat.js');

// The one "start a child that outlives me, with its output appended to a log".
// Both spawners wanted this and spelled it differently — daemon.js opened the
// same log file TWICE (one fd for stdout, one for stderr) where hub.js reused
// one, and neither closed the parent's copies. spawn() dup()s the descriptors
// into the child, so what the parent keeps is pure leak: harmless in a one-shot
// CLI, but the MCP server is long-lived and respawns a dead daemon on demand
// (lib/client), so it leaked a pair per respawn for the life of a Claude Code
// session. One open, closed as soon as the child owns its own.
//
// `extraFds` are appended to the child's stdio after stdout and stderr, so the
// first lands on fd 3: spawnDaemon's relay secret rides an inherited pipe there
// (contract 06 C-06.19), never the environment or an argv.
function spawnDetached({ bin = CLI_BIN, args = [], log, cwd, env, extraFds = [] } = {}) {
  fs.mkdirSync(path.dirname(log), { recursive: true });
  const fd = fs.openSync(log, 'a');
  try {
    const child = spawn(process.execPath, [bin, ...args], {
      detached: true,
      stdio: ['ignore', fd, fd, ...extraFds],
      ...(cwd ? { cwd } : {}),
      ...(env ? { env } : {}),
    });
    child.unref();
    return child;
  } finally {
    // spawn() is synchronous in creating the child, so by here it holds its own
    // dup of `fd` and ours is dead weight. A spawn that threw closes it too.
    try { fs.closeSync(fd); } catch {}
  }
}

// How long a spawn path waits for the daemon it started to answer.
const DAEMON_WAIT_MS = 8000;

// THE wait for this root's daemon: poll lib/util/registry daemonFor until it
// verifies a live daemon of `root` (its portfile, else its registry entry,
// answering /api/health as that pid and this root's instance), or `maxMs`
// passes — the record ({pid, port, url, source}), or null. Never the raw
// portfile (core/portfiles waitUntilReachable, which stays the primitive for a
// caller that does not need identity): a .web-chat/ copied from another project
// carries a portfile naming THAT project's live daemon, which answers at once,
// and every spawn path that waited on it reported, browsed or adopted the other
// project's daemon as the one it had just started (lifecycle-bugs.md; U107c,
// U107d). `not: {pid, port}` skips one daemon — the one a restart just stopped,
// still answering on its way out: a daemon is its pid and the port it bound (a
// process never moves port), so a new pid, or the same pid on another port
// (in-process daemons in a test share one), is a new daemon. `daemonFor` is a
// test seam.
async function waitForDaemon(root, { maxMs = DAEMON_WAIT_MS, intervalMs = 100, daemonFor: find, not = null } = {}) {
  const lookup = find || registry.daemonFor;
  const skip = (d) => Boolean(not && d.pid === not.pid && d.port === not.port);
  const deadline = Date.now() + maxMs;
  for (;;) {
    let d = null;
    try { d = await lookup(root); } catch { d = null; }
    if (d && !skip(d)) return d;
    if (Date.now() >= deadline) return null;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

// Spawn the server as a detached daemon, logging to .web-chat/server.log. The
// child outlives this process (the whole point — it survives `/exit`). Returns
// the child handle; callers that need the URL await `waitForDaemon`. `env` and
// `extraFds` pass straight to spawnDetached (spawnDaemon's secret path); with
// neither, the child inherits this process's environment as it always has.
// The child runs `start` in the foreground, so its pid IS the daemon's pid.
function spawnDaemonProcess(root, { env, extraFds } = {}) {
  return spawnDetached({
    args: ['start'], log: projectPaths(root).serverLog, cwd: root,
    ...(env ? { env } : {}),
    ...(extraFds ? { extraFds } : {}),
  });
}

// The relay secret's one shape (03 C-03.22): 32 random bytes as 64 lowercase
// hex characters. The fd it rides is named to the child, never the secret.
const RELAY_SECRET_RE = /^[0-9a-f]{64}$/;
const RELAY_SECRET_FD = '3';

// Hand the secret to the child on its fd-3 pipe and let go of our end: one
// write, end(), then destroy once flushed — or at once on an error (EPIPE from a
// child that already died is swallowed: the wait that follows reports it as no
// daemon). The stream is unref'd from the start, so nothing here holds the
// event loop, and it is gone before spawnDaemon goes on to wait.
function handOverSecret(pipe, secret) {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      try { pipe.destroy(); } catch {}
      resolve();
    };
    pipe.on('error', finish);
    pipe.on('close', finish);
    if (typeof pipe.unref === 'function') { try { pipe.unref(); } catch {} }
    try { pipe.end(secret, finish); } catch { finish(); }
  });
}

// Idempotent "make sure a daemon is up". Asks for this root's LIVE daemon first
// (lib/util/registry daemonFor: the portfile, else the registry entry, each
// accepted only once the daemon answering on its port names its pid and this
// root) and ADOPTS it — returns its info, so lib/client talks to its port. The
// portfile alone used to decide: with .web-chat/ deleted under a running daemon
// every caller here (lib/client's auto-spawn for the MCP server and hooks,
// install's pre-warm, the portal's starter, the connector's supervisor) started
// a second daemon for the same root. A portfile-less daemon re-writes its own
// record (U106's guard). After a spawn it waits with waitForDaemon, the same
// rule: the raw portfile it used to wait on could be a copy naming another
// project's live daemon, whose port the MCP server and hooks then adopted.
// Returns the verified record ({pid, port, url, source}), or null if it never
// came up within `maxMs`. `daemonFor` and `spawn` are test seams.
//
// ONE FIRST SPAWN PER ROOT (U718b; the 6A gate's GT-23). Concurrent first
// spawns used to all pass the check before any child bound: five callers
// started five daemons, the first to answer was handed to every caller, and
// it then stepped aside (the instance guard) for the last to write the
// portfile, which nobody had been handed. So the check and the spawn run under
// the root's spawn lock, across processes: userPaths().spawnLock(<the root's
// instance id>), a held lock (lib/util/registry withHeldLockFile: a pid and a
// process start time, stale once that process is gone or is not the one that
// started then), taken BEFORE the daemonFor check and held until the child's
// daemon is the root's verified daemon (waitForDaemon) or the wait gives up.
// A caller that finds it held waits for it (at most `maxMs`), then asks
// daemonFor under the lock and adopts what it finds, spawning nothing (if the
// holder's child never came up, nothing is found, and this caller spawns);
// one whose wait runs out adopts whatever is up then (or null), and spawns
// nothing. Not behind the lock, and left to the daemon's own boot check and
// the instance guard as before: the foreground `start`, the bare
// spawnDaemonProcess of `open` and `start --daemon`, and an older build's
// client.
//
// When THIS call spawned, the record also carries `child_pid`, the pid of the
// child it started (absent when the seam returned no child): the connector's
// supervisor compares it with the verified record's pid, because a spawn
// outside the lock (a foreground `start`, an older build) can still win the
// bind, and the record then names a daemon that is not ours (06 C-06.19, wc-13
// O1). An adopted daemon's record comes back exactly as daemonFor gave it,
// with no child_pid. Either way it is returned after the lock is released.
//
// `secret` (the connector's only): a relay secret, 64 lowercase hex characters,
// refused before anything is spawned or locked otherwise. The child gets a pipe
// on fd 3 and WEB_CHAT_RELAY_SECRET_FD=3 in its environment (`env`, else this
// process's, minus any inherited WEB_CHAT_RELAY_SECRET — the daemon's fallback
// is never the connector's way), the secret is written to that pipe once and
// our end closed; then the wait is as above. The environment is otherwise
// passed through untouched: this never names or sets a port (10 C-10.5; a
// test's walk seam variable reaches the child as the caller set it). A spawn
// seam called with a secret must return a child with a pipe at stdio[3].
async function spawnDaemon(root, { maxMs = DAEMON_WAIT_MS, daemonFor, spawn: spawnFn, secret, env } = {}) {
  const withSecret = secret !== undefined && secret !== null;
  if (withSecret && (typeof secret !== 'string' || !RELAY_SECRET_RE.test(secret))) {
    throw new TypeError('spawnDaemon: a relay secret must be 64 lowercase hex characters');
  }
  const find = daemonFor || registry.daemonFor;
  const first = () => adoptOrSpawn(root, { maxMs, find, spawnFn, withSecret, secret, env });
  const lock = spawnLockFor(root);
  if (!lock) return first();
  const got = await registry.withHeldLockFile(lock, first, { waitMs: maxMs });
  if (got.state !== 'timeout') return got.value;
  // Another spawner held the root's lock for all of our wait: adopt what is
  // up now, if anything, and start nothing.
  return (await find(root)) || null;
}

// The root's spawn lock: one file in the user tier per instance id.
function spawnLockFor(root) {
  return userPaths().spawnLock(registry.instanceId(root));
}

// The part under the lock: adopt a live daemon, else spawn and wait for it.
async function adoptOrSpawn(root, { maxMs, find, spawnFn, withSecret, secret, env }) {
  const live = await find(root);
  if (live) return live;
  const start = spawnFn || spawnDaemonProcess;
  let child;
  if (withSecret) {
    const childEnv = { ...(env || process.env), WEB_CHAT_RELAY_SECRET_FD: RELAY_SECRET_FD };
    delete childEnv.WEB_CHAT_RELAY_SECRET;
    child = start(root, { env: childEnv, extraFds: ['pipe'] });
    const pipe = child && child.stdio ? child.stdio[3] : null;
    if (!pipe || typeof pipe.end !== 'function') throw new Error('spawnDaemon: no pipe for the secret');
    await handOverSecret(pipe, secret);
  } else {
    child = env ? start(root, { env }) : start(root);
  }
  const rec = await waitForDaemon(root, { maxMs, daemonFor: find });
  if (rec && child && Number.isInteger(child.pid)) return { ...rec, child_pid: child.pid };
  return rec;
}

module.exports = { spawnDaemon, spawnDaemonProcess, waitForDaemon, spawnLockFor, DAEMON_WAIT_MS, spawnDetached, CLI_BIN };
