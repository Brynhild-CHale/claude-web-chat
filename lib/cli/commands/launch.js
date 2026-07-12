const os = require('os');

// Bring up the web-chat surface (daemon + browser tab) and drop the user
// straight into a Claude Code session in the same project, forwarding any flags
// (e.g. --resume) through to `claude`. One command instead of `open` + launch.
//
// Dependencies are injectable for testing; defaults wire the real ones.
async function launch(args = [], deps = {}) {
  const open = deps.open || require('./open');
  const spawn = deps.spawn || require('child_process').spawn;
  const exit = deps.exit || ((c) => process.exit(c));
  const errlog = deps.errlog || ((m) => console.error(m));
  const platform = deps.platform || process.platform;

  // Start the surface first so it's live before the session attaches. `open`
  // is idempotent (reuses a running daemon). It normally exits the process
  // itself on failure, but guard against a thrown rejection too — no point
  // launching a session against a dead surface.
  try {
    await open();
  } catch (e) {
    errlog(`could not start the web-chat surface: ${e ? e.message : 'unknown error'}`);
    return exit(1);
  }

  // Windows exposes npm bin shims as `claude.cmd`; spawning that needs the
  // shell, since CreateProcess can't execute a .cmd directly (without it Node
  // raises ENOENT even when `claude` works in the user's terminal). Elsewhere,
  // spawn the bare binary with no shell.
  const isWin = platform === 'win32';
  const bin = isWin ? 'claude.cmd' : 'claude';
  const child = spawn(bin, args, { stdio: 'inherit', shell: isWin });

  return await new Promise((resolve) => {
    let settled = false;
    const done = (code) => { if (settled) return; settled = true; exit(code); resolve(); };

    child.on('error', (e) => {
      if (e && e.code === 'ENOENT') {
        errlog('could not find `claude` on PATH — is Claude Code installed? See https://claude.com/claude-code');
        done(127);
      } else {
        errlog(`failed to launch claude: ${e ? e.message : 'unknown error'}`);
        done(1);
      }
    });

    // Propagate the session's exit code so `launch` is transparent in scripts.
    // A signal-terminated session reports code === null with a signal name —
    // surface that as 128+signum rather than laundering it into success (0).
    child.on('exit', (code, signal) => {
      if (signal) done(128 + (os.constants.signals[signal] || 0));
      else done(code == null ? 1 : code);
    });
  });
}

module.exports = launch;
