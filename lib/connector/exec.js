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

// ── the terminal programs (U731; contract 06 C-06.26a "What runs") ─────────
//
// `connect open|shell|code` run exactly four programs: ssh, tmux's attach, the
// user's login shell and the OS opener. terminal.js decides WHICH from the
// GetChatAttach result's fields and builds a PLAN with the helpers below; the
// plan names a program by its role and carries an argument list:
//
//   { program: 'ssh' | 'tmux' | 'shell' | 'opener', argv: [string], cwd?, pathEnv? }
//
//   quoteRemoteWord(word) → the word as ssh's remote login shell must read it:
//     unchanged when every character is in [A-Za-z0-9/._~@-] and it does not
//     begin with '~', else a POSIX single-quoted word, each ' written '\''
//     (10 C-10.14a's rule; the '=' target is outside the set, so quoted).
//     ssh joins its remote arguments into ONE string the remote shell parses,
//     so "never through a shell" holds only on this machine.
//   sshPlan(target, words)        → ssh -t <target> <word…>, each word quoted
//   tmuxAttachPlan(name, pathEnv) → tmux attach-session -t =<name> (local: no
//                                   shell reads it, so no quoting), with the tmux
//                                   on `pathEnv` (the record's service.path_env)
//   loginShellPlan(cwd)           → $SHELL -l, its working directory `cwd`
//   openerPlan(url)               → the OS opener with the URL as its one argument
//
//   resolvePlan(plan, {env, platform}) → { bin, args } | { reason }
//     ssh on env.PATH, tmux on plan.pathEnv (else env.PATH), the shell from
//     env.SHELL (an absolute, executable file), the opener from
//     lib/util/os-opener's mapping (darwin and linux only) on env.PATH.
//   runPlan(plan, {env, platform, spawn}) → Promise<{ code, reason }>
//     resolvePlan, then runInteractive.
//   runInteractive(bin, argv, {cwd, env, spawn}) → Promise<{ code, reason }>
//     spawn over an ARGUMENT LIST with the terminal inherited (stdio inherit),
//     `shell` never set; resolves with the child's exit code (128 + n for a
//     signal); `reason` is null when the program ran, else 'not-found', 'argv'
//     or 'spawn' with `code` 127. SIGINT and SIGTERM are ignored in this
//     process while the child holds the terminal (the child gets them).
//
// No hub-composed string is ever a program or a shell command here: a plan's
// argv is built by terminal.js from the result's fields, and commands.code is
// the one hub value passed on, as the opener's one argument.

const os = require('os');
const { spawn: spawnChild } = require('child_process');
const { openerCommand } = require('../util/os-opener');

const SAFE_WORD_RE = /^[A-Za-z0-9/._~@-]+$/;
const PLAN_PROGRAMS = Object.freeze(['ssh', 'tmux', 'shell', 'opener']);
const OPENER_PLATFORMS = Object.freeze(['darwin', 'linux']);

function quoteRemoteWord(word) {
  const w = String(word);
  if (SAFE_WORD_RE.test(w) && !w.startsWith('~')) return w;
  return `'${w.replace(/'/g, "'\\''")}'`;
}

function sshPlan(target, words) {
  return { program: 'ssh', argv: ['-t', String(target), ...words.map(quoteRemoteWord)] };
}

function tmuxAttachPlan(name, pathEnv) {
  const plan = { program: 'tmux', argv: ['attach-session', '-t', `=${name}`] };
  if (typeof pathEnv === 'string' && pathEnv) plan.pathEnv = pathEnv;
  return plan;
}

function loginShellPlan(cwd) {
  return { program: 'shell', argv: ['-l'], cwd };
}

function openerPlan(url) {
  return { program: 'opener', argv: [String(url)] };
}

function resolvePlan(plan, { env = process.env, platform = process.platform } = {}) {
  if (!plan || !PLAN_PROGRAMS.includes(plan.program)) return { reason: 'not-found' };
  const envPath = typeof env.PATH === 'string' ? env.PATH : '';
  switch (plan.program) {
    case 'ssh': {
      const bin = findProgram('ssh', envPath);
      return bin ? { bin, args: [] } : { reason: 'not-found' };
    }
    case 'tmux': {
      const bin = findProgram('tmux', plan.pathEnv || envPath);
      return bin ? { bin, args: [] } : { reason: 'not-found' };
    }
    case 'shell':
      return isExecutable(env.SHELL) ? { bin: env.SHELL, args: [] } : { reason: 'not-found' };
    case 'opener': {
      if (!OPENER_PLATFORMS.includes(platform)) return { reason: 'platform' };
      const { cmd, args } = openerCommand(platform);
      const bin = findProgram(cmd, envPath);
      return bin ? { bin, args } : { reason: 'not-found' };
    }
    default:
      return { reason: 'not-found' };
  }
}

function runInteractive(bin, argv, { cwd, env = process.env, spawn = spawnChild } = {}) {
  return new Promise((resolve) => {
    if (typeof bin !== 'string' || !path.isAbsolute(bin) || bin.includes('\0')) {
      resolve({ code: 127, reason: 'not-found' });
      return;
    }
    if (!Array.isArray(argv) || !argv.every((a) => typeof a === 'string' && !a.includes('\0'))) {
      resolve({ code: 127, reason: 'argv' });
      return;
    }
    const ignore = () => {};
    const hold = () => { process.on('SIGINT', ignore); process.on('SIGTERM', ignore); };
    const release = () => { process.removeListener('SIGINT', ignore); process.removeListener('SIGTERM', ignore); };
    let done = false;
    const finish = (r) => { if (done) return; done = true; release(); resolve(r); };
    let child;
    try {
      child = spawn(bin, argv, { cwd, env, stdio: 'inherit', shell: false });
    } catch (e) {
      finish({ code: 127, reason: e && e.code === 'ENOENT' ? 'not-found' : 'spawn' });
      return;
    }
    hold();
    child.on('error', (e) => finish({ code: 127, reason: e && e.code === 'ENOENT' ? 'not-found' : 'spawn' }));
    child.on('exit', (code, signal) => {
      if (Number.isInteger(code)) { finish({ code, reason: null }); return; }
      const n = signal && os.constants.signals[signal];
      finish({ code: Number.isInteger(n) ? 128 + n : 1, reason: null });
    });
  });
}

async function runPlan(plan, { env = process.env, platform = process.platform, spawn = spawnChild } = {}) {
  const r = resolvePlan(plan, { env, platform });
  if (!r.bin) return { code: 127, reason: r.reason || 'not-found' };
  return runInteractive(r.bin, [...r.args, ...plan.argv], { cwd: plan.cwd, env, spawn });
}

module.exports = {
  run, findProgram, isExecutable, TIMEOUT_MS, KILL_GRACE_MS, MAX_BYTES,
  quoteRemoteWord, sshPlan, tmuxAttachPlan, loginShellPlan, openerPlan,
  resolvePlan, runPlan, runInteractive, PLAN_PROGRAMS,
};
