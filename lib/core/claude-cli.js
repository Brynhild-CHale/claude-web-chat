// The one way web-chat runs the Claude Code CLI (`claude`).
//
// Four questions, answered once:
//
//   findClaude({ env }) → the `claude` to run, or null
//     PATH first, then the two places Claude Code's own installers put it when
//     PATH does not reach them: ~/.local/bin/claude (the native installer) and
//     ~/.claude/local/claude (the older "local" install, often reached only
//     through a shell alias, which a child process never sees). Both through
//     lib/core/paths, so through the one homeDir().
//
//   claudeEnv(env) → the environment a `claude` child gets
//     The caller's environment without CLAUDE_CODE_* and WEB_CHAT_*: run from
//     inside a Claude Code session (a hook, or a `!` command), a child would
//     otherwise inherit that session's identity (CLAUDE_CODE_ENTRYPOINT,
//     CLAUDE_CODE_SESSION_ID, its messaging token) and web-chat's own switches
//     (WEB_CHAT_CHANNEL makes an MCP server start a channel bridge). It KEEPS
//     CLAUDE_CONFIG_DIR, deliberately: `claude mcp add --scope local` writes the
//     config file of the profile it runs under, and the user's profile is the
//     one whose sessions must see the registration.
//
//   runClaude(argv, { cwd, env, bin, timeoutMs }) → { ok, stdout } | { ok:false, stderr, notFound }
//     execFileSync with an argv array and no shell, from `cwd` (`--scope local`
//     keys the registration to the directory it runs in, so the cwd is part of
//     the command). `notFound` is set when there is no `claude` to run at all,
//     apart from a command that ran and failed: a caller with no `claude` prints
//     the command instead of claiming a change that did not happen.
//
//   runClaudeAsync(argv, { cwd, env, bin, timeoutMs, signal, maxBytes })
//       → Promise<{ ok: true, stdout } | { ok: false, stderr, notFound, timedOut, code?, aborted? }>
//     The daemon's runner: child_process.spawn with an argv array, no shell,
//     claudeEnv's environment and stdio ['ignore', 'pipe', 'pipe'] — stdin is
//     /dev/null, so a child that reads it sees EOF at once (execFile takes no
//     stdio option and would leave stdin an open pipe the child could wait on
//     until the timeout). stdout and stderr are kept up to `maxBytes` each
//     (1 MiB): more stdout than that kills the child and fails the run, more
//     stderr is cut. Past `timeoutMs` (30 s) the child is killed through its
//     ChildProcess handle (SIGTERM, then SIGKILL a second later) and the run
//     answers `timedOut`; an AbortSignal that fires does the same and answers
//     `aborted`. It never rejects and never blocks the event loop. ok is an
//     exit code of 0; `code` is the exit code otherwise (null when a signal
//     ended it). Generic: the fork (lib/server/control/fork.js) and
//     `claude agents --json` (the revert's check) both run through it.
//
// lib/setup/registration's defaultRunClaude IS runClaude, the synchronous one;
// the daemon never calls it (it would block the event loop for the length of
// the child). One synchronous runner and one asynchronous one, never a third.
//
// A lib/core leaf: it imports fs, path, child_process and ./paths.

const fs = require('fs');
const path = require('path');
const { execFileSync, spawn } = require('child_process');
const { installPaths, userClaudePaths } = require('./paths');

const CLAUDE_BIN = 'claude';
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_BYTES = 1024 * 1024;
// After a timeout's SIGTERM, how long before SIGKILL; after that, how long
// before the run settles without the child's 'close' (a grandchild holding a
// pipe open would otherwise keep it waiting).
const KILL_GRACE_MS = 1000;
const NOT_FOUND = 'claude not found (not on PATH, in ~/.local/bin or in ~/.claude/local)';

// The prefixes a `claude` child never inherits.
const DROPPED_PREFIXES = ['CLAUDE_CODE_', 'WEB_CHAT_'];

function claudeEnv(env = process.env) {
  const out = {};
  for (const [k, v] of Object.entries(env || {})) {
    if (DROPPED_PREFIXES.some((p) => k.startsWith(p))) continue;
    out[k] = v;
  }
  return out;
}

