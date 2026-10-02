// The floor under the suite, held: test-support/sandbox.js scrubs Claude
// Code's environment and points CLAUDE_CONFIG_DIR into the sandbox, in this
// process and in every process a test starts.
//
// The suite usually runs inside a Claude Code session, and an inherited
// CLAUDE_CODE_SESSION_ID, CLAUDE_CODE_ENTRYPOINT or CLAUDE_CONFIG_DIR would point
// hook subprocesses, the ask hook and the mirror's readers at the developer's
// live session and its real transcripts. Nothing here touches the real home
// directory: the checks compute paths, compare them lexically, and spawn
// children that do the same.

// First, before anything else: a bare `node --test test/sandbox-env.test.js`
// (no --import) gets the sandbox from here.
const { home: SANDBOX } = require('../test-support/sandbox');

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { pathToFileURL } = require('url');
const { claudeConfigDir, userClaudePaths, realpath, fence } = require('../lib/core/paths');

const SANDBOX_MODULE = path.join(__dirname, '..', 'test-support', 'sandbox.js');
const PATHS_MODULE = path.join(__dirname, '..', 'lib', 'core', 'paths.js');
const SID = '0b6f7c1e-4c1d-4a8e-9a43-5d2f0e3c9b11';

// What the sandbox deletes (the spec's list, §10.1, plus a workflow agent's
// CLAUDE_JOB_DIR): spelled out here rather than imported, so a narrowed scrub
// fails this test instead of passing it.
const SCRUBBED = ['CLAUDE_PID', 'CLAUDECODE', 'CLAUDE_EFFORT', 'CLAUDE_JOB_DIR', 'WEB_CHAT_CHANNEL', 'WEB_CHAT_CHANNEL_FORCE'];
const scrubbed = (name) => SCRUBBED.includes(name) || name.startsWith('CLAUDE_CODE_');

// Inside the sandbox, under either spelling of it (macOS's /var is
// /private/var). Lexical on `p`: a path outside is never touched.
const SANDBOX_REAL = realpath(SANDBOX) || SANDBOX;
const inSandbox = (p) => fence(SANDBOX, p) !== null || fence(SANDBOX_REAL, p) !== null;

