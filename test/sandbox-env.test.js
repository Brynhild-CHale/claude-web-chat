// The floor under the suite, held: test-support/sandbox.js scrubs Claude
// Code's environment and points CLAUDE_CONFIG_DIR into the sandbox, in this
// process and in every process a test starts; and test-support/claude-home.js
// builds its fake ~/.claude only under that sandbox, with the procStart the
// caller hands it.
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
const registry = require('../lib/util/registry');
const { claudeHome } = require('../test-support/claude-home');

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
  for (const p of [cp.claudeSettings, cp.claudeSkillsDir, cp.claudeCommandsDir, cp.projectsDir, cp.sessionsDir, cp.plansDir, cp.fileHistoryDir, cp.skillsSyncedDir, cp.pluginsDir, cp.claudeSessionStateFile(process.pid)]) {
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

// ── the claude-home fixture ─────────────────────────────────────────────────

// Every path an fs write call names while `fn` runs: what it creates, writes,
// moves, links, chmods or removes. Relative paths resolve as fs would resolve
// them. Synchronous, so nothing else runs in the window.
const ONE_PATH = ['mkdirSync', 'mkdtempSync', 'writeFileSync', 'appendFileSync', 'openSync', 'chmodSync', 'utimesSync', 'truncateSync', 'unlinkSync', 'rmSync', 'rmdirSync'];
const TWO_PATHS = ['renameSync', 'linkSync', 'copyFileSync', 'cpSync'];
function writesDuring(fn) {
  const seen = [];
  const note = (a) => {
    if (typeof a === 'string' || Buffer.isBuffer(a)) seen.push(path.resolve(String(a)));
    else if (a instanceof URL) seen.push(path.resolve(a.pathname));
  };
  const saved = new Map();
  const spy = (name, pick) => {
    const orig = fs[name];
    if (typeof orig !== 'function') return;
    saved.set(name, orig);
    fs[name] = function (...args) { pick(args).forEach(note); return orig.apply(this, args); };
  };
  for (const name of ONE_PATH) spy(name, (args) => [args[0]]);
  for (const name of TWO_PATHS) spy(name, (args) => [args[0], args[1]]);
  spy('symlinkSync', (args) => [args[1]]); // the link is made at the second argument
  try {
    return { result: fn(), paths: seen };
  } finally {
    for (const [name, orig] of saved) fs[name] = orig;
  }
}

test('claude-home builds its tree only under the sandbox, with the procStart the caller supplies', (t) => {
  const root = tmpDir(t, 'wc-proj-');
  const procStart = 'Fri Oct  2 04:22:15 2026'; // the caller's; the fixture never computes one

  const { result: ch, paths: written } = writesDuring(() => {
    const home = claudeHome(t, { root });
    home.writeSession({ pid: process.pid, procStart, sessionId: SID });
    home.writeTranscript(SID, [{ type: 'user', sessionId: SID }]);
    home.appendTranscript(SID, ['{"type":"assistant"}']);
    home.writeTaskOutput(SID, 'b3k9x2', 'building\n');
    home.addMcp({ pid: process.pid, ppid: process.ppid, interrupt: 'tty' });
    home.write('plans/quiet-river.md', '# Plan\n');
    home.sessionDir(SID);
    return home;
  });
  assert.ok(written.length > 0);
  for (const p of written) assert.ok(inSandbox(p), `${p} is outside the sandbox`);

  // Claude Code's layout, at the paths the path authority names, from the
  // PHYSICAL project path.
  const cp = userClaudePaths();
  const physical = fs.realpathSync(root);
  assert.equal(ch.dir, path.join(SANDBOX, '.claude'));
  assert.equal(ch.cwd, physical);
  assert.equal(ch.projectDir, cp.projectDir(physical));
  assert.ok(fs.statSync(ch.projectDir).isDirectory(), 'the projects slug directory');

  const sessionFile = cp.claudeSessionStateFile(process.pid);
  const record = JSON.parse(fs.readFileSync(sessionFile, 'utf8'));
  assert.equal(record.procStart, procStart, 'procStart is the caller\'s, verbatim');
  assert.equal(record.pid, process.pid);
  assert.equal(record.sessionId, SID);
  assert.equal(record.cwd, physical);
  assert.ok(fs.existsSync(path.join(cp.sessionsDir, `${process.pid}.key`)), 'beside it, the .key a reader must never open');

  const transcript = path.join(ch.projectDir, `${SID}.jsonl`);
  assert.equal(ch.transcript(SID), transcript);
  assert.equal(fs.readFileSync(transcript, 'utf8'), `${JSON.stringify({ type: 'user', sessionId: SID })}\n{"type":"assistant"}\n`);

  const out = path.join(ch.tmpDir, `claude-${ch.uid}`, ch.slug, SID, 'tasks', 'b3k9x2.output');
  assert.equal(fs.readFileSync(out, 'utf8'), 'building\n');
  assert.equal(path.basename(ch.taskDir(SID)), 'tasks');
  assert.equal(fs.statSync(path.join(ch.tmpDir, `claude-${ch.uid}`)).mode & 0o777, 0o700, 'claude-<uid> is private, as Claude Code makes it');

  const row = registry.readMcpEntries().find((e) => e.pid === process.pid && e.root === physical);
  assert.ok(row, 'a live MCP presence row for this project');
  assert.equal(row.ppid, process.ppid);
  assert.equal(row.interrupt, 'tty', 'a field the writer does not take is still on the row');

  assert.equal(fs.readFileSync(path.join(ch.dir, 'plans', 'quiet-river.md'), 'utf8'), '# Plan\n');

  // Cleanup takes everything it made, and only that.
  const { paths: removed } = writesDuring(() => ch.cleanup());
  for (const p of removed) assert.ok(inSandbox(p), `${p} is outside the sandbox`);
  for (const p of [sessionFile, transcript, out, path.join(ch.dir, 'plans', 'quiet-river.md'), ch.projectDir]) {
    assert.equal(fs.existsSync(p), false, `${p} is gone`);
  }
  assert.equal(registry.readMcpEntries().some((e) => e.pid === process.pid && e.root === physical), false, 'and so is the row');
});

test('claude-home refuses to guess: procStart is the caller\'s, a pid is an integer, an id cannot form a path', (t) => {
  const ch = claudeHome(t, { root: tmpDir(t, 'wc-proj-') });
  assert.throws(() => ch.writeSession({ pid: process.pid }), /procStart/);
  assert.throws(() => ch.writeSession({ pid: String(process.pid), procStart: null }), /pid/);
  const { record } = ch.writeSession({ pid: process.pid, procStart: null, status: 'waiting', waitingFor: 'permission prompt' });
  assert.equal(record.procStart, null, 'null is a choice the caller may make');
  assert.equal(record.waitingFor, 'permission prompt');
  for (const bad of ['../x', 'a/b', '', 'x'.repeat(101)]) {
    assert.throws(() => ch.writeTranscript(bad, []), /session id/, JSON.stringify(bad));
    assert.throws(() => ch.taskDir(bad), /session id/, JSON.stringify(bad));
  }
  assert.throws(() => ch.writeTaskOutput(SID, '../escape', 'x'), /task id/);
  assert.throws(() => ch.write('../../outside.txt', 'x'), /not a file inside/);
  assert.throws(() => ch.write('', 'x'), /not a file inside/);
});

test('claude-home refuses a Claude tier outside the sandbox, and writes nothing there', (t) => {
  const outside = tmpDir(t, 'wc-not-sandbox-');
  const prev = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = path.join(outside, '.claude');
  t.after(() => {
    if (prev === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = prev;
  });

  assert.throws(() => claudeHome(t, { root: tmpDir(t, 'wc-proj-') }), /outside the test sandbox/);
  assert.deepEqual(fs.readdirSync(outside), []);
});

test('an isolated claude-home is a private, empty tier under the sandbox until its cleanup', (t) => {
  const shared = process.env.CLAUDE_CONFIG_DIR;
  const outer = claudeHome(t, { root: tmpDir(t, 'wc-proj-'), isolate: true });
  assert.notEqual(outer.dir, shared);
  assert.ok(inSandbox(outer.dir));
  assert.equal(process.env.CLAUDE_CONFIG_DIR, outer.dir);
  assert.equal(claudeConfigDir(), outer.dir, 'code under test resolves the private tier');
  assert.deepEqual(fs.readdirSync(outer.dir).sort(), ['projects', 'sessions']);

  // Nested, the innermost wins; unwinding outer first (the order t.after hooks
  // run in) still leaves the right tier in force at each step.
  const inner = claudeHome(t, { root: outer.root, isolate: true });
  assert.equal(claudeConfigDir(), inner.dir);
  outer.cleanup();
  assert.equal(claudeConfigDir(), inner.dir, 'the outer cleanup leaves the inner tier in force');
  inner.cleanup();
  assert.equal(process.env.CLAUDE_CONFIG_DIR, shared, 'then the sandbox\'s own tier again');
  assert.equal(fs.existsSync(outer.dir), false);
  assert.equal(fs.existsSync(inner.dir), false);
});
