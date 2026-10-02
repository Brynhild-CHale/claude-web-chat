// Throwaway HOME for the whole test process — the floor under every other
// isolation this harness does.
//
// Loaded by `npm test` as `node --test --import ./test-support/sandbox.js`, so it
// runs before any test file's first `require`, and required from
// test-support/helpers.js as a belt in case a runner (or a bare
// `node --test some.test.js`) doesn't carry the flag through. The runner itself
// does not load it: each test FILE runs in a process of its own, which loads it
// and so makes a sandbox of its own.
//
// WHY, precisely: withServer already sandboxes HOME per test, so the ~45 files
// that go through it were never exposed. Two paths it cannot see were:
//
//   * test/client-autospawn.test.js spawns a REAL daemon through
//     lib/util/daemon.js's `spawn(...)`, which passes no `env` — so the child
//     inherited the developer's HOME and its start() wrote the throwaway tmp
//     root into the real ~/.web-chat/instances.json and called ensureHub()
//     against the live capture hub (SIGTERM-and-respawn if it was behind).
//   * test/profile-cli.test.js spawnSyncs bin/claude-web-chat.js with no `env`,
//     so `profile list` read the developer's real ~/.web-chat/profiles.
//
// Both inherit process.env, so redirecting HOME here fixes both for free, and
// any future env-less spawn along with them.
//
// It does NOT replace per-test withTempHome, and withServer deliberately still
// mints its own: one process-wide home does not isolate tests from EACH OTHER
// inside a file (the service trust store, system-scope themes and the
// update-check throttle all accumulate).
//
// Safe to load after other modules: lib/core/paths.js reads the home directory
// and CLAUDE_CONFIG_DIR per use, with no module-scope memoization anywhere in
// lib/, so a value set here is what the next call sees.
//
// ── Claude Code's environment ───────────────────────────────────────────────
// The suite usually runs INSIDE Claude Code (a developer's session, or a
// workflow agent), and every process the tests start inherits that session's
// variables: CLAUDE_PID, CLAUDECODE, CLAUDE_EFFORT, CLAUDE_JOB_DIR (a workflow
// agent's), the CLAUDE_CODE_* family (CLAUDE_CODE_SESSION_ID,
// CLAUDE_CODE_ENTRYPOINT, CLAUDE_CODE_MESSAGING_TOKEN, …), and
// WEB_CHAT_CHANNEL=1 when the session was launched with the channel. Left in
// place, a hook subprocess spawned with {...process.env, HOME} would build its
// envelope and its halt-flag path from the developer's LIVE session, the ask
// hook would return at once, reporting nothing, as it does under an SDK host
// (CLAUDE_CODE_ENTRYPOINT=sdk-…), and an MCP server under test would start a
// channel bridge. So they are deleted (with
// WEB_CHAT_CHANNEL_FORCE, the bridge's override), and a test that needs one
// sets it explicitly, in a subprocess's `env` (test/channel-mcp.test.js does
// that for WEB_CHAT_CHANNEL).
//
// CLAUDE_CONFIG_DIR is pointed into the sandbox, at <sandbox>/.claude.
// lib/core/paths claudeConfigDir() follows it to Claude Code's state (live
// sessions files and transcripts, which hold real secrets), so an inherited
// value would lead a test straight to the real one. It does not follow a
// per-test HOME (withTempHome): for the whole file the Claude tier stays here,
// where test-support/claude-home.js builds a fake one (or a private one per
// test).
//
// Both happen once, where the sandbox is made, and the scrub before anything
// is required. A process that inherits a sandbox (WEB_CHAT_TEST_SANDBOX set)
// inherits the scrubbed environment too, plus whatever a test set on purpose,
// which a second scrub would wipe. test/sandbox-env.test.js holds all of this.

if (!process.env.WEB_CHAT_TEST_SANDBOX) {
  const exact = new Set([
    'CLAUDE_PID', 'CLAUDECODE', 'CLAUDE_EFFORT', 'CLAUDE_JOB_DIR',
    'WEB_CHAT_CHANNEL', 'WEB_CHAT_CHANNEL_FORCE',
  ]);
  for (const name of Object.keys(process.env)) {
    if (exact.has(name) || name.startsWith('CLAUDE_CODE_')) delete process.env[name];
  }
}

const fs = require('fs');
const os = require('os');
const path = require('path');

// Idempotent — --import and the helpers require both land in the same process,
// and a second home would just orphan the first.
if (!process.env.WEB_CHAT_TEST_SANDBOX) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-sandbox-home-'));
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.CLAUDE_CONFIG_DIR = path.join(home, '.claude');
  process.env.WEB_CHAT_TEST_SANDBOX = home;
  // Best-effort: a killed runner leaves it for the OS to reap, like every other
  // mkdtemp in this harness.
  process.on('exit', () => { try { fs.rmSync(home, { recursive: true, force: true }); } catch {} });
}

// The chrome modules the daemon serves rather than ships as files (/app/markdown.js
// — see served-modules.js), resolvable by the jsdom tests that import
// public/app off the disk. Once per process (the flag is process-local: a child
// process inherits the env but not the hooks, so it is not an env var).
if (!global.__wcServedModules) {
  global.__wcServedModules = true;
  const mod = require('node:module');
  if (typeof mod.registerHooks === 'function') mod.registerHooks(require('./served-modules'));
  else mod.register('./served-modules.js', require('node:url').pathToFileURL(__filename));
}

module.exports = { home: process.env.WEB_CHAT_TEST_SANDBOX };