function isExecutableFile(p) {
  try {
    if (!fs.statSync(p).isFile()) return false;
    fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

// The fallback locations, in the order they are tried after PATH.
function fallbackLocations() {
  return [
    path.join(installPaths().binDir, CLAUDE_BIN),
    path.join(userClaudePaths().dir, 'local', CLAUDE_BIN),
  ];
}

function findClaude({ env = process.env } = {}) {
  const dirs = String((env && env.PATH) || '').split(path.delimiter).filter(Boolean);
  for (const d of dirs) {
    const p = path.join(d, CLAUDE_BIN);
    if (isExecutableFile(p)) return p;
  }
  for (const p of fallbackLocations()) if (isExecutableFile(p)) return p;
  return null;
}

function runClaude(argv, { cwd, env = process.env, bin, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const exe = bin || findClaude({ env });
  if (!exe) return { ok: false, notFound: true, stderr: 'claude not found (not on PATH, in ~/.local/bin or in ~/.claude/local)' };
  try {
    const stdout = execFileSync(exe, argv, {
      cwd,
      env: claudeEnv(env),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: timeoutMs,
      shell: false,
    });
    return { ok: true, stdout: stdout || '' };
  } catch (e) {
    const stderr = [e.stderr, e.stdout].filter(Boolean).map(String).join('\n') || String(e.message || '');
    return { ok: false, stderr, notFound: e.code === 'ENOENT' };
  }
}

function runClaudeAsync(argv, {
  cwd, env = process.env, bin, timeoutMs = DEFAULT_TIMEOUT_MS, signal, maxBytes = DEFAULT_MAX_BYTES,
} = {}) {
  return new Promise((resolve) => {
    const fail = (stderr, extra = {}) => ({ ok: false, stderr, notFound: false, timedOut: false, ...extra });
    let exe;
    try { exe = bin || findClaude({ env }); } catch { exe = null; }
    if (!exe) { resolve(fail(NOT_FOUND, { notFound: true })); return; }
    if (!Array.isArray(argv) || !argv.every((a) => typeof a === 'string')) { resolve(fail('argv must be a list of strings')); return; }
    if (signal && signal.aborted) { resolve(fail('aborted', { aborted: true })); return; }
    const cap = Number.isSafeInteger(maxBytes) && maxBytes > 0 ? maxBytes : DEFAULT_MAX_BYTES;
    const limit = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS;

    let child;
    try {
      child = spawn(exe, argv, {
        cwd, env: claudeEnv(env), stdio: ['ignore', 'pipe', 'pipe'], shell: false, windowsHide: true,
      });
    } catch (e) {
      resolve(fail(String((e && e.message) || 'spawn failed'), { notFound: !!e && e.code === 'ENOENT' }));
      return;
    }

    const out = { chunks: [], bytes: 0 };
    const err = { chunks: [], bytes: 0 };
    let settled = false;
    let timedOut = false;
    let aborted = false;
    let overflow = false;
    let spawnError = null;
    let killTimer = null;
    let giveUpTimer = null;
    const text = (b) => Buffer.concat(b.chunks).toString('utf8');

    function kill() {
      try { child.kill('SIGTERM'); } catch { /* already gone */ }
      if (killTimer) return;
      killTimer = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch { /* already gone */ }
        // The child is dead; a pipe a grandchild still holds must not keep the
        // run waiting for 'close'.
        giveUpTimer = setTimeout(() => settle(null, 'SIGKILL'), KILL_GRACE_MS);
      }, KILL_GRACE_MS);
    }
    function onAbort() { aborted = true; kill(); }
    const timer = setTimeout(() => { timedOut = true; kill(); }, limit);
    if (signal) signal.addEventListener('abort', onAbort, { once: true });

    function keep(buf, chunk, isStdout) {
      if (buf.bytes >= cap) {
        if (isStdout && !overflow) { overflow = true; kill(); }
        return;
      }
      const room = cap - buf.bytes;
      const piece = chunk.length > room ? chunk.subarray(0, room) : chunk;
      buf.chunks.push(piece);
      buf.bytes += piece.length;
      if (isStdout && chunk.length > room && !overflow) { overflow = true; kill(); }
    }
    child.stdout.on('data', (c) => keep(out, c, true));
    child.stderr.on('data', (c) => keep(err, c, false));

    function settle(code, sig) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      if (giveUpTimer) clearTimeout(giveUpTimer);
      if (signal) signal.removeEventListener('abort', onAbort);
      try { child.stdout.destroy(); child.stderr.destroy(); } catch { /* closed */ }
      if (spawnError) {
        resolve(fail(String(spawnError.message || 'spawn failed'), { notFound: spawnError.code === 'ENOENT' }));
        return;
      }
      if (code === 0 && !sig && !timedOut && !aborted && !overflow) {
        resolve({ ok: true, stdout: text(out) });
        return;
      }
      let stderr = text(err);
      if (timedOut) stderr = stderr || `timed out after ${limit} ms`;
      else if (aborted) stderr = stderr || 'aborted';
      else if (overflow) stderr = stderr || `output over ${cap} bytes`;
      const extra = { timedOut, code: Number.isInteger(code) ? code : null };
      if (aborted) extra.aborted = true;
      resolve(fail(stderr, extra));
    }
    child.on('error', (e) => {
      // A spawn failure (ENOENT, EACCES) never reaches 'close' with a code.
      if (child.pid === undefined) { spawnError = e; settle(null, null); }
    });
    child.on('close', (code, sig) => settle(code, sig));
  });
}

module.exports = {
  CLAUDE_BIN,
  claudeEnv,
  findClaude,
  runClaude,
  runClaudeAsync,
  fallbackLocations,
};