// Purely lexical containment, for a directory this test must not touch.
function lexicallyInside(dir, p) {
  const rel = path.relative(path.resolve(dir), path.resolve(p));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

// A child's view of its environment, as JSON. NESTED also spawns a grandchild
// with {...process.env} and reports its view too.
const FACTS = `({
  names: Object.keys(process.env),
  probe: process.env.WC_SANDBOX_PROBE,
  sandbox: process.env.WEB_CHAT_TEST_SANDBOX,
  HOME: process.env.HOME,
  CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
  configDir: require(${JSON.stringify(PATHS_MODULE)}).claudeConfigDir(),
})`;
const LEAF = `process.stdout.write(JSON.stringify(${FACTS}))`;
const NESTED = `
const out = ${FACTS};
const r = require('child_process').spawnSync(process.execPath, ['-e', ${JSON.stringify(LEAF)}], { env: { ...process.env }, encoding: 'utf8' });
out.child = JSON.parse(r.stdout);
process.stdout.write(JSON.stringify(out));`;

function child(src, { env, execArgv = [] } = {}) {
  const r = spawnSync(process.execPath, [...execArgv, '-e', src], { encoding: 'utf8', ...(env ? { env } : {}) });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}

function tmpDir(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('this process carries none of Claude Code\'s variables', () => {
  assert.deepEqual(Object.keys(process.env).filter(scrubbed), []);
});

test('CLAUDE_CONFIG_DIR points inside the sandbox, never at the real ~/.claude', () => {
  const tier = path.join(SANDBOX, '.claude');
  assert.equal(process.env.CLAUDE_CONFIG_DIR, tier);
  assert.equal(claudeConfigDir(), tier);
  assert.equal(os.homedir(), SANDBOX, 'and HOME is the sandbox');

  const cp = userClaudePaths();
  for (const p of [cp.projectsDir, cp.sessionsDir, cp.plansDir, cp.fileHistoryDir, cp.skillsSyncedDir, cp.pluginsDir, cp.claudeSessionStateFile(process.pid)]) {
    assert.ok(inSandbox(p), `${p} is in the sandbox`);
  }
  // The account's real home, from the user database rather than $HOME (which
  // the sandbox replaced), compared as a string only.
  let realHome = null;
  try { realHome = os.userInfo().homedir; } catch {}
  if (realHome && realHome !== SANDBOX) {
    assert.ok(!lexicallyInside(path.join(realHome, '.claude'), claudeConfigDir()), 'the real Claude tier is out of reach');
  }
});

test('a child spawned with {...process.env}, or with no env at all, inherits the scrub and the sandbox\'s Claude tier', () => {
  for (const opts of [{ env: { ...process.env } }, {}]) {
    const r = child(LEAF, opts);
    assert.deepEqual(r.names.filter(scrubbed), []);
    assert.equal(r.sandbox, SANDBOX);
    assert.equal(r.CLAUDE_CONFIG_DIR, path.join(SANDBOX, '.claude'));
    assert.equal(r.configDir, path.join(SANDBOX, '.claude'));
  }
});

test('a child handed another HOME still resolves the sandbox\'s Claude tier', (t) => {
  // A hook-style spawn ({...process.env, HOME}) cannot walk to a different
  // ~/.claude, even one that exists: the variable decides, not the home.
  const decoyHome = tmpDir(t, 'wc-decoy-home-');
  fs.mkdirSync(path.join(decoyHome, '.claude'));
  const r = child(LEAF, { env: { ...process.env, HOME: decoyHome } });
  assert.equal(r.HOME, decoyHome);
  assert.equal(r.configDir, path.join(SANDBOX, '.claude'));
});

test('loading the sandbox scrubs a dirty environment before any test code runs, and children inherit it', () => {
  const decoy = path.join(os.tmpdir(), 'wc-decoy-claude-tier');
  const dirty = {
    ...process.env,
    CLAUDE_PID: '12345',
    CLAUDECODE: '1',
    CLAUDE_EFFORT: 'high',
    CLAUDE_JOB_DIR: path.join(os.tmpdir(), 'wc-decoy-job'),
    CLAUDE_CODE_SESSION_ID: SID,
    CLAUDE_CODE_ENTRYPOINT: 'sdk-cli',
    CLAUDE_CODE_MESSAGING_TOKEN: 'fake-messaging-token-for-tests',
    CLAUDE_CODE_SOMETHING_NOT_INVENTED_YET: '1', // the whole family, by prefix
    WEB_CHAT_CHANNEL: '1',
    WEB_CHAT_CHANNEL_FORCE: '1',
    CLAUDE_CONFIG_DIR: decoy,                     // a tier the sandbox must not follow
    WC_SANDBOX_PROBE: 'kept',                     // the scrub is targeted
  };
  delete dirty.WEB_CHAT_TEST_SANDBOX; // a fresh process, as each test file's is

  const r = child(NESTED, { env: dirty, execArgv: ['--import', pathToFileURL(SANDBOX_MODULE).href] });
  assert.deepEqual(r.names.filter(scrubbed), [], 'the first line of test code sees a clean environment');
  assert.equal(r.probe, 'kept');
  assert.ok(r.sandbox && r.sandbox !== SANDBOX, 'a sandbox of its own');
  assert.equal(r.HOME, r.sandbox);
  assert.equal(r.CLAUDE_CONFIG_DIR, path.join(r.sandbox, '.claude'));
  assert.notEqual(r.configDir, decoy);
  assert.equal(r.configDir, path.join(r.sandbox, '.claude'));
  assert.equal(fs.existsSync(r.sandbox), false, 'and it removed its sandbox on exit');

  assert.deepEqual(r.child.names.filter(scrubbed), [], 'its own children inherit the scrub');
  assert.equal(r.child.probe, 'kept');
  assert.equal(r.child.configDir, path.join(r.sandbox, '.claude'));
});

test('a process that inherits a sandbox keeps what a test set on purpose', () => {
  // The scrub runs once, where the sandbox is made: loading it again in a
  // process that inherited one must not wipe a variable a test passed
  // explicitly, nor make a second sandbox.
  const r = child(LEAF, {
    env: { ...process.env, CLAUDE_CODE_SESSION_ID: SID },
    execArgv: ['--import', pathToFileURL(SANDBOX_MODULE).href],
  });
  assert.equal(r.sandbox, SANDBOX);
  assert.deepEqual(r.names.filter(scrubbed), ['CLAUDE_CODE_SESSION_ID']);
  assert.ok(fs.existsSync(SANDBOX), 'and the inherited sandbox outlives that process');
});
