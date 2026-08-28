// Throwaway HOME for the whole test process — the floor under every other
// isolation this harness does.
//
// Loaded by `npm test` as `node --test --import ./test-support/sandbox.js`, so it
// runs before any test file's first `require`, and required from
// test-support/helpers.js as a belt in case a runner (or a bare
// `node --test some.test.js`) doesn't carry the flag through.
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
// Safe to load after other modules: lib/core/paths.js calls os.homedir() per
// use with no module-scope memoization anywhere in lib/, and os.homedir()
// re-reads $HOME at call time.

const fs = require('fs');
const os = require('os');
const path = require('path');

// Idempotent — --import and the helpers require both land in the same process,
// and a second home would just orphan the first.
if (!process.env.WEB_CHAT_TEST_SANDBOX) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-sandbox-home-'));
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.WEB_CHAT_TEST_SANDBOX = home;
  // Best-effort: a killed runner leaves it for the OS to reap, like every other
  // mkdtemp in this harness.
  process.on('exit', () => { try { fs.rmSync(home, { recursive: true, force: true }); } catch {} });
}

module.exports = { home: process.env.WEB_CHAT_TEST_SANDBOX };
