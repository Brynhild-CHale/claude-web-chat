// The connector's program runner (tranche 6, U725): THE one way the connector
// and its CLI rows run a program other than Claude Code and git.
//
//   findProgram(name, pathEnv) → the absolute path of `name` on that PATH, or null
//     `name` is a bare program name (no separator, no `..`); `pathEnv` is a
//     PATH string — the one captured at install (the record's service.path_env,
//     06 C-06.6) or the process's own — of which only absolute directories
//     count. The first regular, executable file wins. A directory walk; nothing
//     runs.
//
//   isExecutable(file) → whether `file` is an absolute path to a regular,
//     executable file (for a program at a known place, the Tailscale app's CLI).
//
//   run(bin, argv, { timeoutMs, env, cwd, maxBytes })
//       → Promise<{ ok, code, stdout, notFound, reason, signal }>
//     child_process.execFile over an ARGUMENT LIST: `bin` an absolute path (a
//     findProgram answer), `argv` a list of strings, `shell` never set, stdin
//     closed at once (EOF), a timeout (TIMEOUT_MS by default: SIGTERM, then
//     SIGKILL KILL_GRACE_MS later, and the promise settles then whatever the
//     child's pipes do) and an output cap (`maxBytes`, MAX_BYTES by default:
//     past it the child is killed and stdout is cut at exactly that many
//     bytes). It NEVER rejects and refuses nothing silently: every way a run
//     can end is `ok: false` with a `reason` —
//       'not-found' (no such program, or `bin` not an absolute path; also
//                    `notFound: true`), 'argv' (not a list of strings, or a
//                    NUL in one), 'timeout', 'overflow', 'exit' (a non-zero
//                    `code`), 'signal' (ended by `signal`), 'spawn' (any other
//                    failure to start).
//     ok is an exit code of 0. stderr is not returned: nothing the connector
//     runs is allowed to reach a log line or a frame by way of its error text.
//
// Every program the connector or its CLI runs goes through here: `tailscale`
// for the machine facts (./facts), and — appended by U731 — ssh, tmux's attach,
// the login shell and the OS opener. The `claude` program goes through
// lib/core/claude-cli and git through lib/server/git-run, never here. A
// literal 'tailscale' program anywhere else is a conventions-ratchet failure
// (test/conventions.test.js; its baseline is empty because this file runs a
// resolved variable).

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const TIMEOUT_MS = 10000;
const KILL_GRACE_MS = 1000;
const MAX_BYTES = 1024 * 1024;

// A bare program name: letters, digits and . _ + -, never `.` or `..`.
const PROGRAM_NAME_RE = /^[A-Za-z0-9._+-]{1,128}$/;

function isExecutable(file) {
  if (typeof file !== 'string' || !path.isAbsolute(file) || file.includes('\0')) return false;
  try {
    if (!fs.statSync(file).isFile()) return false;
    fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function findProgram(name, pathEnv) {
  if (typeof name !== 'string' || !PROGRAM_NAME_RE.test(name) || name === '.' || name === '..') return null;
  if (typeof pathEnv !== 'string' || !pathEnv) return null;
  for (const dir of pathEnv.split(path.delimiter)) {
    if (!dir || !path.isAbsolute(dir)) continue;
    const file = path.join(dir, name);
    if (isExecutable(file)) return file;
  }
  return null;
}

function result(fields) {
  return { ok: false, code: null, stdout: '', notFound: false, reason: null, signal: null, ...fields };
}

function run(bin, argv, { timeoutMs = TIMEOUT_MS, env = process.env, cwd, maxBytes = MAX_BYTES } = {}) {
  return new Promise((resolve) => {
    if (typeof bin !== 'string' || !path.isAbsolute(bin) || bin.includes('\0')) {
      resolve(result({ notFound: true, reason: 'not-found' }));
      return;
    }
    if (!Array.isArray(argv) || !argv.every((a) => typeof a === 'string' && !a.includes('\0'))) {
      resolve(result({ reason: 'argv' }));
      return;
    }
    const cap = Number.isSafeInteger(maxBytes) && maxBytes > 0 ? maxBytes : MAX_BYTES;
    const limit = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : TIMEOUT_MS;

    let settled = false;
    let timedOut = false;
    let timer = null;
    let killTimer = null;
    let child;
    const finish = (r) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(killTimer);
      resolve(r);
    };
    const capped = (out) => {
      const b = Buffer.isBuffer(out) ? out : Buffer.from(String(out || ''), 'utf8');
      return (b.length > cap ? b.subarray(0, cap) : b).toString('utf8');
    };

    try {
      child = execFile(bin, argv, {
        cwd, env, encoding: 'buffer', maxBuffer: cap, shell: false, windowsHide: true, killSignal: 'SIGTERM',
      }, (err, stdout) => {
        const out = capped(stdout);
        if (!err) { finish(result({ ok: true, code: 0, stdout: out })); return; }
        if (timedOut) { finish(result({ stdout: out, reason: 'timeout', signal: err.signal || null })); return; }
        if (err.code === 'ENOENT') { finish(result({ notFound: true, reason: 'not-found' })); return; }
        if (err.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') { finish(result({ stdout: out, reason: 'overflow' })); return; }
        if (typeof err.code === 'number') { finish(result({ code: err.code, stdout: out, reason: 'exit' })); return; }
        if (err.signal) { finish(result({ stdout: out, reason: 'signal', signal: err.signal })); return; }
        finish(result({ stdout: out, reason: 'spawn' }));
      });
    } catch {
      finish(result({ reason: 'spawn' }));
      return;
    }
    // EOF on stdin at once: a program that reads it never waits on us.
    try { if (child.stdin) child.stdin.end(); } catch { /* already closed */ }
    child.on('error', () => { /* reported through the callback */ });

    timer = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGTERM'); } catch { /* already gone */ }
      killTimer = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch { /* already gone */ }
        // A pipe a grandchild still holds must not keep the run waiting.
        finish(result({ reason: 'timeout', signal: 'SIGKILL' }));
      }, KILL_GRACE_MS);
    }, limit);
  });
}

module.exports = { run, findProgram, isExecutable, TIMEOUT_MS, KILL_GRACE_MS, MAX_BYTES };
