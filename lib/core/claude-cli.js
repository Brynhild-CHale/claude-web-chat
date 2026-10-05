// The one way web-chat runs the Claude Code CLI (`claude`).
//
// Three questions, answered once:
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
// lib/setup/registration's defaultRunClaude IS runClaude. The chat mirror's
// control layer (fork, U84) extends this module rather than growing a second
// runner.
//
// A lib/core leaf: it imports fs, path, child_process and ./paths.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { installPaths, userClaudePaths } = require('./paths');

const CLAUDE_BIN = 'claude';
const DEFAULT_TIMEOUT_MS = 30_000;

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

module.exports = {
  CLAUDE_BIN,
  claudeEnv,
  findClaude,
  runClaude,
  fallbackLocations,
};
